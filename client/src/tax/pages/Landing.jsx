import { useEffect, useState } from 'react';
import { hasSavedLocale, useT } from '../i18n';
import { taxApi } from '../api';
import Header from '../components/Header';
import Hero from '../components/Hero';
import ServicesGrid from '../components/ServicesGrid';
import TeamSection from '../components/TeamSection';
import FaqsSection from '../components/FaqsSection';
import ArticlesSection from '../components/ArticlesSection';
import About from '../components/About';
import Contact from '../components/Contact';
import Footer from '../components/Footer';

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

  // Honor the community's default_locale on first load when the visitor has no
  // saved preference. Subsequent visits with a saved locale skip this.
  useEffect(() => {
    if (state.kind !== 'ready') return;
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
    faqs: true,
    about: true,
    contact: true,
  };

  return (
    <div className="tax-app" style={brandStyle}>
      <Header community={community} sections={sections} />
      <Hero community={community} />
      <ServicesGrid products={products} onRequestService={onRequestService} />
      <TeamSection communitySlug={communitySlug} />
      <ArticlesSection communitySlug={communitySlug} />
      <FaqsSection communitySlug={communitySlug} />
      <About />
      <Contact community={community} products={products}
               initialProductSlug={pendingService} />
      <Footer community={community} />
    </div>
  );
}
