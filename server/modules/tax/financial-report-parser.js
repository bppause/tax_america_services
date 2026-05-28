'use strict';

// Phase 4n.74: bookkeeping PDF parser — dynamic section walker.
//
// Earlier iterations mapped specific QuickBooks labels to a fixed set
// of revenue / expense fields. That collapsed when different
// customers have different vendor names, channel names, and category
// labels. This version walks the standard QB P&L skeleton instead:
//
//   Income → [groups → items] → Total Income
//   Cost of Goods Sold → [groups → items] → Total COGS
//   Gross Profit
//   Expense → [groups → items] → Total Expense
//   Net Ordinary Income
//   Other Income / Other Expense → [groups → items] → Net Other Income
//   Net Income
//
// Section names and the canonical totals are universal across QB
// exports. Everything inside is captured as the customer set it up:
// sub-groups roll up to a single rollup item in their parent group;
// rollups validate against the recorded subtotal; the report carries
// its own group/item structure so the dashboard can render whatever
// the customer actually has rather than guessing at a fixed schema.

const pdfParse = require('pdf-parse/lib/pdf-parse.js');

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
  if (lastComma === -1 && lastDot === -1) normalized = str;
  else if (lastComma > lastDot) normalized = str.replace(/\./g, '').replace(',', '.');
  else normalized = str.replace(/,/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const AMOUNT_AT_END = /^(.*?)\s+([\-(]?\$?[\d.,]+\)?)\s*$/;

// Matchers for the canonical structural anchors. The "Total <X>"
// forms are matched separately from section headers because they
// always carry amounts.
const RE = {
  topIncome:        /^(Ordinary\s+Income\/Expense|Income)$/i,
  topCogs:          /^(Cost\s+of\s+Goods\s+Sold|COGS)$/i,
  topExpense:       /^Expense$/i,
  topOtherWrapper:  /^Other\s+Income\/Expense$/i,
  topOtherIncome:   /^Other\s+Income$/i,
  topOtherExpense:  /^Other\s+Expense$/i,

  totalIncome:           /^Total\s+Income$/i,
  totalCogs:             /^Total\s+(COGS|Cost\s+of\s+Goods\s+Sold)$/i,
  totalExpense:          /^Total\s+Expense$/i,
  totalOtherIncome:      /^Total\s+Other\s+Income$/i,
  totalOtherExpense:     /^Total\s+Other\s+Expense$/i,
  grossProfit:           /^Gross\s+Profit$/i,
  netOrdinaryIncome:     /^Net\s+Ordinary\s+Income$/i,
  netOtherIncome:        /^Net\s+Other\s+Income$/i,
  netIncome:             /^Net\s+Income$/i,

  // Page chrome that should never count as a section / item.
  pageHeader: /^(\d{1,2}:\d{2}\s*[AP]M|\d{1,2}\/\d{1,2}\/\d{2,4}|Accrual\s+Basis|Cash\s+Basis|Page\s+\d+|Profit\s*&?\s*Loss)$/i,
};

function newSection() { return { groups: [], total: null }; }

// Walks the spatial render output and emits the structured P&L.
// State machine carries `section`, `group`, and `subgroup` so 3-level
// nesting (e.g., Expense → Payroll Expenses → Payroll Taxes → items)
// gets flattened cleanly: the subgroup's items collapse into a single
// rollup item on the parent group.
function parseDynamic(text) {
  const out = {
    sections: {
      income: newSection(),
      cogs: newSection(),
      expenses: newSection(),
      other_income: newSection(),
      other_expense: newSection(),
    },
    totals: {},
    debug: { matched: 0, lines: 0, warnings: [] },
  };

  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  out.debug.lines = lines.length;

  let section = null;       // 'income' | 'cogs' | 'expenses' | 'other_income' | 'other_expense'
  let group = null;         // { name, total, items: [] }
  let subgroup = null;      // { name, items: [] }

  const flushSubgroup = () => {
    if (subgroup && group && subgroup.items.length) {
      const sum = subgroup.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      group.items.push({ name: subgroup.name, amount: sum, rollup: true });
    }
    subgroup = null;
  };
  const flushGroup = () => {
    flushSubgroup();
    if (group && section) {
      if (group.items.length === 0 && group.total == null) {
        // empty section header with no children — drop
      } else {
        // If the group closed without an explicit "Total <name>"
        // line (orphan items under a section, or QB exports that
        // skip the subtotal line for single-item groups), derive
        // its total from the items so rollups balance against the
        // section total.
        if (group.total == null && group.items.length) {
          group.total = group.items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        }
        out.sections[section].groups.push(group);
        out.debug.matched++;
      }
    }
    group = null;
  };
  const closeSection = () => {
    flushGroup();
    section = null;
  };

  for (const line of lines) {
    if (RE.pageHeader.test(line)) continue;
    // Per-page company-name header line: skip anything that's the
    // company name (looks like words with no amount and no leading
    // structural keyword). Cheap heuristic: skip lines that match
    // page chrome from above; everything else is in scope.

    const m = AMOUNT_AT_END.exec(line);
    const hasAmount = !!m;
    const label = (hasAmount ? m[1] : line).trim();
    const amount = hasAmount ? parseAmount(m[2]) : null;

    // ── Top-level totals + computed lines ─────────────────────────
    if (hasAmount && RE.totalIncome.test(label)) {
      flushGroup();
      out.sections.income.total = amount;
      out.totals.total_income = amount;
      section = null;
      continue;
    }
    if (hasAmount && RE.totalCogs.test(label)) {
      flushGroup();
      out.sections.cogs.total = amount;
      out.totals.total_cogs = amount;
      section = null;
      continue;
    }
    if (hasAmount && RE.totalExpense.test(label)) {
      flushGroup();
      out.sections.expenses.total = amount;
      out.totals.total_expense = amount;
      section = null;
      continue;
    }
    if (hasAmount && RE.totalOtherExpense.test(label)) {
      flushGroup();
      out.sections.other_expense.total = amount;
      section = null;
      continue;
    }
    if (hasAmount && RE.totalOtherIncome.test(label)) {
      // Ambiguous: this can be the wrap-up of a top-level Other Income
      // section OR a sub-group total ("Other Income" group within
      // Income). Disambiguate by current state.
      if (section === 'other_income') {
        flushGroup();
        out.sections.other_income.total = amount;
        section = null;
      } else if (group && /^other\s+income$/i.test(group.name)) {
        group.total = amount;
        flushGroup();
      } else {
        // Stash as a generic item if we can't place it.
        if (group) group.items.push({ name: 'Other Income', amount });
      }
      continue;
    }
    if (hasAmount && RE.grossProfit.test(label))         { out.totals.gross_profit = amount; closeSection(); continue; }
    if (hasAmount && RE.netOrdinaryIncome.test(label))   { out.totals.net_ordinary_income = amount; closeSection(); continue; }
    if (hasAmount && RE.netOtherIncome.test(label))      { out.totals.net_other_income = amount; continue; }
    if (hasAmount && RE.netIncome.test(label))           { out.totals.net_income = amount; closeSection(); continue; }

    // ── Section / group headers (no amount) ───────────────────────
    if (!hasAmount) {
      // Unambiguous top-level headers — fire regardless of current
      // state. "Income" appears only once at the top of the report;
      // same for "Cost of Goods Sold" / "Expense". The wrapper
      // "Ordinary Income/Expense" is silent (section stays where it
      // was, but the income mode is implied by the "Income" header
      // that follows).
      if (RE.topIncome.test(label))   { flushGroup(); section = 'income'; continue; }
      if (RE.topCogs.test(label))     { flushGroup(); section = 'cogs'; continue; }
      if (RE.topExpense.test(label))  { flushGroup(); section = 'expenses'; continue; }
      if (RE.topOtherWrapper.test(label)) { continue; }
      // "Other Income" / "Other Expense" are ambiguous: both appear
      // as group names *inside* the Income section in some QB
      // exports, AND as the top-level sections in the
      // Other Income/Expense block at the bottom. Disambiguate by
      // current state: only treat as top-level when we're between
      // sections (which happens after Net Ordinary Income).
      if (section === null) {
        if (RE.topOtherIncome.test(label))  { flushGroup(); section = 'other_income'; continue; }
        if (RE.topOtherExpense.test(label)) { flushGroup(); section = 'other_expense'; continue; }
        continue; // unknown header outside any section — skip
      }
      // Inside a section: header is a group or subgroup.
      if (!group) {
        group = { name: label, total: null, items: [] };
      } else {
        flushSubgroup();
        subgroup = { name: label, items: [] };
      }
      continue;
    }

    // ── "Total X" lines — close the matching group or subgroup ────
    if (/^Total\s+/i.test(label)) {
      const tName = label.replace(/^Total\s+/i, '').trim().toLowerCase();
      if (subgroup && tName === subgroup.name.toLowerCase()) {
        // Subgroup total — replace accumulated subgroup items with a
        // single rollup item on the parent group.
        group.items.push({ name: subgroup.name, amount, rollup: true });
        subgroup = null;
        continue;
      }
      if (group && tName === group.name.toLowerCase()) {
        group.total = amount;
        flushGroup();
        continue;
      }
      // Unrecognized "Total X" — record as an item so nothing is lost.
      if (group) group.items.push({ name: label.replace(/^Total\s+/i, '').trim(), amount });
      continue;
    }

    // ── Line item ─────────────────────────────────────────────────
    if (subgroup)      subgroup.items.push({ name: label, amount });
    else if (group)    group.items.push({ name: label, amount });
    else if (section) {
      // Orphan item under a section with no current group — synthesize one.
      group = { name: '(uncategorized)', total: null, items: [{ name: label, amount }] };
    }
  }

  // Final flush at EOF.
  flushGroup();

  // Derive any missing canonical totals from what we did capture.
  const sumGroups = (sec) => (sec.groups || []).reduce((s, g) => s + (Number(g.total) || 0), 0);
  if (out.sections.income.total == null && out.sections.income.groups.length) {
    out.sections.income.total = sumGroups(out.sections.income);
  }
  if (out.totals.total_income == null && out.sections.income.total != null) {
    out.totals.total_income = out.sections.income.total;
  }
  if (out.totals.total_cogs == null && out.sections.cogs.total != null) {
    out.totals.total_cogs = out.sections.cogs.total;
  }
  if (out.totals.gross_profit == null && out.totals.total_income != null && out.totals.total_cogs != null) {
    out.totals.gross_profit = out.totals.total_income - out.totals.total_cogs;
  }
  if (out.totals.total_expense == null && out.sections.expenses.total != null) {
    out.totals.total_expense = out.sections.expenses.total;
  }
  if (out.totals.net_ordinary_income == null && out.totals.gross_profit != null && out.totals.total_expense != null) {
    out.totals.net_ordinary_income = out.totals.gross_profit - out.totals.total_expense;
  }
  if (out.totals.net_other_income == null) {
    const oi = Number(out.sections.other_income.total) || 0;
    const oe = Number(out.sections.other_expense.total) || 0;
    if (out.sections.other_income.total != null || out.sections.other_expense.total != null) {
      out.totals.net_other_income = oi - oe;
    }
  }
  if (out.totals.net_income == null && out.totals.net_ordinary_income != null) {
    out.totals.net_income = out.totals.net_ordinary_income + (Number(out.totals.net_other_income) || 0);
  }

  // Sanity check: each section's group totals should sum to the
  // recorded section total within $1. Surface a warning when they
  // don't — owner sees it on save so they know a number didn't parse.
  for (const [key, sec] of Object.entries(out.sections)) {
    if (sec.total == null) continue;
    const sum = sumGroups(sec);
    if (Math.abs(sum - sec.total) > 1) {
      out.debug.warnings.push(`Section ${key} total ${sec.total} doesn't match sum of groups ${sum.toFixed(2)}`);
    }
  }

  return out;
}

// Document type markers (unchanged behavior).
const PL_MARKERS = /Profit\s*&\s*Loss|Net\s+(?:Ordinary\s+)?Income|Total\s+Income|Gross\s+Profit|Cost\s+of\s+Goods\s+Sold/i;
const BALANCE_MARKERS = /Balance\s+Sheet|TOTAL\s+(?:ASSETS|LIABILITIES)|Retained\s+Earnings|Accumulated\s+Depreciation/i;

// Balance sheet patterns — kept as label-based mapping since the
// balance sheet has a much smaller, more stable set of canonical
// lines than the P&L expense catalog. (Dynamic walking for balance
// is a follow-up if it becomes a real need.)
const BALANCE_PATTERNS = [
  { label: /Total\s*Checking\/?Savings/i,                          target: 'cash' },
  { label: /Food\s*Inventory/i,                                    target: 'inventory' },
  { label: /Total\s*Other\s*Current\s*Assets/i,                    target: 'other_current_assets' },
  { label: /Accumulated\s*Depreciation/i,                          target: 'accumulated_depreciation' },
  { label: /Total\s*Fixed\s*Assets/i,                              target: 'fixed_assets_gross' },
  { label: /Total\s*Other\s*Assets/i,                              target: 'other_assets' },
  { label: /Total\s*Current\s*Liabilities/i,                       target: 'current_liabilities' },
  { label: /Total\s*Long\s*Term\s*Liabilities/i,                   target: 'long_term_liabilities' },
  { label: /Retained\s*Earnings/i,                                 target: 'retained_earnings' },
  { label: /Total\s*Shareholder\s*Distributions/i,                 target: 'distributions' },
];

function parseBalance(text) {
  const out = {};
  let matched = 0;
  for (const p of BALANCE_PATTERNS) {
    const re = new RegExp(p.label.source + `[^\\d\\-(]{0,80}?([\\-(]?\\$?[\\d.,]+\\)?)(?=[^\\d.,]|$)`, 'gi');
    const m = re.exec(text);
    if (m) {
      const amount = parseAmount(m[1]);
      if (amount !== null) { out[p.target] = amount; matched++; }
    }
  }
  return { fields: out, matched };
}

async function parsePdf(buffer, kind /* 'pl' | 'balance' */) {
  const out = {
    pl: null,
    balance: null,
    debug: { matched: 0, characters: 0, detectedType: null, typeMismatch: false, warnings: [] },
  };
  if (!buffer || !buffer.length) {
    out.debug.error = 'empty_buffer';
    return out;
  }
  let text;
  try {
    const parsed = await pdfParse(buffer, PDF_PARSE_OPTIONS);
    text = (parsed?.text || '').replace(/ /g, ' ');
  } catch (e) {
    out.debug.error = String(e?.message || e);
    return out;
  }
  out.debug.characters = text.length;
  if (!text.trim()) {
    out.debug.error = 'pdf_no_text_layer';
    return out;
  }
  const hasPl = PL_MARKERS.test(text);
  const hasBalance = BALANCE_MARKERS.test(text);
  out.debug.detectedType =
    hasPl && !hasBalance ? 'pl'
    : hasBalance && !hasPl ? 'balance'
    : hasPl && hasBalance ? 'mixed'
    : 'unknown';
  if (kind === 'pl' && out.debug.detectedType === 'balance') {
    out.debug.typeMismatch = true; return out;
  }
  if (kind === 'balance' && out.debug.detectedType === 'pl') {
    out.debug.typeMismatch = true; return out;
  }

  if (kind === 'balance') {
    const r = parseBalance(text);
    out.balance = r.fields;
    out.debug.matched = r.matched;
  } else {
    out.pl = parseDynamic(text);
    // Roll the section walker's match + warning data up to top-level
    // debug so the server log + client banner can read it without
    // peeking into pl.debug.
    out.debug.matched = out.pl.debug.matched;
    out.debug.warnings = out.pl.debug.warnings || [];
  }

  if (out.debug.matched === 0) {
    out.debug.textSample = text.slice(0, 1200);
    out.debug.markersFound = { hasPl, hasBalance };
  }
  return out;
}

module.exports = { parsePdf, parseAmount, parseDynamic };
