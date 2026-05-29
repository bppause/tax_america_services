// Schedule engine — pure functions for generating filing due dates from a
// `tax_filing_schedules.anchor_rule`. No DB, no I/O — easy to unit-test.
//
// Supported anchor_rule shapes:
//
//   { type: 'fixed_quarterly', dates: ['MM-DD','MM-DD','MM-DD','MM-DD'] }
//     Ordered Q1..Q4. If a date's month is lower than the previous quarter's
//     month, the year auto-increments — so federal 1040-ES Q4 ['01-15']
//     following Q3 ['09-15'] lands in January of the following year.
//
//   { type: 'monthly_following', day: <1-28> }
//     Filing covers calendar month M; due on `day` of month M+1.
//
//   { type: 'annual', date: 'MM-DD' }
//     One filing per calendar year; covers the prior tax year.
//
// All dates use UTC to avoid host-tz drift in cron jobs.

'use strict';

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseMmDd(s) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return { month: parseInt(m[1], 10), day: parseInt(m[2], 10) };
}

function parseRefDate(input) {
  if (input instanceof Date) return input;
  const d = new Date(input || Date.now());
  return isNaN(d) ? new Date() : d;
}

function toYmd(d) {
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function capitalize(s) { return String(s || '').replace(/^./, c => c.toUpperCase()); }
function monthLabel(y, m, lang) {
  const names = lang === 'en' ? MONTHS_EN : MONTHS_ES;
  return `${capitalize(names[m - 1])} ${y}`;
}
function quarterLabel(idx, year, lang) {
  return lang === 'en' ? `Q${idx + 1} ${year}` : `T${idx + 1} ${year}`;
}
function annualLabel(taxYear, lang) {
  return lang === 'en' ? `Tax Year ${taxYear}` : `Año Fiscal ${taxYear}`;
}

// Returns up to `limit` upcoming periods (dueDate >= fromDate). Each entry:
//   { dueDate, periodStart, periodEnd, periodLabel }   (all ISO date strings)
function generatePeriods(anchorRule, fromDate, limit = 6, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'es';
  const ref = parseRefDate(fromDate);
  const refIso = toYmd(ref);
  const refYear = ref.getUTCFullYear();
  const rule = anchorRule || {};

  if (rule.type === 'fixed_quarterly') return fixedQuarterly(rule, refIso, refYear, limit, lang);
  if (rule.type === 'monthly_following') return monthlyFollowing(rule, ref, refYear, limit, lang);
  if (rule.type === 'quarterly_following') return quarterlyFollowing(rule, ref, refYear, limit, lang);
  if (rule.type === 'weekly_following') return weeklyFollowing(rule, ref, limit, lang);
  if (rule.type === 'annual') return annual(rule, refIso, refYear, limit, lang);
  return [];
}

// Phase 4n.3: generic quarterly cadence — period is a calendar quarter, due
// date is `day` of the month immediately following the quarter end. So with
// day=15 the dues are Apr 15, Jul 15, Oct 15, Jan 15 (the typical 1040-ES
// pattern — useful when owners want generic quarterly without listing fixed
// dates).
function quarterlyFollowing(rule, ref, refYear, limit, lang) {
  const day = Math.max(1, Math.min(28, parseInt(rule.day, 10) || 15));
  const refIso = toYmd(ref);
  const out = [];
  const quarters = [
    { startMonth: 1,  endMonth: 3,  dueMonth: 4  },
    { startMonth: 4,  endMonth: 6,  dueMonth: 7  },
    { startMonth: 7,  endMonth: 9,  dueMonth: 10 },
    { startMonth: 10, endMonth: 12, dueMonth: 1, dueYearOffset: 1 },
  ];
  for (let y = refYear - 1; y < refYear + 4 && out.length < limit + 4; y++) {
    for (let q = 0; q < quarters.length; q++) {
      const cfg = quarters[q];
      const dueYear = y + (cfg.dueYearOffset || 0);
      const dueDay = Math.min(day, lastDayOfMonth(dueYear, cfg.dueMonth));
      const due = ymd(dueYear, cfg.dueMonth, dueDay);
      if (due >= refIso) {
        out.push({
          dueDate: due,
          periodStart: ymd(y, cfg.startMonth, 1),
          periodEnd: ymd(y, cfg.endMonth, lastDayOfMonth(y, cfg.endMonth)),
          periodLabel: quarterLabel(q, y, lang),
        });
      }
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, limit);
}

// Weekly cadence — due every 7 days on `dayOfWeek` (1=Mon … 7=Sun, ISO).
// Period covers the 7 days ending at the due date.
function weeklyFollowing(rule, ref, limit, lang) {
  const dow = Math.max(1, Math.min(7, parseInt(rule.dayOfWeek, 10) || 5));
  const refIso = toYmd(ref);
  const out = [];
  // Start from refDate, walk forward day by day until we hit the target dow,
  // then add weekly. Use UTC to avoid tz drift.
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  // JS getUTCDay: 0=Sun..6=Sat. Convert to ISO 1..7.
  function isoDay(date) {
    const js = date.getUTCDay();
    return js === 0 ? 7 : js;
  }
  while (isoDay(d) !== dow) d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < limit; i++) {
    const due = toYmd(d);
    if (due >= refIso) {
      const start = new Date(d);
      start.setUTCDate(start.getUTCDate() - 6);
      out.push({
        dueDate: due,
        periodStart: toYmd(start),
        periodEnd: due,
        periodLabel: lang === 'en' ? `Week of ${toYmd(start)}` : `Semana del ${toYmd(start)}`,
      });
    }
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

function fixedQuarterly(rule, refIso, refYear, limit, lang) {
  const parsed = (rule.dates || []).map(parseMmDd).filter(Boolean);
  if (!parsed.length) return [];

  const out = [];
  // Look back one year so we don't miss periods that started before today
  // but whose due-date is still upcoming.
  for (let y = refYear - 1; y < refYear + 3 && out.length < limit + 8; y++) {
    let prevMonth = -1;
    parsed.forEach((p, idx) => {
      const dueYear = (prevMonth >= 0 && p.month < prevMonth) ? y + 1 : y;
      prevMonth = p.month;
      const day = Math.min(p.day, lastDayOfMonth(dueYear, p.month));
      const dueDate = ymd(dueYear, p.month, day);
      const qStartMonth = [1, 4, 7, 10][idx] || 1;
      const qEndMonth = qStartMonth + 2;
      const periodStart = ymd(y, qStartMonth, 1);
      const periodEnd = ymd(y, qEndMonth, lastDayOfMonth(y, qEndMonth));
      out.push({
        dueDate, periodStart, periodEnd,
        periodLabel: quarterLabel(idx, y, lang),
      });
    });
  }
  return out
    .filter(p => p.dueDate >= refIso)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, limit);
}

function monthlyFollowing(rule, ref, refYear, limit, lang) {
  const day = Math.max(1, Math.min(28, parseInt(rule.day, 10) || 20));
  const refIso = toYmd(ref);
  const out = [];
  // Walk forward from two months before ref to catch boundary cases.
  let y = refYear;
  let m = ref.getUTCMonth() - 1;       // 0-indexed month of period
  while (m < 0) { m += 12; y -= 1; }
  for (let i = 0; i < 36 && out.length < limit; i++) {
    const periodMonth = m + 1;          // 1-indexed
    const periodLast = lastDayOfMonth(y, periodMonth);
    const dueY = periodMonth === 12 ? y + 1 : y;
    const dueM = periodMonth === 12 ? 1 : periodMonth + 1;
    const dueD = Math.min(day, lastDayOfMonth(dueY, dueM));
    const due = ymd(dueY, dueM, dueD);
    if (due >= refIso) {
      out.push({
        dueDate: due,
        periodStart: ymd(y, periodMonth, 1),
        periodEnd: ymd(y, periodMonth, periodLast),
        periodLabel: monthLabel(y, periodMonth, lang),
      });
    }
    m += 1;
    if (m > 11) { m -= 12; y += 1; }
  }
  return out;
}

function annual(rule, refIso, refYear, limit, lang) {
  // Accept two shapes — the documented `date: 'MM-DD'` form and the
  // {month, day} form that auto-task-templates.js + the bookkeeping
  // H1/H2 migrations write. Without the {month,day} fallback every
  // catalog template tagged 'annual' (doc-collection, prepare-1040,
  // q1..q4, year-end-review, w2-1099-prep, annual-close, the new
  // bookkeeping H1/H2) silently produces zero periods.
  let p = parseMmDd(rule.date);
  if (!p) {
    const m = Number(rule.month);
    const d = Number(rule.day);
    if (Number.isFinite(m) && Number.isFinite(d) && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      p = { month: m, day: d };
    }
  }
  if (!p) return [];
  // taxYearOffset: how many years to subtract from the due year to get the
  // label year. Default -1 (prior-year coverage, e.g. 1040 due Apr 2026
  // covers Tax Year 2025). Use 0 for same-year coverage — e.g. the H1
  // bookkeeping report due Jul 31, 2026 covers Jan–Jun 2026 (Tax Year 2026).
  const taxYearOffset = rule.taxYearOffset !== undefined ? Number(rule.taxYearOffset) : -1;
  const out = [];
  for (let year = refYear; year < refYear + 4 && out.length < limit; year++) {
    const day = Math.min(p.day, lastDayOfMonth(year, p.month));
    const due = ymd(year, p.month, day);
    if (due >= refIso) {
      const taxYear = year + taxYearOffset;
      out.push({
        dueDate: due,
        periodStart: ymd(taxYear, 1, 1),
        periodEnd: ymd(taxYear, 12, 31),
        periodLabel: annualLabel(taxYear, lang),
      });
    }
  }
  return out;
}

// Adds `days` to an ISO date (days can be negative).
function shiftDays(dueDateIso, days) {
  const d = new Date(dueDateIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

// Returns the firing date for each reminder offset (negative = days before due).
function reminderFireDates(dueDateIso, offsetsDays) {
  return (offsetsDays || []).map(d => shiftDays(dueDateIso, d));
}

module.exports = {
  generatePeriods,
  reminderFireDates,
  shiftDays,
  toYmd,
  _internal: { fixedQuarterly, monthlyFollowing, annual, parseMmDd, lastDayOfMonth },
};
