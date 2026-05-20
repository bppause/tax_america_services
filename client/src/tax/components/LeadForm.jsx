import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';

// Public-site lead form. Optimized for converting a prospect into a
// customer record with minimal re-entry: name parts mirror the
// customer profile (first / middle optional / last), phone is required,
// optional WhatsApp captures the channel a lot of leads actually
// respond on. Service chips drive the auto-tag handoff in the convert
// flow so the practice's team queue is pre-populated.
export default function LeadForm({ community, products, initialProductSlug }) {
  const { locale, t } = useT();
  const [form, setForm] = useState({
    customerType: 'individual',
    firstName: '', middleName: '', lastName: '',
    email: '', phone: '', whatsapp: '', company: '',
    productSlugs: [], message: '', website: '',
  });
  const [status, setStatus] = useState({ kind: 'idle', message: '' });

  // When the visitor clicked "Request this service" on a service card,
  // Landing forwards the slug here. Add it to the selection (don't
  // replace — they may already have picked others).
  useEffect(() => {
    if (!initialProductSlug) return;
    setForm(f => f.productSlugs.includes(initialProductSlug)
      ? f
      : { ...f, productSlugs: [...f.productSlugs, initialProductSlug] });
  }, [initialProductSlug]);

  const visibleProducts = (products || []).filter(p => p.enabled !== false);

  const onChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const toggleService = (slug) => setForm(f => ({
    ...f,
    productSlugs: f.productSlugs.includes(slug)
      ? f.productSlugs.filter(s => s !== slug)
      : [...f.productSlugs, slug],
  }));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (status.kind === 'submitting') return;
    setStatus({ kind: 'submitting', message: '' });
    try {
      await taxApi.submitLead({
        communitySlug: community.id,
        customerType: form.customerType,
        firstName: form.firstName,
        middleName: form.middleName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        whatsapp: form.whatsapp,
        company: form.customerType === 'business' ? form.company : '',
        productSlugs: form.productSlugs,
        message: form.message,
        locale,
        website: form.website,
      });
      setStatus({ kind: 'success', message: '' });
      setForm({ customerType: 'individual',
                firstName: '', middleName: '', lastName: '',
                email: '', phone: '', whatsapp: '', company: '',
                productSlugs: [], message: '', website: '' });
    } catch (err) {
      const isNetwork = !err?.status;
      setStatus({
        kind: 'error',
        message: isNetwork ? t('lead.error.network') : (err.message || t('lead.error.generic')),
      });
    }
  };

  if (status.kind === 'success') {
    return (
      <div className="tax-form" role="status">
        <div className="tax-msg tax-msg--success">
          <strong>{t('lead.success.heading')}</strong>
          <div style={{ marginTop: 6 }}>{t('lead.success.body')}</div>
        </div>
      </div>
    );
  }

  return (
    <form className="tax-form" onSubmit={onSubmit} noValidate>
      {/* Two-state classification toggle. Drives whether the Business
          name field is shown + required. Default 'individual' matches
          the server-side default and keeps the form lean for the
          common case. */}
      <div role="radiogroup" aria-label={t('lead.field.customerType')}
           style={{ display: 'flex', gap: 8 }}>
        {['individual', 'business'].map(opt => {
          const active = form.customerType === opt;
          return (
            <button key={opt} type="button"
                    role="radio" aria-checked={active}
                    onClick={() => setForm(f => ({ ...f, customerType: opt }))}
                    style={{
                      flex: '1 1 auto', padding: '10px 14px', borderRadius: 8,
                      background: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                        : '#fff',
                      color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                      border: '1px solid',
                      borderColor: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                        : 'var(--tax-border)',
                      fontSize: 14, fontWeight: active ? 700 : 500,
                      cursor: 'pointer', textAlign: 'center',
                    }}>
              {active ? '✓ ' : ''}{t(`lead.field.customerType.${opt}`)}
            </button>
          );
        })}
      </div>
      <div className="tax-form__row3">
        <div>
          <label htmlFor="lead-first">{t('lead.field.firstName')}</label>
          <input id="lead-first" name="firstName" type="text" required autoComplete="given-name"
                 value={form.firstName} onChange={onChange} maxLength={80} />
        </div>
        <div>
          <label htmlFor="lead-middle">{t('lead.field.middleName')}</label>
          <input id="lead-middle" name="middleName" type="text" autoComplete="additional-name"
                 value={form.middleName} onChange={onChange} maxLength={80} />
        </div>
        <div>
          <label htmlFor="lead-last">{t('lead.field.lastName')}</label>
          <input id="lead-last" name="lastName" type="text" required autoComplete="family-name"
                 value={form.lastName} onChange={onChange} maxLength={80} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label htmlFor="lead-email">{t('lead.field.email')}</label>
          <input id="lead-email" name="email" type="email" required autoComplete="email"
                 value={form.email} onChange={onChange} />
        </div>
        <div>
          <label htmlFor="lead-phone">{t('lead.field.phone.required')}</label>
          <input id="lead-phone" name="phone" type="tel" required autoComplete="tel"
                 value={form.phone} onChange={onChange} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label htmlFor="lead-whatsapp">{t('lead.field.whatsapp')}</label>
          <input id="lead-whatsapp" name="whatsapp" type="tel" autoComplete="tel"
                 placeholder="+14155551234"
                 value={form.whatsapp} onChange={onChange} maxLength={40} />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
            {t('lead.field.whatsapp.hint')}
          </p>
        </div>
        {form.customerType === 'business' ? (
          <div>
            <label htmlFor="lead-company">{t('lead.field.businessName')}</label>
            <input id="lead-company" name="company" type="text"
                   required autoComplete="organization"
                   placeholder={t('lead.field.businessName.placeholder')}
                   value={form.company} onChange={onChange} maxLength={200} />
          </div>
        ) : (
          /* Empty slot keeps the row's 2-column rhythm so phone +
             WhatsApp stay aligned when the visitor is an individual. */
          <div />
        )}
      </div>

      {visibleProducts.length > 0 && (
        <div>
          <label>{t('lead.field.services')}</label>
          <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('lead.field.services.hint')}
          </p>
          <div role="group" aria-label={t('lead.field.services')}
               style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {visibleProducts.map(p => {
              const label = pickI18n(p.name_i18n, locale).value || p.slug;
              const desc  = pickI18n(p.description_i18n, locale).value || '';
              const checked = form.productSlugs.includes(p.slug);
              return (
                <button key={p.id} type="button"
                        onClick={() => toggleService(p.slug)}
                        aria-pressed={checked}
                        title={desc || undefined}
                        style={{
                          padding: '6px 12px', borderRadius: 999,
                          background: checked
                            ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                            : '#fff',
                          color: checked ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                          border: '1px solid',
                          borderColor: checked
                            ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                            : 'var(--tax-border)',
                          fontSize: 13, fontWeight: checked ? 700 : 500,
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}>
                  {checked ? '✓ ' : '+ '}{label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="lead-message">{t('lead.field.message')}</label>
        <textarea id="lead-message" name="message" rows={3}
                  placeholder={t('lead.field.message.placeholder')}
                  value={form.message} onChange={onChange} />
      </div>

      {/* Honeypot — bots fill this; real users never see it. */}
      <div className="tax-form__honeypot" aria-hidden="true">
        <label htmlFor="lead-website">Website</label>
        <input id="lead-website" name="website" type="text" tabIndex={-1} autoComplete="off"
               value={form.website} onChange={onChange} />
      </div>

      {status.kind === 'error' && (
        <div className="tax-msg tax-msg--error" role="alert">{status.message}</div>
      )}

      <button type="submit" className="tax-btn tax-btn--primary tax-btn--block"
              disabled={status.kind === 'submitting'}>
        {status.kind === 'submitting' ? t('lead.submitting') : t('lead.submit')}
      </button>
    </form>
  );
}
