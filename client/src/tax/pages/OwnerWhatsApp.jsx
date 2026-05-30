'use strict';

import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

const CATEGORY_EMOJI = {
  tax_prep: '📋',
  recurring: '📚',
  one_off:   '🏢',
};

function buildMessage(locale, settings, products, publicUrl) {
  const name = locale === 'es'
    ? (settings.name    || settings.name_en || '')
    : (settings.name_en || settings.name    || '');

  const enabled = products
    .filter(p => p.enabled)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const serviceLines = enabled.map(p => {
    const pname = pickI18n(p.name_i18n,        locale).value || p.slug;
    const pdesc = pickI18n(p.description_i18n, locale).value || '';
    const emoji  = CATEGORY_EMOJI[p.category] || '•';
    const link   = `${publicUrl}#service-${p.slug}`;
    return [
      `${emoji} *${pname}*`,
      pdesc && pdesc,
      `🔗 ${link}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const contactLines = [
    settings.phone         ? (locale === 'es' ? `📞 Teléfono: ${settings.phone}` : `📞 Phone: ${settings.phone}`) : '',
    settings.whatsapp      ? `💬 WhatsApp: ${settings.whatsapp}` : '',
    settings.contact_email ? `📧 Email: ${settings.contact_email}` : '',
    `🌐 ${publicUrl}`,
  ].filter(Boolean).join('\n');

  if (locale === 'es') {
    return `Cordial saludo,

Es un placer para nosotros poder servirle.

*${name}* es una firma bilingüe especializada en servicios tributarios y contables para personas naturales y empresas en los Estados Unidos. Nuestro compromiso es brindarle atención precisa, puntual y personalizada.

Nuestros servicios:

${serviceLines}

${contactLines}

Quedamos atentos a sus preguntas. ¡Con gusto le orientamos sin ningún compromiso!

Cordialmente,
*${name}*`;
  }

  return `Hi, greetings from *${name}*!

We are a bilingual tax and accounting firm helping individuals and businesses across the United States stay compliant, organized, and ahead of deadlines.

Our services:

${serviceLines}

${contactLines}

We are happy to answer any questions with no obligation. Looking forward to hearing from you!

Warm regards,
*${name}*`;
}

export default function OwnerWhatsApp() {
  const { fbUser, community } = useEmployeeAuth();
  const { locale, t } = useT();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [settings,    setSettings]    = useState(null);
  const [products,    setProducts]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [msgLocale,   setMsgLocale]   = useState('es');
  const [copied,      setCopied]      = useState(false);

  useEffect(() => {
    if (!fbUser || !community) return;
    Promise.all([
      taxApi.adminGetCommunitySettings(auth, community.id),
      taxApi.adminListProducts(auth, community.id),
    ])
      .then(([sd, pd]) => {
        setSettings(sd.settings);
        setProducts(pd.products || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const publicUrl = `${window.location.origin}/tax/${community?.id}`;

  const message = (!loading && settings && products.some(p => p.enabled))
    ? buildMessage(msgLocale, settings, products, publicUrl)
    : '';

  const copy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (_) {}
  };

  return (
    <EmployeeShell community={community} active="whatsapp">
      <div className="tax-page-header">
        <h1>{t('owner.whatsapp.title')}</h1>
        <p className="tax-page-sub">{t('owner.whatsapp.subtitle')}</p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.whatsapp.loading')}</p>
      ) : (
        <div style={{ maxWidth: 680 }}>

          {/* Language selector */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {['es', 'en'].map(lang => (
              <button key={lang} type="button"
                      className={`tax-btn ${msgLocale === lang ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                      onClick={() => { setMsgLocale(lang); setCopied(false); }}>
                {lang === 'es' ? 'Español' : 'English'}
              </button>
            ))}
          </div>

          {/* Message preview + copy */}
          {message ? (
            <div style={{ position: 'relative' }}>
              <pre style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--tax-bg-alt)', border: '1px solid var(--tax-border)',
                borderRadius: 8, padding: '16px 16px 16px 16px',
                paddingTop: 48,
                fontSize: 14, lineHeight: 1.7,
                fontFamily: 'inherit', margin: 0,
              }}>
                {message}
              </pre>
              <button type="button"
                      className={`tax-btn ${copied ? 'tax-btn--ghost' : 'tax-btn--primary'} tax-btn--sm`}
                      onClick={copy}
                      style={{ position: 'absolute', top: 10, right: 10 }}>
                {copied ? `✓ ${t('owner.whatsapp.copied')}` : t('owner.whatsapp.copy')}
              </button>
            </div>
          ) : (
            <p style={{ color: 'var(--tax-muted)' }}>{t('owner.whatsapp.noServices')}</p>
          )}

          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.whatsapp.hint.prefix')}{' '}
            <a href={`/tax/${community?.id}/employee/settings`}>{t('owner.whatsapp.hint.settings')}</a>
            {' '}{t('owner.whatsapp.hint.and')}{' '}
            <a href={`/tax/${community?.id}/employee/service-catalog`}>{t('owner.whatsapp.hint.catalog')}</a>
            {' '}{t('owner.whatsapp.hint.suffix')}
          </p>
        </div>
      )}
    </EmployeeShell>
  );
}
