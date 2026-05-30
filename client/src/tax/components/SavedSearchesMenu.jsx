import { useEffect, useRef, useState } from 'react';
import { taxApi } from '../api';

// Reusable saved-searches dropdown for Tasks / Customers / Leads.
// Each host page hands over:
//   • scope: 'tasks' | 'customers' | 'leads' (server-side allowlist)
//   • getCurrentParams(): captures the host page's current filter state
//   • applyParams(params): receives a stored params blob and applies it
//   • builtIns: pre-canned starter views shipped with the client. Each
//     entry is { key, name, params }; built-ins aren't editable or
//     deletable but apply via the same applyParams path.
//   • activeKey (optional): the key/id of whichever view is "current"
//     so the menu can highlight it. Pass '' when none.
//
// Persistence is per-employee + per-scope. Custom saves can be deleted
// or pinned for quick access; for v1 we only render an inline list +
// "save current view" prompt — pinning surfaces in a follow-up.
export default function SavedSearchesMenu({
  auth, scope, builtIns = [], getCurrentParams, applyParams,
  activeKey = '', t,
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState([]);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);

  const load = () => {
    taxApi.adminListSavedSearches(auth, scope)
      .then(d => setSaved(d.searches || []))
      .catch(() => setSaved([]));
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside-click + Escape so the dropdown doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onSave = async () => {
    const params = getCurrentParams ? getCurrentParams() : {};
    const name = window.prompt(t('saved.namePrompt'));
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      await taxApi.adminCreateSavedSearch(auth, { scope, name: name.trim(), params });
      load();
    } catch (e) {
      alert(e?.message || '');
    } finally { setBusy(false); }
  };

  const onDelete = async (id) => {
    if (!window.confirm(t('saved.deleteConfirm'))) return;
    setBusy(true);
    try {
      await taxApi.adminDeleteSavedSearch(auth, id);
      setSaved(prev => prev.filter(s => s.id !== id));
    } catch (e) {
      alert(e?.message || '');
    } finally { setBusy(false); }
  };

  const itemStyle = (active) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, padding: '8px 12px',
    background: active ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : 'transparent',
    cursor: 'pointer', fontSize: 13, lineHeight: 1.3,
    borderRadius: 4, border: 0, width: '100%', textAlign: 'left',
  });

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
              className="tax-btn tax-btn--ghost tax-btn--sm"
              style={{ color: 'var(--tax-text)' }}>
        ☆ {t('saved.menuLabel')} {saved.length ? `· ${saved.length}` : ''} ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0,
          minWidth: 280, maxWidth: 360, padding: 6, zIndex: 50,
          background: '#fff', border: '1px solid var(--tax-border)',
          borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.08)',
        }}>
          {builtIns.length > 0 && (
            <>
              <SectionLabel>{t('saved.builtIns')}</SectionLabel>
              {builtIns.map(b => (
                <button key={b.key} type="button"
                        style={itemStyle(activeKey === b.key)}
                        onClick={() => { applyParams(b.params); setOpen(false); }}>
                  <span>{b.name}</span>
                </button>
              ))}
            </>
          )}
          {saved.length > 0 && (
            <>
              <SectionLabel>{t('saved.yours')}</SectionLabel>
              {saved.map(s => (
                <div key={s.id} style={{ display: 'flex', gap: 4 }}>
                  <button type="button"
                          style={{ ...itemStyle(activeKey === s.id), flex: 1 }}
                          onClick={() => { applyParams(s.params || {}); setOpen(false); }}>
                    <span>{s.name}</span>
                  </button>
                  <button type="button" onClick={() => onDelete(s.id)}
                          aria-label={t('saved.delete')}
                          style={{
                            border: 0, background: 'transparent',
                            color: 'var(--tax-error)', cursor: 'pointer',
                            padding: '4px 8px', fontSize: 14,
                          }}>×</button>
                </div>
              ))}
            </>
          )}
          {saved.length === 0 && builtIns.length === 0 && (
            <p style={{ margin: 0, padding: '12px', color: 'var(--tax-muted)', fontSize: 13 }}>
              {t('saved.empty')}
            </p>
          )}
          <div style={{ borderTop: '1px solid var(--tax-border)', marginTop: 6, paddingTop: 6 }}>
            <button type="button" onClick={onSave} disabled={busy}
                    style={{ ...itemStyle(false), color: 'var(--tax-brand-primary)', fontWeight: 600 }}>
              + {t('saved.saveCurrent')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: '6px 12px 2px', fontSize: 10, fontWeight: 700,
      color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.06em',
    }}>{children}</div>
  );
}
