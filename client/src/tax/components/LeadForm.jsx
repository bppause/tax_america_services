import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';

// Canonical group order. Categories not in this list slot in after the
// known ones under the "other" bucket so the form never silently hides a
// service the owner has configured.
const CATEGORY_ORDER = ['tax_prep', 'recurring', 'one_off', 'custom'];

export default function LeadForm({ community, products, initialProductSlug }) {
  const { locale, t } = useT();

  // Group services by category, preserving the owner-defined display_order
  // inside each group. Caller already sorts `products` by display_order.
  const groups = useMemo(() => {
    const buckets = new Map();
    for (const p of products || []) {
      const cat = CATEGORY_ORDER.includes(p.category) ? p.category : 'other';
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(p);
    }
    const ordered = [];
    for (const cat of [...CATEGORY_ORDER, 'other']) {
      if (buckets.has(cat)) ordered.push({ cat, items: buckets.get(cat) });
    }
    return ordered;
  }, [products]);
  // Phase 4n.12: multi-select services. `productSlugs` is the live state;
  // submitted as an array. Submission still degrades gracefully if a future
  // client/server pair forgets to send the array (server falls back to the
  // legacy `productSlug` body field).
  const [form, setForm] = useState({
    firstName: '', middleName: '', lastName: '',
    email: '', phone: '', company: '', productSlugs: [], message: '', website: '',
  });
  const [status, setStatus] = useState({ kind: 'idle', message: '' });

  // When the visitor clicks "Request this service" inside a card's modal,
  // Landing passes the slug down here. Add it to the selection (don't
  // replace — they may already have picked others) and flash a soft
  // highlight so they can see what changed when they land at the form.
  useEffect(() => {
    if (!initialProductSlug) return;
    setForm(f => f.productSlugs.includes(initialProductSlug)
      ? f
      : { ...f, productSlugs: [...f.productSlugs, initialProductSlug] });
  }, [initialProductSlug]);

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
        firstName: form.firstName,
        middleName: form.middleName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        company: form.company,
        productSlugs: form.productSlugs,
        message: form.message,
        locale,
        website: form.website,
      });
      setStatus({ kind: 'success', message: '' });
      setForm({ firstName: '', middleName: '', lastName: '', email: '', phone: '', company: '', productSlugs: [], message: '', website: '' });
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
      <div>
        <label>{t('lead.field.services')}</label>
        <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--tax-muted)' }}>
          {t('lead.field.services.hint')}
        </p>
        <div role="group" aria-label={t('lead.field.services')}
             style={{ display: 'grid', gap: 16 }}>
          {groups.map(g => (
            <div key={g.cat}>
              <div style={{
                fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em',
                color: 'var(--tax-muted)', fontWeight: 700, marginBottom: 8,
              }}>
                {t(`lead.field.services.cat.${g.cat}`)}
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {g.items.map(p => {
                  const label = pickI18n(p.name_i18n, locale).value || p.slug;
                  const desc  = pickI18n(p.description_i18n, locale).value || '';
                  const checked = form.productSlugs.includes(p.slug);
                  return (
                    <label key={p.id} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
                      padding: '10px 12px', border: '1px solid var(--tax-border)', borderRadius: 8,
                      background: checked ? 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)' : 'transparent',
                    }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleService(p.slug)}
                             style={{ marginTop: 3 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{label}</div>
                        {desc && (
                          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>{desc}</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="lead-message">{t('lead.field.message')}</label>
        <textarea id="lead-message" name="message" rows={5}
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
