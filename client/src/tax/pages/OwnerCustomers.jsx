import { useEffect, useMemo, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { formatLastSignInCompact } from '../lib/lastSignIn';
import { displayPersonName } from '../lib/personName';

// Category display order — surface business / individual first since most
// customers are tagged with one of those. The relationship types themselves
// already carry display_order, used as a tiebreak inside each category.
const CATEGORY_ORDER = ['business', 'individual', 'general', 'audit'];

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

// Customer browser. Surfaced inside the staff portal at
// /tax/{slug}/employee/customers and visible to BOTH admin and staff
// employees:
//   admin → uses adminListCustomers (whole community)
//   staff → uses listEmployeeCustomers (scoped to assigned customers)
//
// Search + filter behavior is identical for both roles. Admin-only
// surfaces (Add / Import) are gated by role.
//
// Search runs server-side via the q + relationshipTypeIds params on
// the underlying endpoint. The frontend debounces input changes by
// 300ms before refetching to keep typing responsive.
export default function OwnerCustomers() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isAdmin = employee?.role === 'admin';

  const [customers, setCustomers] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');                 // debounced value
  const [relationshipFilter, setRelationshipFilter] = useState([]); // array of type ids
  const [allTypes, setAllTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Add-customer form state (admin only; staff sees no Add UI)
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState({
    customerType: 'individual',
    businessName: '',
    firstName: '', middleName: '', lastName: '',
    email: '', phone: '', locale: 'es',
    relationshipTypeIds: [],
    sendWelcomeEmail: true,                       // default behavior per owner spec
  });
  const [busyAdd, setBusyAdd] = useState(false);
  const [addMsg, setAddMsg] = useState({ kind: 'idle', text: '' });

  // Debounce the search input so we don't refetch on every keystroke.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  const load = () => {
    if (!fbUser || !community) return;
    setLoading(true); setErr('');
    const opts = { q: search, relationshipTypeIds: relationshipFilter };
    const p = isAdmin
      ? taxApi.adminListCustomers(auth, community.id, opts)
      : taxApi.listEmployeeCustomers(auth, opts);
    p.then(d => setCustomers(d.customers || []))
     .catch(e => setErr(e?.message || t('error.loadFailed')))
     .finally(() => setLoading(false));
  };
  useEffect(load, [fbUser, community, search, relationshipFilter, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load relationship-type catalog once for the chip filter. Both admin
  // and staff need it; the endpoint sits behind requireOwnerAdmin so staff
  // would 403. Wrap in try/catch so a 403 doesn't blow up the page —
  // staff just won't see the chip filter (search still works fine).
  useEffect(() => {
    if (!fbUser || !community) return;
    taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id })
      .then(d => setAllTypes(d.types || []))
      .catch(() => setAllTypes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  const groupedTypes = useMemo(() => groupByCategory(allTypes), [allTypes]);

  // Collapsible "Filter by service" section. Default = collapsed if no
  // filter is active, expanded once a chip is picked. Persists across
  // reloads so a user who likes the chips visible keeps them visible.
  const [serviceFilterOpen, setServiceFilterOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('tax.customers.serviceFilterOpen');
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch { /* ignore */ }
    return false;
  });
  useEffect(() => {
    try { localStorage.setItem('tax.customers.serviceFilterOpen', serviceFilterOpen ? '1' : '0'); }
    catch { /* ignore */ }
  }, [serviceFilterOpen]);
  // Auto-open the section the first time a chip is selected, so the
  // user always sees the active filter.
  useEffect(() => {
    if (relationshipFilter.length > 0) setServiceFilterOpen(true);
  }, [relationshipFilter.length]);

  const toggleRelationshipFilter = (typeId) =>
    setRelationshipFilter(prev =>
      prev.includes(typeId) ? prev.filter(id => id !== typeId) : [...prev, typeId]);

  // Sort controls. Default = last name ascending (the common phone-book
  // ordering owners expect when scanning a customer roster). Owner can
  // flip to first-name sort, and reverse direction either way. Choice
  // persists in localStorage so the next visit honors their preference.
  const [sortBy, setSortBy] = useState(() => {
    try {
      const s = localStorage.getItem('tax.customers.sortBy');
      if (s === 'firstName' || s === 'lastName') return s;
    } catch { /* ignore */ }
    return 'lastName';
  });
  const [sortDir, setSortDir] = useState(() => {
    try {
      const s = localStorage.getItem('tax.customers.sortDir');
      if (s === 'asc' || s === 'desc') return s;
    } catch { /* ignore */ }
    return 'asc';
  });
  useEffect(() => {
    try { localStorage.setItem('tax.customers.sortBy', sortBy); }
    catch { /* ignore */ }
  }, [sortBy]);
  useEffect(() => {
    try { localStorage.setItem('tax.customers.sortDir', sortDir); }
    catch { /* ignore */ }
  }, [sortDir]);

  // Alphabetic letter grouping. The letter we bucket by follows the
  // current sort key — sort by last name → group by first letter of
  // last name; sort by first name → group by first letter of first
  // name. Search dissolves the grouping (flat results scan faster).
  const [collapsedLetters, setCollapsedLetters] = useState(() => new Set());
  const toggleLetter = (letter) => setCollapsedLetters(prev => {
    const next = new Set(prev);
    if (next.has(letter)) next.delete(letter); else next.add(letter);
    return next;
  });
  // Reset collapse state when the sort key flips so a customer who was
  // hiding under "Z" by last name doesn't end up hidden under a stale
  // letter when they switch to first-name sort.
  useEffect(() => { setCollapsedLetters(new Set()); }, [sortBy]);

  // The string we sort + bucket by, per customer. Falls through to
  // whichever name part is populated, and finally to the email so
  // freshly-imported rows with no name parts still slot in somewhere
  // visible instead of disappearing into a "—" group.
  const sortKeyOf = (c) => {
    const primary = sortBy === 'firstName'
      ? (c.first_name || c.last_name || c.name || c.email || '')
      : (c.last_name  || c.first_name || c.name || c.email || '');
    return String(primary).trim().toLowerCase();
  };
  const bucketLetterOf = (c) => {
    const first = sortKeyOf(c).charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
  };

  // Sort + group the customers list. Search active → flat results,
  // group headers off (the customer hunting for a name doesn't need
  // to expand "M" to find Maria).
  const grouping = useMemo(() => {
    const rows = (customers || []).slice();
    rows.sort((a, b) => {
      const cmp = sortKeyOf(a).localeCompare(sortKeyOf(b));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    if (search) return { mode: 'flat', rows };
    const map = new Map();
    for (const c of rows) {
      const l = bucketLetterOf(c);
      if (!map.has(l)) map.set(l, []);
      map.get(l).push(c);
    }
    // # (digits / symbols) always sorts after letters, regardless of
    // direction, to keep the natural alphabetical look.
    const sections = Array.from(map.entries())
      .sort(([a], [b]) => {
        if (a === '#') return 1;
        if (b === '#') return -1;
        return sortDir === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
      })
      .map(([letter, rows]) => ({ letter, rows }));
    return { mode: 'grouped', sections };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, sortBy, sortDir, search]);

  const onAdd = async (e) => {
    e.preventDefault();
    if (!form.email.trim()) { setAddMsg({ kind: 'error', text: t('owner.customers.errEmailRequired') }); return; }
    setBusyAdd(true); setAddMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminCreateCustomer(auth, {
        communitySlug: community.id,
        email: form.email.trim().toLowerCase(),
        customerType: form.customerType,
        businessName: form.customerType === 'business' ? form.businessName.trim() : '',
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim(),
        locale: form.locale,
        relationshipTypeIds: form.relationshipTypeIds,
        sendWelcomeEmail: form.sendWelcomeEmail,
      });
      // Successful create. The welcome-email send is best-effort on the
      // server; we just trust the response for the redirect. The detail
      // page can re-send manually if needed.
      setAddMsg({ kind: 'success', text: t('owner.customers.addedSuccess') });
      setForm({ customerType: 'individual', businessName: '',
                firstName: '', middleName: '', lastName: '',
                email: '', phone: '', locale: 'es',
                relationshipTypeIds: [], sendWelcomeEmail: true });
      window.location.href = `/tax/${community.id}/employee/customers/${encodeURIComponent(r.id)}`;
    } catch (err) {
      setAddMsg({ kind: 'error', text: err?.message || t('respond.error.generic') });
    } finally {
      setBusyAdd(false);
    }
  };

  const toggleRelOnForm = (typeId) =>
    setForm(prev => ({
      ...prev,
      relationshipTypeIds: prev.relationshipTypeIds.includes(typeId)
        ? prev.relationshipTypeIds.filter(id => id !== typeId)
        : [...prev.relationshipTypeIds, typeId],
    }));

  const base = community ? `/tax/${community.id}/employee/customers` : '#';

  return (
    <EmployeeShell community={community} active="customers">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('owner.customers.title')}</h2>
        {/* Admin-only actions. Staff sees the list + search/filter but no
            create or import controls — they manage relationships through
            the customer detail page (admin-only) or via the inbox flow. */}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={() => { setImporting(im => !im); setAdding(false); }}
                    style={{ color: 'var(--tax-text)' }}>
              {importing ? t('owner.customers.cancelImport') : t('owner.customers.importBtn')}
            </button>
            <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                    onClick={() => { setAdding(a => !a); setImporting(false); }}>
              {adding ? t('owner.customers.cancelAdd') : t('owner.customers.addBtn')}
            </button>
          </div>
        )}
      </div>
      <p className="tax-section__lede">
        {isAdmin ? t('owner.customers.subtitle') : t('owner.customers.subtitleStaff')}
      </p>

      {isAdmin && importing && (
        <ImportCustomers auth={auth} community={community}
                         onDone={() => { setImporting(false); load(); }}
                         t={t} />
      )}

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {isAdmin && adding && (
        <form className="tax-form" onSubmit={onAdd} noValidate style={{ marginBottom: 24 }}>
          {/* Individual vs Business toggle. Business unlocks the
              required Business name field and tags the customer row
              with the "Business" pill so the owner can later filter
              / scan by type. */}
          <div role="radiogroup" aria-label={t('owner.customers.fieldCustomerType')}
               style={{ display: 'flex', gap: 8 }}>
            {['individual', 'business'].map(opt => {
              const active = form.customerType === opt;
              return (
                <button key={opt} type="button"
                        role="radio" aria-checked={active}
                        onClick={() => setForm(p => ({ ...p, customerType: opt }))}
                        style={{
                          flex: '1 1 auto', padding: '10px 14px', borderRadius: 8,
                          background: active
                            ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                            : '#fff',
                          color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                          border: '1px solid',
                          borderColor: active
                            ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                            : 'var(--tax-border)',
                          fontSize: 14, fontWeight: active ? 700 : 500,
                          cursor: 'pointer', textAlign: 'center',
                        }}>
                  {active ? '✓ ' : ''}{t(`owner.customers.customerType.${opt}`)}
                </button>
              );
            })}
          </div>
          {form.customerType === 'business' && (
            <div>
              <label htmlFor="oc-biz">{t('owner.customers.fieldBusinessName')}</label>
              <input id="oc-biz" type="text"
                     required autoComplete="organization"
                     value={form.businessName}
                     onChange={e => setForm(p => ({ ...p, businessName: e.target.value }))}
                     maxLength={200} />
            </div>
          )}
          <div className="tax-form__row3">
            <div>
              <label htmlFor="oc-first">{t('owner.customers.fieldFirstName')}</label>
              <input id="oc-first" type="text" value={form.firstName}
                     onChange={e => setForm(p => ({ ...p, firstName: e.target.value }))} maxLength={80} />
            </div>
            <div>
              <label htmlFor="oc-middle">{t('owner.customers.fieldMiddleName')}</label>
              <input id="oc-middle" type="text" value={form.middleName}
                     onChange={e => setForm(p => ({ ...p, middleName: e.target.value }))} maxLength={80} />
            </div>
            <div>
              <label htmlFor="oc-last">{t('owner.customers.fieldLastName')}</label>
              <input id="oc-last" type="text" value={form.lastName}
                     onChange={e => setForm(p => ({ ...p, lastName: e.target.value }))} maxLength={80} />
            </div>
          </div>
          <div className="tax-form__row2">
            <div>
              <label htmlFor="oc-email">{t('owner.customers.fieldEmail')} *</label>
              <input id="oc-email" type="email" required value={form.email}
                     onChange={e => setForm(p => ({ ...p, email: e.target.value }))} maxLength={200} />
            </div>
            <div>
              <label htmlFor="oc-phone-row">{t('owner.customers.fieldPhone')}</label>
              <input id="oc-phone-row" type="tel" value={form.phone}
                     onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} maxLength={40} />
            </div>
          </div>
          <div>
            <label htmlFor="oc-locale">{t('owner.customers.fieldLocale')}</label>
            <select id="oc-locale" value={form.locale}
                    onChange={e => setForm(p => ({ ...p, locale: e.target.value }))}>
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </div>

          {/* Service relationships — chip picker over the 13 relationship
              types. Selected chips drive both the customer's portal-side
              FAQ/help filtering and (when the welcome email is enabled)
              the bulleted service list in the welcome email body. */}
          {allTypes.length > 0 && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'block' }}>
                {t('owner.customers.fieldRelationships')}
              </label>
              <p style={{ fontSize: 12, color: 'var(--tax-muted)', margin: '0 0 8px' }}>
                {t('owner.customers.fieldRelationshipsHint')}
              </p>
              <div style={{ display: 'grid', gap: 10 }}>
                {groupedTypes.map(({ category, types }) => (
                  <div key={category}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                      textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4,
                    }}>
                      {t(`owner.customers.category.${category}`, { _: category })}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {types.map(tp => {
                        const active = form.relationshipTypeIds.includes(tp.id);
                        return (
                          <button key={tp.id} type="button" onClick={() => toggleRelOnForm(tp.id)}
                                  style={{
                                    padding: '4px 10px', borderRadius: 999,
                                    background: active
                                      ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                                      : '#fff',
                                    color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                                    border: '1px solid',
                                    borderColor: active
                                      ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                                      : 'var(--tax-border)',
                                    fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer',
                                  }}>
                            {pickI18n(tp.name_i18n, locale).value || tp.slug}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Welcome-email checkbox. Default on per owner spec. The email
              body summarizes the selected relationships and is rendered
              in the customer's locale (es/en above). */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
            padding: '10px 12px', background: 'var(--tax-bg-alt)', borderRadius: 8,
          }}>
            <input type="checkbox" checked={form.sendWelcomeEmail}
                   onChange={e => setForm(p => ({ ...p, sendWelcomeEmail: e.target.checked }))}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('owner.customers.sendWelcome')}</div>
              <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                {t('owner.customers.sendWelcomeHint')}
              </div>
            </div>
          </label>

          {addMsg.text && (
            <div className={`tax-msg tax-msg--${addMsg.kind === 'error' ? 'error' : 'success'}`}>{addMsg.text}</div>
          )}
          <button type="submit" className="tax-btn tax-btn--primary" disabled={busyAdd}>
            {busyAdd ? t('lead.submitting') : t('owner.customers.createBtn')}
          </button>
        </form>
      )}

      <div style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t('owner.customers.searchPlaceholder')}
               value={searchInput} onChange={e => setSearchInput(e.target.value)}
               style={{
                 width: '100%', padding: '10px 12px',
                 border: '1px solid var(--tax-border)', borderRadius: 8, fontSize: 15,
               }} />
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4 }}>
          {t('owner.customers.searchHint')}
        </div>
      </div>

      {allTypes.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button type="button"
                  onClick={() => setServiceFilterOpen(o => !o)}
                  aria-expanded={serviceFilterOpen}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
                    fontSize: 12, fontWeight: 700, color: 'var(--tax-muted)',
                    textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6,
                  }}>
            <span style={{
              display: 'inline-block', transition: 'transform .15s ease',
              transform: serviceFilterOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              fontSize: 10,
            }}>▶</span>
            <span>{t('owner.customers.filterRelationships')}</span>
            {relationshipFilter.length > 0 && (
              <span style={{
                padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                color: 'var(--tax-brand-primary)',
                border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)',
              }}>{relationshipFilter.length}</span>
            )}
            {relationshipFilter.length > 0 && (
              <span role="button" tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); setRelationshipFilter([]); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation(); e.preventDefault(); setRelationshipFilter([]);
                      }
                    }}
                    style={{
                      marginLeft: 'auto',
                      color: 'var(--tax-brand-primary)', cursor: 'pointer',
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                    }}>
                {t('owner.customers.clearFilters')}
              </span>
            )}
          </button>
          {serviceFilterOpen && (
          <div style={{ display: 'grid', gap: 10 }}>
            {groupedTypes.map(({ category, types }) => (
              <div key={category}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                  textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4,
                }}>
                  {t(`owner.customers.category.${category}`, { _: category })}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {types.map(tp => {
                    const active = relationshipFilter.includes(tp.id);
                    return (
                      <button key={tp.id} type="button"
                              onClick={() => toggleRelationshipFilter(tp.id)}
                              style={{
                                padding: '4px 10px', borderRadius: 999,
                                background: active
                                  ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                                  : '#fff',
                                color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                                border: '1px solid',
                                borderColor: active
                                  ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                                  : 'var(--tax-border)',
                                fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer',
                              }}>
                        {pickI18n(tp.name_i18n, locale).value || tp.slug}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          )}
        </div>
      )}

      {customers === null || (loading && !customers) ? <p>{t('loading')}</p>
        : customers.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>
              {search || relationshipFilter.length > 0
                ? t('owner.customers.noMatch')
                : t('owner.customers.empty')}
            </p>
          : <>
              <CustomerSortBar sortBy={sortBy} setSortBy={setSortBy}
                               sortDir={sortDir} setSortDir={setSortDir}
                               grouping={grouping} t={t}
                               onCollapseAll={() =>
                                 grouping.mode === 'grouped' &&
                                 setCollapsedLetters(new Set(grouping.sections.map(s => s.letter)))}
                               onExpandAll={() => setCollapsedLetters(new Set())} />
              <div style={{ display: 'grid', gap: 14, opacity: loading ? 0.6 : 1 }}>
                {grouping.mode === 'flat'
                  ? grouping.rows.map(c =>
                      <CustomerRow key={c.id} c={c} base={base} locale={locale} t={t} />)
                  : grouping.sections.map(({ letter, rows }) => {
                      const collapsed = collapsedLetters.has(letter);
                      return (
                        <div key={letter} style={{ display: 'grid', gap: 6 }}>
                          <button type="button"
                                  onClick={() => toggleLetter(letter)}
                                  aria-expanded={!collapsed}
                                  style={{
                                    position: 'sticky', top: 0, zIndex: 1,
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    width: '100%', textAlign: 'left',
                                    padding: '4px 0', border: 0,
                                    background: 'rgba(255,255,255,.96)', cursor: 'pointer',
                                    fontSize: 12, fontWeight: 700, color: 'var(--tax-muted)',
                                    letterSpacing: '.5px',
                                  }}>
                            <span style={{
                              display: 'inline-block', transition: 'transform .15s ease',
                              transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                              fontSize: 10,
                            }}>▶</span>
                            <span>{letter}</span>
                            <span style={{ color: 'var(--tax-muted)', fontWeight: 500 }}>
                              ({rows.length})
                            </span>
                          </button>
                          {!collapsed && rows.map(c =>
                            <CustomerRow key={c.id} c={c} base={base} locale={locale} t={t} />
                          )}
                        </div>
                      );
                    })}
              </div>
            </>}
    </EmployeeShell>
  );
}

// One row of the customer list, used by both the flat (search-results)
// path and the grouped-by-letter path. Kept identical to the prior
// inline markup so existing visual + interaction patterns survive.
function CustomerRow({ c, base, locale, t }) {
  return (
    <a href={`${base}/${encodeURIComponent(c.id)}`}
       className="tax-contact-item" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {displayPersonName(c) || c.email}
            {c.customer_type === 'business' && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                color: 'var(--tax-brand-primary)',
                border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 30%, #fff)',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
              }}>{t('owner.customers.customerType.business')}</span>
            )}
            <HealthChip health={c.health} t={t} />
          </div>
          {c.business_name && (
            <div style={{ fontSize: 13, color: 'var(--tax-text)', fontWeight: 500, marginTop: 2 }}>
              {c.business_name}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
            {c.email}
            {c.phone ? ` • ${c.phone}` : ''}
            {c.whatsapp ? ` • WhatsApp ${c.whatsapp}` : ''}
          </div>
          {(c.address?.line1 || c.address?.city) && (
            <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
              {[c.address.line1, c.address.city, c.address.state].filter(Boolean).join(', ')}
            </div>
          )}
          {Array.isArray(c.relationships) && c.relationships.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {c.relationships.map(r => (
                <span key={r.relationship_type_id} style={{
                  padding: '1px 8px', borderRadius: 999,
                  background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
                  color: 'var(--tax-brand-primary)',
                  border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 18%, #fff)',
                  fontSize: 11, fontWeight: 600,
                }}>
                  {pickI18n(r.type?.name_i18n, locale).value || r.relationship_type_id}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--tax-muted)', textAlign: 'right' }}>
          <div>{c.locale === 'en' ? 'EN' : 'ES'}</div>
          <div style={{ marginTop: 2, color: c.last_sign_in_at ? 'var(--tax-muted)' : '#b91c1c' }}>
            {formatLastSignInCompact(c.last_sign_in_at, locale, t)}
          </div>
        </div>
      </div>
    </a>
  );
}

// Sort + collapse controls above the customer list. Two segmented
// pills (Last name / First name) drive both the sort key and the
// alphabet grouping bucket; the arrow toggles direction. Collapse /
// Expand All only render in grouped mode (search dissolves grouping).
function CustomerSortBar({ sortBy, setSortBy, sortDir, setSortDir, grouping, t, onCollapseAll, onExpandAll }) {
  const Pill = ({ value, label }) => {
    const active = sortBy === value;
    return (
      <button type="button" onClick={() => setSortBy(value)}
              style={{
                padding: '4px 12px', borderRadius: 999, fontSize: 12,
                cursor: 'pointer',
                background: active
                  ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                  : '#fff',
                color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                border: '1px solid',
                borderColor: active
                  ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                  : 'var(--tax-border)',
                fontWeight: active ? 700 : 500,
              }}>{label}</button>
    );
  };
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
      marginBottom: 10,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                     textTransform: 'uppercase', letterSpacing: '.5px', marginRight: 4 }}>
        {t('owner.customers.sort.label')}
      </span>
      <Pill value="lastName"  label={t('owner.customers.sort.lastName')} />
      <Pill value="firstName" label={t('owner.customers.sort.firstName')} />
      <button type="button"
              onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
              title={sortDir === 'asc' ? t('owner.customers.sort.asc') : t('owner.customers.sort.desc')}
              style={{
                padding: '4px 10px', borderRadius: 999, fontSize: 12,
                background: '#fff', border: '1px solid var(--tax-border)',
                color: 'var(--tax-text)', cursor: 'pointer',
              }}>
        {sortDir === 'asc' ? '↓ A–Z' : '↑ Z–A'}
      </button>
      {grouping.mode === 'grouped' && grouping.sections.length > 1 && (
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          <button type="button" onClick={onCollapseAll}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    color: 'var(--tax-brand-primary)', fontSize: 11,
                    fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  }}>{t('owner.customers.sort.collapseAll')}</button>
          <button type="button" onClick={onExpandAll}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    color: 'var(--tax-brand-primary)', fontSize: 11,
                    fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  }}>{t('owner.customers.sort.expandAll')}</button>
        </div>
      )}
    </div>
  );
}

// CSV import dialog. Two-step UX:
//   1. Template download — generated client-side so no static asset deploy
//      is needed. Header row + 2 example rows + a comment row explaining
//      the relationship-tag format. Excel/Sheets/Numbers all open it.
//   2. Upload — owner pastes CSV or picks a file. Server parses, validates
//      per-row, returns { created, skipped, errors[] }. The dialog
//      displays the summary inline so the owner can fix problem rows and
//      re-upload (existing customers are skipped on re-run).
//
// Insert-only — duplicate emails report as 'skipped' rather than
// overwriting. To update existing customers, use the customer detail
// edit form (Phase 4d).
function ImportCustomers({ auth, community, onDone, t }) {
  const [csvText, setCsvText] = useState('');
  const [mode, setMode] = useState('skip');       // 'skip' | 'update'
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  // The template is a static asset at /tax-customer-import-template.csv
  // — accessible without authentication, so admins can share the URL
  // directly with new practice owners during onboarding (no need to
  // log them in just to grab the template). The file lives in
  // client/public/ and includes inline `#` comment rows that the
  // server-side parser silently skips, so an owner can leave the docs
  // in place without breaking the import.
  const TEMPLATE_URL = '/tax-customer-import-template.csv';
  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${TEMPLATE_URL}`
    : TEMPLATE_URL;

  const [copyMsg, setCopyMsg] = useState('');
  const copyTemplateUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyMsg(t('owner.customers.import.copyOk'));
      setTimeout(() => setCopyMsg(''), 2000);
    } catch (_e) {
      // Fallback for older browsers: select the URL in an input the
      // owner can manually copy. Cheap UX — surface the URL as plain
      // text alongside the button so it's always selectable too.
      setCopyMsg(t('owner.customers.import.copyManual'));
    }
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.onerror = () => setErr(t('owner.customers.import.errFileRead'));
    reader.readAsText(f, 'utf-8');
  };

  const onSubmit = async () => {
    if (!csvText.trim()) { setErr(t('owner.customers.import.errEmpty')); return; }
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await taxApi.adminImportCustomers(auth, {
        communitySlug: community.id, csv: csvText, mode,
      });
      setResult(r);
    } catch (e) {
      setErr(e?.message || t('respond.error.generic'));
    } finally { setBusy(false); }
  };

  // Bucket the per-row notices returned by the server. Hard errors block
  // the row entirely; warnings mean the row was created/updated with a
  // caveat; skippedRows comes back as a structured array in mode='skip'.
  const hardErrors = (result?.errors || []).filter(e => !e.warning);
  const warnings   = (result?.errors || []).filter(e => e.warning);
  const skippedRows = result?.skippedRows || [];

  return (
    <form className="tax-form" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
          style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 600 }}>{t('owner.customers.import.title')}</div>
      <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 8px' }}>
        {t('owner.customers.import.subtitle')}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <a href={TEMPLATE_URL} download className="tax-btn tax-btn--ghost tax-btn--sm"
           style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
          {t('owner.customers.import.downloadTemplate')}
        </a>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={copyTemplateUrl}
                style={{ color: 'var(--tax-text)' }}>
          {t('owner.customers.import.copyUrl')}
        </button>
        <label className="tax-btn tax-btn--ghost tax-btn--sm"
               style={{ color: 'var(--tax-text)', cursor: 'pointer' }}>
          {t('owner.customers.import.pickFile')}
          <input type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} onChange={onFile} />
        </label>
      </div>
      {/* Always-visible shareable URL — so owners can copy by hand when
          clipboard access isn't available (older browsers, locked-down
          mobile, etc.) */}
      <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 4 }}>
        {t('owner.customers.import.shareUrlHint')}&nbsp;
        <a href={TEMPLATE_URL} target="_blank" rel="noopener noreferrer"
           style={{ color: 'var(--tax-brand-primary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {shareUrl}
        </a>
        {copyMsg && <span style={{ marginLeft: 8, color: 'var(--tax-success)' }}>{copyMsg}</span>}
      </div>

      {/* Phase: mode picker — controls what happens when a row's email
          already exists in this community. Skip is the safe default
          (idempotent re-runs); Update enables bulk profile refresh from
          a regenerated spreadsheet. */}
      <fieldset style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 12, margin: '8px 0 0' }}>
        <legend style={{ padding: '0 6px', fontSize: 12, fontWeight: 700, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
          {t('owner.customers.import.mode.title')}
        </legend>
        <label style={{ display: 'flex', gap: 8, padding: '8px 4px', cursor: 'pointer', borderRadius: 6 }}>
          <input type="radio" name="import-mode" value="skip"
                 checked={mode === 'skip'} onChange={() => setMode('skip')} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('owner.customers.import.mode.skip')}</div>
            <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('owner.customers.import.mode.skipHint')}</div>
          </div>
        </label>
        <label style={{ display: 'flex', gap: 8, padding: '8px 4px', cursor: 'pointer', borderRadius: 6 }}>
          <input type="radio" name="import-mode" value="update"
                 checked={mode === 'update'} onChange={() => setMode('update')} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('owner.customers.import.mode.update')}</div>
            <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('owner.customers.import.mode.updateHint')}</div>
          </div>
        </label>
      </fieldset>

      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)', marginTop: 8, display: 'block' }}>
          {t('owner.customers.import.csvLabel')}
        </label>
        <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
                  rows={10}
                  placeholder={t('owner.customers.import.csvPlaceholder')}
                  style={{
                    width: '100%', padding: 10, border: '1px solid var(--tax-border)',
                    borderRadius: 8, fontFamily: 'monospace', fontSize: 12,
                  }} />
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {result && (
        <div style={{ background: 'var(--tax-bg-alt)', padding: 12, borderRadius: 8, display: 'grid', gap: 8 }}>
          {/* Four-bucket summary stat strip. Each bucket renders as a
              colored chip so the owner can absorb the result at a glance. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            <SummaryCell label={t('owner.customers.import.bucket.created')}
                         value={result.created || 0}
                         color="#166534" bg="#dcfce7" />
            <SummaryCell label={t('owner.customers.import.bucket.updated')}
                         value={result.updated || 0}
                         color="#1d4ed8" bg="#dbeafe" />
            <SummaryCell label={t('owner.customers.import.bucket.skipped')}
                         value={result.skipped || 0}
                         color="#6b7280" bg="#f3f4f6" />
            <SummaryCell label={t('owner.customers.import.bucket.errors')}
                         value={hardErrors.length}
                         color="#b91c1c" bg="#fee2e2" />
            {warnings.length > 0 && (
              <SummaryCell label={t('owner.customers.import.bucket.warnings')}
                           value={warnings.length}
                           color="#92400e" bg="#fef3c7" />
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.customers.import.summaryMode', {
              mode: result.mode === 'update'
                ? t('owner.customers.import.mode.update')
                : t('owner.customers.import.mode.skip'),
            })}
          </div>
          {hardErrors.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tax-error)', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                {t('owner.customers.import.errors')}
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 13 }}>
                {hardErrors.map((e, i) => (
                  <li key={i}>
                    {t('owner.customers.import.row', { row: e.row })}: <code>{e.email || '—'}</code> — {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#a65b00', textTransform: 'uppercase', letterSpacing: '.5px' }}>
                {t('owner.customers.import.warnings')}
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 13 }}>
                {warnings.map((e, i) => (
                  <li key={i}>
                    {t('owner.customers.import.row', { row: e.row })}: <code>{e.email}</code> — {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {skippedRows.length > 0 && (
            <details>
              <summary style={{ fontSize: 12, fontWeight: 700, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.5px', cursor: 'pointer' }}>
                {t('owner.customers.import.skipped', { count: skippedRows.length })}
              </summary>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20, fontSize: 12 }}>
                {skippedRows.map((e, i) => (
                  <li key={i}><code>{e.email}</code></li>
                ))}
              </ul>
            </details>
          )}
          {result.created > 0 && (
            <div>
              <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                      onClick={onDone}>
                {t('owner.customers.import.done')}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy || !csvText.trim()}>
          {busy ? t('lead.submitting') : t('owner.customers.import.upload')}
        </button>
      </div>
    </form>
  );
}

// Color-pill stat cell used in the import result strip. Centered number on
// top, uppercase label below — same shape as the platform-dashboard cells.
function SummaryCell({ label, value, color, bg }) {
  return (
    <div style={{ background: bg, color, padding: '8px 10px', borderRadius: 6, textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
    </div>
  );
}

// Small at-a-glance task-health indicator for the customer list.
// Green = all caught up, amber = 1-2 overdue, red = 3+ overdue, blue
// = no overdue but in-progress work. Hidden when there are no open
// tasks at all (treat as quiescent — same as green but visually
// uncluttered).
function HealthChip({ health, t }) {
  const h = health || {};
  const overdue = Number(h.overdue) || 0;
  const open = Number(h.open) || 0;
  if (!open) return null;

  let bg = '#dcfce7', fg = '#166534', label = `${open} ${t('owner.customers.health.open')}`;
  if (overdue >= 3) {
    bg = '#fee2e2'; fg = '#991b1b';
    label = `${overdue} ${t('owner.customers.health.overdue')}`;
  } else if (overdue > 0) {
    bg = '#fef3c7'; fg = '#92400e';
    label = `${overdue} ${t('owner.customers.health.overdue')}`;
  } else if ((Number(h.in_progress) || 0) > 0) {
    bg = '#e0e7ff'; fg = '#3730a3';
    label = `${open} ${t('owner.customers.health.open')}`;
  }
  return (
    <span style={{
      marginLeft: 8, padding: '1px 8px', borderRadius: 999,
      background: bg, color: fg,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
      verticalAlign: 'middle',
    }}>{label}</span>
  );
}
