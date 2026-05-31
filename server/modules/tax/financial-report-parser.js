'use strict';

const { log, warn } = require('../../../logger');

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

// Lazy-loaded so a missing pdf-parse install doesn't crash the server
// when only xlsx files are being processed.
let _pdfParse;
function getPdfParse() {
  if (!_pdfParse) _pdfParse = require('pdf-parse/lib/pdf-parse.js');
  return _pdfParse;
}

// Custom page renderer: cluster text items by Y-coordinate with a
// small tolerance window, then sort by X within each cluster, then
// join with single spaces.
//
// The earlier implementation used Math.round(transform[5]) as the
// row key. That works when every glyph in a row sits on the exact
// same baseline, but real PDFs (and especially multi-font tables
// like QuickBooks exports) emit labels and amounts at slightly
// different Y values — text labels at the letter baseline, numbers
// at the digit baseline, often 0.5–1.5pt apart. Rounding splits
// those into adjacent "lines" and the section parser misreads
// label-only lines as subgroup headers, sweeping the next row's
// number in as the subgroup's only item. The tolerance fix below
// snaps anything within ±Y_TOLERANCE of the current row's baseline
// to that row.
const Y_TOLERANCE = 3;
function spatialPageRender(pageData) {
  return pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  }).then(tc => {
    const items = [];
    for (const item of tc.items || []) {
      if (!item || !item.str) continue;
      const transform = item.transform || [1, 0, 0, 1, 0, 0];
      items.push({ y: transform[5] || 0, x: transform[4] || 0, str: item.str });
    }
    // Top-down (PDF Y axis goes bottom-up).
    items.sort((a, b) => b.y - a.y);
    const rows = [];
    let currentRow = null;
    let anchorY = null;
    for (const it of items) {
      if (anchorY === null || Math.abs(it.y - anchorY) > Y_TOLERANCE) {
        if (currentRow) rows.push(currentRow);
        currentRow = [];
        anchorY = it.y;
      }
      currentRow.push(it);
    }
    if (currentRow) rows.push(currentRow);
    return rows
      .map(row => row.sort((a, b) => a.x - b.x).map(i => i.str).join(' '))
      .join('\n');
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

// Space-delimited (PDF text stream) and tab-delimited (xlsx export) forms.
// The tab form is tried first to avoid ambiguity when account names
// contain numbers (e.g. "Deposit 8222" vs actual amount "173568.15").
const AMOUNT_AT_END = /^(.*?)\s+([\-(]?\$?[\d.,]+\)?)\s*$/;
const AMOUNT_AT_END_TAB = /^(.*?)\t([\-(]?\$?[\d.,]+\)?)$/;

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

  // Page chrome that should never count as a section / item. QB
  // exports repeat this header on every page; the time + date stamp
  // can also collide with the company name on a single text-stream
  // line, so we drop anything CONTAINING these markers, not just
  // lines that start with them.
  pageHeaderContains: /\d{1,2}:\d{2}\s*[AP]M|\d{1,2}\/\d{1,2}\/\d{2,4}|Accrual\s+Basis|Cash\s+Basis|Profit\s*&\s*Loss|Page\s+\d+\s*$/i,
  // The period-label header at the top of each page (e.g.
  // "January through December 2025" or "Jan - Dec 25"). Drop
  // standalone date-range labels; never an item.
  periodLabel: /^(?:[A-Z][a-z]+\s+through\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]{2,8}\s*[-–]\s*[A-Z][a-z]{2,8}\s*\d{2,4}|\d{4})$/,
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
    if (RE.pageHeaderContains.test(line)) continue;
    if (RE.periodLabel.test(line)) continue;

    const m = AMOUNT_AT_END_TAB.exec(line) || AMOUNT_AT_END.exec(line);
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
      // Skip bare numeric tokens — when pdf-parse strands an amount
      // on its own line (which the tolerant Y-clustering above should
      // mostly prevent, but can still happen with extreme baseline
      // jitter), it would otherwise become a fake subgroup whose
      // following rows get rolled up under a name like "258,32".
      if (/^[\-(]?\$?[\d.,]+\)?$/.test(label)) continue;
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
      // Orphan item under a section with no current group — single-
      // line group (QB exports skip the "Header / item / Total Header"
      // wrapper for things like "Depreciation Expense 19,800.00" that
      // have no sub-items). Treat as a standalone group named after
      // the line itself with total = amount and NO child items —
      // listing both the group and a self-named item underneath read
      // as redundant clutter. Owner can still + Add line item if they
      // want to break it down later. Flush immediately so the next
      // real header opens fresh.
      group = { name: label, total: amount, items: [] };
      flushGroup();
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

  // Post-pass: consolidate duplicate group names within each
  // section. QB exports + pdf-parse occasionally produce the same
  // group header twice (once as a partial accumulation and again as
  // the "real" group bracketed by Total X). When that happens the
  // entry with the larger total wins and the other's items merge in.
  for (const sec of Object.values(out.sections)) {
    if (!sec.groups || sec.groups.length < 2) continue;
    const byName = new Map();
    for (const g of sec.groups) {
      const key = (g.name || '').trim().toLowerCase();
      if (!key) { continue; }
      const prev = byName.get(key);
      if (!prev) { byName.set(key, g); continue; }
      // Merge: keep the larger of the two totals, append items.
      const prevTotal = Number(prev.total) || 0;
      const curTotal = Number(g.total) || 0;
      if (curTotal > prevTotal) prev.total = g.total;
      prev.items = [...(prev.items || []), ...(g.items || [])];
    }
    sec.groups = [...byName.values()];
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

// Extract the company name from the first ~25 lines of extracted PDF text.
// QuickBooks puts the company name near the top, often on the same spatial
// row as the timestamp (e.g. "9:23 AM  Sabor Latino Restaurant"). When that
// pattern is found we strip the timestamp prefix; otherwise we take the first
// non-header line that contains letters.
function cleanCompanyName(s) {
  if (!s) return s;
  // Strip trailing column-period headers that may have merged onto the same spatial line.
  // e.g. "DBA Sabor Latino & Deli INC  Jan - Dec 25"  →  "DBA Sabor Latino & Deli INC"
  s = s.replace(/\s+(TOTAL|AMOUNT|BALANCE|NET|GROSS|SUBTOTAL)\s*$/i, '').trim();
  s = s.replace(/\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-–]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{2,4}\s*$/i, '').trim();
  s = s.replace(/\s+As\s+of\s+.+$/i, '').trim();
  return s || null;
}

function extractCompanyName(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 40);
  const REPORT_HDR = /Accrual\s+Basis|Cash\s+Basis|Profit\s*[&\/]\s*Loss|Balance\s+Sheet|Page\s+\d+|Estado\s+de\s+Resultados|Balance\s+General|P[eé]rdidas\s+y\s+Ganancias/i;
  const DATE_RANGE = /^(?:[A-Z][a-z]+\s+through\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]{2,8}\s*[-–]\s*[A-Z][a-z]{2,8}\s*\d{2,4}|\d{4})$/;
  const QB_COL_HDR = /^(TOTAL|AMOUNT|BALANCE|NET|GROSS|SUBTOTAL|INCOME|EXPENSE|EXPENSES|PROFIT|LOSS|REVENUE|COST|ASSETS|LIABILITIES|EQUITY|CASH)$/;

  function isJunk(l) {
    if (!l || l.length < 4) return true;
    if (/^\d+$/.test(l)) return true;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(l)) return true;
    if (REPORT_HDR.test(l)) return true;
    if (DATE_RANGE.test(l)) return true;
    if (QB_COL_HDR.test(l.trim())) return true;
    return false;
  }

  // Pass 1: QuickBooks "HH:MM AM  CompanyName" on the same spatial line.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^\d{1,2}:\d{2}\s*[AP]M\s+(.+)$/i);
    if (m) {
      const candidate = cleanCompanyName(m[1].trim());
      if (candidate && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(candidate) && /[A-Za-z]/.test(candidate) && candidate.length > 3) {
        return candidate;
      }
    }
  }

  // Pass 2: first meaningful non-header line.
  // When a standalone timestamp line is found, also peek at the next 1-2 lines
  // because QB sometimes puts the company name on the line immediately below the print time.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/\d{1,2}:\d{2}\s*[AP]M/i.test(l)) {
      // Standalone timestamp — company name may follow on the next line(s).
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (!isJunk(next) && /[A-Za-z]/.test(next)) return cleanCompanyName(next);
      }
      continue;
    }
    if (isJunk(l)) continue;
    if (/[A-Za-z]/.test(l)) return cleanCompanyName(l);
  }
  return null;
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
    const parsed = await getPdfParse()(buffer, PDF_PARSE_OPTIONS);
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
  out.companyName = extractCompanyName(text);
  log('[pdf-parser] kind=%s companyName=%s first300=%s',
    kind, JSON.stringify(out.companyName), JSON.stringify(text.slice(0, 300)));
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

  // Always carry the first 1500 chars of extracted text + the marker
  // hits in debug. The server-side route streams these into Render
  // logs when the parse looks wrong (zero matches OR rollup warnings)
  // so the regexes can be tuned against the actual pdf-parse output
  // without another deploy cycle.
  out.debug.textSample = text.slice(0, 1500);
  out.debug.markersFound = { hasPl, hasBalance };
  return out;
}

module.exports = { parsePdf, parseAmount, parseDynamic };
