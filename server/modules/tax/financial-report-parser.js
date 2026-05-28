'use strict';

// Phase 4n.72: bookkeeping PDF parser.
//
// Heuristic extraction of P&L + Balance Sheet line items from
// QuickBooks-style PDF exports. The parser walks line-by-line,
// matching known label patterns against the amount at the end of
// the line, and maps each hit to one of the structured field keys
// the bookkeeping form already uses. Owner reviews + corrects
// everything before publish, so a partial-match is fine — anything
// the parser misses just stays blank and the owner types it.
//
// Number format: handles both US ($1,234.56) and Spanish/European
// (1.234,56 — what the Sabor Latino QB output uses) by sniffing
// which separator is the last one in the string.

// Require the implementation file directly to bypass pdf-parse's
// index.js, which has a debug-mode branch that tries to read a test
// fixture from disk at require time when module.parent is null.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// Convert "173.568,15" → 173568.15 or "173,568.15" → 173568.15.
// Negative numbers may use a leading "-" or trailing parentheses;
// we accept both.
function parseAmount(s) {
  if (!s) return null;
  let str = String(s).trim();
  let negative = false;
  if (/^\(.*\)$/.test(str)) { negative = true; str = str.slice(1, -1); }
  if (str.startsWith('-')) { negative = true; str = str.slice(1); }
  str = str.replace(/[^0-9.,]/g, '');
  if (!str) return null;
  // The last separator (whichever it is) is the decimal point.
  // Everything before it is thousands separators.
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = str;
  } else if (lastComma > lastDot) {
    // comma is decimal
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else {
    // dot is decimal
    normalized = str.replace(/,/g, '');
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Find a numeric amount at the end of a line.
const AMOUNT_RE = /([\-(]?[\d.,]+\)?)\s*$/;

function amountAtEnd(line) {
  const m = AMOUNT_RE.exec(line);
  if (!m) return null;
  return parseAmount(m[1]);
}

// Label patterns. First match wins per line. Specific patterns must
// come before more-general ones.
const PL_PATTERNS = [
  // Revenue channels — match specific named lines.
  { label: /^Sales\s*Doordash\b/i,                                  target: 'pl.revenue.doordash' },
  { label: /^Sales\s*Uber\b/i,                                       target: 'pl.revenue.uber' },
  { label: /^Sales\s*Grubhub\b/i,                                    target: 'pl.revenue.grubhub' },
  { label: /^Sales\s*Menufy\b/i,                                     target: 'pl.revenue.menufy' },
  { label: /^Sales\s*Cash\b/i,                                       target: 'pl.revenue.cash' },
  // Bank deposits — multiple common patterns sum into one bucket.
  { label: /^Merch\s*Bnkcd\s*Deposit\b/i,                            target: 'pl.revenue.bank_deposits', add: true },
  { label: /^Deposit\s+\d/i,                                         target: 'pl.revenue.bank_deposits', add: true },
  { label: /^Payoneer\b/i,                                           target: 'pl.revenue.bank_deposits', add: true },
  { label: /^Other\s*Payments\b/i,                                   target: 'pl.revenue.other', add: true },

  // Sales tax (separate from revenue).
  { label: /^Total\s*Sales\s*Tax\s*Collected\b/i,                    target: 'pl.sales_tax_collected' },
  { label: /^Sale\s*Tax\s*Remitted\b/i,                              target: 'pl.sales_tax_remitted' },

  // COGS.
  { label: /^Total\s*COGS\b/i,                                       target: 'pl.cogs' },

  // Expense totals — match "Total X" lines so we don't double-count
  // the line items underneath.
  { label: /^Total\s*Advertising(\s*and\s*Promotion)?\b/i,           target: 'pl.expenses.advertising' },
  { label: /^Total\s*Auto\b/i,                                       target: 'pl.expenses.auto' },
  { label: /^Total\s*Bank\s*Service\s*Charges\b/i,                   target: 'pl.expenses.other', add: true },
  { label: /^Total\s*Business\s*Licenses(\s*and\s*Permits)?\b/i,     target: 'pl.expenses.other', add: true },
  { label: /^Total\s*Computer\s*and\s*Software\b/i,                  target: 'pl.expenses.other', add: true },
  { label: /^Depreciation\s*Expense\b/i,                             target: 'pl.expenses.depreciation' },
  { label: /^Total\s*Insurance\s*Expense\b/i,                        target: 'pl.expenses.insurance' },
  { label: /^Total\s*Interest\s*Expense\b/i,                         target: 'pl.expenses.interest' },
  { label: /^Total\s*Merchant\s*Services\b/i,                        target: 'pl.expenses.merchant_services' },
  { label: /^Total\s*Office\s*Expense\b/i,                           target: 'pl.expenses.office' },
  { label: /^Total\s*Office\s*Supplies\b/i,                          target: 'pl.expenses.office_supplies' },
  { label: /^Total\s*Payroll\s*Expenses\b/i,                         target: 'pl.expenses.payroll' },
  { label: /^Total\s*Professional\s*Fees\b/i,                        target: 'pl.expenses.professional_fees' },
  { label: /^Total\s*Rent\s*Expense\b/i,                             target: 'pl.expenses.rent' },
  { label: /^Total\s*Repairs(\s*and\s*Maintenance)?\b/i,             target: 'pl.expenses.repairs' },
  { label: /^Total\s*Tax\s*Paid\b/i,                                 target: 'pl.expenses.other', add: true },
  { label: /^Total\s*Utilities\b/i,                                  target: 'pl.expenses.utilities' },
];

const BALANCE_PATTERNS = [
  { label: /^Total\s*Checking\/?Savings\b/i,                         target: 'balance.cash' },
  { label: /^Food\s*Inventory\b/i,                                   target: 'balance.inventory' },
  { label: /^Total\s*Other\s*Current\s*Assets\b/i,                   target: 'balance.other_current_assets' },
  { label: /^Accumulated\s*Depreciation\b/i,                         target: 'balance.accumulated_depreciation' },
  { label: /^Total\s*Fixed\s*Assets\b/i,                             target: 'balance.fixed_assets_gross' },
  { label: /^Total\s*Other\s*Assets\b/i,                             target: 'balance.other_assets' },
  { label: /^Total\s*Current\s*Liabilities\b/i,                      target: 'balance.current_liabilities' },
  { label: /^Total\s*Long\s*Term\s*Liabilities\b/i,                  target: 'balance.long_term_liabilities' },
  { label: /^Retained\s*Earnings\b/i,                                target: 'balance.retained_earnings' },
  { label: /^Total\s*Shareholder\s*Distributions\b/i,                target: 'balance.distributions' },
];

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

// Returns { pl, balance, debug }.
async function parsePdf(buffer, kind /* 'pl' | 'balance' */) {
  const out = { pl: { revenue: {}, expenses: {} }, balance: {}, debug: { matched: 0, unmatched: 0, lines: 0 } };
  if (!buffer || !buffer.length) return out;
  let text;
  try {
    const parsed = await pdfParse(buffer);
    text = parsed?.text || '';
  } catch (e) {
    out.debug.error = String(e?.message || e);
    return out;
  }
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  out.debug.lines = lines.length;
  const patterns = kind === 'balance' ? BALANCE_PATTERNS : PL_PATTERNS;
  for (const line of lines) {
    const amount = amountAtEnd(line);
    if (amount === null) continue;
    let hit = null;
    for (const p of patterns) {
      if (p.label.test(line)) { hit = p; break; }
    }
    if (!hit) { out.debug.unmatched++; continue; }
    setPath(out, hit.target, amount, !!hit.add);
    out.debug.matched++;
  }
  return out;
}

module.exports = { parsePdf, parseAmount };
