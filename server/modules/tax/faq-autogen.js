'use strict';

// LLM-generated FAQs for newly added services.
//
// Service create/delete in routes.js fires this asynchronously so the
// owner's "Create service" button doesn't block on an LLM round-trip.
// Output: 4 bilingual EN/ES Q&A pairs grounded in the service's own
// name + description + long description.
//
// Why not web_search? The questions we want are evergreen ("What is
// X?" / "When is the deadline?" / "What documents do I need?") and the
// answers should reflect the practice's framing of the service —
// pulling random websites would dilute that. Pure LLM generation is
// fast, cheap, and predictable here.

const MODEL = 'claude-sonnet-4-6';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

async function generateFaqsForService({ service, apiKey, count = 4 }) {
  if (!apiKey) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY is not configured.' };
  const nameEn = pickLocale(service?.name_i18n, 'en');
  const nameEs = pickLocale(service?.name_i18n, 'es');
  if (!nameEn && !nameEs) {
    return { error: 'no_service_name', message: 'Service has no name to base FAQs on.' };
  }
  const descEn = pickLocale(service?.description_i18n, 'en');
  const descEs = pickLocale(service?.description_i18n, 'es');
  const longEn = pickLocale(service?.long_description_i18n, 'en');
  const longEs = pickLocale(service?.long_description_i18n, 'es');
  const wanted = Math.max(2, Math.min(8, Number(count) || 4));

  const prompt = `A U.S. tax practice in Connecticut just added a new service. Write ${wanted} customer-facing FAQs for the service's public landing page. The audience is small-business owners and individual filers.

Service name (EN): ${nameEn || '(none)'}
Service name (ES): ${nameEs || '(none)'}
Short description (EN): ${descEn || '(none)'}
Short description (ES): ${descEs || '(none)'}
Long description (EN): ${longEn || '(none)'}
Long description (ES): ${longEs || '(none)'}

Cover the questions a real customer would actually ask before buying — what it is, when it's needed, what documents/info are required, typical timing, common pitfalls, deductibility. Avoid generic "contact us" non-answers.

Each FAQ must include English and Spanish. Keep questions ≤120 chars; answers 2–4 sentences each.

Return STRICTLY a JSON array of ${wanted} objects with this shape (no prose, no markdown fences):
[
  { "question_en": "...", "question_es": "...", "answer_en": "...", "answer_es": "..." },
  ...
]`;

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) { return { error: 'fetch_failed', message: e?.message || String(e) }; }

  let payload;
  try { payload = await resp.json(); }
  catch (e) { return { error: 'parse_failed', message: e?.message }; }
  if (!resp.ok || payload.type === 'error') {
    return { error: 'api_error',
      message: `Anthropic API: ${payload?.error?.type || resp.status} — ${payload?.error?.message || ''}` };
  }
  const textBlocks = Array.isArray(payload.content)
    ? payload.content.filter(b => b.type === 'text').map(b => b.text || '').filter(Boolean)
    : [];
  const raw = textBlocks.join('\n').trim();
  let items;
  try {
    const s = raw.indexOf('[');
    const e = raw.lastIndexOf(']');
    if (s === -1 || e === -1) throw new Error('no JSON array in response');
    items = JSON.parse(raw.slice(s, e + 1));
  } catch (e) {
    return { error: 'parse_failed', message: e?.message, raw: raw.slice(0, 500) };
  }
  if (!Array.isArray(items)) {
    return { error: 'shape_invalid', message: 'Model output was not a JSON array.' };
  }
  const faqs = items.slice(0, wanted).map(o => ({
    question_en: String(o?.question_en || '').slice(0, 500),
    question_es: String(o?.question_es || o?.question_en || '').slice(0, 500),
    answer_en:   String(o?.answer_en   || '').slice(0, 4000),
    answer_es:   String(o?.answer_es   || o?.answer_en   || '').slice(0, 4000),
  })).filter(f => f.question_en && f.answer_en);
  if (faqs.length === 0) {
    return { error: 'empty_result', message: 'Model returned no usable FAQs.' };
  }
  return { ok: true, faqs };
}

function pickLocale(i18n, locale) {
  if (!i18n || typeof i18n !== 'object') return '';
  return String(i18n[locale] || i18n.en || i18n.es || '').trim();
}

// Map a tax_products.category to a tax_relationship_types.category.
// The two columns mean different things; this is a heuristic mapping
// for auto-created relationship types. Owners can edit the category
// later if they care.
function inferRelationshipCategory(service) {
  const slug = String(service?.slug || '').toLowerCase();
  const nameEn = String(service?.name_i18n?.en || '').toLowerCase();
  const hay = `${slug} ${nameEn}`;
  if (/\b(audit|representation|irs|drs)\b/.test(hay)) return 'audit';
  if (/\b(individual|personal|itin|1040)\b/.test(hay)) return 'individual';
  if (/\b(notary|translation|translate)\b/.test(hay))  return 'general';
  return 'business';
}

module.exports = { generateFaqsForService, inferRelationshipCategory };
