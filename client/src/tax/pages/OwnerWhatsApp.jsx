'use strict';

import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// ── Default template copy ──────────────────────────────────────────────────
const DEFAULTS = {
  es: {
    opening:
      'Cordial saludo,\n\n' +
      'Es un placer para nosotros poder servirle.\n\n' +
      '*{name}* es una firma bilingüe especializada en servicios tributarios y contables ' +
      'para personas naturales y empresas en los Estados Unidos. Nuestro compromiso es ' +
      'brindarle atención precisa, puntual y personalizada.',
    closing:  'Quedamos atentos a sus preguntas. ¡Con gusto le orientamos sin ningún compromiso!',
    signoff:  'Cordialmente,\n*{name}*',
  },
  en: {
    opening:
      'Hi, greetings from *{name}*!\n\n' +
      'We are a bilingual tax and accounting firm helping individuals and businesses across ' +
      'the United States stay compliant, organized, and ahead of deadlines.',
    closing:  'We are happy to answer any questions with no obligation. Looking forward to hearing from you!',
    signoff:  'Warm regards,\n*{name}*',
  },
};

const CATEGORY_EMOJI = { tax_prep: '📋', recurring: '📚', one_off: '🏢' };

function brochureUrl(origin, communityId, lang) {
  return `${origin}/api/m/tax/community/${encodeURIComponent(communityId)}/brochure.pdf?lang=${lang}`;
}

function interpolate(text, name) {
  return (text || '').replace(/\{name\}/g, name);
}

function buildServicesBlock(locale, products) {
  const enabled = products
    .filter(p => p.enabled)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  return enabled.map(p => {
    const pname = pickI18n(p.name_i18n, locale).value || p.slug;
    const pdesc = pickI18n(p.description_i18n, locale).value || '';
    const emoji = CATEGORY_EMOJI[p.category] || '•';
    return [`${emoji} *${pname}*`, pdesc, `🔗 {SITE}#service-${p.slug}`]
      .filter(Boolean).join('\n');
  }).join('\n\n');
}

function buildContactBlock(locale, settings) {
  const waDigits = (settings.whatsapp || '').replace(/\D/g, '');
  const waUrl    = waDigits ? `https://wa.me/${waDigits}` : null;
  return [
    settings.phone         ? (locale === 'es' ? `📞 Teléfono: ${settings.phone}` : `📞 Phone: ${settings.phone}`) : '',
    waUrl                  ? `💬 WhatsApp: ${waUrl}` : '',
    settings.contact_email ? `📧 Email: ${settings.contact_email}` : '',
    `🌐 {SITE}`,
  ].filter(Boolean).join('\n');
}

function buildMessage(locale, settings, products, publicUrl, pdfUrl, template) {
  const name = locale === 'es'
    ? (settings.name || settings.name_en || '')
    : (settings.name_en || settings.name || '');
  const tpl = (field) => interpolate(template[locale]?.[field] ?? DEFAULTS[locale][field], name);
  const svcLabel   = locale === 'es' ? 'Nuestros servicios:' : 'Our services:';
  const svcBlock   = buildServicesBlock(locale, products).replace(/\{SITE\}/g, publicUrl);
  const ctaBlock   = buildContactBlock(locale, settings).replace(/\{SITE\}/g, publicUrl);
  const brochLine  = locale === 'es'
    ? `📄 Portafolio de servicios: ${pdfUrl}`
    : `📄 Services portfolio: ${pdfUrl}`;
  return [tpl('opening'), '', svcLabel, '', svcBlock, '', ctaBlock, '', brochLine, '', tpl('closing'), '', tpl('signoff')].join('\n');
}

// ── TemplateBlock — one section of the editor ─────────────────────────────
function TemplateBlock({ label, editable, value, onChange, hint, hintHref, hintText, children, rows = 4 }) {
  const textareaRef = useRef(null);
  useEffect(() => {
    if (editable && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value, editable]);

  return (
    <div style={{ borderLeft: `3px solid ${editable ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`, paddingLeft: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: editable ? 'var(--tax-brand-primary)' : 'var(--tax-muted)' }}>
          {label}
        </span>
        {hintHref && (
          <a href={hintHref} style={{ fontSize: 11, color: 'var(--tax-brand-primary)', whiteSpace: 'nowrap' }}>
            {hintText} →
          </a>
        )}
      </div>
      {editable ? (
        <>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            rows={rows}
            style={{
              width: '100%', resize: 'none', overflow: 'hidden',
              padding: '8px 10px', borderRadius: 6,
              border: '1px solid var(--tax-border)', boxSizing: 'border-box',
              fontSize: 13, lineHeight: 1.6, fontFamily: 'inherit',
              background: '#fff',
            }}
          />
          {hint && <p style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 3 }}>{hint}</p>}
        </>
      ) : (
        <div style={{
          background: 'var(--tax-bg-alt)', borderRadius: 6,
          padding: '8px 10px', fontSize: 12.5, lineHeight: 1.6,
          color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function OwnerWhatsApp() {
  const { fbUser, community } = useEmployeeAuth();
  const { t } = useT();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [settings,    setSettings]    = useState(null);
  const [products,    setProducts]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [template,    setTemplate]    = useState({ es: {}, en: {} });
  const [msgLocale,   setMsgLocale]   = useState('es');
  const [dirty,       setDirty]       = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [saveOk,      setSaveOk]      = useState(false);
  const [copied,      setCopied]      = useState(false);
  const [pdfVersion,  setPdfVersion]  = useState(() => Date.now());

  useEffect(() => {
    if (!fbUser || !community) return;
    Promise.all([
      taxApi.adminGetCommunitySettings(auth, community.id),
      taxApi.adminListProducts(auth, community.id),
      taxApi.adminGetWhatsappTemplate(auth, community.id),
    ])
      .then(([sd, pd, td]) => {
        setSettings(sd.settings);
        setProducts(pd.products || []);
        setTemplate(td.template || { es: {}, en: {} });
        setPdfVersion(Date.now()); // fresh PDF when settings load
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const publicUrl    = settings?.website_url || `${window.location.origin}/tax/${community?.id}`;
  // pdfUrl goes into the WhatsApp message (clean, cacheable link for recipients).
  // pdfPreviewUrl busts the cache so the iframe always shows the current brochure.
  const pdfUrl        = community ? brochureUrl(window.location.origin, community.id, msgLocale) : '';
  const pdfPreviewUrl = pdfUrl ? `${pdfUrl}&_v=${pdfVersion}` : '';

  const getField = (field) => template[msgLocale]?.[field] ?? DEFAULTS[msgLocale][field];
  const setField = (field, value) => {
    setTemplate(prev => ({ ...prev, [msgLocale]: { ...prev[msgLocale], [field]: value } }));
    setDirty(true);
    setSaveOk(false);
  };

  const name = settings
    ? (msgLocale === 'es' ? (settings.name || settings.name_en || '') : (settings.name_en || settings.name || ''))
    : '';

  const hasServices = products.some(p => p.enabled);
  const svcPreview  = settings ? buildServicesBlock(msgLocale, products).replace(/\{SITE\}/g, publicUrl) : '';
  const ctaPreview  = settings ? buildContactBlock(msgLocale, settings).replace(/\{SITE\}/g, publicUrl) : '';
  const brochLine   = msgLocale === 'es' ? `📄 Portafolio de servicios: ${pdfUrl}` : `📄 Services portfolio: ${pdfUrl}`;

  const message = settings && hasServices
    ? buildMessage(msgLocale, settings, products, publicUrl, pdfUrl, template)
    : '';

  const save = async () => {
    setSaving(true);
    try {
      await taxApi.adminSaveWhatsappTemplate(auth, { communitySlug: community.id, template });
      setDirty(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (_) {}
    finally { setSaving(false); }
  };

  const copy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (_) {}
  };

  const base = community ? `/tax/${community.id}/employee` : '#';

  return (
    <EmployeeShell community={community} active="whatsapp">
      <div className="tax-page-header">
        <h1>{t('owner.whatsapp.title')}</h1>
        <p className="tax-page-sub">{t('owner.whatsapp.subtitle')}</p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.whatsapp.loading')}</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start', maxWidth: 1100 }}>

          {/* ── Left: template editor ── */}
          <div>
            {/* Locale tabs */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {['es', 'en'].map(lang => (
                <button key={lang} type="button"
                        className={`tax-btn ${msgLocale === lang ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                        onClick={() => { setMsgLocale(lang); setCopied(false); }}>
                  {lang === 'es' ? 'Español' : 'English'}
                </button>
              ))}
            </div>

            {/* Editable sections */}
            <TemplateBlock
              label={t('owner.whatsapp.block.opening')}
              editable
              value={getField('opening')}
              onChange={v => setField('opening', v)}
              hint={t('owner.whatsapp.block.namehint')}
              rows={6}
            />

            {/* Services — locked, from service catalog */}
            <TemplateBlock
              label={t('owner.whatsapp.block.services')}
              hintHref={`${base}/service-catalog`}
              hintText={t('owner.whatsapp.block.services.edit')}>
              {hasServices ? svcPreview : <span style={{ color: 'var(--tax-muted)', fontStyle: 'italic' }}>{t('owner.whatsapp.noServices')}</span>}
            </TemplateBlock>

            {/* Contact — locked, from settings */}
            <TemplateBlock
              label={t('owner.whatsapp.block.contact')}
              hintHref={`${base}/settings`}
              hintText={t('owner.whatsapp.block.contact.edit')}>
              {ctaPreview || <span style={{ color: 'var(--tax-muted)', fontStyle: 'italic' }}>{t('owner.whatsapp.block.contact.empty')}</span>}
            </TemplateBlock>

            {/* Brochure link — auto */}
            <TemplateBlock label={t('owner.whatsapp.block.brochure')}>
              {brochLine}
            </TemplateBlock>

            <TemplateBlock
              label={t('owner.whatsapp.block.closing')}
              editable
              value={getField('closing')}
              onChange={v => setField('closing', v)}
              rows={2}
            />

            <TemplateBlock
              label={t('owner.whatsapp.block.signoff')}
              editable
              value={getField('signoff')}
              onChange={v => setField('signoff', v)}
              hint={t('owner.whatsapp.block.namehint')}
              rows={2}
            />

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
              {dirty && (
                <button type="button" className="tax-btn tax-btn--primary"
                        onClick={save} disabled={saving}>
                  {saving ? t('owner.whatsapp.saving') : t('owner.whatsapp.save')}
                </button>
              )}
              {saveOk && !dirty && (
                <span style={{ fontSize: 13, color: 'var(--tax-success, #16a34a)', fontWeight: 600 }}>
                  ✓ {t('owner.whatsapp.saved')}
                </span>
              )}
              <button type="button"
                      className={`tax-btn ${copied ? 'tax-btn--ghost' : 'tax-btn--primary'}`}
                      onClick={copy} disabled={!message}>
                {copied ? `✓ ${t('owner.whatsapp.copied')}` : t('owner.whatsapp.copy')}
              </button>
            </div>

            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--tax-muted)', lineHeight: 1.5 }}>
              {t('owner.whatsapp.hint.services')}{' '}
              <a href={`${base}/service-catalog`}>{t('owner.whatsapp.hint.catalog')}</a>.{' '}
              {t('owner.whatsapp.hint.contact')}{' '}
              <a href={`${base}/settings`}>{t('owner.whatsapp.hint.settings')}</a>.
            </p>
          </div>

          {/* ── Right: PDF preview ── */}
          {hasServices && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--tax-muted)' }}>
                  {t('owner.whatsapp.section.brochure')}
                </span>
                <a href={pdfUrl} target="_blank" rel="noreferrer"
                   style={{ fontSize: 12, color: 'var(--tax-brand-primary)' }}>
                  {t('owner.whatsapp.brochure.newTab')} ↗
                </a>
              </div>
              <iframe key={pdfPreviewUrl} src={pdfPreviewUrl}
                      title={t('owner.whatsapp.section.brochure')}
                      style={{ width: '100%', height: 700, border: '1px solid var(--tax-border)', borderRadius: 8 }} />
            </div>
          )}
        </div>
      )}
    </EmployeeShell>
  );
}
