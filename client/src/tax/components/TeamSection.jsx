import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';
import { displayPersonName } from '../lib/personName';

// Meet-the-team section on the public landing page. Renders only the
// employees the owner has opted into the homepage (show_on_homepage =
// true). Hidden entirely when no member has been published — keeps
// the landing tidy on fresh communities.
export default function TeamSection({ communitySlug }) {
  const { locale, t } = useT();
  const [members, setMembers] = useState(null);

  useEffect(() => {
    let cancelled = false;
    taxApi.getCommunityTeam(communitySlug)
      .then(d => { if (!cancelled) setMembers(d.members || []); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [communitySlug]);

  if (members === null) return null;
  if (!members.length) return null;

  return (
    <section className="tax-section" id="team">
      <div className="tax-container">
        <h2>{t('landing.team.heading')}</h2>
        <p className="tax-section__lede">{t('landing.team.subheading')}</p>

        <div style={{
          display: 'grid', gap: 18, marginTop: 18,
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        }}>
          {members.map(m => {
            const name = displayPersonName(m) || m.name || '';
            const title = pickI18n(m.title_i18n, locale).value;
            const bio = pickI18n(m.bio_i18n, locale).value;
            const role = pickI18n(m.role_i18n, locale).value;
            const highlights = pickI18n(m.highlights_i18n, locale).value;
            const education = pickI18n(m.education_i18n, locale).value;
            const experience = pickI18n(m.experience_i18n, locale).value;
            const highlightLines = (highlights || '')
              .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            return (
              <article key={m.id} style={{
                display: 'grid', gap: 12, padding: 18,
                border: '1px solid var(--tax-border)', borderRadius: 12,
                background: 'var(--tax-bg)',
              }}>
                <Avatar photoUrl={m.photo_url} name={name} />
                <div>
                  <div style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 17 }}>{name}</div>
                    {role && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 999, fontSize: 11,
                        fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
                        background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                        color: 'var(--tax-brand-primary)',
                        border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 30%, #fff)',
                      }}>{role}</span>
                    )}
                  </div>
                  {title && (
                    <div style={{ marginTop: 2, fontSize: 13, color: 'var(--tax-muted)' }}>
                      {title}
                    </div>
                  )}
                </div>
                {bio && (
                  <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                    {bio}
                  </div>
                )}
                {highlightLines.length > 0 && (
                  <ul style={{
                    margin: 0, padding: 0, listStyle: 'none',
                    display: 'grid', gap: 4,
                  }}>
                    {highlightLines.map((line, i) => (
                      <li key={i} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8,
                        fontSize: 13, lineHeight: 1.5,
                      }}>
                        <span aria-hidden="true" style={{
                          marginTop: 6, width: 6, height: 6, borderRadius: '50%',
                          background: 'var(--tax-brand-primary)', flexShrink: 0,
                        }} />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {experience && (
                  <TeamFactBlock label={t('landing.team.experience')} body={experience} />
                )}
                {education && (
                  <TeamFactBlock label={t('landing.team.education')} body={education} />
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TeamFactBlock({ label, body }) {
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
        textTransform: 'uppercase', color: 'var(--tax-muted)', marginBottom: 4,
      }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {body}
      </div>
    </div>
  );
}

// Photo or initials fallback. Empty photo_url → a colored circle
// with the member's initials so the layout doesn't collapse for
// employees who haven't uploaded a headshot yet.
function Avatar({ photoUrl, name }) {
  const size = 88;
  const common = {
    width: size, height: size, borderRadius: '50%',
    display: 'block', objectFit: 'cover',
  };
  if (photoUrl) {
    return <img src={photoUrl} alt={name || ''} style={common}
                onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  }
  const initials = (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w.charAt(0)).join('').toUpperCase() || '?';
  return (
    <div style={{
      ...common,
      background: 'color-mix(in srgb, var(--tax-brand-primary) 18%, #fff)',
      color: 'var(--tax-brand-primary)',
      fontWeight: 700, fontSize: 28, lineHeight: `${size}px`,
      textAlign: 'center',
    }}>
      {initials}
    </div>
  );
}
