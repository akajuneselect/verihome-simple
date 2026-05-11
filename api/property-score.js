const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Rate limiting: simple in-memory store (per-deployment)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 requests per IP per minute

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count += 1;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

// ── NZ Suburb intelligence ────────────────────────────────────────────────────
const NZ_SUBURB_DATA = {
  // Auckland premium suburbs
  'remuera': { city: 'Auckland', tier: 'premium', medianPrice: 2200000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'parnell': { city: 'Auckland', tier: 'premium', medianPrice: 1800000, growth: 'steady', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'herne bay': { city: 'Auckland', tier: 'premium', medianPrice: 2500000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'medium', liquefaction: 'low' },
  'ponsonby': { city: 'Auckland', tier: 'premium', medianPrice: 1900000, growth: 'steady', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'mt eden': { city: 'Auckland', tier: 'premium', medianPrice: 1650000, growth: 'steady', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'epsom': { city: 'Auckland', tier: 'premium', medianPrice: 1750000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'grey lynn': { city: 'Auckland', tier: 'mid', medianPrice: 1350000, growth: 'growing', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'onehunga': { city: 'Auckland', tier: 'mid', medianPrice: 980000, growth: 'growing', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'low' },
  'mt albert': { city: 'Auckland', tier: 'mid', medianPrice: 1100000, growth: 'steady', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  'henderson': { city: 'Auckland', tier: 'entry', medianPrice: 820000, growth: 'growing', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'low' },
  'manurewa': { city: 'Auckland', tier: 'entry', medianPrice: 720000, growth: 'growing', schoolZone: 'below_average', floodRisk: 'low', liquefaction: 'low' },
  'auckland cbd': { city: 'Auckland', tier: 'cbd', medianPrice: 680000, growth: 'volatile', schoolZone: 'limited', floodRisk: 'medium', liquefaction: 'low' },
  'newmarket': { city: 'Auckland', tier: 'premium', medianPrice: 1200000, growth: 'steady', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  'st heliers': { city: 'Auckland', tier: 'premium', medianPrice: 1900000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'devonport': { city: 'Auckland', tier: 'premium', medianPrice: 1600000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'medium', liquefaction: 'low' },
  'takapuna': { city: 'Auckland', tier: 'premium', medianPrice: 1500000, growth: 'steady', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'albany': { city: 'Auckland', tier: 'mid', medianPrice: 1050000, growth: 'growing', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  'east tamaki': { city: 'Auckland', tier: 'mid', medianPrice: 880000, growth: 'growing', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'low' },
  'pakuranga': { city: 'Auckland', tier: 'mid', medianPrice: 960000, growth: 'steady', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'howick': { city: 'Auckland', tier: 'mid', medianPrice: 1100000, growth: 'steady', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  // Wellington
  'thorndon': { city: 'Wellington', tier: 'premium', medianPrice: 1200000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'medium' },
  'kelburn': { city: 'Wellington', tier: 'premium', medianPrice: 1100000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'karori': { city: 'Wellington', tier: 'mid', medianPrice: 890000, growth: 'steady', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  'brooklyn': { city: 'Wellington', tier: 'mid', medianPrice: 820000, growth: 'growing', schoolZone: 'good', floodRisk: 'low', liquefaction: 'low' },
  'te aro': { city: 'Wellington', tier: 'cbd', medianPrice: 650000, growth: 'volatile', schoolZone: 'limited', floodRisk: 'medium', liquefaction: 'medium' },
  'wellington cbd': { city: 'Wellington', tier: 'cbd', medianPrice: 630000, growth: 'volatile', schoolZone: 'limited', floodRisk: 'medium', liquefaction: 'medium' },
  'island bay': { city: 'Wellington', tier: 'mid', medianPrice: 820000, growth: 'steady', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'medium' },
  'newtown': { city: 'Wellington', tier: 'entry', medianPrice: 720000, growth: 'growing', schoolZone: 'average', floodRisk: 'low', liquefaction: 'medium' },
  'petone': { city: 'Wellington', tier: 'entry', medianPrice: 680000, growth: 'growing', schoolZone: 'average', floodRisk: 'high', liquefaction: 'high' },
  'lower hutt': { city: 'Wellington', tier: 'entry', medianPrice: 620000, growth: 'growing', schoolZone: 'average', floodRisk: 'high', liquefaction: 'high' },
  // Christchurch
  'fendalton': { city: 'Christchurch', tier: 'premium', medianPrice: 1200000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'merivale': { city: 'Christchurch', tier: 'premium', medianPrice: 1100000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'riccarton': { city: 'Christchurch', tier: 'mid', medianPrice: 680000, growth: 'growing', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'medium' },
  'addington': { city: 'Christchurch', tier: 'entry', medianPrice: 580000, growth: 'growing', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'medium' },
  'papanui': { city: 'Christchurch', tier: 'mid', medianPrice: 720000, growth: 'steady', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'medium' },
  'fitzgerald avenue': { city: 'Christchurch', tier: 'mid', medianPrice: 690000, growth: 'growing', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'medium' },
  'sumner': { city: 'Christchurch', tier: 'premium', medianPrice: 1050000, growth: 'stable', schoolZone: 'excellent', floodRisk: 'medium', liquefaction: 'low' },
  'burnside': { city: 'Christchurch', tier: 'mid', medianPrice: 780000, growth: 'steady', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  // Hamilton / Tauranga / Dunedin
  'hamilton cbd': { city: 'Hamilton', tier: 'entry', medianPrice: 580000, growth: 'growing', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'low' },
  'rototuna': { city: 'Hamilton', tier: 'mid', medianPrice: 820000, growth: 'growing', schoolZone: 'excellent', floodRisk: 'low', liquefaction: 'low' },
  'papamoa': { city: 'Tauranga', tier: 'mid', medianPrice: 890000, growth: 'growing', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'mount maunganui': { city: 'Tauranga', tier: 'premium', medianPrice: 1150000, growth: 'steady', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'mosgiel': { city: 'Dunedin', tier: 'entry', medianPrice: 480000, growth: 'growing', schoolZone: 'good', floodRisk: 'medium', liquefaction: 'low' },
  'dunedin cbd': { city: 'Dunedin', tier: 'entry', medianPrice: 450000, growth: 'steady', schoolZone: 'average', floodRisk: 'medium', liquefaction: 'low' },
};

function detectSuburb(input) {
  const lower = input.toLowerCase();
  let bestMatch = null;
  let bestLen = 0;
  for (const key of Object.keys(NZ_SUBURB_DATA)) {
    if (lower.includes(key) && key.length > bestLen) {
      bestMatch = key;
      bestLen = key.length;
    }
  }
  return bestMatch ? NZ_SUBURB_DATA[bestMatch] : null;
}

function detectListingSite(input) {
  if (input.includes('trademe.co.nz')) return 'Trade Me';
  if (input.includes('realestate.co.nz')) return 'realestate.co.nz';
  if (input.includes('oneroof.co.nz')) return 'OneRoof';
  if (input.includes('harcourts')) return 'Harcourts';
  if (input.includes('barfoot')) return 'Barfoot & Thompson';
  if (input.includes('raywhite') || input.includes('ray-white')) return 'Ray White';
  if (input.includes('ljhooker')) return 'LJ Hooker';
  return null;
}

function extractPriceFromInput(input) {
  // Match patterns like $850,000 or $850k or 850000
  const m = input.match(/\$([0-9,]+)k?/i) || input.match(/([0-9]{6,7})/);
  if (m) {
    let val = m[1].replace(/,/g,'');
    if (m[0].toLowerCase().includes('k')) val = parseFloat(val) * 1000;
    return parseInt(val);
  }
  return null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const { input } = req.body || {};
  if (!input || typeof input !== 'string' || input.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide a valid property URL or address.' });
  }

  const trimmedInput = input.trim().substring(0, 500); // safety limit

  // Pre-enrich with known suburb data
  const suburbData = detectSuburb(trimmedInput);
  const listingSite = detectListingSite(trimmedInput);
  const extractedPrice = extractPriceFromInput(trimmedInput);

  const suburbContext = suburbData ? `
KNOWN NZ SUBURB DATA:
- City: ${suburbData.city}
- Market Tier: ${suburbData.tier}
- Approximate Median Price: $${suburbData.medianPrice.toLocaleString()} NZD
- Market Growth Trend: ${suburbData.growth}
- School Zone Quality: ${suburbData.schoolZone}
- Flood Risk: ${suburbData.floodRisk}
- Liquefaction Risk: ${suburbData.liquefaction}
` : '';

  const listingContext = listingSite ? `Listing platform: ${listingSite}\n` : '';
  const priceContext = extractedPrice ? `Detected asking price: $${extractedPrice.toLocaleString()} NZD\n` : '';

  const systemPrompt = `You are a senior New Zealand property analyst with expert knowledge of the NZ real estate market, including suburb profiles, LIM reports, weathertightness risks, NZ building standards, investment yields, and the NZ legal framework for property purchase.

Your job is to analyse a property input (URL or address) and produce a structured JSON score covering 6 dimensions. You must provide realistic, specific NZ-market analysis — not generic advice.

Respond ONLY with valid JSON in exactly this structure:
{
  "propertyTitle": "brief property description (max 80 chars)",
  "overallScore": 7.2,
  "verdict": "One sentence overall assessment for the buyer.",
  "dimensions": [
    {
      "id": "location",
      "name": "Location & Suburb",
      "icon": "🗺️",
      "score": 8.0,
      "summary": "2-3 sentences: suburb profile, amenities, transport links, school zone quality, growth trajectory."
    },
    {
      "id": "price",
      "name": "Price vs Market",
      "icon": "💰",
      "score": 7.0,
      "summary": "2-3 sentences: how the price compares to suburb median, current market conditions, affordability, and whether value looks fair, premium or discounted."
    },
    {
      "id": "risk",
      "name": "Risk Signals",
      "icon": "⚠️",
      "score": 6.5,
      "summary": "2-3 sentences: NZ-specific risks such as weathertightness, monolithic cladding, leaky building era (1990-2004), liquefaction zone, flood risk, earthquake-prone building register, cross-lease or unit title complexity."
    },
    {
      "id": "condition",
      "name": "Property Condition",
      "icon": "🏗️",
      "score": 7.5,
      "summary": "2-3 sentences: age-based risks, likely condition for the era and type, common issues with NZ housing stock of this age, likely maintenance requirements."
    },
    {
      "id": "investment",
      "name": "Investment Potential",
      "icon": "📈",
      "score": 7.0,
      "summary": "2-3 sentences: rental yield estimate for this suburb/type, capital growth outlook, demand drivers, any gentrification or infrastructure tailwinds."
    },
    {
      "id": "legal",
      "name": "Legal Complexity",
      "icon": "📄",
      "score": 8.0,
      "summary": "2-3 sentences: title type (freehold vs cross-lease vs unit title vs leasehold), likely legal due diligence requirements, complexity of purchase process, key documents the buyer must review."
    }
  ],
  "keyFindings": [
    { "title": "Finding Title", "detail": "Specific finding detail (1-2 sentences).", "sentiment": "positive" },
    { "title": "Finding Title", "detail": "Specific finding detail (1-2 sentences).", "sentiment": "neutral" },
    { "title": "Finding Title", "detail": "Specific finding detail (1-2 sentences).", "sentiment": "negative" },
    { "title": "Finding Title", "detail": "Specific finding detail (1-2 sentences).", "sentiment": "positive" },
    { "title": "Finding Title", "detail": "Specific finding detail (1-2 sentences).", "sentiment": "neutral" }
  ]
}

Rules:
- Scores must be between 1.0 and 10.0 with one decimal place
- overallScore = weighted average (location 20%, price 20%, risk 20%, condition 15%, investment 15%, legal 10%)
- sentiment must be exactly "positive", "neutral", or "negative"
- Provide exactly 5 keyFindings mixing positive and negative
- Be specific and NZ-market-relevant, not generic
- If only an address is given, infer suburb characteristics from your NZ knowledge
- If no price info is available, comment on typical price range for the suburb and property type
- Do NOT include any text outside the JSON object`;

  const userMessage = `Analyse this NZ property and produce a JSON score:

INPUT: ${trimmedInput}

${listingContext}${priceContext}${suburbContext}

Produce the JSON score now. Be specific about this suburb, property type, and NZ market conditions.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 1800,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0].message.content;
    let result;
    try {
      result = JSON.parse(raw);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message, 'raw:', raw.substring(0, 200));
      return res.status(500).json({ error: 'Analysis parsing failed. Please try again.' });
    }

    // Validate required fields
    if (!result.overallScore || !result.dimensions || !Array.isArray(result.dimensions)) {
      return res.status(500).json({ error: 'Incomplete analysis returned. Please try again.' });
    }

    // Clamp scores
    result.overallScore = Math.min(10, Math.max(1, parseFloat(result.overallScore) || 5));
    result.dimensions = result.dimensions.map(d => ({
      ...d,
      score: Math.min(10, Math.max(1, parseFloat(d.score) || 5))
    }));

    return res.status(200).json(result);

  } catch (err) {
    console.error('OpenAI error:', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'AI service is busy. Please try again in a moment.' });
    }
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};
