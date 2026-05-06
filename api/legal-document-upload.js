/**
 * api/legal-document-upload.js
 *
 * FOUR-LAYER ANALYSIS ARCHITECTURE
 * Layer 1 (FREE): NZ rule engine - regex scan. Zero AI cost.
 * Layer 2 (FREE): GPT-4o-mini classifier - doc type + risk categories. ~$0.0002/upload.
 * Layer 3 (FREE PREVIEW): Cross-reference L1 + L2 for accurate results.
 * Layer 4 (PAID): Full GPT analysis in webhook.
 *
 * FIX: Supabase requires 'ws' package on Node.js < 22 in serverless environments.
 */
const multiparty = require('multiparty');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const OpenAI = require('openai');
const ws = require('ws');
const { createClient } = require('@supabase/supabase-js');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getSupabase() {
          return createClient(
                      process.env.SUPABASE_URL,
                      process.env.SUPABASE_SERVICE_ROLE_KEY,
                  {
                                auth: { persistSession: false, autoRefreshToken: false },
                                realtime: { transport: ws },
                  }
                    );
}

// ============================================================
// LAYER 1: NZ Property Risk Rule Engine
// ============================================================
const NZ_RISK_RULES = {
          spa: [
                  { pattern: /as\s+is\s+where\s+is/gi, risk: 'HIGH', category: 'Contract Terms', message: '"As is where is" clause detected - seller disclaims ALL responsibility for property condition. You have no recourse after settlement.' },
                  { pattern: /cash\s+unconditional/gi, risk: 'HIGH', category: 'Contract Terms', message: 'Cash unconditional offer - you have NO finance or due diligence protection. Any issues discovered are entirely at your risk.' },
                  { pattern: /no\s+due\s+diligence/gi, risk: 'HIGH', category: 'Due Diligence', message: 'Due diligence condition waived - you cannot legally withdraw if serious issues are found after signing.' },
                  { pattern: /leasehold/gi, risk: 'HIGH', category: 'Title', message: 'Leasehold title detected - ground rent reviews can dramatically increase holding costs. Legal advice essential before proceeding.' },
                  { pattern: /meth(amphetamine)?\s+(contamin|test|residue)/gi, risk: 'HIGH', category: 'Contamination', message: 'Methamphetamine contamination reference found - obtain independent meth test immediately. Remediation can exceed $50,000 NZD.' },
                  { pattern: /periodic\s+tenan(cy|t)/gi, risk: 'HIGH', category: 'Tenancy', message: 'Existing periodic tenancy - tenant may be difficult to remove before settlement. Under RTA, at least 90 days notice required for owner-occupation.' },
                  { pattern: /tenan(cy|t)\s+(in\s+place|remains|continuing|current)/gi, risk: 'HIGH', category: 'Tenancy', message: 'Tenancy in place at settlement - confirm tenancy terms, bond, and exit arrangements before going unconditional.' },
                  { pattern: /subject\s+to\s+(existing\s+)?tenanc/gi, risk: 'HIGH', category: 'Tenancy', message: 'Property sold subject to existing tenancy - you inherit all tenancy obligations including bond and notice periods.' },
                  { pattern: /body\s+corporate/gi, risk: 'MEDIUM', category: 'Body Corporate', message: 'Body corporate property - you must obtain levy statements and recent meeting minutes. Unexpected special levies can cost tens of thousands.' },
                  { pattern: /unit\s+title/gi, risk: 'MEDIUM', category: 'Title', message: 'Unit title property - pre-contract disclosure statement legally required under Unit Titles Act 2010. Failure to provide is a red flag.' },
                  { pattern: /cross[\s-]?lease/gi, risk: 'MEDIUM', category: 'Title', message: 'Cross-lease title - the flats plan must exactly match current structures. Illegal alterations are extremely common and costly to remedy.' },
                  { pattern: /settlement\s+(date|period|is)/gi, risk: 'MEDIUM', category: 'Settlement', message: 'Settlement date found - confirm all finance, LIM, and inspection conditions can be completed within this timeframe. Extensions can be refused.' },
                  { pattern: /(\d+)\s*working\s+days/gi, risk: 'MEDIUM', category: 'Settlement', message: 'Working day deadline detected - bank approval, valuation, and legal review all take time. Ensure the timeline is realistic for your situation.' },
                  { pattern: /penalty\s+(interest|clause)/gi, risk: 'MEDIUM', category: 'Financial', message: 'Penalty interest clause - if settlement is delayed, you may be charged penalty interest at a significantly higher rate than your mortgage.' },
                  { pattern: /gst\s+(is\s+not\s+included|exclusive|registered)/gi, risk: 'MEDIUM', category: 'Financial', message: 'GST clause detected - if property is a business asset, GST may be payable on top of the purchase price. Seek urgent tax advice.' },
                  { pattern: /indemnit(y|ies)/gi, risk: 'MEDIUM', category: 'Contract Terms', message: 'Indemnity clause found - you may be taking on liability for costs or losses beyond the purchase price. Have a lawyer review this clause.' },
                  { pattern: /easement/gi, risk: 'MEDIUM', category: 'Title', message: 'Easement referenced - third parties may have rights to use part of your property. Confirm the easement details and how they affect your use.' },
                  { pattern: /covenant/gi, risk: 'MEDIUM', category: 'Title', message: 'Covenant found - restrictions on how you can use or develop the property may apply. These are permanent and bind all future owners.' },
                  { pattern: /subject\s+to\s+finance/gi, risk: 'LOW', category: 'Conditions', message: 'Finance condition present - this is standard buyer protection. Ensure the finance date gives your bank sufficient time for approval.' },
                  { pattern: /due\s+diligence\s+(condition|period)/gi, risk: 'LOW', category: 'Due Diligence', message: 'Due diligence condition - protects you to withdraw if issues are found. Confirm the timeframe is sufficient for inspections and LIM review.' },
                  { pattern: /chattels?/gi, risk: 'LOW', category: 'Chattels', message: 'Chattels listed in the agreement - verify all items are physically present and in working order at settlement date.' },
                  { pattern: /vacant\s+possession/gi, risk: 'LOW', category: 'Possession', message: 'Vacant possession required at settlement - if currently tenanted, confirm the tenancy end date and notice has been given.' },
                  { pattern: /purchaser\s+must\s+not\s+assign/gi, risk: 'LOW', category: 'Contract Terms', message: 'Assignment restriction - you cannot on-sell this contract to another buyer before settlement.' },
                  { pattern: /LIM\s+(report|condition)/gi, risk: 'LOW', category: 'Conditions', message: 'LIM condition included - ensure you obtain the LIM from council and review it thoroughly within the condition period.' },
                  { pattern: /building\s+(inspection|report)\s+(condition|subject)/gi, risk: 'LOW', category: 'Conditions', message: 'Building inspection condition - engage a licensed building inspector before the condition deadline. Do not skip this step.' },
                    ],
          lim: [
                  { pattern: /outstanding\s+(building\s+)?consent/gi, risk: 'HIGH', category: 'Building Consent', message: 'Outstanding building consent - structures may be illegal. Demand code compliance certificate before proceeding.' },
                  { pattern: /no\s+code\s+compliance/gi, risk: 'HIGH', category: 'Building Consent', message: 'No code compliance certificate - council has not signed off on completed building work. Major liability risk.' },
                  { pattern: /requisition/gi, risk: 'HIGH', category: 'Council Notice', message: 'Council requisition on property - legal obligation to remediate, cost passes to new owner.' },
                  { pattern: /notice\s+to\s+(fix|rectify|remedy)/gi, risk: 'HIGH', category: 'Council Notice', message: 'Notice to fix issued by council - legal repair obligation that transfers to purchaser.' },
                  { pattern: /flood(ing|plain|prone)?/gi, risk: 'HIGH', category: 'Environmental', message: 'Flood risk noted in LIM - check council flood maps and obtain insurance quotes before committing.' },
                  { pattern: /liquefaction/gi, risk: 'HIGH', category: 'Environmental', message: 'Liquefaction risk - common in Christchurch, Wellington coastal areas. Verify EQC claims history.' },
                  { pattern: /contaminated\s+(land|site|soil)/gi, risk: 'HIGH', category: 'Environmental', message: 'Land contamination recorded on LIM - remediation costs can be very substantial.' },
                  { pattern: /asbestos/gi, risk: 'HIGH', category: 'Hazardous Materials', message: 'Asbestos referenced - if pre-1990 building, obtain asbestos survey before purchase.' },
                  { pattern: /erosion\s+risk/gi, risk: 'HIGH', category: 'Environmental', message: 'Erosion risk - may affect future insurability and long-term property value.' },
                  { pattern: /heritage\s+(order|designation|listing)/gi, risk: 'MEDIUM', category: 'Heritage', message: 'Heritage designation - limits alterations significantly, may affect resale value.' },
                  { pattern: /designation/gi, risk: 'MEDIUM', category: 'Planning', message: 'Land designation found - local or central government may have acquisition rights.' },
                  { pattern: /onsite\s+(wastewater|septic)/gi, risk: 'MEDIUM', category: 'Services', message: 'Onsite wastewater system - verify compliance with regional council rules; ongoing maintenance costs.' },
                  { pattern: /resource\s+consent/gi, risk: 'LOW', category: 'Planning', message: 'Resource consent on record - check ongoing consent conditions and obligations.' },
                    ],
          building: [
                  { pattern: /moisture\s+(meter|reading|level|damage|intrusion)/gi, risk: 'HIGH', category: 'Moisture', message: 'Moisture issues detected - may indicate weathertightness failure. Get specialist report urgently.' },
                  { pattern: /weathertight(ness)?(\s+risk|\s+failure|\s+issue)?/gi, risk: 'HIGH', category: 'Weathertightness', message: 'Weathertightness risk flagged - NZ leaky building remediation can exceed $200,000 NZD.' },
                  { pattern: /monolithic\s+cladding/gi, risk: 'HIGH', category: 'Weathertightness', message: 'Monolithic cladding system - high weathertightness risk, common in 1990s-2000s NZ builds.' },
                  { pattern: /eifs|exterior\s+insulation/gi, risk: 'HIGH', category: 'Weathertightness', message: 'EIFS cladding - closely associated with NZ leaky building crisis. Specialist assessment required.' },
                  { pattern: /structural\s+(concern|issue|damage|defect|movement)/gi, risk: 'HIGH', category: 'Structure', message: 'Structural concerns - engage a structural engineer before going unconditional.' },
                  { pattern: /foundation\s+(crack|subsidence|settlement|movement)/gi, risk: 'HIGH', category: 'Structure', message: 'Foundation issues - can be very costly to remediate; obtain engineering assessment.' },
                  { pattern: /urgent\s+(repair|attention|remediation)/gi, risk: 'HIGH', category: 'Urgent Works', message: 'Urgent repairs flagged - use these to negotiate purchase price reduction.' },
                  { pattern: /earthquake\s+(damage|prone|risk)/gi, risk: 'HIGH', category: 'Earthquake', message: 'Earthquake damage or risk - check council earthquake-prone building register and EQC claims.' },
                  { pattern: /\$[\d,]+\s*(to|-)\s*\$[\d,]+/g, risk: 'MEDIUM', category: 'Cost Estimates', message: 'Repair cost estimates found - total all figures for price negotiation leverage.' },
                  { pattern: /electrical\s+(fault|issue|concern|non.compliant)/gi, risk: 'MEDIUM', category: 'Electrical', message: 'Electrical issues - non-compliant wiring is a safety concern and may affect insurance.' },
                  { pattern: /plumbing\s+(leak|issue|concern|age)/gi, risk: 'MEDIUM', category: 'Plumbing', message: 'Plumbing concerns - aged or leaking pipes can be expensive to replace throughout a house.' },
                  { pattern: /re.roofing\s+recommended|roof\s+(end|near)\s+of\s+life/gi, risk: 'MEDIUM', category: 'Roofing', message: 'Roof replacement recommended - budget $15,000-$45,000 NZD depending on size and material.' },
                  { pattern: /uninspected\s+area/gi, risk: 'MEDIUM', category: 'Inspection Limitation', message: 'Areas not inspected - hidden risks remain. Consider invasive investigation before committing.' },
                    ],
};

// ============================================================
// LAYER 2: GPT-4o-mini Classifier
// ============================================================
async function classifyWithAI(text, docTypeHint) {
          const excerpt = text.slice(0, 4000);
          try {
                      const response = await openai.chat.completions.create({
                                    model: 'gpt-4o-mini',
                                    messages: [
                                            {
                                                              role: 'system',
                                                              content: 'You are an expert New Zealand property document risk analyst. Your job is to identify ALL potential risks in property documents to protect buyers. Return ONLY valid JSON - no explanation, no markdown.',
                                            },
                                            {
                                                              role: 'user',
                                                              content: `Analyse this NZ property document for buyer risks. User-selected type hint: "${docTypeHint || 'unknown'}"

                                                              Document text (first 4000 chars):
                                                              ---
                                                              ${excerpt}
                                                              ---

                                                              Return this exact JSON shape:
                                                              {
                                                                "docType": "<sale_purchase_agreement | lim_report | building_inspection | title_search | insurance | other>",
                                                                  "docTypeConfidence": "<high | medium | low>",
                                                                    "confirmedRiskCategories": ["<categories with textual evidence>"],
                                                                      "additionalRisks": ["<additional buyer risks found, each as a specific actionable string>"],
                                                                        "estimatedRiskLevel": "<high | medium | low>",
                                                                          "notes": "<one sentence summary>"
                                                                          }

                                                                          Allowed confirmedRiskCategories (pick ALL that apply based on document content):
                                                                          as_is_where_is, settlement_risk, finance_penalty, leasehold, cross_lease, unit_title, body_corporate,
                                                                          flood_zone, liquefaction, asbestos, building_consent, contamination, heritage, resource_consent,
                                                                          weathertightness, structural, monolithic_cladding, eqc_risk, moisture, electrical, plumbing, roofing,
                                                                          cost_estimates, tenancy_risk, easement_covenant, gst_risk, due_diligence_gap, indemnity_clause

                                                                          For additionalRisks: identify 2-4 specific risks in this document that matter to a buyer,
                                                                          written as short actionable warnings (e.g. "short settlement period of 10 working days may not allow sufficient time for LIM and inspection review").
                                                                          Focus on: unusual clauses, tight deadlines, missing conditions, tenancy complications, title issues, financial exposure.`,
                                            },
                                                  ],
                                    temperature: 0,
                                    max_tokens: 600,
                                    response_format: { type: 'json_object' },
                      });

            const raw = response.choices[0]?.message?.content;
                      if (!raw) throw new Error('Empty AI response');
                      const parsed = JSON.parse(raw);
                      console.log('[classifier] tokens:', response.usage?.total_tokens, '| docType:', parsed.docType, '| categories:', parsed.confirmedRiskCategories?.length, '| additionalRisks:', parsed.additionalRisks?.length);
                      return {
                                    docType: parsed.docType || 'other',
                                    docTypeConfidence: parsed.docTypeConfidence || 'low',
                                    confirmedRiskCategories: Array.isArray(parsed.confirmedRiskCategories) ? parsed.confirmedRiskCategories : [],
                                    additionalRisks: Array.isArray(parsed.additionalRisks) ? parsed.additionalRisks : [],
                                    estimatedRiskLevel: parsed.estimatedRiskLevel || 'medium',
                                    notes: parsed.notes || '',
                                    source: 'gpt-4o-mini',
                      };
          } catch (err) {
                      console.warn('[classifier] AI failed, fallback:', err.message);
                      return fallbackClassify(text, docTypeHint);
          }
}

function fallbackClassify(text, docTypeHint) {
          const t = text.toLowerCase();
          const cats = [];
          if (/as\s+is\s+where\s+is/.test(t)) cats.push('as_is_where_is');
          if (/leasehold/.test(t)) cats.push('leasehold');
          if (/cross[\s-]?lease/.test(t)) cats.push('cross_lease');
          if (/unit\s+title/.test(t)) cats.push('unit_title');
          if (/body\s+corporate/.test(t)) cats.push('body_corporate');
          if (/flood|liquefaction/.test(t)) cats.push('flood_zone');
          if (/asbestos/.test(t)) cats.push('asbestos');
          if (/building\s+consent/.test(t)) cats.push('building_consent');
          if (/weathertight|leaky\s+building/.test(t)) cats.push('weathertightness');
          if (/monolithic|eifs/.test(t)) cats.push('monolithic_cladding');
          if (/structural|foundation/.test(t)) cats.push('structural');
          if (/moisture/.test(t)) cats.push('moisture');
          if (/periodic\s+tenan|tenan(cy|t)\s+in\s+place/.test(t)) cats.push('tenancy_risk');
          if (/easement|covenant/.test(t)) cats.push('easement_covenant');
          if (/gst/.test(t)) cats.push('gst_risk');
          if (/indemnit/.test(t)) cats.push('indemnity_clause');
          return {
                      docType: ({ sp: 'sale_purchase_agreement', lim: 'lim_report', building: 'building_inspection' })[docTypeHint] || 'other',
                      docTypeConfidence: 'low',
                      confirmedRiskCategories: cats,
                      additionalRisks: [],
                      estimatedRiskLevel: cats.length >= 2 ? 'high' : cats.length === 1 ? 'medium' : 'low',
                      notes: '',
                      source: 'fallback',
          };
}

// Map AI category names to rule engine category names
const AI_TO_RULE_MAP = {
          as_is_where_is: 'Contract Terms',
          leasehold: 'Title',
          cross_lease: 'Title',
          unit_title: 'Title',
          body_corporate: 'Body Corporate',
          flood_zone: 'Environmental',
          liquefaction: 'Environmental',
          asbestos: 'Hazardous Materials',
          building_consent: 'Building Consent',
          contamination: 'Environmental',
          heritage: 'Heritage',
          resource_consent: 'Planning',
          weathertightness: 'Weathertightness',
          structural: 'Structure',
          monolithic_cladding: 'Weathertightness',
          eqc_risk: 'Earthquake',
          moisture: 'Moisture',
          electrical: 'Electrical',
          plumbing: 'Plumbing',
          roofing: 'Roofing',
          cost_estimates: 'Cost Estimates',
          settlement_risk: 'Settlement',
          finance_penalty: 'Financial',
          tenancy_risk: 'Tenancy',
          easement_covenant: 'Title',
          gst_risk: 'Financial',
          due_diligence_gap: 'Due Diligence',
          indemnity_clause: 'Contract Terms',
};

// ============================================================
// LAYER 3: Cross-reference & validate (more inclusive for preview)
// ============================================================
function crossReference(ruleFindings, aiResult) {
          const aiCategories = new Set(
                      aiResult.confirmedRiskCategories.map(c => AI_TO_RULE_MAP[c]).filter(Boolean)
                    );

  const validated = [];
          for (const f of ruleFindings) {
                      const confirmed = aiCategories.has(f.category);
                      if (confirmed) {
                                    validated.push({ ...f, aiConfirmed: true, confidence: 'high' });
                      } else if (f.risk === 'HIGH') {
                                    // HIGH risk rule matches always included - buyer safety
                        validated.push({ ...f, aiConfirmed: false, confidence: 'medium' });
                      } else if (f.risk === 'MEDIUM') {
                                    // MEDIUM risk always included - important for buyer awareness
                        validated.push({ ...f, aiConfirmed: false, confidence: 'medium' });
                      } else if (f.risk === 'LOW') {
                                    // LOW risk included if AI confirmed, otherwise still include for S&P docs
                        validated.push({ ...f, aiConfirmed: confirmed, confidence: 'low' });
                      }
          }

  // Add AI-only additional risks
  for (const extra of aiResult.additionalRisks) {
              if (extra && extra.trim()) {
                            validated.push({
                                            risk: 'MEDIUM',
                                            category: 'AI Detected',
                                            message: extra,
                                            context: '',
                                            matchCount: 1,
                                            aiConfirmed: true,
                                            confidence: 'medium',
                                            aiOnly: true
                            });
              }
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          return validated.sort((a, b) => order[a.risk] - order[b.risk]);
}

// ============================================================
// HELPERS
// ============================================================
function runRuleEngine(text, docType) {
          const rules = NZ_RISK_RULES[docType] || [...NZ_RISK_RULES.spa, ...NZ_RISK_RULES.lim, ...NZ_RISK_RULES.building];
          const findings = [];
          for (const rule of rules) {
                      const matches = text.match(rule.pattern);
                      if (matches) {
                                    const idx = text.search(new RegExp(rule.pattern.source, 'i'));
                                    const context = text.substring(Math.max(0, idx - 100), Math.min(text.length, idx + 150)).replace(/\s+/g, ' ').trim();
                                    findings.push({ risk: rule.risk, category: rule.category, message: rule.message, context, matchCount: matches.length });
                      }
          }
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
          return findings.sort((a, b) => order[a.risk] - order[b.risk]);
}

function splitIntoParagraphs(text) {
          return text.split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p.length > 50).map(p => p.slice(0, 500));
}

function detectDocType(text, declared) {
          if (declared && declared !== 'other') return declared;
          const t = text.toLowerCase();
          if (t.includes('land information memorandum') || t.includes(' lim ')) return 'lim';
          if (t.includes('building inspection') || t.includes('building report')) return 'building';
          if (
                      t.includes('sale and purchase') ||
                      t.includes('agreement for sale') ||
                      t.includes('purchase price') ||
                      t.includes('settlement date') ||
                      t.includes('vendor') ||
                      t.includes('purchaser') ||
                      t.includes('conditional') ||
                      t.includes('unconditional')
                    ) return 'spa';
          return 'other';
}

// ============================================================
// MAIN HANDLER
// ============================================================
async function handler(req, res) {
          if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
              const sessionId = uuidv4();
              const uploadDir = `/tmp/legal-docs/${sessionId}`;
              if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

            const form = new multiparty.Form({ uploadDir, maxFilesSize: 50 * 1024 * 1024, maxFields: 10 });

            const result = await new Promise((resolve, reject) => {
                          form.parse(req, async (err, fields, files) => {
                                          if (err) return reject(err);
                                          try {
                                                            const uploadedFiles = files.documents || files.file || [];
                                                            const declaredType = fields.documentType?.[0] || 'other';

                                            if (!uploadedFiles.length) return resolve({ error: 'No files uploaded' });

                                            const supabase = getSupabase();
                                                            const allFindings = [];
                                                            const processedFiles = [];
                                                            const storedFileKeys = [];

                                            for (const file of uploadedFiles) {
                                                                const ext = path.extname(file.originalFilename || '').toLowerCase();
                                                                let text = '';
                                                                if (ext === '.pdf') {
                                                                                      text = (await pdfParse(fs.readFileSync(file.path))).text;
                                                                } else if (ext === '.docx' || ext === '.doc') {
                                                                                      text = (await mammoth.extractRawText({ buffer: fs.readFileSync(file.path) })).value;
                                                                } else {
                                                                                      text = fs.readFileSync(file.path, 'utf8');
                                                                }

                                                              // Upload to Supabase Storage
                                                              const fileKey = `${sessionId}/${file.originalFilename}`;
                                                                const fileBuffer = fs.readFileSync(file.path);
                                                                const mimeType = ext === '.pdf' ? 'application/pdf'
                                                                                      : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                                                                      : 'application/octet-stream';

                                                              const { error: upErr } = await supabase.storage.from('documents').upload(fileKey, fileBuffer, { contentType: mimeType, upsert: true });
                                                                if (upErr) console.error('Supabase upload error:', upErr);
                                                                else storedFileKeys.push({ key: fileKey, name: file.originalFilename, ext });

                                                              try { fs.unlinkSync(file.path); } catch (_) {}

                                                              const docType = detectDocType(text, declaredType);
                                                                const ruleFindings = runRuleEngine(text, docType);
                                                                const aiResult = await classifyWithAI(text, declaredType);
                                                                const validated = crossReference(ruleFindings, aiResult);

                                                              processedFiles.push({
                                                                                    fileName: file.originalFilename,
                                                                                    docType: aiResult.docTypeConfidence === 'high' ? aiResult.docType : docType,
                                                                                    aiResult,
                                                                                    validated,
                                                                                    paragraphs: splitIntoParagraphs(text)
                                                              });
                                                                allFindings.push(...validated);
                                            }

                                            const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
                                                            allFindings.sort((a, b) => order[a.risk] - order[b.risk]);

                                            return resolve({
                                                                sessionId,
                                                                preview: true,
                                                                storedFileKeys,
                                                                summary: {
                                                                                      totalRisks: allFindings.length,
                                                                                      highRisks: allFindings.filter(f => f.risk === 'HIGH').length,
                                                                                      mediumRisks: allFindings.filter(f => f.risk === 'MEDIUM').length,
                                                                                      lowRisks: allFindings.filter(f => f.risk === 'LOW').length,
                                                                                      documentsAnalysed: processedFiles.length,
                                                                                      aiClassification: processedFiles.map(f => ({
                                                                                                              file: f.fileName,
                                                                                                              docType: f.docType,
                                                                                                              confidence: f.aiResult?.docTypeConfidence,
                                                                                                              riskLevel: f.aiResult?.estimatedRiskLevel,
                                                                                                              notes: f.aiResult?.notes
                                                                                              })),
                                                                },
                                                                previewFindings: allFindings.slice(0, 3).map(f => ({
                                                                                      risk: f.risk,
                                                                                      category: f.category,
                                                                                      message: f.message,
                                                                                      aiConfirmed: f.aiConfirmed
                                                                })),
                                                                hiddenCount: Math.max(0, allFindings.length - 3),
                                            });
                                          } catch (e) {
                                                            reject(e);
                                          }
                          });
            });

            if (result.error) return res.status(400).json({ error: result.error });
              return res.status(200).json(result);
  } catch (error) {
              console.error('Document processing error:', error);
              return res.status(500).json({ error: 'Processing failed: ' + error.message });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
