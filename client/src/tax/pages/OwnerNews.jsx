import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Owner-managed news feed. Three areas in one card:
//   1. Settings: topics chip list + display limit + auto-refresh toggle.
//   2. Refresh now: button that fires the LLM-grounded refresh and shows
//      how many AI rows were inserted.
//   3. Articles list with inline add/edit/delete and video URL or upload.
//
// AI rows (source='ai') are flagged so the owner can tell which entries
// the daily cron will rewrite vs. their own pinned manual entries.
export default function OwnerNews() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [settings, setSettings] = useState(null);
  const [articles, setArticles] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  const [busy, setBusy] = useState(false);

  const loadSettings = () => {
    if (!community?.id) return;
    taxApi.adminGetCommunitySettings(auth, community.id)
      .then(d => setSettings(d.settings))
      .catch(e => setMsg({ kind: 'error', text: e?.message || '' }));
  };
  const loadArticles = () => {
    if (!community?.id) return;
    taxApi.adminListNews(auth, community.id)
      .then(d => setArticles(d.articles || []))
      .catch(e => setMsg({ kind: 'error', text: e?.message || '' }));
  };
  useEffect(() => { loadSettings(); loadArticles(); }, [community?.id]); // eslint-disable-line

  const onRefresh = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminRefreshNews(auth, { communitySlug: community.id });
      setMsg({ kind: 'success', text: t('owner.news.refreshed', { n: r.inserted || 0 }) });
      loadArticles(); loadSettings();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.body?.message || e?.message || '' });
    }
    finally { setBusy(false); }
  };

  const onDelete = async (id) => {
    if (!window.confirm(t('owner.news.deleteConfirm'))) return;
    try { await taxApi.adminDeleteNews(auth, id); loadArticles(); }
    catch (e) { setMsg({ kind: 'error', text: e?.message || '' }); }
  };

  if (!community) return <EmployeeShell active="news"><p>{t('loading')}</p></EmployeeShell>;

  return (
    <EmployeeShell community={community} active="news">
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '16px 12px 80px' }}>
        <h1 style={{ marginTop: 0 }}>{t('owner.news.title')}</h1>
        <p style={{ color: 'var(--tax-muted)', marginTop: 0 }}>
          {t('owner.news.subtitle')}
        </p>

        {msg.text && (
          <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
               style={{ marginBottom: 12 }}>{msg.text}</div>
        )}

        <SettingsPanel settings={settings} auth={auth} community={community} t={t}
                       onSaved={loadSettings}
                       onMsg={setMsg} />

        <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="tax-btn tax-btn--primary"
                  onClick={onRefresh} disabled={busy}>
            {busy ? t('owner.news.refreshing') : t('owner.news.refreshNow')}
          </button>
          {settings?.tax_news_last_refreshed_at && (
            <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('owner.news.lastRefreshed')}: {fmtDateTime(settings.tax_news_last_refreshed_at, locale)}
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.news.refreshHint')}
          </span>
        </div>

        <h2 style={{ marginTop: 28, fontSize: 16 }}>{t('owner.news.articles')}</h2>

        {articles === null
          ? <p>{t('loading')}</p>
          : (
            <>
              <div style={{ display: 'grid', gap: 10 }}>
                {articles.length === 0 && (
                  <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>
                    {t('owner.news.empty')}
                  </p>
                )}
                {articles.map(a => (
                  editingId === a.id
                    ? <ArticleForm key={a.id}
                                   initial={a} auth={auth} community={community} t={t}
                                   onClose={() => setEditingId('')}
                                   onSaved={() => { setEditingId(''); loadArticles(); }} />
                    : <ArticleRow key={a.id} article={a} locale={locale} t={t}
                                  onEdit={() => setEditingId(a.id)}
                                  onDelete={() => onDelete(a.id)} />
                ))}
              </div>
              {adding
                ? <div style={{ marginTop: 10 }}>
                    <ArticleForm initial={null} auth={auth} community={community} t={t}
                                 onClose={() => setAdding(false)}
                                 onSaved={() => { setAdding(false); loadArticles(); }} />
                  </div>
                : <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          style={{ marginTop: 10 }}
                          onClick={() => setAdding(true)}>
                    + {t('owner.news.add')}
                  </button>}
            </>
          )}
      </div>
    </EmployeeShell>
  );
}

function SettingsPanel({ settings, auth, community, t, onSaved, onMsg }) {
  const topicsInitial = Array.isArray(settings?.tax_news_topics) ? settings.tax_news_topics : [];
  const limitInitial = Number(settings?.tax_news_display_limit) || 5;
  const autoInitial = settings?.tax_news_auto_refresh !== false;
  const [topics, setTopics] = useState(topicsInitial);
  const [draft, setDraft] = useState('');
  const [limit, setLimit] = useState(String(limitInitial));
  const [auto, setAuto] = useState(autoInitial);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setTopics(topicsInitial); }, [JSON.stringify(topicsInitial)]); // eslint-disable-line
  useEffect(() => { setLimit(String(limitInitial)); }, [limitInitial]);
  useEffect(() => { setAuto(autoInitial); }, [autoInitial]);

  const addTopic = () => {
    const s = draft.trim();
    if (!s) return;
    if (topics.includes(s)) { setDraft(''); return; }
    if (topics.length >= 10) return;
    setTopics([...topics, s]);
    setDraft('');
  };
  const removeTopic = (s) => setTopics(topics.filter(x => x !== s));

  const onSave = async () => {
    setBusy(true); onMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetNewsTopics(auth, { communitySlug: community.id, topics });
      const n = Math.max(1, Math.min(20, Math.round(Number(limit) || 5)));
      await taxApi.adminSetNewsDisplayLimit(auth, { communitySlug: community.id, limit: n });
      await taxApi.adminSetNewsAutoRefresh(auth, { communitySlug: community.id, enabled: auto });
      onMsg({ kind: 'success', text: t('owner.settings.saved') });
      onSaved();
    } catch (e) { onMsg({ kind: 'error', text: e?.message || '' }); }
    finally { setBusy(false); }
  };

  if (!settings) return <p>{t('loading')}</p>;

  return (
    <div style={{
      padding: 14, borderRadius: 10, background: 'var(--tax-bg-card, #fff)',
      border: '1px solid var(--tax-border)',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('owner.news.settings.title')}</div>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--tax-muted)' }}>
        {t('owner.news.settings.subtitle')}
      </p>

      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
        {t('owner.news.settings.topicsLabel')}
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '6px 0' }}>
        {topics.map(s => (
          <span key={s} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '4px 8px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)',
            color: 'var(--tax-text)', fontSize: 12,
          }}>
            {s}
            <button type="button" onClick={() => removeTopic(s)} aria-label={`Remove ${s}`}
                    style={{ border: 0, background: 'transparent', cursor: 'pointer',
                             color: 'var(--tax-muted)', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {topics.length === 0 && (
          <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.news.settings.noTopics')}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="text" value={draft} onChange={e => setDraft(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTopic(); } }}
               placeholder={t('owner.news.settings.topicPlaceholder')}
               maxLength={200}
               style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={addTopic} disabled={!draft.trim() || topics.length >= 10}>
          {t('owner.news.settings.addTopic')}
        </button>
      </div>
      <p style={{ margin: '6px 0 12px', fontSize: 11, color: 'var(--tax-muted)' }}>
        {t('owner.news.settings.topicsHint')}
      </p>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
          {t('owner.news.settings.limitLabel')}&nbsp;
          <input type="number" min="1" max="20" value={limit}
                 onChange={e => setLimit(e.target.value)}
                 style={{ width: 70 }} />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
          {t('owner.news.settings.autoLabel')}
        </label>
      </div>

      <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
              onClick={onSave} disabled={busy}>
        {busy ? t('lead.submitting') : t('owner.news.settings.save')}
      </button>
    </div>
  );
}

function ArticleRow({ article: a, locale, t, onEdit, onDelete }) {
  const title = pickI18n(a.title_i18n, locale).value || '(no title)';
  const summary = pickI18n(a.summary_i18n, locale).value || '';
  const isAi = a.source === 'ai';
  return (
    <div style={{
      padding: 12, border: '1px solid var(--tax-border)', borderRadius: 8,
      background: 'var(--tax-bg-card, #fff)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{
          padding: '1px 6px', borderRadius: 4,
          background: isAi ? '#e0e7ff' : '#dcfce7',
          color: isAi ? '#3730a3' : '#166534',
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
        }}>{isAi ? t('owner.news.sourceAi') : t('owner.news.sourceManual')}</span>
        {a.topic && (
          <span style={{
            padding: '1px 6px', borderRadius: 4, background: '#f3f4f6',
            color: '#4b5563', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>{a.topic}</span>
        )}
        {(a.video_url || a.video_storage_path) && (
          <span style={{
            padding: '1px 6px', borderRadius: 4, background: '#fee2e2',
            color: '#991b1b', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>▶ {t('owner.news.video')}</span>
        )}
        {a.active === false && (
          <span style={{
            padding: '1px 6px', borderRadius: 4, background: '#fee2e2',
            color: '#991b1b', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.05em',
          }}>{t('owner.news.inactive')}</span>
        )}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
      {summary && (
        <div style={{ marginTop: 4, fontSize: 13, color: 'var(--tax-muted)' }}>{summary}</div>
      )}
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

function ArticleForm({ initial, auth, community, t, onClose, onSaved }) {
  const isEdit = !!initial;
  const [titleEn, setTitleEn] = useState(initial?.title_i18n?.en || '');
  const [titleEs, setTitleEs] = useState(initial?.title_i18n?.es || '');
  const [summaryEn, setSummaryEn] = useState(initial?.summary_i18n?.en || '');
  const [summaryEs, setSummaryEs] = useState(initial?.summary_i18n?.es || '');
  const [bodyEn, setBodyEn] = useState(initial?.body_i18n?.en || '');
  const [bodyEs, setBodyEs] = useState(initial?.body_i18n?.es || '');
  const [topic, setTopic] = useState(initial?.topic || '');
  const [sourceUrl, setSourceUrl] = useState(initial?.source_url || '');
  const [sourceName, setSourceName] = useState(initial?.source_name || '');
  const [videoUrl, setVideoUrl] = useState(initial?.video_url || '');
  const [videoStoragePath, setVideoStoragePath] = useState(initial?.video_storage_path || '');
  const [active, setActive] = useState(initial?.active !== false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const onUpload = async (file) => {
    if (!file) return;
    setUploading(true); setErr('');
    try {
      const r = await taxApi.adminGetNewsVideoUploadUrl(auth, {
        communitySlug: community.id, filename: file.name || 'video.mp4',
      });
      const put = await fetch(r.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed: ${put.status} ${put.statusText}`);
      // Store the public URL so the public site can render it without
      // re-signing. Also stash the storage path for cleanup-on-delete.
      setVideoUrl(r.publicUrl || '');
      setVideoStoragePath(r.path);
    } catch (e) { setErr(e?.message || ''); }
    finally { setUploading(false); }
  };

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    if (!titleEn.trim() && !titleEs.trim()) {
      setErr(t('owner.news.form.errTitle'));
      return;
    }
    setBusy(true); setErr('');
    try {
      const payload = {
        communitySlug: community.id,
        titleEn: titleEn.trim(), titleEs: titleEs.trim(),
        summaryEn: summaryEn.trim(), summaryEs: summaryEs.trim(),
        bodyEn, bodyEs,
        topic: topic.trim(),
        sourceUrl: sourceUrl.trim(),
        sourceName: sourceName.trim(),
        videoUrl: videoUrl.trim(),
        videoStoragePath,
        active,
      };
      if (isEdit) await taxApi.adminUpdateNews(auth, initial.id, payload);
      else        await taxApi.adminCreateNews(auth, payload);
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
          <label style={fieldLabel}>{t('owner.news.form.titleEn')}</label>
          <input type="text" value={titleEn} onChange={e => setTitleEn(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.news.form.titleEs')}</label>
          <input type="text" value={titleEs} onChange={e => setTitleEs(e.target.value)} maxLength={200} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={fieldLabel}>{t('owner.news.form.summaryEn')}</label>
          <textarea rows={2} value={summaryEn} onChange={e => setSummaryEn(e.target.value)} maxLength={1000} />
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.news.form.summaryEs')}</label>
          <textarea rows={2} value={summaryEs} onChange={e => setSummaryEs(e.target.value)} maxLength={1000} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={fieldLabel}>{t('owner.news.form.bodyEn')}</label>
          <textarea rows={4} value={bodyEn} onChange={e => setBodyEn(e.target.value)} maxLength={4000} />
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.news.form.bodyEs')}</label>
          <textarea rows={4} value={bodyEs} onChange={e => setBodyEs(e.target.value)} maxLength={4000} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={fieldLabel}>{t('owner.news.form.topic')}</label>
          <input type="text" value={topic} onChange={e => setTopic(e.target.value)} maxLength={200}
                 placeholder={t('owner.news.form.topicPlaceholder')} />
        </div>
        <div>
          <label style={fieldLabel}>{t('owner.news.form.sourceName')}</label>
          <input type="text" value={sourceName} onChange={e => setSourceName(e.target.value)} maxLength={200}
                 placeholder="IRS.gov" />
        </div>
      </div>
      <div>
        <label style={fieldLabel}>{t('owner.news.form.sourceUrl')}</label>
        <input type="url" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} maxLength={500}
               placeholder="https://" />
      </div>
      <div style={{ padding: 8, borderRadius: 6, background: 'color-mix(in srgb, #2563eb 4%, #fff)' }}>
        <label style={fieldLabel}>{t('owner.news.form.videoUrl')}</label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} maxLength={500}
               placeholder="https://www.youtube.com/watch?v=…" />
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('owner.news.form.orUpload')}</span>
          <input type="file" accept="video/mp4,video/quicktime,video/webm"
                 onChange={e => onUpload(e.target.files?.[0])} disabled={uploading} />
          {uploading && <span style={{ fontSize: 12 }}>{t('owner.news.form.uploading')}</span>}
        </div>
        {videoStoragePath && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--tax-muted)' }}>
            {t('owner.news.form.uploaded')}: {videoStoragePath}
          </div>
        )}
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
        <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
        {t('owner.news.form.active')}
      </label>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : (isEdit ? t('owner.services.save') : t('owner.news.form.create'))}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}

const fieldLabel = { fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' };

function fmtDateTime(iso, locale) {
  try { return new Date(iso).toLocaleString(locale === 'es' ? 'es' : 'en'); }
  catch { return iso; }
}
