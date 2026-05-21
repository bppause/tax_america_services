import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Phase 4f: tax-scoped audit log viewer. Filters audit_logs to rows where
// entity LIKE 'tax.%' and supports entity/action/actor/date-range filters.
//
// Entity options are hardcoded against the actions we emit in the tax
// module. Adding a new auditLog() call site means adding the entity here
// for the filter dropdown to surface it. (audit_logs is platform-wide so
// we can't enumerate distinct values without an extra DB call.)

const ENTITY_OPTIONS = [
  'tax.lead',
  'tax.filing_response',
  'tax.customer',
  'tax.customer.contact',
  'tax.customer_note',
  'tax.customer_relationship',
  'tax.customer_workflow_override',
  'tax.document',
  'tax.message_thread',
  'tax.employee',
  'tax.employee_assignment',
  'tax.impersonation',
  'tax.relationship_workflow_rule',
  'tax.filing_schedule',
  'tax.email_template',
  'tax.signature_request',
  'tax.workflow_template',
  'tax.community.contact',
];

export default function OwnerAudit() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [filters, setFilters] = useState({
    entity: '',
    action: '',
    actor: '',
    dateFrom: '',
    dateTo: '',
  });
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const [data, setData] = useState({ logs: null, total: 0 });
  const [err, setErr] = useState('');

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminListAudit(auth, {
      ...filters,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then(d => setData({ logs: d.logs || [], total: d.total || 0 }))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community, filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const onApply = (e) => { e.preventDefault(); setPage(0); load(); };
  const onReset = () => { setFilters({ entity: '', action: '', actor: '', dateFrom: '', dateTo: '' }); setPage(0); };
  const totalPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

  return (
    <EmployeeShell community={community} active="audit">
      <h2 style={{ marginTop: 0 }}>{t('owner.audit.title')}</h2>
      <p className="tax-section__lede">{t('owner.audit.subtitle')}</p>

      <form onSubmit={onApply} className="tax-form" style={{ marginBottom: 16 }}>
        <div className="tax-form__row2">
          <div>
            <label>{t('owner.audit.field.entity')}</label>
            <select value={filters.entity} onChange={e => setFilters(f => ({ ...f, entity: e.target.value }))}>
              <option value="">{t('owner.audit.entity.all')}</option>
              {ENTITY_OPTIONS.map(e => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </div>
          <div>
            <label>{t('owner.audit.field.action')}</label>
            <input type="text" value={filters.action}
                   onChange={e => setFilters(f => ({ ...f, action: e.target.value }))}
                   placeholder={t('owner.audit.field.actionPlaceholder')} maxLength={80} />
          </div>
        </div>
        <div className="tax-form__row2">
          <div>
            <label>{t('owner.audit.field.actor')}</label>
            <input type="text" value={filters.actor}
                   onChange={e => setFilters(f => ({ ...f, actor: e.target.value }))}
                   placeholder="someone@gmail.com" maxLength={200} />
          </div>
          <div>
            <div className="tax-form__row2">
              <div>
                <label>{t('owner.audit.field.dateFrom')}</label>
                <input type="date" value={filters.dateFrom}
                       onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))} />
              </div>
              <div>
                <label>{t('owner.audit.field.dateTo')}</label>
                <input type="date" value={filters.dateTo}
                       onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))} />
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm">
            {t('owner.audit.apply')}
          </button>
          <button type="button" onClick={onReset} className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-text)' }}>
            {t('owner.audit.reset')}
          </button>
        </div>
      </form>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {data.logs === null ? <p>{t('loading')}</p>
        : data.logs.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.audit.empty')}</p>
          : <>
              <div style={{ overflowX: 'auto', border: '1px solid var(--tax-border)', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: 'var(--tax-bg-alt)', fontWeight: 600 }}>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 12px', whiteSpace: 'nowrap' }}>{t('owner.audit.col.time')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>{t('owner.audit.col.entity')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>{t('owner.audit.col.action')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>{t('owner.audit.col.actor')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>{t('owner.audit.col.entityId')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px' }}>{t('owner.audit.col.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.logs.map(row => <AuditRow key={row.id} row={row} t={t} />)}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                <div style={{ color: 'var(--tax-muted)', fontSize: 13 }}>
                  {t('owner.audit.pageInfo', {
                    from: page * PAGE_SIZE + 1,
                    to: Math.min((page + 1) * PAGE_SIZE, data.total),
                    total: data.total,
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          onClick={() => setPage(p => Math.max(0, p - 1))}
                          disabled={page === 0}
                          style={{ color: 'var(--tax-text)' }}>
                    {t('owner.audit.prev')}
                  </button>
                  <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          onClick={() => setPage(p => p + 1)}
                          disabled={(page + 1) >= totalPages}
                          style={{ color: 'var(--tax-text)' }}>
                    {t('owner.audit.next')}
                  </button>
                </div>
              </div>
            </>
      }
    </EmployeeShell>
  );
}

function AuditRow({ row, t }) {
  const [open, setOpen] = useState(false);
  const hasDetails = row.before_data || row.after_data || row.reason;
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--tax-border)' }}>
        <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--tax-muted)' }}>
          {row.created_at ? new Date(row.created_at).toLocaleString() : ''}
        </td>
        <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 12 }}>{row.entity}</td>
        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{row.action}</td>
        <td style={{ padding: '8px 12px' }}>
          {row.actor_email || '—'}
          {row.actor_name && <span style={{ color: 'var(--tax-muted)', fontSize: 12, marginLeft: 4 }}>({row.actor_name})</span>}
        </td>
        <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11, color: 'var(--tax-muted)',
                     maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.entity_id || ''}
        </td>
        <td style={{ padding: '8px 12px' }}>
          {hasDetails ? (
            <button type="button" onClick={() => setOpen(o => !o)}
                    className="tax-btn tax-btn--ghost tax-btn--sm"
                    style={{ color: 'var(--tax-text)', padding: '2px 8px' }}>
              {open ? t('owner.audit.hide') : t('owner.audit.show')}
            </button>
          ) : <span style={{ color: 'var(--tax-muted)', fontSize: 12 }}>—</span>}
        </td>
      </tr>
      {open && hasDetails && (
        <tr>
          <td colSpan={6} style={{ padding: '8px 12px', background: 'var(--tax-bg-alt)' }}>
            {row.reason && (
              <div style={{ marginBottom: 8, fontSize: 13 }}>
                <strong style={{ color: 'var(--tax-muted)', fontSize: 12 }}>{t('owner.audit.reason')}:</strong> {row.reason}
              </div>
            )}
            <div className="tax-form__row2">
              {row.before_data && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{t('owner.audit.before')}</div>
                  <pre style={{ margin: 0, padding: 8, background: '#fff', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 11, maxHeight: 240, overflow: 'auto' }}>
                    {JSON.stringify(row.before_data, null, 2)}
                  </pre>
                </div>
              )}
              {row.after_data && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{t('owner.audit.after')}</div>
                  <pre style={{ margin: 0, padding: 8, background: '#fff', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 11, maxHeight: 240, overflow: 'auto' }}>
                    {JSON.stringify(row.after_data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
