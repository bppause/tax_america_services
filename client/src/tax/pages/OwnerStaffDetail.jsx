import { useEffect, useMemo, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi, setImpersonation } from '../api';
import EmployeeShell from '../components/EmployeeShell';

import { formatLastSignIn } from '../lib/lastSignIn';
import { displayPersonName } from '../lib/personName';

// Category display order mirrors OwnerCustomers so the chip groups feel
// consistent between the customer browser and the assignment manager.
const CATEGORY_ORDER = ['business', 'individual', 'general', 'audit'];

function groupTypesByCategory(types) {
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

// First-letter bucket for alphabet grouping. Falls back to "#" for rows
// that don't start with a letter so digits/symbols don't get scattered.
function bucketLetter(name) {
  const first = (name || '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

// Owner-side view of a single employee. Profile is read-only (the employee
// edits their own profile via /employee/profile); the action surface here is
// the customer-assignment manager.
export default function OwnerStaffDetail({ employeeId }) {
  const { t, locale } = useT();
  const { fbUser, employee: me, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [employees, setEmployees] = useState(null);
  const [customers, setCustomers] = useState(null);
  const [assignments, setAssignments] = useState(null);
  const [err, setErr] = useState('');

  const loadEmployee = () => taxApi.adminListEmployees(auth, community.id)
    .then(d => setEmployees(d.employees || []))
    .catch(e => setErr(e?.message || t('error.loadFailed')));
  const loadCustomers = () => taxApi.adminListCustomers(auth, community.id)
    .then(d => setCustomers(d.customers || []))
    .catch(() => {});
  const loadAssignments = () => taxApi.adminListEmployeeAssignments(auth, employeeId)
    .then(d => setAssignments(d.assignments || []))
    .catch(() => {});

  useEffect(() => {
    if (!fbUser || !community) return;
    loadEmployee(); loadCustomers(); loadAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, employeeId]);

  if (me && me.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }
  if (err) return <EmployeeShell community={community} active="staff"><div className="tax-msg tax-msg--error">{err}</div></EmployeeShell>;

  const emp = (employees || []).find(e => e.id === employeeId);
  if (employees === null) return <EmployeeShell community={community} active="staff"><p>{t('loading')}</p></EmployeeShell>;
  if (!emp) return <EmployeeShell community={community} active="staff"><div className="tax-msg tax-msg--error">{t('owner.staff.notFound')}</div></EmployeeShell>;

  const back = community ? `/tax/${community.id}/employee/staff` : '#';

  return (
    <EmployeeShell community={community} active="staff">
      <a href={back} style={{ fontSize: 14, color: 'var(--tax-muted)' }}>← {t('owner.staff.back')}</a>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, marginBottom: 4 }}>
            {displayPersonName(emp) || emp.email}
            <span style={{
              marginLeft: 12, padding: '2px 10px', borderRadius: 999,
              background: emp.role === 'admin' ? 'var(--tax-brand-primary)' : 'var(--tax-bg-alt)',
              color: emp.role === 'admin' ? '#fff' : 'var(--tax-muted)',
              fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
              verticalAlign: 'middle',
            }}>{emp.role}</span>
          </h2>
          <p style={{ color: 'var(--tax-muted)', marginTop: 0, fontSize: 13 }}>
            {emp.email}
            {!emp.firebase_uid && <> • <em>{t('owner.staff.notSignedInHint')}</em></>}
            {' • '}{(emp.notification_channels || []).includes('email')
                    ? t('owner.staff.channelBoth') : t('owner.staff.channelPortal')}
            {' • '}{formatLastSignIn(emp.last_sign_in_at, locale, t)}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          {/* No self-impersonation — admin viewing their own row shouldn't try. */}
          {emp.id !== me?.id && emp.firebase_uid && emp.status === 'active' && (
            <ImpersonateEmployeeButton employee={emp} auth={auth} community={community} t={t} />
          )}
          {!emp.firebase_uid && emp.status === 'active' && (
            <DetailResendWelcomeButton emp={emp} auth={auth} t={t} />
          )}
          {emp.id !== me?.id && (
            <ArchiveEmployeeButton emp={emp} auth={auth} onChanged={loadEmployee} t={t} />
          )}
        </div>
      </div>

      {emp.status === 'archived' && (
        <div className="tax-msg" style={{
          background: 'color-mix(in srgb, #b91c1c 8%, #fff)',
          borderLeft: '3px solid #b91c1c', color: '#7f1d1d',
          padding: '10px 14px', marginTop: 12,
        }}>
          <strong>{t('owner.staffDetail.archivedBanner.title')}</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            {t('owner.staffDetail.archivedBanner.body')}
          </div>
        </div>
      )}

      {/* Permissions card — owner can revoke specific powers from this
          employee. Self-edit is blocked server-side for manage_employees
          so the owner can't accidentally lock themselves out. */}
      <PublicProfileCard emp={emp} auth={auth} onSaved={loadEmployee} t={t} />
      <PermissionsCard emp={emp} me={me} auth={auth} onSaved={loadEmployee} t={t} />

      <h3 style={{ marginTop: 32 }}>{t('owner.staffDetail.assignments')}</h3>
      {emp.role === 'admin' ? (
        <div className="tax-msg" style={{ background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
                                          color: 'var(--tax-text)', borderLeft: '3px solid var(--tax-brand-primary)' }}>
          <strong>{t('employee.profile.assignments.adminBanner')}</strong>
          <div style={{ marginTop: 4, color: 'var(--tax-muted)', fontSize: 13 }}>
            {t('owner.staffDetail.adminHint')}
          </div>
        </div>
      ) : (
        <AssignmentManager
          assignments={assignments} customers={customers}
          empId={employeeId} auth={auth}
          onChange={loadAssignments} t={t}
          locale={locale} community={community} />
      )}
    </EmployeeShell>
  );
}

// Unified assignment roster. One list of every customer in the community
// with an "Assigned" checkbox per row + a "Lead" toggle when assigned.
// Owner toggles multiple, sees the running count of pending changes, and
// saves all in one click.
//
// Browsing mirrors the OwnerCustomers page so the experience feels the
// same across the two screens: debounced search, relationship-type chip
// filter, and an "Assigned / Unassigned / All" status pill. When no
// search is active the rows are grouped alphabetically by first letter
// so long rosters scan quickly.
function AssignmentManager({ assignments, customers, empId, auth, onChange, t, locale, community }) {
  // Initial state derived from the server-side assignment list. We keep
  // these in refs-of-truth (initialAssigned / initialPrimary) so the diff
  // for Save is straightforward and a stale render doesn't cause spurious
  // POST/DELETEs.
  const initialAssigned = new Set((assignments || []).map(a => a.customer_id));
  const initialPrimary = new Map((assignments || []).map(a => [a.customer_id, !!a.is_primary]));

  const [assignedSet, setAssignedSet] = useState(() => new Set(initialAssigned));
  const [primaryMap, setPrimaryMap] = useState(() => new Map(initialPrimary));
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'assigned' | 'unassigned'
  const [relationshipFilter, setRelationshipFilter] = useState([]); // type ids
  const [allTypes, setAllTypes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Debounce search input the same way OwnerCustomers does so big rosters
  // don't restyle on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(searchInput.trim()), 200);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Load relationship-type catalog for the chip filter. Soft-fail: if
  // the admin gate 403s for any reason, just hide the chip row.
  useEffect(() => {
    if (!auth?.uid || !community?.id) return;
    taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id })
      .then(d => setAllTypes(d.types || []))
      .catch(() => setAllTypes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.uid, community?.id]);

  const groupedTypes = useMemo(() => groupTypesByCategory(allTypes), [allTypes]);

  // Collapsible "Filter by service" section. Default collapsed when no
  // chips are active; auto-opens once any chip is selected. Persists
  // across reloads.
  const [serviceFilterOpen, setServiceFilterOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('tax.staffDetail.serviceFilterOpen');
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch { /* ignore */ }
    return false;
  });
  useEffect(() => {
    try { localStorage.setItem('tax.staffDetail.serviceFilterOpen', serviceFilterOpen ? '1' : '0'); }
    catch { /* ignore */ }
  }, [serviceFilterOpen]);
  useEffect(() => {
    if (relationshipFilter.length > 0) setServiceFilterOpen(true);
  }, [relationshipFilter.length]);

  // Per-letter collapse state. Letters not in the map are treated as
  // expanded (the natural state for grouping). Master Collapse/Expand
  // sets every visible letter at once.
  const [collapsedLetters, setCollapsedLetters] = useState(() => new Set());
  const toggleLetter = (letter) => {
    setCollapsedLetters(prev => {
      const next = new Set(prev);
      if (next.has(letter)) next.delete(letter); else next.add(letter);
      return next;
    });
  };

  const toggleRelationshipFilter = (typeId) =>
    setRelationshipFilter(prev =>
      prev.includes(typeId) ? prev.filter(id => id !== typeId) : [...prev, typeId]);
  const clearFilters = () => {
    setRelationshipFilter([]); setStatusFilter('all'); setSearchInput('');
  };

  // Re-sync when the server-side assignments change (after a save).
  useEffect(() => {
    setAssignedSet(new Set((assignments || []).map(a => a.customer_id)));
    setPrimaryMap(new Map((assignments || []).map(a => [a.customer_id, !!a.is_primary])));
  }, [assignments]);

  // Compute pending diffs once per render.
  const toAdd = [];
  const toRemove = [];
  const toUpdatePrimary = [];
  for (const c of customers || []) {
    const wasAssigned = initialAssigned.has(c.id);
    const isAssigned  = assignedSet.has(c.id);
    if (!wasAssigned && isAssigned) toAdd.push({ id: c.id, isPrimary: !!primaryMap.get(c.id) });
    else if (wasAssigned && !isAssigned) toRemove.push(c.id);
    else if (wasAssigned && isAssigned) {
      const wasPrimary = !!initialPrimary.get(c.id);
      const isPrimary  = !!primaryMap.get(c.id);
      if (wasPrimary !== isPrimary) toUpdatePrimary.push({ id: c.id, isPrimary });
    }
  }
  const pendingCount = toAdd.length + toRemove.length + toUpdatePrimary.length;

  const onToggle = (cid) => {
    setAssignedSet(prev => {
      const next = new Set(prev);
      if (next.has(cid)) {
        next.delete(cid);
        // Lead flag is meaningless on an unassigned customer; clear it.
        setPrimaryMap(m => { const mm = new Map(m); mm.delete(cid); return mm; });
      } else {
        next.add(cid);
      }
      return next;
    });
  };
  const onPrimary = (cid, value) => {
    setPrimaryMap(prev => { const mm = new Map(prev); mm.set(cid, !!value); return mm; });
  };

  const onSave = async () => {
    if (!pendingCount) return;
    setBusy(true); setErr('');
    try {
      await Promise.all([
        ...toAdd.map(a => taxApi.adminAddEmployeeAssignment(auth, empId, {
          customerId: a.id, isPrimary: a.isPrimary,
        })),
        // The POST endpoint upserts on (employee_id, customer_id) so it
        // doubles as the "change is_primary" path.
        ...toUpdatePrimary.map(a => taxApi.adminAddEmployeeAssignment(auth, empId, {
          customerId: a.id, isPrimary: a.isPrimary,
        })),
        ...toRemove.map(cid => taxApi.adminRemoveEmployeeAssignment(auth, empId, cid)),
      ]);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  const onResetDraft = () => {
    setAssignedSet(new Set(initialAssigned));
    setPrimaryMap(new Map(initialPrimary));
  };

  const q = query.toLowerCase();
  const filtered = (customers || []).filter(c => {
    if (statusFilter === 'assigned' && !assignedSet.has(c.id)) return false;
    if (statusFilter === 'unassigned' && assignedSet.has(c.id)) return false;
    if (relationshipFilter.length) {
      const typeIds = new Set((c.relationships || []).map(r => r.relationship_type_id || r.type?.id));
      const hit = relationshipFilter.some(id => typeIds.has(id));
      if (!hit) return false;
    }
    if (q) {
      const hay = `${c.name || ''} ${c.email || ''} ${c.phone || ''} ${c.whatsapp || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort((a, b) =>
    (displayPersonName(a) || a.email || '').localeCompare(displayPersonName(b) || b.email || ''));

  // Group by first letter only when not searching — search results stay
  // flat so the rows the owner is hunting for aren't broken across
  // section headers. Status/relationship filters keep grouping.
  const sections = (() => {
    if (q) return [{ letter: null, rows: filtered }];
    const map = new Map();
    for (const c of filtered) {
      const l = bucketLetter(displayPersonName(c) || c.email);
      if (!map.has(l)) map.set(l, []);
      map.get(l).push(c);
    }
    // Skip grouping when everything falls under one letter — a single
    // header with the same content underneath looks like a bug.
    if (map.size <= 1) return [{ letter: null, rows: filtered }];
    return Array.from(map.entries())
      .sort(([a], [b]) => {
        if (a === '#') return 1;
        if (b === '#') return -1;
        return a.localeCompare(b);
      })
      .map(([letter, rows]) => ({ letter, rows }));
  })();

  const filtersActive = query || statusFilter !== 'all' || relationshipFilter.length;

  return (
    <>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        marginBottom: 10, flexWrap: 'wrap',
      }}>
        <input type="search" value={searchInput} onChange={e => setSearchInput(e.target.value)}
               placeholder={t('owner.staffDetail.searchPlaceholder')}
               style={{ flex: 1, minWidth: 240, padding: '8px 10px',
                        border: '1px solid var(--tax-border)', borderRadius: 8 }} />
        <span style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
          {t('owner.staffDetail.assignedCount', {
            assigned: assignedSet.size,
            total: (customers || []).length,
          })}
        </span>
      </div>

      {/* Status pill: All / Assigned / Unassigned. Mirrors the visual style
          of the relationship chips below so the two filter rows feel
          related. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {[
          { key: 'all', label: t('owner.staffDetail.filter.all') },
          { key: 'assigned', label: t('owner.staffDetail.filter.assigned') },
          { key: 'unassigned', label: t('owner.staffDetail.filter.unassigned') },
        ].map(opt => {
          const active = statusFilter === opt.key;
          return (
            <button key={opt.key} type="button"
                    onClick={() => setStatusFilter(opt.key)}
                    style={{
                      padding: '4px 12px', borderRadius: 999,
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
              {opt.label}
            </button>
          );
        })}
        {filtersActive && (
          <button type="button" onClick={clearFilters}
                  style={{
                    marginLeft: 4, border: 0, background: 'transparent',
                    color: 'var(--tax-brand-primary)', cursor: 'pointer',
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                  }}>
            {t('owner.customers.clearFilters')}
          </button>
        )}
      </div>

      {allTypes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <button type="button"
                  onClick={() => setServiceFilterOpen(o => !o)}
                  aria-expanded={serviceFilterOpen}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
                    fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
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
          </button>
          {serviceFilterOpen && (
          <div style={{ display: 'grid', gap: 8 }}>
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

      {/* Master Collapse/Expand all letter sections. Only relevant when
          the alphabet grouping is active (no search, enough rows). */}
      {(!q && sections.length > 1 && sections[0].letter) && (
        <div style={{
          display: 'flex', justifyContent: 'flex-end',
          marginBottom: 6, gap: 12,
        }}>
          <button type="button"
                  onClick={() => setCollapsedLetters(new Set(sections.map(s => s.letter)))}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    color: 'var(--tax-brand-primary)', fontSize: 11,
                    fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  }}>
            {t('owner.staffDetail.collapseAll')}
          </button>
          <button type="button"
                  onClick={() => setCollapsedLetters(new Set())}
                  style={{
                    border: 0, background: 'transparent', cursor: 'pointer',
                    color: 'var(--tax-brand-primary)', fontSize: 11,
                    fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  }}>
            {t('owner.staffDetail.expandAll')}
          </button>
        </div>
      )}

      {err && <div className="tax-msg tax-msg--error" style={{ marginBottom: 8 }}>{err}</div>}

      {(!customers || customers.length === 0) ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.staffDetail.noCustomers')}</p>
      ) : filtered.length === 0 ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.staffDetail.noMatch')}</p>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {sections.map(({ letter, rows }) => {
          const collapsed = letter && collapsedLetters.has(letter);
          return (
          <div key={letter || '_flat'} style={{ display: 'grid', gap: 6 }}>
            {letter && (
              <button type="button"
                      onClick={() => toggleLetter(letter)}
                      aria-expanded={!collapsed}
                      style={{
                        position: 'sticky', top: 0, zIndex: 1,
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', textAlign: 'left',
                        padding: '4px 0', border: 0,
                        background: 'rgba(255,255,255,.96)', cursor: 'pointer',
                        fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
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
            )}
            {!collapsed && rows.map(c => {
            const isAssigned = assignedSet.has(c.id);
            const wasAssigned = initialAssigned.has(c.id);
            const wasPrimary  = !!initialPrimary.get(c.id);
            const isPrimary   = !!primaryMap.get(c.id);
            const changed = (isAssigned !== wasAssigned)
                         || (isAssigned && wasAssigned && (isPrimary !== wasPrimary));
            return (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--tax-border)',
                background: changed ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
              }}>
                <input type="checkbox" checked={isAssigned} onChange={() => onToggle(c.id)} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{displayPersonName(c) || c.email}</div>
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{c.email}</div>
                </div>
                {wasAssigned && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                    background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
                  }}>{t('owner.staffDetail.alreadyAssigned')}</span>
                )}
                <label style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 13, opacity: isAssigned ? 1 : 0.4,
                }}>
                  <input type="checkbox" checked={isPrimary} disabled={!isAssigned}
                         onChange={e => onPrimary(c.id, e.target.checked)} />
                  {t('owner.staffDetail.markPrimary')}
                </label>
              </div>
            );
          })}
          </div>
          );
          })}
        </div>
      )}

      <div style={{
        position: 'sticky', bottom: 0,
        marginTop: 16, padding: '10px 12px',
        background: 'rgba(255,255,255,.96)', borderRadius: 10,
        border: '1px solid var(--tax-border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
          {pendingCount === 0
            ? t('owner.staffDetail.noPendingChanges')
            : t('owner.staffDetail.pendingChanges', {
                count: pendingCount,
                adds: toAdd.length,
                removes: toRemove.length,
                primaries: toUpdatePrimary.length,
              })}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {pendingCount > 0 && (
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={onResetDraft} disabled={busy}>
              {t('owner.staffDetail.discardChanges')}
            </button>
          )}
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                  onClick={onSave} disabled={!pendingCount || busy}>
            {busy ? t('lead.submitting') : t('owner.staffDetail.saveAssignments')}
          </button>
        </div>
      </div>
    </>
  );
}

// Permissions delegation card. Each registered permission key is shown
// with a toggle; on = granted (default), off = revoked. We start from
// the server's registry so adding a new key on the server surfaces it
// here without a frontend change.
// Public profile card. Lets the owner publish this employee on the
// landing page's "Meet the team" section with a photo, a short title,
// and a bilingual bio. Default visibility is OFF — the owner explicitly
// turns it on per employee so nobody is published by surprise.
function PublicProfileCard({ emp, auth, onSaved, t }) {
  const initial = () => ({
    showOnHomepage: !!emp.show_on_homepage,
    photoUrl: emp.photo_url || '',
    titleEn: emp.title_i18n?.en || '',
    titleEs: emp.title_i18n?.es || '',
    bioEn: emp.bio_i18n?.en || '',
    bioEs: emp.bio_i18n?.es || '',
    roleEn: emp.role_i18n?.en || '',
    roleEs: emp.role_i18n?.es || '',
    highlightsEn: emp.highlights_i18n?.en || '',
    highlightsEs: emp.highlights_i18n?.es || '',
    educationEn: emp.education_i18n?.en || '',
    educationEs: emp.education_i18n?.es || '',
    experienceEn: emp.experience_i18n?.en || '',
    experienceEs: emp.experience_i18n?.es || '',
    displayOrder: String(emp.homepage_display_order ?? 100),
  });
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial()); }, [emp]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const dirty = draft.showOnHomepage !== !!emp.show_on_homepage
             || draft.photoUrl !== (emp.photo_url || '')
             || draft.titleEn !== (emp.title_i18n?.en || '')
             || draft.titleEs !== (emp.title_i18n?.es || '')
             || draft.bioEn !== (emp.bio_i18n?.en || '')
             || draft.bioEs !== (emp.bio_i18n?.es || '')
             || draft.roleEn !== (emp.role_i18n?.en || '')
             || draft.roleEs !== (emp.role_i18n?.es || '')
             || draft.highlightsEn !== (emp.highlights_i18n?.en || '')
             || draft.highlightsEs !== (emp.highlights_i18n?.es || '')
             || draft.educationEn !== (emp.education_i18n?.en || '')
             || draft.educationEs !== (emp.education_i18n?.es || '')
             || draft.experienceEn !== (emp.experience_i18n?.en || '')
             || draft.experienceEs !== (emp.experience_i18n?.es || '')
             || Number(draft.displayOrder) !== (emp.homepage_display_order ?? 100);

  const set = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));

  const onSave = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetEmployeePublicProfile(auth, emp.id, {
        showOnHomepage: draft.showOnHomepage,
        photoUrl: draft.photoUrl.trim(),
        titleI18n: { en: draft.titleEn.trim(), es: draft.titleEs.trim() },
        bioI18n: { en: draft.bioEn.trim(), es: draft.bioEs.trim() },
        roleI18n: { en: draft.roleEn.trim(), es: draft.roleEs.trim() },
        highlightsI18n: { en: draft.highlightsEn.trim(), es: draft.highlightsEs.trim() },
        educationI18n: { en: draft.educationEn.trim(), es: draft.educationEs.trim() },
        experienceI18n: { en: draft.experienceEn.trim(), es: draft.experienceEs.trim() },
        displayOrder: Number(draft.displayOrder) || 100,
      });
      setMsg({ kind: 'success', text: t('owner.publicProfile.saved') });
      onSaved && onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || '' });
    } finally { setBusy(false); }
  };

  return (
    <section style={{ marginTop: 32 }}>
      <h3 style={{ margin: 0 }}>{t('owner.publicProfile.heading')}</h3>
      <p className="tax-section__lede" style={{ marginTop: 4, marginBottom: 12 }}>
        {t('owner.publicProfile.sub')}
      </p>

      <div style={{
        display: 'grid', gap: 12, maxWidth: 720,
        padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
        background: draft.showOnHomepage
          ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
      }}>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="checkbox" checked={draft.showOnHomepage}
                 onChange={e => set('showOnHomepage', e.target.checked)} disabled={busy} />
          <span style={{ fontWeight: 600 }}>{t('owner.publicProfile.showOnHomepage')}</span>
        </label>
        <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.publicProfile.showHint')}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 14, alignItems: 'start' }}>
          <div style={{
            width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
            background: 'var(--tax-bg-alt)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {draft.photoUrl
              ? <img src={draft.photoUrl} alt=""
                     style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                     onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              : <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
                  {t('owner.publicProfile.noPhoto')}
                </span>}
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.photoUrl')}
            </label>
            <input type="url" value={draft.photoUrl}
                   onChange={e => set('photoUrl', e.target.value)} disabled={busy}
                   maxLength={1000}
                   placeholder="https://… (paste a direct image link)"
                   style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.photoHint')}
            </p>
            <PhotoUploadButton emp={emp} auth={auth} disabled={busy} t={t}
                               onUploaded={(url) => set('photoUrl', url)} />
          </div>
        </div>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.titleEn')}
            </label>
            <input type="text" value={draft.titleEn} maxLength={200} disabled={busy}
                   onChange={e => set('titleEn', e.target.value)}
                   placeholder="e.g. Senior Tax Preparer"
                   style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.titleEs')}
            </label>
            <input type="text" value={draft.titleEs} maxLength={200} disabled={busy}
                   onChange={e => set('titleEs', e.target.value)}
                   placeholder="p. ej. Preparadora de Impuestos Senior"
                   style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
        </div>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.roleEn')}
            </label>
            <input type="text" value={draft.roleEn} maxLength={200} disabled={busy}
                   onChange={e => set('roleEn', e.target.value)}
                   placeholder={t('owner.publicProfile.rolePlaceholderEn')}
                   style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.roleEs')}
            </label>
            <input type="text" value={draft.roleEs} maxLength={200} disabled={busy}
                   onChange={e => set('roleEs', e.target.value)}
                   placeholder={t('owner.publicProfile.rolePlaceholderEs')}
                   style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
        </div>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.bioEn')}
            </label>
            <textarea rows={4} value={draft.bioEn} maxLength={4000} disabled={busy}
                      onChange={e => set('bioEn', e.target.value)}
                      placeholder={t('owner.publicProfile.bioPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.bioEs')}
            </label>
            <textarea rows={4} value={draft.bioEs} maxLength={4000} disabled={busy}
                      onChange={e => set('bioEs', e.target.value)}
                      placeholder={t('owner.publicProfile.bioPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
        </div>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.highlightsEn')}
            </label>
            <textarea rows={4} value={draft.highlightsEn} maxLength={4000} disabled={busy}
                      onChange={e => set('highlightsEn', e.target.value)}
                      placeholder={t('owner.publicProfile.highlightsPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.highlightsEs')}
            </label>
            <textarea rows={4} value={draft.highlightsEs} maxLength={4000} disabled={busy}
                      onChange={e => set('highlightsEs', e.target.value)}
                      placeholder={t('owner.publicProfile.highlightsPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
        </div>
        <p style={{ margin: '-4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
          {t('owner.publicProfile.highlightsHint')}
        </p>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.educationEn')}
            </label>
            <textarea rows={3} value={draft.educationEn} maxLength={4000} disabled={busy}
                      onChange={e => set('educationEn', e.target.value)}
                      placeholder={t('owner.publicProfile.educationPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.educationEs')}
            </label>
            <textarea rows={3} value={draft.educationEs} maxLength={4000} disabled={busy}
                      onChange={e => set('educationEs', e.target.value)}
                      placeholder={t('owner.publicProfile.educationPlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
        </div>

        <div className="tax-form__row2">
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.experienceEn')}
            </label>
            <textarea rows={3} value={draft.experienceEn} maxLength={4000} disabled={busy}
                      onChange={e => set('experienceEn', e.target.value)}
                      placeholder={t('owner.publicProfile.experiencePlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.publicProfile.experienceEs')}
            </label>
            <textarea rows={3} value={draft.experienceEs} maxLength={4000} disabled={busy}
                      onChange={e => set('experienceEs', e.target.value)}
                      placeholder={t('owner.publicProfile.experiencePlaceholder')}
                      style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.publicProfile.displayOrder')}:
          <input type="number" value={draft.displayOrder} disabled={busy}
                 onChange={e => set('displayOrder', e.target.value)}
                 min="0" max="10000"
                 style={{ width: 80, padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 4 }} />
        </label>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                  onClick={onSave} disabled={busy || !dirty}>
            {busy ? t('lead.submitting') : t('owner.publicProfile.save')}
          </button>
          {msg.text && (
            <span style={{ fontSize: 12,
                           color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)' }}>
              {msg.text}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// Direct file-upload affordance. Asks the server for a signed PUT URL into
// the public staff-photos bucket, uploads the file, then writes the
// resulting public URL straight into the photo_url draft field. The owner
// still has to click Save Profile to persist it on the row.
function PhotoUploadButton({ emp, auth, disabled, t, onUploaded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onPick = () => {
    if (busy || disabled) return;
    setErr('');
    inputRef.current?.click();
  };

  const onChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setErr(t('owner.publicProfile.photoUpload.tooBig'));
      return;
    }
    setBusy(true); setErr('');
    try {
      const r = await taxApi.adminEmployeePhotoUploadUrl(auth, emp.id, {
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      const put = await fetch(r.signedUrl, {
        method: 'PUT', body: file,
        headers: { 'content-type': file.type, 'x-upsert': 'true' },
      });
      if (!put.ok) {
        const text = await put.text().catch(() => '');
        throw new Error(text || `Upload failed (${put.status}).`);
      }
      // Cache-bust so the freshly-uploaded image replaces the cached
      // one immediately in the on-page preview.
      const busted = r.publicUrl + (r.publicUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
      onUploaded(busted);
    } catch (ex) {
      setErr(ex?.message || t('owner.publicProfile.photoUpload.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif"
             onChange={onChange} style={{ display: 'none' }} />
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onPick} disabled={busy || disabled}>
        {busy
          ? t('owner.publicProfile.photoUpload.uploading')
          : t('owner.publicProfile.photoUpload.button')}
      </button>
      <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
        {t('owner.publicProfile.photoUpload.hint')}
      </span>
      {err && (
        <span style={{ fontSize: 11, color: 'var(--tax-error)' }}>{err}</span>
      )}
    </div>
  );
}

function PermissionsCard({ emp, me, auth, onSaved, t }) {
  const [registry, setRegistry] = useState(null);
  const [draft, setDraft] = useState(() => emp.permissions || {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  useEffect(() => { setDraft(emp.permissions || {}); }, [emp.permissions]);

  useEffect(() => {
    taxApi.adminListPermissions(auth)
      .then(d => setRegistry(d.permissions || []))
      .catch(() => setRegistry([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (registry === null) return null;
  if (!registry.length) return null;

  const isGranted = (key) => draft[key] !== false;
  const toggle = (key) => setDraft(prev => {
    const next = { ...prev };
    if (next[key] === false) delete next[key];
    else next[key] = false;
    return next;
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(emp.permissions || {});

  const onSave = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      // Strip every key that's `true` — the server stores only revoked
      // entries. Sending `true` is harmless (sanitizer drops it) but
      // keeping the payload minimal makes the audit log readable.
      const payload = {};
      for (const k of Object.keys(draft)) if (draft[k] === false) payload[k] = false;
      await taxApi.adminSetEmployeePermissions(auth, emp.id, payload);
      setMsg({ kind: 'success', text: t('owner.permissions.saved') });
      onSaved && onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || '' });
    } finally { setBusy(false); }
  };
  const onReset = () => setDraft(emp.permissions || {});

  const revokedCount = Object.values(draft).filter(v => v === false).length;
  const isSelf = me?.id === emp.id;

  return (
    <section style={{ marginTop: 32 }}>
      <h3 style={{ margin: 0 }}>{t('owner.permissions.heading')}</h3>
      <p className="tax-section__lede" style={{ marginTop: 4, marginBottom: 12 }}>
        {t('owner.permissions.sub', { defaultText: '' })}
      </p>
      {isSelf && (
        <div className="tax-msg" style={{
          background: 'color-mix(in srgb, #92400e 8%, #fff)',
          borderLeft: '3px solid #92400e', color: '#7c2d12',
          padding: '8px 12px', marginBottom: 10, fontSize: 13,
        }}>
          {t('owner.permissions.selfWarning')}
        </div>
      )}
      <div style={{ display: 'grid', gap: 6, maxWidth: 720 }}>
        {registry.map(p => {
          const granted = isGranted(p.key);
          return (
            <label key={p.key} style={{
              display: 'flex', gap: 12, padding: '10px 12px',
              border: '1px solid var(--tax-border)', borderRadius: 8,
              background: granted ? '#fff' : 'color-mix(in srgb, #b91c1c 5%, #fff)',
              cursor: 'pointer',
            }}>
              <input type="checkbox" checked={granted} onChange={() => toggle(p.key)}
                     disabled={busy} style={{ marginTop: 2 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {t(p.labelKey, { _: p.key })}
                  {!granted && (
                    <span style={{
                      marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                      background: '#fee2e2', color: '#991b1b',
                    }}>{t('owner.permissions.revoked')}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                  {t(p.descKey, { _: '' })}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
          {revokedCount === 0
            ? t('owner.permissions.allGranted')
            : t('owner.permissions.someRevoked', { count: revokedCount })}
        </span>
        {dirty && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={onReset} disabled={busy} style={{ color: 'var(--tax-text)' }}>
            {t('owner.permissions.reset')}
          </button>
        )}
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={onSave} disabled={!dirty || busy}>
          {busy ? t('lead.submitting') : t('owner.permissions.save')}
        </button>
        {msg.text && (
          <span style={{ fontSize: 12,
                         color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)' }}>
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

// "Impersonate" button for a staff row. Behaves like the customer version
// but routes to /employee — the EmployeeAuthProvider detects the
// impersonation state and swaps identity to the target.
function ImpersonateEmployeeButton({ employee: emp, auth, community, t }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onClick = async () => {
    if (!window.confirm(t('impersonation.confirm.employee', { name: displayPersonName(emp) || emp.email }))) return;
    setBusy(true); setErr('');
    try {
      const r = await taxApi.adminStartImpersonation(auth, {
        communitySlug: community.id,
        targetType: 'employee',
        targetId: emp.id,
      });
      setImpersonation({
        token: r.token,
        targetType: 'employee',
        targetId: emp.id,
        targetEmail: emp.email,
        targetName: displayPersonName(emp) || emp.email,
        communitySlug: community.id,
        realAdminEmail: auth.adminEmail || auth.email,
        realAdminUid: auth.uid,
        expiresAt: r.expiresAt,
      });
      window.location.href = `/tax/${community.id}/employee`;
    } catch (e) {
      setErr(e?.message || '');
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: '#b91c1c', borderColor: '#b91c1c', flexShrink: 0 }}>
        {busy ? t('impersonation.starting') : t('impersonation.viewAsEmployee')}
      </button>
      {err && <span style={{ color: 'var(--tax-error)', fontSize: 11 }}>{err}</span>}
    </div>
  );
}

// Phase 4n.16: archive (status='archived') an employee. Soft-delete to
// retain audit history + past assignments. When already archived, swaps
// to a "Restore" affordance.
// Detail-page resend affordance. Shown when the employee hasn't yet
// completed first sign-in — same endpoint as the list-row variant.
function DetailResendWelcomeButton({ emp, auth, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const onClick = async () => {
    if (!window.confirm(t('owner.staff.resendWelcome.confirm', { name: displayPersonName(emp) || emp.email }))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminSendStaffWelcomeEmail(auth, emp.id);
      if (r?.welcomeEmail?.sent || r?.sent) {
        setMsg({ kind: 'success', text: t('owner.staff.resendWelcome.sent') });
      } else {
        const reason = r?.welcomeEmail?.reason || r?.reason || r?.welcomeEmail?.error || r?.error;
        setMsg({ kind: 'error', text: reason
          ? t('owner.staff.resendWelcome.failedWithReason', { reason })
          : t('owner.staff.resendWelcome.failed') });
      }
    } catch (err) {
      setMsg({ kind: 'error', text: err?.message || t('owner.staff.resendWelcome.failed') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 6000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
        {busy ? t('lead.submitting') : t('owner.staff.resendWelcome.button')}
      </button>
      {msg.text && (
        <span style={{ fontSize: 11,
                       color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

function ArchiveEmployeeButton({ emp, auth, onChanged, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  const isArchived = emp.status === 'archived';

  const onClick = async () => {
    if (!isArchived) {
      if (!window.confirm(t('owner.staffDetail.archive.confirm', { name: displayPersonName(emp) || emp.email }))) return;
    }
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetEmployeeStatus(auth, emp.id, {
        status: isArchived ? 'active' : 'archived',
      });
      setMsg({ kind: 'success',
        text: isArchived ? t('owner.staffDetail.archive.restored') : t('owner.staffDetail.archive.done') });
      onChanged && onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 6000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: '#b91c1c', borderColor: '#b91c1c' }}>
        {busy
          ? t('lead.submitting')
          : (isArchived ? t('owner.staffDetail.archive.restoreBtn') : t('owner.staffDetail.archive.button'))}
      </button>
      {msg.text && (
        <span style={{
          fontSize: 11,
          color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)',
        }}>{msg.text}</span>
      )}
    </div>
  );
}
