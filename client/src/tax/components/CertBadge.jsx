import { useRef, useState } from 'react';
import { CERT_NOTES } from '../lib/certLibrary';

// Credential badge with hover tooltip showing the credential definition.
// For custom certs not in the library a generic fallback is shown.
export default function CertBadge({ label, style }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const note = CERT_NOTES[label] || 'Practice-held credential.';

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block' }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}>
      <span
        role="button"
        tabIndex={0}
        style={{
          display: 'inline-block',
          fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
          background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b',
          cursor: 'default', whiteSpace: 'nowrap',
          ...style,
        }}>
        🏅 {label}
      </span>

      {open && (
        <div role="tooltip" style={{
          position: 'absolute', zIndex: 2000,
          bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
          minWidth: 220, maxWidth: 300,
          background: '#1c2a3a', color: '#fff',
          borderRadius: 8, padding: '10px 14px',
          fontSize: 12, lineHeight: 1.55,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
          <div style={{ color: '#d1e0f0' }}>{note}</div>
          <div style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 0, height: 0,
            borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
            borderTop: '6px solid #1c2a3a',
          }} />
        </div>
      )}
    </span>
  );
}
