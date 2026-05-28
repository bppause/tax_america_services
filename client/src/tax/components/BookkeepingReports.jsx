// Phase 4n.70: bookkeeping financial reports section, rendered inside
// the owner's customer-detail page. List of existing reports + an
// inline form to capture a new one. Owner enters the structured P&L
// + balance-sheet subtotals manually — PDF auto-parse is deferred to
// a follow-up. Publish and Send are explicit, separate actions.
//
// All labels run through useT() so the owner/employee sees the UI in
// whichever language they've picked. The customer-facing dashboard
// (TaxReport.jsx) is independently bilingual — that one defaults to
// the customer's locale and shouldn't follow the owner's preference.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';

// Keys only — labels come from the i18n bundles at render time.
const REVENUE_KEYS = ['bank_deposits', 'cash', 'doordash', 'uber', 'grubhub', 'menufy', 'other'];
const EXPENSE_KEYS = [
  'payroll', 'rent', 'utilities', 'repairs', 'depreciation', 'interest',
  'professional_fees', 'merchant_services', 'insurance', 'auto', 'office',
  'office_supplies', 'advertising', 'other',
];
const BALANCE_KEYS = [
  'cash', 'inventory', 'other_current_assets', 'fixed_assets_gross',
  'accumulated_depreciation', 'other_assets', 'current_liabilities',
  'long_term_liabilities', 'retained_earnings', 'distributions',
];

function emptyForm() {
  const blank = { period_label: '', period_start: '', period_end: '', cadence: 'semi_annual',
                  sales_tax_collected: '', sales_tax_remitted: '', cogs: '', notes: '' };
  for (const k of REVENUE_KEYS) blank[`rev_${k}`] = '';
  for (const k of EXPENSE_KEYS) blank[`exp_${k}`] = '';
  for (const k of BALANCE_KEYS) blank[`bal_${k}`] = '';
  return blank;
}

function reportToForm(r) {
  const f = emptyForm();
  if (!r) return f;
  f.period_label = r.period_label || '';
  f.period_start = r.period_start || '';
  f.period_end = r.period_end || '';
  f.cadence = r.cadence || 'semi_annual';
  const pl = r.pl_data || {};
  const rev = pl.revenue || {};
  const exp = pl.expenses || {};
  const bal = r.balance_data || {};
  for (const k of REVENUE_KEYS)  f[`rev_${k}`] = rev[k] != null ? String(rev[k]) : '';
  for (const k of EXPENSE_KEYS)  f[`exp_${k}`] = exp[k] != null ? String(exp[k]) : '';
  for (const k of BALANCE_KEYS)  f[`bal_${k}`] = bal[k] != null ? String(bal[k]) : '';
  f.cogs = pl.cogs != null ? String(pl.cogs) : '';
  f.sales_tax_collected = pl.sales_tax_collected != null ? String(pl.sales_tax_collected) : '';
  f.sales_tax_remitted  = pl.sales_tax_remitted  != null ? String(pl.sales_tax_remitted)  : '';
  f.notes = r.notes || '';
  return f;
}

function formToPayload(f) {
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const revenue = {};
  let revenueTotal = 0;
  for (const k of REVENUE_KEYS) {
    const v = num(f[`rev_${k}`]);
    revenue[k] = v; revenueTotal += v;
  }
  const expenses = {};
  let expensesTotal = 0;
  for (const k of EXPENSE_KEYS) {
    const v = num(f[`exp_${k}`]);
    expenses[k] = v; expensesTotal += v;
  }
  const cogs = num(f.cogs);
  const salesTaxCollected = num(f.sales_tax_collected);
  const salesTaxRemitted  = num(f.sales_tax_remitted);
  const totalIncome = revenueTotal + salesTaxCollected;
  const grossProfit = revenueTotal - cogs;
  const netOrdinaryIncome = grossProfit - expensesTotal;
  const netIncome = netOrdinaryIncome - salesTaxRemitted + salesTaxCollected;
  const balance = {};
  for (const k of BALANCE_KEYS) balance[k] = num(f[`bal_${k}`]);
  return {
    period_label: f.period_label.trim(),
    period_start: f.period_start,
    period_end: f.period_end,
    cadence: f.cadence,
    notes: f.notes,
    pl_data: {
      revenue, expenses, cogs,
      sales_tax_collected: salesTaxCollected,
      sales_tax_remitted: salesTaxRemitted,
      total_income: totalIncome,
      gross_profit: grossProfit,
      net_ordinary_income: netOrdinaryIncome,
      net_income: netIncome,
    },
    balance_data: balance,
  };
}

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Map server-side parsed payload back into the form's flat field
// names. Parser returns { pl: { revenue:{}, expenses:{}, cogs,
// sales_tax_collected, sales_tax_remitted } } for the P&L kind, and
// { balance: { cash, inventory, ... } } for the balance kind.
function mergeParsedIntoForm(prev, parsed, kind) {
  const out = { ...prev };
  const fmt = (n) => (n == null ? '' : String(n));
  if (kind === 'balance' && parsed?.balance) {
    for (const [k, v] of Object.entries(parsed.balance)) {
      if (v != null) out[`bal_${k}`] = fmt(v);
    }
    return out;
  }
  const pl = parsed?.pl || {};
  for (const [k, v] of Object.entries(pl.revenue || {})) {
    if (v != null) out[`rev_${k}`] = fmt(v);
  }
  for (const [k, v] of Object.entries(pl.expenses || {})) {
    if (v != null) out[`exp_${k}`] = fmt(v);
  }
  if (pl.cogs != null) out.cogs = fmt(pl.cogs);
  if (pl.sales_tax_collected != null) out.sales_tax_collected = fmt(pl.sales_tax_collected);
  if (pl.sales_tax_remitted != null) out.sales_tax_remitted = fmt(pl.sales_tax_remitted);
  return out;
}

function fmtDate(iso, locale) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale === 'en' ? 'en-US' : 'es-ES',
    { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_STYLE = {
  draft:     { bg: '#f1f5f9', color: '#334155' },
  published: { bg: '#fef3c7', color: '#92400e' },
  sent:      { bg: '#dcfce7', color: '#166534' },
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

  // When a task button (in the Tasks section above) wants this section
  // to open a specific report in edit mode, it sets a URL hash like
  // #bookkeeping-edit=REPORT_ID. We poll the hash on mount + on
  // hashchange and call startEdit. Hash is cleared after we consume
  // it so a refresh doesn't re-trigger.
  useEffect(() => {
    function handleHash() {
      const m = (window.location.hash || '').match(/bookkeeping-edit=([^&]+)/);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      // Wait for the report list to load (or trigger load).
      if (!reports) return;
      const row = reports.find(r => r.id === id);
      if (row) {
        startEdit(row);
        // Clear the hash so a remount/refresh doesn't re-open.
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_e) {}
        // Scroll into view.
        setTimeout(() => {
          const el = document.querySelector('section.tax-card h3');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      }
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
      if (editingId) {
        await taxApi.adminUpdateFinancialReport(auth, editingId, payload);
      } else {
        await taxApi.adminCreateFinancialReport(auth, customerId, payload);
      }
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

  // Upload + parse PDF for the currently-edited report. Calls the
  // signed-URL endpoint, PUTs the file directly to Supabase Storage,
  // then asks the server to parse and returns the structured fields.
  // The parsed values are merged into the form state so the owner
  // sees them pre-filled and can correct anything that didn't match.
  const uploadAndParsePdf = async (kind, file) => {
    if (!editingId) {
      setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.saveDraftFirst') });
      return;
    }
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
      // Wrong-type detection — the file is a balance sheet dropped
      // into the P&L slot (or vice versa). Don't merge anything; tell
      // the owner so they can pick the right file. The PDF stays
      // uploaded so they can re-upload over it.
      if (dbg.typeMismatch) {
        const expected = kind === 'balance'
          ? t('owner.customer.bookkeeping.pdf.balance')
          : t('owner.customer.bookkeeping.pdf.pl');
        const got = dbg.detectedType === 'pl'
          ? t('owner.customer.bookkeeping.pdf.pl')
          : dbg.detectedType === 'balance'
          ? t('owner.customer.bookkeeping.pdf.balance')
          : t('owner.customer.bookkeeping.pdf.unknown');
        setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.wrongType', { expected, got }) });
        return;
      }
      // Recognizable PDF but the parser couldn't read text from it
      // (most likely a scanned image — no text layer).
      if (dbg.error === 'pdf_no_text_layer') {
        setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.noTextLayer') });
        return;
      }
      if (dbg.error) {
        setMsg({ kind: 'err', text: t('owner.customer.bookkeeping.msg.parseError', { error: dbg.error }) });
        return;
      }
      setForm(prev => mergeParsedIntoForm(prev, parseResult.parsed, kind));
      if ((dbg.matched || 0) === 0) {
        setMsg({ kind: 'warn', text: t('owner.customer.bookkeeping.msg.parsedZero', { kind }) });
      } else {
        setMsg({
          kind: 'ok',
          text: t('owner.customer.bookkeeping.msg.parsed', { kind, matched: dbg.matched }),
        });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || t('owner.customer.bookkeeping.msg.uploadFailed') });
    } finally { setBusy(false); }
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

  // Service-gated: hide the section entirely unless the customer has
  // the bookkeeping product tagged via the Services panel above. If
  // they have legacy reports from before the service was removed, we
  // keep the section visible (read-only banner) so the owner can
  // still resend/preview.
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
        <ReportForm t={t} form={form} setForm={setForm} onSave={save} onCancel={cancel} busy={busy} editing={!!editingId} onUploadPdf={uploadAndParsePdf} />
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
          {r.revision > 1 && (
            <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>{t('owner.customer.bookkeeping.row.revision', { n: r.revision })}</span>
          )}
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
        {r.status === 'draft' && (
          <button type="button" className="tax-btn tax-btn--primary" onClick={onPublish} disabled={busy}>{t('owner.customer.bookkeeping.action.publish')}</button>
        )}
        {r.status === 'published' && (
          <>
            <button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>{t('owner.customer.bookkeeping.action.preview')}</button>
            <button type="button" className="tax-btn tax-btn--primary" onClick={onSend} disabled={busy}>{t('owner.customer.bookkeeping.action.send')}</button>
          </>
        )}
        {r.status === 'sent' && (
          <>
            <button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>{t('owner.customer.bookkeeping.action.preview')}</button>
            <button type="button" className="tax-btn" onClick={onResend} disabled={busy}>{t('owner.customer.bookkeeping.action.resend')}</button>
          </>
        )}
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onEdit} disabled={busy}>{t('owner.customer.bookkeeping.action.edit')}</button>
        {r.status !== 'sent' && (
          <button type="button" className="tax-btn tax-btn--ghost" onClick={onDelete}
                  disabled={busy} style={{ color: '#b91c1c' }}>{t('owner.customer.bookkeeping.action.delete')}</button>
        )}
      </div>
    </div>
  );
}

function ReportForm({ t, form, setForm, onSave, onCancel, busy, editing, onUploadPdf }) {
  const set = (k, v) => setForm({ ...form, [k]: v });
  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 14, marginTop: 8, background: '#fafafa' }}>
      <h4 style={{ margin: '0 0 12px' }}>{t(editing ? 'owner.customer.bookkeeping.form.heading.edit' : 'owner.customer.bookkeeping.form.heading.create')}</h4>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Field label={t('owner.customer.bookkeeping.form.period')}>
          <input type="text" value={form.period_label} onChange={e => set('period_label', e.target.value)}
                 placeholder={t('owner.customer.bookkeeping.form.periodPlaceholder')}
                 style={inputStyle} />
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
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.pl')}
                     onPick={f => onUploadPdf && onUploadPdf('pl', f)} busy={busy} />
            <PdfDrop label={t('owner.customer.bookkeeping.pdf.balance')}
                     onPick={f => onUploadPdf && onUploadPdf('balance', f)} busy={busy} />
          </div>
        ) : (
          <div style={{ padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13, color: '#475569' }}>
            {t('owner.customer.bookkeeping.pdf.saveFirstHint')}
          </div>
        )}
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.revenue')}>
        <NumericGrid>
          {REVENUE_KEYS.map(k => (
            <Field key={k} label={t(`owner.customer.bookkeeping.channel.${k}`)}>
              <NumericInput value={form[`rev_${k}`]} onChange={v => set(`rev_${k}`, v)} />
            </Field>
          ))}
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.cogs')}>
        <NumericGrid>
          <Field label={t('owner.customer.bookkeeping.form.field.cogs')}>
            <NumericInput value={form.cogs} onChange={v => set('cogs', v)} />
          </Field>
          <Field label={t('owner.customer.bookkeeping.form.field.salesTaxCollected')}>
            <NumericInput value={form.sales_tax_collected} onChange={v => set('sales_tax_collected', v)} />
          </Field>
          <Field label={t('owner.customer.bookkeeping.form.field.salesTaxRemitted')}>
            <NumericInput value={form.sales_tax_remitted} onChange={v => set('sales_tax_remitted', v)} />
          </Field>
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.expenses')}>
        <NumericGrid>
          {EXPENSE_KEYS.map(k => (
            <Field key={k} label={t(`owner.customer.bookkeeping.expense.${k}`)}>
              <NumericInput value={form[`exp_${k}`]} onChange={v => set(`exp_${k}`, v)} />
            </Field>
          ))}
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.balance')}>
        <NumericGrid>
          {BALANCE_KEYS.map(k => (
            <Field key={k} label={t(`owner.customer.bookkeeping.balance.${k}`)}>
              <NumericInput value={form[`bal_${k}`]} onChange={v => set(`bal_${k}`, v)} />
            </Field>
          ))}
        </NumericGrid>
      </FormGroup>

      <FormGroup title={t('owner.customer.bookkeeping.form.group.notes')}>
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
                  rows={2} placeholder={t('owner.customer.bookkeeping.form.field.notes.placeholder')}
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
      </FormGroup>

      <Totals form={form} t={t} />

      <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #b45309', borderRadius: 6, fontSize: 13, color: '#78350f' }}>
        {t('owner.customer.bookkeeping.form.verifyBanner')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onCancel} disabled={busy}>{t('owner.customer.bookkeeping.action.cancel')}</button>
        <button type="button" className="tax-btn tax-btn--primary" onClick={onSave} disabled={busy}>
          {busy
            ? t('owner.customer.bookkeeping.action.saving')
            : t(editing ? 'owner.customer.bookkeeping.action.saveChanges' : 'owner.customer.bookkeeping.action.saveDraft')}
        </button>
      </div>
    </div>
  );
}

const inputStyle = { padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 13 };

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

function Totals({ form, t }) {
  const payload = formToPayload(form);
  const pl = payload.pl_data;
  const opex = Object.values(pl.expenses).reduce((s, v) => s + v, 0);
  return (
    <div style={{ marginTop: 14, padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <Total label={t('owner.customer.bookkeeping.form.totals.revenue')}     value={pl.total_income - pl.sales_tax_collected} />
        <Total label={t('owner.customer.bookkeeping.form.totals.cogs')}        value={pl.cogs} />
        <Total label={t('owner.customer.bookkeeping.form.totals.grossProfit')} value={pl.gross_profit} />
        <Total label={t('owner.customer.bookkeeping.form.totals.opex')}        value={opex} />
        <Total label={t('owner.customer.bookkeeping.form.totals.netIncome')}   value={pl.net_income} bold />
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
