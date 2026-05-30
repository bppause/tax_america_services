// Phase 4n.70: customer-facing financial report dashboard.
//
// Mount at /tax/{slug}/r/{token}. Two states:
//   1. 'gate'  — server didn't see a valid cookie. We render an email
//      confirmation form. POST /report-access/:token/confirm with the
//      typed email; on match the server sets a 7-day cookie and we
//      reload into the 'ready' state.
//   2. 'ready' — cookie is valid. Server returned the report list +
//      customer info. We render a list; clicking a report fetches the
//      full payload + the immediate prior report (for YoY) and shows
//      the charted dashboard.
//
// Charts use inline SVG — keeps the bundle slim since this page is
// hit infrequently (only customers with the magic link).

import { useEffect, useMemo, useState } from 'react';
import { taxApi } from '../api';

const I18N = {
  es: {
    confirmTitle: 'Confirme su correo electrónico',
    confirmBlurb: 'Por seguridad, escriba la dirección de correo a la que se envió este enlace. La verificación dura 7 días en este dispositivo.',
    emailLabel: 'Correo electrónico',
    emailPlaceholder: 'usted@ejemplo.com',
    confirmCta: 'Ver mi informe',
    confirmBusy: 'Verificando…',
    mismatch: 'Ese correo no coincide. Por favor verifique e intente de nuevo.',
    locked: 'Demasiados intentos. El enlace está bloqueado temporalmente; intente de nuevo en una hora.',
    notFound: 'Este enlace no es válido o fue revocado.',
    networkErr: 'No se pudo verificar. Intente de nuevo.',
    listTitle: 'Sus informes financieros',
    listBlurb: 'Toque un informe para ver los gráficos y las comparaciones.',
    empty: 'Aún no hay informes publicados.',
    backToList: '← Volver a la lista',
    period: 'Período',
    publishedOn: 'Publicado',
    revision: 'Rev.',
    updatedNote: 'Actualizado',
    estimateBanner: 'La información mostrada es estimada basada en lo que usted nos ha proporcionado. Verifique con sus propios libros antes de tomar decisiones importantes.',
    kpi: { revenue: 'Ingresos', cogs: 'Costo de ventas', grossProfit: 'Utilidad bruta', opex: 'Gastos operativos', netIncome: 'Utilidad neta', grossMargin: 'Margen bruto' },
    yoyTitle: 'Este período vs. el anterior',
    revenueMixTitle: 'Ingresos por canal',
    expensesTitle: 'Principales gastos operativos',
    balanceTitle: 'Balance general — Activos vs. Pasivos + Capital',
    healthTitle: 'Salud financiera',
    ratios: {
      net_margin: { label: 'Margen neto', note: 'Utilidad neta ÷ ingresos' },
      gross_margin: { label: 'Margen bruto', note: 'Utilidad bruta ÷ ingresos' },
      months_of_cash: { label: 'Meses de efectivo', note: 'Efectivo ÷ gasto operativo mensual' },
      debt_to_equity: { label: 'Deuda sobre capital', note: 'Pasivos totales ÷ capital total' },
    },
    badgeGood: 'Saludable',
    badgeWatch: 'Atención',
    badgeRisk: 'Riesgo',
    downloads: 'Documentos fuente',
    pdfPl: 'Estado de Resultados (PDF)',
    pdfBalance: 'Balance General (PDF)',
    footer: 'Preparado por {practice}. Responda al correo recibido para cualquier pregunta.',
    channels: { bank_deposits: 'Depósitos bancarios', cash: 'Ventas en efectivo', doordash: 'DoorDash', uber: 'Uber Eats', grubhub: 'Grubhub', menufy: 'Menufy', other: 'Otros canales' },
    expenseLabels: { payroll: 'Nómina', rent: 'Renta', utilities: 'Servicios', repairs: 'Reparaciones', depreciation: 'Depreciación', interest: 'Intereses', professional_fees: 'Honorarios prof.', merchant_services: 'Procesamiento', insurance: 'Seguros', auto: 'Auto', office: 'Oficina', office_supplies: 'Suministros', advertising: 'Publicidad', other: 'Otros' },
  },
  en: {
    confirmTitle: 'Confirm your email address',
    confirmBlurb: 'For security, enter the email address this link was sent to. Verification lasts 7 days on this device.',
    emailLabel: 'Email address',
    emailPlaceholder: 'you@example.com',
    confirmCta: 'View my report',
    confirmBusy: 'Verifying…',
    mismatch: 'That email does not match. Please check and try again.',
    locked: 'Too many attempts. The link is temporarily locked; try again in an hour.',
    notFound: 'This link is invalid or has been revoked.',
    networkErr: 'Could not verify. Please try again.',
    listTitle: 'Your financial reports',
    listBlurb: 'Tap a report to see the charts and comparisons.',
    empty: 'No reports published yet.',
    backToList: '← Back to list',
    period: 'Period',
    publishedOn: 'Published',
    revision: 'Rev.',
    updatedNote: 'Updated',
    estimateBanner: 'The information shown is estimated based on what you have provided us. Verify against your own books before making important decisions.',
    kpi: { revenue: 'Revenue', cogs: 'COGS', grossProfit: 'Gross profit', opex: 'Operating exp.', netIncome: 'Net income', grossMargin: 'Gross margin' },
    yoyTitle: 'This period vs. previous',
    revenueMixTitle: 'Revenue by channel',
    expensesTitle: 'Top operating expenses',
    balanceTitle: 'Balance sheet — Assets vs. Liabilities + Equity',
    healthTitle: 'Financial health',
    ratios: {
      net_margin: { label: 'Net margin', note: 'Net income ÷ revenue' },
      gross_margin: { label: 'Gross margin', note: 'Gross profit ÷ revenue' },
      months_of_cash: { label: 'Months of cash', note: 'Cash ÷ monthly operating expense' },
      debt_to_equity: { label: 'Debt to equity', note: 'Total liabilities ÷ total equity' },
    },
    badgeGood: 'Healthy',
    badgeWatch: 'Watch',
    badgeRisk: 'Risk',
    downloads: 'Source documents',
    pdfPl: 'Profit & Loss (PDF)',
    pdfBalance: 'Balance Sheet (PDF)',
    footer: 'Prepared by {practice}. Reply to the email we sent you with any questions.',
    channels: { bank_deposits: 'Bank deposits', cash: 'Cash sales', doordash: 'DoorDash', uber: 'Uber Eats', grubhub: 'Grubhub', menufy: 'Menufy', other: 'Other channels' },
    expenseLabels: { payroll: 'Payroll', rent: 'Rent', utilities: 'Utilities', repairs: 'Repairs', depreciation: 'Depreciation', interest: 'Interest', professional_fees: 'Professional fees', merchant_services: 'Merchant svc', insurance: 'Insurance', auto: 'Auto', office: 'Office', office_supplies: 'Supplies', advertising: 'Advertising', other: 'Other' },
  },
};

const CHANNEL_COLORS = ['#0f766e', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#94a3b8'];

function fmtCurrency(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`;
  return `$${v}`;
}
function fmtCurrencyFull(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtPct(n) {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return `${v.toFixed(1)}%`;
}
function fmtDate(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'en' ? 'en-US' : 'es-ES',
    { year: 'numeric', month: 'short', day: 'numeric' });
}

function readParsedHashReport() {
  // /r/{token}#report={id} — opens that specific report on load
  // (used by the owner's "Vista previa" button to deep-link).
  const m = (window.location.hash || '').match(/report=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export default function TaxReport({ communitySlug, token }) {
  const [state, setState] = useState('loading'); // loading | gate | ready | error
  const [community, setCommunity] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [reports, setReports] = useState([]);
  const [errCode, setErrCode] = useState('');
  const [lang, setLang] = useState('es');
  const [selectedId, setSelectedId] = useState('');

  const load = async () => {
    try {
      const d = await taxApi.getReportAccess(token);
      setCommunity(d.community || null);
      // Apply the customer/community locale from either payload shape:
      //   gate  → server includes `locale` so the confirmation page
      //           renders in the customer's language from the first
      //           paint instead of defaulting to platform Spanish.
      //   ready → falls through to the existing customer.locale path
      //           below (post-confirm we know who they are).
      if (d.locale === 'en' || d.locale === 'es') setLang(d.locale);
      if (d.state === 'ready') {
        setCustomer(d.customer || null);
        setReports(d.reports || []);
        if (d.customer?.locale === 'en') setLang('en');
        else if (d.customer?.locale === 'es') setLang('es');
        const hashId = readParsedHashReport();
        if (hashId && (d.reports || []).some(r => r.id === hashId)) {
          setSelectedId(hashId);
        }
        setState('ready');
      } else {
        setState('gate');
      }
    } catch (e) {
      setErrCode(e?.body?.error || e?.message || 'unknown');
      setState('error');
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  const t = I18N[lang];

  if (state === 'loading') {
    return <div style={pageWrapStyle}><div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>…</div></div>;
  }
  if (state === 'error') {
    return (
      <div style={pageWrapStyle}>
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>{lang === 'en' ? 'Link not found' : 'Enlace no encontrado'}</h2>
          <p style={{ color: '#64748b' }}>{t.notFound}</p>
        </div>
      </div>
    );
  }
  if (state === 'gate') {
    return <ConfirmGate token={token} t={t} lang={lang} setLang={setLang} communityName={community?.name} onConfirmed={load} />;
  }

  const selected = selectedId ? reports.find(r => r.id === selectedId) : null;

  return (
    <div style={pageWrapStyle}>
      <Header community={community} customer={customer} t={t} lang={lang} setLang={setLang} />
      {!selected ? (
        <ReportList reports={reports} t={t} onPick={id => { setSelectedId(id); window.scrollTo(0, 0); }} lang={lang} />
      ) : (
        <ReportDetail report={selected} token={token} t={t} lang={lang}
                      practice={community?.name || ''}
                      onBack={() => { setSelectedId(''); history.replaceState(null, '', window.location.pathname); }} />
      )}
    </div>
  );
}

const pageWrapStyle = {
  minHeight: '100vh', background: '#f6f7f9', padding: '20px 12px 60px',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  color: '#0f172a',
};
const containerStyle = { maxWidth: 1120, margin: '0 auto' };
const cardStyle = {
  maxWidth: 480, margin: '40px auto', padding: 28,
  background: '#fff', borderRadius: 12, border: '1px solid #e2e8f0',
  boxShadow: '0 1px 3px rgba(15,23,42,.08)',
};

function Header({ community, customer, t, lang, setLang }) {
  const heroStyle = {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 16, flexWrap: 'wrap', padding: '22px 26px',
    background: 'linear-gradient(135deg, #134e4a 0%, #0f766e 100%)',
    color: '#fff', borderRadius: 14, marginBottom: 22,
    boxShadow: '0 1px 3px rgba(15,23,42,.08)',
  };
  return (
    <div style={containerStyle}>
      <div style={heroStyle}>
        <div>
          <div style={{ textTransform: 'uppercase', letterSpacing: '.12em', fontSize: 11, fontWeight: 700, opacity: .85, color: '#ccfbf1' }}>
            {community?.name || 'Tax America Services'}
          </div>
          <h1 style={{ margin: '6px 0 4px', fontSize: 24, fontWeight: 700 }}>
            {customer?.name || (lang === 'en' ? 'Financial reports' : 'Informes financieros')}
          </h1>
        </div>
        <LangToggle lang={lang} setLang={setLang} />
      </div>
    </div>
  );
}

function LangToggle({ lang, setLang }) {
  const btn = (val, label) => (
    <button type="button" onClick={() => setLang(val)} style={{
      background: lang === val ? '#fff' : 'transparent',
      color: lang === val ? '#0f766e' : '#fff',
      border: 0, padding: '6px 12px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, cursor: 'pointer',
    }}>{label}</button>
  );
  return (
    <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,.15)', padding: 4, borderRadius: 999, border: '1px solid rgba(255,255,255,.2)' }}>
      {btn('en', 'EN')}{btn('es', 'ES')}
    </div>
  );
}

function ConfirmGate({ token, t, lang, setLang, communityName, onConfirmed }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e?.preventDefault?.();
    if (!email.trim()) return;
    setBusy(true); setErr('');
    try {
      await taxApi.confirmReportAccess(token, email.trim());
      onConfirmed();
    } catch (e) {
      const code = e?.body?.error || '';
      if (code === 'locked') setErr(t.locked);
      else if (code === 'mismatch') setErr(t.mismatch);
      else setErr(t.networkErr);
    } finally { setBusy(false); }
  };
  return (
    <div style={pageWrapStyle}>
      <div style={containerStyle}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: 480, margin: '0 auto 12px' }}>
          <div style={{ display: 'inline-flex', background: '#e2e8f0', padding: 3, borderRadius: 999 }}>
            <button onClick={() => setLang('en')} style={{ background: lang === 'en' ? '#fff' : 'transparent', border: 0, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>EN</button>
            <button onClick={() => setLang('es')} style={{ background: lang === 'es' ? '#fff' : 'transparent', border: 0, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>ES</button>
          </div>
        </div>
        <form style={cardStyle} onSubmit={submit}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.12em', color: '#0f766e', fontWeight: 700 }}>
            {communityName || 'Tax America Services'}
          </div>
          <h2 style={{ marginTop: 6, marginBottom: 8 }}>{t.confirmTitle}</h2>
          <p style={{ color: '#64748b', fontSize: 14 }}>{t.confirmBlurb}</p>
          <label style={{ display: 'block', fontSize: 12, color: '#475569', fontWeight: 600, marginTop: 14 }}>{t.emailLabel}</label>
          <input type="email" autoFocus required value={email} onChange={e => setEmail(e.target.value)}
                 placeholder={t.emailPlaceholder}
                 style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14, marginTop: 4, boxSizing: 'border-box' }} />
          {err && <div style={{ marginTop: 10, padding: '8px 12px', background: '#fee2e2', color: '#b91c1c', borderRadius: 6, fontSize: 13 }}>{err}</div>}
          <button type="submit" disabled={busy}
                  style={{ marginTop: 14, width: '100%', padding: '12px 16px', background: '#0f766e', color: '#fff', border: 0, borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? t.confirmBusy : t.confirmCta}
          </button>
        </form>
      </div>
    </div>
  );
}

function ReportList({ reports, t, onPick, lang }) {
  return (
    <div style={containerStyle}>
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 24, boxShadow: '0 1px 3px rgba(15,23,42,.04)' }}>
        <h2 style={{ marginTop: 0, marginBottom: 6 }}>{t.listTitle}</h2>
        <p style={{ color: '#64748b', fontSize: 14, marginTop: 0 }}>{t.listBlurb}</p>
        {reports.length === 0 ? (
          <p style={{ color: '#64748b', fontStyle: 'italic' }}>{t.empty}</p>
        ) : (
          <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            {reports.map(r => (
              <button key={r.id} type="button" onClick={() => onPick(r.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                  padding: '14px 16px', border: '1px solid #e2e8f0', borderRadius: 10,
                  background: '#fff', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{r.period_label}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {fmtDate(r.period_start, lang)} — {fmtDate(r.period_end, lang)}
                    {r.revision > 1 && <> · {t.revision} {r.revision}</>}
                  </div>
                </div>
                <div style={{ color: '#0f766e', fontWeight: 700, fontSize: 18 }}>→</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportDetail({ report: summary, token, t, lang, practice, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setData(null); setErr('');
    taxApi.getReportAccessReport(token, summary.id)
      .then(d => setData(d))
      .catch(e => setErr(e?.message || 'load_failed'));
  }, [token, summary.id]);

  if (err) return <div style={containerStyle}><div style={{ ...cardStyle, margin: '20px auto' }}>{err}</div></div>;
  if (!data) return <div style={containerStyle}><div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>…</div></div>;

  const r = data.report;
  const prior = data.prior;
  return (
    <div style={containerStyle}>
      <button type="button" onClick={onBack}
        style={{ background: 'transparent', border: 0, color: '#0f766e', fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: 0, marginBottom: 8 }}>
        {t.backToList}
      </button>

      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '18px 22px', marginBottom: 16, boxShadow: '0 1px 3px rgba(15,23,42,.04)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{r.period_label}</h2>
          <span style={{ color: '#64748b', fontSize: 13 }}>
            {fmtDate(r.period_start, lang)} — {fmtDate(r.period_end, lang)}
          </span>
          {r.revision > 1 && (
            <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', background: '#fef3c7', padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t.updatedNote} {fmtDate(r.updated_at, lang)}
            </span>
          )}
        </div>
      </div>

      <KpiStrip r={r} prior={prior} t={t} />
      <TwoCol left={<RevenueMix r={r} t={t} />} right={<ExpenseBars r={r} t={t} />} />
      {prior && <Yoy r={r} prior={prior} t={t} />}
      <BalanceSection r={r} t={t} />
      <HealthSection r={r} t={t} />

      <div style={{ background: '#fef3c7', borderLeft: '3px solid #b45309', borderRadius: 8, padding: '12px 16px', marginTop: 16, color: '#78350f', fontSize: 13 }}>
        <strong>{lang === 'en' ? 'Important' : 'Importante'}.</strong> {t.estimateBanner}
      </div>

      <DownloadsSection r={r} token={token} t={t} />

      <div style={{ marginTop: 22, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
        {t.footer.replace('{practice}', practice || 'Tax America Services')}
      </div>
    </div>
  );
}

function TwoCol({ left, right }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, marginBottom: 14 }}>
      {left}
      {right}
    </div>
  );
}

// Resolves both the new sectional shape and the legacy flat shape
// into the same in-component view: revenue/expense breakdowns plus
// canonical totals. New reports flow through `pl.sections` /
// `pl.totals`; old reports flow through the original `pl.revenue` /
// `pl.expenses` dicts.
function totalsFromReport(r) {
  const pl = r.pl || {};
  // Channel + category breakdowns — used by donut + bar charts.
  const revenueChannels = []; // [{name, amount}]
  const expenseCategories = []; // [{name, amount}]

  if (pl.sections) {
    for (const g of (pl.sections.income?.groups || [])) {
      // Prefer per-item granularity when present, otherwise the group's own total.
      const items = (g.items || []).filter(i => Number(i.amount) > 0 && !i.rollup);
      if (items.length) {
        for (const it of items) revenueChannels.push({ name: it.name, amount: Number(it.amount) });
      } else if (Number(g.total) > 0) {
        revenueChannels.push({ name: g.name, amount: Number(g.total) });
      }
    }
    for (const g of (pl.sections.expenses?.groups || [])) {
      const t = Number(g.total) || (g.items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      if (t > 0) expenseCategories.push({ name: g.name, amount: t });
    }
  } else {
    // Legacy shape: flat dicts of channel/category → amount.
    for (const [k, v] of Object.entries(pl.revenue || {})) {
      if (Number(v) > 0) revenueChannels.push({ name: prettify(k), amount: Number(v), key: k });
    }
    for (const [k, v] of Object.entries(pl.expenses || {})) {
      if (Number(v) > 0) expenseCategories.push({ name: prettify(k), amount: Number(v), key: k });
    }
  }

  // Canonical totals — prefer the parser-recorded totals, fall back
  // to derived sums when missing (for legacy reports).
  const t = pl.totals || {};
  const revenueTotal = t.total_income != null
    ? Number(t.total_income)
    : (pl.total_income != null
        ? (Number(pl.total_income) || 0) - (Number(pl.sales_tax_collected) || 0)
        : revenueChannels.reduce((s, x) => s + x.amount, 0));
  const cogs = t.total_cogs != null ? Number(t.total_cogs) : (Number(pl.cogs) || 0);
  const grossProfit = t.gross_profit != null ? Number(t.gross_profit) : (revenueTotal - cogs);
  const opex = t.total_expense != null ? Number(t.total_expense) : expenseCategories.reduce((s, x) => s + x.amount, 0);
  const netIncome = t.net_income != null ? Number(t.net_income) : (Number(pl.net_income) || (grossProfit - opex));
  const grossMargin = revenueTotal > 0 ? (grossProfit / revenueTotal) * 100 : 0;
  return { revenueTotal, cogs, grossProfit, opex, netIncome, grossMargin, revenueChannels, expenseCategories };
}

function prettify(k) {
  if (!k) return '';
  return String(k).split(/[_\s]+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim();
}

function KpiStrip({ r, prior, t }) {
  const cur = totalsFromReport(r);
  const prev = prior ? totalsFromReport(prior) : null;
  const delta = (a, b) => {
    if (!prev || !b) return null;
    const pct = ((a - b) / Math.abs(b)) * 100;
    return Number.isFinite(pct) ? pct : null;
  };
  const items = [
    { label: t.kpi.revenue, value: fmtCurrency(cur.revenueTotal), delta: delta(cur.revenueTotal, prev?.revenueTotal), positiveIsGood: true },
    { label: t.kpi.cogs, value: fmtCurrency(cur.cogs), delta: delta(cur.cogs, prev?.cogs), positiveIsGood: false },
    { label: t.kpi.grossProfit, value: fmtCurrency(cur.grossProfit), delta: delta(cur.grossProfit, prev?.grossProfit), positiveIsGood: true },
    { label: t.kpi.opex, value: fmtCurrency(cur.opex), delta: delta(cur.opex, prev?.opex), positiveIsGood: false },
    { label: t.kpi.netIncome, value: fmtCurrency(cur.netIncome), delta: delta(cur.netIncome, prev?.netIncome), positiveIsGood: true },
    { label: t.kpi.grossMargin, value: fmtPct(cur.grossMargin), delta: prev ? cur.grossMargin - prev.grossMargin : null, positiveIsGood: true, isPoints: true },
  ];
  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 14 }}>
      {items.map((it, i) => <KpiCard key={i} {...it} />)}
    </div>
  );
}
function KpiCard({ label, value, delta, positiveIsGood, isPoints }) {
  const good = delta != null && ((positiveIsGood && delta >= 0) || (!positiveIsGood && delta < 0));
  const sign = delta != null && delta >= 0 ? '▲' : '▼';
  const deltaStr = delta != null
    ? `${sign} ${Math.abs(Math.round(delta * 10) / 10).toFixed(1)}${isPoints ? ' pts' : '%'}`
    : '';
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', boxShadow: '0 1px 2px rgba(15,23,42,.04)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {delta != null && (
        <div style={{
          marginTop: 4, fontSize: 11, fontWeight: 600,
          display: 'inline-flex', padding: '2px 6px', borderRadius: 999,
          color: good ? '#15803d' : '#b91c1c',
          background: good ? '#dcfce7' : '#fee2e2',
        }}>{deltaStr}</div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18, boxShadow: '0 1px 3px rgba(15,23,42,.04)', marginBottom: 14 }}>
      <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700 }}>{title}</h3>
      {children}
    </div>
  );
}

function RevenueMix({ r, t }) {
  const { revenueChannels, revenueTotal } = totalsFromReport(r);
  // Coalesce tiny long-tail entries into "Other" so the donut + list
  // don't fragment into 30 slivers on customers with many channels.
  const sorted = [...revenueChannels].sort((a, b) => b.amount - a.amount);
  const TOP = 6;
  const top = sorted.slice(0, TOP);
  const tail = sorted.slice(TOP);
  const entries = [...top];
  if (tail.length) {
    const tailSum = tail.reduce((s, e) => s + e.amount, 0);
    if (tailSum > 0) entries.push({ name: t.otherChannels || 'Other', amount: tailSum });
  }
  if (entries.length === 0) return <Section title={t.revenueMixTitle}><div style={{ color: '#94a3b8' }}>—</div></Section>;
  return (
    <Section title={t.revenueMixTitle}>
      <Donut entries={entries} total={revenueTotal || entries.reduce((s, e) => s + e.amount, 0)} />
      <div style={{ marginTop: 12 }}>
        {entries.map((e, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: CHANNEL_COLORS[i % CHANNEL_COLORS.length], borderRadius: 2, marginRight: 8, verticalAlign: 'middle' }} />{(t.channels && t.channels[e.key]) || e.name}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCurrencyFull(e.amount)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Donut({ entries, total }) {
  const size = 200, r = 70, cx = size/2, cy = size/2;
  let acc = 0;
  const segs = entries.map((e, i) => {
    const v = e.amount;
    const start = acc / total * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const end = acc / total * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end),   y2 = cy + r * Math.sin(end);
    return { d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, color: CHANNEL_COLORS[i % CHANNEL_COLORS.length] };
  });
  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} style={{ maxHeight: 240, display: 'block', margin: '0 auto' }}>
      {segs.map((s, i) => <path key={i} d={s.d} fill={s.color} stroke="#fff" strokeWidth="2" />)}
      <circle cx={cx} cy={cy} r={42} fill="#fff" />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="11" fill="#64748b" fontWeight="700">TOTAL</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="16" fontWeight="700" fill="#0f172a">{fmtCurrency(total)}</text>
    </svg>
  );
}

function ExpenseBars({ r, t }) {
  const { expenseCategories } = totalsFromReport(r);
  const entries = [...expenseCategories]
    .sort((a, b) => b.amount - a.amount).slice(0, 8);
  if (entries.length === 0) return <Section title={t.expensesTitle}><div style={{ color: '#94a3b8' }}>—</div></Section>;
  const max = entries[0].amount;
  return (
    <Section title={t.expensesTitle}>
      <div style={{ display: 'grid', gap: 8 }}>
        {entries.map((e, i) => (
          <div key={i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{(t.expenseLabels && t.expenseLabels[e.key]) || e.name}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: '#475569' }}>{fmtCurrencyFull(e.amount)}</span>
            </div>
            <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${(e.amount / max) * 100}%`, background: '#0f766e', borderRadius: 4 }} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Yoy({ r, prior, t }) {
  const cur = totalsFromReport(r);
  const prev = totalsFromReport(prior);
  const series = [
    [t.kpi.revenue,     prev.revenueTotal, cur.revenueTotal],
    [t.kpi.cogs,        prev.cogs,         cur.cogs],
    [t.kpi.grossProfit, prev.grossProfit,  cur.grossProfit],
    [t.kpi.opex,        prev.opex,         cur.opex],
    [t.kpi.netIncome,   prev.netIncome,    cur.netIncome],
  ];
  const max = Math.max(1, ...series.flatMap(s => [s[1], s[2]]));
  return (
    <Section title={t.yoyTitle}>
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
        {prior.period_label} → {r.period_label}
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {series.map(([label, a, b]) => (
          <div key={label}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 90px', gap: 8, alignItems: 'center' }}>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>{prior.period_label}</div>
              <div style={{ height: 10, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(Math.abs(a) / max) * 100}%`, background: '#cbd5e1' }} />
              </div>
              <div style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCurrencyFull(a)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 90px', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <div style={{ fontSize: 10, color: '#0f766e', fontWeight: 700 }}>{r.period_label}</div>
              <div style={{ height: 10, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(Math.abs(b) / max) * 100}%`, background: '#0f766e' }} />
              </div>
              <div style={{ fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtCurrencyFull(b)}</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function balanceTotals(r) {
  const b = r.balance || {};
  const cash = Number(b.cash) || 0;
  const inv = Number(b.inventory) || 0;
  const oca = Number(b.other_current_assets) || 0;
  const fag = Number(b.fixed_assets_gross) || 0;
  const ad  = Number(b.accumulated_depreciation) || 0;
  const oa  = Number(b.other_assets) || 0;
  const cl  = Number(b.current_liabilities) || 0;
  const ltl = Number(b.long_term_liabilities) || 0;
  const re  = Number(b.retained_earnings) || 0;
  const dist = Number(b.distributions) || 0;
  const totalAssets = cash + inv + oca + fag + ad + oa;
  const totalLiab = cl + ltl;
  // Equity = total assets − total liabilities (forces balance to balance
  // even if RE + distributions + net income don't quite reconcile due
  // to rounding). The 'equity' segment we render is what's left over.
  const equity = totalAssets - totalLiab;
  return { cash, inv, oca, fag, ad, oa, cl, ltl, re, dist, totalAssets, totalLiab, equity };
}

function BalanceSection({ r, t }) {
  const b = balanceTotals(r);
  if (b.totalAssets <= 0) return null;
  const assetsSegs = [
    [t.kpi.revenue === 'Ingresos' ? 'Efectivo' : 'Cash', b.cash, '#0f766e'],
    [t.kpi.revenue === 'Ingresos' ? 'Inventario' : 'Inventory', b.inv, '#14b8a6'],
    [t.kpi.revenue === 'Ingresos' ? 'Activos fijos (neto)' : 'Fixed (net)', b.fag + b.ad, '#a7f3d0'],
    [t.kpi.revenue === 'Ingresos' ? 'Otros' : 'Other', b.oca + b.oa, '#bae6fd'],
  ].filter(([, v]) => v > 0);
  const liabSegs = [
    [t.kpi.revenue === 'Ingresos' ? 'Pasivos corrientes' : 'Current liab.', b.cl, '#b91c1c'],
    [t.kpi.revenue === 'Ingresos' ? 'Deuda largo plazo' : 'Long-term debt', b.ltl, '#fb923c'],
    [t.kpi.revenue === 'Ingresos' ? 'Capital' : 'Equity', Math.max(0, b.equity), '#0f766e'],
  ].filter(([, v]) => v > 0);
  return (
    <Section title={t.balanceTitle}>
      <StackedBar segs={assetsSegs} total={b.totalAssets} label={fmtCurrencyFull(b.totalAssets)} />
      <div style={{ height: 12 }} />
      <StackedBar segs={liabSegs} total={b.totalAssets} label={fmtCurrencyFull(b.totalAssets)} />
    </Section>
  );
}

function StackedBar({ segs, total, label }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#64748b', marginBottom: 6, fontWeight: 600 }}>
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', height: 26, borderRadius: 6, overflow: 'hidden', background: '#f1f5f9' }}>
        {segs.map(([name, v, color], i) => {
          const pct = (v / total) * 100;
          return (
            <div key={i} style={{
              width: `${pct}%`, background: color, color: '#fff',
              fontSize: 11, fontWeight: 700, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden', whiteSpace: 'nowrap',
            }} title={`${name}: ${fmtCurrencyFull(v)} (${pct.toFixed(1)}%)`}>
              {pct >= 10 && `${pct.toFixed(0)}%`}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 12, color: '#475569' }}>
        {segs.map(([name, v, color], i) => (
          <span key={i}>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: color, borderRadius: 2, marginRight: 6, verticalAlign: 'middle' }} />
            {name}: <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCurrencyFull(v)}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function HealthSection({ r, t }) {
  const cur = totalsFromReport(r);
  const b = balanceTotals(r);
  const monthlyOpex = cur.opex > 0 ? cur.opex / 12 : 0;
  const ratios = [
    { key: 'net_margin',     value: cur.revenueTotal ? (cur.netIncome / cur.revenueTotal) * 100 : 0, display: (v) => fmtPct(v), good: (v) => v >= 5, warn: (v) => v >= 0 },
    { key: 'gross_margin',   value: cur.grossMargin, display: (v) => fmtPct(v), good: (v) => v >= 50, warn: (v) => v >= 25 },
    { key: 'months_of_cash', value: monthlyOpex ? b.cash / monthlyOpex : 0, display: (v) => `${v.toFixed(1)}`, good: (v) => v >= 3, warn: (v) => v >= 1 },
    { key: 'debt_to_equity', value: b.equity > 0 ? b.totalLiab / b.equity : 0, display: (v) => v.toFixed(2), good: (v) => v <= 1, warn: (v) => v <= 2.5 },
  ];
  return (
    <Section title={t.healthTitle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {ratios.map(rt => {
          const meta = t.ratios[rt.key];
          const status = rt.good(rt.value) ? 'good' : rt.warn(rt.value) ? 'watch' : 'risk';
          const badgeMap = {
            good:  { bg: '#dcfce7', color: '#166534', label: t.badgeGood },
            watch: { bg: '#fef3c7', color: '#92400e', label: t.badgeWatch },
            risk:  { bg: '#fee2e2', color: '#b91c1c', label: t.badgeRisk },
          };
          const bd = badgeMap[status];
          return (
            <div key={rt.key} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, background: '#fff' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em' }}>{meta.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{rt.display(rt.value)}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{meta.note}</div>
              <div style={{ display: 'inline-block', marginTop: 6, padding: '2px 6px', borderRadius: 4,
                            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
                            background: bd.bg, color: bd.color }}>{bd.label}</div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function DownloadsSection({ r, token, t }) {
  if (!r.has_pl_pdf && !r.has_balance_pdf) return null;
  const url = (kind) => `/api/m/tax/report-access/${encodeURIComponent(token)}/reports/${encodeURIComponent(r.id)}/pdf/${kind}`;
  return (
    <Section title={t.downloads}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {r.has_pl_pdf && (
          <a href={url('pl')} target="_blank" rel="noopener noreferrer"
             style={{ padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 10, color: '#0f766e', fontWeight: 600, fontSize: 13, textDecoration: 'none', background: '#fff' }}>
            📄 {t.pdfPl}
          </a>
        )}
        {r.has_balance_pdf && (
          <a href={url('balance')} target="_blank" rel="noopener noreferrer"
             style={{ padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 10, color: '#0f766e', fontWeight: 600, fontSize: 13, textDecoration: 'none', background: '#fff' }}>
            📄 {t.pdfBalance}
          </a>
        )}
      </div>
    </Section>
  );
}
