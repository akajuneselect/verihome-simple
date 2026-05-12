const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

const PURPOSE_LABELS = {
  buying_home: '🏡 Buying to live in',
  investment:  '📈 Investment / rental',
  researching: '🔍 Just researching',
  other:       '💬 Other',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, purpose, propertyInput, overallScore, propertyTitle, timestamp } = req.body || {};

  // Basic validation
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const leadData = {
    email: email.toLowerCase().trim(),
    purpose: purpose || 'unknown',
    property_input: propertyInput || '',
    overall_score: overallScore || null,
    property_title: propertyTitle || '',
    source: 'property_score_tool',
    created_at: timestamp || new Date().toISOString(),
  };

  // 1. Save to Supabase
  try {
    const { error } = await supabase
      .from('score_leads')
      .insert([leadData]);

    if (error && error.code !== '23505') {
      // 23505 = duplicate email, not a hard failure
      console.error('Supabase lead insert error:', error.message);
    } else if (error?.code === '23505') {
      console.log('Duplicate lead email, skipping insert:', email);
    } else {
      console.log('Lead saved to Supabase:', email);
    }
  } catch (dbErr) {
    console.error('Supabase connection error:', dbErr.message);
    // Don't fail the whole request — still send email
  }

  // 2. Notify you via email
  const purposeLabel = PURPOSE_LABELS[purpose] || purpose || 'Unknown';
  const scoreDisplay = overallScore ? `${overallScore}/10` : 'N/A';
  const notifyHtml = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f4f7fb;margin:0;padding:20px">
<div style="max-width:520px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <div style="background:#1a3c5e;color:white;padding:20px 24px">
    <h2 style="margin:0;font-size:1.1rem">🎯 New Property Score Lead</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:.85rem">Someone just used the free AI scoring tool</p>
  </div>
  <div style="padding:24px">
    <table style="width:100%;border-collapse:collapse;font-size:.9rem">
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef2f7;color:#666;width:38%">📧 Email</td>
          <td style="padding:10px 0;border-bottom:1px solid #eef2f7;font-weight:700;color:#1a3c5e">${email}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef2f7;color:#666">🎯 Purpose</td>
          <td style="padding:10px 0;border-bottom:1px solid #eef2f7;font-weight:700">${purposeLabel}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef2f7;color:#666">🏠 Property</td>
          <td style="padding:10px 0;border-bottom:1px solid #eef2f7">${propertyTitle || propertyInput || 'N/A'}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #eef2f7;color:#666">⭐ AI Score</td>
          <td style="padding:10px 0;border-bottom:1px solid #eef2f7;font-weight:700;font-size:1.1rem;color:${overallScore >= 7.5 ? '#27ae60' : overallScore >= 5 ? '#e67e22' : '#e74c3c'}">${scoreDisplay}</td></tr>
      <tr><td style="padding:10px 0;color:#666">🕐 Time</td>
          <td style="padding:10px 0">${new Date(timestamp || Date.now()).toLocaleString('en-NZ', {timeZone:'Pacific/Auckland'})}</td></tr>
    </table>
    <div style="margin-top:20px;background:#e8f5e9;border-left:4px solid #27ae60;padding:14px;border-radius:6px;font-size:.85rem">
      <strong style="color:#1d7a46">💡 Follow-up tip:</strong>
      <span style="color:#2e7d32">
      ${purpose === 'buying_home' ? ' This buyer is actively looking to purchase — high conversion potential. Send a personalised welcome and offer a discount on their first document review.' :
        purpose === 'investment' ? ' Investor lead — likely comparing multiple properties. Highlight the Complete or Premium package ROI analysis sections.' :
        purpose === 'researching' ? ' Early-stage researcher — nurture with educational content about NZ property risks before pitching.' :
        ' Warm lead — follow up with a friendly intro email about what Verihome can do for them.'}
      </span>
    </div>
    <div style="margin-top:16px;text-align:center">
      <a href="mailto:${email}?subject=Your Verihome Property Score&body=Hi there,%0A%0AThanks for using the Verihome free property scoring tool!..."
         style="display:inline-block;background:#1a3c5e;color:white;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:.9rem">
        ✉️ Reply to This Lead
      </a>
    </div>
  </div>
  <div style="background:#f8f9fa;padding:14px;text-align:center;font-size:.75rem;color:#999">
    Verihome NZ · Property Score Lead Notification · <a href="https://verihome-simple.vercel.app/property-score.html" style="color:#1a3c5e">View Tool</a>
  </div>
</div>
</body></html>`;

  try {
    const { error: emailError } = await resend.emails.send({
      from: 'Verihome Leads <support@verihome.co.nz>',
      to: 'support@verihome.co.nz',
      subject: `🎯 New Lead: ${purposeLabel} — Score ${scoreDisplay} — ${email}`,
      html: notifyHtml,
    });
    if (emailError) console.error('Lead notification email error:', emailError);
    else console.log('Lead notification sent for:', email);
  } catch (emailErr) {
    console.error('Resend error:', emailErr.message);
  }

  // 3. Send a welcome email to the user
  const welcomeHtml = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#f4f7fb;margin:0;padding:20px">
<div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#1a3c5e 0%,#2563a8 100%);color:white;padding:28px 24px;text-align:center">
    <h1 style="margin:0;font-size:1.4rem;font-weight:800">Verihome NZ</h1>
    <p style="margin:6px 0 0;opacity:.85;font-size:.95rem">Your property score is now unlocked ✅</p>
  </div>
  <div style="padding:28px 24px">
    <p style="margin:0 0 16px">Hi there,</p>
    <p style="color:#555;line-height:1.65;margin:0 0 20px">Thanks for using the <strong>Verihome Free Property Score</strong> tool. Your AI analysis is ready — and we hope it gives you a useful head-start on this property.</p>
    <div style="background:#e8f0f8;border-left:4px solid #1a3c5e;padding:16px;border-radius:6px;margin-bottom:24px">
      <p style="margin:0;font-size:.9rem;color:#1a3c5e;font-weight:700">🏠 Property Scored</p>
      <p style="margin:6px 0 0;font-size:.88rem;color:#444">${propertyTitle || propertyInput || 'Your property'}</p>
      <p style="margin:6px 0 0;font-size:1.1rem;font-weight:800;color:#1a3c5e">AI Score: ${scoreDisplay}</p>
    </div>
    <p style="color:#555;line-height:1.65;margin:0 0 8px"><strong>Remember:</strong> This free score is a starting point — it's based on publicly available data and AI analysis. Before you go unconditional, you should get a proper legal review of the actual documents.</p>
    <p style="color:#555;line-height:1.65;margin:0 0 24px">A Verihome Complete Analysis of your <strong>LIM report, building inspection, and Sale & Purchase Agreement</strong> starts from just <strong>$69 NZD</strong> — and can save you from costly surprises.</p>
    <div style="text-align:center;margin:24px 0">
      <a href="https://www.verihome.co.nz/#pricing"
         style="display:inline-block;background:#27ae60;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:1rem">
        Get Full Legal Review from $69 →
      </a>
    </div>
    <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:14px;font-size:.78rem;color:#7a5c00;line-height:1.5">
      <strong>Disclaimer:</strong> This free score is AI-generated from publicly available data and does not constitute legal or financial advice. Always conduct proper due diligence with a qualified NZ solicitor.
    </div>
  </div>
  <div style="background:#f8f9fa;padding:16px;text-align:center;font-size:.75rem;color:#999">
    © 2025 Protocol Zero Limited · Verihome NZ ·
    <a href="https://www.verihome.co.nz/privacy.html" style="color:#666">Privacy</a>
  </div>
</div>
</body></html>`;

  try {
    const { error: welcomeErr } = await resend.emails.send({
      from: 'Verihome NZ <support@verihome.co.nz>',
      to: email,
      subject: `Your Verihome Property Score is Ready — ${scoreDisplay}`,
      html: welcomeHtml,
    });
    if (welcomeErr) console.error('Welcome email error:', welcomeErr);
    else console.log('Welcome email sent to:', email);
  } catch (e) {
    console.error('Welcome email send error:', e.message);
  }

  return res.status(200).json({ success: true });
};
