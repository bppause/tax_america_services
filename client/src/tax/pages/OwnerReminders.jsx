import { useEffect, useMemo, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { displayPersonName } from '../lib/personName';

// Upcoming reminders dashboard — shows every filing period that's about
// to fire (or has just fired) so the owner can see what's queued and
// manually send a reminder when needed. Filters mirror the customer
// search page: text search across customer name/email + service +
// status + due window.
//
// Staff see the same data but scoped server-side to their assigned
// customers.

const PORTAL_OFF_LIMIT_STATUS = new Set(['filed']);

export default function OwnerReminders() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [rows, setRows] = useState(null);
  const [products, setProducts] = useState([]);
  const [err, setErr] = useState('');
  const [filters, setFilters] = useState({
    q: '', status: 'active', due: 'month', productId: '',
  });
  const searchTimer = useRef(null);

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminListUpcomingReminders(auth, { communitySlug: community.id, ...filters })
      .then(d => setRows(d.rows || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };

  useEffect(() => {
    if (!employee || !community) return;
    taxApi.adminListProducts(auth, community.id)
      .then(d => setProducts(d.products || []))
      .catch(() => setProducts([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, filters]);

  if (err) return <EmployeeShell community={community} active="reminders">
    <div className="tax-msg tax-msg--error">{err}</div>
  </EmployeeShell>;

  return (
    <EmployeeShell community={community} active="reminders">
      <h2 style={{ margin: 0 }}>{t('owner.reminders.title')}</h2>
      <p className="tax-section__lede">{t('owner.reminders.subtitle')}</p>

      <Filters filters={filters} setFilters={setFilters} products={products}
               locale={locale} t={t} />

      {rows === null ? <p>{t('loading')}</p>
        : rows.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.reminders.empty')}</p>
          : <div style={{ display: 'grid', gap: 8 }}>
              {rows.map(r => (
                <ReminderRow key={r.id} row={r} auth={auth} onChange={load}
                             locale={locale} t={t} />
              ))}
            </div>}
    </EmployeeShell>
  );
}

function Filters({ filters, setFilters, products, locale, t }) {
  const set = (k, v) => setFilters(prev => ({ ...prev, [k]: v }));
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 16,
                  padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8 }}>
      <input type="search" value={filters.q} onChange={e => set('q', e.target.value)}
             placeholder={t('owner.reminders.searchPlaceholder')}
             style={{ padding: '8px 10px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <select value={filters.status} onChange={e => set('status', e.target.value)}>
          <option value="active">{t('owner.reminders.status.active')}</option>
          <option value="pending">{t('owner.reminders.status.pending')}</option>
          <option value="info_requested">{t('owner.reminders.status.info_requested')}</option>
          <option value="info_received">{t('owner.reminders.status.info_received')}</option>
          <option value="filed">{t('owner.reminders.status.filed')}</option>
          <option value="all">{t('owner.reminders.status.all')}</option>
        </select>
        <select value={filters.due} onChange={e => set('due', e.target.value)}>
          <option value="overdue">{t('owner.reminders.due.overdue')}</option>
          <option value="today">{t('owner.reminders.due.today')}</option>
          <option value="week">{t('owner.reminders.due.week')}</option>
          <option value="month">{t('owner.reminders.due.month')}</option>
          <option value="all">{t('owner.reminders.due.all')}</option>
        </select>
        <select value={filters.productId} onChange={e => set('productId', e.target.value)}>
          <option value="">{t('owner.reminders.anyService')}</option>
          {products.map(p => (
            <option key={p.id} value={p.id}>{pickI18n(p.name_i18n, locale).value || p.slug}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ReminderRow({ row, auth, onChange, locale, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  const customer = row.customer || {};
  const schedule = row.schedule || row.workflow || null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = row.due_date && row.due_date < today && row.status !== 'info_received' && row.status !== 'filed';
  const last = row.lastEmail;

  const onSend = async (force) => {
    if (force && !window.confirm(t('owner.reminders.resendConfirm'))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminSendReminderNow(auth, row.id, { force: !!force });
      if (r.sent) {
        setMsg({ kind: 'success', text: t('owner.reminders.sent') });
      } else {
        setMsg({ kind: 'success', text: t('owner.reminders.alreadySent') });
      }
      onChange();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || '' });
    } finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item" style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            <a href={`/tax/${row.community_id}/employee/customers/${encodeURIComponent(customer.id || '')}`}
               style={{ color: 'inherit', textDecoration: 'none' }}>
              {displayPersonName(customer) || customer.email}
            </a>
            <StatusChip status={row.status} t={t} />
            {overdue && <OverdueChip t={t} />}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--tax-muted)', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <span><strong>{t('owner.reminders.field.service')}:</strong>{' '}
              {schedule ? pickI18n(schedule.name_i18n, locale).value : row.period_label}</span>
            <span><strong>{t('owner.reminders.field.period')}:</strong> {row.period_label}</span>
            <span style={overdue ? { color: '#b91c1c', fontWeight: 600 } : undefined}>
              <strong>{t('owner.reminders.field.due')}:</strong> {row.due_date}
            </span>
            {customer.email && <span>· {customer.email}</span>}
          </div>
          <EngagementLine last={last} t={t} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, alignItems: 'flex-end' }}>
          {!last && (
            <button type="button" onClick={() => onSend(false)} disabled={busy}
                    className="tax-btn tax-btn--primary tax-btn--sm">
              {busy ? t('lead.submitting') : t('owner.reminders.sendNow')}
            </button>
          )}
          {last && (
            <button type="button" onClick={() => onSend(true)} disabled={busy}
                    className="tax-btn tax-btn--ghost tax-btn--sm"
                    style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
              {busy ? t('lead.submitting') : t('owner.reminders.resend')}
            </button>
          )}
        </div>
      </div>
      {msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginTop: 0 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status, t }) {
  const color = {
    pending:        { bg: '#fef3c7', fg: '#92400e' },
    info_requested: { bg: '#e0e7ff', fg: '#3730a3' },
    info_received:  { bg: '#dcfce7', fg: '#166534' },
    filed:          { bg: '#dbeafe', fg: '#1e40af' },
  }[status] || { bg: '#f3f4f6', fg: '#6b7280' };
  return (
    <span style={{
      marginLeft: 8, padding: '1px 8px', borderRadius: 999,
      background: color.bg, color: color.fg,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    }}>{t(`owner.reminders.status.${status}`, { _: status })}</span>
  );
}
function OverdueChip({ t }) {
  return (
    <span style={{
      marginLeft: 6, padding: '1px 8px', borderRadius: 999,
      background: '#fee2e2', color: '#991b1b',
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    }}>{t('owner.reminders.overdue')}</span>
  );
}

function EngagementLine({ last, t }) {
  if (!last) return (
    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--tax-muted)' }}>
      {t('owner.reminders.engagement.notSent')}
    </div>
  );
  const dt = (s) => s ? new Date(s).toLocaleString() : '';
  const opened = !!last.opened_at;
  const clicked = !!last.clicked_at;
  const bounced = !!last.bounced_at;
  return (
    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--tax-muted)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <span><strong>{t('owner.reminders.engagement.sent')}:</strong> {dt(last.sent_at || last.created_at)}</span>
      {opened && (
        <span style={{ color: '#166534', fontWeight: 600 }}>
          ✓ {t('owner.reminders.engagement.opened')} {dt(last.opened_at)}
          {last.open_count > 1 && ` (${last.open_count}×)`}
        </span>
      )}
      {!opened && !bounced && (
        <span style={{ color: '#92400e' }}>{t('owner.reminders.engagement.notOpened')}</span>
      )}
      {clicked && (
        <span style={{ color: '#1e40af' }}>↗ {t('owner.reminders.engagement.clicked')}</span>
      )}
      {bounced && (
        <span style={{ color: '#991b1b', fontWeight: 600 }}>⚠ {t('owner.reminders.engagement.bounced')}</span>
      )}
    </div>
  );
}
