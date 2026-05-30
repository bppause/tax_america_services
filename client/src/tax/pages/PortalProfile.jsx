import { useEffect, useRef, useState } from 'react';
import { hasSavedLocale, pickI18n, useT } from '../i18n';
import { useTaxAuth } from '../auth/AuthProvider';
import { taxApi } from '../api';
import PortalShell from '../components/PortalShell';

const CATEGORY_KEY = {
  business: 'portal.profile.category.business',
  individual: 'portal.profile.category.individual',
  general: 'portal.profile.category.general',
  audit: 'portal.profile.category.audit',
};

// E.164 validator: + followed by 7-15 digits, first not zero. Mirrors the
// server-side regex in routes.js so the user gets immediate feedback before
// the round-trip. The server still re-validates.
const WHATSAPP_E164 = /^\+[1-9]\d{6,14}$/;
function normalizeWhatsappForCheck(raw) {
  const trimmed = String(raw || '').trim();
  return '+' + trimmed.replace(/^\+/, '').replace(/\D+/g, '');
}

export default function PortalProfile() {
  const { locale, setLocale, t } = useT();
  const { fbUser, customer, community, prefs, relationships, refreshMe } = useTaxAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  // ── Profile form state (Phase 2e) ───────────────────────────────────────
  const [form, setForm] = useState({
    firstName: '', middleName: '', lastName: '',
    phone: '', whatsapp: '', preferredEmail: '', locale: 'es',
    addr: { line1: '', line2: '', city: '', state: '', postal_code: '', country: 'US' },
  });
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle'|'saving'|'saved'|error string
  const debounceRef = useRef(null);
  const savedTimerRef = useRef(null);
  useEffect(() => () => { clearTimeout(debounceRef.current); clearTimeout(savedTimerRef.current); }, []);

  // Hydrate the form from the auth context whenever the customer record
  // refreshes (initial load, post-save).
  useEffect(() => {
    if (!customer) return;
    const a = customer.address || {};
    setForm({
      firstName: customer.first_name || '',
      middleName: customer.middle_name || '',
      lastName: customer.last_name || '',
      phone: customer.phone || '',
      whatsapp: customer.whatsapp || '',
      preferredEmail: customer.preferredCommunicationEmail || '',
      locale: customer.locale === 'en' ? 'en' : 'es',
      addr: {
        line1: a.line1 || '', line2: a.line2 || '',
        city: a.city || '', state: a.state || '',
        postal_code: a.postal_code || '',
        country: a.country || 'US',
      },
    });
  }, [customer]);

  const doSave = useRef(null);
  doSave.current = async (overrides = {}) => {
    const d = { ...form, ...overrides };
    const wn = d.whatsapp ? normalizeWhatsappForCheck(d.whatsapp) : '';
    if (d.whatsapp && !WHATSAPP_E164.test(wn)) {
      setSaveStatus(t('portal.profile.whatsapp.invalid'));
      return;
    }
    setSaveStatus('saving');
    try {
      const address = {};
      for (const k of ['line1', 'line2', 'city', 'state', 'postal_code', 'country']) {
        const v = String((d.addr || {})[k] || '').trim();
        if (v) address[k] = v;
      }
      await taxApi.updateProfile(auth, {
        firstName: d.firstName.trim(),
        middleName: d.middleName.trim(),
        lastName: d.lastName.trim(),
        phone: d.phone.trim(),
        whatsapp: d.whatsapp.trim(),
        address,
        preferredCommunicationEmail: d.preferredEmail.trim(),
        locale: d.locale,
      });
      if (d.locale !== locale) setLocale(d.locale);
      setSaveStatus('saved');
      refreshMe();
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (e) {
      setSaveStatus(e?.message || 'Save failed');
    }
  };

  const scheduleAutoSave = (overrides = {}) => {
    clearTimeout(debounceRef.current);
    clearTimeout(savedTimerRef.current);
    debounceRef.current = setTimeout(() => doSave.current(overrides), 1200);
  };

  const saveNow = (overrides = {}) => {
    clearTimeout(debounceRef.current);
    clearTimeout(savedTimerRef.current);
    doSave.current(overrides);
  };

  const onField = (k, v, immediate = false) => {
    setForm(p => ({ ...p, [k]: v }));
    if (immediate) saveNow({ [k]: v }); else scheduleAutoSave({ [k]: v });
  };
  const onAddr = (k, v) => {
    setForm(p => ({ ...p, addr: { ...p.addr, [k]: v } }));
    scheduleAutoSave();
  };

  const whatsappNormalized = form.whatsapp ? normalizeWhatsappForCheck(form.whatsapp) : '';
  const whatsappValid = !form.whatsapp || WHATSAPP_E164.test(whatsappNormalized);
  const waLink = whatsappValid && whatsappNormalized.length > 1
    ? `https://wa.me/${whatsappNormalized.replace(/^\+/, '')}`
    : '';


  // First-load sync: if the customer has a saved profile locale and the
  // browser has no explicit user choice yet (no localStorage), apply the
  // profile locale to the UI so it follows the user across devices.
  useEffect(() => {
    if (!customer) return;
    const profileLocale = customer.locale === 'en' ? 'en' : 'es';
    if (!hasSavedLocale() && profileLocale !== locale) setLocale(profileLocale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.id]);

  // ── Notification preferences state (unchanged from Phase 2a/2b) ────────
  const allowChange = Boolean(prefs?.allowChange);
  const initial = prefs?.channels || ['email', 'in_app'];
  const [emailPref, setEmailPref] = useState(initial.includes('email'));
  const [inAppPref, setInAppPref] = useState(initial.includes('in_app'));
  const [prefsStatus, setPrefsStatus] = useState('idle');
  const prefsSavedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(prefsSavedTimerRef.current), []);

  const savePrefsNow = async (ep, ip) => {
    const channels = [];
    if (ep) channels.push('email');
    if (ip) channels.push('in_app');
    if (!channels.length) { setPrefsStatus(t('portal.profile.atLeastOne')); return; }
    setPrefsStatus('saving');
    try {
      await taxApi.updatePreferences(auth, { channels });
      setPrefsStatus('saved');
      refreshMe();
      prefsSavedTimerRef.current = setTimeout(() => setPrefsStatus('idle'), 2500);
    } catch (err) {
      setPrefsStatus(err?.message || 'Save failed');
    }
  };

  return (
    <PortalShell community={community} active="profile">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('portal.profile.title')}</h2>
        {saveStatus === 'saving' && <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>Saving…</span>}
        {saveStatus === 'saved'  && <span style={{ fontSize: 11, color: 'var(--tax-success, #166534)' }}>✓ Saved</span>}
        {saveStatus !== 'idle' && saveStatus !== 'saving' && saveStatus !== 'saved' && (
          <span style={{ fontSize: 11, color: 'var(--tax-error)' }}>{saveStatus}</span>
        )}
      </div>

      {/* ── Editable profile form ─────────────────────────────────────── */}
      <form className="tax-form" noValidate style={{ maxWidth: 720 }}>
        <div className="tax-form__row3">
          <div>
            <label htmlFor="pp-first">{t('owner.customers.fieldFirstName')}</label>
            <input id="pp-first" type="text" value={form.firstName}
                   onChange={e => onField('firstName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label htmlFor="pp-middle">{t('owner.customers.fieldMiddleName')}</label>
            <input id="pp-middle" type="text" value={form.middleName}
                   onChange={e => onField('middleName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label htmlFor="pp-last">{t('owner.customers.fieldLastName')}</label>
            <input id="pp-last" type="text" value={form.lastName}
                   onChange={e => onField('lastName', e.target.value)} maxLength={80} />
          </div>
        </div>
        <div>
          <label htmlFor="pp-login-email">
            {t('portal.profile.email')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              ({t('portal.profile.email.readonly')})
            </span>
          </label>
          <input id="pp-login-email" type="email" value={customer?.email || ''} readOnly
                 style={{ background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)' }} />
        </div>

        <div className="tax-form__row2">
          <div>
            <label htmlFor="pp-phone">{t('portal.profile.phone')}</label>
            <input id="pp-phone" type="tel" value={form.phone}
                   placeholder="(415) 555-1234"
                   onChange={e => onField('phone', e.target.value)} maxLength={40} />
          </div>
          <div>
            <label htmlFor="pp-whatsapp">
              {t('portal.profile.whatsapp')}
              <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                {t('portal.profile.whatsapp.format')}
              </span>
            </label>
            <input id="pp-whatsapp" type="tel" value={form.whatsapp}
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
          <label htmlFor="pp-pref-email">
            {t('portal.profile.preferredEmail')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              {t('portal.profile.preferredEmail.hint')}
            </span>
          </label>
          <input id="pp-pref-email" type="email" value={form.preferredEmail}
                 placeholder={customer?.email || ''}
                 onChange={e => onField('preferredEmail', e.target.value)} maxLength={200} />
        </div>

        <div>
          <label htmlFor="pp-locale">
            {t('portal.profile.language')}
            <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
              {t('portal.profile.language.hint')}
            </span>
          </label>
          <select id="pp-locale" value={form.locale}
                  onChange={e => onField('locale', e.target.value, true)}
                  style={{ maxWidth: 280 }}>
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>

        <fieldset style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 16, margin: 0 }}>
          <legend style={{ padding: '0 8px', fontWeight: 600, fontSize: 14 }}>{t('portal.profile.address')}</legend>
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label htmlFor="pp-addr1">{t('portal.profile.address.line1')}</label>
              <input id="pp-addr1" type="text" value={form.addr.line1}
                     onChange={e => onAddr('line1', e.target.value)} maxLength={200} />
            </div>
            <div>
              <label htmlFor="pp-addr2">{t('portal.profile.address.line2')}</label>
              <input id="pp-addr2" type="text" value={form.addr.line2}
                     placeholder={t('portal.profile.address.line2.placeholder')}
                     onChange={e => onAddr('line2', e.target.value)} maxLength={200} />
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="pp-city">{t('portal.profile.address.city')}</label>
                <input id="pp-city" type="text" value={form.addr.city}
                       onChange={e => onAddr('city', e.target.value)} maxLength={120} />
              </div>
              <div>
                <label htmlFor="pp-state">{t('portal.profile.address.state')}</label>
                <input id="pp-state" type="text" value={form.addr.state}
                       onChange={e => onAddr('state', e.target.value)} maxLength={80} />
              </div>
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="pp-postal">{t('portal.profile.address.postal')}</label>
                <input id="pp-postal" type="text" value={form.addr.postal_code}
                       onChange={e => onAddr('postal_code', e.target.value)} maxLength={20} />
              </div>
              <div>
                <label htmlFor="pp-country">{t('portal.profile.address.country')}</label>
                <input id="pp-country" type="text" value={form.addr.country}
                       onChange={e => onAddr('country', e.target.value)} maxLength={4}
                       placeholder="US" />
              </div>
            </div>
          </div>
        </fieldset>

      </form>

      {/* Services (read-only) — the language preference moved into the
          editable form above so it can drive outgoing emails. */}
      <h3 style={{ marginTop: 40 }}>{t('portal.profile.services')}</h3>
      <p className="tax-section__lede" style={{ marginBottom: 16 }}>
        {t('portal.profile.servicesHint')}
      </p>
      {relationships && relationships.length > 0
        ? <RelationshipChips relationships={relationships} locale={locale} t={t} />
        : <p style={{ color: 'var(--tax-muted)', marginBottom: 32 }}>{t('portal.profile.noServices')}</p>}

      {/* ── Notification preferences (unchanged from 2a/2b) ──────────── */}
      <h3 style={{ marginTop: 32 }}>{t('portal.profile.notifications')}</h3>
      <p className="tax-section__lede" style={{ marginBottom: 16 }}>
        {allowChange ? t('portal.profile.notifications.editable') : t('portal.profile.notifications.locked')}
      </p>

      <div className="tax-form" style={{ maxWidth: 480 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: allowChange ? 'pointer' : 'default' }}>
          <input type="checkbox" checked={emailPref} disabled={!allowChange}
                 onChange={e => { setEmailPref(e.target.checked); savePrefsNow(e.target.checked, inAppPref); }} />
          <span>{t('portal.profile.channel.email')}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: allowChange ? 'pointer' : 'default' }}>
          <input type="checkbox" checked={inAppPref} disabled={!allowChange}
                 onChange={e => { setInAppPref(e.target.checked); savePrefsNow(emailPref, e.target.checked); }} />
          <span>{t('portal.profile.channel.inApp')}</span>
        </label>

        {prefsStatus === 'saving' && <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>Saving…</span>}
        {prefsStatus === 'saved'  && <span style={{ fontSize: 11, color: 'var(--tax-success, #166534)' }}>✓ Saved</span>}
        {prefsStatus !== 'idle' && prefsStatus !== 'saving' && prefsStatus !== 'saved' && (
          <div className="tax-msg tax-msg--error">{prefsStatus}</div>
        )}
      </div>

      <p style={{ marginTop: 32, color: 'var(--tax-muted)', fontSize: 14 }}>
        {t('portal.profile.contactToChange')} {community?.contact_email && (
          <a href={`mailto:${community.contact_email}`}>{community.contact_email}</a>
        )}
      </p>
    </PortalShell>
  );
}

function RelationshipChips({ relationships, locale, t }) {
  // Group by category so the chip list reads in a predictable order
  // (Business → Individual → General → Audit).
  const order = ['business', 'individual', 'general', 'audit'];
  const byCat = order.map(cat => ({
    category: cat,
    items: (relationships || [])
      .filter(r => r.type?.category === cat)
      .sort((a, b) => (a.type?.display_order || 0) - (b.type?.display_order || 0)),
  })).filter(g => g.items.length > 0);

  return (
    <div style={{ marginBottom: 16 }}>
      {byCat.map(g => (
        <div key={g.category} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.6px',
                        color: 'var(--tax-muted)', marginBottom: 6 }}>
            {t(CATEGORY_KEY[g.category])}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {g.items.map(r => (
              <span key={r.id} style={{
                display: 'inline-block', padding: '6px 12px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
                color: 'var(--tax-brand-primary)',
                border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 20%, #fff)',
                fontSize: 13, fontWeight: 600,
              }}>
                {pickI18n(r.type?.name_i18n, locale).value}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
