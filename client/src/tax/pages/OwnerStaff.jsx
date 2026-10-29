import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi, setImpersonation } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { formatLastSignInCompact } from '../lib/lastSignIn';
import { displayPersonName } from '../lib/personName';
import { deviceLabel } from '../lib/deviceLabel';

export default function OwnerStaff() {
  const { t, locale } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const me = employee;

  const [employees, setEmployees] = useState(null);
  const [err, setErr] = useState('');

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ firstName: '', middleName: '', lastName: '', email: '', role: 'staff', locale: 'en', sendWelcomeEmail: true, isEmployeeSiteAdmin: false });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminListEmployees(auth, community.id)
      .then(d => setEmployees(d.employees || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  const onAdd = async (e) => {
    e.preventDefault();
    if (!form.email.trim()) { setMsg({ kind: 'error', text: t('owner.customers.errEmailRequired') }); return; }
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      // "Site admin" is role=admin scoped to "Public homepage only" —
      // every permission revoked except manage_services (needed for the
      // Services catalog + WhatsApp template link, both part of the
      // public homepage) — a one-step shortcut for the person who should
      // manage the public website/app but never see customer data or
      // practice-operations screens, instead of creating a regular admin
      // and then finding those toggles in the permissions editor
      // afterward. Matches the set OwnerStaffDetail's role switcher uses
      // (SITE_ADMIN_REVOKED_KEYS).
      const isSiteAdmin = form.role === 'site_admin';
      const result = await taxApi.adminCreateEmployee(auth, {
        communitySlug: community.id,
        email: form.email.trim().toLowerCase(),
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        lastName: form.lastName.trim(),
        role: isSiteAdmin ? 'admin' : form.role,
        permissions: isSiteAdmin
          ? {
              view_customers: false,
              manage_customers: false,
              manage_leads: false,
              manage_workflows: false,
              manage_email_templates: false,
              manage_settings: false,
              manage_employees: false,
              send_reminders: false,
              view_audit_logs: false,
            }
          : undefined,
        locale: form.locale,
        sendWelcomeEmail: form.sendWelcomeEmail,
        isEmployeeSiteAdmin: form.isEmployeeSiteAdmin,
      });
      // Phase 4n.16: messaging branches on whether the email already had an
      // account on the platform. Existing users (customer accounts, dual
      // tenants, etc.) sign in with their existing credentials; new users
      // bootstrap on first visit.
      const isExisting = !!result?.isExistingUser;
      const baseKey = isExisting ? 'owner.staff.addedSuccess.existing' : 'owner.staff.addedSuccess.new';
      // The account is created either way — but a checked "send welcome
      // email" box doesn't guarantee the send actually happened (staff
      // emails disabled in Settings, Resend misconfigured, etc.). Trusting
      // the checkbox state here told the admin an email went out when it
      // silently didn't, which is exactly how "new employee never got
      // their welcome email" goes unnoticed. Branch on the server's
      // actual result instead.
      let text;
      let kind = 'success';
      if (!form.sendWelcomeEmail) {
        text = t(`${baseKey}.noEmail`);
      } else if (result?.welcomeEmail?.sent) {
        text = t(`${baseKey}.withEmail`);
      } else {
        const reason = result?.welcomeEmail?.reason || result?.welcomeEmail?.error;
        kind = 'error';
        text = reason
          ? t(`${baseKey}.emailFailedWithReason`, { reason })
          : t(`${baseKey}.emailFailed`);
      }
      setMsg({ kind, text });
      setForm({ firstName: '', middleName: '', lastName: '', email: '', role: 'staff', locale: 'en', sendWelcomeEmail: true, isEmployeeSiteAdmin: false });
      setAdding(false);
      load();
    } catch (err) {
      setMsg({ kind: 'error', text: err?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  // A Staff Admin (is_employee_site_admin) reaches this page too, even
  // on a 'staff' role account — the flag exists specifically to let
  // someone add/remove staff and manage sessions without being a full
  // admin.
  if (employee && employee.role !== 'admin' && !employee.is_employee_site_admin) {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const base = community ? `/tax/${community.id}/employee/staff` : '#';

  // Split active staff from archived. Archived rows go into their own
  // collapsible section so the working roster stays scannable but the
  // archive isn't hidden out-of-sight.
  const { active, archived } = useMemo(() => {
    const a = [], r = [];
    for (const e of employees || []) {
      if (e.status === 'archived') r.push(e); else a.push(e);
    }
    return { active: a, archived: r };
  }, [employees]);

  return (
    <EmployeeShell community={community} active="staff">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('owner.staff.title')}</h2>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={() => setAdding(a => !a)}>
          {adding ? t('owner.staff.cancelAdd') : t('owner.staff.addBtn')}
        </button>
      </div>
      <p className="tax-section__lede">{t('owner.staff.subtitle')}</p>

      <div style={{
        padding: '10px 14px', marginBottom: 16,
        background: 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)',
        border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 22%, #fff)',
        borderRadius: 8, fontSize: 13, color: 'var(--tax-text)',
      }}>
        <strong>{t('owner.staff.accessExplainer.heading')}</strong>{' '}
        <span style={{ color: 'var(--tax-muted)' }}>
          {t('owner.staff.accessExplainer.body')}
        </span>
      </div>

      <RolesExplainer t={t} />
      <SessionsPanel auth={auth} community={community} locale={locale} t={t} />

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {adding && (
        <form className="tax-form" onSubmit={onAdd} noValidate style={{ marginBottom: 24 }}>
          <div className="tax-form__row3">
            <div>
              <label htmlFor="os-first">{t('owner.customers.fieldFirstName')}</label>
              <input id="os-first" type="text" value={form.firstName}
                     onChange={e => setForm(p => ({ ...p, firstName: e.target.value }))} maxLength={80} />
            </div>
            <div>
              <label htmlFor="os-middle">{t('owner.customers.fieldMiddleName')}</label>
              <input id="os-middle" type="text" value={form.middleName}
                     onChange={e => setForm(p => ({ ...p, middleName: e.target.value }))} maxLength={80} />
            </div>
            <div>
              <label htmlFor="os-last">{t('owner.customers.fieldLastName')}</label>
              <input id="os-last" type="text" value={form.lastName}
                     onChange={e => setForm(p => ({ ...p, lastName: e.target.value }))} maxLength={80} />
            </div>
          </div>
          <div>
            <label htmlFor="os-email">{t('owner.staff.fieldEmail')} *</label>
            <input id="os-email" type="email" required value={form.email}
                   onChange={e => setForm(p => ({ ...p, email: e.target.value }))} maxLength={200} />
          </div>
          <div className="tax-form__row2">
            <div>
              <label htmlFor="os-role">{t('owner.staff.fieldRole')}</label>
              <select id="os-role" value={form.role}
                      onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                <option value="staff">{t('owner.staff.role.staff')}</option>
                <option value="admin">{t('owner.staff.role.admin')}</option>
                <option value="site_admin">{t('owner.staff.role.siteAdmin')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="os-locale">{t('owner.staff.fieldLocale')}</label>
              <select id="os-locale" value={form.locale}
                      onChange={e => setForm(p => ({ ...p, locale: e.target.value }))}>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </div>
          </div>
          {form.role === 'site_admin' && (
            <p style={{
              color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 8px',
              padding: '8px 10px', background: 'var(--tax-bg-alt)', borderRadius: 6,
            }}>
              {t('owner.staff.role.siteAdminHint')}
            </p>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.isEmployeeSiteAdmin}
                   onChange={e => setForm(p => ({ ...p, isEmployeeSiteAdmin: e.target.checked }))} />
            <span>{t('employee.role.staffAdmin')}</span>
          </label>
          <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 8px' }}>
            {t('owner.staff.staffAdminHint')}
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.sendWelcomeEmail}
                   onChange={e => setForm(p => ({ ...p, sendWelcomeEmail: e.target.checked }))} />
            <span>{t('owner.staff.sendWelcomeEmail')}</span>
          </label>
          <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 8px' }}>
            {t('owner.staff.sendWelcomeEmailHint')}
          </p>
          {msg.text && (
            <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}>{msg.text}</div>
          )}
          <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
            {busy ? t('lead.submitting') : t('owner.staff.createBtn')}
          </button>
        </form>
      )}

      {/* Banner-style success / error toast outside the form (visible after
          the form auto-closes on save). */}
      {!adding && msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginBottom: 16 }}>{msg.text}</div>
      )}

      {employees === null ? <p>{t('loading')}</p>
        : (active.length === 0 && archived.length === 0)
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.staff.empty')}</p>
          : (
            <>
              <div style={{ display: 'grid', gap: 8 }}>
                {active.map(e => (
                  <StaffRow key={e.id} e={e} me={me} auth={auth} community={community}
                            base={base} locale={locale} t={t} onChange={load} />
                ))}
              </div>
              <ArchivedStaffSection rows={archived} me={me} auth={auth} community={community}
                                    base={base} locale={locale} t={t} onChange={load} />
            </>
          )}
    </EmployeeShell>
  );
}

// One active-staff row. Mirrors the prior inline markup plus a
// "Resend welcome" affordance on staff who haven't yet completed
// first sign-in (no firebase_uid). The button surfaces only when the
// row is editable — archived rows live in the separate archive
// section and use a different control set.
function StaffRow({ e, me, auth, community, base, locale, t, onChange }) {
  return (
    <div className="tax-contact-item"
         style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
      <a href={`${base}/${encodeURIComponent(e.id)}`}
         style={{ textDecoration: 'none', color: 'inherit', minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>
          {displayPersonName(e) || e.email}
          <span style={{
            marginLeft: 8, padding: '1px 8px', borderRadius: 999,
            background: e.role === 'admin' ? 'var(--tax-brand-primary)' : 'var(--tax-bg-alt)',
            color: e.role === 'admin' ? '#fff' : 'var(--tax-muted)',
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          }}>{e.role}</span>
          {e.is_seed_owner && (
            <span style={{
              marginLeft: 6, padding: '1px 8px', borderRadius: 999,
              background: '#fef3c7', color: '#92400e',
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }} title={t('owner.staff.seedOwnerHint')}>
              {t('employee.role.seedOwner')}
            </span>
          )}
          {e.is_employee_site_admin && !e.is_seed_owner && (
            <span style={{
              marginLeft: 6, padding: '1px 8px', borderRadius: 999,
              background: '#e0f2fe', color: '#075985',
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }} title={t('owner.staff.staffAdminHint')}>
              {t('employee.role.staffAdmin')}
            </span>
          )}
          {e.is_task_reviewer && !e.is_seed_owner && (
            <span style={{
              marginLeft: 6, padding: '1px 8px', borderRadius: 999,
              background: '#dcfce7', color: '#166534',
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }} title={t('owner.staff.reviewerHint')}>
              {t('employee.role.reviewer')}
            </span>
          )}
          <AccessScopePill emp={e} t={t} />
          {!e.firebase_uid && (
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--tax-muted)' }}>
              ({t('owner.staff.notSignedIn')})
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
          {e.email}
        </div>
      </a>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', textAlign: 'right' }}>
          <div>{(e.notification_channels || []).includes('email')
            ? t('owner.staff.channelBoth') : t('owner.staff.channelPortal')}</div>
          <div style={{ marginTop: 2, color: e.last_sign_in_at ? 'var(--tax-muted)' : '#b91c1c' }}>
            {formatLastSignInCompact(e.last_sign_in_at, locale, t)}
          </div>
        </div>
        {!e.firebase_uid && (
          <ResendWelcomeButton emp={e} auth={auth} t={t} />
        )}
        {e.id !== me?.id && e.firebase_uid && (
          <ImpersonateRowButton emp={e} auth={auth} community={community} t={t} />
        )}
      </div>
    </div>
  );
}

// Quick reference for every role/badge that can show up on this page —
// the role model has grown past what the inline "Who sees what" note
// above can cover (Staff/Admin/Site admin, Owner/Seed owner, and the two
// independent grants Staff Admin and Reviewer). Collapsed by default,
// same convention as the sessions panel below — reference material, not
// everyday UI.
const ROLE_LEGEND = [
  { key: 'staff',       bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)' },
  { key: 'admin',       bg: 'var(--tax-brand-primary)', fg: '#fff' },
  { key: 'siteAdmin',   bg: 'color-mix(in srgb, #6b7280 10%, #fff)', fg: '#374151' },
  { key: 'owner',       bg: '#fef3c7', fg: '#92400e' },
  { key: 'seedOwner',   bg: '#fef3c7', fg: '#92400e' },
  { key: 'staffAdmin',  bg: '#e0f2fe', fg: '#075985' },
  { key: 'reviewer',    bg: '#dcfce7', fg: '#166534' },
];

function RolesExplainer({ t }) {
  const [open, setOpen] = useState(false);
  return (
    <section style={{
      marginBottom: 16, border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
    }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', textAlign: 'left', padding: '12px 14px',
                border: 0, background: '#fff', cursor: 'pointer',
              }}>
        <span aria-hidden="true" style={{
          display: 'inline-block', transition: 'transform .15s ease',
          transform: open ? 'none' : 'rotate(-90deg)',
        }}>▾</span>
        <strong>{t('owner.staff.roles.title')}</strong>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px', display: 'grid', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--tax-muted)' }}>
            {t('owner.staff.roles.subtitle')}
          </p>
          {ROLE_LEGEND.map(({ key, bg, fg }) => (
            <div key={key} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '8px 10px', borderRadius: 8, background: 'var(--tax-bg-alt)',
            }}>
              <span style={{
                flexShrink: 0, padding: '2px 9px', borderRadius: 999,
                background: bg, color: fg, fontSize: 11, fontWeight: 700,
                textTransform: 'uppercase', whiteSpace: 'nowrap', marginTop: 1,
              }}>{t(`owner.staff.roles.${key}.label`)}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{t(`owner.staff.roles.${key}.desc`)}</div>
                <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                  {t(`owner.staff.roles.${key}.grant`)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// "Who's logged in where" + force logout. Collapsed by default (most
// days nobody needs it) but always visible at the top of the Staff page
// — the one place an admin would think to look when a device needs to
// be kicked off (a lost phone, an ex-employee's laptop, a shared
// workstation someone forgot to sign out of).
function SessionsPanel({ auth, community, locale, t }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = () => {
    if (!community) return;
    taxApi.adminListEmployeeSessions(auth, community.id)
      .then(d => setSessions(d.sessions || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(() => { if (open) load(); }, [open, community]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const m = new Map();
    for (const s of sessions || []) {
      if (!m.has(s.employee_id)) m.set(s.employee_id, { employee: s.tax_employees, employeeId: s.employee_id, rows: [] });
      m.get(s.employee_id).rows.push(s);
    }
    return [...m.values()].sort((a, b) =>
      (displayPersonName(a.employee) || a.employee?.email || '')
        .localeCompare(displayPersonName(b.employee) || b.employee?.email || ''));
  }, [sessions]);

  const revoke = async (sessionId) => {
    setBusyId(sessionId); setErr('');
    try { await taxApi.adminRevokeEmployeeSession(auth, sessionId); load(); }
    catch (e) { setErr(e?.message || t('respond.error.generic')); }
    finally { setBusyId(''); }
  };
  const revokeAll = async (employeeId, name) => {
    if (!window.confirm(t('owner.staff.sessions.confirmRevokeAll', { name }))) return;
    setBusyId(employeeId); setErr('');
    try { await taxApi.adminRevokeAllEmployeeSessions(auth, employeeId); load(); }
    catch (e) { setErr(e?.message || t('respond.error.generic')); }
    finally { setBusyId(''); }
  };

  return (
    <section style={{
      marginBottom: 16, border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
    }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                width: '100%', textAlign: 'left', padding: '12px 14px',
                border: 0, background: '#fff', cursor: 'pointer',
              }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden="true" style={{
            display: 'inline-block', transition: 'transform .15s ease',
            transform: open ? 'none' : 'rotate(-90deg)',
          }}>▾</span>
          <strong>{t('owner.staff.sessions.title')}</strong>
        </span>
        {sessions !== null && (
          <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.staff.sessions.activeCount', { count: sessions.length })}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          <p style={{ fontSize: 13, color: 'var(--tax-muted)', margin: '0 0 10px' }}>
            {t('owner.staff.sessions.subtitle')}
          </p>
          {err && <div className="tax-msg tax-msg--error">{err}</div>}
          {sessions === null ? <p>{t('loading')}</p>
            : grouped.length === 0 ? (
              <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{t('owner.staff.sessions.empty')}</p>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {grouped.map(g => {
                  const name = displayPersonName(g.employee) || g.employee?.email || '';
                  return (
                    <div key={g.employeeId} style={{
                      border: '1px solid var(--tax-border)', borderRadius: 8, padding: '8px 10px',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                        <strong style={{ fontSize: 13 }}>
                          {name}
                          {g.employee?.is_seed_owner && (
                            <span style={{
                              marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                              background: '#fef3c7', color: '#92400e',
                              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            }}>{t('employee.role.seedOwner')}</span>
                          )}
                          {g.employee?.is_employee_site_admin && !g.employee?.is_seed_owner && (
                            <span style={{
                              marginLeft: 6, padding: '1px 6px', borderRadius: 999,
                              background: '#e0f2fe', color: '#075985',
                              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                            }}>{t('employee.role.staffAdmin')}</span>
                          )}
                        </strong>
                        {g.rows.length > 1 && (
                          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                                  disabled={busyId === g.employeeId}
                                  onClick={() => revokeAll(g.employeeId, name)}
                                  style={{ color: '#b91c1c', borderColor: '#b91c1c', flexShrink: 0 }}>
                            {t('owner.staff.sessions.revokeAll')}
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'grid', gap: 6 }}>
                        {g.rows.map(s => (
                          <div key={s.id} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            fontSize: 12, gap: 8,
                          }}>
                            <div style={{ minWidth: 0, color: 'var(--tax-muted)' }}>
                              <div style={{ color: 'var(--tax-text)' }}>{deviceLabel(s.user_agent, t)}</div>
                              <div>
                                {s.ip_address || '—'}
                                {' · '}
                                {t('owner.staff.sessions.lastSeen', { time: formatLastSignInCompact(s.last_seen_at, locale, t) })}
                              </div>
                            </div>
                            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                                    disabled={busyId === s.id}
                                    onClick={() => revoke(s.id)}
                                    style={{ color: '#b91c1c', borderColor: '#b91c1c', flexShrink: 0 }}>
                              {t('owner.staff.sessions.revoke')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </section>
  );
}

// Pill that telegraphs which customers this employee can see — the most
// common owner question on this page. Admins always see the whole
// community; staff see only the customers they're explicitly assigned
// to. The assignment count comes back from /admin/employees so the
// list scans without a per-row round-trip. Archived staff see nothing
// (suppress the pill — the archived badge already covers it).
function AccessScopePill({ emp, t }) {
  if (emp.status === 'archived') return null;
  const isAdmin = emp.role === 'admin';
  // An admin can still have view_customers revoked — a "site admin" who
  // configures the public site/app but never sees customer records.
  const isWebAdmin = isAdmin && emp.permissions?.view_customers === false;
  const count = Number(emp.assigned_customer_count) || 0;
  const label = isWebAdmin
    ? t('owner.staff.access.webAdmin')
    : isAdmin
      ? t('owner.staff.access.all')
      : (count === 0
          ? t('owner.staff.access.none')
          : t('owner.staff.access.assigned', { count }));
  const tint = isWebAdmin
    ? { bg: 'color-mix(in srgb, #6b7280 10%, #fff)',
        fg: '#374151',
        bd: 'color-mix(in srgb, #6b7280 30%, #fff)' }
    : isAdmin
      ? { bg: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
          fg: 'var(--tax-brand-primary)',
          bd: 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)' }
      : count === 0
        ? { bg: 'color-mix(in srgb, #b91c1c 7%, #fff)',
            fg: '#7f1d1d',
            bd: 'color-mix(in srgb, #b91c1c 22%, #fff)' }
        : { bg: 'var(--tax-bg-alt)',
            fg: 'var(--tax-text)',
            bd: 'var(--tax-border)' };
  const hint = isWebAdmin
    ? t('owner.staff.access.webAdminHint')
    : isAdmin ? t('owner.staff.access.allHint') : t('owner.staff.access.assignedHint');
  return (
    <span style={{
      marginLeft: 6, padding: '1px 8px', borderRadius: 999,
      background: tint.bg, color: tint.fg, border: `1px solid ${tint.bd}`,
      fontSize: 11, fontWeight: 600,
    }}
          title={hint}>
      {label}
    </span>
  );
}

// Manual welcome-email resend. Useful when a new hire didn't see the
// initial email, the address bounced, or the owner wants to re-prod a
// staff member who never completed sign-in. Hits the existing
// /admin/employees/:id/send-welcome endpoint.
function ResendWelcomeButton({ emp, auth, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const onClick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!window.confirm(t('owner.staff.resendWelcome.confirm', { name: displayPersonName(emp) || emp.email }))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminSendStaffWelcomeEmail(auth, emp.id);
      if (r?.welcomeEmail?.sent || r?.sent) {
        setMsg({ kind: 'success', text: t('owner.staff.resendWelcome.sent') });
      } else {
        const reason = r?.welcomeEmail?.reason || r?.reason || r?.welcomeEmail?.error || r?.error;
        setMsg({ kind: 'error', text: reason
          ? t('owner.staff.resendWelcome.failedWithReason', { reason })
          : t('owner.staff.resendWelcome.failed') });
      }
    } catch (err) {
      setMsg({ kind: 'error', text: err?.message || t('owner.staff.resendWelcome.failed') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 6000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
        {busy ? t('lead.submitting') : t('owner.staff.resendWelcome.button')}
      </button>
      {msg.text && (
        <span style={{ fontSize: 11,
                       color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

// Collapsed-by-default block listing archived staff. Stays on the same
// page (instead of a separate filter screen) so the admin always sees
// at a glance how many staff are archived and can restore any of them
// from one click into the detail page.
function ArchivedStaffSection({ rows, me, auth, community, base, locale, t, onChange }) {
  const [open, setOpen] = useState(false);
  if (!rows || rows.length === 0) return null;
  return (
    <section style={{
      marginTop: 24, border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
    }}>
      <button type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', textAlign: 'left',
                padding: '12px 14px', border: 0, background: '#fff', cursor: 'pointer',
              }}>
        <span style={{
          display: 'inline-block', transition: 'transform .15s ease',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          fontSize: 11, color: 'var(--tax-muted)',
        }}>▶</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--tax-text)' }}>
            {t('owner.staff.archived.title')}
          </span>
        </span>
        <span style={{
          padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
          background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
        }}>{rows.length}</span>
      </button>
      {open && (
        <div style={{ padding: '8px 14px 16px' }}>
          <p style={{ color: 'var(--tax-muted)', marginTop: 0, marginBottom: 12, fontSize: 13 }}>
            {t('owner.staff.archived.subtitle')}
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map(e => (
              <a key={e.id} href={`${base}/${encodeURIComponent(e.id)}`}
                 className="tax-contact-item"
                 style={{
                   textDecoration: 'none', color: 'inherit',
                   display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                   opacity: 0.85,
                 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {displayPersonName(e) || e.email}
                    <span style={{
                      marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                      background: 'color-mix(in srgb, #b91c1c 8%, #fff)',
                      color: '#7f1d1d', fontSize: 11, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '.04em',
                      border: '1px solid color-mix(in srgb, #b91c1c 20%, #fff)',
                    }}>{t('owner.staff.archived.badge')}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
                    {e.email}
                  </div>
                </div>
                <span style={{
                  fontSize: 12, color: 'var(--tax-brand-primary)', fontWeight: 600, flexShrink: 0,
                }}>
                  {t('owner.staff.archived.openToRestore')} →
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// Compact row-level "View as employee" button. Mirrors
// ImpersonateEmployeeButton on the staff detail page — same confirm dialog,
// same POST /admin/impersonation/start, same sessionStorage + redirect.
// Hidden for the current admin's own row and for staff who haven't yet
// signed in (no firebase_uid to swap into).
function ImpersonateRowButton({ emp, auth, community, t }) {
  const [busy, setBusy] = useState(false);
  const onClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(t('impersonation.confirm.employee', { name: emp.name || emp.email }))) return;
    setBusy(true);
    try {
      const r = await taxApi.adminStartImpersonation(auth, {
        communitySlug: community.id,
        targetType: 'employee',
        targetId: emp.id,
      });
      setImpersonation({
        token: r.token,
        targetType: 'employee',
        targetId: emp.id,
        targetEmail: emp.email,
        targetName: emp.name || emp.email,
        communitySlug: community.id,
        realAdminEmail: auth.adminEmail || auth.email,
        realAdminUid: auth.uid,
        expiresAt: r.expiresAt,
      });
      window.location.href = `/tax/${community.id}/employee`;
    } catch (err) {
      window.alert(err?.message || t('respond.error.generic'));
      setBusy(false);
    }
  };
  return (
    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
            onClick={onClick} disabled={busy}
            style={{ color: '#b91c1c', borderColor: '#b91c1c' }}>
      {busy ? t('impersonation.starting') : t('impersonation.viewAsEmployee')}
    </button>
  );
}
