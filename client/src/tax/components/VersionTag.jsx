import { useEffect, useState } from 'react';

// Tiny build identifier so support can tell which deploy someone is
// looking at, across all three surfaces (public site footer, customer
// portal, employee portal). Source: GET /api/version — a platform-
// level endpoint (no auth, no /api/m/tax prefix), so this fetches
// directly rather than through taxApi. buildTime comes from the
// client's own vite build; commit from Render's auto-injected
// RENDER_GIT_COMMIT. Either can be blank (local dev has no commit env
// var; a very first boot before any build has no build-meta.json
// yet) — renders nothing rather than a broken partial string.
export default function VersionTag({ style }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/version')
      .then(r => r.json())
      .then(d => { if (!cancelled) setInfo(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const buildDate = info?.buildTime ? info.buildTime.slice(0, 10) : '';
  const commit = info?.commit || '';
  if (!buildDate && !commit) return null;
  const label = ['v' + (buildDate || '?'), commit].filter(Boolean).join(' · ');

  return (
    <span style={{ fontSize: 11, color: 'var(--tax-muted)', opacity: 0.7, ...style }}>
      {label}
    </span>
  );
}
