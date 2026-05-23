import { useT } from '../i18n';

export default function Footer({ community }) {
  const { t } = useT();
  const year = new Date().getFullYear();
  const slug = community?.id || '';
  return (
    <footer className="tax-footer">
      <div className="tax-container tax-footer__row">
        <div>{t('footer.copyright', { year, name: community?.name || '' })}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
          {slug && (
            <a href={`/tax/${slug}/calendar`}
               style={{ color: 'inherit', textDecoration: 'underline' }}>
              {t('nav.calendar')}
            </a>
          )}
          <span>{t('footer.poweredBy')}</span>
        </div>
      </div>
    </footer>
  );
}
