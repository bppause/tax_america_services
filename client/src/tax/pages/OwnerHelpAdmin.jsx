import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Phase 4e: owner-managed help articles. Mirrors the override pattern from
// the FAQ admin (Phase 2b) — three flavors of community row:
//   override → replace the default's title/body
//   hide     → mark default invisible in this community
//   custom   → community-authored article (no underlying default)
//
// UI: audience toggle (customer/employee), per-article row with source pill
// (Default / Overridden / Custom / Hidden), inline editor for override +
// custom-create form at the bottom.

const SOURCE_LABEL_KEY = {
  default: 'owner.help.source.default',
  override: 'owner.help.source.override',
  hidden: 'owner.help.source.hidden',
  custom: 'owner.help.source.custom',
};
const SOURCE_COLOR = {
  default: { bg: '#f3f4f6', fg: '#4b5563' },
  override: { bg: '#fef3c7', fg: '#92400e' },
  hidden: { bg: '#fee2e2', fg: '#991b1b' },
  custom: { bg: '#dcfce7', fg: '#166534' },
};

const CATEGORY_KEYS = [
  'getting_started', 'documents', 'messages', 'filings',
  'notifications', 'profile', 'service', 'admin', 'general',
];

export default function OwnerHelpAdmin() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [audience, setAudience] = useState('customer');
  const [articles, setArticles] = useState(null);
  const [types, setTypes] = useState([]);
  const [err, setErr] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminListHelp(auth, community.id, audience)
      .then(d => setArticles(d.articles?.[audience] || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community, audience]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!employee || !community) return;
    taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id })
      .then(d => setTypes(d.types || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="articles">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('owner.help.title')}</h2>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={() => setShowCustom(s => !s)}>
          {showCustom ? t('owner.help.custom.cancel') : t('owner.help.custom.add')}
        </button>
      </div>
      <p className="tax-section__lede">{t('owner.help.subtitle')}</p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['customer', 'employee'].map(aud => (
          <button key={aud} type="button"
                  className={`tax-btn tax-btn--sm ${audience === aud ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                  onClick={() => setAudience(aud)}
                  style={audience !== aud ? { color: 'var(--tax-text)', borderColor: 'var(--tax-border)' } : undefined}>
            {t(`owner.help.audience.${aud}`)}
          </button>
        ))}
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {showCustom && (
        <CustomCreateForm
          audience={audience} types={types} auth={auth}
          onDone={() => { setShowCustom(false); load(); }}
          onCancel={() => setShowCustom(false)} locale={locale} t={t} />
      )}

      {articles === null ? <p>{t('loading')}</p>
        : articles.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.help.empty')}</p>
          : <div style={{ display: 'grid', gap: 8 }}>
              {articles.map(a => (
                <ArticleRow key={a.id} article={a} auth={auth} onChange={load} locale={locale} t={t} />
              ))}
            </div>}
    </EmployeeShell>
  );
}

function ArticleRow({ article, auth, onChange, locale, t }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const c = SOURCE_COLOR[article.source] || SOURCE_COLOR.default;

  const titleEn = article.title_i18n?.en || '';
  const titleEs = article.title_i18n?.es || '';
  const bodyEn = article.body_i18n?.en || '';
  const bodyEs = article.body_i18n?.es || '';

  const onHide = async () => {
    if (!window.confirm(t('owner.help.confirm.hide'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminOverrideHelp(auth, article.defaultId || article.id, {
        communitySlug: auth.communitySlug,
        titleI18n: {}, bodyI18n: {}, visible: false,
      });
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onUnhide = async () => {
    if (!article.overrideId) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteHelp(auth, article.overrideId);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onResetOverride = async () => {
    if (!window.confirm(t('owner.help.confirm.resetOverride'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteHelp(auth, article.overrideId || article.id);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onDeleteCustom = async () => {
    if (!window.confirm(t('owner.help.confirm.deleteCustom'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteHelp(auth, article.id);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item" style={{ opacity: article.source === 'hidden' ? 0.6 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {pickI18n(article.title_i18n, locale).value || '—'}
            <span style={{
              marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              background: c.bg, color: c.fg, fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }}>{t(SOURCE_LABEL_KEY[article.source] || 'owner.help.source.default')}</span>
            {article.relationship_type_id && (
              <span style={{ marginLeft: 6, color: 'var(--tax-muted)', fontSize: 11 }}>
                · {pickI18n(article.type?.name_i18n, locale).value || article.relationship_type_id}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
            {article.category}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!editing && article.source !== 'custom' && article.source !== 'hidden' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={() => setEditing(true)} style={{ color: 'var(--tax-text)' }}>
              {t('owner.help.editOverride')}
            </button>
          )}
          {!editing && article.source === 'override' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onResetOverride} disabled={busy}
                    style={{ color: 'var(--tax-muted)' }}>
              {t('owner.help.resetOverride')}
            </button>
          )}
          {!editing && article.source === 'default' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onHide} disabled={busy}
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.help.hide')}
            </button>
          )}
          {!editing && article.source === 'hidden' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onUnhide} disabled={busy} style={{ color: 'var(--tax-text)' }}>
              {t('owner.help.unhide')}
            </button>
          )}
          {!editing && article.source === 'custom' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onDeleteCustom} disabled={busy}
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.help.deleteCustom')}
            </button>
          )}
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error" style={{ marginTop: 8 }}>{err}</div>}

      {editing && (
        <OverrideEditor
          article={article}
          auth={auth}
          onDone={() => { setEditing(false); onChange(); }}
          onCancel={() => setEditing(false)}
          initialTitle={{ en: titleEn, es: titleEs }}
          initialBody={{ en: bodyEn, es: bodyEs }}
          t={t} />
      )}

      {!editing && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--tax-muted)', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden' }}>
          {pickI18n(article.body_i18n, locale).value}
        </div>
      )}
    </div>
  );
}

function OverrideEditor({ article, auth, onDone, onCancel, initialTitle, initialBody, t }) {
  const [titleEn, setTitleEn] = useState(initialTitle.en);
  const [titleEs, setTitleEs] = useState(initialTitle.es);
  const [bodyEn, setBodyEn] = useState(initialBody.en);
  const [bodyEs, setBodyEs] = useState(initialBody.es);
  const [videoUrl, setVideoUrl] = useState(article.video_url || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const targetDefaultId = article.defaultId || article.id;

  const onSave = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminOverrideHelp(auth, targetDefaultId, {
        communitySlug: auth.communitySlug,
        titleI18n: { en: titleEn.trim(), es: titleEs.trim() },
        bodyI18n: { en: bodyEn.trim(), es: bodyEs.trim() },
        videoUrl: videoUrl.trim(),
        visible: true,
      });
      onDone();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 12, padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8, display: 'grid', gap: 12 }}>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.titleEn')}</label>
          <input type="text" value={titleEn} onChange={e => setTitleEn(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.titleEs')}</label>
          <input type="text" value={titleEs} onChange={e => setTitleEs(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.bodyEn')}</label>
          <textarea rows={6} value={bodyEn} onChange={e => setBodyEn(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.bodyEs')}</label>
          <textarea rows={6} value={bodyEs} onChange={e => setBodyEs(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.videoUrl')}</label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} maxLength={500}
               placeholder="https://youtube.com/watch?v=…"
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={onSave} disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.help.saveOverride')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('owner.help.cancelEdit')}
        </button>
      </div>
    </div>
  );
}

function CustomCreateForm({ audience, types, auth, onDone, onCancel, locale, t }) {
  const [category, setCategory] = useState('general');
  const [relationshipTypeId, setRelationshipTypeId] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [titleEs, setTitleEs] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [bodyEs, setBodyEs] = useState('');
  const [displayOrder, setDisplayOrder] = useState('1000');
  const [videoUrl, setVideoUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!titleEn.trim() && !titleEs.trim()) { setErr(t('owner.help.errTitle')); return; }
    if (!bodyEn.trim() && !bodyEs.trim())   { setErr(t('owner.help.errBody'));  return; }
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateHelp(auth, {
        communitySlug: auth.communitySlug,
        audience, category,
        relationshipTypeId: relationshipTypeId || undefined,
        titleI18n: { en: titleEn.trim(), es: titleEs.trim() },
        bodyI18n:  { en: bodyEn.trim(),  es: bodyEs.trim()  },
        displayOrder: Number(displayOrder) || 1000,
        videoUrl: videoUrl.trim(),
      });
      onDone();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <form className="tax-contact-item" onSubmit={onSubmit} style={{ marginBottom: 16, padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ fontWeight: 600 }}>{t('owner.help.custom.title')}</div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.category')}</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
                  style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            {CATEGORY_KEYS.map(k => (
              <option key={k} value={k}>{t(`portal.help.cat.${k === 'general' ? 'service' : (k === 'getting_started' ? 'gettingStarted' : k)}`)}</option>
            ))}
          </select>
        </div>
        {audience === 'customer' && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.relationshipTag')}</label>
            <select value={relationshipTypeId} onChange={e => setRelationshipTypeId(e.target.value)}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
              <option value="">{t('owner.help.relationshipTag.none')}</option>
              {types.map(tp => (
                <option key={tp.id} value={tp.id}>{pickI18n(tp.name_i18n, locale).value}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.titleEn')}</label>
          <input type="text" value={titleEn} onChange={e => setTitleEn(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.titleEs')}</label>
          <input type="text" value={titleEs} onChange={e => setTitleEs(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.bodyEn')}</label>
          <textarea rows={6} value={bodyEn} onChange={e => setBodyEn(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.bodyEs')}</label>
          <textarea rows={6} value={bodyEs} onChange={e => setBodyEs(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.help.displayOrder')}:&nbsp;
          <input type="number" value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} min="0" max="10000"
                 style={{ width: 80, padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 4 }} />
        </label>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.help.videoUrl')}</label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} maxLength={500}
               placeholder="https://youtube.com/watch?v=…"
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.help.custom.create')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('owner.help.custom.cancel')}
        </button>
      </div>
    </form>
  );
}
