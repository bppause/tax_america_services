import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { displayPersonName } from '../lib/personName';

// Task-completion dashboard. Aggregates every active task by service,
// then by customer, so the owner can scan at a glance which customers
// are caught up and which are behind. Staff see the same view scoped
// to their assignments — the server enforces the filter.
export default function OwnerProgress() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState({});
  const [employees, setEmployees] = useState([]);
  const [customers, setCustomers] = useState([]);
  // customerType is a chip filter ('all' | 'individual' | 'business')
  // that mirrors the Customers list, Leads inbox, and Tasks page so
  // the filter language stays the same across the employee portal.
  const [filters, setFilters] = useState({ customerType: 'all', assignedTo: '', customerId: '' });

  // Reference data for the filter dropdowns. Load once per community.
  useEffect(() => {
    if (!employee || !community) return;
    Promise.all([
      taxApi.adminListEmployees(auth, community.id).catch(() => ({ employees: [] })),
      taxApi.adminListCustomers(auth, community.id).catch(() => ({ customers: [] })),
    ]).then(([e, c]) => {
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
      setCustomers(c.customers || []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  useEffect(() => {
    if (!employee || !community) return;
    setData(null);
    taxApi.adminTaskProgress(auth, {
      communitySlug: community.id,
      assignedTo: filters.assignedTo,
      customerId: filters.customerId,
      customerType: filters.customerType !== 'all' ? filters.customerType : undefined,
    })
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, filters.assignedTo, filters.customerId, filters.customerType]);

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
          {(filters.customerType !== 'all' || filters.assignedTo || filters.customerId) && (
            <button type="button"
                    onClick={() => setFilters({ customerType: 'all', assignedTo: '', customerId: '' })}
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
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 20 }}>
        <Stat label={t('owner.progress.kpi.done')}        value={t0.done}        color="#166534" sub={`${donePct}% ${t('owner.progress.kpi.ofAll')}`} />
        <Stat label={t('owner.progress.kpi.inProgress')}  value={t0.in_progress} color="#3730a3" />
        <Stat label={t('owner.progress.kpi.open')}        value={t0.open}        color="#92400e" />
        <Stat label={t('owner.progress.kpi.overdue')}     value={t0.overdue}     color="#991b1b" />
      </div>

      {(!data.byService || data.byService.length === 0) ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.progress.empty')}</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {data.byService.map(svc => {
            const total = svc.totals.total || 0;
            const pct = total ? Math.round((svc.totals.done / total) * 100) : 0;
            const isOpen = !!expanded[svc.product.id];
            return (
              <section key={svc.product.id} style={{
                border: '1px solid var(--tax-border)', borderRadius: 10,
                background: 'var(--tax-bg)', overflow: 'hidden',
              }}>
                <header style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: 12, padding: '12px 16px', cursor: 'pointer',
                  background: isOpen ? 'var(--tax-bg-alt)' : '#fff',
                  borderBottom: isOpen ? '1px solid var(--tax-border)' : 'none',
                }} onClick={() => setExpanded(s => ({ ...s, [svc.product.id]: !s[svc.product.id] }))}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                      {pickI18n(svc.product.name_i18n, locale).value || svc.product.slug}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      <span><strong style={{ color: '#166534' }}>{svc.totals.done}</strong> {t('owner.progress.kpi.done').toLowerCase()}</span>
                      <span><strong style={{ color: '#3730a3' }}>{svc.totals.in_progress}</strong> {t('owner.progress.kpi.inProgress').toLowerCase()}</span>
                      <span><strong style={{ color: '#92400e' }}>{svc.totals.open}</strong> {t('owner.progress.kpi.open').toLowerCase()}</span>
                      {svc.totals.overdue > 0 && (
                        <span style={{ color: '#991b1b', fontWeight: 600 }}>
                          ⚠ {svc.totals.overdue} {t('owner.progress.kpi.overdue').toLowerCase()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tax-brand-primary)' }}>{pct}%</div>
                    <ProgressBar pct={pct} width={140} />
                  </div>
                  <span aria-hidden="true" style={{
                    fontSize: 14, color: 'var(--tax-muted)',
                    transform: isOpen ? 'rotate(180deg)' : 'rotate(0)',
                    transition: 'transform .12s ease',
                  }}>▾</span>
                </header>
                {isOpen && (
                  <div style={{ padding: '8px 12px 14px' }}>
                    {svc.customers.length === 0 ? (
                      <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{t('owner.progress.noCustomers')}</p>
                    ) : (
                      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ color: 'var(--tax-muted)', fontSize: 11, textTransform: 'uppercase', textAlign: 'left' }}>
                            <th style={{ padding: '8px 6px' }}>{t('owner.progress.col.customer')}</th>
                            <th style={{ padding: '8px 6px', textAlign: 'right' }}>{t('owner.progress.col.done')}</th>
                            <th style={{ padding: '8px 6px', textAlign: 'right' }}>{t('owner.progress.col.inProgress')}</th>
                            <th style={{ padding: '8px 6px', textAlign: 'right' }}>{t('owner.progress.col.open')}</th>
                            <th style={{ padding: '8px 6px', textAlign: 'right' }}>{t('owner.progress.col.overdue')}</th>
                            <th style={{ padding: '8px 6px', minWidth: 110 }}>{t('owner.progress.col.progress')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {svc.customers.map(c => {
                            const cpct = c.total ? Math.round((c.done / c.total) * 100) : 0;
                            return (
                              <tr key={c.id} style={{ borderTop: '1px solid var(--tax-border)' }}>
                                <td style={{ padding: '8px 6px' }}>
                                  <a href={`/tax/${community.id}/employee/customers/${encodeURIComponent(c.id)}`}
                                     style={{ color: 'inherit', textDecoration: 'none' }}>
                                    {c.customer?.business_name || displayPersonName(c.customer) || c.customer?.email || c.id}
                                  </a>
                                </td>
                                <td style={{ padding: '8px 6px', textAlign: 'right', color: '#166534' }}>{c.done}</td>
                                <td style={{ padding: '8px 6px', textAlign: 'right' }}>{c.in_progress}</td>
                                <td style={{ padding: '8px 6px', textAlign: 'right' }}>{c.open}</td>
                                <td style={{ padding: '8px 6px', textAlign: 'right',
                                             color: c.overdue > 0 ? '#991b1b' : 'inherit',
                                             fontWeight: c.overdue > 0 ? 700 : 400 }}>{c.overdue}</td>
                                <td style={{ padding: '8px 6px' }}>
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <ProgressBar pct={cpct} width={90} />
                                    <span style={{ minWidth: 36, color: 'var(--tax-muted)' }}>{cpct}%</span>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </EmployeeShell>
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
