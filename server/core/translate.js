'use strict';

// Translate a short string between 'en' and 'es' using the Anthropic API.
// Returns the translated string, or the original text if translation fails
// (missing key, network error, etc.) so callers never hard-fail on this.

const LANG_NAMES = { en: 'English', es: 'Spanish' };

async function translateText(text, fromLang, toLang) {
  if (!text || !text.trim()) return text;
  if (fromLang === toLang) return text;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return text; // no key configured — graceful no-op

  const from = LANG_NAMES[fromLang] || fromLang;
  const to   = LANG_NAMES[toLang]   || toLang;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Translate the following task title from ${from} to ${to}. Reply with ONLY the translated text, no explanation, no quotes.\n\n${text}`,
        }],
      }),
    });
    if (!resp.ok) return text;
    const data = await resp.json();
    const out = data?.content?.[0]?.text?.trim();
    return out || text;
  } catch (_) {
    return text; // network error — fall back silently
  }
}

module.exports = { translateText };
