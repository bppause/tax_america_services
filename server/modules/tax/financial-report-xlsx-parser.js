'use strict';

// QuickBooks Desktop xlsx export parser for P&L and Balance Sheet reports.
// QB embeds the company name and report type in named ranges, so extraction
// is exact — no heuristic text scanning needed. The P&L data is converted
// to tab-delimited text and fed into parseDynamic (the same state machine
// as the PDF parser), using tab as the label/amount separator to avoid
// misreading numbers that appear in account names (e.g. "Deposit 8222").

const XLSX = require('xlsx');
const { log } = require('../../../logger');
const { parseDynamic, parseAmount } = require('./financial-report-parser');

const BALANCE_PATTERNS = [
  { re: /^Total\s*Checking\/?Savings$/i,           key: 'cash' },
  { re: /^Food\s*Inventory$/i,                     key: 'inventory' },
  { re: /^Total\s*Other\s*Current\s*Assets$/i,     key: 'other_current_assets' },
  { re: /^Accumulated\s*Depreciation$/i,           key: 'accumulated_depreciation' },
  { re: /^Total\s*Fixed\s*Assets$/i,               key: 'fixed_assets_gross' },
  { re: /^Total\s*Other\s*Assets$/i,               key: 'other_assets' },
  { re: /^Total\s*Current\s*Liabilities$/i,        key: 'current_liabilities' },
  { re: /^Total\s*Long\s*Term\s*Liabilities$/i,    key: 'long_term_liabilities' },
  { re: /^Retained\s*Earnings$/i,                  key: 'retained_earnings' },
  { re: /^Total\s*Shareholder\s*Distributions$/i,  key: 'distributions' },
];

// Extract company name from the QBCOMPANYFILENAME named range.
// QB stores it as a quoted Windows path string ending in .qbw:
//   '"C:\\Users\\...\\DBA Sabor Latino & Deli INC.qbw"'
function extractCompanyName(wb) {
  const names = (wb.Workbook?.Names) || [];
  const entry = names.find(n => n.Name === 'QBCOMPANYFILENAME');
  if (!entry) return null;
  const m = String(entry.Ref || '').match(/([^\\/"]+)\.qbw"?$/i);
  return m ? m[1].trim() : null;
}

// QBREPORTTYPE: 0 = Profit & Loss, 5 = Balance Sheet.
function detectType(wb) {
  const names = (wb.Workbook?.Names) || [];
  const entry = names.find(n => n.Name === 'QBREPORTTYPE');
  if (!entry) return 'unknown';
  const v = String(entry.Ref || '').trim();
  if (v === '0') return 'pl';
  if (v === '5') return 'balance';
  return 'unknown';
}

// Get the report data sheet (everything except the QB tips sheet).
function getDataSheet(wb) {
  const name = wb.SheetNames.find(n => !/QuickBooks Desktop Export Tips/i.test(n))
    || wb.SheetNames[0];
  return wb.Sheets[name] || null;
}

// Convert the sheet into rows of { indent, label, amount }.
// Indent = index of first non-empty cell; amount = value in the last column.
function sheetToRows(ws) {
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const maxCol = raw.reduce((m, r) => Math.max(m, r.length - 1), 0);
  const result = [];
  for (const row of raw) {
    let indent = -1, label = '';
    for (let i = 0; i <= maxCol; i++) {
      if (row[i] !== '' && row[i] != null) { indent = i; label = String(row[i]).trim(); break; }
    }
    if (indent < 0 || !label) continue;
    const last = row[maxCol];
    let amount = null;
    if (last !== '' && last != null) {
      if (typeof last === 'number' && isFinite(last)) amount = last;
      else { const n = parseAmount(String(last)); if (n != null) amount = n; }
    }
    result.push({ indent, label, amount });
  }
  return result;
}

// Convert rows to tab-delimited text so parseDynamic can process them.
// "label\tamount" when an amount exists, "label" otherwise.
// The tab delimiter avoids the PDF parser's space-based AMOUNT_AT_END
// regex misreading numbers embedded in account names (e.g. "Deposit 8222").
function rowsToText(rows) {
  return rows.map(({ label, amount }) =>
    amount != null ? `${label}\t${amount}` : label
  ).join('\n');
}

function parseXlsxPl(rows) {
  return parseDynamic(rowsToText(rows));
}

function parseXlsxBalance(rows) {
  const out = {};
  let matched = 0;
  for (const { re, key } of BALANCE_PATTERNS) {
    const row = rows.find(r => re.test(r.label) && r.amount != null);
    if (row) { out[key] = row.amount; matched++; }
  }
  return { fields: out, matched };
}

async function parseXlsx(buffer, kind) {
  const out = {
    pl: null, balance: null,
    debug: { matched: 0, characters: buffer.length, detectedType: null, typeMismatch: false, warnings: [] },
  };
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    out.debug.error = String(e?.message || e);
    return out;
  }

  out.companyName = extractCompanyName(wb);
  out.debug.detectedType = detectType(wb);
  log('[xlsx-parser] kind=%s companyName=%s detectedType=%s',
    kind, JSON.stringify(out.companyName), out.debug.detectedType);

  if (kind === 'pl'      && out.debug.detectedType === 'balance') { out.debug.typeMismatch = true; return out; }
  if (kind === 'balance' && out.debug.detectedType === 'pl')      { out.debug.typeMismatch = true; return out; }

  const ws = getDataSheet(wb);
  if (!ws) { out.debug.error = 'no_data_sheet'; return out; }
  const rows = sheetToRows(ws);

  if (kind === 'balance') {
    const r = parseXlsxBalance(rows);
    out.balance = r.fields;
    out.debug.matched = r.matched;
  } else {
    out.pl = parseXlsxPl(rows);
    out.debug.matched = out.pl?.debug?.matched || 0;
    out.debug.warnings = out.pl?.debug?.warnings || [];
  }
  return out;
}

module.exports = { parseXlsx };
