import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import SetupBanner from '../components/SetupBanner';

function relTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m`;
    if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)}h`;
    return d.toLocaleDateString();
  } catch (_e) { return ''; }
}

export default function EmployeeInbox() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [threads, setThreads] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'unread'
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!employee || !community) return;
    taxApi.getEmployeeThreads(auth)
      .then(d => setThreads(d.threads || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const base = community ? `/tax/${community.id}/employee` : '#';
  const shown = !threads ? null
    : (filter === 'unread' ? threads.filter(th => th.practice_unread) : threads);
  const unreadCount = (threads || []).filter(th => th.practice_unread).length;

  return (
    <EmployeeShell community={community} active="inbox">
      <SetupBanner />

      <TodayInbox auth={auth} community={community} t={t} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 8px' }}>
        <h2 style={{ margin: 0 }}>{t('employee.inbox.title')}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button"
                  className={`tax-btn tax-btn--sm ${filter === 'all' ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                  onClick={() => setFilter('all')}
                  style={filter !== 'all' ? { color: 'var(--tax-text)', borderColor: 'var(--tax-border)' } : undefined}>
            {t('employee.inbox.filterAll')}
          </button>
          <button type="button"
                  className={`tax-btn tax-btn--sm ${filter === 'unread' ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                  onClick={() => setFilter('unread')}
                  style={filter !== 'unread' ? { color: 'var(--tax-text)', borderColor: 'var(--tax-border)' } : undefined}>
            {t('employee.inbox.filterUnread', { count: unreadCount })}
          </button>
        </div>
      </div>
      <p className="tax-section__lede">{t('employee.inbox.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {shown === null ? <p>{t('loading')}</p>
        : shown.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>
              {filter === 'unread' ? t('employee.inbox.emptyUnread') : t('employee.inbox.empty')}
            </p>
          : <div style={{ display: 'grid', gap: 8 }}>
              {shown.map(th => (
                <a key={th.id} href={`${base}/threads/${encodeURIComponent(th.id)}`}
                   className="tax-contact-item"
                   style={{
                     textDecoration: 'none', color: 'inherit',
                     borderLeft: th.practice_unread ? '3px solid var(--tax-brand-secondary)' : '3px solid transparent',
                   }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <div style={{ fontWeight: th.practice_unread ? 700 : 600,
                                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {th.subject || t('employee.inbox.untitled')}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--tax-muted)', flexShrink: 0 }}>
                          {th.customer?.name || th.customer?.email || ''}
                        </div>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 4,
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {th.last_message_by_role === 'customer'
                          ? <strong style={{ color: 'var(--tax-text)' }}>{t('employee.inbox.fromCustomer')}</strong>
                          : <span>{t('employee.inbox.fromPractice')}</span>}
                        {' — '}{th.last_message_preview || ''}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--tax-muted)' }}>
                      {relTime(th.last_message_at || th.created_at)}
                    </div>
                  </div>
                </a>
              ))}
            </div>
      }
    </EmployeeShell>
  );
}

// Phase 4n.23: triage / "today" panel above the message list. Folds the
// four signals staff actually scan every morning into one block so the
// inbox page becomes "what needs my attention" instead of just "did
// anybody message me?". Each row deep-links to the customer detail or
// thread page so the cost of starting the next action is one click.
function TodayInbox({ auth, community, t }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!auth?.uid || !community) return;
    taxApi.getEmployeeTriage(auth, 7)
      .then(d => setData(d))
      .catch(e => setErr(e?.message || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.uid, community?.id]);

  if (err) {
    return (
      <div className="tax-msg tax-msg--error" style={{ marginBottom: 16 }}>{err}</div>
    );
  }
  if (!data) return null;

  const pendingSignatures = data.pendingSignatures || [];
  const total = data.overdue.length + data.dueSoon.length + data.unreadCount + data.newLeads.length + pendingSignatures.length;
  const allCaughtUp = total === 0;

  return (
    <section style={{ marginBottom: 8 }}>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>{t('employee.today.title')}</h2>
      <p className="tax-section__lede" style={{ marginTop: 0 }}>
        {t('employee.today.subtitle', { days: data.windowDays })}
      </p>

      {allCaughtUp && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 18px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--tax-success) 8%, #fff)',
          border: '1px solid var(--tax-success)', color: 'var(--tax-success)',
        }}>
          <span style={{ fontSize: 24 }}>✓</span>
          <div>
            <div style={{ fontWeight: 700 }}>{t('employee.today.allCaughtUp')}</div>
            <div style={{ fontSize: 13, marginTop: 2 }}>
              {t('employee.today.allCaughtUpSubtitle')}
            </div>
          </div>
        </div>
      )}

      {!allCaughtUp && (
        <div style={{ display: 'grid', gap: 12 }}>
          <Bucket tone="danger"
                  title={t('employee.today.overdueTitle', { count: data.overdue.length })}
                  empty={t('employee.today.overdueEmpty')}>
            {data.overdue.map(p => <PeriodRow key={p.id} p={p} community={community} t={t} variant="overdue" />)}
          </Bucket>
          <Bucket tone="warn"
                  title={t('employee.today.dueSoonTitle', { count: data.dueSoon.length, days: data.windowDays })}
                  empty={t('employee.today.dueSoonEmpty')}>
            {data.dueSoon.map(p => <PeriodRow key={p.id} p={p} community={community} t={t} variant="due-soon" />)}
          </Bucket>
          {data.unreadCount > 0 && (
            <Bucket tone="info"
                    title={t('employee.today.unreadTitle', { count: data.unreadCount })}
                    empty="">
              <a href={`/tax/${community.id}/employee#unread`}
                 className="tax-contact-item"
                 style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                {t('employee.today.unreadCta')}
              </a>
            </Bucket>
          )}
          {data.newLeads.length > 0 && (
            <Bucket tone="info"
                    title={t('employee.today.newLeadsTitle', { count: data.newLeads.length })}
                    empty="">
              {data.newLeads.map(l => (
                <a key={l.id} href={`/tax/${community.id}/employee/leads`}
                   className="tax-contact-item"
                   style={{ display: 'flex', textDecoration: 'none', color: 'inherit',
                            justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{l.name || l.email}</div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{l.email}</div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)', flexShrink: 0 }}>
                    {relTime(l.created_at)}
                  </div>
                </a>
              ))}
            </Bucket>
          )}
          {pendingSignatures.length > 0 && (
            <Bucket tone="warn"
                    title={t('employee.today.signaturesTitle', { count: pendingSignatures.length })}
                    empty="">
              {pendingSignatures.map(s => (
                <a key={s.id}
                   href={`/tax/${community.id}/employee/customers/${encodeURIComponent(s.customer_id)}`}
                   className="tax-contact-item"
                   style={{ display: 'flex', textDecoration: 'none', color: 'inherit',
                            justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {s.customer?.name || s.customer?.email || s.customer_id}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                      {s.title}{s.requested_by_name ? ` · ${t('employee.today.signatureRequestedBy', { name: s.requested_by_name })}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)', flexShrink: 0 }}>
                    {relTime(s.created_at)}
                  </div>
                </a>
              ))}
            </Bucket>
          )}
          {data.recent.length > 0 && (
            <Bucket tone="ok"
                    title={t('employee.today.recentTitle', { count: data.recent.length, days: data.windowDays })}
                    empty="">
              {data.recent.map(p => <PeriodRow key={p.id} p={p} community={community} t={t} variant="recent" />)}
            </Bucket>
          )}
        </div>
      )}
    </section>
  );
}

function Bucket({ tone, title, children, empty }) {
  const colors = {
    danger: { bar: '#b91c1c', chip: '#fee', chipText: '#a00' },
    warn:   { bar: 'var(--tax-brand-secondary)', chip: 'color-mix(in srgb, var(--tax-brand-secondary) 14%, #fff)', chipText: 'var(--tax-brand-secondary)' },
    info:   { bar: 'var(--tax-brand-primary)',  chip: 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)', chipText: 'var(--tax-brand-primary)' },
    ok:     { bar: 'var(--tax-success)',         chip: '#dcfce7', chipText: '#166534' },
  }[tone] || {};
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : !!children;
  if (!hasChildren && !empty) return null;
  return (
    <div style={{
      border: '1px solid var(--tax-border)', borderLeft: `4px solid ${colors.bar}`,
      borderRadius: 8, background: '#fff', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px', fontSize: 13, fontWeight: 700,
        background: colors.chip, color: colors.chipText,
      }}>{title}</div>
      <div style={{ display: 'grid', gap: 4, padding: hasChildren ? 8 : 14 }}>
        {hasChildren ? children : (
          <div style={{ fontSize: 13, color: 'var(--tax-muted)' }}>{empty}</div>
        )}
      </div>
    </div>
  );
}

function PeriodRow({ p, community, t, variant }) {
  const cust = p.customer || {};
  const wf = p.workflow || {};
  const sch = p.schedule || {};
  const name = (wf.name_i18n && (wf.name_i18n.es || wf.name_i18n.en))
            || (sch.name_i18n && (sch.name_i18n.es || sch.name_i18n.en))
            || wf.filing_schedule_slug || sch.slug || p.period_label || 'Filing';
  const href = `/tax/${community.id}/employee/customers/${encodeURIComponent(p.customer_id)}`;
  const tone = variant === 'overdue' ? '#b91c1c'
             : variant === 'due-soon' ? 'var(--tax-brand-secondary)'
             : 'var(--tax-success)';
  const today = new Date().toISOString().slice(0, 10);
  let daysLabel = '';
  try {
    const dueMs = new Date(p.due_date + 'T00:00:00Z').getTime();
    const todayMs = new Date(today + 'T00:00:00Z').getTime();
    const days = Math.round((dueMs - todayMs) / 86400000);
    if (variant === 'overdue') daysLabel = t('employee.today.overdueBy', { days: Math.abs(days) });
    else if (variant === 'due-soon') {
      if (days === 0) daysLabel = t('employee.today.dueToday');
      else daysLabel = t('employee.today.dueInDays', { days });
    } else if (variant === 'recent') daysLabel = t('employee.today.recentlyReceived');
  } catch (_e) {}
  return (
    <a href={href} className="tax-contact-item"
       style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: 12, textDecoration: 'none', color: 'inherit' }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{cust.name || cust.email}</div>
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
          {name} · {p.period_label || p.due_date}
        </div>
      </div>
      <div style={{ fontSize: 12, color: tone, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {daysLabel}
      </div>
    </a>
  );
}