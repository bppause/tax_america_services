import { useT } from '../i18n';
import LeadWizard from './LeadWizard';
import { useCalendlyPopup } from './CalendlySection';
import { useLandingCopy } from '../lib/landingCopy';

// Address used for two purposes:
//   1. Plaintext on the contact card.
//   2. Encoded as a Google Maps query for the embed iframe + the
//      "Get directions" link (no API key needed for either).
function buildAddress(c) {
  const lines = [c.address_line1, c.address_line2].filter(Boolean);
  const cityLine = [c.city, c.state, c.postal_code].filter(Boolean).join(', ');
  return [...lines, cityLine, c.country].filter(Boolean).join(' • ');
}
function buildMapQuery(c) {
  return [c.address_line1, c.address_line2, c.city, c.state, c.postal_code, c.country]
    .filter(Boolean).join(', ');
}
// E.164 numbers stored as `+14155551234`; wa.me wants digits only.
function waDigits(raw) {
  return String(raw || '').trim().replace(/^\+/, '').replace(/\D+/g, '');
}

export default function Contact({ community, products, initialProductSlug }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const address = buildAddress(community);
  const mapQuery = buildMapQuery(community);
  const hasMap = !!mapQuery;
  const embedSrc = hasMap
    ? `https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed`
    : '';
  const directionsHref = hasMap
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQuery)}`
    : '';

  const waNumber = waDigits(community.whatsapp);
  const waHref = waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(
        t('contact.whatsapp.prefill', { name: community.name || '' })
      )}`
    : '';

  const { open: openCalendly, available: calendlyAvailable } =
    useCalendlyPopup(community?.calendly_url, locale);

  const infoCard = (
    <ContactInfoCard t={t}
      address={address} hasMap={hasMap}
      directionsHref={directionsHref} embedSrc={embedSrc}
      community={community} waNumber={waNumber} waHref={waHref} />
  );

  return (
    <section className="tax-section tax-section--alt" id="contact">
      <div className="tax-container">
        <h2>{pick('getStarted.heading')}</h2>
        <p className="tax-section__lede">{pick('getStarted.subheading')}</p>

        {/* Two parallel paths to action when Calendly is configured.
            Without it the lead form keeps the legacy two-column
            layout with the contact-info card on its right. */}
        {calendlyAvailable ? (
          <>
            <div className="tax-twopath">
              <article className="tax-twopath__card">
                <div className="tax-twopath__icon" aria-hidden="true">📅</div>
                <h3 className="tax-twopath__title">{pick('getStarted.scheduleHeading')}</h3>
                <p className="tax-twopath__body">{pick('getStarted.scheduleBody')}</p>
                <button type="button" className="tax-btn tax-btn--primary tax-btn--block"
                        onClick={openCalendly}>
                  {pick('landing.calendly.cta')}
                </button>
              </article>
              <article className="tax-twopath__card">
                <div className="tax-twopath__icon" aria-hidden="true">✉️</div>
                <h3 className="tax-twopath__title">{pick('getStarted.messageHeading')}</h3>
                <p className="tax-twopath__body">{pick('getStarted.messageBody')}</p>
                <LeadWizard community={community} products={products}
                            initialProductSlug={initialProductSlug} />
              </article>
            </div>
            <div style={{ marginTop: 32 }}>{infoCard}</div>
          </>
        ) : (
          <div className="tax-contact-layout">
            <LeadWizard community={community} products={products}
                        initialProductSlug={initialProductSlug} />
            <div>{infoCard}</div>
          </div>
        )}
      </div>
    </section>
  );
}

// Practice address / phone / WhatsApp / email + a Google Maps embed.
// Renders below the two-path layout when Calendly is on, or beside the
// lead form when it isn't.
function ContactInfoCard({ t, address, hasMap, directionsHref, embedSrc, community, waNumber, waHref }) {
  return (
    <>
      <h3 style={{ marginTop: 0 }}>{t('contact.heading')}</h3>
      <div className="tax-contact-grid">
        {address && (
          <div className="tax-contact-item">
            <div className="tax-contact-item__label">{t('contact.address')}</div>
            <div className="tax-contact-item__value">{address}</div>
            {hasMap && (
              <a href={directionsHref} target="_blank" rel="noopener noreferrer"
                 style={{ display: 'inline-block', marginTop: 6, fontSize: 13, fontWeight: 600 }}>
                {t('contact.directions')} ↗
              </a>
            )}
          </div>
        )}
        {community.phone && (
          <div className="tax-contact-item">
            <div className="tax-contact-item__label">{t('contact.phone')}</div>
            <div className="tax-contact-item__value">
              <a href={`tel:${community.phone}`}>{community.phone}</a>
            </div>
          </div>
        )}
        {waNumber && (
          <div className="tax-contact-item">
            <div className="tax-contact-item__label">{t('contact.whatsapp')}</div>
            <div className="tax-contact-item__value">
              <a href={waHref} target="_blank" rel="noopener noreferrer"
                 style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span aria-hidden="true">💬</span>
                <span>{t('contact.whatsapp.chatBtn')}</span>
              </a>
            </div>
          </div>
        )}
        {community.contact_email && (
          <div className="tax-contact-item">
            <div className="tax-contact-item__label">{t('contact.email')}</div>
            <div className="tax-contact-item__value">
              <a href={`mailto:${community.contact_email}`}>{community.contact_email}</a>
            </div>
          </div>
        )}
      </div>

      {hasMap && (
        <div style={{
          marginTop: 16, borderRadius: 12, overflow: 'hidden',
          border: '1px solid var(--tax-border)', boxShadow: 'var(--tax-shadow-sm)',
        }}>
          <iframe
            title={t('contact.map.title')}
            src={embedSrc}
            style={{ width: '100%', height: 260, border: 0, display: 'block' }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
          />
          <a href={directionsHref} target="_blank" rel="noopener noreferrer"
             style={{
               display: 'block', padding: '10px 12px', textAlign: 'center',
               background: 'var(--tax-bg-alt)', fontSize: 13, fontWeight: 600,
               textDecoration: 'none', color: 'var(--tax-brand-primary)',
               borderTop: '1px solid var(--tax-border)',
             }}>
            {t('contact.directions.openInMaps')}
          </a>
        </div>
      )}
    </>
  );
}
