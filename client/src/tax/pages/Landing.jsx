import { useEffect, useState } from 'react';
import { hasSavedLocale, useT } from '../i18n';
import { taxApi } from '../api';
import Header from '../components/Header';
import LeadChatWidget from '../components/LeadChatWidget';
import Hero from '../components/Hero';
import ServicesGrid from '../components/ServicesGrid';
import TeamSection from '../components/TeamSection';
import TestimonialsSection from '../components/TestimonialsSection';
import FaqsSection from '../components/FaqsSection';
import NewsSection from '../components/NewsSection';
import ArticlesSection from '../components/ArticlesSection';
import About from '../components/About';
import Contact from '../components/Contact';
import Footer from '../components/Footer';
import { LandingCopyProvider } from '../lib/landingCopy';

// Sets <head> meta for SEO + social previews. Best-effort from JS — non-JS
// crawlers (legacy Facebook/LinkedIn) won't see these. Server-side rendering
// of OG tags lands in Phase 2 if the marketing team needs perfect previews.
function setMeta(name, content, attr = 'name') {
  if (typeof document === 'undefined' || !content) return;
  let el = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export default function Landing({ communitySlug }) {
  const { locale, setLocale, t } = useT();
  const [state, setState] = useState({ kind: 'loading', data: null, error: '' });
  // Selected service from a "Request this service" click in the service
  // modal. Passed down to LeadForm so the chip is pre-checked when the
  // visitor lands at the contact form.
  const [pendingService, setPendingService] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  // Testimonials lifted to Landing so the Reviews nav link can hide
  // itself when there are zero rows (instead of linking to a section
  // that self-hides — a scroll-to-nothing surprise). Also captures
  // the owner's configured display limit so the section knows how
  // many cards to render without a second roundtrip.
  const [testimonials, setTestimonials] = useState(null);
  const [testimonialsLimit, setTestimonialsLimit] = useState(null);
  // News articles: same lift-up pattern so the News nav link can hide
  // itself when the feed is empty.
  const [news, setNews] = useState(null);
  const [newsLimit, setNewsLimit] = useState(null);
  // Articles + deadlines: fetched here so the nav links can hide when empty.
  const [hasArticles, setHasArticles] = useState(null);
  const [hasDeadlines, setHasDeadlines] = useState(null);

  const onRequestService = (slug) => {
    setPendingService(slug);
    // Defer the scroll until React has time to render the updated form
    // state (so the chip pre-check is visible by the time the user
    // arrives at the section).
    setTimeout(() => {
      const el = document.getElementById('contact');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading', data: null, error: '' });
    taxApi.getCommunity(communitySlug)
      .then(data => { if (!cancelled) setState({ kind: 'ready', data, error: '' }); })
      .catch(err => {
        if (cancelled) return;
        const notFound = err?.status === 404;
        setState({ kind: notFound ? 'not-found' : 'error', data: null, error: err?.message || '' });
      });
    return () => { cancelled = true; };
  }, [communitySlug]);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityTestimonials(communitySlug)
      .then(d => {
        if (cancelled) return;
        setTestimonials(d.testimonials || []);
        setTestimonialsLimit(d.displayLimit || null);
      })
      .catch(() => !cancelled && setTestimonials([]));
    return () => { cancelled = true; };
  }, [communitySlug]);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityNews(communitySlug)
      .then(d => {
        if (cancelled) return;
        setNews(d.articles || []);
        setNewsLimit(d.displayLimit || null);
      })
      .catch(() => !cancelled && setNews([]));
    return () => { cancelled = true; };
  }, [communitySlug]);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityArticles(communitySlug)
      .then(d => { if (!cancelled) setHasArticles((d.articles || []).length > 0); })
      .catch(() => { if (!cancelled) setHasArticles(false); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityDeadlines(communitySlug)
      .then(d => { if (!cancelled) setHasDeadlines((d.deadlines || []).length > 0); })
      .catch(() => { if (!cancelled) setHasDeadlines(false); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  // Honor the community's default_locale on first load when the visitor has no
  // saved preference. Subsequent visits with a saved locale skip this.
  // Also honour an explicit ?lang= query param (used in outbound email/WhatsApp
  // links so recipients land in the right language regardless of their browser).
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const urlLang = new URLSearchParams(window.location.search).get('lang');
    if (urlLang === 'en' || urlLang === 'es') {
      if (urlLang !== locale) setLocale(urlLang);
      return;
    }
    const dl = state.data?.community?.default_locale;
    if ((dl === 'en' || dl === 'es') && !hasSavedLocale() && dl !== locale) {
      setLocale(dl);
    }
  }, [state, locale, setLocale]);

  // Document title + meta description + OG tags. Re-runs when locale or
  // community changes so language switches update the head.
  useEffect(() => {
    if (state.kind !== 'ready' || typeof document === 'undefined') return;
    const c = state.data.community;
    const tagline = (locale === 'es'
      ? (c.tagline || c.tagline_en)
      : (c.tagline_en || c.tagline)) || '';
    const title = tagline ? `${c.name} — ${tagline}` : c.name;
    document.title = title;
    setMeta('description', t('meta.description'));
    setMeta('og:title', title, 'property');
    setMeta('og:description', t('meta.description'), 'property');
    setMeta('og:type', 'website', 'property');
    setMeta('og:locale', locale === 'es' ? 'es_US' : 'en_US', 'property');
    if (c.logo_url) setMeta('og:image', new URL(c.logo_url, window.location.origin).toString(), 'property');
    setMeta('twitter:card', 'summary');
  }, [state, locale, t]);

  if (state.kind === 'loading') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">{t('loading')}</div></div>;
  }
  if (state.kind === 'not-found') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">{t('error.notFound')}</div></div>;
  }
  if (state.kind === 'error') {
    return <div className="tax-fullscreen"><div className="tax-fullscreen__inner">{t('error.loadFailed')}</div></div>;
  }

  const { community, products } = state.data;
  const brandStyle = {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  };

  // Which sections will end up rendering, so the Header can hide nav
  // links whose anchor would scroll to nothing. Team/FAQs always
  // attempt to render — they self-hide when empty. Calendly is folded
  // into the Contact section now (two-path layout), so there's no
  // separate Schedule anchor to expose.
  const sections = {
    services: (products || []).length > 0,
    team: true,
    reviews: Array.isArray(testimonials) && testimonials.length > 0,
    news: Array.isArray(news) && news.length > 0,
    articles: hasArticles === true,
    calendar: hasDeadlines === true,
    faqs: true,
    about: true,
    contact: true,
  };

  return (
    <LandingCopyProvider community={community}>
      <div className="tax-app" style={brandStyle}>
        <Header community={community} sections={sections} communitySlug={communitySlug} />
        <Hero community={community} />
        <ServicesGrid products={products} community={community} onRequestService={onRequestService} />
        <TeamSection communitySlug={communitySlug} />
        <TestimonialsSection communitySlug={communitySlug}
                             rows={testimonials}
                             displayLimit={testimonialsLimit} />
        <NewsSection communitySlug={communitySlug}
                     articles={news} displayLimit={newsLimit} />
        <ArticlesSection communitySlug={communitySlug} />
        <FaqsSection communitySlug={communitySlug} />
        <About />
        <Contact community={community} products={products}
                 initialProductSlug={pendingService} />
        <Footer community={community} />

        {/* Floating AI chat button */}
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1200, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {!chatOpen && (
            <span style={{
              background: 'var(--tax-brand-primary, #1d3a6d)', color: '#fff',
              fontSize: 12, fontWeight: 700, padding: '5px 12px',
              borderRadius: 20, whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
              animation: 'tax-pulse-label 2s ease-in-out infinite',
            }}>
              {locale === 'es' ? '🤖 Pregunta al asistente de IA' : '🤖 Ask our AI assistant'}
            </span>
          )}
          <button type="button"
            onClick={() => setChatOpen(o => !o)}
            aria-label={locale === 'es' ? 'Abrir asistente virtual' : 'Open AI assistant'}
            style={{
              width: 56, height: 56, borderRadius: '50%',
              background: 'var(--tax-brand-primary, #1d3a6d)',
              color: '#fff', border: 'none', cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
              fontSize: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            {chatOpen ? '×' : '💬'}
          </button>
        </div>

        {chatOpen && (
          <div style={{
            position: 'fixed', bottom: 90, right: 24, zIndex: 1200,
            width: 360, maxWidth: 'calc(100vw - 32px)',
            height: 520, maxHeight: 'calc(100vh - 110px)',
            background: '#fff', border: '1px solid var(--tax-border)',
            borderRadius: 14, boxShadow: '0 8px 32px rgba(0,0,0,0.16)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px', background: 'var(--tax-brand-primary, #1d3a6d)',
              color: '#fff', fontWeight: 600, fontSize: 14, display: 'flex',
              justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>{locale === 'es' ? 'Asistente virtual' : 'AI Assistant'}</span>
              <button type="button" onClick={() => setChatOpen(false)}
                style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>
                ×
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: 12 }}>
              <LeadChatWidget community={community} products={products} />
            </div>
          </div>
        )}
      </div>
    </LandingCopyProvider>
  );
}
