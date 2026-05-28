'use strict';

// Phase 4n.72: bookkeeping PDF parser.
//
// Heuristic extraction of P&L + Balance Sheet line items from
// QuickBooks-style PDF exports. PDF text extraction often breaks
// column-aligned tables across lines (label on one line, amount on
// the next), so the parser walks the full text and pairs each label
// pattern with the *next* amount that follows it, capped at a short
// character gap. Owner reviews + corrects every number before
// publishing, so partial matches are fine.
//
// Number format: handles both US ($1,234.56) and Spanish/European
// (1.234,56 — what the Sabor Latino QB output uses) by sniffing
// which separator is the last one in the string.

const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// Custom page renderer: group text items by Y-coordinate (rounded
// to integer), then sort by X within each Y-line, then join with
// single spaces. Default pdf-parse render simply concatenates items
// at the same Y with no separator and can interleave columns out of
// reading order — that's why QuickBooks exports like
// "Total COGS                141.757,05" came out as either
// "Total COGS141.757,05" (no space) or scrambled across the page.
// This renderer reconstructs an honest left-to-right, top-to-bottom
// view that matches what a human sees.
function spatialPageRender(pageData) {
  return pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  }).then(tc => {
    const lines = new Map();
    for (const item of tc.items || []) {
      if (!item || !item.str) continue;
      const transform = item.transform || [1, 0, 0, 1, 0, 0];
      const y = Math.round(transform[5] || 0);
      const x = transform[4] || 0;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x, str: item.str });
    }
    // PDF coordinate origin is the lower-left corner — sort Y values
    // descending so the top of the page comes first.
    const sortedYs = [...lines.keys()].sort((a, b) => b - a);
    const out = [];
    for (const y of sortedYs) {
      const items = lines.get(y).sort((a, b) => a.x - b.x);
      out.push(items.map(i => i.str).join(' '));
    }
    return out.join('\n');
  });
}

const PDF_PARSE_OPTIONS = { pagerender: spatialPageRender };

// Convert "173.568,15" → 173568.15 or "173,568.15" → 173568.15.
function parseAmount(s) {
  if (!s) return null;
  let str = String(s).trim();
  let negative = false;
  if (/^\(.*\)$/.test(str)) { negative = true; str = str.slice(1, -1); }
  if (str.startsWith('-')) { negative = true; str = str.slice(1); }
  str = str.replace(/[^0-9.,]/g, '');
  if (!str) return null;
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = str;
  } else if (lastComma > lastDot) {
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = str.replace(/,/g, '');
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Patterns: { label (regex source, no anchors), target, add?, multi? }.
// First match per pattern wins for non-`multi` entries; `multi` entries
// sum all occurrences (used for bank-deposit subtotals where QB exports
// several "Deposit XXXX" / "Merch Bnkcd Deposit XXXX" lines).
const PL_PATTERNS = [
  { label: 'Sales\\s*Doordash',                                   target: 'pl.revenue.doordash' },
  { label: 'Sales\\s*Uber',                                       target: 'pl.revenue.uber' },
  { label: 'Sales\\s*Grubhub',                                    target: 'pl.revenue.grubhub' },
  { label: 'Sales\\s*Menufy',                                     target: 'pl.revenue.menufy' },
  // "Sales Cash <name>" — let the 80-char gap step over the cashier
  // name; the previous bracket class also ate the leading digits of
  // the amount and clipped the value (21115 → 115).
  { label: 'Sales\\s*Cash\\b',                                    target: 'pl.revenue.cash' },
  { label: 'Merch\\s*Bnkcd\\s*Deposit\\s*\\d+(?:\\s*no\\s*Tax)?', target: 'pl.revenue.bank_deposits', add: true, multi: true },
  // Negative lookbehind so this doesn't also match inside the
  // "Merch Bnkcd Deposit" pattern above (which would double-count
  // those rows).
  { label: '(?<!Bnkcd\\s)\\bDeposit\\s+\\d{3,}',                  target: 'pl.revenue.bank_deposits', add: true, multi: true },
  { label: 'Payoneer',                                            target: 'pl.revenue.bank_deposits', add: true },
  { label: 'Other\\s*Payments',                                   target: 'pl.revenue.other', add: true },

  { label: 'Total\\s*Sales\\s*Tax\\s*Collected',                  target: 'pl.sales_tax_collected' },
  { label: 'Sale\\s*Tax\\s*Remitted',                             target: 'pl.sales_tax_remitted' },

  { label: 'Total\\s*COGS',                                       target: 'pl.cogs' },

  { label: 'Total\\s*Advertising(?:\\s*and\\s*Promotion)?',       target: 'pl.expenses.advertising' },
  { label: 'Total\\s*Auto',                                       target: 'pl.expenses.auto' },
  { label: 'Total\\s*Bank\\s*Service\\s*Charges',                 target: 'pl.expenses.other', add: true },
  { label: 'Total\\s*Business\\s*Licenses(?:\\s*and\\s*Permits)?', target: 'pl.expenses.other', add: true },
  { label: 'Total\\s*Computer\\s*and\\s*Software',                target: 'pl.expenses.other', add: true },
  { label: 'Depreciation\\s*Expense',                             target: 'pl.expenses.depreciation' },
  { label: 'Total\\s*Insurance\\s*Expense',                       target: 'pl.expenses.insurance' },
  { label: 'Total\\s*Interest\\s*Expense',                        target: 'pl.expenses.interest' },
  { label: 'Total\\s*Merchant\\s*Services',                       target: 'pl.expenses.merchant_services' },
  { label: 'Total\\s*Office\\s*Expense',                          target: 'pl.expenses.office' },
  { label: 'Total\\s*Office\\s*Supplies',                         target: 'pl.expenses.office_supplies' },
  { label: 'Total\\s*Payroll\\s*Expenses',                        target: 'pl.expenses.payroll' },
  { label: 'Total\\s*Professional\\s*Fees',                       target: 'pl.expenses.professional_fees' },
  { label: 'Total\\s*Rent\\s*Expense',                            target: 'pl.expenses.rent' },
  { label: 'Total\\s*Repairs(?:\\s*and\\s*Maintenance)?',         target: 'pl.expenses.repairs' },
  { label: 'Total\\s*Tax\\s*Paid',                                target: 'pl.expenses.other', add: true },
  { label: 'Total\\s*Utilities',                                  target: 'pl.expenses.utilities' },
];

const BALANCE_PATTERNS = [
  { label: 'Total\\s*Checking/?Savings',                          target: 'balance.cash' },
  { label: 'Food\\s*Inventory',                                   target: 'balance.inventory' },
  { label: 'Total\\s*Other\\s*Current\\s*Assets',                 target: 'balance.other_current_assets' },
  { label: 'Accumulated\\s*Depreciation',                         target: 'balance.accumulated_depreciation' },
  { label: 'Total\\s*Fixed\\s*Assets',                            target: 'balance.fixed_assets_gross' },
  { label: 'Total\\s*Other\\s*Assets',                            target: 'balance.other_assets' },
  { label: 'Total\\s*Current\\s*Liabilities',                     target: 'balance.current_liabilities' },
  { label: 'Total\\s*Long\\s*Term\\s*Liabilities',                target: 'balance.long_term_liabilities' },
  { label: 'Retained\\s*Earnings',                                target: 'balance.retained_earnings' },
  { label: 'Total\\s*Shareholder\\s*Distributions',               target: 'balance.distributions' },
];

// Markers that prove the document is a P&L vs. a Balance Sheet. We
// surface a typeMismatch flag when the wrong file is dropped into a
// slot so the owner gets a clear error instead of "Parsed 0 fields".
const PL_MARKERS = /Profit\s*&\s*Loss|Net\s+(?:Ordinary\s+)?Income|Total\s+Income|Gross\s+Profit|Cost\s+of\s+Goods\s+Sold/i;
const BALANCE_MARKERS = /Balance\s+Sheet|TOTAL\s+(?:ASSETS|LIABILITIES)|Retained\s+Earnings|Accumulated\s+Depreciation/i;

function setPath(obj, path, value, add = false) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (add) {
    cur[last] = (Number(cur[last]) || 0) + value;
  } else {
    cur[last] = value;
  }
}

// Find every (label, amount) pair where `amount` is the next number
// appearing within `maxGap` chars after the label match. Cap the gap
// to avoid pairing a label with an unrelated downstream number.
function findPairs(text, labelSource, flags, maxGap = 80) {
  const re = new RegExp(
    `(${labelSource})[^\\d\\-(]{0,${maxGap}}?([\\-(]?\\$?[\\d.,]+\\)?)(?=[^\\d.,]|$)`,
    flags,
  );
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const amount = parseAmount(m[2]);
    if (amount !== null) results.push({ amount, index: m.index });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return results;
}

// Returns { pl, balance, debug }. typeMismatch=true means the file
// looks like the other kind (e.g. balance sheet dropped into the P&L
// slot) so the client can show a "wrong file" error.
async function parsePdf(buffer, kind /* 'pl' | 'balance' */) {
  const out = {
    pl: { revenue: {}, expenses: {} },
    balance: {},
    debug: { matched: 0, characters: 0, detectedType: null, typeMismatch: false },
  };
  if (!buffer || !buffer.length) {
    out.debug.error = 'empty_buffer';
    return out;
  }
  let text;
  try {
    const parsed = await pdfParse(buffer, PDF_PARSE_OPTIONS);
    text = (parsed?.text || '').replace(/ /g, ' '); // normalize non-breaking spaces
  } catch (e) {
    out.debug.error = String(e?.message || e);
    return out;
  }
  out.debug.characters = text.length;
  if (!text.trim()) {
    out.debug.error = 'pdf_no_text_layer';
    return out;
  }
  // Type detection — first decide what the document actually is, then
  // compare against what slot the owner uploaded it into.
  const hasPl = PL_MARKERS.test(text);
  const hasBalance = BALANCE_MARKERS.test(text);
  out.debug.detectedType =
    hasPl && !hasBalance ? 'pl'
    : hasBalance && !hasPl ? 'balance'
    : hasPl && hasBalance ? 'mixed'
    : 'unknown';
  if (kind === 'pl' && out.debug.detectedType === 'balance') {
    out.debug.typeMismatch = true;
    return out;
  }
  if (kind === 'balance' && out.debug.detectedType === 'pl') {
    out.debug.typeMismatch = true;
    return out;
  }
  const patterns = kind === 'balance' ? BALANCE_PATTERNS : PL_PATTERNS;
  const unmatched = [];
  for (const p of patterns) {
    const flags = 'gi';
    const pairs = findPairs(text, p.label, flags);
    if (!pairs.length) { unmatched.push(p.target); continue; }
    if (p.multi) {
      for (const pair of pairs) {
        setPath(out, p.target, pair.amount, !!p.add);
      }
      out.debug.matched += pairs.length;
    } else {
      // Pick the first occurrence — totals tend to appear once.
      setPath(out, p.target, pairs[0].amount, !!p.add);
      out.debug.matched++;
    }
  }
  // When everything misses, return a small text sample + the list of
  // unmatched targets + which PL/Balance markers actually fired so the
  // server-side log (and the parse-response payload) carries enough
  // signal to fix the regexes without another deploy cycle.
  if (out.debug.matched === 0) {
    out.debug.textSample = text.slice(0, 1200);
    out.debug.unmatchedTargets = unmatched.slice(0, 30);
    out.debug.markersFound = { hasPl, hasBalance };
  }
  return out;
}

module.exports = { parsePdf, parseAmount };
