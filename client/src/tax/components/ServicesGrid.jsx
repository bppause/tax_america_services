import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import VideoEmbed from './VideoEmbed';
import { useLandingCopy } from '../lib/landingCopy';

const ICON_LETTER = {
  receipt: 'IR', briefcase: 'BT', 'id-card': 'ID', book: 'BK', wallet: 'PR',
  building: 'BF', stamp: 'NT', globe: 'TR', scales: 'IRS', calculator: 'ST',
};

// Home-page service catalog. Renders short summary cards in a grid;
// clicking a card opens a detail modal with the long description,
// required-documents bullets, optional embedded video, and a "Request
// this service" CTA. Earlier inline-list variant was rolled back per
// the owner request — full descriptions live behind a click again so
// the landing page stays scannable.
export default function ServicesGrid({ products, onRequestService }) {
  const { locale, t } = useT();
  const { pick } = useLandingCopy();
  const [openId, setOpenId] = useState(null);
  const open = products.find(p => p.id === openId) || null;

  const onRequest = (slug) => {
    setOpenId(null);
    if (typeof onRequestService === 'function') onRequestService(slug);
  };

  // Auto-open service modal when URL hash matches #service-{slug}
  // (e.g. links from WhatsApp messages or the PDF brochure).
  useEffect(() => {
    const hash = window.location.hash; // e.g. "#service-business-tax-prep"
    if (!hash.startsWith('#service-')) return;
    const slug = hash.slice('#service-'.length);
    const match = products.find(p => p.slug === slug);
    if (match) setOpenId(match.id);
  }, [products]);

  return (
    <section className="tax-section" id="services">
      <div className="tax-container">
        <h2>{pick('services.heading')}</h2>
        <p className="tax-section__lede">{pick('services.subheading')}</p>
        <div className="tax-services-grid">
          {products.map(p => {
            const name = pickI18n(p.name_i18n, locale).value;
            const desc = pickI18n(p.description_i18n, locale).value;
            const categoryLabel = t(`services.category.${p.category}`);
            return (
              <button type="button" key={p.id}
                      id={`service-${p.slug}`}
                      className="tax-service-card tax-service-card--button"
                      onClick={() => setOpenId(p.id)}
                      aria-label={t('services.card.openAria', { name })}>
                <div className="tax-service-card__icon">{ICON_LETTER[p.icon] || '•'}</div>
                <span className="tax-service-card__category">{categoryLabel}</span>
                <h3>{name}</h3>
                <p>{desc}</p>
                <span className="tax-service-card__more">
                  {t('services.card.learnMore')} →
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {open && (
        <ServiceDetailModal
          product={open}
          locale={locale}
          t={t}
          onClose={() => setOpenId(null)}
          onRequest={() => onRequest(open.slug)}
        />
      )}
    </section>
  );
}

function ServiceDetailModal({ product, locale, t, onClose, onRequest }) {
  const closeRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const name = pickI18n(product.name_i18n, locale).value;
  const desc = pickI18n(product.description_i18n, locale).value;
  const longDesc = pickI18n(product.long_description_i18n, locale).value;
  const categoryLabel = t(`services.category.${product.category}`);
  const videoUrl = product.video_url || '';

  const requires = Array.isArray(product.required_documents) ? product.required_documents : [];
  const requiresLabels = requires.map(d => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') return pickI18n(d.name_i18n || d.label_i18n || {}, locale).value || d.name || d.label || '';
    return '';
  }).filter(Boolean);

  return (
    <div className="tax-modal" role="dialog" aria-modal="true" aria-labelledby="svcmodal-title"
         onClick={onClose}>
      <div className="tax-modal__panel" onClick={e => e.stopPropagation()}>
        <button type="button" ref={closeRef} className="tax-modal__close"
                onClick={onClose} aria-label={t('services.modal.close')}>×</button>
        {videoUrl && <VideoEmbed url={videoUrl} title={name} />}
        <span className="tax-service-card__category">{categoryLabel}</span>
        <h3 id="svcmodal-title" className="tax-modal__title">{name}</h3>
        <p className="tax-modal__desc">{desc}</p>
        {longDesc && (
          <div className="tax-modal__longdesc">
            {longDesc.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        )}
        {requiresLabels.length > 0 && (
          <div className="tax-modal__section">
            <h4>{t('services.modal.requires')}</h4>
            <ul>
              {requiresLabels.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
        <div className="tax-modal__actions">
          <button type="button" className="tax-btn tax-btn--primary"
                  onClick={onRequest}>
            {t('services.modal.requestCta')}
          </button>
          <button type="button" className="tax-btn tax-btn--ghost"
                  onClick={onClose} style={{ color: 'var(--tax-text)' }}>
            {t('services.modal.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
