'use strict';

// AI-grounded news refresh for the public landing News section.
//
// Calls the Anthropic Messages API with the server-side web_search tool
// so the model bases its summaries on real-time sources instead of its
// training data. Returns at most `desiredCount` bilingual items.
//
// Output contract (each item):
//   { title_en, title_es, summary_en, summary_es, body_en, body_es,
//     source_url, source_name, published_at, topic }
//
// On any failure (missing key, network, parse) returns { error, message };
// callers persist nothing in that case so the existing news survives.

const { v4: uuidv4 } = require('uuid');

// Haiku 4.5 is fast enough to finish a 3–4 search refresh in ~20 s vs.
// 60–90 s for Sonnet, while still producing solid bilingual summaries
// grounded in real sources. Bump to Sonnet if quality regresses.
const MODEL = 'claude-haiku-4-5-20251001';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
// Hard cap on the Anthropic round-trip so the owner's Refresh button
// can't hang forever. Render's proxy will eventually kill the request
// anyway; failing fast lets the UI surface a clear error.
const FETCH_TIMEOUT_MS = 90_000;

async function fetchAiNews({ topics, desiredCount = 5, apiKey, locale = 'en' }) {
  if (!apiKey) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY is not configured.' };
  const cleanTopics = (Array.isArray(topics) ? topics : [])
    .map(t => String(t || '').trim()).filter(Boolean);
  if (cleanTopics.length === 0) {
    return { error: 'no_topics', message: 'No topics configured.' };
  }
  const count = Math.max(1, Math.min(20, Number(desiredCount) || 5));

  const prompt = `You are curating a tax-practice news feed. Find the ${count} most important and recent news items relevant to a U.S. tax-services firm whose clientele is in Connecticut. Cover these topics — distribute coverage roughly evenly:

${cleanTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

For each item:
- Use the web_search tool to ground each item in a real, current source (IRS.gov, ct.gov, Tax Foundation, JournalOfAccountancy.com, Treasury.gov, etc.). Prefer items from the last 60 days.
- Write a short headline (≤90 chars) and a 2–3 sentence summary that's accurate, practical, and oriented to small-business owners and individual filers.
- Provide both English and Spanish for the title, summary, and a longer body (4–6 sentences).
- Tag each item with the matching topic from the list above (exact string).
- Include the source URL and a short source_name (e.g., "IRS.gov" or "CT DRS").
- Include the publication date in ISO 8601 (YYYY-MM-DD).

Return STRICTLY a JSON array of ${count} objects with this shape (no prose, no markdown fences):
[
  {
    "title_en": "...",
    "title_es": "...",
    "summary_en": "...",
    "summary_es": "...",
    "body_en": "...",
    "body_es": "...",
    "topic": "exact matching topic string",
    "source_url": "https://...",
    "source_name": "IRS.gov",
    "published_at": "2026-05-14"
  },
  ...
]`;

  let resp;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
        // 2 searches keep input-token usage well under the free-tier
        // 30K/min cap (each search result counts as input on the next
        // turn). Most items can be grounded from a single broad search
        // per topic. Owners can re-run if they want different sources.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return {
      error: aborted ? 'timeout' : 'fetch_failed',
      message: aborted
        ? `Anthropic call exceeded ${Math.round(FETCH_TIMEOUT_MS / 1000)}s and was aborted. Try again with fewer topics, or set a smaller display limit.`
        : `Anthropic fetch failed: ${e?.message || e}`,
    };
  } finally { clearTimeout(timer); }
  let payload;
  try { payload = await resp.json(); }
  catch (e) { return { error: 'parse_failed', message: `Non-JSON response from Anthropic: ${e?.message}` }; }
  if (!resp.ok || payload.type === 'error') {
    const kind = payload?.error?.type || '';
    // Friendly framing for the two errors owners hit most often.
    if (kind === 'rate_limit_error') {
      return { error: 'rate_limited',
        message: 'Anthropic rate limit reached. Wait ~1 minute and try Refresh again, or upgrade your tier at console.anthropic.com/settings/billing. Existing articles on the public site are unchanged.' };
    }
    if (kind === 'authentication_error' || kind === 'permission_error') {
      return { error: 'auth_failed',
        message: 'Anthropic rejected the API key (authentication_error). Check ANTHROPIC_API_KEY on Render and confirm the key is active in console.anthropic.com.' };
    }
    return { error: 'api_error',
      message: `Anthropic API: ${kind || resp.status} — ${payload?.error?.message || ''}` };
  }
  // Find the final text block (after any tool_use blocks).
  const textBlocks = Array.isArray(payload.content)
    ? payload.content.filter(b => b.type === 'text').map(b => b.text || '').filter(Boolean)
    : [];
  const raw = textBlocks.join('\n').trim();
  if (!raw) return { error: 'no_text', message: 'Anthropic returned no text content.' };
  let items;
  try {
    // The model is asked for strict JSON but tolerate stray fencing.
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('no JSON array in response');
    items = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    return { error: 'parse_failed',
      message: `Could not parse JSON from model output: ${e?.message || e}`,
      raw: raw.slice(0, 500) };
  }
  if (!Array.isArray(items)) {
    return { error: 'shape_invalid', message: 'Model output was not a JSON array.' };
  }
  // Normalize and clamp.
  const normalized = items.slice(0, count).map(o => ({
    title_en:    String(o?.title_en    || '').slice(0, 200),
    title_es:    String(o?.title_es    || '').slice(0, 200),
    summary_en:  String(o?.summary_en  || '').slice(0, 1000),
    summary_es:  String(o?.summary_es  || '').slice(0, 1000),
    body_en:     String(o?.body_en     || '').slice(0, 4000),
    body_es:     String(o?.body_es     || '').slice(0, 4000),
    topic:       String(o?.topic       || '').slice(0, 200),
    source_url:  String(o?.source_url  || '').slice(0, 500),
    source_name: String(o?.source_name || '').slice(0, 200),
    published_at: parseIsoDateLoose(o?.published_at),
  })).filter(o => o.title_en && o.summary_en);
  if (normalized.length === 0) {
    return { error: 'empty_result', message: 'Model returned no usable items.' };
  }
  return { ok: true, items: normalized };
}

// Accept either "2026-05-14" or full ISO; fall back to now() if unparseable.
function parseIsoDateLoose(value) {
  if (!value) return null;
  const s = String(value).trim();
  // Bare date: pad with T00:00:00Z so JS parses consistently.
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(bare);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// Build a tax_news_articles row from a normalized item.
function rowFromItem({ communityId, item }) {
  return {
    id: 'tn_' + uuidv4().slice(0, 12),
    community_id: communityId,
    source: 'ai',
    topic: item.topic || '',
    topics: item.topic ? [item.topic] : [],
    title_i18n: { en: item.title_en, es: item.title_es || item.title_en },
    summary_i18n: { en: item.summary_en, es: item.summary_es || item.summary_en },
    body_i18n: { en: item.body_en || '', es: item.body_es || item.body_en || '' },
    source_url: item.source_url || '',
    source_name: item.source_name || '',
    published_at: item.published_at || new Date().toISOString(),
    video_url: '',
    video_storage_path: '',
    active: true,
    display_order: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

module.exports = { fetchAiNews, rowFromItem };
