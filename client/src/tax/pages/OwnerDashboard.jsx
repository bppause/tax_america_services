import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import TaskHover from '../components/TaskHover';
import { displayPersonName, firstNameOf } from '../lib/personName';

// Today dashboard — the default landing page for employees and the
// owner. Four KPI cards on top, then three short stacks: urgent
// tasks, new leads, and customers needing attention. Every list
// links into the relevant deep-dive page.
export default function OwnerDashboard() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Gate on `employee` (set after both Firebase link AND impersonation
    // resolve) instead of `fbUser`, which stays null during impersonation.
    if (!employee || !community) return;
    taxApi.adminDashboard(auth, community.id)
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee, community]);

  if (err) return <EmployeeShell community={community} active="dashboard">
    <div className="tax-msg tax-msg--error">{err}</div>
  </EmployeeShell>;
  if (data === null) return <EmployeeShell community={community} active="dashboard">
    <p>{t('loading')}</p>
  </EmployeeShell>;

  const isAdmin = data.role === 'admin';
  const k = data.kpis || {};
  const base = community ? `/tax/${community.id}/employee` : '#';

  return (
    <EmployeeShell community={community} active="dashboard">
      <h2 style={{ margin: 0 }}>
        {firstNameOf(employee)
          ? t('owner.dashboard.titleNamed', { name: firstNameOf(employee) })
          : t('owner.dashboard.title')}
      </h2>
      <p className="tax-section__lede">{t('owner.dashboard.subtitle')}</p>

      <div style={{ display: 'grid', gap: 12, marginBottom: 20,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <Kpi label={t('owner.dashboard.kpi.dueToday')}
             value={k.tasks_due_today ?? 0}
             color="#3730a3"
             href={`${base}/tasks?due=today`} />
        <Kpi label={t('owner.dashboard.kpi.overdue')}
             value={k.tasks_overdue ?? 0}
             color="#991b1b"
             href={`${base}/tasks?due=overdue`} />
        {isAdmin && (
          <Kpi label={t('owner.dashboard.kpi.newLeads')}
               value={k.new_leads_7d ?? 0}
               color="#166534"
               sub={t('owner.dashboard.kpi.last7d')}
               href={`${base}/leads`} />
        )}
        <Kpi label={t('owner.dashboard.kpi.completion')}
             value={k.completion_rate_30d?.pct == null
               ? '—'
               : `${k.completion_rate_30d.pct}%`}
             color="#0f766e"
             sub={t('owner.dashboard.kpi.last30d')}
             href={`${base}/progress`} />
      </div>

      {/* Mobile quick-actions: one-tap list shown only on narrow screens.
          On wider screens the full UrgentTasks + NewLeads grid is sufficient. */}
      <MobileQuickActions
        urgentTasks={data.urgentTasks || []}
        newLeads={data.newLeads || []}
        isAdmin={isAdmin}
        base={base}
        community={community}
        auth={auth}
        locale={locale}
        t={t}
      />

      <div style={{
        display: 'grid', gap: 16,
        gridTemplateColumns: isAdmin
          ? 'minmax(0, 1fr) minmax(0, 0.85fr)'
          : 'minmax(0, 1fr)',
      }}>
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <UrgentTasks tasks={data.urgentTasks || []}
                       base={base} community={community} locale={locale} t={t} />
          <NeedsAttention rows={data.needsAttention || []}
                          base={base} t={t} />
        </div>
        {isAdmin && (
          <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
            <NewLeads rows={data.newLeads || []} base={base} t={t} />
          </div>
        )}
      </div>
    </EmployeeShell>
  );
}

// Visible only on narrow screens (≤640 px). Shows the most urgent tasks
// and newest leads in a single tap-friendly list with one-tap status
// updates so the owner can work their queue from a phone without
// navigating into the full task or leads editor.
function MobileQuickActions({ urgentTasks, newLeads, isAdmin, base, community, auth, locale, t }) {
  const [taskStatuses, setTaskStatuses] = useState({});
  const [busy, setBusy] = useState({});
  const es = locale === 'es';

  const today = new Date().toISOString().slice(0, 10);

  const markTask = async (taskId, status) => {
    if (busy[taskId]) return;
    setBusy(b => ({ ...b, [taskId]: true }));
    try {
      await taxApi.adminUpdateTask(auth, taskId, { status });
      setTaskStatuses(s => ({ ...s, [taskId]: status }));
    } catch (_e) { /* fail silently — user can retry */ }
    finally { setBusy(b => ({ ...b, [taskId]: false })); }
  };

  if (urgentTasks.length === 0 && (!isAdmin || newLeads.length === 0)) return null;

  return (
    <div className="tax-mobile-quick-actions" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
                    color: 'var(--tax-muted)', marginBottom: 8 }}>
        {es ? "Acción rápida — hoy" : "Quick actions — today"}
      </div>

      {urgentTasks.map(task => {
        const status = taskStatuses[task.id] || task.status;
        const done = status === 'done' || status === 'complete';
        const isOverdue = task.due_date && task.due_date < today;
        const custName = task.customer?.business_name
          || displayPersonName(task.customer)
          || task.customer?.email || '';
        return (
          <div key={task.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 12px', background: '#fff',
            border: `1px solid ${isOverdue && !done ? '#fca5a5' : 'var(--tax-border)'}`,
            borderRadius: 8, marginBottom: 6,
            opacity: done ? .5 : 1,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {task.title}
              </div>
              {custName && (
                <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>{custName}</div>
              )}
              {isOverdue && !done && (
                <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, marginTop: 2 }}>
                  {es ? 'Vencido' : 'Overdue'}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {!done && (
                <button type="button" disabled={busy[task.id]}
                  onClick={() => markTask(task.id, 'done')}
                  style={{
                    padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                    background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0', cursor: 'pointer',
                  }}>
                  {es ? '✓ Hecho' : '✓ Done'}
                </button>
              )}
              <a href={`${base}/tasks?edit=${encodeURIComponent(task.id)}`}
                 style={{
                   padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                   background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                   border: '1px solid var(--tax-border)', textDecoration: 'none',
                 }}>
                {es ? 'Ver' : 'View'}
              </a>
            </div>
          </div>
        );
      })}

      {isAdmin && newLeads.slice(0, 3).map(lead => {
        const waDigits = String(lead.whatsapp || lead.phone || '').replace(/^\+/, '').replace(/\D+/g, '');
        const waHref = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
          es
            ? `Hola ${lead.first_name || lead.name}, soy de ${community?.name || ''}. Vi tu solicitud de información. ¿Tienes unos minutos para hablar?`
            : `Hi ${lead.first_name || lead.name}, this is ${community?.name || ''}. I saw your inquiry. Do you have a few minutes to chat?`
        )}` : null;
        return (
          <div key={lead.id} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 12px', background: '#fff',
            border: '1px solid #bbf7d0',
            borderRadius: 8, marginBottom: 6,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{lead.name}</div>
              <div style={{ fontSize: 11, color: '#166534', fontWeight: 600, marginTop: 2 }}>
                {es ? '🆕 Nuevo prospecto' : '🆕 New lead'}
              </div>
              {(lead.product_slugs || []).length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
                  {(lead.product_slugs || []).join(', ')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {waHref && (
                <a href={waHref} target="_blank" rel="noopener noreferrer"
                   style={{
                     padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                     background: '#25d366', color: '#fff', textDecoration: 'none',
                   }}>
                  💬
                </a>
              )}
              <a href={`${base}/leads?lead=${encodeURIComponent(lead.id)}`}
                 style={{
                   padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                   background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                   border: '1px solid var(--tax-border)', textDecoration: 'none',
                 }}>
                {es ? 'Ver' : 'View'}
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, color, sub, href }) {
  const inner = (
    <>
      <div style={{ fontSize: 11, color: 'var(--tax-muted)', textTransform: 'uppercase',
                    fontWeight: 700, letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>{sub}</div>}
    </>
  );
  return href ? (
    <a href={href} style={{
      display: 'block', padding: 14,
      border: '1px solid var(--tax-border)', borderRadius: 8,
      background: '#fff', textDecoration: 'none', color: 'inherit',
    }}>{inner}</a>
  ) : (
    <div style={{ padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8, background: '#fff' }}>
      {inner}
    </div>
  );
}

function UrgentTasks({ tasks, base, community, locale, t }) {
  const today = new Date().toISOString().slice(0, 10);
  // Clicking a row jumps to the Tasks page with ?edit=<id> so the same
  // editor used on List / Kanban / Calendar opens for the task.
  const editHref = (id) => `${base}/tasks?edit=${encodeURIComponent(id)}`;
  return (
    <section style={{ border: '1px solid var(--tax-border)', borderRadius: 10,
                       background: '#fff', overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px 14px', borderBottom: '1px solid var(--tax-border)',
                        background: 'var(--tax-bg-alt)' }}>
        <strong style={{ fontSize: 14 }}>{t('owner.dashboard.urgent.heading')}</strong>
        <a href={`${base}/tasks`} style={{ fontSize: 12, color: 'var(--tax-brand-primary)' }}>
          {t('owner.dashboard.viewAll')} →
        </a>
      </header>
      {tasks.length === 0 ? (
        <p style={{ padding: '14px', color: 'var(--tax-muted)', margin: 0, fontSize: 14 }}>
          {t('owner.dashboard.urgent.empty')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {tasks.map(t1 => {
            const isOverdue = t1.due_date && t1.due_date < today;
            const isToday = t1.due_date === today;
            const cust = t1.customer;
            const custName = cust?.business_name
              || displayPersonName(cust)
              || cust?.email
              || t('owner.dashboard.practiceWide');
            return (
              <li key={t1.id} style={{ borderTop: '1px solid var(--tax-border)' }}>
                <TaskHover task={t1} statuses={[]} community={community}
                           locale={locale} t={t}>
                  <a href={editHref(t1.id)}
                     style={{
                       display: 'block', padding: '10px 14px',
                       textDecoration: 'none', color: 'inherit',
                     }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 600, minWidth: 0, flex: 1 }}>{t1.title}</div>
                      <DuePill date={t1.due_date} overdue={isOverdue} today={isToday} t={t} />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--tax-muted)',
                                   display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {cust && <span>{custName}</span>}
                      {t1.product && (
                        <span>· {pickI18n(t1.product.name_i18n, locale).value || t1.product.slug}</span>
                      )}
                      {t1.priority && t1.priority !== 'normal' && (
                        <PriorityChip priority={t1.priority} t={t} />
                      )}
                    </div>
                  </a>
                </TaskHover>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NeedsAttention({ rows, base, t }) {
  return (
    <section style={{ border: '1px solid var(--tax-border)', borderRadius: 10,
                       background: '#fff', overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px 14px', borderBottom: '1px solid var(--tax-border)',
                        background: 'var(--tax-bg-alt)' }}>
        <strong style={{ fontSize: 14 }}>{t('owner.dashboard.needsAttention.heading')}</strong>
        <a href={`${base}/customers`} style={{ fontSize: 12, color: 'var(--tax-brand-primary)' }}>
          {t('owner.dashboard.viewAll')} →
        </a>
      </header>
      {rows.length === 0 ? (
        <p style={{ padding: '14px', color: 'var(--tax-muted)', margin: 0, fontSize: 14 }}>
          {t('owner.dashboard.needsAttention.empty')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map(r => {
            const c = r.customer || {};
            const name = c.business_name
              || displayPersonName(c)
              || c.email
              || r.id;
            return (
              <li key={r.id} style={{ borderTop: '1px solid var(--tax-border)' }}>
                <a href={`${base}/customers/${encodeURIComponent(r.id)}`}
                   style={{
                     display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                     gap: 12, padding: '10px 14px', textDecoration: 'none', color: 'inherit',
                   }}>
                  <span style={{ fontWeight: 600, minWidth: 0, flex: 1 }}>{name}</span>
                  <span style={{
                    padding: '2px 10px', borderRadius: 999,
                    background: '#fee2e2', color: '#991b1b',
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                  }}>
                    {r.overdue} {t('owner.customers.health.overdue')}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NewLeads({ rows, base, t }) {
  return (
    <section style={{ border: '1px solid var(--tax-border)', borderRadius: 10,
                       background: '#fff', overflow: 'hidden' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px 14px', borderBottom: '1px solid var(--tax-border)',
                        background: 'var(--tax-bg-alt)' }}>
        <strong style={{ fontSize: 14 }}>{t('owner.dashboard.leads.heading')}</strong>
        <a href={`${base}/leads`} style={{ fontSize: 12, color: 'var(--tax-brand-primary)' }}>
          {t('owner.dashboard.viewAll')} →
        </a>
      </header>
      {rows.length === 0 ? (
        <p style={{ padding: '14px', color: 'var(--tax-muted)', margin: 0, fontSize: 14 }}>
          {t('owner.dashboard.leads.empty')}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map(lead => {
            const name = displayPersonName(lead) || lead.email;
            const services = Array.isArray(lead.product_slugs) && lead.product_slugs.length
              ? lead.product_slugs.join(', ')
              : (lead.product_slug || '');
            return (
              <li key={lead.id} style={{ borderTop: '1px solid var(--tax-border)' }}>
                <a href={`${base}/leads`} style={{
                  display: 'block', padding: '10px 14px',
                  textDecoration: 'none', color: 'inherit',
                }}>
                  <div style={{ fontWeight: 600 }}>{name}</div>
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                    {lead.email}
                    {services && ` · ${services}`}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DuePill({ date, overdue, today, t }) {
  if (!date) return null;
  const bg = overdue ? '#fee2e2' : today ? '#fef3c7' : '#dbeafe';
  const fg = overdue ? '#991b1b' : today ? '#92400e' : '#1e40af';
  const label = overdue ? t('owner.dashboard.overdue') :
                today  ? t('owner.dashboard.today')   : date;
  return (
    <span style={{
      padding: '1px 8px', borderRadius: 999,
      background: bg, color: fg,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    }}>{label}</span>
  );
}

function PriorityChip({ priority, t }) {
  const c = priority === 'urgent' ? { bg: '#fee2e2', fg: '#991b1b' }
        : priority === 'high'   ? { bg: '#fef3c7', fg: '#92400e' }
        : priority === 'low'    ? { bg: '#f3f4f6', fg: '#6b7280' }
        : { bg: '#e0e7ff', fg: '#3730a3' };
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 999,
      background: c.bg, color: c.fg,
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    }}>{t(`owner.tasks.priority.${priority}`)}</span>
  );
}
