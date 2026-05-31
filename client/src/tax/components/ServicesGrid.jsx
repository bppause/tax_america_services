import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import VideoEmbed from './VideoEmbed';
import { useLandingCopy } from '../lib/landingCopy';
import LeadChatWidget from './LeadChatWidget';
import CertBadge from './CertBadge';

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
export default function ServicesGrid({ products, community, onRequestService }) {
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

  const aiLabel = locale === 'es'
    ? 'Preguntas? Habla con nuestro asistente de IA'
    : 'Questions? Chat with our AI assistant';

  return (
    <section className="tax-section" id="services">
      <div className="tax-container">
        <h2>{pick('services.heading')}</h2>
        <p className="tax-section__lede">{pick('services.subheading')}</p>

        {/* AI agent availability banner */}
        {community && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
            border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 25%, #fff)',
            borderRadius: 10, padding: '10px 16px', marginBottom: 24,
            fontSize: 14,
          }}>
            <span style={{ fontSize: 20 }}>🤖</span>
            <span>
              <strong>{locale === 'es' ? '¿Tienes preguntas sobre nuestros servicios?' : 'Have questions about our services?'}</strong>
              {' '}
              {locale === 'es'
                ? 'Nuestro asistente de IA puede responderte al instante — solo haz clic en cualquier servicio y elige la pestaña "Preguntar al asistente".'
                : 'Our AI assistant can answer them instantly — click any service card and open the "Ask AI assistant" tab, or use the chat button below.'}
            </span>
          </div>
        )}

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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div className="tax-service-card__icon">{ICON_LETTER[p.icon] || '•'}</div>
                  {community && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '.4px',
                      background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                      color: 'var(--tax-brand-primary)', borderRadius: 20,
                      padding: '2px 8px', whiteSpace: 'nowrap',
                    }}>
                      🤖 {locale === 'es' ? 'IA disponible' : 'AI Q&A'}
                    </span>
                  )}
                </div>
                <span className="tax-service-card__category">{categoryLabel}</span>
                <h3>{name}</h3>
                {Array.isArray(p.certifications) && p.certifications.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                    {p.certifications.map((c, i) => (
                      <CertBadge key={i} label={c} />
                    ))}
                  </div>
                )}
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
          community={community}
          products={products}
          onClose={() => setOpenId(null)}
          onRequest={() => onRequest(open.slug)}
        />
      )}
    </section>
  );
}

function ServiceDetailModal({ product, locale, t, community, products, onClose, onRequest }) {
  const closeRef = useRef(null);
  const [tab, setTab] = useState('info'); // 'info' | 'chat'

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

  const tabLabel = {
    info: locale === 'es' ? 'Información' : 'About',
    chat: locale === 'es' ? 'Preguntar al asistente' : 'Ask AI assistant',
  };

  return (
    <div className="tax-modal" role="dialog" aria-modal="true" aria-labelledby="svcmodal-title"
         onClick={onClose}>
      <div className="tax-modal__panel" onClick={e => e.stopPropagation()}>
        <button type="button" ref={closeRef} className="tax-modal__close"
                onClick={onClose} aria-label={t('services.modal.close')}>×</button>
        <span className="tax-service-card__category">{categoryLabel}</span>
        <h3 id="svcmodal-title" className="tax-modal__title">{name}</h3>

        {/* Tab bar */}
        {community && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--tax-border)' }}>
            {['info', 'chat'].map(tabKey => (
              <button key={tabKey} type="button"
                onClick={() => setTab(tabKey)}
                style={{
                  padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  background: 'transparent', borderBottom: tab === tabKey ? '2px solid var(--tax-brand-primary, #1d3a6d)' : '2px solid transparent',
                  color: tab === tabKey ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-muted)',
                  marginBottom: -1,
                }}>
                {tabLabel[tabKey]}
              </button>
            ))}
          </div>
        )}

        {tab === 'info' && (
          <>
            {Array.isArray(product.certifications) && product.certifications.length > 0 && (
              <div style={{
                background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 8,
                padding: '10px 14px', marginBottom: 14,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#92400e', marginBottom: 6 }}>
                  {locale === 'es' ? 'Certificaciones y credenciales' : 'Certifications & credentials'}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {product.certifications.map((c, i) => (
                    <CertBadge key={i} label={c} />
                  ))}
                </div>
              </div>
            )}
            {videoUrl && <VideoEmbed url={videoUrl} title={name} />
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
              {community && (
                <button type="button" className="tax-btn tax-btn--ghost"
                        onClick={() => setTab('chat')}
                        style={{ color: 'var(--tax-brand-primary, #1d3a6d)' }}>
                  {locale === 'es' ? '¿Tienes preguntas? Pregunta al asistente →' : 'Have questions? Ask AI →'}
                </button>
              )}
              <button type="button" className="tax-btn tax-btn--primary"
                      onClick={onRequest}>
                {t('services.modal.requestCta')}
              </button>
              <button type="button" className="tax-btn tax-btn--ghost"
                      onClick={onClose} style={{ color: 'var(--tax-text)' }}>
                {t('services.modal.close')}
              </button>
            </div>
          </>
        )}

        {tab === 'chat' && community && (
          <div style={{ height: 440 }}>
            <LeadChatWidget
              community={community}
              products={products}
              preselectedProduct={product}
            />
          </div>
        )}
      </div>
    </div>
  );
}
