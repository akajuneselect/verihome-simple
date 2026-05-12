const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

// No bodyParser needed for GET, but keep config explicit
module.exports.config = { api: { bodyParser: true } };

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).end('Method Not Allowed');
  }

  const { session_id, token } = req.query || {};

  // Validate token
  if (!token || token !== process.env.REVIEW_SECRET) {
    return res.status(401).send('<h2>Unauthorised</h2><p>Invalid or missing review token.</p>');
  }
  if (!session_id) {
    return res.status(400).send('<h2>Bad Request</h2><p>Missing session_id.</p>');
  }

  // Fetch order from Supabase
  let order, fetchError;
  try {
    const result = await supabase
      .from('orders')
      .select('*')
      .eq('stripe_session_id', session_id)
      .single();
    order = result.data;
    fetchError = result.error;
  } catch (e) {
    console.error('Supabase fetch exception:', e.message);
    return res.status(500).send('<h2>Database Error</h2><p>' + e.message + '</p>');
  }

  if (fetchError || !order) {
    console.error('Order not found:', fetchError?.message);
    return res.status(404).send('<h2>Not Found</h2><p>Order not found for session: ' + session_id + '</p>');
  }

  // Already sent guard
  if (order.status === 'report_sent') {
    return res.status(200).send([
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Already Sent</title></head>',
      '<body style="font-family:Arial;padding:40px;max-width:600px;margin:0 auto;text-align:center">',
      '<div style="font-size:3rem">✅</div>',
      '<h2 style="color:#27ae60">Already Sent</h2>',
      '<p>This report was already sent to <strong>' + order.customer_email + '</strong>.</p>',
      '<p style="color:#888;font-size:.85rem">Session: ' + session_id + '</p>',
      '</body></html>'
    ].join(''));
  }

  if (!order.report_html) {
    return res.status(400).send('<h2>Error</h2><p>No report found for this order. The AI report may still be generating — wait a moment and try again.</p>');
  }

  // Parse risk counts correctly from AI-generated HTML
  const { highRisks, medRisks, lowRisks, total } = parseRiskCountsFromHtml(order.report_html);

  const pkgLabel = {
    essential: 'Essential Review',
    complete: 'Complete Analysis',
    premium: 'Premium Report'
  }[order.package_type] || order.package_type;

  // Build client email HTML
  const clientHtml = buildClientEmailHtml({
    name: order.customer_name,
    pkgLabel,
    propertyAddress: order.property_address,
    reportHtml: order.report_html,
    highRisks, medRisks, lowRisks, total,
  });

  // Send email to client
  let sendError;
  try {
    const result = await resend.emails.send({
      from: 'Verihome NZ <support@verihome.co.nz>',
      to: order.customer_email,
      subject: 'Your Verihome Property Report is Ready — ' + pkgLabel,
      html: clientHtml,
    });
    sendError = result.error;
  } catch (e) {
    console.error('Resend exception:', e.message);
    return res.status(500).send('<h2>Email Error</h2><p>Failed to send email: ' + e.message + '</p>');
  }

  if (sendError) {
    console.error('Failed to send report:', sendError);
    return res.status(500).send('<h2>Email Error</h2><p>Failed to send: ' + sendError.message + '</p>');
  }

  // Mark as sent — prevent double-send
  try {
    await supabase
      .from('orders')
      .update({ status: 'report_sent', report_sent_at: new Date().toISOString() })
      .eq('stripe_session_id', session_id);
  } catch (e) {
    console.error('Failed to update order status:', e.message);
    // Don't fail the response — email already sent
  }

  console.log('Report approved and sent to:', order.customer_email, 'session:', session_id);

  return res.status(200).send([
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report Sent</title>',
    '<style>body{font-family:Arial,sans-serif;padding:60px 40px;max-width:580px;margin:0 auto;text-align:center}',
    '.box{background:#f8f9fa;border-radius:10px;padding:20px;margin:20px 0;text-align:left;font-size:.9rem;line-height:1.7}</style></head>',
    '<body>',
    '<div style="font-size:4rem">✅</div>',
    '<h1 style="color:#27ae60;margin:.5rem 0">Report Sent!</h1>',
    '<p style="font-size:1.05rem;color:#333">Report delivered to:</p>',
    '<p style="font-size:1.2rem;font-weight:700;color:#1a3c5e">' + order.customer_email + '</p>',
    '<div class="box">',
    '<strong>Client:</strong> ' + (order.customer_name || 'N/A') + '<br>',
    '<strong>Package:</strong> ' + pkgLabel + '<br>',
    '<strong>Property:</strong> ' + (order.property_address || 'N/A') + '<br>',
    '<strong>Risks:</strong> ' + highRisks + ' High · ' + medRisks + ' Medium · ' + lowRisks + ' Low<br>',
    '<strong>Session:</strong> ' + session_id,
    '</div>',
    '</body></html>'
  ].join(''));
};

// ── Build client email ─────────────────────────────────────────────────────────
function buildClientEmailHtml({ name, pkgLabel, propertyAddress, reportHtml, highRisks, medRisks, lowRisks, total }) {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body{font-family:Arial,sans-serif;line-height:1.6;color:#333;margin:0;padding:0}',
    '.hdr{background:#1a3c5e;color:white;padding:24px;text-align:center}',
    '.b{display:inline-block;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:700;margin:3px}',
    '.hi{background:#ffebee;color:#c62828}.me{background:#fff3e0;color:#e65100}.lo{background:#e8f5e9;color:#2e7d32}',
    '.bar{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap;align-items:center}',
    '.cnt{padding:30px;max-width:700px;margin:0 auto}',
    '.rpt{background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:24px;margin:20px 0}',
    '.rpt h3{color:#1a3c5e;border-bottom:2px solid #e3f2fd;padding-bottom:6px;margin-top:20px}',
    '.finding{padding:14px 16px;border-radius:6px;margin:10px 0;line-height:1.6}',
    '.ftr{background:#f8f9fa;padding:20px;text-align:center;font-size:13px;color:#666}',
    '</style></head><body>',
    '<div class="hdr">',
    '<h1 style="margin:0">Verihome NZ</h1>',
    '<h2 style="margin:8px 0 0;font-weight:normal;opacity:.9">' + pkgLabel + ' — Property Analysis Report</h2>',
    '</div>',
    '<div class="cnt">',
    '<p>Dear <strong>' + (name || 'Valued Customer') + '</strong>,</p>',
    '<p>Your property document analysis is complete. Here is your full report:</p>',
    '<div class="bar">',
    '<span class="b hi">🔴 ' + highRisks + ' High Risk</span>',
    '<span class="b me">🟠 ' + medRisks + ' Medium Risk</span>',
    '<span class="b lo">🟢 ' + lowRisks + ' Low Risk</span>',
    '<span class="b" style="background:#f5f5f5;color:#424242">Total: ' + total + ' Findings</span>',
    '</div>',
    propertyAddress ? '<p><strong>Property:</strong> ' + propertyAddress + '</p>' : '',
    '<div class="rpt">' + reportHtml + '</div>',
    '<div style="background:#fff8e1;padding:16px;border-left:4px solid #ffc107;border-radius:6px;font-size:13px;margin:20px 0">',
    '<strong>Legal Disclaimer:</strong> This report is generated by an AI-assisted analysis system for informational purposes only and does not constitute legal advice. Verihome NZ and Protocol Zero Limited recommend consulting a qualified New Zealand solicitor before making any property decisions.',
    '</div>',
    '<p>Questions? <a href="mailto:support@verihome.co.nz">support@verihome.co.nz</a></p>',
    '<p>Best regards,<br><strong>The Verihome NZ Legal Analysis Team</strong></p>',
    '</div>',
    '<div class="ftr">Protocol Zero Limited · Verihome NZ · AI-Powered NZ Property Document Analysis<br>',
    'This email contains confidential analysis prepared for the named recipient only.</div>',
    '</body></html>'
  ].join('\n');
}

// ── Risk Count Parser (robust, 3-strategy) ─────────────────────────────────────
function parseRiskCountsFromHtml(reportHtml) {
  if (!reportHtml) return { highRisks: 0, medRisks: 0, lowRisks: 0, total: 0 };

  let highRisks = 0, medRisks = 0, lowRisks = 0;
  try {
    // Strategy 1: explicit data-risk attributes added by AI
    highRisks = (reportHtml.match(/data-risk=["']HIGH["']/gi) || []).length;
    medRisks  = (reportHtml.match(/data-risk=["']MEDIUM["']/gi) || []).length;
    lowRisks  = (reportHtml.match(/data-risk=["']LOW["']/gi) || []).length;

    // Strategy 2: count <div class="finding"> blocks inside each section
    if (highRisks + medRisks + lowRisks === 0) {
      // Split HTML at section boundary markers
      const sectionBoundary = /(?:NEGOTIATION|DUE DILIGENCE|PRE.UNCONDITIONAL|CHECKLIST|WHEN TO|APPLICABLE|RELEVANT NZ|LEGAL CONDITIONS)/i;

      const highMatch = reportHtml.match(/(?:HIGH RISK|HIGH-RISK FINDINGS?)[\s\S]*?(?=(?:MEDIUM RISK|LOW RISK|NEGOTIATION|DUE DILIGENCE|PRE.UNCON|CHECKLIST|WHEN TO|APPLICABLE|<\/body)|$)/i);
      const medMatch  = reportHtml.match(/(?:MEDIUM RISK|MEDIUM-RISK FINDINGS?)[\s\S]*?(?=(?:LOW RISK|NEGOTIATION|DUE DILIGENCE|PRE.UNCON|CHECKLIST|WHEN TO|APPLICABLE|<\/body)|$)/i);
      const lowMatch  = reportHtml.match(/(?:LOW RISK|LOW-RISK FINDINGS?)[\s\S]*?(?=(?:NEGOTIATION|DUE DILIGENCE|PRE.UNCON|CHECKLIST|WHEN TO|APPLICABLE|<\/body)|$)/i);

      // Count individual findings: <div class="finding">, <li>, or <p> tags that indicate separate items
      if (highMatch) highRisks = (highMatch[0].match(/<div[^>]*class=["'][^"']*finding|<li[\s>]/gi) || []).length || Math.max(0, (highMatch[0].match(/<p>/gi) || []).length - 1);
      if (medMatch)  medRisks  = (medMatch[0].match(/<div[^>]*class=["'][^"']*finding|<li[\s>]/gi) || []).length || Math.max(0, (medMatch[0].match(/<p>/gi) || []).length - 1);
      if (lowMatch)  lowRisks  = (lowMatch[0].match(/<div[^>]*class=["'][^"']*finding|<li[\s>]/gi) || []).length || Math.max(0, (lowMatch[0].match(/<p>/gi) || []).length - 1);
    }

    // Strategy 3: count how many times HIGH/MEDIUM/LOW appear as styled labels in the report body
    if (highRisks + medRisks + lowRisks === 0) {
      // Look for colour indicators or badge patterns
      highRisks = (reportHtml.match(/(?:border-left[^;]*#e74c3c|border-left[^;]*red|border-left[^;]*#c0392b|border-left[^;]*#c62828)/gi) || []).length;
      medRisks  = (reportHtml.match(/(?:border-left[^;]*#e67e22|border-left[^;]*orange|border-left[^;]*#f39c12)/gi) || []).length;
      lowRisks  = (reportHtml.match(/(?:border-left[^;]*#27ae60|border-left[^;]*green|border-left[^;]*#2ecc71)/gi) || []).length;
    }

  } catch (e) {
    console.warn('parseRiskCountsFromHtml error:', e.message);
  }

  // Minimum 1 per category if the section heading exists at all
  if (highRisks === 0 && /HIGH RISK/i.test(reportHtml)) highRisks = 1;
  if (medRisks  === 0 && /MEDIUM RISK/i.test(reportHtml)) medRisks  = 1;
  if (lowRisks  === 0 && /LOW RISK/i.test(reportHtml)) lowRisks  = 1;

  console.log('Risk parse result — HIGH:', highRisks, 'MED:', medRisks, 'LOW:', lowRisks);
  return { highRisks, medRisks, lowRisks, total: highRisks + medRisks + lowRisks };
}
