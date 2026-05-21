import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Phase 4k: manage the catalog of relationship-type services for this
// community. Two sources mixed in the list:
//   • Platform defaults (community_id IS NULL) — shown as read-only with a
//     badge. Owner can't rename or disable; they're shared across all
//     communities.
//   • Community-scoped services (community_id = this slug) — fully editable:
//     rename, edit description, change display order, toggle active.
// New rows always land in the community-scoped bucket.
const CATEGORIES = ['business', 'individual', 'general', 'audit'];
const CATEGORY_ORDER = CATEGORIES;

function groupByCategory(types) {
  const buckets = new Map();
  for (const t of types) {
    const c = t.category || 'other';
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(t);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  }
  const known = CATEGORY_ORDER.filter(c => buckets.has(c));
  const extras = Array.from(buckets.keys())
    .filter(c => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extras].map(c => ({ category: c, types: buckets.get(c) }));
}

const BLANK_NEW = {
  category: 'business', slug: '',
  nameEn: '', nameEs: '', descriptionEn: '', descriptionEs: '',
  displayOrder: 500,
};

export default function OwnerRelationshipTypes() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [types, setTypes] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Add-new form
  const [adding, setAdding] = useState(false);
  const [newForm, setNewForm] = useState(BLANK_NEW);
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState({ kind: 'idle', text: '' });

  // Per-row edit state. Keyed by relationship type id.
  const [edit, setEdit] = useState({});       // id → { nameEn, nameEs, ... }
  const [editBusy, setEditBusy] = useState({});
  const [editMsg, setEditMsg] = useState({});

  const load = () => {
    if (!employee || !community) return;
    setLoading(true); setErr('');
    taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id, includeInactive: true })
      .then(d => setTypes(d.types || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')))
      .finally(() => setLoading(false));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => groupByCategory(types), [types]);

  const onCreate = async (e) => {
    e.preventDefault();
    if (!newForm.slug.trim() || (!newForm.nameEn.trim() && !newForm.nameEs.trim())) {
      setAddMsg({ kind: 'error', text: t('owner.services.errFields') }); return;
    }
    setAddBusy(true); setAddMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminCreateRelationshipType(auth, {
        communitySlug: community.id,
        category: newForm.category,
        slug: newForm.slug.trim(),
        nameEn: newForm.nameEn.trim(),
        nameEs: newForm.nameEs.trim(),
        descriptionEn: newForm.descriptionEn.trim(),
        descriptionEs: newForm.descriptionEs.trim(),
        displayOrder: newForm.displayOrder,
      });
      setAddMsg({ kind: 'success', text: t('owner.services.created') });
      setNewForm(BLANK_NEW);
      setAdding(false);
      load();
    } catch (e2) {
      setAddMsg({ kind: 'error', text: e2?.message || t('respond.error.generic') });
    } finally { setAddBusy(false); }
  };

  const startEdit = (tp) => {
    setEdit(prev => ({
      ...prev,
      [tp.id]: {
        nameEn: tp.name_i18n?.en || '',
        nameEs: tp.name_i18n?.es || '',
        descriptionEn: tp.description_i18n?.en || '',
        descriptionEs: tp.description_i18n?.es || '',
        displayOrder: tp.display_order || 0,
      },
    }));
  };
  const cancelEdit = (id) => {
    setEdit(prev => { const n = { ...prev }; delete n[id]; return n; });
    setEditMsg(prev => { const n = { ...prev }; delete n[id]; return n; });
  };
  const saveEdit = async (id) => {
    const f = edit[id]; if (!f) return;
    setEditBusy(p => ({ ...p, [id]: true }));
    setEditMsg(p => ({ ...p, [id]: { kind: 'idle', text: '' } }));
    try {
      await taxApi.adminUpdateRelationshipType(auth, id, {
        communitySlug: community.id,
        nameEn: f.nameEn, nameEs: f.nameEs,
        descriptionEn: f.descriptionEn, descriptionEs: f.descriptionEs,
        displayOrder: f.displayOrder,
      });
      setEditMsg(p => ({ ...p, [id]: { kind: 'success', text: t('owner.services.saved') } }));
      cancelEdit(id);
      load();
    } catch (e) {
      setEditMsg(p => ({ ...p, [id]: { kind: 'error', text: e?.message || t('respond.error.generic') } }));
    } finally { setEditBusy(p => ({ ...p, [id]: false })); }
  };
  const toggleActive = async (tp) => {
    setEditBusy(p => ({ ...p, [tp.id]: true }));
    try {
      await taxApi.adminUpdateRelationshipType(auth, tp.id, {
        communitySlug: community.id,
        active: !tp.active,
      });
      load();
    } catch (e) {
      setEditMsg(p => ({ ...p, [tp.id]: { kind: 'error', text: e?.message || t('respond.error.generic') } }));
    } finally { setEditBusy(p => ({ ...p, [tp.id]: false })); }
  };

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community} active="services">
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="services">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('owner.services.title')}</h2>
        <a href={community ? `/tax/${community.id}/employee/workflows` : '#'}
           className="tax-btn tax-btn--ghost tax-btn--sm" style={{ color: 'var(--tax-text)' }}>
          {t('owner.services.openWorkflows')}
        </a>
      </div>
      <p className="tax-section__lede">{t('owner.services.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {loading && <p>{t('loading')}</p>}

      {/* Add new */}
      <div style={{ marginBottom: 24 }}>
        {!adding && (
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" onClick={() => setAdding(true)}>
            + {t('owner.services.addBtn')}
          </button>
        )}
        {adding && (
          <form className="tax-form" onSubmit={onCreate} noValidate
                style={{ display: 'grid', gap: 12, padding: 16, border: '1px solid var(--tax-border)', borderRadius: 8 }}>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="svc-cat">{t('owner.services.category')}</label>
                <select id="svc-cat" value={newForm.category}
                        onChange={e => setNewForm(p => ({ ...p, category: e.target.value }))}>
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{t(`owner.customers.category.${c}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="svc-slug">{t('owner.services.slug')}</label>
                <input id="svc-slug" type="text" required maxLength={80}
                       placeholder="bookkeeping_monthly"
                       value={newForm.slug}
                       onChange={e => setNewForm(p => ({ ...p, slug: e.target.value }))} />
              </div>
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="svc-name-en">{t('owner.services.nameEn')}</label>
                <input id="svc-name-en" type="text" maxLength={200}
                       value={newForm.nameEn}
                       onChange={e => setNewForm(p => ({ ...p, nameEn: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="svc-name-es">{t('owner.services.nameEs')}</label>
                <input id="svc-name-es" type="text" maxLength={200}
                       value={newForm.nameEs}
                       onChange={e => setNewForm(p => ({ ...p, nameEs: e.target.value }))} />
              </div>
            </div>
            <div className="tax-form__row2">
              <div>
                <label htmlFor="svc-desc-en">{t('owner.services.descriptionEn')}</label>
                <input id="svc-desc-en" type="text" maxLength={1000}
                       value={newForm.descriptionEn}
                       onChange={e => setNewForm(p => ({ ...p, descriptionEn: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="svc-desc-es">{t('owner.services.descriptionEs')}</label>
                <input id="svc-desc-es" type="text" maxLength={1000}
                       value={newForm.descriptionEs}
                       onChange={e => setNewForm(p => ({ ...p, descriptionEs: e.target.value }))} />
              </div>
            </div>
            <div>
              <label htmlFor="svc-order">{t('owner.services.displayOrder')}</label>
              <input id="svc-order" type="number" min={0} max={9999} style={{ width: 120 }}
                     value={newForm.displayOrder}
                     onChange={e => setNewForm(p => ({ ...p, displayOrder: Number(e.target.value) || 0 }))} />
            </div>
            {addMsg.text && (
              <div className={`tax-msg tax-msg--${addMsg.kind === 'error' ? 'error' : 'success'}`}>{addMsg.text}</div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="tax-btn tax-btn--primary" disabled={addBusy}>
                {addBusy ? t('lead.submitting') : t('owner.services.createBtn')}
              </button>
              <button type="button" className="tax-btn tax-btn--ghost"
                      onClick={() => { setAdding(false); setNewForm(BLANK_NEW); setAddMsg({ kind: 'idle', text: '' }); }}>
                {t('owner.services.cancel')}
              </button>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('owner.services.hint')}
            </p>
          </form>
        )}
      </div>

      {/* Existing types, grouped */}
      <div style={{ display: 'grid', gap: 20 }}>
        {grouped.map(({ category, types: catTypes }) => (
          <div key={category}>
            <div style={{
              fontSize: 12, fontWeight: 700, color: 'var(--tax-muted)',
              textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8,
            }}>
              {t(`owner.customers.category.${category}`, { _: category })}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {catTypes.map(tp => {
                const isCommunityScoped = tp.community_id === community?.id;
                const isEditing = !!edit[tp.id];
                const ef = edit[tp.id];
                const mk = editMsg[tp.id];
                return (
                  <div key={tp.id} style={{
                    padding: 12, border: '1px solid var(--tax-border)', borderRadius: 8,
                    background: tp.active ? 'var(--tax-bg)' : 'var(--tax-bg-alt)',
                    opacity: tp.active ? 1 : 0.7,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong>{pickI18n(tp.name_i18n, locale).value || tp.slug}</strong>
                          {!isCommunityScoped && (
                            <span style={{
                              padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                              background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
                            }}>{t('owner.services.platformBadge')}</span>
                          )}
                          {!tp.active && (
                            <span style={{
                              padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                              background: '#fee', color: '#a00',
                            }}>{t('owner.services.disabledBadge')}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                          <code>{tp.id}</code> · {t('owner.services.orderShort')} {tp.display_order || 0}
                        </div>
                        {(tp.description_i18n?.en || tp.description_i18n?.es) && !isEditing && (
                          <div style={{ fontSize: 13, color: 'var(--tax-text)', marginTop: 6 }}>
                            {pickI18n(tp.description_i18n, locale).value}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        {isCommunityScoped && !isEditing && (
                          <>
                            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                                    onClick={() => startEdit(tp)} style={{ color: 'var(--tax-text)' }}>
                              {t('owner.services.edit')}
                            </button>
                            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                                    onClick={() => toggleActive(tp)} disabled={!!editBusy[tp.id]}
                                    style={{ color: tp.active ? '#a00' : 'var(--tax-brand-primary)' }}>
                              {tp.active ? t('owner.services.disable') : t('owner.services.enable')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                        <div className="tax-form__row2">
                          <div>
                            <label>{t('owner.services.nameEn')}</label>
                            <input type="text" value={ef.nameEn} maxLength={200}
                                   onChange={e => setEdit(p => ({ ...p, [tp.id]: { ...ef, nameEn: e.target.value } }))} />
                          </div>
                          <div>
                            <label>{t('owner.services.nameEs')}</label>
                            <input type="text" value={ef.nameEs} maxLength={200}
                                   onChange={e => setEdit(p => ({ ...p, [tp.id]: { ...ef, nameEs: e.target.value } }))} />
                          </div>
                        </div>
                        <div className="tax-form__row2">
                          <div>
                            <label>{t('owner.services.descriptionEn')}</label>
                            <input type="text" value={ef.descriptionEn} maxLength={1000}
                                   onChange={e => setEdit(p => ({ ...p, [tp.id]: { ...ef, descriptionEn: e.target.value } }))} />
                          </div>
                          <div>
                            <label>{t('owner.services.descriptionEs')}</label>
                            <input type="text" value={ef.descriptionEs} maxLength={1000}
                                   onChange={e => setEdit(p => ({ ...p, [tp.id]: { ...ef, descriptionEs: e.target.value } }))} />
                          </div>
                        </div>
                        <div>
                          <label>{t('owner.services.displayOrder')}</label>
                          <input type="number" min={0} max={9999} style={{ width: 120 }}
                                 value={ef.displayOrder}
                                 onChange={e => setEdit(p => ({ ...p, [tp.id]: { ...ef, displayOrder: Number(e.target.value) || 0 } }))} />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                                  disabled={!!editBusy[tp.id]} onClick={() => saveEdit(tp.id)}>
                            {editBusy[tp.id] ? t('lead.submitting') : t('owner.services.saveBtn')}
                          </button>
                          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                                  onClick={() => cancelEdit(tp.id)}>
                            {t('owner.services.cancel')}
                          </button>
                        </div>
                      </div>
                    )}

                    {mk?.text && (
                      <div className={`tax-msg tax-msg--${mk.kind === 'error' ? 'error' : 'success'}`} style={{ marginTop: 8 }}>
                        {mk.text}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </EmployeeShell>
  );
}
