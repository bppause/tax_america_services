import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';

// Public-site lead form. Optimized for a low-friction conversion:
// one name field, email + phone in a row, a row of service chips
// (no category headings), and an optional message. The server still
// supports the older firstName/middleName/lastName shape but we send
// a single `name` here — fewer fields = higher completion rate.
export default function LeadForm({ community, products, initialProductSlug }) {
  const { locale, t } = useT();
  const [form, setForm] = useState({
    name: '', email: '', phone: '', company: '',
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

  // Display order is already established by the parent (community feed
  // returns them sorted). Filter to enabled products only.
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
        name: form.name,
        email: form.email,
        phone: form.phone,
        company: form.company,
        productSlugs: form.productSlugs,
        message: form.message,
        locale,
        website: form.website,
      });
      setStatus({ kind: 'success', message: '' });
      setForm({ name: '', email: '', phone: '', company: '',
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
      <div>
        <label htmlFor="lead-name">{t('lead.field.fullName')}</label>
        <input id="lead-name" name="name" type="text" required autoComplete="name"
               value={form.name} onChange={onChange} maxLength={200} />
      </div>
      <div className="tax-form__row2">
        <div>
          <label htmlFor="lead-email">{t('lead.field.email')}</label>
          <input id="lead-email" name="email" type="email" required autoComplete="email"
                 value={form.email} onChange={onChange} />
        </div>
        <div>
          <label htmlFor="lead-phone">{t('lead.field.phone')}</label>
          <input id="lead-phone" name="phone" type="tel" autoComplete="tel"
                 value={form.phone} onChange={onChange} />
        </div>
      </div>
      <div>
        <label htmlFor="lead-company">{t('lead.field.company')}</label>
        <input id="lead-company" name="company" type="text" autoComplete="organization"
               placeholder={t('lead.field.company.placeholder')}
               value={form.company} onChange={onChange} maxLength={200} />
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
