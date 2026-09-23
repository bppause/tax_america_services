import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Owner-managed testimonials feed ("What our clients say" on the public
// landing page). Three areas in one page:
//   1. Google Reviews sync: Place ID + auto-sync toggle + manual "Sync now".
//   2. Display limit: how many cards the public section shows.
//   3. Reviews list with inline add/edit/delete for hand-curated entries.
//
// Google-sourced rows (source='google') are flagged so the owner can tell
// which entries the daily cron will overwrite vs. their own manual ones.
export default function OwnerTestimonials() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [settings, setSettings] = useState(null);
  const [google, setGoogle] = useState(null);
  const [items, setItems] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const loadSettings = () => {
    if (!community?.id) return;
    taxApi.adminGetCommunitySettings(auth, community.id)
      .then(d => setSettings(d.settings))
      .catch(e => setMsg({ kind: 'error', text: e?.message || '' }));
  };
  const loadGoogle = () => {
    if (!community?.id) return;
    taxApi.adminGetGoogleReviewsState(auth, community.id)
      .then(setGoogle)
      .catch(e => setMsg({ kind: 'error', text: e?.message || '' }));
  };
  const loadItems = () => {
    if (!community?.id) return;
    taxApi.adminListTestimonials(auth, community.id)
      .then(d => setItems(d.testimonials || []))
      .catch(e => setMsg({ kind: 'error', text: e?.message || '' }));
  };
  useEffect(() => { loadSettings(); loadGoogle(); loadItems(); }, [community?.id]); // eslint-disable-line

  const onDelete = async (id) => {
    if (!window.confirm(t('owner.testimonials.deleteConfirm'))) return;
    try { await taxApi.adminDeleteTestimonial(auth, id); loadItems(); }
    catch (e) { setMsg({ kind: 'error', text: e?.message || '' }); }
  };

  if (!community) return <EmployeeShell active="testimonials"><p>{t('loading')}</p></EmployeeShell>;

  return (
    <EmployeeShell community={community} active="testimonials">
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '16px 12px 80px' }}>
        <h1 style={{ marginTop: 0 }}>{t('owner.testimonials.title')}</h1>
        <p style={{ color: 'var(--tax-muted)', marginTop: 0 }}>
          {t('owner.testimonials.subtitle')}
        </p>

        {msg.text && (
          <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
               style={{ marginBottom: 12 }}>{msg.text}</div>
        )}

        <GooglePanel google={google} auth={auth} community={community} t={t}
                     onSaved={() => { loadGoogle(); loadItems(); }}
                     onMsg={setMsg} />

        <DisplayLimitPanel settings={settings} auth={auth} community={community} t={t}
                            onSaved={loadSettings} onMsg={setMsg} />

        <h2 style={{ marginTop: 28, fontSize: 16 }}>{t('owner.testimonials.list')}</h2>

        {items === null
          ? <p>{t('loading')}</p>
          : (
            <>
              <div style={{ display: 'grid', gap: 10 }}>
                {items.length === 0 && (
                  <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>
                    {t('owner.testimonials.empty')}
                  </p>
                )}
                {items.map(item => (
                  editingId === item.id
                    ? <TestimonialForm key={item.id}
                                       initial={item} auth={auth} community={community} t={t}
                                       onClose={() => setEditingId('')}
                                       onSaved={() => { setEditingId(''); loadItems(); }} />
                    : <TestimonialRow key={item.id} item={item} t={t}
                                      onEdit={() => setEditingId(item.id)}
                                      onDelete={() => onDelete(item.id)} />
                ))}
              </div>
              {adding
                ? <div style={{ marginTop: 10 }}>
                    <TestimonialForm initial={null} auth={auth} community={community} t={t}
                                     onClose={() => setAdding(false)}
                                     onSaved={() => { setAdding(false); loadItems(); }} />
                  </div>
                : <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          style={{ marginTop: 10 }}
                          onClick={() => setAdding(true)}>
                    + {t('owner.testimonials.add')}
                  </button>}
            </>
          )}
      </div>
    </EmployeeShell>
  );
}

function GooglePanel({ google, auth, community, t, onSaved, onMsg }) {
  const [placeId, setPlaceId] = useState('');
  const [auto, setAuto] = useState(true);
  const [busySave, setBusySave] = useState(false);
  const [busySync, setBusySync] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    if (!google) return;
    setPlaceId(google.placeId || '');
    setAuto(google.autoSyncEnabled !== false);
  }, [google]);

  if (!google) return <p>{t('loading')}</p>;

  const onSavePlaceId = async () => {
    setBusySave(true); onMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminSetGooglePlaceId(auth, { communitySlug: community.id, placeId: placeId.trim() });
      onMsg({ kind: 'success', text: r.message || t('owner.settings.saved') });
      onSaved();
    } catch (e) { onMsg({ kind: 'error', text: e?.body?.message || e?.message || '' }); }
    finally { setBusySave(false); }
  };

  const onToggleAuto = async (checked) => {
    setAuto(checked);
    try { await taxApi.adminSetGoogleAutoSync(auth, { communitySlug: community.id, enabled: checked }); onSaved(); }
    catch (e) { onMsg({ kind: 'error', text: e?.message || '' }); }
  };

  const onSyncNow = async () => {
    setBusySync(true); onMsg({ kind: 'idle', text: '' }); setSyncResult(null);
    try {
      const r = await taxApi.adminSyncGoogleReviews(auth, { communitySlug: community.id });
      setSyncResult(r);
      onSaved();
    } catch (e) {
      onMsg({ kind: 'error', text: e?.body?.message || e?.message || '' });
    } finally { setBusySync(false); }
  };

  return (
    <div style={{
      padding: 14, borderRadius: 10, background: 'var(--tax-bg-card, #fff)',
      border: '1px solid var(--tax-border)', marginBottom: 16,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('owner.testimonials.google.title')}</div>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--tax-muted)' }}>
        {t('owner.testimonials.google.subtitle')}
      </p>

      {!google.hasApiKey && (
        <div className="tax-msg tax-msg--error" style={{ marginBottom: 10, fontSize: 12 }}>
          {t('owner.testimonials.google.noApiKey')}
        </div>
      )}

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
        {t('owner.testimonials.google.placeIdLabel')}
      </label>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input type="text" value={placeId} onChange={e => setPlaceId(e.target.value)}
               placeholder={t('owner.testimonials.google.placeIdPlaceholder')}
               style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onSavePlaceId} disabled={busySave}>
          {busySave ? t('lead.submitting') : t('owner.testimonials.google.save')}
        </button>
      </div>
      <p style={{ margin: '6px 0 12px', fontSize: 11, color: 'var(--tax-muted)' }}>
        {t('owner.testimonials.google.placeIdHint')}
      </p>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={auto} onChange={e => onToggleAuto(e.target.checked)} />
          {t('owner.testimonials.google.autoSyncLabel')}
        </label>
        <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.testimonials.google.lastSynced')}: {google.lastSyncAt ? fmtDateTime(google.lastSyncAt) : t('owner.testimonials.google.never')}
        </span>
      </div>

      <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
              onClick={onSyncNow} disabled={busySync || !google.placeId}>
        {busySync ? t('owner.testimonials.google.syncing') : t('owner.testimonials.google.syncNow')}
      </button>

      {syncResult && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--tax-muted)' }}>
          {syncResult.placeName
            ? t('owner.testimonials.google.syncResultNamed', { n: syncResult.upserted, place: syncResult.placeName })
            : t('owner.testimonials.google.syncResult', { n: syncResult.upserted })}
          {syncResult.likelyNoEnterpriseSku && (
            <div style={{ marginTop: 4, color: 'var(--tax-error, #b91c1c)' }}>
              {t('owner.testimonials.google.enterpriseSkuHint')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DisplayLimitPanel({ settings, auth, community, t, onSaved, onMsg }) {
  const initial = Number(settings?.tax_testimonials_display_limit) || 9;
  const [limit, setLimit] = useState(String(initial));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLimit(String(initial)); }, [initial]);

  if (!settings) return <p>{t('loading')}</p>;

  const onSave = async () => {
    setBusy(true); onMsg({ kind: 'idle', text: '' });
    try {
      const n = Math.max(1, Math.min(30, Math.round(Number(limit) || 9)));
      await taxApi.adminSetTestimonialsDisplayLimit(auth, { communitySlug: community.id, limit: n });
      onMsg({ kind: 'success', text: t('owner.settings.saved') });
      onSaved();
    } catch (e) { onMsg({ kind: 'error', text: e?.message || '' }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      padding: 14, borderRadius: 10, background: 'var(--tax-bg-card, #fff)',
      border: '1px solid var(--tax-border)', marginBottom: 16,
      display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <label style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('owner.testimonials.displayLimitLabel')}&nbsp;
        <input type="number" min="1" max="30" value={limit}
               onChange={e => setLimit(e.target.value)}
               style={{ width: 70 }} />
      </label>
      <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" onClick={onSave} disabled={busy}>
        {busy ? t('lead.submitting') : t('owner.testimonials.displayLimitSave')}
      </button>
    </div>
  );
}

function TestimonialRow({ item, t, onEdit, onDelete }) {
  const isGoogle = item.source === 'google';
  return (
    <div style={{
      padding: 12, border: '1px solid var(--tax-border)', borderRadius: 8,
      background: 'var(--tax-bg-card, #fff)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{
          padding: '1px 6px', borderRadius: 4,
          background: isGoogle ? '#e0e7ff' : '#dcfce7',
          color: isGoogle ? '#3730a3' : '#166534',
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
        }}>{isGoogle ? t('owner.testimonials.sourceGoogle') : t('owner.testimonials.sourceManual')}</span>
        <span style={{ fontSize: 12, color: '#d97706' }}>{'★'.repeat(item.rating || 5)}</span>
        {item.active === false && (
          <span style={{
            padding: '1px 6px', borderRadius: 4, background: '#fee2e2',
            color: '#991b1b', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>{t('owner.testimonials.inactive')}</span>
        )}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>
        {item.author_name}{item.author_role ? ` — ${item.author_role}` : ''}
      </div>
      <div style={{ marginTop: 4, fontSize: 13, color: 'var(--tax-muted)' }}>{item.body}</div>
      <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onEdit}>
          {t('owner.services.edit')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onDelete}
                style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
          {t('owner.services.delete')}
        </button>
      </div>
    </div>
  );
}

function TestimonialForm({ initial, auth, community, t, onClose, onSaved }) {
  const isEdit = !!initial;
  const [authorName, setAuthorName] = useState(initial?.author_name || '');
  const [authorRole, setAuthorRole] = useState(initial?.author_role || '');
  const [body, setBody] = useState(initial?.body || '');
  const [rating, setRating] = useState(String(initial?.rating || 5));
  const [locale, setLocale] = useState(initial?.locale || 'en');
  const [active, setActive] = useState(initial?.active !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    if (!authorName.trim() || !body.trim()) {
      setErr(t('owner.testimonials.form.errRequired'));
      return;
    }
    setBusy(true); setErr('');
    try {
      const payload = {
        communitySlug: community.id,
        authorName: authorName.trim(), authorRole: authorRole.trim(),
        body: body.trim(), rating: Number(rating) || 5, locale, active,
      };
      if (isEdit) await taxApi.adminUpdateTestimonial(auth, initial.id, payload);
      else        await taxApi.adminCreateTestimonial(auth, payload);
      onSaved();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={onSubmit} style={{
      padding: 14, background: 'var(--tax-bg-card, #fff)',
      border: '1px solid var(--tax-border)', borderRadius: 8, display: 'grid', gap: 8,
    }}>
      <div className="tax-form__row2">
        <div>
          <label style={fieldLabel}>{t('owner.testimonials.form.authorName')}</label>
          <input type="text" value={authorName} onChange={e => setAuthorName(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.testimonials.form.authorRole')}</label>
          <input type="text" value={authorRole} onChange={e => setAuthorRole(e.target.value)} maxLength={200} />
        </div>
      </div>
      <div>
        <label style={fieldLabel}>{t('owner.testimonials.form.body')}</label>
        <textarea rows={3} value={body} onChange={e => setBody(e.target.value)} maxLength={4000} />
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={fieldLabel}>{t('owner.testimonials.form.rating')}</label>
          <select value={rating} onChange={e => setRating(e.target.value)}>
            {[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.testimonials.form.locale')}</label>
          <select value={locale} onChange={e => setLocale(e.target.value)}>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
        {t('owner.testimonials.form.active')}
      </label>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : (isEdit ? t('owner.services.save') : t('owner.testimonials.form.create'))}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}

const fieldLabel = { fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' };

function fmtDateTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
