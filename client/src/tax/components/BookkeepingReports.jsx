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
    return { sections, totals: { ...(pl.totals || {}) } };
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
    totals: computeTotals(f.pl_data),
  };
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

export default function BookkeepingReportsSection({ auth, customerId, customer, refreshNonce }) {
  const { t, locale } = useT();
  const [reports, setReports] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [bookkeepingActive, setBookkeepingActive] = useState(null);
  const [editingId, setEditingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: '', text: '' });

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

  const startCreate = () => {
    setForm(emptyForm()); setCreating(true); setEditingId(''); setMsg({ kind: '', text: '' });
  };
  const startEdit = (r) => {
    setBusy(true);
    taxApi.adminGetFinancialReport(auth, r.id)
      .then(d => { setForm(reportToForm(d.report)); setEditingId(r.id); setCreating(false); setMsg({ kind: '', text: '' }); })
      .catch(e => setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.loadFailed') }))
      .finally(() => setBusy(false));
  };
  const cancel = () => { setCreating(false); setEditingId(''); setForm(emptyForm()); setMsg({ kind: '', text: '' }); };

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
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.saveFailed') });
    } finally { setBusy(false); }
  };

  const publish = async (r) => {
    if (!confirm(t('owner.customer.bookkeeping.confirm.publish', { period: r.period_label }))) return;
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
        setMsg({ kind: 'ok', text: t(isResend ? 'owner.customer.bookkeeping.msg.sendOk.resend' : 'owner.customer.bookkeeping.msg.sendOk.send') });
      } else {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.sendSkipped', { reason: d.reason || '?', url: d.viewUrl || '' }) });
      }
      load();
    } catch (e) { setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.sendFailed') }); }
    finally { setBusy(false); }
  };

  const uploadAndParsePdf = async (kind, file) => {
    if (!editingId) { setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.saveDraftFirst') }); return; }
    if (!file) return;
    setBusy(true); setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.uploading', { kind }) });
    try {
      const sig = await taxApi.adminFinancialReportUploadUrl(auth, editingId, kind);
      const putResp = await fetch(sig.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
        body: file,
      });
      if (!putResp.ok) throw new Error(`Upload failed (${putResp.status}).`);
      setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.parsing') });
      const parseResult = await taxApi.adminFinancialReportParse(auth, editingId, kind);
      const dbg = parseResult.parsed?.debug || {};
      if (dbg.typeMismatch) {
        const expected = kind === 'balance' ? t('owner.customer.bookkeeping.pdf.balance') : t('owner.customer.bookkeeping.pdf.pl');
        const got = dbg.detectedType === 'pl' ? t('owner.customer.bookkeeping.pdf.pl')
          : dbg.detectedType === 'balance' ? t('owner.customer.bookkeeping.pdf.balance')
          : t('owner.customer.bookkeeping.pdf.unknown');
        setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.wrongType', { expected, got }) });
        return;
      }
      if (dbg.error === 'pdf_no_text_layer') { setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.noTextLayer') }); return; }
      if (dbg.error) { setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.parseError', { error: dbg.error }) }); return; }
      setForm(prev => mergeParsedIntoForm(prev, parseResult.parsed, kind));
      if ((dbg.matched || 0) === 0) {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.parsedZero', { kind }) });
      } else {
        setMsg({ kind: 'ok', text: t('owner.customer.bookkeeping.msg.parsed', { kind, matched: dbg.matched }) });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.uploadFailed') });
    } finally { setBusy(false); }
  };

  const preview = async (r) => {
    setBusy(true);
    try {
      const d = await taxApi.adminPreviewReportAccess(auth, customerId);
      document.cookie = `${d.cookieName}=${d.cookieValue}; Path=/; Max-Age=${Math.floor(d.cookieMaxAgeMs/1000)}; SameSite=Lax`;
      window.open(d.viewUrl + '#report=' + encodeURIComponent(r.id), '_blank', 'noopener');
    } catch (e) { setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.previewFailed') }); }
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
    <section className="tax-card" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>{t('owner.customer.bookkeeping.heading')}</h3>
        {bookkeepingActive && !creating && !editingId && (
          <button type="button" className="tax-btn tax-btn--primary" onClick={startCreate} disabled={busy}>
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
        </div>
      )}

      {(creating || editingId) && (
        <ReportForm t={t} form={form} setForm={setForm} onSave={save} onCancel={cancel} busy={busy}
                    editing={!!editingId} onUploadPdf={uploadAndParsePdf} />
      )}

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
                  onEdit={() => startEdit(r)}
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

function ReportForm({ t, form, setForm, onSave, onCancel, busy, editing, onUploadPdf }) {
  const set = (k, v) => setForm({ ...form, [k]: v });
  const setSection = (key, sec) => {
    setForm({ ...form, pl_data: { ...form.pl_data, sections: { ...form.pl_data.sections, [key]: sec } } });
  };
  const totals = computeTotals(form.pl_data);

  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 14, marginTop: 8, background: '#fafafa' }}>
      <h4 style={{ margin: '0 0 12px' }}>{t(editing ? 'owner.customer.bookkeeping.form.heading.edit' : 'owner.customer.bookkeeping.form.heading.create')}</h4>

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
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.pl')}      onPick={f => onUploadPdf && onUploadPdf('pl', f)} busy={busy} />
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.balance')} onPick={f => onUploadPdf && onUploadPdf('balance', f)} busy={busy} />
          </div>
        ) : (
          <div style={{ padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13, color: '#475569' }}>
            {t('owner.customer.bookkeeping.pdf.saveFirstHint')}
          </div>
        )}
      </FormGroup>

      {SECTION_KEYS.map(sectionKey => (
        <SectionEditor key={sectionKey} t={t}
          sectionKey={sectionKey}
          title={t(SECTION_TITLE_KEY[sectionKey])}
          section={form.pl_data.sections[sectionKey]}
          onChange={s => setSection(sectionKey, s)}
        />
      ))}

      <FormGroup title={t('owner.customer.bookkeeping.form.group.balance')}>
        <NumericGrid>
          {BALANCE_KEYS.map(k => (
            <Field key={k} label={t(`owner.customer.bookkeeping.balance.${k}`)}>
              <NumericInput value={form.balance_data[k]} onChange={v => setForm({ ...form, balance_data: { ...form.balance_data, [k]: v } })} />
            </Field>
          ))}
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.notes')}>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
                  placeholder={t('owner.customer.bookkeeping.form.field.notes.placeholder')}
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
      </FormGroup>

      <TotalsBar t={t} totals={totals} />

      <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #b45309', borderRadius: 6, fontSize: 13, color: '#78350f' }}>
        {t('owner.customer.bookkeeping.form.verifyBanner')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onCancel} disabled={busy}>{t('owner.customer.bookkeeping.action.cancel')}</button>
        <button type="button" className="tax-btn tax-btn--primary" onClick={onSave} disabled={busy}>
          {busy ? t('owner.customer.bookkeeping.action.saving') : t(editing ? 'owner.customer.bookkeeping.action.saveChanges' : 'owner.customer.bookkeeping.action.saveDraft')}
        </button>
      </div>
    </div>
  );
}

function SectionEditor({ t, sectionKey, title, section, onChange }) {
  const setGroup = (idx, g) => onChange({ ...section, groups: section.groups.map((x, i) => i === idx ? g : x) });
  const addGroup = () => onChange({ ...section, groups: [...section.groups, { name: '', total: null, items: [] }] });
  const removeGroup = (idx) => onChange({ ...section, groups: section.groups.filter((_, i) => i !== idx) });
  const sectionTotal = section.groups.reduce((s, g) =>
    s + (Number(g.total) || (g.items || []).reduce((a, i) => a + num(i.amount), 0)), 0);
  return (
    <div style={{ marginTop: 14, border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#fff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: '.04em' }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMoney(sectionTotal)}
        </div>
      </div>
      {section.groups.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', fontStyle: 'italic', padding: '6px 0' }}>
          {t('owner.customer.bookkeeping.section.empty')}
        </div>
      )}
      {section.groups.map((g, idx) => (
        <GroupEditor key={idx} t={t} group={g}
                     onChange={ng => setGroup(idx, ng)}
                     onDelete={() => removeGroup(idx)} />
      ))}
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addGroup}
              style={{ marginTop: 6, fontSize: 12 }}>
        + {t('owner.customer.bookkeeping.section.addGroup')}
      </button>
    </div>
  );
}

function GroupEditor({ t, group, onChange, onDelete }) {
  const setItem = (idx, item) => onChange({ ...group, items: group.items.map((x, i) => i === idx ? item : x) });
  const addItem = () => onChange({ ...group, items: [...group.items, { name: '', amount: '' }] });
  const removeItem = (idx) => onChange({ ...group, items: group.items.filter((_, i) => i !== idx) });
  const itemSum = group.items.reduce((s, i) => s + num(i.amount), 0);
  const declaredTotal = group.total != null && group.total !== '' ? num(group.total) : null;
  const mismatch = declaredTotal != null && Math.abs(declaredTotal - itemSum) > 0.5;
  return (
    <div style={{ marginTop: 8, padding: 10, border: '1px solid #e2e8f0', borderRadius: 6, background: '#fafafa' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="text" value={group.name} onChange={e => onChange({ ...group, name: e.target.value })}
               placeholder={t('owner.customer.bookkeeping.group.namePlaceholder')}
               style={{ ...inputStyle, flex: 1, fontWeight: 600 }} />
        <input type="number" inputMode="decimal" step="0.01"
               value={group.total ?? ''}
               onChange={e => onChange({ ...group, total: e.target.value })}
               placeholder={String(itemSum.toFixed(2))}
               title={t('owner.customer.bookkeeping.group.totalHint')}
               style={{ ...inputStyle, width: 110, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }} />
        <button type="button" onClick={onDelete} title={t('owner.customer.bookkeeping.action.delete')}
                style={{ background: 'transparent', border: 0, color: '#b91c1c', cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>×</button>
      </div>
      {mismatch && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#b45309' }}>
          {t('owner.customer.bookkeeping.group.mismatch', { sum: fmtMoney(itemSum), total: fmtMoney(declaredTotal) })}
        </div>
      )}
      {group.items.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {group.items.map((it, idx) => (
            <ItemRow key={idx} t={t} item={it} onChange={i => setItem(idx, i)} onDelete={() => removeItem(idx)} />
          ))}
        </div>
      )}
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addItem}
              style={{ marginTop: 6, fontSize: 11 }}>
        + {t('owner.customer.bookkeeping.group.addItem')}
      </button>
    </div>
  );
}

function ItemRow({ t, item, onChange, onDelete }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="text" value={item.name} onChange={e => onChange({ ...item, name: e.target.value })}
             placeholder={t('owner.customer.bookkeeping.item.namePlaceholder')}
             style={{ ...inputStyle, flex: 1 }} />
      <input type="number" inputMode="decimal" step="0.01"
             value={item.amount ?? ''}
             onChange={e => onChange({ ...item, amount: e.target.value })}
             placeholder="0.00"
             style={{ ...inputStyle, width: 110, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }} />
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
function NumericInput({ value, onChange }) {
  return (
    <input type="number" inputMode="decimal" step="0.01"
           value={value} onChange={e => onChange(e.target.value)} placeholder="0.00"
           style={{ ...inputStyle, fontVariantNumeric: 'tabular-nums' }} />
  );
}
function FormGroup({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#475569', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}
function TotalsBar({ t, totals }) {
  return (
    <div style={{ marginTop: 14, padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <Total label={t('owner.customer.bookkeeping.form.totals.revenue')}     value={totals.total_income} />
        <Total label={t('owner.customer.bookkeeping.form.totals.cogs')}        value={totals.total_cogs} />
        <Total label={t('owner.customer.bookkeeping.form.totals.grossProfit')} value={totals.gross_profit} />
        <Total label={t('owner.customer.bookkeeping.form.totals.opex')}        value={totals.total_expense} />
        <Total label={t('owner.customer.bookkeeping.form.totals.netIncome')}   value={totals.net_income} bold />
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

function PdfDrop({ label, onPick, busy }) {
  const inputId = `pdf-drop-${label.replace(/\s+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`;
  // After every pick we clear the input.value so the slot resets to
  // "No file chosen" — owner sees a clean dropzone and can re-upload
  // the same file again if a parse needs a redo. The status banner
  // above the form ("Parsed N fields …") is the confirmation that
  // the upload worked.
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={inputId} style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>{label}</label>
      <input id={inputId} type="file" accept="application/pdf,.pdf" disabled={busy}
             onChange={e => {
               const f = e.target.files && e.target.files[0];
               if (f) onPick(f);
               e.target.value = '';
             }}
             style={{ padding: '8px', border: '1px dashed var(--tax-border)', borderRadius: 6, background: '#fff', fontSize: 13 }} />
    </div>
  );
}
