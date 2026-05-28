// Phase 4n.70: bookkeeping financial reports section, rendered inside
// the owner's customer-detail page. List of existing reports + an
// inline form to capture a new one. Owner enters the structured P&L
// + balance-sheet subtotals manually — PDF auto-parse is deferred to
// a follow-up. Publish and Send are explicit, separate actions.
//
// The form is intentionally Spanish-labeled (matches the customer's
// preferred language); switching the admin UI to bilingual labels
// is a follow-up if/when we onboard non-Spanish-speaking practices.

import { useEffect, useState } from 'react';
import { taxApi } from '../api';

const FIELD_GROUPS = {
  revenue: [
    ['bank_deposits',   'Depósitos bancarios'],
    ['cash',            'Ventas en efectivo'],
    ['doordash',        'DoorDash'],
    ['uber',            'Uber Eats'],
    ['grubhub',         'Grubhub'],
    ['menufy',          'Menufy'],
    ['other',           'Otros canales'],
  ],
  expenses: [
    ['payroll',           'Nómina'],
    ['rent',              'Renta'],
    ['utilities',         'Servicios públicos'],
    ['repairs',           'Reparaciones y mantenimiento'],
    ['depreciation',      'Depreciación'],
    ['interest',          'Intereses'],
    ['professional_fees', 'Honorarios profesionales'],
    ['merchant_services', 'Servicios de procesamiento'],
    ['insurance',         'Seguros'],
    ['auto',              'Auto / Combustible'],
    ['office',            'Gastos de oficina'],
    ['office_supplies',   'Suministros de oficina'],
    ['advertising',       'Publicidad'],
    ['other',             'Otros gastos'],
  ],
  balance: [
    ['cash',                    'Efectivo en bancos'],
    ['inventory',               'Inventario'],
    ['other_current_assets',    'Otros activos corrientes'],
    ['fixed_assets_gross',      'Activos fijos (bruto)'],
    ['accumulated_depreciation','Depreciación acumulada (negativo)'],
    ['other_assets',            'Otros activos'],
    ['current_liabilities',     'Pasivos corrientes'],
    ['long_term_liabilities',   'Pasivos a largo plazo'],
    ['retained_earnings',       'Ganancias retenidas'],
    ['distributions',           'Distribuciones (negativo)'],
  ],
};

function emptyForm() {
  const blank = { period_label: '', period_start: '', period_end: '', cadence: 'semi_annual',
                  sales_tax_collected: '', sales_tax_remitted: '', cogs: '', notes: '' };
  for (const [k] of FIELD_GROUPS.revenue) blank[`rev_${k}`] = '';
  for (const [k] of FIELD_GROUPS.expenses) blank[`exp_${k}`] = '';
  for (const [k] of FIELD_GROUPS.balance) blank[`bal_${k}`] = '';
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
  for (const [k] of FIELD_GROUPS.revenue)  f[`rev_${k}`] = rev[k] != null ? String(rev[k]) : '';
  for (const [k] of FIELD_GROUPS.expenses) f[`exp_${k}`] = exp[k] != null ? String(exp[k]) : '';
  for (const [k] of FIELD_GROUPS.balance)  f[`bal_${k}`] = bal[k] != null ? String(bal[k]) : '';
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
  for (const [k] of FIELD_GROUPS.revenue) {
    const v = num(f[`rev_${k}`]);
    revenue[k] = v; revenueTotal += v;
  }
  const expenses = {};
  let expensesTotal = 0;
  for (const [k] of FIELD_GROUPS.expenses) {
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
  for (const [k] of FIELD_GROUPS.balance) balance[k] = num(f[`bal_${k}`]);
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

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_BADGE = {
  draft:     { bg: '#f1f5f9', color: '#334155', label: 'Borrador' },
  published: { bg: '#fef3c7', color: '#92400e', label: 'Listo para enviar' },
  sent:      { bg: '#dcfce7', color: '#166534', label: 'Enviado' },
};

export default function BookkeepingReportsSection({ auth, customerId, customer }) {
  const [reports, setReports] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [editingId, setEditingId] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: '', text: '' });

  const load = () => {
    taxApi.adminListFinancialReports(auth, customerId)
      .then(d => { setReports(d.reports || []); setAccessToken(d.accessToken || null); })
      .catch(e => setMsg({ kind: 'err', text: e?.message || 'No se pudo cargar.' }));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [customerId]);

  const startCreate = () => {
    setForm(emptyForm()); setCreating(true); setEditingId(''); setMsg({ kind: '', text: '' });
  };
  const startEdit = (r) => {
    setBusy(true);
    taxApi.adminGetFinancialReport(auth, r.id)
      .then(d => { setForm(reportToForm(d.report)); setEditingId(r.id); setCreating(false); setMsg({ kind: '', text: '' }); })
      .catch(e => setMsg({ kind: 'err', text: e?.message || 'No se pudo cargar.' }))
      .finally(() => setBusy(false));
  };
  const cancel = () => { setCreating(false); setEditingId(''); setForm(emptyForm()); setMsg({ kind: '', text: '' }); };

  const save = async () => {
    if (!form.period_label || !form.period_start || !form.period_end) {
      setMsg({ kind: 'err', text: 'Período, fecha inicial y fecha final son requeridos.' });
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
      setMsg({ kind: 'ok', text: 'Guardado.' });
      cancel(); load();
    } catch (e) {
      setMsg({ kind: 'err', text: e?.message || 'No se pudo guardar.' });
    } finally { setBusy(false); }
  };

  const publish = async (r) => {
    if (!confirm(`Publicar el informe ${r.period_label}? Esto no envía correo todavía — solo lo prepara para revisión.`)) return;
    setBusy(true);
    try { await taxApi.adminPublishFinancialReport(auth, r.id); load(); }
    catch (e) { setMsg({ kind: 'err', text: e?.message || 'No se pudo publicar.' }); }
    finally { setBusy(false); }
  };

  const send = async (r, isResend) => {
    const action = isResend ? 'Reenviar' : 'Enviar';
    if (!confirm(`${action} el informe ${r.period_label} al cliente?`)) return;
    setBusy(true);
    try {
      const d = await taxApi.adminSendFinancialReport(auth, r.id);
      if (d.sent) {
        setMsg({ kind: 'ok', text: `${action} exitoso.` });
      } else {
        setMsg({ kind: 'warn', text: `Correo no enviado (${d.reason || 'desconocido'}). URL: ${d.viewUrl}` });
      }
      load();
    } catch (e) { setMsg({ kind: 'err', text: e?.message || 'No se pudo enviar.' }); }
    finally { setBusy(false); }
  };

  const preview = async (r) => {
    setBusy(true);
    try {
      const d = await taxApi.adminPreviewReportAccess(auth, customerId);
      // Set the signed cookie so the gate skips, then navigate.
      // Cookie is httpOnly when set by the server, but here we set it
      // client-side as a regular cookie — same value, same name. The
      // public route accepts either form (it only reads the value).
      document.cookie = `${d.cookieName}=${d.cookieValue}; Path=/; Max-Age=${Math.floor(d.cookieMaxAgeMs/1000)}; SameSite=Lax`;
      window.open(d.viewUrl + '#report=' + encodeURIComponent(r.id), '_blank', 'noopener');
    } catch (e) { setMsg({ kind: 'err', text: e?.message || 'No se pudo abrir vista previa.' }); }
    finally { setBusy(false); }
  };

  const remove = async (r) => {
    if (!confirm(`Eliminar permanentemente el informe ${r.period_label}?`)) return;
    setBusy(true);
    try { await taxApi.adminDeleteFinancialReport(auth, r.id); load(); }
    catch (e) { setMsg({ kind: 'err', text: e?.message || 'No se pudo eliminar.' }); }
    finally { setBusy(false); }
  };

  if (!reports) return <section className="tax-card" style={{ marginTop: 24 }}><p>Cargando informes…</p></section>;

  return (
    <section className="tax-card" style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Informes de contabilidad (P&amp;L + Balance)</h3>
        {!creating && !editingId && (
          <button type="button" className="tax-btn tax-btn--primary" onClick={startCreate} disabled={busy}>
            + Nuevo informe
          </button>
        )}
      </div>

      {msg.text && (
        <div className={`tax-msg ${msg.kind === 'err' ? 'tax-msg--error' : msg.kind === 'warn' ? '' : 'tax-msg--success'}`}
             style={msg.kind === 'warn' ? { background: '#fef3c7', borderLeft: '3px solid #b45309', color: '#78350f', padding: '8px 12px' } : {}}>
          {msg.text}
        </div>
      )}

      {(creating || editingId) && (
        <ReportForm form={form} setForm={setForm} onSave={save} onCancel={cancel} busy={busy} editing={!!editingId} />
      )}

      {!creating && !editingId && (
        <>
          {reports.length === 0 ? (
            <p style={{ color: 'var(--tax-muted)', fontSize: 14, margin: '8px 0 0' }}>
              Aún no hay informes para este cliente. Haga clic en <strong>+ Nuevo informe</strong> para crear el primero.
            </p>
          ) : (
            <div style={{ marginTop: 8 }}>
              {reports.map(r => (
                <ReportRow key={r.id} r={r}
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
              Enlace del cliente provisionado el {fmtDate(accessToken.created_at)}.
              {accessToken.last_used_at && <> Último acceso: {fmtDate(accessToken.last_used_at)}.</>}
              {accessToken.revoked_at && <> <strong style={{ color: '#b91c1c' }}>Revocado.</strong></>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ReportRow({ r, onEdit, onPublish, onSend, onResend, onPreview, onDelete, busy }) {
  const badge = STATUS_BADGE[r.status] || STATUS_BADGE.draft;
  const pl = r.pl_data || {};
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
            background: badge.bg, color: badge.color,
          }}>{badge.label}</span>
          {r.revision > 1 && (
            <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>Rev. {r.revision}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4 }}>
          {fmtDate(r.period_start)} – {fmtDate(r.period_end)}
          {r.published_at && <> · Publicado {fmtDate(r.published_at)}</>}
          {r.first_sent_at && <> · Enviado {fmtDate(r.first_sent_at)}{r.send_count > 1 ? ` (×${r.send_count})` : ''}</>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {r.status === 'draft' && (
          <button type="button" className="tax-btn tax-btn--primary" onClick={onPublish} disabled={busy}>Publicar</button>
        )}
        {r.status === 'published' && (
          <>
            <button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>Vista previa</button>
            <button type="button" className="tax-btn tax-btn--primary" onClick={onSend} disabled={busy}>Enviar</button>
          </>
        )}
        {r.status === 'sent' && (
          <>
            <button type="button" className="tax-btn" onClick={onPreview} disabled={busy}>Vista previa</button>
            <button type="button" className="tax-btn" onClick={onResend} disabled={busy}>Reenviar</button>
          </>
        )}
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onEdit} disabled={busy}>Editar</button>
        {r.status !== 'sent' && (
          <button type="button" className="tax-btn tax-btn--ghost" onClick={onDelete}
                  disabled={busy} style={{ color: '#b91c1c' }}>Eliminar</button>
        )}
      </div>
    </div>
  );
}

function ReportForm({ form, setForm, onSave, onCancel, busy, editing }) {
  const set = (k, v) => setForm({ ...form, [k]: v });
  const InputCell = ({ k, label, prefix = 'rev_' }) => (
    <div style={{ display: 'grid', gap: 4 }}>
      <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>{label}</label>
      <input type="number" inputMode="decimal" step="0.01"
             value={form[`${prefix}${k}`]}
             onChange={e => set(`${prefix}${k}`, e.target.value)}
             placeholder="0.00"
             style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 13, fontVariantNumeric: 'tabular-nums' }} />
    </div>
  );

  return (
    <div style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 14, marginTop: 8, background: '#fafafa' }}>
      <h4 style={{ margin: '0 0 12px' }}>{editing ? 'Editar informe' : 'Nuevo informe'}</h4>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Período (ej. H1 2025)</label>
          <input type="text" value={form.period_label} onChange={e => set('period_label', e.target.value)}
                 placeholder="H1 2025"
                 style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Fecha inicial</label>
          <input type="date" value={form.period_start} onChange={e => set('period_start', e.target.value)}
                 style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Fecha final</label>
          <input type="date" value={form.period_end} onChange={e => set('period_end', e.target.value)}
                 style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Cadencia</label>
          <select value={form.cadence} onChange={e => set('cadence', e.target.value)}
                  style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="semi_annual">Semestral</option>
            <option value="annual">Anual</option>
            <option value="quarterly">Trimestral</option>
            <option value="custom">Personalizado</option>
          </select>
        </div>
      </div>

      <FormGroup title="Ingresos por canal">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {FIELD_GROUPS.revenue.map(([k, label]) => <InputCell key={k} k={k} label={label} prefix="rev_" />)}
        </div>
      </FormGroup>

      <FormGroup title="Costo de bienes vendidos (COGS) e impuesto a las ventas">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>COGS total</label>
            <input type="number" inputMode="decimal" step="0.01"
                   value={form.cogs} onChange={e => set('cogs', e.target.value)} placeholder="0.00"
                   style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Impuesto a las ventas recaudado</label>
            <input type="number" inputMode="decimal" step="0.01"
                   value={form.sales_tax_collected} onChange={e => set('sales_tax_collected', e.target.value)} placeholder="0.00"
                   style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 12, color: 'var(--tax-muted)', fontWeight: 600 }}>Impuesto a las ventas remitido</label>
            <input type="number" inputMode="decimal" step="0.01"
                   value={form.sales_tax_remitted} onChange={e => set('sales_tax_remitted', e.target.value)} placeholder="0.00"
                   style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
        </div>
      </FormGroup>

      <FormGroup title="Gastos operativos">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {FIELD_GROUPS.expenses.map(([k, label]) => <InputCell key={k} k={k} label={label} prefix="exp_" />)}
        </div>
      </FormGroup>

      <FormGroup title="Balance general (al final del período)">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {FIELD_GROUPS.balance.map(([k, label]) => <InputCell key={k} k={k} label={label} prefix="bal_" />)}
        </div>
      </FormGroup>

      <FormGroup title="Notas internas (opcional)">
        <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
                  rows={2} placeholder="Notas que solo verá el equipo."
                  style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
      </FormGroup>

      <Totals form={form} />

      <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef3c7', borderLeft: '3px solid #b45309', borderRadius: 6, fontSize: 13, color: '#78350f' }}>
        <strong>Verifique antes de publicar.</strong> Los números que ingrese aquí son los que verá su cliente en el panel y en el correo. Confirme que coinciden con los PDFs originales.
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="tax-btn tax-btn--ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="button" className="tax-btn tax-btn--primary" onClick={onSave} disabled={busy}>
          {busy ? 'Guardando…' : (editing ? 'Guardar cambios' : 'Guardar borrador')}
        </button>
      </div>
    </div>
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

function Totals({ form }) {
  const payload = formToPayload(form);
  const pl = payload.pl_data;
  return (
    <div style={{ marginTop: 14, padding: '10px 12px', background: '#f1f5f9', borderRadius: 6, fontSize: 13 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <Total label="Ingresos" value={pl.total_income - pl.sales_tax_collected} />
        <Total label="COGS" value={pl.cogs} />
        <Total label="Utilidad bruta" value={pl.gross_profit} />
        <Total label="Gastos op." value={Object.values(pl.expenses).reduce((s, v) => s + v, 0)} />
        <Total label="Utilidad neta" value={pl.net_income} bold />
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
