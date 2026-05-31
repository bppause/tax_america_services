// Phase 4n.74: bookkeeping financial reports section.
//
// Dynamic section/group/item editor — the form shape mirrors what
// the parser produces. Sections (income, cogs, expenses, other_income,
// other_expense) hold groups; groups hold line items. Owner can add,
// rename, delete anything. Totals roll up live.
//
// Legacy reports stored in the original flat shape ({revenue:{},
// expenses:{}, cogs, …}) are auto-converted on load via
// normalizePlData so they continue to render and edit cleanly.
//
// All labels run through useT() so the section follows the
// owner/employee language toggle.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';

// Fuzzy company-name match: normalize away legal suffixes, common type
// words (Restaurant, Deli, DBA…), punctuation, then check whether the
// two names' meaningful words share any overlap. Returns true when the
// names are close enough, false when they look like different businesses.
function companyNamesMatch(a, b) {
  if (!a || !b) return true;
  const stop = /\b(dba|the|a|an|and|or|of|inc|llc|corp|ltd|co|restaurant|cafe|bar|grill|kitchen|deli|bakery|store|shop|services|group|enterprise|enterprises)\b/g;
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(stop, ' ').replace(/\s+/g, ' ').trim();
  const words = s => new Set(normalize(s).split(' ').filter(w => w.length > 2));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) {
    return normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a));
  }
  return [...wa].some(w => wb.has(w));
}

const BALANCE_KEYS = [
  'cash', 'inventory', 'other_current_assets', 'fixed_assets_gross',
  'accumulated_depreciation', 'other_assets', 'current_liabilities',
  'long_term_liabilities', 'retained_earnings', 'distributions',
];

const SECTION_KEYS = ['income', 'cogs', 'expenses', 'other_income', 'other_expense'];

function emptySection() { return { groups: [], total: null }; }

function emptyPlData() {
  return {
    sections: SECTION_KEYS.reduce((acc, k) => { acc[k] = emptySection(); return acc; }, {}),
    totals: {},
  };
}

function emptyForm() {
  const blank = {
    period_label: '', period_start: '', period_end: '', cadence: 'semi_annual',
    notes: '',
    pl_data: emptyPlData(),
    balance_data: {},
  };
  for (const k of BALANCE_KEYS) blank.balance_data[k] = '';
  return blank;
}

function prettifyKey(k) {
  if (!k) return '';
  return String(k).split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim();
}

// Convert the legacy flat shape ({revenue:{...}, expenses:{...}, cogs,
// sales_tax_collected, ...}) into the new sectional shape. New-shape
// data passes through unchanged. Anything missing collapses to an
// empty section so the editor still renders.
function normalizePlData(pl) {
  if (!pl || typeof pl !== 'object') return emptyPlData();
  if (pl.sections) {
    // New shape — fill in any missing section so the editor has all five.
    const sections = {};
    for (const k of SECTION_KEYS) sections[k] = pl.sections[k] ? cloneSection(pl.sections[k]) : emptySection();
    return { sections, totals: { ...(pl.totals || {}) }, _companyName: pl._companyName || undefined, _fileName: pl._fileName || undefined };
  }
  // Legacy shape — synthesize sections from the flat fields.
  const out = emptyPlData();
  if (pl.revenue && typeof pl.revenue === 'object') {
    const items = Object.entries(pl.revenue)
      .filter(([, v]) => Number(v) !== 0)
      .map(([k, v]) => ({ name: prettifyKey(k), amount: Number(v) }));
    if (items.length) {
      const total = items.reduce((s, i) => s + i.amount, 0);
      out.sections.income.groups.push({ name: 'Revenue', total, items });
      out.sections.income.total = total;
    }
  }
  if (Number(pl.sales_tax_collected) > 0) {
    out.sections.income.groups.push({
      name: 'Sales tax collected', total: Number(pl.sales_tax_collected),
      items: [{ name: 'Sales tax collected', amount: Number(pl.sales_tax_collected) }],
    });
  }
  if (Number(pl.cogs) !== 0) {
    out.sections.cogs.groups.push({ name: 'Cost of goods sold', total: Number(pl.cogs), items: [] });
    out.sections.cogs.total = Number(pl.cogs);
  }
  if (pl.expenses && typeof pl.expenses === 'object') {
    for (const [k, v] of Object.entries(pl.expenses)) {
      if (Number(v) === 0) continue;
      out.sections.expenses.groups.push({
        name: prettifyKey(k), total: Number(v), items: [{ name: prettifyKey(k), amount: Number(v) }],
      });
    }
    out.sections.expenses.total = out.sections.expenses.groups.reduce((s, g) => s + Number(g.total || 0), 0);
  }
  if (Number(pl.sales_tax_remitted) > 0) {
    out.sections.other_expense.groups.push({
      name: 'Sales tax remitted', total: Number(pl.sales_tax_remitted),
      items: [{ name: 'Sales tax remitted', amount: Number(pl.sales_tax_remitted) }],
    });
    out.sections.other_expense.total = Number(pl.sales_tax_remitted);
  }
  out.totals = {
    total_income: pl.total_income,
    total_cogs: pl.cogs,
    gross_profit: pl.gross_profit,
    total_expense: out.sections.expenses.total,
    net_ordinary_income: pl.net_ordinary_income,
    net_income: pl.net_income,
  };
  return out;
}

function cloneSection(s) {
  return {
    groups: (s.groups || []).map(g => ({
      name: g.name || '',
      total: g.total ?? null,
      items: (g.items || []).map(i => ({ name: i.name || '', amount: i.amount ?? null, rollup: !!i.rollup })),
    })),
    total: s.total ?? null,
  };
}

function reportToForm(r) {
  const f = emptyForm();
  if (!r) return f;
  f.period_label = r.period_label || '';
  f.period_start = r.period_start || '';
  f.period_end = r.period_end || '';
  f.cadence = r.cadence || 'semi_annual';
  f.notes = r.notes || '';
  f.pl_data = normalizePlData(r.pl_data);
  const bal = r.balance_data || {};
  for (const k of BALANCE_KEYS) f.balance_data[k] = bal[k] != null ? String(bal[k]) : '';
  return f;
}

function num(v) {
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Returns true if any group in the P&L data has a declared total that
// doesn't match the sum of its items (the only condition that blocks publish).
function plHasMismatch(plData) {
  if (!plData?.sections) return false;
  for (const section of Object.values(plData.sections)) {
    for (const g of (section?.groups || [])) {
      const itemSum = (g.items || []).reduce((s, i) => s + num(i.amount), 0);
      const declared = g.total != null && g.total !== '' ? num(g.total) : null;
      if (declared != null && (g.items || []).length > 0 && Math.abs(declared - itemSum) > 0.5) return true;
    }
  }
  return false;
}
// Returns list of affected file labels (e.g. ['P&L']) for the publish-block message.
function mismatchedFiles(rpt) {
  const files = [];
  if (plHasMismatch(rpt.pl_data)) files.push('P&L');
  return files;
}

// Compute totals from the section/group tree. Sums groups within each
// section, derives the canonical totals (gross_profit, net_income,
// etc.). Used to display live totals + sent to the server alongside
// the form data so any consumer reading just `totals` gets balanced
// numbers without having to walk the tree themselves.
function computeTotals(pl) {
  const ss = pl.sections || {};
  const sectionTotal = (key) => (ss[key]?.groups || [])
    .reduce((s, g) => s + (Number(g.total) || (g.items || []).reduce((a, i) => a + (Number(i.amount) || 0), 0)), 0);
  const inc = sectionTotal('income');
  const cog = sectionTotal('cogs');
  const exp = sectionTotal('expenses');
  const oi = sectionTotal('other_income');
  const oe = sectionTotal('other_expense');
  const gp = inc - cog;
  const noi = gp - exp;
  const noo = oi - oe;
  return {
    total_income: inc,
    total_cogs: cog,
    gross_profit: gp,
    total_expense: exp,
    net_ordinary_income: noi,
    net_other_income: noo,
    net_income: noi + noo,
  };
}

function formToPayload(f) {
  const pl_data = {
    sections: {},
    // Preserve QB-reported totals for xlsx imports — recomputing overwrites
    // net_income with a different figure (Sales Tax Collected/Remitted treatment).
    totals: f.pl_data._companyName && f.pl_data.totals ? f.pl_data.totals : computeTotals(f.pl_data),
  };
  if (f.pl_data._companyName) pl_data._companyName = f.pl_data._companyName;
  if (f.pl_data._fileName) pl_data._fileName = f.pl_data._fileName;
  for (const k of SECTION_KEYS) {
    const sec = f.pl_data.sections[k] || emptySection();
    pl_data.sections[k] = {
      total: sec.total != null ? Number(sec.total) : pl_data.totals[k === 'income' ? 'total_income' : k === 'cogs' ? 'total_cogs' : k === 'expenses' ? 'total_expense' : null] || null,
      groups: (sec.groups || []).map(g => ({
        name: String(g.name || '').trim(),
        total: g.total != null && g.total !== '' ? num(g.total) : (g.items || []).reduce((s, i) => s + num(i.amount), 0),
        items: (g.items || []).map(i => ({
          name: String(i.name || '').trim(),
          amount: num(i.amount),
          ...(i.rollup ? { rollup: true } : {}),
        })),
      })),
    };
  }
  const balance_data = {};
  for (const k of BALANCE_KEYS) balance_data[k] = num(f.balance_data[k]);
  if (f.balance_data._companyName) balance_data._companyName = f.balance_data._companyName;
  if (f.balance_data._fileName) balance_data._fileName = f.balance_data._fileName;
  return {
    period_label: f.period_label.trim(),
    period_start: f.period_start,
    period_end: f.period_end,
    cadence: f.cadence,
    notes: f.notes,
    pl_data,
    balance_data,
  };
}

// Merge parsed PDF data into the form. For PL, the parser already
// returns the new shape ({ sections, totals }) — we just replace
// pl_data wholesale, which is what the owner expects when they
// upload a fresh PDF.
function mergeParsedIntoForm(prev, parsed, kind) {
  const out = { ...prev };
  if (kind === 'balance' && parsed?.balance) {
    out.balance_data = { ...out.balance_data };
    for (const [k, v] of Object.entries(parsed.balance)) {
      if (v != null) out.balance_data[k] = String(v);
    }
    return out;
  }
  if (kind === 'pl' && parsed?.pl?.sections) {
    out.pl_data = normalizePlData(parsed.pl);
    return out;
  }
  return out;
}

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtInputNum(n) {
  const v = parseFloat(String(n == null ? '' : n).replace(/,/g, ''));
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso, locale) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES', { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_STYLE = {
  draft:     { bg: '#f1f5f9', color: '#334155' },
  published: { bg: '#fef3c7', color: '#92400e' },
  sent:      { bg: '#dcfce7', color: '#166534' },
};

const SECTION_TITLE_KEY = {
  income: 'owner.customer.bookkeeping.section.income',
  cogs: 'owner.customer.bookkeeping.section.cogs',
  expenses: 'owner.customer.bookkeeping.section.expenses',
  other_income: 'owner.customer.bookkeeping.section.other_income',
  other_expense: 'owner.customer.bookkeeping.section.other_expense',
};

export default function BookkeepingReportsSection({ auth, customerId, customer, refreshNonce, initialReportId, drawerMode, onEditRequest, onNewRequest, onDone }) {
  const { t, locale } = useT();
  const [reports, setReports] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [bookkeepingActive, setBookkeepingActive] = useState(null);
  const [editingId, setEditingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: '', text: '' });
  const [pdfMeta, setPdfMeta] = useState({ pl: null, balance: null }); // { fileName, companyName, mismatch }
  const [taskId, setTaskId] = useState(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState('idle'); // 'idle'|'pending'|'saving'|'saved'|'error'
  const sectionRef = useRef(null);
  const autoSaveTimerRef = useRef(null);
  const ignoreNextFormChangeRef = useRef(false);

  const load = () => {
    taxApi.adminListFinancialReports(auth, customerId)
      .then(d => {
        setReports(d.reports || []);
        setAccessToken(d.accessToken || null);
        setBookkeepingActive(!!d.bookkeepingActive);
      })
      .catch(e => setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.loadFailed') }));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [customerId, refreshNonce]);

  const triedInitialId = useRef(null);
  useEffect(() => {
    if (!initialReportId || !reports) return;
    if (triedInitialId.current === initialReportId) return;
    const row = reports.find(r => r.id === initialReportId);
    if (row) {
      triedInitialId.current = initialReportId;
      startEdit(row);
    } else {
      // Not in list yet (newly created) — re-fetch once
      if (triedInitialId.current !== `retry:${initialReportId}`) {
        triedInitialId.current = `retry:${initialReportId}`;
        load();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReportId, reports]);

  // Auto-save: fires 1.5s after last form change while editing/creating
  useEffect(() => {
    if (!editingId && !creating) return;
    if (ignoreNextFormChangeRef.current) { ignoreNextFormChangeRef.current = false; return; }
    if (!form.period_label || !form.period_start || !form.period_end) return;
    setAutoSaveStatus('pending');
    const timer = setTimeout(async () => {
      setAutoSaveStatus('saving');
      try {
        const payload = formToPayload(form);
        if (editingId) {
          await taxApi.adminUpdateFinancialReport(auth, editingId, payload);
        } else {
          const d = await taxApi.adminCreateFinancialReport(auth, customerId, payload);
          ignoreNextFormChangeRef.current = true;
          setEditingId(d.report.id);
          setCreating(false);
        }
        setAutoSaveStatus('saved');
        load();
        setTimeout(() => setAutoSaveStatus(s => s === 'saved' ? 'idle' : s), 3000);
      } catch (_e) {
        setAutoSaveStatus('error');
      }
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const resetPl = () => {
    if (!confirm(t('owner.customer.bookkeeping.confirm.resetPl'))) return;
    setForm(prev => ({ ...prev, pl_data: emptyPlData() }));
    setPdfMeta(prev => ({ ...prev, pl: null }));
  };
  const resetBalance = () => {
    if (!confirm(t('owner.customer.bookkeeping.confirm.resetBalance'))) return;
    const blank = {};
    for (const k of BALANCE_KEYS) blank[k] = '';
    setForm(prev => ({ ...prev, balance_data: blank }));
    setPdfMeta(prev => ({ ...prev, balance: null }));
  };

  const startCreate = () => {
    ignoreNextFormChangeRef.current = true;
    setAutoSaveStatus('idle');
    clearTimeout(autoSaveTimerRef.current);
    setForm(emptyForm()); setCreating(true); setEditingId(''); setMsg({ kind: '', text: '' }); setPdfMeta({ pl: null, balance: null }); setTaskId(null);
  };
  const startEdit = (r) => {
    setPdfMeta({ pl: null, balance: null });
    ignoreNextFormChangeRef.current = true;
    setAutoSaveStatus('idle');
    clearTimeout(autoSaveTimerRef.current);
    setBusy(true);
    taxApi.adminGetFinancialReport(auth, r.id)
      .then(d => {
        ignoreNextFormChangeRef.current = true;
        setForm(reportToForm(d.report));
        setEditingId(r.id);
        setCreating(false);
        setMsg({ kind: '', text: '' });
        const rpt = d.report;
        const tid = rpt.task_id || null;
        setTaskId(tid);
        if (tid) taxApi.adminUpdateTask(auth, tid, { statusKey: 'in_progress' }).catch(() => {});
        const biz = customer?.business_name || customer?.name || null;
        const plCn = rpt.pl_data?._companyName || null;
        const balCn = rpt.balance_data?._companyName || null;
        setPdfMeta({
          pl: rpt.pl_pdf_path ? {
            fileName: rpt.pl_data?._fileName || t('owner.customer.bookkeeping.pdf.onFile'),
            companyName: plCn,
            mismatch: !!(plCn && biz && !companyNamesMatch(plCn, biz)),
          } : null,
          balance: rpt.balance_pdf_path ? {
            fileName: rpt.balance_data?._fileName || t('owner.customer.bookkeeping.pdf.onFile'),
            companyName: balCn,
            mismatch: !!(balCn && biz && !companyNamesMatch(balCn, biz)),
          } : null,
        });
      })
      .catch(e => setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.loadFailed') }))
      .finally(() => setBusy(false));
  };
  const cancel = () => {
    clearTimeout(autoSaveTimerRef.current);
    ignoreNextFormChangeRef.current = true;
    setAutoSaveStatus('idle');
    setCreating(false); setEditingId(''); setForm(emptyForm()); setMsg({ kind: '', text: '' }); setPdfMeta({ pl: null, balance: null }); setTaskId(null);
  };

  const saveAndClose = async () => {
    clearTimeout(autoSaveTimerRef.current);
    const finalId = editingId; // capture before cancel clears it
    if ((editingId || creating) && form.period_label && form.period_start && form.period_end) {
      setAutoSaveStatus('saving');
      try {
        const payload = formToPayload(form);
        if (editingId) {
          await taxApi.adminUpdateFinancialReport(auth, editingId, payload);
        } else {
          await taxApi.adminCreateFinancialReport(auth, customerId, payload);
        }
        load();
      } catch (_e) {}
    }
    cancel();
    onDone?.(finalId || null); // close drawer and scroll to this report
  };

  const triedHashIds = useRef(new Set());
  useEffect(() => {
    function handleHash() {
      const m = (window.location.hash || '').match(/bookkeeping-edit=([^&]+)/);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      if (!reports) return;
      const row = reports.find(r => r.id === id);
      if (row) {
        triedHashIds.current.delete(id);
        startEdit(row);
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_e) {}
        setTimeout(() => {
          const el = document.querySelector('section.tax-card h3');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
        return;
      }
      if (!triedHashIds.current.has(id)) { triedHashIds.current.add(id); load(); }
    }
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports]);

  const save = async () => {
    if (!form.period_label || !form.period_start || !form.period_end) {
      setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.requiredFields') });
      return;
    }
    setBusy(true); setMsg({ kind: '', text: '' });
    try {
      const payload = formToPayload(form);
      if (editingId) await taxApi.adminUpdateFinancialReport(auth, editingId, payload);
      else            await taxApi.adminCreateFinancialReport(auth, customerId, payload);
      setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.saved') });
      cancel(); load();
      setTimeout(() => sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.saveFailed') });
    } finally { setBusy(false); }
  };

  const publish = async (r) => {
    setBusy(true);
    let missing = [];
    let badFiles = [];
    try {
      const d = await taxApi.adminGetFinancialReport(auth, r.id);
      const rpt = d.report;
      const plOk = rpt.pl_data?.sections && Object.values(rpt.pl_data.sections).some(s => s?.groups?.length > 0);
      const balOk = rpt.balance_data && Object.values(rpt.balance_data).some(v => v != null && v !== '' && Number(v) !== 0);
      if (!plOk) missing.push('P&L');
      if (!balOk) missing.push('balance sheet');
      badFiles = mismatchedFiles(rpt);
    } catch (_e) { /* fetch failed — skip checks, let publish proceed */ }
    finally { setBusy(false); }

    if (badFiles.length > 0) {
      setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.publishMismatch', { files: badFiles.join(' and ') }) });
      return;
    }

    const confirmText = missing.length > 0
      ? t('owner.customer.bookkeeping.confirm.publishMissing', { period: r.period_label, missing: missing.join(' and ') })
      : t('owner.customer.bookkeeping.confirm.publish', { period: r.period_label });
    if (!confirm(confirmText)) return;

    setBusy(true);
    try { await taxApi.adminPublishFinancialReport(auth, r.id); load(); }
    catch (e) { setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.publishFailed') }); }
    finally { setBusy(false); }
  };

  const send = async (r, isResend) => {
    const confirmKey = isResend ? 'owner.customer.bookkeeping.confirm.resend' : 'owner.customer.bookkeeping.confirm.send';
    if (!confirm(t(confirmKey, { period: r.period_label }))) return;
    setBusy(true);
    try {
      const d = await taxApi.adminSendFinancialReport(auth, r.id);
      if (d.sent) {
        const tid = r.task_id || taskId || null;
        if (tid) taxApi.adminUpdateTask(auth, tid, { statusKey: 'completed' }).catch(() => {});
        setMsg({ kind: 'ok', text: t(isResend ? 'owner.customer.bookkeeping.msg.sendOk.resend' : 'owner.customer.bookkeeping.msg.sendOk.send') });
      } else {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.sendSkipped', { reason: d.reason || '?', url: d.viewUrl || '' }) });
      }
      load();
    } catch (e) { setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.sendFailed') }); }
    finally { setBusy(false); }
  };

  const uploadAndParsePdf = async (kind, file) => {
    if (!file) return;
    let reportId = editingId;
    setPdfMeta(prev => ({ ...prev, [kind]: { fileName: file.name } }));
    setBusy(true);
    try {
      if (!reportId) {
        // Auto-save a draft before uploading so we have an ID to attach to.
        if (!form.period_label || !form.period_start || !form.period_end) {
          setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.fillPeriodFirst') });
          return;
        }
        setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.autoSaving') });
        const d = await taxApi.adminCreateFinancialReport(auth, customerId, formToPayload(form));
        reportId = d.report.id;
        setEditingId(reportId);
        setCreating(false);
        load();
      }
      setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.uploading', { filename: file.name }) });
      const fileType = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'pdf';
      const mimeType = fileType === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
      const sig = await taxApi.adminFinancialReportUploadUrl(auth, reportId, kind, fileType);
      const putResp = await fetch(sig.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType, 'x-upsert': 'true' },
        body: file,
      });
      if (!putResp.ok) throw new Error(`Upload failed (${putResp.status}).`);
      setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.parsing') });
      const parseResult = await taxApi.adminFinancialReportParse(auth, reportId, kind);
      const dbg = parseResult.parsed?.debug || {};
      if (dbg.typeMismatch) {
        const expected = kind === 'balance' ? t('owner.customer.bookkeeping.pdf.balance') : t('owner.customer.bookkeeping.pdf.pl');
        const got = dbg.detectedType === 'pl' ? t('owner.customer.bookkeeping.pdf.pl')
          : dbg.detectedType === 'balance' ? t('owner.customer.bookkeeping.pdf.balance')
          : t('owner.customer.bookkeeping.pdf.unknown');
        setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.wrongType', { expected, got }), debug: dbg });
        return;
      }
      if (dbg.error === 'pdf_no_text_layer') { setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.noTextLayer'), debug: dbg }); return; }
      if (dbg.error) { setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.parseError', { error: dbg.error }), debug: dbg }); return; }
      const companyName = parseResult.parsed?.companyName || null;
      const businessName = customer?.business_name || customer?.name || null;
      const nameMismatch = !!(companyName && businessName && !companyNamesMatch(companyName, businessName));
      setForm(prev => {
        const cleared = kind === 'pl'
          ? { ...prev, pl_data: emptyPlData() }
          : { ...prev, balance_data: Object.fromEntries(BALANCE_KEYS.map(k => [k, ''])) };
        const merged = mergeParsedIntoForm(cleared, parseResult.parsed, kind);
        // Persist company name in the JSONB so it survives a page reload / re-edit.
        if (kind === 'pl') {
          if (companyName) merged.pl_data._companyName = companyName;
          merged.pl_data._fileName = file.name;
        } else {
          if (companyName) merged.balance_data._companyName = companyName;
          merged.balance_data._fileName = file.name;
        }
        return merged;
      });
      setPdfMeta(prev => ({ ...prev, [kind]: { fileName: file.name, companyName, mismatch: nameMismatch, detectedType: dbg.detectedType || null } }));
      if (dbg.detectedType === 'unknown' && (dbg.matched || 0) === 0) {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.notRecognized', { kind }), warnings: dbg.warnings, debug: dbg });
      } else if ((dbg.matched || 0) === 0) {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.parsedZero', { kind }), warnings: dbg.warnings, debug: dbg });
      } else {
        setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.parsed', { kind, matched: dbg.matched }), warnings: dbg.warnings, debug: dbg });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.uploadFailed') });
    } finally { setBusy(false); }
  };

  const preview = async (r) => {
    // Open blank tab synchronously (user-gesture context) to avoid popup blocking,
    // then navigate once the API resolves. No noopener — we need the reference to redirect.
    const win = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const d = await taxApi.adminPreviewReportAccess(auth, customerId);
      document.cookie = `${d.cookieName}=${d.cookieValue}; Path=/; Max-Age=${Math.floor(d.cookieMaxAgeMs/1000)}; SameSite=Lax`;
      if (win) win.location.href = d.viewUrl + '#report=' + encodeURIComponent(r.id) + '&ownerSend=1';
    } catch (e) {
      if (win) win.close();
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.previewFailed') });
    }
    finally { setBusy(false); }
  };

  const remove = async (r) => {
    if (!confirm(t('owner.customer.bookkeeping.confirm.delete', { period: r.period_label }))) return;
    setBusy(true);
    try { await taxApi.adminDeleteFinancialReport(auth, r.id); load(); }
    catch (e) { setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.deleteFailed') }); }
    finally { setBusy(false); }
  };

  if (!reports) return <section className="tax-card" style={{ marginTop: 24 }}><p>{t('owner.customer.bookkeeping.loading')}</p></section>;
  if (!bookkeepingActive && reports.length === 0) return null;

  return (
    <section className="tax-card" ref={sectionRef} style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('owner.customer.bookkeeping.heading')}</h3>
        {bookkeepingActive && !creating && !editingId && (
          <button type="button" className="tax-btn tax-btn--primary"
                  onClick={drawerMode ? () => onNewRequest?.() : startCreate}
                  disabled={busy}>
            {t('owner.customer.bookkeeping.newBtn')}
          </button>
        )}
      </div>

      {!bookkeepingActive && (
        <div style={{ background: '#fef3c7', borderLeft: '3px solid #b45309', color: '#78350f', padding: '10px 12px', borderRadius: 6, fontSize: 13, marginBottom: 8 }}>
          {t('owner.customer.bookkeeping.serviceInactive')}
        </div>
      )}
      {bookkeepingActive && !creating && !editingId && (
        <div style={{ background: '#f1f5f9', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#475569', marginBottom: 10 }}>
          {t('owner.customer.bookkeeping.taskFlowHint')}
        </div>
      )}

      {msg.text && (
        <div className={`tax-msg ${msg.kind === 'err' ? 'tax-msg--error' : msg.kind === 'warn' ? '' : 'tax-msg--success'}`}
             style={msg.kind === 'warn' ? { background: '#fef3c7', borderLeft: '3px solid #b45309', color: '#78350f', padding: '8px 12px' } : {}}>
          {msg.text}
          {msg.warnings?.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {msg.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {msg.debug && (msg.debug.characters != null || msg.debug.matched != null || msg.debug.unmatched != null || msg.debug.textSample) && (
            <details style={{ marginTop: 8, fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Debug info</summary>
              <div style={{ marginTop: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {msg.debug.characters != null && <div>Characters read: {msg.debug.characters}</div>}
                {msg.debug.matched != null && <div>Fields matched: {msg.debug.matched}</div>}
                {msg.debug.unmatched != null && <div>Fields unmatched: {msg.debug.unmatched}</div>}
                {msg.debug.markersFound != null && <div>Markers found: {msg.debug.markersFound}</div>}
                {msg.debug.detectedType && <div>Detected type: {msg.debug.detectedType}</div>}
                {msg.debug.textSample && (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ fontWeight: 600 }}>Text sample:</div>
                    <div style={{ background: 'rgba(0,0,0,0.06)', padding: '4px 6px', borderRadius: 4, marginTop: 2, maxHeight: 120, overflow: 'auto' }}>
                      {msg.debug.textSample}
                    </div>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}

      {(creating || editingId) && (() => {
        const currentReport = editingId ? (reports?.find(r => r.id === editingId) || null) : null;
        const rptStatus = currentReport?.status || 'draft';
        return (
          <ReportForm t={t} form={form} setForm={setForm} onSaveAndClose={saveAndClose} onCancel={cancel} busy={busy}
                      editing={!!editingId} onUploadPdf={uploadAndParsePdf}
                      onResetPl={resetPl} onResetBalance={resetBalance} pdfMeta={pdfMeta}
                      contactName={customer?.business_name || customer?.name || null}
                      reportStatus={rptStatus}
                      autoSaveStatus={autoSaveStatus} />
        );
      })()}

      {!creating && !editingId && (
        <>
          {reports.length === 0 ? (
            <p style={{ color: 'var(--tax-muted)', fontSize: 14, margin: '8px 0 0' }}>
              {t('owner.customer.bookkeeping.empty')}
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              {reports.map(r => (
                <ReportRow key={r.id} r={r} t={t} locale={locale}
                  onEdit={drawerMode ? () => onEditRequest?.(r.id) : () => startEdit(r)}
                  onPublish={() => publish(r)}
                  onSend={() => send(r, false)}
                  onResend={() => send(r, true)}
                  onPreview={() => preview(r)}
                  onDelete={() => remove(r)}
                  busy={busy}
                />
              ))}
            </div>
          )}
          {accessToken && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('owner.customer.bookkeeping.linkProvisioned', { date: fmtDate(accessToken.created_at, locale) })}
              {accessToken.last_used_at && <> {t('owner.customer.bookkeeping.lastAccess', { date: fmtDate(accessToken.last_used_at, locale) })}</>}
              {accessToken.revoked_at && <> <strong style={{ color: '#b91c1c' }}>{t('owner.customer.bookkeeping.revoked')}</strong></>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ReportRow({ r, t, locale, onEdit, onPublish, onSend, onResend, onPreview, onDelete, busy }) {
  const style = STATUS_STYLE[r.status] || STATUS_STYLE.draft;
  const statusLabel = t(`owner.customer.bookkeeping.status.${r.status}`);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '12px 14px', border: '1px solid var(--tax-border)', borderRadius: 8,
      marginBottom: 8, flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{r.period_label}</strong>
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: 999,
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
            background: style.bg, color: style.color,
          }}>{statusLabel}</span>
          {r.revision > 1 && <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>{t('owner.customer.bookkeeping.row.revision', { n: r.revision })}</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4 }}>
          {fmtDate(r.period_start, locale)} – {fmtDate(r.period_end, locale)}
          {r.published_at && <> · {t('owner.customer.bookkeeping.row.published', { date: fmtDate(r.published_at, locale) })}</>}
          {r.first_sent_at && (
            <> · {r.send_count > 1
              ? t('owner.customer.bookkeeping.row.sentMulti', { date: fmtDate(r.first_sent_at, locale), n: r.send_count })
              : t('owner.customer.bookkeeping.row.sentOnce', { date: fmtDate(r.first_sent_at, locale) })}</>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {r.status === 'draft'     && <button type="button" className="tax-btn tax-btn--primary" onClick={onPublish} disabled={busy}>{t('owner.customer.bookkeeping.action.publish')}</button>}
        {r.status === 'published' && <><button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>{t('owner.customer.bookkeeping.action.preview')}</button><button type="button" className="tax-btn tax-btn--primary" onClick={onSend} disabled={busy}>{t('owner.customer.bookkeeping.action.send')}</button></>}
        {r.status === 'sent'      && <><button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>{t('owner.customer.bookkeeping.action.preview')}</button><button type="button" className="tax-btn" onClick={onResend} disabled={busy}>{t('owner.customer.bookkeeping.action.resend')}</button></>}
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onEdit} disabled={busy}>{t('owner.customer.bookkeeping.action.edit')}</button>
        {r.status !== 'sent' && <button type="button" className="tax-btn tax-btn--ghost" onClick={onDelete} disabled={busy} style={{ color: '#b91c1c' }}>{t('owner.customer.bookkeeping.action.delete')}</button>}
      </div>
    </div>
  );
}

// ── Dynamic form ─────────────────────────────────────────────────────────

const inputStyle = { padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 13 };

function SaveButtons({ t, onSave, onCancel, busy, editing, sm }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <button type="button" className={`tax-btn tax-btn--ghost${sm ? ' tax-btn--sm' : ''}`} onClick={onCancel} disabled={busy}>
        {t('owner.customer.bookkeeping.action.cancel')}
      </button>
      <button type="button" className={`tax-btn tax-btn--primary${sm ? ' tax-btn--sm' : ''}`} onClick={onSave} disabled={busy}>
        {busy ? t('owner.customer.bookkeeping.action.saving') : t(editing ? 'owner.customer.bookkeeping.action.saveChanges' : 'owner.customer.bookkeeping.action.saveDraft')}
      </button>
    </div>
  );
}

function AutoSaveStatus({ status }) {
  const map = {
    pending: { text: '● Unsaved', color: '#94a3b8' },
    saving:  { text: '⟳ Saving…', color: '#2563eb' },
    saved:   { text: '✓ Saved',   color: '#16a34a' },
    error:   { text: '⚠ Save failed', color: '#dc2626' },
  };
  const s = map[status];
  if (!s) return null;
  return <span style={{ fontSize: 12, color: s.color, fontWeight: 500 }}>{s.text}</span>;
}

function ReportForm({ t, form, setForm, onSaveAndClose, onCancel, busy, editing, onUploadPdf, onResetPl, onResetBalance, pdfMeta, contactName, reportStatus, autoSaveStatus }) {
  const [plCollapsed, setPlCollapsed] = useState(false);
  const [balCollapsed, setBalCollapsed] = useState(false);
  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
  const setSection = (key, sec) => {
    setForm(prev => ({ ...prev, pl_data: { ...prev.pl_data, sections: { ...prev.pl_data.sections, [key]: sec } } }));
  };
  const totals = computeTotals(form.pl_data);
  const plReadOnly = !!form.pl_data._companyName;
  const balReadOnly = !!form.balance_data._companyName;

  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 14, marginTop: 8, background: '#fafafa', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <h4 style={{ margin: 0 }}>{t(editing ? 'owner.customer.bookkeeping.form.heading.edit' : 'owner.customer.bookkeeping.form.heading.create')}</h4>
        <AutoSaveStatus status={autoSaveStatus} />
      </div>

      {(reportStatus === 'published' || reportStatus === 'sent') && (
        <div style={{ padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #d97706', borderRadius: 6, fontSize: 13, color: '#78350f', marginBottom: 12 }}>
          {t('owner.customer.bookkeeping.form.redraftWarning')}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Field label={t('owner.customer.bookkeeping.form.period')}>
          <input type="text" value={form.period_label} onChange={e => set('period_label', e.target.value)}
                 placeholder={t('owner.customer.bookkeeping.form.periodPlaceholder')} style={inputStyle} />
        </Field>
        <Field label={t('owner.customer.bookkeeping.form.start')}>
          <input type="date" value={form.period_start} onChange={e => set('period_start', e.target.value)} style={inputStyle} />
        </Field>
        <Field label={t('owner.customer.bookkeeping.form.end')}>
          <input type="date" value={form.period_end} onChange={e => set('period_end', e.target.value)} style={inputStyle} />
        </Field>
        <Field label={t('owner.customer.bookkeeping.form.cadence')}>
          <select value={form.cadence} onChange={e => set('cadence', e.target.value)} style={inputStyle}>
            <option value="semi_annual">{t('owner.customer.bookkeeping.form.cadence.semi_annual')}</option>
            <option value="annual">{t('owner.customer.bookkeeping.form.cadence.annual')}</option>
            <option value="quarterly">{t('owner.customer.bookkeeping.form.cadence.quarterly')}</option>
            <option value="custom">{t('owner.customer.bookkeeping.form.cadence.custom')}</option>
          </select>
        </Field>
      </div>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.pdfs')}>
        {editing ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.pl')}      slotKind="pl"      onPick={f => onUploadPdf && onUploadPdf('pl', f)} onReset={onResetPl} busy={busy} t={t} fileName={pdfMeta?.pl?.fileName} companyName={pdfMeta?.pl?.companyName} mismatch={pdfMeta?.pl?.mismatch} contactName={contactName} detectedType={pdfMeta?.pl?.detectedType} />
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.balance')} slotKind="balance" onPick={f => onUploadPdf && onUploadPdf('balance', f)} onReset={onResetBalance} busy={busy} t={t} fileName={pdfMeta?.balance?.fileName} companyName={pdfMeta?.balance?.companyName} mismatch={pdfMeta?.balance?.mismatch} contactName={contactName} detectedType={pdfMeta?.balance?.detectedType} />
          </div>
        ) : (
          <div style={{ padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13, color: '#475569' }}>
            {t('owner.customer.bookkeeping.pdf.saveFirstHint')}
          </div>
        )}
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.pl')}
                 collapsed={plCollapsed} onToggle={() => setPlCollapsed(c => !c)}
                 action={plReadOnly
                   ? <span style={{ fontSize: 11, color: '#0f766e', fontWeight: 600, background: '#ccfbf1', padding: '2px 8px', borderRadius: 4 }}>📊 {t('owner.customer.bookkeeping.form.xlsxReadOnly')}</span>
                   : <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                             onClick={e => { e.stopPropagation(); onResetPl(); }} disabled={busy}
                             style={{ fontSize: 11, color: '#b91c1c' }}>
                       {t('owner.customer.bookkeeping.action.resetPl')}
                     </button>
                 }>
        {SECTION_KEYS.map(sectionKey => (
          <SectionEditor key={sectionKey} t={t}
            sectionKey={sectionKey}
            title={t(SECTION_TITLE_KEY[sectionKey])}
            section={form.pl_data.sections[sectionKey]}
            onChange={s => setSection(sectionKey, s)}
            readOnly={plReadOnly}
          />
        ))}
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.balance')}
                 collapsed={balCollapsed} onToggle={() => setBalCollapsed(c => !c)}
                 action={balReadOnly
                   ? <span style={{ fontSize: 11, color: '#0f766e', fontWeight: 600, background: '#ccfbf1', padding: '2px 8px', borderRadius: 4 }}>📊 {t('owner.customer.bookkeeping.form.xlsxReadOnly')}</span>
                   : <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                             onClick={e => { e.stopPropagation(); onResetBalance(); }} disabled={busy}
                             style={{ fontSize: 11, color: '#b91c1c' }}>
                       {t('owner.customer.bookkeeping.action.resetBalance')}
                     </button>
                 }>
        <NumericGrid>
          {BALANCE_KEYS.map(k => (
            <Field key={k} label={t(`owner.customer.bookkeeping.balance.${k}`)}>
              {balReadOnly
                ? <div style={{ padding: '8px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 14, fontVariantNumeric: 'tabular-nums', color: '#0f172a' }}>
                    {form.balance_data[k] != null && form.balance_data[k] !== '' ? `$${Number(form.balance_data[k]).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </div>
                : <NumericInput value={form.balance_data[k]} onChange={v => setForm(prev => ({ ...prev, balance_data: { ...prev.balance_data, [k]: v } }))} />
              }
            </Field>
          ))}
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.notes')}>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
                  placeholder={t('owner.customer.bookkeeping.form.field.notes.placeholder')}
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
      </FormGroup>

      <TotalsBar t={t} plData={form.pl_data} computedTotals={totals} />

      <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #b45309', borderRadius: 6, fontSize: 13, color: '#78350f' }}>
        {t('owner.customer.bookkeeping.form.verifyBanner')}
      </div>

      {/* Sticky close bar — workflow actions (Publish/Preview/Send) live on the summary */}
      <div style={{
        position: 'sticky', bottom: 0,
        background: '#f8fafc',
        borderTop: '1px solid var(--tax-border)',
        padding: '12px 0 0',
        marginTop: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <AutoSaveStatus status={autoSaveStatus} />
        <button type="button" className="tax-btn tax-btn--ghost"
                onClick={onSaveAndClose || onCancel} disabled={busy}>
          {autoSaveStatus === 'saving' ? t('owner.customer.bookkeeping.action.saving') : 'Close'}
        </button>
      </div>
    </div>
  );
}

function SectionEditor({ t, sectionKey, title, section, onChange, readOnly }) {
  const [collapsed, setCollapsed] = useState(false);
  const setGroup = (idx, g) => onChange({ ...section, groups: section.groups.map((x, i) => i === idx ? g : x) });
  const addGroup = () => onChange({ ...section, groups: [...section.groups, { name: '', total: null, items: [] }] });
  const removeGroup = (idx) => onChange({ ...section, groups: section.groups.filter((_, i) => i !== idx) });
  const sectionTotal = section.groups.reduce((s, g) =>
    s + (Number(g.total) || (g.items || []).reduce((a, i) => a + num(i.amount), 0)), 0);
  const sectionHasMismatch = section.groups.some(g => {
    const itemSum = (g.items || []).reduce((a, i) => a + num(i.amount), 0);
    const declared = g.total != null && g.total !== '' ? num(g.total) : null;
    return declared != null && (g.items || []).length > 0 && Math.abs(declared - itemSum) > 0.5;
  });
  // Show badge when any group has a declared total (summary-only groups count as valid)
  const hasAnyTotal = section.groups.some(g => g.total != null && g.total !== '');
  const validationBadge = readOnly && hasAnyTotal
    ? sectionHasMismatch
      ? <span style={{ fontSize: 11, color: '#b91c1c', fontWeight: 700, background: '#fee2e2', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>✗ {t('owner.customer.bookkeeping.section.mismatch')}</span>
      : <span style={{ fontSize: 11, color: '#15803d', fontWeight: 700, background: '#dcfce7', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>✓ {t('owner.customer.bookkeeping.section.valid')}</span>
    : null;
  return (
    <div style={{ marginTop: 10, border: `1px solid ${sectionHasMismatch ? '#ef4444' : '#e2e8f0'}`, borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '9px 12px', cursor: 'pointer', userSelect: 'none',
          background: sectionHasMismatch ? '#fee2e2' : '#fafafa',
          borderBottom: collapsed ? 'none' : `1px solid ${sectionHasMismatch ? '#ef4444' : '#e2e8f0'}` }}
        onClick={() => setCollapsed(c => !c)}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 14, color: '#64748b', lineHeight: 1, width: 14, textAlign: 'center' }}>{collapsed ? '▶' : '▼'}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: '.04em' }}>{title}</span>
          {collapsed && validationBadge}
          {!readOnly && sectionHasMismatch && collapsed && <span style={{ color: '#b91c1c', fontSize: 14, lineHeight: 1 }}>✗</span>}
        </div>
        <span style={{ fontSize: 13, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(sectionTotal)}</span>
      </div>
      {!collapsed && (
        <div style={{ padding: 12 }}>
          {!collapsed && validationBadge && <div style={{ marginBottom: 8 }}>{validationBadge}</div>}
          {section.groups.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--tax-muted)', fontStyle: 'italic', padding: '4px 0' }}>
              {t('owner.customer.bookkeeping.section.empty')}
            </div>
          )}
          {section.groups.map((g, idx) => (
            <GroupEditor key={idx} t={t} group={g}
                         onChange={ng => setGroup(idx, ng)}
                         onDelete={() => removeGroup(idx)}
                         readOnly={readOnly} />
          ))}
          {!readOnly && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addGroup}
                    style={{ marginTop: 6, fontSize: 12 }}>
              + {t('owner.customer.bookkeeping.section.addGroup')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function GroupEditor({ t, group, onChange, onDelete, readOnly }) {
  const [collapsed, setCollapsed] = useState(false);
  const setItem = (idx, item) => onChange({ ...group, items: group.items.map((x, i) => i === idx ? item : x) });
  const addItem = () => onChange({ ...group, items: [...group.items, { name: '', amount: '' }] });
  const removeItem = (idx) => onChange({ ...group, items: group.items.filter((_, i) => i !== idx) });
  const itemSum = group.items.reduce((s, i) => s + num(i.amount), 0);
  const declaredTotal = group.total != null && group.total !== '' ? num(group.total) : null;
  const mismatch = declaredTotal != null && group.items.length > 0 && Math.abs(declaredTotal - itemSum) > 0.5;
  // No items = summary-only group; treat declared total as correct → green
  const match = !mismatch && declaredTotal != null;
  const borderColor = mismatch ? '#ef4444' : match ? '#16a34a' : '#e2e8f0';
  const headerBg  = mismatch ? '#fee2e2' : match ? '#f0fdf4' : '#f8fafc';
  return (
    <div style={{ marginTop: 8, border: `1px solid ${borderColor}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '7px 10px',
                    background: headerBg,
                    borderBottom: collapsed ? 'none' : `1px solid ${borderColor}` }}>
        <button type="button" onClick={() => setCollapsed(c => !c)}
                style={{ background: 'none', border: 0, cursor: 'pointer', padding: '0 2px',
                         color: '#64748b', fontSize: 13, lineHeight: 1, flexShrink: 0, width: 16 }}>
          {collapsed ? '▶' : '▼'}
        </button>
        {readOnly
          ? <span style={{ flex: 1, fontWeight: 600, fontSize: 13, color: '#0f172a', padding: '4px 0' }}>{group.name || '—'}</span>
          : <input type="text" value={group.name} onChange={e => onChange({ ...group, name: e.target.value })}
                   placeholder={t('owner.customer.bookkeeping.group.namePlaceholder')}
                   style={{ ...inputStyle, flex: 1, fontWeight: 600, background: 'transparent', border: '1px solid transparent' }}
                   onFocus={e => { e.target.style.border = `1px solid ${mismatch ? '#ef4444' : 'var(--tax-border)'}`; e.target.style.background = '#fff'; }}
                   onBlur={e => { e.target.style.border = '1px solid transparent'; e.target.style.background = 'transparent'; }} />
        }
        {readOnly
          ? <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: '#0f172a', minWidth: 90, textAlign: 'right' }}>{fmtMoney(declaredTotal ?? itemSum)}</span>
          : <MoneyInput value={group.total ?? ''}
                        onChange={v => onChange({ ...group, total: v })}
                        placeholder={fmtInputNum(itemSum) || '0.00'}
                        title={t('owner.customer.bookkeeping.group.totalHint')}
                        width={110}
                        borderColor={mismatch ? '#ef4444' : undefined}
                        extraInputStyle={{ fontWeight: 700 }} />
        }
        {match && <span style={{ color: '#16a34a', fontSize: 13, flexShrink: 0, lineHeight: 1 }}>✓</span>}
        {mismatch && (
          <span title={t('owner.customer.bookkeeping.group.mismatch', { sum: fmtMoney(itemSum), total: fmtMoney(declaredTotal) })}
                style={{ color: '#b91c1c', fontSize: 15, flexShrink: 0, lineHeight: 1 }}>✗</span>
        )}
        {!readOnly && (
          <button type="button" onClick={onDelete} title={t('owner.customer.bookkeeping.action.delete')}
                  style={{ background: 'transparent', border: 0, color: '#b91c1c', cursor: 'pointer', fontSize: 18, padding: '0 2px', flexShrink: 0 }}>×</button>
        )}
      </div>
      {!collapsed && (
        <div style={{ padding: '8px 10px', background: '#fff' }}>
          {mismatch && (
            <div style={{ marginBottom: 6, padding: '5px 8px', background: '#fee2e2', borderRadius: 4, fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>
              ✗ {t('owner.customer.bookkeeping.group.mismatch', { sum: fmtMoney(itemSum), total: fmtMoney(declaredTotal) })}
            </div>
          )}
          {group.items.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {group.items.map((it, idx) => (
                <ItemRow key={idx} t={t} item={it} onChange={i => setItem(idx, i)} onDelete={() => removeItem(idx)} readOnly={readOnly} />
              ))}
            </div>
          )}
          {!readOnly && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addItem}
                    style={{ marginTop: 6, fontSize: 11 }}>
              + {t('owner.customer.bookkeeping.group.addItem')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({ t, item, onChange, onDelete, readOnly }) {
  if (readOnly) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
        <span style={{ flex: 1, fontSize: 13, color: '#374151' }}>{item.name || '—'}</span>
        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#475569', minWidth: 90, textAlign: 'right' }}>{fmtMoney(Number(item.amount) || 0)}</span>
        {item.rollup && (
          <span title={t('owner.customer.bookkeeping.item.rollup')}
                style={{ fontSize: 10, fontWeight: 700, color: '#64748b', padding: '2px 6px', background: '#f1f5f9', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            ∑
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="text" value={item.name} onChange={e => onChange({ ...item, name: e.target.value })}
             placeholder={t('owner.customer.bookkeeping.item.namePlaceholder')}
             style={{ ...inputStyle, flex: 1 }} />
      <MoneyInput value={item.amount ?? ''}
                  onChange={v => onChange({ ...item, amount: v })}
                  width={110} />
      {item.rollup && (
        <span title={t('owner.customer.bookkeeping.item.rollup')}
              style={{ fontSize: 10, fontWeight: 700, color: '#64748b', padding: '2px 6px', background: '#f1f5f9', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>
          ∑
        </span>
      )}
      <button type="button" onClick={onDelete}
              style={{ background: 'transparent', border: 0, color: 'var(--tax-muted)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}
function NumericGrid({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>{children}</div>;
}
// Wraps a numeric input with a left-aligned $ adornment.
// `inputStyle` props go on the inner <input>; width/borderColor are on the wrapper.
function MoneyInput({ value, onChange, placeholder, width, borderColor, extraInputStyle, disabled, title }) {
  const [focused, setFocused] = useState(false);
  const raw = (value === '' || value == null) ? '' : String(value).replace(/,/g, '');
  const displayValue = focused ? raw : fmtInputNum(raw) || raw;
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center',
                  width: width || '100%', flexShrink: 0,
                  border: `1px solid ${borderColor || 'var(--tax-border)'}`, borderRadius: 6,
                  background: disabled ? '#f8fafc' : '#fff' }}>
      <span style={{ position: 'absolute', left: 8, color: '#94a3b8', fontSize: 13,
                     pointerEvents: 'none', userSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>$</span>
      <input type="text" inputMode="decimal" disabled={disabled} title={title}
             value={displayValue}
             onFocus={() => setFocused(true)}
             onBlur={() => setFocused(false)}
             onChange={e => onChange(e.target.value.replace(/,/g, ''))}
             placeholder={placeholder || '0.00'}
             style={{ width: '100%', padding: '6px 8px 6px 20px', border: 'none', borderRadius: 6,
                      fontSize: 13, background: 'transparent', outline: 'none',
                      fontVariantNumeric: 'tabular-nums', textAlign: 'right', ...extraInputStyle }} />
    </div>
  );
}
function NumericInput({ value, onChange }) {
  return <MoneyInput value={value} onChange={onChange} />;
}
function FormGroup({ title, children, action, collapsed, onToggle }) {
  if (onToggle !== undefined) {
    return (
      <div style={{ marginTop: 14, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '9px 12px', background: '#f8fafc', cursor: 'pointer', userSelect: 'none',
            borderBottom: collapsed ? 'none' : '1px solid #e2e8f0' }}
          onClick={onToggle}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: '#64748b', lineHeight: 1, width: 14, textAlign: 'center' }}>{collapsed ? '▶' : '▼'}</span>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#475569' }}>{title}</span>
          </div>
          {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
        </div>
        {!collapsed && <div style={{ padding: 12 }}>{children}</div>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#475569' }}>
          {title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
function TotalsBar({ t, plData, computedTotals }) {
  // Prefer xlsx-parsed QB totals when available — they match what the customer
  // will see in the dashboard and what QB actually reported.
  const stored = plData?.totals;
  const isXlsx = !!plData?._companyName;
  const display = (stored && isXlsx) ? stored : computedTotals;

  // Validation: does every group's declared total match its item sum?
  const groupMismatches = [];
  for (const [secKey, sec] of Object.entries(plData?.sections || {})) {
    for (const g of (sec?.groups || [])) {
      const itemSum = (g.items || []).reduce((s, i) => s + num(i.amount), 0);
      const declared = g.total != null && g.total !== '' ? num(g.total) : null;
      if (declared != null && (g.items || []).length > 0 && Math.abs(declared - itemSum) > 0.5) {
        groupMismatches.push(g.name);
      }
    }
  }
  const allMatch = groupMismatches.length === 0;

  // When xlsx totals are used, check if computed net income differs from stored
  // (e.g. Sales Tax Collected/Remitted treatment). Show a note when they diverge.
  const netDiffers = isXlsx && stored && Math.abs((stored.net_income || 0) - (computedTotals.net_income || 0)) > 0.5;

  const statusColor = allMatch ? '#15803d' : '#b91c1c';
  const statusBg    = allMatch ? '#dcfce7'  : '#fee2e2';
  const statusIcon  = allMatch ? '✓' : '✗';
  const statusText  = allMatch
    ? t('owner.customer.bookkeeping.form.totals.valid')
    : t('owner.customer.bookkeeping.form.totals.mismatch', { count: groupMismatches.length });

  return (
    <div style={{ marginTop: 14, borderRadius: 6, border: `1px solid ${allMatch ? '#bbf7d0' : '#fecaca'}`, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px',
                    background: statusBg, borderBottom: `1px solid ${allMatch ? '#bbf7d0' : '#fecaca'}` }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>{statusIcon} {statusText}</span>
        {isXlsx && <span style={{ fontSize: 11, color: '#64748b' }}>{t('owner.customer.bookkeeping.form.totals.xlsxSource')}</span>}
      </div>
      <div style={{ padding: '10px 12px', background: '#f8fafc' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Total label={t('owner.customer.bookkeeping.form.totals.revenue')}     value={display.total_income} />
          <Total label={t('owner.customer.bookkeeping.form.totals.cogs')}        value={display.total_cogs} />
          <Total label={t('owner.customer.bookkeeping.form.totals.grossProfit')} value={display.gross_profit} />
          <Total label={t('owner.customer.bookkeeping.form.totals.opex')}        value={display.total_expense} />
          <Total label={t('owner.customer.bookkeeping.form.totals.netIncome')}   value={display.net_income} bold />
        </div>
        {netDiffers && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#64748b', borderTop: '1px solid #e2e8f0', paddingTop: 6 }}>
            {t('owner.customer.bookkeeping.form.totals.netIncomeNote',
              { qb: fmtMoney(stored.net_income), computed: fmtMoney(computedTotals.net_income) })}
          </div>
        )}
      </div>
    </div>
  );
}
function Total({ label, value, bold }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--tax-muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontWeight: bold ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(value)}</div>
    </div>
  );
}

function PdfDrop({ label, slotKind, onPick, onReset, busy, t, fileName, companyName, mismatch, contactName, detectedType }) {
  const inputId = useRef(`pdf-drop-${label.replace(/\s+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`).current;
  const showCard = fileName || contactName;
  // Detected type label + whether it matches the slot.
  const typeLabel = detectedType === 'pl' ? t('owner.customer.bookkeeping.pdf.pl')
    : detectedType === 'balance' ? t('owner.customer.bookkeeping.pdf.balance')
    : null;
  const typeMatch = detectedType && slotKind && (
    (slotKind === 'pl' && detectedType === 'pl') ||
    (slotKind === 'balance' && detectedType === 'balance')
  );
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <label htmlFor={inputId} style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>{label}</label>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{t('owner.customer.bookkeeping.pdf.acceptHint')}</span>
      </div>

      {showCard && (
        <div style={{ padding: '8px 10px', background: mismatch ? '#fef9ec' : '#f8fafc', border: `1px solid ${mismatch ? '#d97706' : '#e2e8f0'}`, borderRadius: 6, fontSize: 12 }}>
          {fileName && (
            <div style={{ fontWeight: 700, color: '#0f172a', wordBreak: 'break-all', marginBottom: 4 }}>{fileName}</div>
          )}
          <div style={{ display: 'grid', gap: 2 }}>
            {typeLabel && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 2 }}>
                <span style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{t('owner.customer.bookkeeping.pdf.detectedType')}</span>
                <span style={{ fontWeight: 600, color: typeMatch ? '#15803d' : '#b45309' }}>
                  {typeMatch ? '✓' : '⚠'} {typeLabel}
                </span>
              </div>
            )}
            {companyName && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{t('owner.customer.bookkeeping.pdf.mismatch.pdf')}</span>
                <span style={{ fontWeight: 700, color: mismatch ? '#b45309' : '#0f172a' }}>{companyName}</span>
              </div>
            )}
            {contactName && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', flexShrink: 0 }}>{t('owner.customer.bookkeeping.pdf.mismatch.contact')}</span>
                <span style={{ fontWeight: 600, color: mismatch ? '#b45309' : '#475569' }}>{contactName}</span>
              </div>
            )}
            {mismatch && (
              <div style={{ marginTop: 4, color: '#b45309', fontWeight: 700, fontSize: 11 }}>
                ⚠ {t('owner.customer.bookkeeping.pdf.mismatch.title')}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input id={inputId} type="file" accept=".xlsx" disabled={busy}
               onChange={e => {
                 const f = e.target.files && e.target.files[0];
                 if (f) onPick(f);
                 e.target.value = '';
               }}
               style={{ flex: 1, minWidth: 0, padding: '8px', border: '1px dashed var(--tax-border)', borderRadius: 6, background: '#fff', fontSize: 13 }} />
        {onReset && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={onReset} disabled={busy}
                  style={{ fontSize: 11, color: '#b91c1c', whiteSpace: 'nowrap' }}>
            {t('owner.customer.bookkeeping.action.reset')}
          </button>
        )}
      </div>
    </div>
  );
}
