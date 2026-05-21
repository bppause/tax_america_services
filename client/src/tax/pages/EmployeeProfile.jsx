import { useEffect, useState } from 'react';
import { hasSavedLocale, pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

const WHATSAPP_E164 = /^\+[1-9]\d{6,14}$/;
function normalizeWhatsappForCheck(raw) {
  const trimmed = String(raw || '').trim();
  return '+' + trimmed.replace(/^\+/, '').replace(/\D+/g, '');
}

// Employee profile editor. Mirrors the customer-side fields plus a key v3
// addition: notification channel preferences — defaulting to portal-only
// per the owner spec, switchable to "portal + email" via the checkboxes.
export default function EmployeeProfile() {
  const { locale, setLocale, t } = useT();
  const { fbUser, employee, community, assignments, refreshMe } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  // Phase 4n.11: per-type prefs replace the global inApp/email pair. Keep
  // the legacy fields populated alongside for backwards compat — they only
  // matter if the user clears all per-type prefs.
  const [notificationTypes, setNotificationTypes] = useState([]);
  const [prefs, setPrefs] = useState({});  // { typeKey: { in_app, email } }
  const [form, setForm] = useState({
    firstName: '', middleName: '', lastName: '',
    phone: '', whatsapp: '', preferredEmail: '', locale: 'es',
    addr: { line1: '', line2: '', city: '', state: '', postal_code: '', country: 'US' },
    inApp: true, email: false,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  useEffect(() => {
    if (!employee) return;
    const a = employee.address || {};
    const ch = Array.isArray(employee.notificationChannels) ? employee.notificationChannels : ['in_app'];
    setForm({
      firstName: employee.first_name || '',
      middleName: employee.middle_name || '',
      lastName: employee.last_name || '',
      phone: employee.phone || '',
      whatsapp: employee.whatsapp || '',
      preferredEmail: employee.preferredCommunicationEmail || '',
      locale: employee.locale === 'en' ? 'en' : 'es',
      addr: {
        line1: a.line1 || '', line2: a.line2 || '',
        city: a.city || '', state: a.state || '',
        postal_code: a.postal_code || '',
        country: a.country || 'US',
      },
      inApp: ch.includes('in_app'),
      email: ch.includes('email'),
    });
  }, [employee]);

  // Phase 4n.11: fetch the notification-type catalog + this employee's
  // current per-type prefs. Falls back to the type's default_channels when
  // no pref is stored for a type.
  useEffect(() => {
    if (!employee || !community) return;
    let cancelled = false;
    taxApi.getEmployeeNotificationTypes(auth)
      .then(d => {
        if (cancelled) return;
        const types = d.types || [];
        const storedPrefs = d.prefs || {};
        const fallbackCh = Array.isArray(employee?.notificationChannels) && employee.notificationChannels.length
          ? employee.notificationChannels : ['in_app'];
        const initial = {};
        for (const tp of types) {
          if (storedPrefs[tp.key]) {
            initial[tp.key] = {
              in_app: storedPrefs[tp.key].in_app !== false,
              email:  storedPrefs[tp.key].email === true,
            };
          } else {
            const def = Array.isArray(tp.default_channels) ? tp.default_channels : ['in_app'];
            // First-load fallback uses the legacy global toggle so existing
            // opt-ins don't silently flip back to portal-only.
            initial[tp.key] = {
              in_app: fallbackCh.includes('in_app') || def.includes('in_app'),
              email:  fallbackCh.includes('email')  || def.includes('email'),
            };
          }
        }
        setNotificationTypes(types);
        setPrefs(initial);
      })
      .catch(() => { /* falls back to empty matrix; legacy toggle still works */ });
    return () => { cancelled = true; };
  }, [fbUser, community, employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPref = (typeKey, channel, on) => setPrefs(p => ({
    ...p,
    [typeKey]: { ...(p[typeKey] || {}), [channel]: on },
  }));

  const onField = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const onAddr  = (k, v) => setForm(p => ({ ...p, addr: { ...p.addr, [k]: v } }));

  const whatsappNormalized = form.whatsapp ? normalizeWhatsappForCheck(form.whatsapp) : '';
  const whatsappValid = !form.whatsapp || WHATSAPP_E164.test(whatsappNormalized);
  const waLink = whatsappValid && whatsappNormalized.length > 1
    ? `https://wa.me/${whatsappNormalized.replace(/^\+/, '')}` : '';

  const onSave = async (e) => {
    e?.preventDefault?.();
    if (form.whatsapp && !whatsappValid) {
      setMsg({ kind: 'error', text: t('portal.profile.whatsapp.invalid') });
      return;
    }
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const address = {};
      for (const k of ['line1', 'line2', 'city', 'state', 'postal_code', 'country']) {
        const v = String(form.addr[k] || '').trim();
        if (v) address[k] = v;
      }
      // Derive the legacy global channel array from the per-type matrix
      // so older code paths still resolve sensibly. in_app always on as a
      // baseline; include email if any per-type pref opts in.
      const anyEmail = Object.values(prefs).some(p => p && p.email === true);
      const channels = anyEmail ? ['in_app', 'email'] : ['in_app'];
      await taxApi.updateEmployeeProfile(auth, {
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        whatsapp: form.whatsapp.trim(),
        address,
        preferredCommunicationEmail: form.preferredEmail.trim(),
        notificationChannels: channels,
        notificationPrefs: prefs,
        locale: form.locale,
      });
      if (form.locale !== locale) setLocale(form.locale);
      setMsg({ kind: 'success', text: t('portal.profile.saved') });
      refreshMe();
    } catch (err) {
      setMsg({ kind: 'error', text: err?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  // First-load sync: pull the saved profile locale into the UI when the
  // browser has no explicit user choice yet, so the preference follows
  // the employee across devices.
  useEffect(() => {
    if (!employee) return;
    const profileLocale = employee.locale === 'en' ? 'en' : 'es';
    if (!hasSavedLocale() && profileLocale !== locale) setLocale(profileLocale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee?.id]);

  return (
    <EmployeeShell community={community} active="profile">
      <h2 style={{ marginTop: 0 }}>{t('employee.profile.title')}</h2>

      <form className="tax-form" onSubmit={onSave} noValidate style={{ maxWidth: 720 }}>
        <div className="tax-form__row3">
          <div>
            <label htmlFor="ep-first">{t('owner.customers.fieldFirstName')}</label>
            <input id="ep-first" type="text" value={form.firstName}
                   onChange={e => onField('firstName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label htmlFor="ep-middle">{t('owner.customers.fieldMiddleName')}</label>
            <input id="ep-middle" type="text" value={form.middleName}
                   onChange={e => onField('middleName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label htmlFor="ep-last">{t('owner.customers.fieldLastName')}</label>
            <input id="ep-last" type="text" value={form.lastName}
                   onChange={e => onField('lastName', e.target.value)} maxLength={80} />
          </div>
        </div>
        <div>
          <label htmlFor="ep-login">
            {t('portal.profile.email')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              ({t('portal.profile.email.readonly')})
            </span>
          </label>
          <input id="ep-login" type="email" value={employee?.email || ''} readOnly
                 style={{ background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)' }} />
        </div>

        <div className="tax-form__row2">
          <div>
            <label htmlFor="ep-phone">{t('portal.profile.phone')}</label>
            <input id="ep-phone" type="tel" value={form.phone}
                   placeholder="(415) 555-1234"
                   onChange={e => onField('phone', e.target.value)} maxLength={40} />
          </div>
          <div>
            <label htmlFor="ep-whatsapp">
              {t('portal.profile.whatsapp')}
              <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                {t('portal.profile.whatsapp.format')}
              </span>
            </label>
            <input id="ep-whatsapp" type="tel" value={form.whatsapp}
                   placeholder="+14155551234"
                   onChange={e => onField('whatsapp', e.target.value)} maxLength={20}
                   style={form.whatsapp && !whatsappValid ? { borderColor: 'var(--tax-error)' } : undefined} />
            {form.whatsapp && !whatsappValid && (
              <div style={{ color: 'var(--tax-error)', fontSize: 12, marginTop: 4 }}>
                {t('portal.profile.whatsapp.invalid')}
              </div>
            )}
            {waLink && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <a href={waLink} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--tax-brand-primary)' }}>
                  {t('portal.profile.whatsapp.preview')} {whatsappNormalized}
                </a>
              </div>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="ep-pref-email">
            {t('portal.profile.preferredEmail')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              {t('portal.profile.preferredEmail.hint')}
            </span>
          </label>
          <input id="ep-pref-email" type="email" value={form.preferredEmail}
                 placeholder={employee?.email || ''}
                 onChange={e => onField('preferredEmail', e.target.value)} maxLength={200} />
        </div>

        <div>
          <label htmlFor="ep-locale">
            {t('portal.profile.language')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              {t('portal.profile.language.hint')}
            </span>
          </label>
          <select id="ep-locale" value={form.locale}
                  onChange={e => onField('locale', e.target.value)}
                  style={{ maxWidth: 280 }}>
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>

        <fieldset style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 16, margin: 0 }}>
          <legend style={{ padding: '0 8px', fontWeight: 600, fontSize: 14 }}>{t('portal.profile.address')}</legend>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label htmlFor="ep-addr1">{t('portal.profile.address.line1')}</label>
              <input id="ep-addr1" type="text" value={form.addr.line1}
                     onChange={e => onAddr('line1', e.target.value)} maxLength={200} />
            </div>
            <div>
              <label htmlFor="ep-addr2">{t('portal.profile.address.line2')}</label>
              <input id="ep-addr2" type="text" value={form.addr.line2}
                     placeholder={t('portal.profile.address.line2.placeholder')}
                     onChange={e => onAddr('line2', e.target.value)} maxLength={200} />
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="ep-city">{t('portal.profile.address.city')}</label>
                <input id="ep-city" type="text" value={form.addr.city}
                       onChange={e => onAddr('city', e.target.value)} maxLength={120} />
              </div>
              <div>
                <label htmlFor="ep-state">{t('portal.profile.address.state')}</label>
                <input id="ep-state" type="text" value={form.addr.state}
                       onChange={e => onAddr('state', e.target.value)} maxLength={80} />
              </div>
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="ep-postal">{t('portal.profile.address.postal')}</label>
                <input id="ep-postal" type="text" value={form.addr.postal_code}
                       onChange={e => onAddr('postal_code', e.target.value)} maxLength={20} />
              </div>
              <div>
                <label htmlFor="ep-country">{t('portal.profile.address.country')}</label>
                <input id="ep-country" type="text" value={form.addr.country}
                       onChange={e => onAddr('country', e.target.value)} maxLength={4}
                       placeholder="US" />
              </div>
            </div>
          </div>
        </fieldset>

        <fieldset style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 16, margin: 0 }}>
          <legend style={{ padding: '0 8px', fontWeight: 600, fontSize: 14 }}>
            {t('employee.profile.notifications.title')}
          </legend>
          <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 12px' }}>
            {t('employee.profile.notifications.hint')}
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ textAlign: 'left', background: 'var(--tax-bg-alt)' }}>
                  <th style={{ padding: '8px 10px' }}>{t('employee.profile.notifications.col.event')}</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', width: 110 }}>{t('employee.profile.notifications.col.inApp')}</th>
                  <th style={{ padding: '8px 10px', textAlign: 'center', width: 110 }}>{t('employee.profile.notifications.col.email')}</th>
                </tr>
              </thead>
              <tbody>
                {/* Welcome row — pinned, read-only. Sent once on creation. */}
                <tr style={{ borderTop: '1px solid var(--tax-border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <div style={{ fontWeight: 600 }}>{t('employee.profile.notifications.welcome.label')}</div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                      {t('employee.profile.notifications.welcome.hint')}
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--tax-muted)' }}>—</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    <input type="checkbox" checked readOnly disabled />
                  </td>
                </tr>
                {notificationTypes.map(tp => {
                  const p = prefs[tp.key] || { in_app: true, email: false };
                  return (
                    <tr key={tp.key} style={{ borderTop: '1px solid var(--tax-border)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <div style={{ fontWeight: 600 }}>
                          {pickI18n(tp.label_i18n, form.locale).value || tp.key}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                          {pickI18n(tp.description_i18n, form.locale).value || ''}
                        </div>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        <input type="checkbox" checked={!!p.in_app}
                               onChange={e => setPref(tp.key, 'in_app', e.target.checked)} />
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        <input type="checkbox" checked={!!p.email}
                               onChange={e => setPref(tp.key, 'email', e.target.checked)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </fieldset>

        {msg.text && (
          <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}>{msg.text}</div>
        )}

        <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
          {busy ? t('lead.submitting') : t('portal.profile.save')}
        </button>
      </form>

      {/* ── Assignments widget (Phase 3b) ─────────────────────────────────
          Read-only: customer assignments are managed by the practice
          owner via /admin/employees/:id/assignments. Admin-role employees
          see a "scope = all" banner instead of a roster — they're not
          subject to the assignment filter. */}
      <h3 style={{ marginTop: 32 }}>{t('employee.profile.assignments.title')}</h3>
      {employee?.role === 'admin' ? (
        <div className="tax-msg" style={{ background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
                                          color: 'var(--tax-text)', borderLeft: '3px solid var(--tax-brand-primary)' }}>
          <strong>{t('employee.profile.assignments.adminBanner')}</strong>
          <div style={{ marginTop: 4, color: 'var(--tax-muted)', fontSize: 13 }}>
            {t('employee.profile.assignments.adminHint')}
          </div>
        </div>
      ) : (assignments || []).length === 0 ? (
        <div className="tax-contact-item">
          <p style={{ margin: 0, color: 'var(--tax-muted)' }}>
            {t('employee.profile.assignments.empty')}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {assignments.map(a => (
            <div key={a.id} className="tax-contact-item"
                 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {a.customer?.name || a.customer?.email || '—'}
                  {a.is_primary && (
                    <span style={{
                      marginLeft: 8, padding: '2px 8px', borderRadius: 999,
                      background: 'var(--tax-brand-primary)', color: '#fff',
                      fontSize: 11, fontWeight: 700,
                    }}>{t('employee.profile.assignments.primary')}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                  {a.customer?.email}{a.customer?.phone ? ` • ${a.customer.phone}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 8 }}>
        {t('employee.profile.assignments.managedBy')}
      </p>
    </EmployeeShell>
  );
}
