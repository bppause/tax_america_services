import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { generatePeriods } from '../lib/schedulePeriods';

// Owner-admin editor for the landing-page service cards. Mirrors the
// OwnerFaqAdmin / OwnerHelpAdmin layout — each row is one tax_products
// row, click Edit to surface bilingual fields for name, short description,
// long description (for the detail modal), and required-document bullets.
//
// tax_products rows are already per-community, so there's no "default vs
// override" distinction here like FAQs have: editing is in place.

export default function OwnerServicesAdmin() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [products, setProducts] = useState(null);
  const [relTypes, setRelTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [err, setErr] = useState('');

  const load = () => {
    if (!employee || !community) return;
    Promise.all([
      taxApi.adminListProducts(auth, community.id),
      taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id }).catch(() => ({ types: [] })),
      taxApi.adminListEmployees(auth, community.id).catch(() => ({ employees: [] })),
    ]).then(([p, r, e]) => {
      setProducts(p.products || []);
      setRelTypes((r.types || []).filter(rt => rt.active !== false));
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
    }).catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="service-catalog">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('owner.services.title')}</h2>
        <AddServiceLauncher community={community} auth={auth} onAdded={load} t={t} />
      </div>
      <p className="tax-section__lede">{t('owner.services.subtitleUnified')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {products === null ? <p>{t('loading')}</p>
        : products.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.services.empty')}</p>
          : <div style={{ display: 'grid', gap: 10 }}>
              {products.map(p => (
                <ServiceRow key={p.id} product={p} auth={auth}
                            community={community} relTypes={relTypes}
                            employees={employees}
                            onChange={load} locale={locale} t={t} />
              ))}
            </div>}
    </EmployeeShell>
  );
}

// Inline "Add service" form, shown when the owner clicks the header
// button. Keeps the create flow small: just the slug, both names, both
// short descriptions, and the category. Long copy + required documents
// + auto-tasks are authored after creation via the standard edit panel.
function AddServiceLauncher({ community, auth, onAdded, t }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameEs, setNameEs] = useState('');
  const [descEn, setDescEn] = useState('');
  const [descEs, setDescEs] = useState('');
  const [category, setCategory] = useState('one_off');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reset = () => {
    setSlug(''); setNameEn(''); setNameEs('');
    setDescEn(''); setDescEs(''); setCategory('one_off');
    setErr('');
  };

  const onCreate = async (e) => {
    e?.preventDefault?.();
    if (!nameEn.trim() && !nameEs.trim()) {
      setErr(t('owner.services.add.errName'));
      return;
    }
    setBusy(true); setErr('');
    try {
      // Derive the slug from the EN name when the owner hasn't typed
      // one explicitly. Server normalizes either way, but pre-filling
      // saves a step.
      const finalSlug = (slug.trim() || nameEn.trim() || nameEs.trim())
        .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      await taxApi.adminCreateProduct(auth, {
        communitySlug: community.id,
        slug: finalSlug,
        category,
        nameI18n: { en: nameEn.trim(), es: nameEs.trim() },
        descriptionI18n: { en: descEn.trim(), es: descEs.trim() },
      });
      setOpen(false); reset();
      onAdded();
    } catch (e) {
      setErr(e?.body?.message || e?.message || '');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
              onClick={() => setOpen(true)}>
        + {t('owner.services.add.button')}
      </button>
    );
  }

  return (
    <form onSubmit={onCreate}
          style={{ width: '100%', marginTop: 8, padding: 14, borderRadius: 8,
                   background: 'var(--tax-bg-alt)', display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{t('owner.services.add.heading')}</div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.nameEn')} *
          </label>
          <input type="text" value={nameEn} maxLength={200}
                 onChange={e => setNameEn(e.target.value)}
                 placeholder="e.g. Property Tax"
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.nameEs')} *
          </label>
          <input type="text" value={nameEs} maxLength={200}
                 onChange={e => setNameEs(e.target.value)}
                 placeholder="p. ej. Impuesto Predial"
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.descEn')}
          </label>
          <textarea rows={2} value={descEn} maxLength={400}
                    onChange={e => setDescEn(e.target.value)}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.descEs')}
          </label>
          <textarea rows={2} value={descEs} maxLength={400}
                    onChange={e => setDescEs(e.target.value)}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.add.slug')}
          </label>
          <input type="text" value={slug} maxLength={80}
                 onChange={e => setSlug(e.target.value)}
                 placeholder={nameEn ? nameEn.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : 'annual-report'}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
            {t('owner.services.add.slugHint')}
          </p>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.add.category')}
          </label>
          <select value={category} onChange={e => setCategory(e.target.value)}
                  style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="tax_prep">{t('owner.services.category.tax_prep')}</option>
            <option value="recurring">{t('owner.services.category.recurring')}</option>
            <option value="one_off">{t('owner.services.category.one_off')}</option>
          </select>
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.services.add.create')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={() => { setOpen(false); reset(); }}
                style={{ color: 'var(--tax-text)' }}>
          {t('owner.services.cancel')}
        </button>
      </div>
    </form>
  );
}

function ServiceRow({ product: p, auth, community, relTypes, employees = [], onChange, locale, t }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const name = pickI18n(p.name_i18n, locale).value || p.slug;
  const desc = pickI18n(p.description_i18n, locale).value;
  const longDesc = pickI18n(p.long_description_i18n, locale).value;
  const reqs = Array.isArray(p.required_documents) ? p.required_documents : [];

  const toggleEnabled = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminUpdateProduct(auth, p.id, { enabled: !p.enabled });
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onDelete = async () => {
    // First attempt is a plain delete. The server refuses with 409 +
    // `usage` counts when active subscriptions reference the service;
    // we surface those numbers to the owner and require a second
    // confirm before re-trying with force=1.
    if (!window.confirm(t('owner.services.deleteConfirm', { name }))) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminDeleteProduct(auth, p.id);
      onChange();
      return;
    } catch (e) {
      const u = e?.body?.usage;
      if (e?.body?.error === 'product_in_use' && u) {
        const proceed = window.confirm(t('owner.services.deleteForceConfirm', {
          name, subs: u.active_subscriptions || 0,
          schedules: u.filing_schedules || 0,
        }));
        if (!proceed) {
          setErr(t('owner.services.deleteCancelled'));
          setBusy(false);
          return;
        }
        try {
          await taxApi.adminDeleteProduct(auth, p.id, { force: true });
          onChange();
          return;
        } catch (e2) {
          setErr(e2?.message || '');
        }
      } else {
        setErr(e?.message || '');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {name}
            <span style={{
              marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }}>{p.category}</span>
            {!p.enabled && (
              <span style={{
                marginLeft: 6, padding: '1px 8px', borderRadius: 999,
                background: '#fee2e2', color: '#991b1b',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
              }}>{t('owner.services.hidden')}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
            {t('owner.services.slug')}: {p.slug} • {t('owner.services.displayOrder')}: {p.display_order}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {!editing && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={() => setEditing(true)} style={{ color: 'var(--tax-text)' }}>
              {t('owner.services.edit')}
            </button>
          )}
          {!editing && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={toggleEnabled} disabled={busy}
                    style={{ color: 'var(--tax-muted)' }}>
              {p.enabled ? t('owner.services.hide') : t('owner.services.show')}
            </button>
          )}
          {!editing && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onDelete} disabled={busy}
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.services.delete')}
            </button>
          )}
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error" style={{ marginTop: 8 }}>{err}</div>}

      {editing ? (
        <ProductEditor product={p} auth={auth}
                       community={community} relTypes={relTypes}
                       employees={employees}
                       onDone={() => { setEditing(false); onChange(); }}
                       onCancel={() => setEditing(false)} t={t} />
      ) : (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--tax-muted)',
                      whiteSpace: 'pre-wrap' }}>
          <div>{desc || <em>{t('owner.services.descMissing')}</em>}</div>
          {longDesc && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <strong style={{ color: 'var(--tax-text)' }}>{t('owner.services.longLabel')}:</strong>{' '}
              {longDesc.length > 200 ? `${longDesc.slice(0, 200)}…` : longDesc}
            </div>
          )}
          {reqs.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <strong style={{ color: 'var(--tax-text)' }}>{t('owner.services.requiresLabel')}:</strong>{' '}
              {reqs.length} {t('owner.services.requiresItems')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProductEditor({ product: p, auth, community, relTypes = [], employees = [], onDone, onCancel, t }) {
  const [nameEn, setNameEn] = useState(p.name_i18n?.en || '');
  const [nameEs, setNameEs] = useState(p.name_i18n?.es || '');
  const [descEn, setDescEn] = useState(p.description_i18n?.en || '');
  const [descEs, setDescEs] = useState(p.description_i18n?.es || '');
  const [longEn, setLongEn] = useState(p.long_description_i18n?.en || '');
  const [longEs, setLongEs] = useState(p.long_description_i18n?.es || '');
  const initialReqs = Array.isArray(p.required_documents) ? p.required_documents : [];
  const [reqs, setReqs] = useState(() => initialReqs.map(d => (
    typeof d === 'string' ? { en: d, es: '' } : { en: d.en || '', es: d.es || '' }
  )));
  const [order, setOrder] = useState(String(p.display_order || 0));
  const [videoUrl, setVideoUrl] = useState(p.video_url || '');

  // Phase 4n.46: Internal section. A service owns a list of
  // auto-tasks instead of a single cadence — each auto-task is its
  // own generation unit (monthly reconciliation + quarterly P&L +
  // annual close = three auto-tasks on the Bookkeeping service).
  // List is loaded from the server on mount; the form maintains a
  // local working copy and the bulk-replace PUT pushes the diff on
  // Save.
  const [autoTasks, setAutoTasks] = useState([]);
  const [autoTasksLoaded, setAutoTasksLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    taxApi.adminListAutoTasks(auth, p.id)
      .then(d => { if (!cancelled) { setAutoTasks((d.autoTasks || []).map(at => normalizeAutoTaskForEdit(at))); setAutoTasksLoaded(true); } })
      .catch(() => { if (!cancelled) setAutoTasksLoaded(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const updateReq = (i, lang, v) =>
    setReqs(prev => prev.map((r, idx) => idx === i ? { ...r, [lang]: v } : r));
  const addReq = () => setReqs(prev => [...prev, { en: '', es: '' }]);
  const removeReq = (i) => setReqs(prev => prev.filter((_, idx) => idx !== i));

  const addAutoTask = () => setAutoTasks(prev => [...prev, {
    id: null,
    titleEn: '', titleEs: '',
    descriptionEn: '', descriptionEs: '',
    cadenceKind: 'monthly',
    day: '15', weekday: '1', month: '1',
    defaultPriority: 'normal',
    defaultAssigneeEmployeeId: '',
  }]);
  const updateAutoTask = (idx, patch) =>
    setAutoTasks(prev => prev.map((at, i) => i === idx ? { ...at, ...patch } : at));
  const removeAutoTask = (idx) =>
    setAutoTasks(prev => prev.filter((_, i) => i !== idx));

  const onSave = async () => {
    setBusy(true); setErr('');
    try {
      const cleanedReqs = reqs
        .map(r => ({ en: r.en.trim(), es: r.es.trim() }))
        .filter(r => r.en || r.es);
      await taxApi.adminUpdateProduct(auth, p.id, {
        nameI18n: { en: nameEn.trim(), es: nameEs.trim() },
        descriptionI18n: { en: descEn.trim(), es: descEs.trim() },
        longDescriptionI18n: { en: longEn.trim(), es: longEs.trim() },
        requiredDocuments: cleanedReqs,
        displayOrder: Number(order) || 0,
        videoUrl: videoUrl.trim(),
        // Phase 4n.46: the product-level cadence + employee_notes
        // fields are no longer authored from the editor. Server
        // keeps the columns for legacy fallback when a service has
        // no auto-tasks yet.
      });

      // Bulk-replace the auto-tasks list. The server diffs against
      // the existing rows — updates, inserts, deletes accordingly.
      await taxApi.adminReplaceAutoTasks(auth, p.id, autoTasks.map((at, i) => ({
        id: at.id || undefined,
        titleI18n: { en: at.titleEn.trim(), es: at.titleEs.trim() },
        descriptionI18n: { en: at.descriptionEn.trim(), es: at.descriptionEs.trim() },
        cadenceKind: at.cadenceKind,
        anchorRule: buildAnchorRuleFromForm(at),
        defaultPriority: at.defaultPriority,
        defaultAssigneeEmployeeId: at.defaultAssigneeEmployeeId || null,
        displayOrder: (i + 1) * 10,
        active: true,
      })));

      onDone();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 12, padding: 12, background: 'var(--tax-bg-alt)',
                  borderRadius: 8, display: 'grid', gap: 12 }}>
      <SectionHeader emoji="🏠" label={t('owner.services.section.homepage')}
                     hint={t('owner.services.section.homepageHint')} />
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.nameEn')}</label>
          <input type="text" value={nameEn} onChange={e => setNameEn(e.target.value)} maxLength={200}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.nameEs')}</label>
          <input type="text" value={nameEs} onChange={e => setNameEs(e.target.value)} maxLength={200}
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>

      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.descEn')}</label>
          <textarea rows={2} value={descEn} onChange={e => setDescEn(e.target.value)} maxLength={400}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.descEs')}</label>
          <textarea rows={2} value={descEs} onChange={e => setDescEs(e.target.value)} maxLength={400}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>

      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.longEn')}</label>
          <textarea rows={6} value={longEn} onChange={e => setLongEn(e.target.value)} maxLength={4000}
                    placeholder={t('owner.services.longPlaceholder')}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.services.longEs')}</label>
          <textarea rows={6} value={longEs} onChange={e => setLongEs(e.target.value)} maxLength={4000}
                    placeholder={t('owner.services.longPlaceholder')}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
          {t('owner.services.requiresLabel')}
        </label>
        <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
          {reqs.map((r, i) => (
            <div key={i} className="tax-form__row2" style={{ alignItems: 'center', gap: 8 }}>
              <input type="text" value={r.en} onChange={e => updateReq(i, 'en', e.target.value)}
                     placeholder="English" maxLength={200}
                     style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="text" value={r.es} onChange={e => updateReq(i, 'es', e.target.value)}
                       placeholder="Español" maxLength={200}
                       style={{ flex: 1, padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
                <button type="button" onClick={() => removeReq(i)}
                        style={{ border: 0, background: 'transparent', color: 'var(--tax-error)', cursor: 'pointer', fontSize: 18 }}>
                  ×
                </button>
              </div>
            </div>
          ))}
          <button type="button" onClick={addReq}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-brand-primary)', justifySelf: 'start' }}>
            + {t('owner.services.requiresAdd')}
          </button>
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
          {t('owner.services.videoUrl')}
        </label>
        <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
               placeholder="https://youtube.com/watch?v=… or https://vimeo.com/…"
               maxLength={500}
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
          {t('owner.services.videoUrlHint')}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.services.displayOrder')}:&nbsp;
          <input type="number" value={order} onChange={e => setOrder(e.target.value)} min="0" max="10000"
                 style={{ width: 80, padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 4 }} />
        </label>
      </div>

      <SectionHeader emoji="🛠" label={t('owner.services.section.internal')}
                     hint={t('owner.services.section.internalHint')} tone="internal" />

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{t('owner.services.autoTasks.heading')}</div>
            <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
              {t('owner.services.autoTasks.subheading')}
            </div>
          </div>
          <button type="button" onClick={addAutoTask}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
            + {t('owner.services.autoTasks.add')}
          </button>
        </div>
        {!autoTasksLoaded ? <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{t('loading')}</p>
          : autoTasks.length === 0
            ? <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{t('owner.services.autoTasks.empty')}</p>
            : <div style={{ display: 'grid', gap: 10 }}>
                {autoTasks.map((at, i) => (
                  <AutoTaskEditor key={at.id || `new-${i}`} value={at} index={i}
                                  serviceName={nameEn || nameEs || p.slug}
                                  employees={employees}
                                  onChange={patch => updateAutoTask(i, patch)}
                                  onRemove={() => removeAutoTask(i)}
                                  t={t} />
                ))}
              </div>}
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={onSave} disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.services.save')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('owner.services.cancel')}
        </button>
      </div>
    </div>
  );
}

// Small banner heading that delineates the Homepage section (public
// marketing copy) from the Internal section (cadence, relationship
// tag, employee notes — only visible inside the staff portal).
function SectionHeader({ emoji, label, hint, tone = 'homepage' }) {
  // Two visual tones — homepage = blue (public marketing surface),
  // internal = amber (operational surface). The contrast makes it
  // impossible to confuse which audience an edit affects.
  const palette = tone === 'internal'
    ? { bg: 'color-mix(in srgb, #d97706 14%, #fff)',
        bar: '#d97706',
        tag: { bg: '#fed7aa', fg: '#7c2d12' },
        tagLabel: 'STAFF PORTAL' }
    : { bg: 'color-mix(in srgb, #2563eb 12%, #fff)',
        bar: '#2563eb',
        tag: { bg: '#dbeafe', fg: '#1e3a8a' },
        tagLabel: 'PUBLIC SITE' };
  return (
    <div style={{
      marginTop: 10, padding: '10px 14px', borderRadius: 8,
      background: palette.bg,
      borderLeft: `4px solid ${palette.bar}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{emoji} {label}</span>
        <span style={{
          padding: '1px 8px', borderRadius: 999,
          background: palette.tag.bg, color: palette.tag.fg,
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em',
        }}>{palette.tagLabel}</span>
      </div>
      {hint && <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// Concrete preview of what tasks the generator will create for a
// customer tagged with this service's relationship. Recomputes on
// every cadence/day change so the owner sees the impact of their
// edits before saving.
//
// We show the next 6 dates derived from the current anchor_rule;
// the actual generator's look-ahead is the community's

// Map a server auto-task row to the editor's working shape (separate
// fields for cadence inputs that conditional renders read from).
function normalizeAutoTaskForEdit(row) {
  const a = row.anchor_rule && typeof row.anchor_rule === 'object' ? row.anchor_rule : {};
  return {
    id: row.id || null,
    titleEn: row.title_i18n?.en || '',
    titleEs: row.title_i18n?.es || '',
    descriptionEn: row.description_i18n?.en || '',
    descriptionEs: row.description_i18n?.es || '',
    cadenceKind: row.cadence_kind || 'monthly',
    day:     String(a.day ?? 15),
    weekday: String(a.weekday ?? 1),
    month:   String(a.month ?? 1),
    defaultPriority: row.default_priority || 'normal',
    defaultAssigneeEmployeeId: row.default_assignee_employee_id || '',
  };
}

// Reverse of normalizeAutoTaskForEdit — produce the anchor_rule
// shape the generator (schedulePeriods.generatePeriods) expects.
function buildAnchorRuleFromForm(at) {
  if (at.cadenceKind === 'monthly')   return { type: 'monthly_following',   day: Number(at.day) || 15 };
  if (at.cadenceKind === 'quarterly') return { type: 'quarterly_following', day: Number(at.day) || 15 };
  if (at.cadenceKind === 'weekly')    return { type: 'weekly_following',    weekday: Number(at.weekday) || 1 };
  if (at.cadenceKind === 'annual')    return { type: 'annual',
                                                month: Number(at.month) || 1, day: Number(at.day) || 15 };
  return {};
}

// One row in the auto-tasks list. Inline title + cadence config +
// live preview of the next 3 due dates. Designed to stack — owner
// can add many.
function AutoTaskEditor({ value: at, index, serviceName, employees = [], onChange, onRemove, t }) {
  // Default: collapsed for existing rows (so a service with many
  // auto-tasks scans like a list), expanded for new ones the owner
  // just clicked + Add for.
  const [expanded, setExpanded] = useState(!at.id);

  const preview = useMemo(() => {
    if (!at.cadenceKind || at.cadenceKind === 'none') return [];
    try { return generatePeriods(buildAnchorRuleFromForm(at), new Date(), 3); }
    catch { return []; }
  }, [at.cadenceKind, at.day, at.weekday, at.month]);

  const titleLive = at.titleEn || at.titleEs || `${t('owner.services.autoTasks.untitled')} #${index + 1}`;

  // Single-line cadence summary for the collapsed header — e.g.
  // "Monthly · day 15", "Annual · Jan 15", "Weekly · Monday".
  const WEEKDAYS = [
    t('owner.services.weekday.sun', { _: 'Sun' }),
    t('owner.services.weekday.mon'),
    t('owner.services.weekday.tue'),
    t('owner.services.weekday.wed'),
    t('owner.services.weekday.thu'),
    t('owner.services.weekday.fri'),
    t('owner.services.weekday.sat', { _: 'Sat' }),
  ];
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let cadenceSummary = '';
  if (at.cadenceKind === 'weekly') {
    cadenceSummary = `${t('owner.services.cadence.weekly')} · ${WEEKDAYS[Number(at.weekday) || 1]}`;
  } else if (at.cadenceKind === 'monthly') {
    cadenceSummary = `${t('owner.services.cadence.monthly')} · ${t('owner.services.cadence.dayLabel')} ${at.day}`;
  } else if (at.cadenceKind === 'quarterly') {
    cadenceSummary = `${t('owner.services.cadence.quarterly')} · ${t('owner.services.cadence.dayLabel')} ${at.day}`;
  } else if (at.cadenceKind === 'annual') {
    const m = MONTHS_SHORT[(Number(at.month) || 1) - 1] || '';
    cadenceSummary = `${t('owner.services.cadence.annual')} · ${m} ${at.day}`;
  } else {
    cadenceSummary = t('owner.services.cadence.none');
  }

  return (
    <div style={{
      padding: expanded ? 12 : '8px 12px', borderRadius: 8,
      background: '#fff', border: '1px solid var(--tax-border)',
      display: 'grid', gap: expanded ? 10 : 0,
    }}>
      <button type="button"
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, padding: 0, border: 0, background: 'transparent',
                cursor: 'pointer', textAlign: 'left', width: '100%',
              }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span aria-hidden="true" style={{
            color: 'var(--tax-muted)', fontSize: 11,
            transition: 'transform .12s ease',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}>▶</span>
          <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {titleLive}
          </span>
          <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
            · {cadenceSummary}
            {at.defaultPriority && at.defaultPriority !== 'normal'
              ? ` · ${t(`owner.tasks.priority.${at.defaultPriority}`)}`
              : ''}
          </span>
        </div>
        <span onClick={(e) => { e.stopPropagation(); onRemove(); }}
              role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemove(); } }}
              style={{ color: 'var(--tax-error)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          × {t('owner.services.autoTasks.remove')}
        </span>
      </button>

      {expanded && (
      <>

      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.autoTasks.titleEn')}
          </label>
          <input type="text" value={at.titleEn} maxLength={200}
                 onChange={e => onChange({ titleEn: e.target.value })}
                 placeholder="e.g. Monthly reconciliation"
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.autoTasks.titleEs')}
          </label>
          <input type="text" value={at.titleEs} maxLength={200}
                 onChange={e => onChange({ titleEs: e.target.value })}
                 placeholder="p. ej. Conciliación mensual"
                 style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      </div>

      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.cadence')}
          </label>
          <select value={at.cadenceKind} onChange={e => onChange({ cadenceKind: e.target.value })}
                  style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="weekly">{t('owner.services.cadence.weekly')}</option>
            <option value="monthly">{t('owner.services.cadence.monthly')}</option>
            <option value="quarterly">{t('owner.services.cadence.quarterly')}</option>
            <option value="annual">{t('owner.services.cadence.annual')}</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.autoTasks.priority')}
          </label>
          <select value={at.defaultPriority} onChange={e => onChange({ defaultPriority: e.target.value })}
                  style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="low">{t('owner.tasks.priority.low')}</option>
            <option value="normal">{t('owner.tasks.priority.normal')}</option>
            <option value="high">{t('owner.tasks.priority.high')}</option>
            <option value="urgent">{t('owner.tasks.priority.urgent')}</option>
          </select>
        </div>
      </div>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
          {t('owner.services.autoTasks.defaultAssignee')}
        </label>
        <select value={at.defaultAssigneeEmployeeId || ''}
                onChange={e => onChange({ defaultAssigneeEmployeeId: e.target.value })}
                style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
          <option value="">{t('owner.services.autoTasks.defaultAssigneeNone')}</option>
          {employees.map(em => (
            <option key={em.id} value={em.id}>
              {[em.first_name, em.last_name].filter(Boolean).join(' ').trim() || em.name || em.email}
            </option>
          ))}
        </select>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
          {t('owner.services.autoTasks.defaultAssigneeHint')}
        </p>
      </div>

      {at.cadenceKind === 'weekly' && (
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.cadence.weekdayLabel')}
          </label>
          <select value={at.weekday} onChange={e => onChange({ weekday: e.target.value })}
                  style={{ padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="1">{t('owner.services.weekday.mon')}</option>
            <option value="2">{t('owner.services.weekday.tue')}</option>
            <option value="3">{t('owner.services.weekday.wed')}</option>
            <option value="4">{t('owner.services.weekday.thu')}</option>
            <option value="5">{t('owner.services.weekday.fri')}</option>
          </select>
        </div>
      )}
      {(at.cadenceKind === 'monthly' || at.cadenceKind === 'quarterly') && (
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.cadence.dayLabel')}
          </label>
          <input type="number" min="1" max="28" value={at.day}
                 onChange={e => onChange({ day: e.target.value })}
                 style={{ width: 100, padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
      )}
      {at.cadenceKind === 'annual' && (
        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.services.cadence.monthLabel')}
            </label>
            <input type="number" min="1" max="12" value={at.month}
                   onChange={e => onChange({ month: e.target.value })}
                   style={{ width: 100, padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.services.cadence.dayLabel')}
            </label>
            <input type="number" min="1" max="28" value={at.day}
                   onChange={e => onChange({ day: e.target.value })}
                   style={{ width: 100, padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
        </div>
      )}

      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.autoTasks.notesEn')}
          </label>
          <textarea rows={2} value={at.descriptionEn} maxLength={4000}
                    onChange={e => onChange({ descriptionEn: e.target.value })}
                    placeholder={t('owner.services.autoTasks.notesPlaceholder')}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.services.autoTasks.notesEs')}
          </label>
          <textarea rows={2} value={at.descriptionEs} maxLength={4000}
                    onChange={e => onChange({ descriptionEs: e.target.value })}
                    placeholder={t('owner.services.autoTasks.notesPlaceholder')}
                    style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
        </div>
      </div>

      {preview.length > 0 && (
        <div style={{
          padding: '8px 10px', borderRadius: 6,
          background: 'color-mix(in srgb, #d97706 8%, #fff)',
          fontSize: 12,
        }}>
          <div style={{ color: 'var(--tax-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            {t('owner.services.autoTasks.previewTitle')}
          </div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {preview.map((p, i) => (
              <li key={i}>
                <strong>{p.dueDate}</strong>
                <span style={{ color: 'var(--tax-muted)' }}>
                  {' — '}{titleLive}{p.periodLabel ? ` (${p.periodLabel})` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      </>
      )}
    </div>
  );
}
