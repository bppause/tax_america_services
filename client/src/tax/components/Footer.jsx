import { useT } from '../i18n';

export default function Footer({ community }) {
  const { t } = useT();
  const year = new Date().getFullYear();
  return (
    <footer className="tax-footer">
      <div className="tax-container tax-footer__row">
        <div>{t('footer.copyright', { year, name: community?.name || '' })}</div>
        <div>{t('footer.poweredBy')}</div>
      </div>
      <div className="tax-container tax-footer__legal">
        <strong>{t('footer.aiNotice.heading')}</strong>
        <p>{t('footer.aiNotice.body')}</p>
      </div>
    </footer>
  );
}
