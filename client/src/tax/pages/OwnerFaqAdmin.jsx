import { useEffect, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Phase 4f: FAQ override admin. Mirrors the OwnerHelpAdmin layout from
// Phase 4e but groups by relationship type since FAQs are always
// relationship-scoped (Phase 2b design).
//
// Backend endpoints live since Phase 2b:
//   GET    /admin/communities/:slug/faqs               returns { groups: [{type, faqs}] }
//   PUT    /admin/communities/:slug/faqs/override/:id  override or hide
//   POST   /admin/communities/:slug/faqs/custom        add new community FAQ
//   DELETE /admin/communities/:slug/faqs/:overrideId   revert override / delete custom

const SOURCE_LABEL_KEY = {
  default:  'owner.faq.source.default',
  override: 'owner.faq.source.override',
  custom:   'owner.faq.source.custom',
};
const SOURCE_COLOR = {
  default:  { bg: '#f3f4f6', fg: '#4b5563' },
  override: { bg: '#fef3c7', fg: '#92400e' },
  custom:   { bg: '#dcfce7', fg: '#166534' },
};

export default function OwnerFaqAdmin() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [groups, setGroups] = useState(null);
  const [err, setErr] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [customTypeId, setCustomTypeId] = useState('');

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminListCommunityFaqs(auth, community.id)
      .then(d => setGroups(d.groups || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="faqs">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('owner.faq.title')}</h2>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={() => setShowCustom(s => !s)}>
          {showCustom ? t('owner.faq.custom.cancel') : t('owner.faq.custom.add')}
        </button>
      </div>
      <p className="tax-section__lede">{t('owner.faq.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {showCustom && groups && (
        <CustomCreateForm
          groups={groups} auth={auth}
          customTypeId={customTypeId} setCustomTypeId={setCustomTypeId}
          onDone={() => { setShowCustom(false); load(); }}
          onCancel={() => setShowCustom(false)}
          locale={locale} t={t} />
      )}

      {groups === null ? <p>{t('loading')}</p>
        : groups.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.faq.empty')}</p>
          : groups.map(g => (
              <section key={g.type.id} style={{ marginBottom: 32 }}>
                <h3 style={{ marginBottom: 4 }}>{pickI18n(g.type.name_i18n, locale).value}</h3>
                <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginBottom: 8 }}>{g.type.category}</div>
                {g.faqs.length === 0 ? (
                  <p style={{ color: 'var(--tax-muted)' }}>{t('owner.faq.noneForType')}</p>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {g.faqs.map(f => (
                      <FaqRow key={f.id} faq={f} auth={auth} community={community}
                              onChange={load} locale={locale} t={t} />
                    ))}
                  </div>
                )}
              </section>
            ))}
    </EmployeeShell>
  );
}

function FaqRow({ faq, auth, community, onChange, locale, t }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const c = SOURCE_COLOR[faq.source] || SOURCE_COLOR.default;

  const titleEn = faq.question_i18n?.en || '';
  const titleEs = faq.question_i18n?.es || '';
  const bodyEn  = faq.answer_i18n?.en   || '';
  const bodyEs  = faq.answer_i18n?.es   || '';

  // For default/override rows, faq.id is the row id we'd edit. For overrides,
  // `defaultFaqId` is on faq.defaultFaqId (returned by Phase 2b's
  // loadEffectiveFaqs). For defaults, the id IS the default id.
  const defaultIdForOverride = faq.source === 'override' ? faq.defaultFaqId : faq.id;

  const onHide = async () => {
    if (!window.confirm(t('owner.faq.confirm.hide'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminOverrideFaq(auth, defaultIdForOverride, {
        communitySlug: community.id,
        questionI18n: {}, answerI18n: {}, visible: false,
      });
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onResetOverride = async () => {
    if (!window.confirm(t('owner.faq.confirm.resetOverride'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteCommunityFaq(auth, community.id, faq.id);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onDeleteCustom = async () => {
    if (!window.confirm(t('owner.faq.confirm.deleteCustom'))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteCommunityFaq(auth, community.id, faq.id);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {pickI18n(faq.question_i18n, locale).value || '—'}
            <span style={{
              marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              background: c.bg, color: c.fg, fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }}>{t(SOURCE_LABEL_KEY[faq.source] || 'owner.faq.source.default')}</span>
          </div>
          {faq.source_note && (
            <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
              {t('owner.faq.source')}: {faq.source_note}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!editing && faq.source !== 'custom' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={() => setEditing(true)} style={{ color: 'var(--tax-text)' }}>
              {t('owner.faq.editOverride')}
            </button>
          )}
          {!editing && faq.source === 'override' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onResetOverride} disabled={busy}
                    style={{ color: 'var(--tax-muted)' }}>
              {t('owner.faq.resetOverride')}
            </button>
          )}
          {!editing && faq.source === 'default' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onHide} disabled={busy}
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.faq.hide')}
            </button>
          )}
          {!editing && faq.source === 'custom' && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onDeleteCustom} disabled={busy}
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.faq.deleteCustom')}
            </button>
          )}
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error" style={{ marginTop: 8 }}>{err}</div>}

      {editing ? (
        <OverrideEditor
          faq={faq} auth={auth} community={community}
          defaultIdForOverride={defaultIdForOverride}
          initialQ={{ en: titleEn, es: titleEs }} initialA={{ en: bodyEn, es: bodyEs }}
          initialVideoUrl={faq.video_url || ''}
          onDone={() => { setEditing(false); onChange(); }}
          onCancel={() => setEditing(false)} t={t} />
      ) : (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--tax-muted)',
                      whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'hidden' }}>
          {pickI18n(faq.answer_i18n, locale).value}
        </div>
      )}
    </div>
  );
}

function OverrideEditor({ auth, community, defaultIdForOverride, initialQ, initialA, initialVideoUrl = '', onDone, onCancel, t }) {
  const [qEn, setQEn] = useState(initialQ.en);
  const [qEs, setQEs] = useState(initialQ.es);
  const [aEn, setAEn] = useState(initialA.en);
  const [aEs, setAEs] = useState(initialA.es);
  const [videoUrl, setVideoUrl] = useState(initialVideoUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSave = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminOverrideFaq(auth, defaultIdForOverride, {
        communitySlug: community.id,
        questionI18n: { en: qEn.trim(), es: qEs.trim() },
        answerI18n:   { en: aEn.trim(), es: aEs.trim() },
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
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.qEn')}</label>
          <input type="text" value={qEn} onChange={e => setQEn(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.qEs')}</label>
          <input type="text" value={qEs} onChange={e => setQEs(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.aEn')}</label>
          <textarea rows={5} value={aEn} onChange={e => setAEn(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.aEs')}</label>
          <textarea rows={5} value={aEs} onChange={e => setAEs(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.videoUrl')}</label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} maxLength={500}
               placeholder="https://youtube.com/watch?v=…"
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      </div>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={onSave} disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.faq.saveOverride')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('owner.faq.cancelEdit')}
        </button>
      </div>
    </div>
  );
}

function CustomCreateForm({ groups, auth, customTypeId, setCustomTypeId, onDone, onCancel, locale, t }) {
  const [qEn, setQEn] = useState('');
  const [qEs, setQEs] = useState('');
  const [aEn, setAEn] = useState('');
  const [aEs, setAEs] = useState('');
  const [displayOrder, setDisplayOrder] = useState('1000');
  const [videoUrl, setVideoUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const types = groups.map(g => g.type);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!customTypeId) { setErr(t('owner.faq.errType')); return; }
    if (!qEn.trim() && !qEs.trim()) { setErr(t('owner.faq.errQuestion')); return; }
    if (!aEn.trim() && !aEs.trim()) { setErr(t('owner.faq.errAnswer')); return; }
    setBusy(true); setErr('');
    try {
      await taxApi.adminAddCustomFaq(auth, auth.communitySlug, {
        relationshipTypeId: customTypeId,
        displayOrder: Number(displayOrder) || 1000,
        questionI18n: { en: qEn.trim(), es: qEs.trim() },
        answerI18n:   { en: aEn.trim(), es: aEs.trim() },
        videoUrl: videoUrl.trim(),
      });
      onDone();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <form className="tax-contact-item" onSubmit={onSubmit} style={{ marginBottom: 16, padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ fontWeight: 600 }}>{t('owner.faq.custom.title')}</div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.serviceTag')}</label>
        <select value={customTypeId} onChange={e => setCustomTypeId(e.target.value)}
                style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, maxWidth: 360 }}>
          <option value="">{t('owner.faq.chooseService')}</option>
          {types.map(tp => (
            <option key={tp.id} value={tp.id}>{pickI18n(tp.name_i18n, locale).value}</option>
          ))}
        </select>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.qEn')}</label>
          <input type="text" value={qEn} onChange={e => setQEn(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.qEs')}</label>
          <input type="text" value={qEs} onChange={e => setQEs(e.target.value)} maxLength={240}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.aEn')}</label>
          <textarea rows={5} value={aEn} onChange={e => setAEn(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.aEs')}</label>
          <textarea rows={5} value={aEs} onChange={e => setAEs(e.target.value)} maxLength={4000}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.faq.displayOrder')}:&nbsp;
          <input type="number" value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} min="0" max="10000"
                 style={{ width: 80, padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 4 }} />
        </label>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.faq.videoUrl')}</label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} maxLength={500}
               placeholder="https://youtube.com/watch?v=…"
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.faq.custom.create')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('owner.faq.custom.cancel')}
        </button>
      </div>
    </form>
  );
}
