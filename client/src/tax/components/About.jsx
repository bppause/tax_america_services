import { useT } from '../i18n';
import { useLandingCopy } from '../lib/landingCopy';

export default function About() {
  const { t } = useT();
  const { pick } = useLandingCopy();
  return (
    <section className="tax-section" id="about">
      <div className="tax-container">
        <h2>{pick('about.heading')}</h2>
        <p className="tax-section__lede" style={{ maxWidth: 720 }}>{pick('about.body')}</p>
        <ul className="tax-about-list">
          <li>{t('about.point1')}</li>
          <li>{t('about.point2')}</li>
          <li>{t('about.point3')}</li>
        </ul>
      </div>
    </section>
  );
}
