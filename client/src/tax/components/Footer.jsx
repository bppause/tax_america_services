import { useT } from '../i18n';
import VersionTag from './VersionTag';

export default function Footer({ community }) {
  const { t } = useT();
  const year = new Date().getFullYear();
  return (
    <footer className="tax-footer">
      <div className="tax-container tax-footer__row">
        <div>{t('footer.copyright', { year, name: community?.name || '' })}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {t('footer.poweredBy')}
          <VersionTag />
        </div>
      </div>
      {community?.tax_ai_features_enabled && (
        <div className="tax-container tax-footer__legal">
          <strong>{t('footer.aiNotice.heading')}</strong>
          <p>{t('footer.aiNotice.body')}</p>
        </div>
      )}
    </footer>
  );
}
