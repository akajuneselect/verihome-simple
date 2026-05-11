const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ws = require('ws');

// Initialize Supabase (service role for server-side writes)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { realtime: { transport: ws } }
  );

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: read raw body buffer (required for Stripe signature verification)
function getRawBody(req) {
      return new Promise((resolve, reject) => {
              const chunks = [];
              req.on('data', (chunk) => chunks.push(chunk));
              req.on('end', () => resolve(Buffer.concat(chunks)));
              req.on('error', reject);
      });
}
module.exports.config = {
    api: { bodyParser: false },
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

  const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
      const rawBody = await getRawBody(req);
    try {
                  event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
    } catch (err) {
          console.error('Webhook signature verification failed:', err.message);
          return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

  try {
        switch (event.type) {
          case 'checkout.session.completed': {
                    const session = event.data.object;
                    await handleLegalConsultationPayment(session);
                    break;
          }
          case 'payment_intent.succeeded': {
                    const paymentIntent = event.data.object;
                    console.log('Payment succeeded:', paymentIntent.id);
                    await updatePaymentStatus(paymentIntent.id, 'completed');
                    break;
          }
          case 'payment_intent.payment_failed': {
                    const failedPayment = event.data.object;
                    console.log('Payment failed:', failedPayment.id);
                    await updatePaymentStatus(failedPayment.id, 'failed');
                    break;
          }
          default:
                    console.log(`Unhandled event type: ${event.type}`);
        }

      res.status(200).json({ received: true });
  } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// --- Main Payment Handler ------------------------------------------------------
async function handleLegalConsultationPayment(session) {
    console.log('Processing payment for session:', session.id);

  const customerEmail = session.customer_details?.email;
    const customerName = session.customer_details?.name;
    const amount = session.amount_total;
    const currency = session.currency;
    const packageType = session.metadata?.packageType || session.metadata?.package || 'complete';
    const propertyAddress = session.custom_fields?.find(f => f.key === 'property_address')?.text?.value;
    const settlementDate = session.custom_fields?.find(f => f.key === 'settlement_date')?.text?.value;
    const urgency = session.custom_fields?.find(f => f.key === 'urgency')?.dropdown?.value || 'standard';

  // Parse file keys from Stripe metadata (stored as JSON string)
  let storedFileKeys = [];
    try {
          storedFileKeys = JSON.parse(session.metadata?.file_keys || '[]');
    } catch (e) {
          console.warn('Could not parse file_keys from metadata:', e.message);
    }
    const docType = session.metadata?.doc_type || 'other';

  const expectedCompletionTime = calculateCompletionTime(packageType, urgency);
    const assignedLawyer = assignLawyer(packageType);

  const record = {
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent,
        customer_email: customerEmail,
        customer_name: customerName,
        amount: amount,
        currency: currency,
        package_type: packageType,
        property_address: propertyAddress,
        settlement_date: settlementDate,
        urgency: urgency,
        status: 'payment_completed',
        assigned_lawyer: assignedLawyer,
        expected_completion_at: expectedCompletionTime,
        metadata: session.metadata || {},
  };

  // 1. Save order to Supabase
  await saveOrderToSupabase(record);

  // 2. Send confirmation email to client
  await sendClientConfirmationEmail(customerEmail, customerName, record);

  // 3. Notify internal team
  await notifyLegalTeam(record);

  // 4. Generate full AI report and email to client
  if (storedFileKeys.length > 0) {
        try {
                await generateAndSendReport({
                          customerEmail,
                          customerName,
                          packageType,
                          docType,
                          storedFileKeys,
                          record,
                          sessionId: session.id,
                });
        } catch (err) {
                console.error('Report generation failed:', err.message);
                // Don't fail the whole webhook &mdash; order is already saved, confirmation sent
        }
  } else {
        console.warn('No file_keys in metadata &mdash; cannot generate report for session:', session.id);
  }
}

// --- AI Report Generation ------------------------------------------------------
async function generateAndSendReport({ customerEmail, customerName, packageType, docType, storedFileKeys, record, sessionId }) {
    console.log(`Generating report for ${customerEmail}, ${storedFileKeys.length} file(s)`);

  const allFindings = [];
    const fileTexts = [];

  for (const fileInfo of storedFileKeys) {
        const fileKey = fileInfo.key || fileInfo;
        const fileName = fileInfo.name || fileKey.split('/').pop();
        const ext = fileInfo.ext || ('.' + fileName.split('.').pop().toLowerCase());

      // Download file from Supabase Storage
      const { data: fileData, error: downloadError } = await supabase.storage
          .from('documents')
          .download(fileKey);

      if (downloadError) {
              console.error(`Failed to download ${fileKey}:`, downloadError.message);
              continue;
      }

      // Convert blob to buffer
      const arrayBuffer = await fileData.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

      // Extract text
      let text = '';
        try {
                if (ext === '.pdf') {
                          const parsed = await pdfParse(buffer);
                          text = parsed.text;
                } else if (ext === '.docx' || ext === '.doc') {
                          const result = await mammoth.extractRawText({ buffer });
                          text = result.value;
                } else {
                          text = buffer.toString('utf8');
                }
        } catch (e) {
                console.error(`Text extraction failed for ${fileName}:`, e.message);
                continue;
        }

      const detectedDocType = detectDocType(text, docType);
        const ruleFindings = runRuleEngine(text, detectedDocType);
        const paragraphs = splitIntoParagraphs(text);

      // Layer 2: Select flagged paragraphs for AI
      const flaggedContexts = ruleFindings.slice(0, 15).map(f => f.context).filter(Boolean);
        const topParagraphs = paragraphs.slice(0, 30);

      allFindings.push({
              fileName,
              detectedDocType,
              ruleFindings,
              flaggedContexts,
              topParagraphs,
              wordCount: text.split(/\s+/).length,
      });
        fileTexts.push({ fileName, detectedDocType, text: text.substring(0, 8000) });
  }

  if (allFindings.length === 0) {
        console.error('No files could be processed for report generation');
        return;
  }

  // Layer 3: OpenAI Analysis - tiered by package
  const packageLabel = { essential: 'Essential', complete: 'Complete', premium: 'Premium' }[packageType] || packageType;

  // Tier config
  const tierConfig = {
    essential: {
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      systemPrompt: `You are a New Zealand property law analyst. Analyse property documents for a homebuyer and produce a clear, professional risk report. Reference NZ legislation where relevant (Property Law Act 2007, Building Act 2004, Unit Titles Act 2010, Resource Management Act 1991). Write for a non-lawyer buyer. Be concise and actionable.`,
      userPrompt: (findings, fileTexts) => `Analyse these NZ property documents and produce an Essential Risk Report.

RULE ENGINE PRE-SCAN:
${findings.flatMap(f => f.ruleFindings).slice(0, 20).map((f, i) => `${i+1}. [${f.risk}] ${f.category}: ${f.message}`).join('\n')}

DOCUMENT EXCERPTS:
${findings.flatMap(f => f.flaggedContexts).slice(0, 8).map((c, i) => `[Excerpt ${i+1}]: ${c}`).join('\n\n')}

Produce a professional HTML report with these sections:
1. EXECUTIVE SUMMARY (2-3 sentences: key risks, should buyer proceed?)
2. HIGH RISK FINDINGS (each with: issue description, why it matters, one clear action)
3. MEDIUM RISK FINDINGS (each with: issue description, recommended action)
4. LOW RISK FINDINGS (brief list)
5. PRE-UNCONDITIONAL CHECKLIST (5 must-do actions before signing)

Format: Use <h3> for section headers, <ul><li> for lists. Colour-code: HIGH = red, MEDIUM = orange, LOW = green. Keep language plain and direct.`
    },
    complete: {
      model: 'gpt-4o-mini',
      max_tokens: 3000,
      systemPrompt: `You are a senior New Zealand property lawyer producing a detailed analysis for a homebuyer client. You have deep knowledge of NZ property law including the Property Law Act 2007, Unit Titles Act 2010, Building Act 2004, Resource Management Act 1991, and REINZ standards. Reference specific legislation by name. Provide detailed, actionable advice.`,
      userPrompt: (findings, fileTexts) => `Conduct a Complete Analysis of these NZ property documents.

RULE ENGINE PRE-SCAN:
${findings.flatMap(f => f.ruleFindings).slice(0, 20).map((f, i) => `${i+1}. [${f.risk}] ${f.category}: ${f.message}`).join('\n')}

DOCUMENT EXCERPTS:
${findings.flatMap(f => f.flaggedContexts).slice(0, 10).map((c, i) => `[Excerpt ${i+1}]: ${c}`).join('\n\n')}

Produce a comprehensive HTML report with:
1. EXECUTIVE SUMMARY (overall risk assessment, clear purchase recommendation)
2. HIGH RISK FINDINGS (detailed analysis, NZ legal context, specific action required, estimated cost/impact)
3. MEDIUM RISK FINDINGS (full analysis, legal context, action steps)
4. LOW RISK FINDINGS (analysis and monitoring recommendations)
5. NEGOTIATION LEVERAGE POINTS (specific issues the buyer can use to negotiate price reduction or remediation, with suggested dollar amounts where possible)
6. DUE DILIGENCE CHECKLIST (10+ specific actions before going unconditional, in priority order)
7. RELEVANT NZ LEGISLATION (list which laws apply and why)

Format: Use <h3> headers, <ul><li> lists. Colour-code risks. Reference NZ legislation by name throughout.`
    },
    premium: {
      model: 'gpt-4o',
      max_tokens: 6000,
      systemPrompt: `You are a senior NZ property conveyancing solicitor producing a formal legal analysis report. You have expert knowledge of NZ property law: Property Law Act 2007, Unit Titles Act 2010 (especially ss.144-148 pre-contract disclosure), Building Act 2004 (especially ss.36, 92, 364A regarding code compliance), Resource Management Act 1991, Weathertight Homes Resolution Services Act 2006, and standard REINZ S&P Agreement clauses. Cite specific sections. Write in formal legal report style but remain accessible to a non-lawyer buyer.`,
      userPrompt: (findings, fileTexts) => `Produce a Premium Legal Analysis Report for this NZ property purchase.

RULE ENGINE PRE-SCAN:
${findings.flatMap(f => f.ruleFindings).slice(0, 20).map((f, i) => `${i+1}. [${f.risk}] ${f.category}: ${f.message}`).join('\n')}

DOCUMENT EXCERPTS:
${findings.flatMap(f => f.flaggedContexts).slice(0, 12).map((c, i) => `[Excerpt ${i+1}]: ${c}`).join('\n\n')}

Produce a formal legal-style HTML report with:
1. EXECUTIVE SUMMARY AND PURCHASE RECOMMENDATION (clear verdict: Proceed / Proceed with Conditions / Do Not Proceed — with reasons)
2. HIGH RISK FINDINGS (formal legal analysis, cite specific NZ statute sections, vendor obligations, buyer remedies, cost estimates)
3. MEDIUM RISK FINDINGS (full legal analysis with statute references)
4. sessionId);LOW RISK FINDINGS (legal context and monitoring)
5. NEGOTIATION STRATEGY (specific leverage points with suggested price reduction amounts, conditions to add to contract, remediation requests — written as instructions to buyer)
6. FULL NEGOTIATION SCRIPT (exact wording the buyer can use when negotiating with the vendor or agent)
7. LEGAL CONDITIONS TO ADD TO CONTRACT (specific clauses the buyer should request before going unconditional)
8. PRE-UNCONDITIONAL DUE DILIGENCE CHECKLIST (priority-ordered, 15+ items)
9. WHEN TO INVOLVE A SOLICITOR (specific issues that require professional legal advice)
10. APPLICABLE NZ LEGISLATION (full list with relevant section references)

Format: Formal legal report style. Use <h3> headers with section numbers. Colour-code all risk levels. Cite statutes throughout as e.g. "s.36 Building Act 2004".`
    }
  };

  const tier = tierConfig[packageType] || tierConfig.complete;

  const aiResponse = await openai.chat.completions.create({
    model: tier.model,
    messages: [
      { role: 'system', content: tier.systemPrompt },
      { role: 'user', content: tier.userPrompt(allFindings, fileTexts) },
    ],
    max_tokens: tier.max_tokens,
    temperature: 0.3,
  });

  let reportHtml = aiResponse.choices[0].message.content;
  // Strip markdown code block wrapper if AI returned ```html ... ```
  reportHtml = reportHtml.replace(/^```html[\s\S]*?\n/, '').replace(/\n?```\s*$/, '').trim();

    // Save report for admin review
    await supabase.from('orders').update({ 
      status: 'report_ready_for_review',
      report_html: reportHtml
    }).eq('stripe_session_id', sessionId);

    await sendReportForReview(customerEmail, customerName, packageType, record, reportHtml, allFindings, sessionId);
    console.log('Report saved for review, admin notified:', sessionId);
}

// --- Supabase ------------------------------------------------------------------
async function saveOrderToSupabase(record) {
  const { data, error } = await supabase
    .from('orders')
    .insert([record]);
  if (error) {
    if (error.code === '23505') {
      // Duplicate key - order already processed (idempotent)
      console.log('Order already exists (duplicate), skipping insert:', record.stripe_session_id);
      return null;
    }
    console.error('Supabase insert error:', error);
    throw new Error(`Failed to save order: ${error.message}`);
  }
    console.log('Order saved to Supabase');
    return data;
}

async function updatePaymentStatus(paymentIntentId, status) {
    const { error } = await supabase
      .from('orders')
      .update({ status })
      .eq('stripe_payment_intent', paymentIntentId);

  if (error) {
        console.error('Supabase update error:', error);
  } else {
        console.log(`Order ${paymentIntentId} status updated to: ${status}`);
  }
}

// --- Resend Emails -------------------------------------------------------------
async function sendClientConfirmationEmail(email, name, record) {
    const packageLabel = {
          essential: 'Essential Review ($69 NZD)',
          complete: 'Complete Analysis ($199 NZD)',
          premium: 'Premium Consultation ($259 NZD)',
    }[record.package_type] || record.package_type;

  const completionDate = new Date(record.expected_completion_at).toLocaleDateString('en-NZ', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
  });

  const { error } = await resend.emails.send({
        from: 'Verihome NZ <support@verihome.co.nz>',
        to: email,
        subject: `Your Verihome Report is Being Prepared - ${packageLabel}`,
        html: `
        <!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{font-family:Arial,sans-serif;line-height:1.6;color:#333;margin:0;padding:0}
        .header{background:#1a3c5e;color:white;padding:24px;text-align:center}
        .content{padding:30px;max-width:600px;margin:0 auto}
        .info-box{background:#f8f9fa;padding:20px;border-left:4px solid #1a3c5e;margin:20px 0;border-radius:4px}
        .info-box h4{margin:0 0 12px;color:#1a3c5e}
        .timeline{margin:20px 0}
        .step{display:flex;align-items:center;margin-bottom:12px;padding:10px;border-radius:6px}
        .step.done{background:#e8f5e9}.step.active{background:#e3f2fd}.step.pending{background:#f5f5f5}
        .step-num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;margin-right:12px;flex-shrink:0}
        .done .step-num{background:#4caf50;color:white}.active .step-num{background:#2196f3;color:white}.pending .step-num{background:#9e9e9e;color:white}
        .notice{background:#fff8e1;padding:16px;border-left:4px solid #ffc107;border-radius:4px;font-size:14px}
        .footer{background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#666}
        </style></head><body>
        <div class="header"><h1 style="margin:0">Verihome NZ</h1><h2 style="margin:8px 0 0;font-weight:normal;opacity:0.9">Payment Confirmed &mdash; Report In Progress</h2></div>
        <div class="content">
        <p>Dear <strong>${name || 'Valued Customer'}</strong>,</p>
        <p>Thank you for choosing Verihome NZ. Your payment has been received and our AI analysis engine is now processing your documents.</p>
        <div class="info-box"><h4>Order Summary</h4><ul>
        <li><strong>Package:</strong> ${packageLabel}</li>
        <li><strong>Amount Paid:</strong> $${(record.amount / 100).toFixed(2)} ${record.currency.toUpperCase()}</li>
        <li><strong>Property:</strong> ${record.property_address || 'As uploaded'}</li>
        <li><strong>Expected Report Delivery:</strong> ${completionDate}</li>
        </ul></div>
        <div class="timeline"><h4>What Happens Next</h4>
        <div class="step done"><div class="step-num">&#10003;</div><div><strong>Payment Confirmed</strong> &mdash; Your order has been received</div></div>
        <div class="step active"><div class="step-num">2</div><div><strong>AI Analysis In Progress</strong> &mdash; Documents are being analysed by our NZ property law engine</div></div>
        <div class="step pending"><div class="step-num">3</div><div><strong>Report Delivery</strong> &mdash; Full analysis will be emailed to you shortly</div></div>
        </div>
        <div class="notice"><strong>Note:</strong> Your full report will arrive in a separate email. Please check your spam folder if you don't see it within the expected timeframe.</div>
        <p style="margin-top:24px">Questions? Contact us at <a href="mailto:support@verihome.co.nz">support@verihome.co.nz</a></p>
        <p>Best regards,<br><strong>The Verihome NZ Team</strong></p>
        </div>
        <div class="footer"><p>Protocol Zero Limited &middot; AI-Powered NZ Property Document Analysis</p></div>
        </body></html>`,
  });

  if (error) console.error('Resend confirmation email error:', error);
    else console.log('Confirmation email sent to:', email);
}

async function sendReportForReview(email, name, packageType, record, reportHtml, allFindings, sessionId) {
  const pkgLabel = { essential: 'Essential Review', complete: 'Complete Analysis', premium: 'Premium Report' }[packageType] || packageType;
  const { highRisks, medRisks, lowRisks, total } = parseRiskCountsFromHtml(reportHtml, allFindings);

  const approveUrl = 'https://www.verihome.co.nz/api/send-report?session_id=' + sessionId + '&token=' + process.env.REVIEW_SECRET;

  const adminHtml = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,sans-serif;line-height:1.6;color:#333;margin:0;padding:0}',
    '.hdr{background:#1a3c5e;color:white;padding:20px 24px;}',
    '.cnt{padding:24px;max-width:800px;margin:0 auto}',
    '.meta{background:#f8f9fa;border-left:4px solid #1a3c5e;padding:16px;border-radius:4px;margin-bottom:20px;font-size:0.9rem;}',
    '.approve{display:inline-block;background:#27ae60;color:white;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;margin:16px 0;}',
    '.warn{color:#c0392b;font-size:0.82rem;margin-top:4px;}',
    '.report{background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:20px;margin:20px 0;}',
    'h3{color:#1a3c5e;border-bottom:2px solid #e3f2fd;padding-bottom:6px}',
    '.b{display:inline-block;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:700;margin:2px}',
    '.hi{background:#ffebee;color:#c62828}.me{background:#fff3e0;color:#e65100}.lo{background:#e8f5e9;color:#2e7d32}',
    '</style></head><body>',
    '<div class="hdr"><h2 style="margin:0">&#128203; Report Ready for Review</h2>',
    '<p style="margin:4px 0 0;opacity:0.85;">' + pkgLabel + ' &mdash; Approve to send to client</p></div>',
    '<div class="cnt">',
    '<div class="meta">',
    '<strong>Client:</strong> ' + (name || 'Unknown') + ' (' + email + ')<br>',
    '<strong>Package:</strong> ' + pkgLabel + '<br>',
    '<strong>Property:</strong> ' + (record.property_address || 'N/A') + '<br>',
    '<strong>Amount:</strong> $' + (record.amount / 100).toFixed(2) + ' ' + (record.currency || 'nzd').toUpperCase() + '<br>',
    '<strong>Risks:</strong> <span class="b hi">' + highRisks + ' High</span> <span class="b me">' + medRisks + ' Medium</span> <span class="b lo">' + lowRisks + ' Low</span> <span class="b" style="background:#f5f5f5;color:#424242">Total: ' + total + '</span>',
    '</div>',
    '<a href="' + approveUrl + '" class="approve">&#9989; Approve &amp; Send to Client</a>',
    '<p class="warn">&#9888; Only click once. This will immediately send the report to ' + email + '</p>',
    '<h3>Report Preview</h3>',
    '<div class="report">' + reportHtml + '</div>',
    '</div></body></html>'
  ].join('\n');

  const { error } = await resend.emails.send({
    from: 'Verihome System <support@verihome.co.nz>',
    to: 'support@verihome.co.nz',
    subject: '[REVIEW] ' + pkgLabel + ' Report &mdash; ' + (name || email),
    html: adminHtml,
  });

  if (error) console.error('Review email error:', error);
  else console.log('Admin review email sent for session:', sessionId);
}

async function sendFullReportEmail(email, name, packageType, record, reportHtml, allFindings) {
  const pkgLabel = { essential: 'Essential Review', complete: 'Complete Analysis', premium: 'Premium Report' }[packageType] || packageType;
  const { highRisks, medRisks, lowRisks, total } = parseRiskCountsFromHtml(reportHtml, allFindings);

  const clientHtml = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,sans-serif;line-height:1.6;color:#333;margin:0;padding:0}',
    '.hdr{background:#1a3c5e;color:white;padding:24px;text-align:center}',
    '.b{display:inline-block;padding:4px 10px;border-radius:12px;font-size:13px;font-weight:bold;margin:2px}',
    '.hi{background:#ffebee;color:#c62828}.me{background:#fff3e0;color:#e65100}.lo{background:#e8f5e9;color:#2e7d32}',
    '.bar{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap}',
    '.cnt{padding:30px;max-width:700px;margin:0 auto}',
    '.rpt{background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:24px;margin:20px 0}',
    '.ftr{background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#666}',
    'h3{color:#1a3c5e;border-bottom:2px solid #e3f2fd;padding-bottom:6px}',
    '</style></head><body>',
    '<div class="hdr"><h1 style="margin:0">Verihome NZ</h1>',
    '<h2 style="margin:8px 0 0;font-weight:normal;opacity:0.9">' + pkgLabel + ' &mdash; Property Analysis Report</h2></div>',
    '<div class="cnt">',
    '<p>Dear <strong>' + (name || 'Valued Customer') + '</strong>,</p>',
    '<p>Your property document analysis is complete. Here is your full report:</p>',
    '<div class="bar">',
    '<span class="b" style="background:#e3f2fd;color:#1565c0">' + allFindings.length + ' Document(s)</span>',
    '<span class="b hi">' + highRisks + ' High Risk</span>',
    '<span class="b me">' + medRisks + ' Medium Risk</span>',
    '<span class="b lo">' + lowRisks + ' Low Risk</span>',
    '<span class="b" style="background:#f5f5f5;color:#424242">Total: ' + total + ' Findings</span>',
    '</div>',
    record.property_address ? '<p><strong>Property:</strong> ' + record.property_address + '</p>' : '',
    '<div class="rpt">' + reportHtml + '</div>',
    '<div style="background:#fff8e1;padding:16px;border-left:4px solid #ffc107;border-radius:4px;font-size:13px;margin:20px 0">',
    '<strong>Legal Disclaimer:</strong> This report is generated by an AI-assisted analysis system for informational purposes only. It does not constitute legal advice. Verihome NZ and Protocol Zero Limited recommend consulting a qualified New Zealand solicitor for all significant property transactions.',
    '</div>',
    '<p>Questions? Contact us at <a href="mailto:support@verihome.co.nz">support@verihome.co.nz</a></p>',
    '<p>Best regards,<br><strong>The Verihome NZ Legal Analysis Team</strong></p>',
    '</div>',
    '<div class="ftr"><p>Protocol Zero Limited &middot; Verihome NZ &middot; AI-Powered NZ Property Document Analysis<br>',
    'This email contains confidential analysis prepared for the named recipient only.</p></div>',
    '</body></html>'
  ].join('\n');

  const { error } = await resend.emails.send({
    from: 'Verihome NZ <support@verihome.co.nz>',
    to: email,
    subject: 'Your Verihome Property Report is Ready &mdash; ' + pkgLabel,
    html: clientHtml,
  });

  if (error) console.error('Report email error:', error);
  else console.log('Full report sent to client:', email);
}

async function notifyLegalTeam(record) {
    const { error } = await resend.emails.send({
          from: 'Verihome System <support@verihome.co.nz>',
          to: 'support@verihome.co.nz',
          subject: `New ${record.package_type.toUpperCase()} Order - ${record.customer_name || record.customer_email}`,
          html: `
          <h2>New Legal Consultation Order</h2>
          <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Client</strong></td><td style="padding:8px;border:1px solid #ddd">${record.customer_name} (${record.customer_email})</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Package</strong></td><td style="padding:8px;border:1px solid #ddd">${record.package_type}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Property</strong></td><td style="padding:8px;border:1px solid #ddd">${record.property_address || 'N/A'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Settlement Date</strong></td><td style="padding:8px;border:1px solid #ddd">${record.settlement_date || 'N/A'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Urgency</strong></td><td style="padding:8px;border:1px solid #ddd">${record.urgency}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Assigned To</strong></td><td style="padding:8px;border:1px solid #ddd">${record.assigned_lawyer}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Due By</strong></td><td style="padding:8px;border:1px solid #ddd">${new Date(record.expected_completion_at).toLocaleString('en-NZ')}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Amount</strong></td><td style="padding:8px;border:1px solid #ddd">$${(record.amount / 100).toFixed(2)} ${record.currency.toUpperCase()}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd"><strong>Session ID</strong></td><td style="padding:8px;border:1px solid #ddd">${record.stripe_session_id}</td></tr>
          </table>`,
    });

  if (error) console.error('Resend team notification error:', error);
    else console.log('Legal team notified');
}

// --- Risk Count Parser --------------------------------------------------------
function parseRiskCountsFromHtml(reportHtml, allFindings) {
  // Count actual risks from AI-generated HTML report sections
  let highRisks = 0, medRisks = 0, lowRisks = 0;
  try {
    const highSec = reportHtml.match(/HIGH[\s\S]*?(?=MEDIUM RISK|LOW RISK|NEGOTIATION|DUE DILIGENCE|PRE-UNCON|CHECKLIST|$)/i);
    if (highSec) highRisks = (highSec[0].match(/<li/gi) || []).length;
    const medSec = reportHtml.match(/MEDIUM RISK[\s\S]*?(?=LOW RISK|NEGOTIATION|DUE DILIGENCE|PRE-UNCON|CHECKLIST|$)/i);
    if (medSec) medRisks = (medSec[0].match(/<li/gi) || []).length;
    const lowSec = reportHtml.match(/LOW RISK[\s\S]*?(?=NEGOTIATION|DUE DILIGENCE|PRE-UNCON|CHECKLIST|DISCLAIMER|$)/i);
    if (lowSec) lowRisks = (lowSec[0].match(/<li/gi) || []).length;
  } catch(e) { console.warn('parseRiskCountsFromHtml error:', e.message); }
  // Fallback to rule engine if AI parsing yields nothing
  if (highRisks === 0 && medRisks === 0 && lowRisks === 0 && allFindings) {
    highRisks = allFindings.reduce((s, f) => s + f.ruleFindings.filter(r => r.risk === 'HIGH').length, 0);
    medRisks  = allFindings.reduce((s, f) => s + f.ruleFindings.filter(r => r.risk === 'MEDIUM').length, 0);
    lowRisks  = allFindings.reduce((s, f) => s + f.ruleFindings.filter(r => r.risk === 'LOW').length, 0);
  }
  return { highRisks, medRisks, lowRisks, total: highRisks + medRisks + lowRisks };
}

// --- NZ Rule Engine (Layer 1) --------------------------------------------------
const NZ_RISK_RULES = {
    spa: [
      { pattern: /as\s+is\s+where\s+is/gi, risk: 'HIGH', category: 'Contract Terms', message: '"As is where is" clause &mdash; seller disclaims all responsibility for property condition.' },
      { pattern: /cash\s+unconditional/gi, risk: 'HIGH', category: 'Contract Terms', message: 'Cash unconditional offer &mdash; no finance or due diligence protection for buyer.' },
      { pattern: /leasehold/gi, risk: 'HIGH', category: 'Title', message: 'Leasehold title &mdash; ground rent reviews can significantly increase future holding costs.' },
      { pattern: /meth(amphetamine)?\s+(contamin|test|residue)/gi, risk: 'HIGH', category: 'Contamination', message: 'Methamphetamine contamination reference &mdash; obtain independent meth test before proceeding.' },
      { pattern: /body\s+corporate/gi, risk: 'MEDIUM', category: 'Body Corporate', message: 'Body corporate property &mdash; obtain levy statements and meeting minutes before going unconditional.' },
      { pattern: /unit\s+title/gi, risk: 'MEDIUM', category: 'Title', message: 'Unit title &mdash; pre-contract disclosure statement required under Unit Titles Act 2010.' },
      { pattern: /cross[\s-]?lease/gi, risk: 'MEDIUM', category: 'Title', message: 'Cross-lease title &mdash; verify flats plan matches current structures; illegal alterations are common.' },
      { pattern: /penalty\s+(interest|clause)/gi, risk: 'MEDIUM', category: 'Financial', message: 'Penalty clause &mdash; late settlement may incur significant additional charges.' },
      { pattern: /subject\s+to\s+finance/gi, risk: 'LOW', category: 'Conditions', message: 'Finance condition &mdash; standard protection, ensure bank approval timeline is realistic.' },
      { pattern: /chattels?/gi, risk: 'LOW', category: 'Chattels', message: 'Chattels referenced &mdash; verify all listed items are present and in working order at settlement.' },
      { pattern: /vacant\s+possession/gi, risk: 'LOW', category: 'Possession', message: 'Vacant possession required &mdash; confirm tenancy end date if property is currently tenanted.' },
        ],
    lim: [
      { pattern: /outstanding\s+(building\s+)?consent/gi, risk: 'HIGH', category: 'Building Consent', message: 'Outstanding building consent &mdash; structures may be illegal. Demand code compliance certificate.' },
      { pattern: /no\s+code\s+compliance/gi, risk: 'HIGH', category: 'Building Consent', message: 'No code compliance certificate &mdash; council has not signed off on completed building work.' },
      { pattern: /notice\s+to\s+(fix|rectify|remedy)/gi, risk: 'HIGH', category: 'Council Notice', message: 'Notice to fix issued by council &mdash; legal repair obligation that transfers to purchaser.' },
      { pattern: /flood(ing|plain|prone)?/gi, risk: 'HIGH', category: 'Environmental', message: 'Flood risk noted in LIM &mdash; check council flood maps and obtain insurance quotes before committing.' },
      { pattern: /liquefaction/gi, risk: 'HIGH', category: 'Environmental', message: 'Liquefaction risk &mdash; common in Christchurch, Wellington coastal areas. Verify EQC claims history.' },
      { pattern: /contaminated\s+(land|site|soil)/gi, risk: 'HIGH', category: 'Environmental', message: 'Land contamination recorded on LIM &mdash; remediation costs can be very substantial.' },
      { pattern: /asbestos/gi, risk: 'HIGH', category: 'Hazardous Materials', message: 'Asbestos referenced &mdash; if pre-1990 building, obtain asbestos survey before purchase.' },
      { pattern: /heritage\s+(order|designation|listing)/gi, risk: 'MEDIUM', category: 'Heritage', message: 'Heritage designation &mdash; limits alterations significantly, may affect resale value.' },
      { pattern: /designation/gi, risk: 'MEDIUM', category: 'Planning', message: 'Land designation found &mdash; local or central government may have acquisition rights.' },
      { pattern: /onsite\s+(wastewater|septic)/gi, risk: 'MEDIUM', category: 'Services', message: 'Onsite wastewater system &mdash; verify compliance with regional council rules; ongoing maintenance costs.' },
      { pattern: /resource\s+consent/gi, risk: 'LOW', category: 'Planning', message: 'Resource consent on record &mdash; check ongoing consent conditions and obligations.' },
        ],
    building: [
      { pattern: /moisture\s+(meter|reading|level|damage|intrusion)/gi, risk: 'HIGH', category: 'Moisture', message: 'Moisture issues detected &mdash; may indicate weathertightness failure. Get specialist report urgently.' },
      { pattern: /weathertight(ness)?(\s+risk|\s+failure|\s+issue)?/gi, risk: 'HIGH', category: 'Weathertightness', message: 'Weathertightness risk flagged &mdash; NZ leaky building remediation can exceed $200,000 NZD.' },
      { pattern: /monolithic\s+cladding/gi, risk: 'HIGH', category: 'Weathertightness', message: 'Monolithic cladding system &mdash; high weathertightness risk, common in 1990s-2000s NZ builds.' },
      { pattern: /structural\s+(concern|issue|damage|defect|movement)/gi, risk: 'HIGH', category: 'Structure', message: 'Structural concerns &mdash; engage a structural engineer before going unconditional.' },
      { pattern: /foundation\s+(crack|subsidence|settlement|movement)/gi, risk: 'HIGH', category: 'Structure', message: 'Foundation issues &mdash; can be very costly to remediate; obtain engineering assessment.' },
      { pattern: /urgent\s+(repair|attention|remediation)/gi, risk: 'HIGH', category: 'Urgent Works', message: 'Urgent repairs flagged &mdash; use these to negotiate purchase price reduction.' },
      { pattern: /earthquake\s+(damage|prone|risk)/gi, risk: 'HIGH', category: 'Earthquake', message: 'Earthquake damage or risk &mdash; check council earthquake-prone building register and EQC claims.' },
      { pattern: /\$[\d,]+\s*(to|-)\s*\$[\d,]+/g, risk: 'MEDIUM', category: 'Cost Estimates', message: 'Repair cost estimates found &mdash; total all figures for price negotiation leverage.' },
      { pattern: /electrical\s+(fault|issue|concern|non.compliant)/gi, risk: 'MEDIUM', category: 'Electrical', message: 'Electrical issues &mdash; non-compliant wiring is a safety concern and may affect insurance.' },
      { pattern: /plumbing\s+(leak|issue|concern|age)/gi, risk: 'MEDIUM', category: 'Plumbing', message: 'Plumbing concerns &mdash; aged or leaking pipes can be expensive to replace throughout a house.' },
      { pattern: /re.roofing\s+recommended|roof\s+(end|near)\s+of\s+life/gi, risk: 'MEDIUM', category: 'Roofing', message: 'Roof replacement recommended &mdash; budget $15,000-$45,000 NZD depending on size and material.' },
      { pattern: /uninspected\s+area/gi, risk: 'MEDIUM', category: 'Inspection Limitation', message: 'Areas not inspected &mdash; hidden risks remain. Consider invasive investigation before committing.' },
        ],
};

function runRuleEngine(text, docType) {
    const rules = NZ_RISK_RULES[docType]
      ? NZ_RISK_RULES[docType]
          : [...NZ_RISK_RULES.spa, ...NZ_RISK_RULES.lim, ...NZ_RISK_RULES.building];
    const findings = [];
    for (const rule of rules) {
          const matches = text.match(rule.pattern);
          if (matches) {
                  const idx = text.search(new RegExp(rule.pattern.source, 'i'));
                  const start = Math.max(0, idx - 100);
                  const end = Math.min(text.length, idx + 150);
                  const context = text.substring(start, end).replace(/\s+/g, ' ').trim();
                  findings.push({ risk: rule.risk, category: rule.category, message: rule.message, context, matchCount: matches.length });
          }
    }
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return findings.sort((a, b) => order[a.risk] - order[b.risk]);
}

function splitIntoParagraphs(text) {
    return text
      .split(/\n{2,}|\r\n{2,}/)
      .map(p => p.replace(/\s+/g, ' ').trim())
      .filter(p => p.length > 50 && p.length <= 1000)
      .map(p => p.length > 500 ? p.substring(0, 500) : p);
}

function detectDocType(text, declared) {
    if (declared && declared !== 'other') return declared;
    const t = text.toLowerCase();
    if (t.includes('land information memorandum') || t.includes(' lim ')) return 'lim';
    if (t.includes('building inspection') || t.includes('building report')) return 'building';
    if (t.includes('sale and purchase') || t.includes('agreement for sale')) return 'spa';
    return 'other';
}

// --- Helpers -------------------------------------------------------------------
function calculateCompletionTime(packageType, urgency) {
    const baseHours = { essential: 48, complete: 24, premium: 12 };
    const multiplier = { emergency: 0.25, urgent: 0.5, standard: 1 };
    const hours = (baseHours[packageType] || 24) * (multiplier[urgency] || 1);
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function assignLawyer(packageType) {
    const lawyers = {
          premium: 'Senior Legal Counsel',
          complete: 'Property Law Specialist',
          essential: 'Legal Analyst',
    };
    return lawyers[packageType] || 'Legal Team';
}
