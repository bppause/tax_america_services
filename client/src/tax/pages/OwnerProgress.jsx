import { Fragment, useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import TaskHover from '../components/TaskHover';
import { displayPersonName } from '../lib/personName';
import { MultiSelect, NO_SERVICE_ID } from './OwnerTasks';

const PRIORITY_OPTIONS = ['urgent', 'high', 'normal', 'low'];
const DUE_OPTIONS = ['overdue', 'today', 'week', 'month', 'month60', 'month90'];

// Overall task progress dashboard. Shows every task (across every
// service, including practice-wide ones) with the same filter surface
// as the Tasks page, grouped by customer so the owner can scan who's
// behind — and drill down into the actual task list, deep-linking
// into the Tasks page's edit modal for details. Service isn't a
// grouping dimension here — it's purely a filter (including a "No
// service" option), so there's no permanent "No service" section
// cluttering the view when the owner isn't filtering on it.
export default function OwnerProgress() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [expandedRows, setExpandedRows] = useState({}); // per-customer task drill-down
  const [employees, setEmployees] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [statuses, setStatuses] = useState([]);
  // customerType is a chip filter ('all' | 'individual' | 'business')
  // that mirrors the Customers list, Leads inbox, and Tasks page so
  // the filter language stays the same across the employee portal.
  // serviceId mirrors the Tasks page's Service filter — empty array
  // means "all tasks" (the default, for consistency with Tasks), one
  // or more real product ids narrows to those services, and the
  // NO_SERVICE_ID pseudo-id isolates practice-wide tasks. status/
  // priority/due/q mirror the rest of the Tasks page's filter set.
  const [filters, setFilters] = useState({
    customerType: 'all', assignedTo: '', customerId: '', serviceId: [],
    status: [], priority: '', due: '', q: '',
  });

  // Reference data for the filter dropdowns. Load once per community.
  useEffect(() => {
    if (!employee || !community) return;
    Promise.all([
      taxApi.adminListEmployees(auth, community.id).catch(() => ({ employees: [] })),
      taxApi.adminListCustomers(auth, community.id).catch(() => ({ customers: [] })),
      taxApi.adminListProducts(auth, community.id).catch(() => ({ products: [] })),
      taxApi.adminListTaskStatuses(auth, community.id).catch(() => ({ statuses: [] })),
    ]).then(([e, c, p, s]) => {
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
      setCustomers(c.customers || []);
      setProducts(p.products || []);
      setStatuses(s.statuses || []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const statusById = new Map(statuses.map(s => [s.key, s]));
  const statusLabel = (key) => {
    const s = statusById.get(key);
    return s ? (pickI18n(s.label_i18n, locale).value || key) : key;
  };

  // Search box debounces like the Tasks page so typing doesn't refetch
  // on every keystroke.
  // Pulled out of the debounced effect below so a task delete (from the
  // drill-down's hover card) can also trigger an immediate refetch,
  // without waiting for the 200ms filter-change debounce.
  const reload = () => {
    if (!employee || !community) return;
    setData(null);
    taxApi.adminTaskProgress(auth, {
      communitySlug: community.id,
      assignedTo: filters.assignedTo,
      customerId: filters.customerId,
      customerType: filters.customerType !== 'all' ? filters.customerType : undefined,
      serviceId: filters.serviceId.join(','),
      status: filters.status.join(','),
      priority: filters.priority,
      due: filters.due,
      q: filters.q,
    })
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };

  const searchTimer = useRef(null);
  useEffect(() => {
    if (!employee || !community) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(reload, 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, filters.assignedTo, filters.customerId, filters.customerType,
      filters.serviceId, filters.status, filters.priority, filters.due, filters.q]);

  if (err) return <EmployeeShell community={community} active="progress">
    <div className="tax-msg tax-msg--error">{err}</div>
  </EmployeeShell>;
  if (data === null) return <EmployeeShell community={community} active="progress">
    <p>{t('loading')}</p>
  </EmployeeShell>;

  const t0 = data.totals || { open: 0, in_progress: 0, done: 0, overdue: 0 };
  const grand = t0.open + t0.in_progress + t0.done;
  const donePct = grand ? Math.round((t0.done / grand) * 100) : 0;

  return (
    <EmployeeShell community={community} active="progress">
      <h2 style={{ margin: 0 }}>{t('owner.progress.title')}</h2>
      <p className="tax-section__lede">{t('owner.progress.subtitle')}</p>

      {/* Filter container — same tax-bg-alt panel pattern the Tasks
          page uses, with the same All / Individual / Business chip
          row up top so the surfaces feel like one product. */}
      <div style={{ display: 'grid', gap: 10, marginBottom: 16,
                    padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {[
            { key: 'all',        label: t('owner.customers.typeFilter.all') },
            { key: 'individual', label: t('owner.customers.customerType.individual') },
            { key: 'business',   label: t('owner.customers.customerType.business') },
          ].map(opt => {
            const active = (filters.customerType || 'all') === opt.key;
            return (
              <button key={opt.key} type="button"
                      onClick={() => setFilters(prev => ({ ...prev, customerType: opt.key }))}
                      style={{
                        padding: '4px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                        background: active
                          ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                          : '#fff',
                        color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                        border: '1px solid',
                        borderColor: active
                          ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                          : 'var(--tax-border)',
                        fontWeight: active ? 700 : 500,
                      }}>
                {opt.label}
              </button>
            );
          })}
          {(filters.customerType !== 'all' || filters.assignedTo || filters.customerId
            || filters.serviceId.length > 0 || filters.status.length > 0
            || filters.priority || filters.due || filters.q) && (
            <button type="button"
                    onClick={() => setFilters({
                      customerType: 'all', assignedTo: '', customerId: '', serviceId: [],
                      status: [], priority: '', due: '', q: '',
                    })}
                    style={{
                      marginLeft: 'auto', border: 0, background: 'transparent',
                      color: 'var(--tax-brand-primary)', cursor: 'pointer',
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '.04em',
                    }}>
              × {t('owner.progress.filter.clear')}
            </button>
          )}
        </div>
        <div style={{ display: 'grid', gap: 8,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.progress.filter.owner')}
            </span>
            <select value={filters.assignedTo}
                    onChange={e => setFilters(prev => ({ ...prev, assignedTo: e.target.value }))}>
              <option value="">{t('owner.progress.filter.anyOwner')}</option>
              {employees.map(em => (
                <option key={em.id} value={em.id}>
                  {displayPersonName(em) || em.email}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.progress.filter.customer')}
            </span>
            <select value={filters.customerId}
                    onChange={e => setFilters(prev => ({ ...prev, customerId: e.target.value }))}>
              <option value="">{t('owner.progress.filter.anyCustomer')}</option>
              {customers
                .filter(c => filters.customerType === 'all'
                  || (c.customer_type || 'individual') === filters.customerType)
                .map(c => (
                  <option key={c.id} value={c.id}>
                    {c.business_name || displayPersonName(c) || c.email}
                  </option>
                ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.tasks.field.service')}
            </span>
            <MultiSelect
              label={t('owner.tasks.filter.anyService')}
              options={[
                { id: NO_SERVICE_ID, label: t('owner.tasks.filter.noService') },
                ...products.map(p => ({ id: p.id, label: pickI18n(p.name_i18n, locale).value || p.slug })),
              ]}
              value={filters.serviceId}
              onToggle={id => setFilters(prev => ({
                ...prev,
                serviceId: prev.serviceId.includes(id)
                  ? prev.serviceId.filter(x => x !== id)
                  : [...prev.serviceId, id],
              }))}
              onClear={() => setFilters(prev => ({ ...prev, serviceId: [] }))}
              searchable={products.length > 8}
              searchPlaceholder={t('owner.tasks.filter.searchServices')}
              t={t}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.tasks.field.status')}
            </span>
            <MultiSelect
              label={t('owner.tasks.filter.allStatuses')}
              options={statuses.map(s => ({ id: s.key, label: pickI18n(s.label_i18n, locale).value || s.key }))}
              value={filters.status}
              onToggle={id => setFilters(prev => ({
                ...prev,
                status: prev.status.includes(id) ? prev.status.filter(x => x !== id) : [...prev.status, id],
              }))}
              onClear={() => setFilters(prev => ({ ...prev, status: [] }))}
              searchable={statuses.length > 8}
              t={t}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.tasks.field.priority')}
            </span>
            <select value={filters.priority}
                    onChange={e => setFilters(prev => ({ ...prev, priority: e.target.value }))}>
              <option value="">{t('owner.tasks.filter.allPriorities')}</option>
              {PRIORITY_OPTIONS.map(p => (
                <option key={p} value={p}>{t(`owner.tasks.priority.${p}`)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.tasks.field.due')}
            </span>
            <select value={filters.due}
                    onChange={e => setFilters(prev => ({ ...prev, due: e.target.value }))}>
              <option value="">{t('owner.tasks.chip.all')}</option>
              {DUE_OPTIONS.map(d => (
                <option key={d} value={d}>{t(`owner.tasks.chip.${d === 'week' ? 'week7' : d === 'month' ? 'month30' : d}`)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, gridColumn: '1 / -1' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                           textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.progress.filter.search')}
            </span>
            <input type="search" value={filters.q}
                   onChange={e => setFilters(prev => ({ ...prev, q: e.target.value }))}
                   placeholder={t('owner.tasks.searchPlaceholder')}
                   style={{ padding: '6px 10px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 20 }}>
        <Stat label={t('owner.progress.kpi.done')}        value={t0.done}        color="#166534" sub={`${donePct}% ${t('owner.progress.kpi.ofAll')}`} />
        <Stat label={t('owner.progress.kpi.inProgress')}  value={t0.in_progress} color="#3730a3" />
        <Stat label={t('owner.progress.kpi.open')}        value={t0.open}        color="#92400e" />
        <Stat label={t('owner.progress.kpi.overdue')}     value={t0.overdue}     color="#991b1b" />
      </div>

      {(!data.customers || data.customers.length === 0) ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.progress.empty')}</p>
      ) : (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse',
                        border: '1px solid var(--tax-border)', borderRadius: 10, overflow: 'hidden' }}>
          <thead>
            <tr style={{ color: 'var(--tax-muted)', fontSize: 11, textTransform: 'uppercase', textAlign: 'left',
                         background: 'var(--tax-bg-alt)' }}>
              <th style={{ padding: '8px 10px' }}>{t('owner.progress.col.customer')}</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>{t('owner.progress.col.done')}</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>{t('owner.progress.col.inProgress')}</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>{t('owner.progress.col.open')}</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>{t('owner.progress.col.overdue')}</th>
              <th style={{ padding: '8px 10px', minWidth: 130 }}>{t('owner.progress.col.progress')}</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map(c => {
              const cpct = c.total ? Math.round((c.done / c.total) * 100) : 0;
              const rowOpen = !!expandedRows[c.id];
              const customerLabel = c.id === '__none__'
                ? t('owner.progress.noCustomerRow')
                : (c.customer?.business_name || displayPersonName(c.customer) || c.customer?.email || c.id);
              return (
                <Fragment key={c.id}>
                  <tr style={{ borderTop: '1px solid var(--tax-border)', cursor: 'pointer' }}
                      onClick={() => setExpandedRows(s => ({ ...s, [c.id]: !s[c.id] }))}>
                    <td style={{ padding: '8px 10px' }}>
                      <span aria-hidden="true" style={{
                        display: 'inline-block', width: 12, fontSize: 10, color: 'var(--tax-muted)',
                        transform: rowOpen ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform .12s ease',
                      }}>▸</span>
                      {' '}
                      {c.id === '__none__' ? (
                        <span>{customerLabel}</span>
                      ) : (
                        <a href={`/tax/${community.id}/employee/customers/${encodeURIComponent(c.id)}`}
                           onClick={e => e.stopPropagation()}
                           style={{ color: 'inherit', textDecoration: 'none' }}>
                          {customerLabel}
                        </a>
                      )}
                      <span style={{ marginLeft: 8, color: 'var(--tax-muted)', fontWeight: 400 }}>
                        · {c.total} {(c.total === 1 ? t('owner.progress.taskSingular') : t('owner.progress.taskPlural'))}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: '#166534' }}>{c.done}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.in_progress}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.open}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right',
                                 color: c.overdue > 0 ? '#991b1b' : 'inherit',
                                 fontWeight: c.overdue > 0 ? 700 : 400 }}>{c.overdue}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <ProgressBar pct={cpct} width={100} />
                        <span style={{ minWidth: 36, color: 'var(--tax-muted)' }}>{cpct}%</span>
                      </div>
                    </td>
                  </tr>
                  {rowOpen && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 10px 12px 28px', borderTop: 'none', background: 'var(--tax-bg-alt)' }}>
                        <TaskDrillDown tasks={c.tasks} community={community} statuses={statuses}
                                        statusLabel={statusLabel} onDeleted={reload} locale={locale} t={t} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </EmployeeShell>
  );
}

// Individual-task drill-down under a customer row. Each title links
// straight into the Tasks page with that task's edit modal open — the
// same ?edit= deep link the task-assigned / status-changed emails use
// — so "drill into task details" doesn't require rebuilding the whole
// edit modal here.
function TaskDrillDown({ tasks, community, statuses, statusLabel, onDeleted, locale, t }) {
  if (!tasks || tasks.length === 0) {
    return <p style={{ color: 'var(--tax-muted)', fontSize: 12, margin: '4px 0' }}>{t('owner.progress.noTasks')}</p>;
  }
  const today = new Date().toISOString().slice(0, 10);
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <tbody>
        {tasks.map(tt => {
          const overdue = tt.due_date && tt.due_date < today && !tt.completed_at;
          return (
            <tr key={tt.id} style={{ borderTop: '1px solid var(--tax-border)' }}>
              <td style={{ padding: '6px 6px' }}>
                <TaskHover task={tt} statuses={statuses} community={community}
                           onDeleted={onDeleted} locale={locale} t={t}>
                  <a href={`/tax/${community.id}/employee/tasks?edit=${encodeURIComponent(tt.id)}`}
                     onClick={e => e.stopPropagation()}
                     style={{ color: 'var(--tax-brand-primary)', textDecoration: 'none', fontWeight: 600 }}>
                    {tt.title}
                  </a>
                </TaskHover>
              </td>
              <td style={{ padding: '6px 6px', color: 'var(--tax-muted)' }}>
                {tt.product ? (pickI18n(tt.product.name_i18n, locale).value || tt.product.slug) : t('owner.tasks.filter.noService')}
              </td>
              <td style={{ padding: '6px 6px', color: 'var(--tax-muted)' }}>{statusLabel(tt.status_key)}</td>
              <td style={{ padding: '6px 6px', color: 'var(--tax-muted)' }}>
                {tt.priority && tt.priority !== 'normal' ? t(`owner.tasks.priority.${tt.priority}`) : ''}
              </td>
              <td style={{ padding: '6px 6px', textAlign: 'right',
                           color: overdue ? '#991b1b' : 'var(--tax-muted)',
                           fontWeight: overdue ? 700 : 400 }}>
                {tt.due_date || ''}
              </td>
              <td style={{ padding: '6px 6px', color: 'var(--tax-muted)' }}>
                {tt.assignee ? (displayPersonName(tt.assignee) || tt.assignee.email) : ''}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div style={{
      padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
      background: '#fff',
    }}>
      <div style={{ fontSize: 11, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function ProgressBar({ pct, width = 100 }) {
  return (
    <div style={{
      width, height: 8, borderRadius: 999,
      background: 'var(--tax-bg-alt)', overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%',
        background: pct >= 80 ? '#166534' : pct >= 40 ? 'var(--tax-brand-primary)' : '#92400e',
      }} />
    </div>
  );
}
