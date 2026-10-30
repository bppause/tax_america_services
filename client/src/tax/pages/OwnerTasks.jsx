import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { displayPersonName } from '../lib/personName';
import { urgencyOf, effectiveUrgency, colorOf, priorityColorOf, resolveThresholds, URGENCY_LABEL_KEY } from '../lib/taskUrgency';
import { formatFrequency } from '../lib/taskFrequency';
import { formatDateTime } from '../lib/lastSignIn';
import { mailtoHref, whatsappHref, taskContactMessage } from '../lib/contactLinks';
import TaskHover from '../components/TaskHover';
import { customerTypeIcon } from '../components/CustomerTypeBadge';

// Owner / staff task tracker. Replaces the spreadsheet workflow:
// columns from the source CSV map onto this UI as
//   Task           → title
//   Customer Name  → customer picker (optional — practice-wide tasks
//                                       leave it blank)
//   Status         → status_key chip (owner-editable list)
//   Owner          → assigned_employee_id (staff picker)
//   Priority       → priority chip
//   Due date       → due_date input
//   Notes          → notes textarea

const PRIORITY_OPTIONS = ['urgent', 'high', 'normal', 'low'];
// Pseudo service-id for practice-wide tasks (no product_id). Lets the
// Service filter isolate them alongside — or instead of — real services.
// Server-side match lives in GET /admin/tasks' and GET /admin/progress's
// productId/serviceId handling. Exported so OwnerProgress.jsx's Service
// filter uses the exact same sentinel.
export const NO_SERVICE_ID = '__none__';

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h === 0 && m === 0) return '<1m';
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Inline status-change-note prompt. Any status change — not just one
// that moves a task into a terminal bucket — gets a note, so prompt
// the user via window.prompt (unless the patch already carries a
// fresh one) and merge the result into the patch. Returns null when
// the user cancels — the caller should skip the API call. Keeps the
// inline status dropdown and the Kanban drag-drop from surprising the
// user with a server 400. The prompt copy still calls out "closing
// note" specifically when the target status is terminal (the server
// gates completion on it too), and a plainer "what changed" note
// otherwise.
//
// Deliberately does NOT treat task.notes (the legacy single field)
// as already satisfying this — that field is sticky across every
// future edit once anything has ever been typed into it, so trusting
// it here would make every status change after the first one skip
// the prompt entirely, which is exactly the bug this used to have.
// Each transition needs its own fresh note.
//
// task.notes stays the legacy single field the server gates status
// changes on (no server-side change needed), but a freshly-prompted
// note also belongs in the collaborative notes log (see TaskNotesSection
// below) so it shows up in that shared history too — `onNewNote(trimmedNote)`,
// when supplied, fires for exactly that case (never for an
// already-existing note, which would just duplicate it).
//
// `promptKey`, when passed, overrides the default terminal/non-terminal
// copy selection below — used when a status change is itself implied by
// some other action (e.g. assigning an owner auto-moves Not started to
// In progress) and the generic "status change" wording wouldn't explain
// why the prompt appeared.
export function ensureStatusChangeNotes({ statuses, task, patch, t, onNewNote, promptKey: promptKeyOverride }) {
  if (!patch || !patch.statusKey || patch.statusKey === task?.status_key) return patch;
  const incoming = String(patch.notes || '').trim();
  if (incoming) return patch;
  const target = (statuses || []).find(s => s.key === patch.statusKey);
  const promptKey = promptKeyOverride
    || (target?.is_terminal ? 'owner.tasks.completeNotesPrompt' : 'owner.tasks.statusChangeNotesPrompt');
  const note = typeof window !== 'undefined'
    ? window.prompt(t(promptKey))
    : null;
  if (note === null) return null;
  const trimmed = String(note).trim();
  if (!trimmed) {
    if (typeof window !== 'undefined') window.alert(t('owner.tasks.statusChangeNotesRequired'));
    return null;
  }
  onNewNote?.(trimmed);
  return { ...patch, notes: trimmed };
}

// A task can't move beyond "Not started" without an owner, priority,
// and due date already in place — those are what make it actually
// actionable (who's doing it, how urgent, by when). Checked against
// whichever value is effective after the patch (falls back to the
// task's current one). Mirrors the server gate on PATCH
// /admin/tasks/:id and POST /admin/tasks. Returns a translated error
// string if blocked, or null if the move is fine.
export function notStartedFieldsMissing({ task, patch, t }) {
  if (!patch || !patch.statusKey) return null;
  if (patch.statusKey === 'not_started') return null;
  const assignee = patch.assignedEmployeeId !== undefined ? patch.assignedEmployeeId : task?.assigned_employee_id;
  const priority = patch.priority !== undefined ? patch.priority : task?.priority;
  const due = patch.dueDate !== undefined ? patch.dueDate : task?.due_date;
  const missing = [];
  if (!assignee) missing.push(t('owner.tasks.field.owner'));
  if (!priority) missing.push(t('owner.tasks.field.priority'));
  if (!due) missing.push(t('owner.tasks.field.due'));
  if (!missing.length) return null;
  return t('owner.tasks.notStartedFieldsRequired', { fields: missing.join(', ') });
}

// When a task requires owner review and hasn't been approved yet,
// picking a terminal status was never really "mark as done" — the
// server always redirects it into "Pending review" instead (see
// stillRequiresReview in PATCH /admin/tasks/:id). Showing the raw
// terminal label (e.g. "Completed") as a plain option hid that, so a
// preparer who picked it would be surprised to see "Pending review"
// after saving. This relabels those options instead of hiding them —
// the value sent to the server is still the real terminal key
// unchanged, only the displayed text differs.
export function statusSelectOptions(statuses, task, t, locale) {
  const needsReview = !!task?.requires_review && !task?.reviewed_at;
  return (statuses || []).map(s => {
    const label = pickI18n(s.label_i18n, locale).value || s.key;
    return {
      key: s.key,
      id: s.id,
      label: (needsReview && s.is_terminal)
        ? t('owner.tasks.field.statusSubmitForReview', { status: label })
        : label,
    };
  });
}

export default function OwnerTasks() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isAdmin = employee?.role === 'admin';
  const isSeedOwner = !!employee?.is_seed_owner;
  // Reviewer is the one role allowed to move a task to a terminal/
  // completed status (see server-side isTaskReviewer in routes.js) —
  // the seed owner always counts, same convention as Staff Admin.
  const isReviewer = !!employee?.is_task_reviewer || isSeedOwner;
  // Settings → Admin/staff view. Simple mode locks this page to a plain
  // list: no Kanban/Calendar/Periods, no bulk actions, no blocked-by/
  // review/time-tracking panel in the edit modal.
  const isSimple = community?.tax_ui_mode === 'simple';

  const [statuses, setStatuses] = useState([]);
  // Owner-controlled master switch — whether the "Requires review"
  // checkbox on a task is even allowed to be turned off. Admin-only
  // data (community-settings is admin-gated), fetched alongside the
  // other reference lists below.
  const [reviewOverrideEnabled, setReviewOverrideEnabled] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [relationshipTypes, setRelationshipTypes] = useState([]);

  // Multi-value filters live as arrays of IDs; serialized to
  // comma-separated strings at the API boundary so the server can
  // accept either form. Priority + due stay scalar — small fixed
  // pickers. Persisted per browser, like view/groupBy/sort below, so
  // the filter set an operator last left the page in comes right back.
  const DEFAULT_FILTERS = {
    status: [], priority: '', assignedTo: [], productId: [], customerId: [], due: '',
    customerType: 'all',   // 'all' | 'individual' | 'business'
    q: '',
  };
  const [filters, setFilters] = useState(() => {
    // ?customerId=<id> (from the Customers list's "View tasks" link)
    // wins over whatever filter set was last saved — the point of
    // following that link is a focused view of THIS customer's tasks,
    // not last session's filters intersected with them.
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('customerId');
      if (fromUrl) return { ...DEFAULT_FILTERS, customerId: [fromUrl] };
    } catch { /* ignore */ }
    try {
      const saved = JSON.parse(localStorage.getItem('tax.tasks.filters'));
      if (saved && typeof saved === 'object') return { ...DEFAULT_FILTERS, ...saved };
    } catch { /* ignore */ }
    return DEFAULT_FILTERS;
  });
  // Strip ?customerId= once it's been applied above so a later manual
  // filter change (or just reloading the page) doesn't keep re-pinning
  // the view back to this customer.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('customerId')) return;
    params.delete('customerId');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.filters', JSON.stringify(filters)); }
    catch { /* ignore */ }
  }, [filters]);
  // Phase 4n.45: view mode (list/calendar/kanban), group-by, and the
  // My-tasks toggle. View + group-by persist per browser via
  // localStorage so the operator's preference sticks across sessions.
  const [view, setView] = useState(() => {
    // 'periods' was removed as a selectable tab — fall back to the
    // default (kanban) for anyone whose saved preference still points
    // at it, rather than landing on a view with no way back to it.
    try {
      const stored = localStorage.getItem('tax.tasks.view');
      return ['list', 'calendar', 'kanban'].includes(stored) ? stored : 'kanban';
    } catch { return 'kanban'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.view', view); } catch { /* ignore */ }
  }, [view]);
  // Simple mode only ever shows the plain list — fall back immediately
  // if a saved preference (from before switching modes) points elsewhere.
  useEffect(() => {
    if (isSimple && view !== 'list') setView('list');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSimple]);
  // v2: the key bumped when the default moved to 'customer', so every
  // user picks up the new default once regardless of a 'none' (or other)
  // choice saved under the old key — they can still change it from here.
  const [groupBy, setGroupBy] = useState(() => {
    try { return localStorage.getItem('tax.tasks.groupBy.v2') || 'customer'; }
    catch { return 'customer'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.groupBy.v2', groupBy); } catch { /* ignore */ }
  }, [groupBy]);
  // Periods view has its own grouping toggle (period / service / month).
  // Lives separately so flipping between List and Periods doesn't
  // overwrite the operator's preference on either side.
  const [periodsGroup, setPeriodsGroup] = useState(() => {
    try { return localStorage.getItem('tax.tasks.periodsGroup') || 'period'; }
    catch { return 'period'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.periodsGroup', periodsGroup); } catch { /* ignore */ }
  }, [periodsGroup]);
  // Sort key persisted per browser so the operator's order sticks.
  // Server interprets the key — see /admin/tasks.
  const [sortKey, setSortKey] = useState(() => {
    try { return localStorage.getItem('tax.tasks.sort') || 'dueAsc'; }
    catch { return 'dueAsc'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.sort', sortKey); } catch { /* ignore */ }
  }, [sortKey]);
  // "My tasks" toggle persists per browser too.
  const [mine, setMine] = useState(() => {
    try { return localStorage.getItem('tax.tasks.mine') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.mine', mine ? '1' : '0'); }
    catch { /* ignore */ }
  }, [mine]);
  // Hide-completed toggle persists per browser, like view/groupBy/sort —
  // a quick way to declutter the list without touching the Status filter.
  const [hideCompleted, setHideCompleted] = useState(() => {
    try { return localStorage.getItem('tax.tasks.hideCompleted') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.hideCompleted', hideCompleted ? '1' : '0'); }
    catch { /* ignore */ }
  }, [hideCompleted]);
  // Bulk selection state. Holds task IDs across re-fetches so an
  // operator can build a selection across multiple page loads (e.g.
  // after switching due-bucket chips). The bulk action bar appears
  // when the set is non-empty.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());
  const selectMany = (ids) => setSelectedIds(prev => {
    const next = new Set(prev);
    for (const id of ids) next.add(id);
    return next;
  });

  const load = () => {
    if (!employee || !community) return;
    // Flatten array filters to comma-separated strings for the API.
    // Empty arrays drop out so the server doesn't see "?status=".
    const flat = (v) => Array.isArray(v) ? v.join(',') : v;
    const merged = {
      communitySlug: community.id,
      status: flat(filters.status),
      priority: filters.priority,
      assignedTo: flat(filters.assignedTo),
      productId: flat(filters.productId),
      customerId: flat(filters.customerId),
      customerType: filters.customerType && filters.customerType !== 'all' ? filters.customerType : undefined,
      due: filters.due,
      q: filters.q,
      sort: sortKey,
      hideCompleted: hideCompleted ? '1' : undefined,
    };
    // Mine-toggle overrides the assignedTo filter for the duration
    // of the toggle. Turning Mine off keeps whatever the picker
    // had selected before.
    if (mine && employee?.id) merged.assignedTo = employee.id;
    taxApi.adminListTasks(auth, merged)
      .then(d => {
        const rows = d.tasks || [];
        // Priority is a text column server-side so the rank ordering
        // (urgent > high > normal > low) is applied here. Other sort
        // keys are already handled by the SQL ORDER BY.
        if (sortKey === 'priority') {
          const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
          rows.sort((a, b) => {
            const ar = rank[a.priority] ?? 99;
            const br = rank[b.priority] ?? 99;
            if (ar !== br) return ar - br;
            const ad = a.due_date || '9999-12-31';
            const bd = b.due_date || '9999-12-31';
            return ad.localeCompare(bd);
          });
        }
        setTasks(rows);
      })
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };

  // Reference data (statuses / employees / customers / products) is loaded
  // once per community — the picker dropdowns + filter chips depend on it.
  useEffect(() => {
    if (!employee || !community) return;
    Promise.all([
      taxApi.adminListTaskStatuses(auth, community.id).catch(() => ({ statuses: [] })),
      taxApi.adminListEmployees(auth, community.id).catch(() => ({ employees: [] })),
      taxApi.adminListCustomers(auth, community.id).catch(() => ({ customers: [] })),
      taxApi.adminListProducts(auth, community.id).catch(() => ({ products: [] })),
      // Admin-only — non-admins can't quick-create a customer, so the
      // listing endpoint (which is admin-gated) is skipped for them.
      isAdmin
        ? taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id }).catch(() => ({ types: [] }))
        : Promise.resolve({ types: [] }),
      isAdmin
        ? taxApi.adminGetCommunitySettings(auth, community.id).catch(() => ({ settings: {} }))
        : Promise.resolve({ settings: {} }),
    ]).then(([s, e, c, p, rt, cs]) => {
      setStatuses(s.statuses || []);
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
      setCustomers(c.customers || []);
      setProducts(p.products || []);
      setRelationshipTypes((rt.types || []).filter(r => r.active !== false));
      setReviewOverrideEnabled(!!cs.settings?.tax_task_review_override_enabled);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  // Refetch tasks whenever filters change. Debounce the search box so
  // typing doesn't refetch on every keystroke.
  const searchTimer = useRef(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, 200);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, filters, mine, employee?.id, sortKey, hideCompleted]);

  const employeeById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);
  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const productById  = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);

  // ?edit=<taskId> auto-opens the edit modal for that task. Used by the
  // owner dashboard's urgent-task list so clicking a task on the
  // dashboard jumps straight into the same editor used here. Cleans
  // the param on open so back/forward navigation behaves.
  useEffect(() => {
    if (!Array.isArray(tasks) || tasks.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const editId = params.get('edit');
    if (!editId) return;
    const task = tasks.find(t => t.id === editId);
    if (task) {
      setEditingTask(task);
      params.delete('edit');
      const qs = params.toString();
      const next = window.location.pathname + (qs ? `?${qs}` : '');
      window.history.replaceState(null, '', next);
    }
  }, [tasks]);

  const onClearFilters = () => setFilters(DEFAULT_FILTERS);
  // customerType always carries a string ('all' / 'individual' /
  // 'business') so we only count it as "active" when it differs from
  // the default. Other scalar filters fall back to truthy because
  // empty string means "not picked".
  const filtersActive = Object.entries(filters).some(([k, v]) => {
    if (Array.isArray(v)) return v.length > 0;
    if (k === 'customerType') return v && v !== 'all';
    return !!v;
  });

  if (err) return <EmployeeShell community={community} active="tasks">
    <div className="tax-msg tax-msg--error">{err}</div>
  </EmployeeShell>;

  return (
    <EmployeeShell community={community} active="tasks">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{t('owner.tasks.title')}</h2>
          <p className="tax-section__lede" style={{ margin: '4px 0 0' }}>
            {t('owner.tasks.subtitle')}
          </p>
        </div>
        <button type="button" className="tax-btn tax-btn--primary"
                onClick={() => setShowAdd(true)}>
          + {t('owner.tasks.add')}
        </button>
      </div>

      {showAdd && (
        <TaskFormModal
          mode="create"
          auth={auth} community={community} isAdmin={isAdmin}
          statuses={statuses} employees={employees} customers={customers}
          products={products} relationshipTypes={relationshipTypes}
          defaultAssignee={employee?.id || ''} locale={locale} t={t}
          isSimple={isSimple}
          onCustomersChanged={(c) => setCustomers(prev => [c, ...prev])}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}

      {editingTask && (
        <TaskFormModal
          mode="edit" task={editingTask}
          auth={auth} community={community} isAdmin={isAdmin} isSeedOwner={isSeedOwner}
          isReviewer={isReviewer}
          reviewOverrideEnabled={reviewOverrideEnabled}
          statuses={statuses} employees={employees} customers={customers}
          products={products} relationshipTypes={relationshipTypes}
          tasks={tasks} employeeId={employee?.id || ''}
          defaultAssignee={employee?.id || ''} locale={locale} t={t}
          isSimple={isSimple}
          onCustomersChanged={(c) => setCustomers(prev => [c, ...prev])}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); load(); }}
        />
      )}

      <TaskToolbar
        mine={mine} setMine={setMine}
        hideCompleted={hideCompleted} setHideCompleted={setHideCompleted}
        filters={filters} setFilters={setFilters}
        view={view} setView={setView}
        groupBy={groupBy} setGroupBy={setGroupBy}
        sortKey={sortKey} setSortKey={setSortKey}
        periodsGroup={periodsGroup} setPeriodsGroup={setPeriodsGroup}
        simple={isSimple}
        t={t}
      />

      <FilterBar
        filters={filters} setFilters={setFilters}
        statuses={statuses} employees={employees} products={products}
        customers={customers}
        onClear={onClearFilters} active={filtersActive}
        locale={locale} t={t}
      />

      {selectedIds.size > 0 && !isSimple && (
        <BulkActionBar
          selectedIds={selectedIds}
          tasks={tasks || []}
          statuses={statuses}
          employees={employees}
          auth={auth}
          onClear={clearSelection}
          onDone={() => { clearSelection(); load(); }}
          locale={locale}
          t={t}
        />
      )}

      {view === 'periods' ? (
        <TasksPeriods auth={auth} community={community} filters={filters}
                      statuses={statuses} employees={employees}
                      customerById={customerById} employeeById={employeeById}
                      productById={productById} isAdmin={isAdmin} isSeedOwner={isSeedOwner}
                      onEdit={setEditingTask}
                      selectedIds={selectedIds} toggleSelect={toggleSelect}
                      selectMany={selectMany}
                      periodsGroup={periodsGroup}
                      mine={mine} employeeId={employee?.id}
                      hideCompleted={hideCompleted}
                      locale={locale} t={t} />
      ) : tasks === null ? <p>{t('loading')}</p>
        : tasks.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>
              {filtersActive ? t('owner.tasks.noMatch') : t('owner.tasks.empty')}
            </p>
          : view === 'calendar' ? (
              <TasksCalendar tasks={tasks} community={community} statuses={statuses}
                             onEdit={setEditingTask} onChange={load} locale={locale} t={t} />
            )
          : view === 'kanban' ? (
              <TasksKanban tasks={tasks} statuses={statuses} community={community}
                           auth={auth} onChange={load} hideCompleted={hideCompleted}
                           groupBy={groupBy}
                           onEdit={setEditingTask} locale={locale} t={t} />
            )
          : (
            <TasksGroupedList tasks={tasks} groupBy={groupBy} community={community}
                              statuses={statuses} employees={employees}
                              customerById={customerById} employeeById={employeeById}
                              productById={productById} isAdmin={isAdmin} employeeId={employee?.id}
                              isSeedOwner={isSeedOwner}
                              auth={auth} onEdit={setEditingTask} onChange={load}
                              selectedIds={isSimple ? undefined : selectedIds}
                              toggleSelect={isSimple ? undefined : toggleSelect}
                              selectMany={isSimple ? undefined : selectMany}
                              locale={locale} t={t} />
          )
      }
    </EmployeeShell>
  );
}

function FilterBar({ filters, setFilters, statuses, employees, products, customers = [], onClear, active, locale, t }) {
  const set = (k, v) => setFilters(prev => ({ ...prev, [k]: v }));
  const toggle = (k, id) => setFilters(prev => {
    const cur = Array.isArray(prev[k]) ? prev[k] : [];
    return { ...prev, [k]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] };
  });
  // Sort customers alphabetically by display name (company first when set)
  // so the picker scans like a directory. Narrow to the chip-filter
  // type so picking "Business" up top hides individuals in the
  // dropdown too.
  const customerOptions = [...customers]
    .filter(c => (filters.customerType === 'all' || !filters.customerType)
      ? true
      : (c.customer_type || 'individual') === filters.customerType)
    .sort((a, b) => {
      const an = (a.business_name || displayPersonName(a) || a.email || '').toLowerCase();
      const bn = (b.business_name || displayPersonName(b) || b.email || '').toLowerCase();
      return an.localeCompare(bn);
    }).map(c => ({
    id: c.id,
    label: c.business_name || displayPersonName(c) || c.email,
    sub: c.business_name && (c.first_name || c.last_name)
      ? `${[c.first_name, c.last_name].filter(Boolean).join(' ').trim()}${c.email ? ' · ' + c.email : ''}`
      : (c.email || ''),
    haystack: `${c.business_name || ''} ${c.name || ''} ${c.first_name || ''} ${c.last_name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase(),
  }));
  const statusOptions = statuses.map(s => ({
    id: s.key,
    label: pickI18n(s.label_i18n, locale).value || s.key,
  }));
  const ownerOptions = employees.map(em => ({
    id: em.id,
    label: displayPersonName(em) || em.email,
    sub: em.email || '',
  }));
  const productOptions = [
    { id: NO_SERVICE_ID, label: t('owner.tasks.filter.noService') },
    ...products.map(p => ({
      id: p.id,
      label: pickI18n(p.name_i18n, locale).value || p.slug,
    })),
  ];
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 16,
                  padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8 }}>
      {/* Customer-type chip row. Mirrors the same control on the
          Customers list + Leads inbox so the filter language is the
          same across the employee portal. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[
          { key: 'all',        label: t('owner.customers.typeFilter.all') },
          { key: 'individual', label: t('owner.customers.customerType.individual') },
          { key: 'business',   label: t('owner.customers.customerType.business') },
        ].map(opt => {
          const active = (filters.customerType || 'all') === opt.key;
          return (
            <button key={opt.key} type="button"
                    onClick={() => set('customerType', opt.key)}
                    style={{
                      padding: '4px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      background: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                        : '#fff',
                      color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                      border: '1px solid',
                      borderColor: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                        : 'var(--tax-border)',
                      fontWeight: active ? 700 : 500,
                    }}>
              {opt.label}
            </button>
          );
        })}
      </div>
      <input type="search" value={filters.q}
             onChange={e => set('q', e.target.value)}
             placeholder={t('owner.tasks.searchPlaceholder')}
             style={{ padding: '8px 10px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <MultiSelect
          label={t('owner.tasks.filter.allStatuses')}
          options={statusOptions}
          value={filters.status}
          onToggle={id => toggle('status', id)}
          onClear={() => set('status', [])}
          searchable={statusOptions.length > 8}
          searchPlaceholder={t('owner.tasks.filter.searchStatuses')}
          t={t}
        />
        <select value={filters.priority} onChange={e => set('priority', e.target.value)}>
          <option value="">{t('owner.tasks.filter.allPriorities')}</option>
          {PRIORITY_OPTIONS.map(p => (
            <option key={p} value={p}>{t(`owner.tasks.priority.${p}`)}</option>
          ))}
        </select>
        <MultiSelect
          label={t('owner.tasks.filter.anyOwner')}
          options={ownerOptions}
          value={filters.assignedTo}
          onToggle={id => toggle('assignedTo', id)}
          onClear={() => set('assignedTo', [])}
          searchable={ownerOptions.length > 8}
          searchPlaceholder={t('owner.tasks.filter.searchOwners')}
          t={t}
        />
        <MultiSelect
          label={t('owner.tasks.filter.anyService')}
          options={productOptions}
          value={filters.productId}
          onToggle={id => toggle('productId', id)}
          onClear={() => set('productId', [])}
          searchable={productOptions.length > 8}
          searchPlaceholder={t('owner.tasks.filter.searchServices')}
          t={t}
        />
        <MultiSelect
          label={t('owner.tasks.filter.anyCustomer')}
          options={customerOptions}
          value={filters.customerId}
          onToggle={id => toggle('customerId', id)}
          onClear={() => set('customerId', [])}
          searchable
          searchPlaceholder={t('owner.tasks.filter.searchCustomers')}
          t={t}
        />
        <select value={filters.due} onChange={e => set('due', e.target.value)}>
          <option value="">{t('owner.tasks.filter.anyDue')}</option>
          <option value="overdue">{t('owner.tasks.filter.overdue')}</option>
          <option value="today">{t('owner.tasks.filter.today')}</option>
          <option value="week">{t('owner.tasks.filter.week')}</option>
        </select>
      </div>
      {active && (
        <button type="button" onClick={onClear}
                style={{ justifySelf: 'start', border: 0, background: 'transparent',
                         color: 'var(--tax-brand-primary)', cursor: 'pointer',
                         fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
          × {t('owner.tasks.filter.clear')}
        </button>
      )}
    </div>
  );
}

// Compact multi-select that doubles as a type-ahead picker for long
// lists (customers, services). Closed: shows the placeholder label
// when empty, the only chosen label when one item is selected, or
// "N selected" otherwise. Open: a search input plus a checkbox list
// filtered as you type. Falls back to a no-search list when the
// option count is small enough to scan at a glance.
// Exported — reused by OwnerProgress.jsx's Service filter so the two
// pages share one multi-select implementation instead of two copies.
export function MultiSelect({ label, options, value, onToggle, onClear, searchable, searchPlaceholder, t }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const selected = Array.isArray(value) ? value : [];
  const selectedSet = new Set(selected);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);
  useEffect(() => {
    if (open && searchable && inputRef.current) {
      inputRef.current.focus();
    }
    if (!open) setQuery('');
  }, [open, searchable]);

  const summary = (() => {
    if (selected.length === 0) return label;
    if (selected.length === 1) {
      const opt = options.find(o => o.id === selected[0]);
      return opt ? opt.label : `${selected.length} ${t('owner.tasks.filter.selected')}`;
    }
    return `${selected.length} ${t('owner.tasks.filter.selected')}`;
  })();

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => (o.haystack || o.label.toLowerCase()).includes(q))
    : options;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button type="button"
              onClick={() => setOpen(o => !o)}
              aria-haspopup="listbox"
              aria-expanded={open}
              style={{
                width: '100%', padding: '6px 28px 6px 10px',
                border: '1px solid var(--tax-border)', borderRadius: 6,
                background: '#fff', cursor: 'pointer', textAlign: 'left',
                fontSize: 13, color: 'var(--tax-text)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                position: 'relative', minHeight: 34,
              }}>
        {summary}
        {selected.length > 0 ? (
          <span onClick={(e) => { e.stopPropagation(); onClear(); }}
                role="button" aria-label={t('owner.tasks.filter.clearOne')}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--tax-muted)', fontSize: 16, cursor: 'pointer', lineHeight: 1,
                }}>×</span>
        ) : (
          <span aria-hidden="true" style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--tax-muted)', fontSize: 10, pointerEvents: 'none',
          }}>▼</span>
        )}
      </button>
      {open && (
        <div role="listbox"
             style={{
               position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
               minWidth: 240,
               maxHeight: 320, display: 'flex', flexDirection: 'column',
               background: '#fff', border: '1px solid var(--tax-border)',
               borderRadius: 6, boxShadow: '0 8px 16px rgba(0,0,0,.08)',
               zIndex: 50,
             }}>
          {searchable && (
            <div style={{ padding: 8, borderBottom: '1px solid var(--tax-border)' }}>
              <input ref={inputRef} type="search" value={query}
                     onChange={e => setQuery(e.target.value)}
                     placeholder={searchPlaceholder || t('owner.tasks.filter.searchPlaceholder')}
                     style={{
                       width: '100%', padding: '6px 8px',
                       border: '1px solid var(--tax-border)', borderRadius: 4,
                       fontSize: 13,
                     }} />
            </div>
          )}
          <MultiSelectOptionList
            filtered={filtered}
            selectedSet={selectedSet}
            onToggle={onToggle}
            t={t}
          />
          {selected.length > 0 && (
            <div style={{ padding: 6, borderTop: '1px solid var(--tax-border)',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
                {selected.length} {t('owner.tasks.filter.selected')}
              </span>
              <button type="button" onClick={onClear}
                      style={{ border: 0, background: 'transparent',
                               color: 'var(--tax-brand-primary)', cursor: 'pointer',
                               fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                {t('owner.tasks.filter.clearOne')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Rows are uniform 44px regardless of whether they carry a sub-line
// — virtualized lists need a fixed row height. Below this count we
// just map normally; above it we hand off to react-window so even a
// 5,000-customer practice opens the picker without jank.
const MULTI_SELECT_VIRTUALIZE_THRESHOLD = 60;
const MULTI_SELECT_ROW_HEIGHT = 44;
const MULTI_SELECT_LIST_HEIGHT = 240;

function MultiSelectOptionList({ filtered, selectedSet, onToggle, t }) {
  if (filtered.length === 0) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('owner.tasks.filter.noMatch')}
      </div>
    );
  }
  if (filtered.length < MULTI_SELECT_VIRTUALIZE_THRESHOLD) {
    return (
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.map(o => (
          <MultiSelectRow key={o.id} option={o}
                          checked={selectedSet.has(o.id)} onToggle={onToggle} />
        ))}
      </div>
    );
  }
  // react-window passes `style` (absolute positioning) and `index`
  // — pull the option out of itemData so the row component stays
  // identical to the non-virtual branch.
  const itemData = { filtered, selectedSet, onToggle };
  return (
    <div style={{ flex: 1 }}>
      <FixedSizeList
        height={Math.min(MULTI_SELECT_LIST_HEIGHT, filtered.length * MULTI_SELECT_ROW_HEIGHT)}
        itemCount={filtered.length}
        itemSize={MULTI_SELECT_ROW_HEIGHT}
        itemData={itemData}
        width="100%"
        overscanCount={6}
      >
        {VirtualizedRow}
      </FixedSizeList>
    </div>
  );
}

function VirtualizedRow({ index, style, data }) {
  const o = data.filtered[index];
  return (
    <div style={style}>
      <MultiSelectRow option={o}
                      checked={data.selectedSet.has(o.id)}
                      onToggle={data.onToggle} />
    </div>
  );
}

function MultiSelectRow({ option: o, checked, onToggle }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '8px 12px', cursor: 'pointer', height: MULTI_SELECT_ROW_HEIGHT,
      boxSizing: 'border-box',
      background: checked ? 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)' : '#fff',
      borderBottom: '1px solid color-mix(in srgb, var(--tax-border) 60%, transparent)',
    }}>
      <input type="checkbox" checked={checked}
             onChange={() => onToggle(o.id)}
             style={{ marginTop: 2 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--tax-text)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {o.label}
        </div>
        {o.sub && (
          <div style={{ fontSize: 11, color: 'var(--tax-muted)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {o.sub}
          </div>
        )}
      </div>
    </label>
  );
}

// Sticky action bar that fires the bulk endpoint on every selected
// task. Two actions: change status (terminal status auto-stamps
// completed_at server-side) and reassign owner. Buttons disable
// while the request is in flight; selection clears + tasks refetch
// on success.
function BulkActionBar({ selectedIds, tasks, statuses, employees, auth, onClear, onDone, locale, t }) {
  const [statusKey, setStatusKey] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ids = Array.from(selectedIds);
  const visibleSelected = tasks.filter(tt => selectedIds.has(tt.id)).length;
  const overflow = ids.length - visibleSelected;

  const apply = async (patch) => {
    setBusy(true); setErr('');
    try {
      const r = await taxApi.adminBulkUpdateTasks(auth, { ids, patch });
      if (r && typeof r.updated === 'number' && r.updated === 0) {
        setErr(t('owner.tasks.bulk.noneUpdated'));
      } else {
        onDone();
      }
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  // Bulk status changes get the same two gates a single-task edit
  // does — see PATCH /admin/tasks/bulk — checked client-side first so
  // a blocked selection surfaces a clear message instead of a round
  // trip that fails. Each selected task needs an owner, priority, and
  // due date before it can move beyond Not started, and every status
  // change needs a note (prompted once, applied to the whole batch).
  const applyStatus = async (v) => {
    const selected = ids.map(id => tasks.find(tt => tt.id === id)).filter(Boolean);
    const target = statuses.find(s => s.key === v);
    if (target?.is_terminal) {
      setErr(t('owner.tasks.bulk.completeUnsupported'));
      setStatusKey('');
      return;
    }
    if (v !== 'not_started') {
      const blocked = selected.filter(tt => notStartedFieldsMissing({ task: tt, patch: { statusKey: v }, t }));
      if (blocked.length) {
        setErr(t('owner.tasks.bulk.fieldsRequired', { count: blocked.length }));
        setStatusKey('');
        return;
      }
    }
    const note = typeof window !== 'undefined' ? window.prompt(t('owner.tasks.statusChangeNotesPrompt')) : null;
    if (note === null) { setStatusKey(''); return; }
    const trimmed = String(note).trim();
    if (!trimmed) {
      if (typeof window !== 'undefined') window.alert(t('owner.tasks.statusChangeNotesRequired'));
      setStatusKey('');
      return;
    }
    await apply({ statusKey: v, notes: trimmed });
    setStatusKey('');
  };

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 40,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
      padding: '10px 12px', marginBottom: 10,
      background: 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)',
      border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)',
      borderRadius: 8,
    }}>
      <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--tax-brand-primary)' }}>
        {ids.length} {t('owner.tasks.bulk.selected')}
        {overflow > 0 && (
          <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--tax-muted)', fontWeight: 500 }}>
            ({overflow} {t('owner.tasks.bulk.notVisible')})
          </span>
        )}
      </span>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ color: 'var(--tax-muted)', fontWeight: 600 }}>
          {t('owner.tasks.bulk.status')}:
        </span>
        <select value={statusKey}
                disabled={busy}
                onChange={e => {
                  const v = e.target.value;
                  setStatusKey(v);
                  if (v) applyStatus(v);
                }}
                style={{ padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 12 }}>
          <option value="">{t('owner.tasks.bulk.chooseStatus')}</option>
          {statuses.map(s => (
            <option key={s.id} value={s.key}>{pickI18n(s.label_i18n, locale).value || s.key}</option>
          ))}
        </select>
      </label>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <span style={{ color: 'var(--tax-muted)', fontWeight: 600 }}>
          {t('owner.tasks.bulk.assign')}:
        </span>
        <select value={assigneeId}
                disabled={busy}
                onChange={e => {
                  const v = e.target.value;
                  setAssigneeId(v);
                  if (v === '__unassign__') apply({ assignedEmployeeId: '' });
                  else if (v) apply({ assignedEmployeeId: v });
                }}
                style={{ padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 12 }}>
          <option value="">{t('owner.tasks.bulk.chooseAssignee')}</option>
          <option value="__unassign__">{t('owner.tasks.bulk.unassign')}</option>
          {employees.map(em => (
            <option key={em.id} value={em.id}>{displayPersonName(em) || em.email}</option>
          ))}
        </select>
      </label>

      <button type="button" onClick={onClear} disabled={busy}
              style={{
                marginLeft: 'auto', border: 0, background: 'transparent',
                color: 'var(--tax-brand-primary)', cursor: 'pointer',
                fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
              }}>
        {t('owner.tasks.bulk.clear')}
      </button>

      {err && <div style={{ flexBasis: '100%', color: 'var(--tax-error)', fontSize: 12 }}>{err}</div>}
    </div>
  );
}

// Tiny "Select all visible" / "Clear visible" toggle that sits above
// each group of TaskRows. Adds or removes every visible row's ID
// from the selection set in one click — the headline win for bulk
// completing a 300-customer period.
function GroupSelectAll({ tasks, selectedIds, toggleSelect, selectMany, t }) {
  if (!tasks?.length || !selectedIds || !selectMany) return null;
  const ids = tasks.map(tt => tt.id);
  const allSelected = ids.every(id => selectedIds.has(id));
  const toggle = () => {
    if (allSelected) {
      // Remove from selection by toggling each — clean, even if
      // a few are already absent.
      ids.forEach(id => { if (selectedIds.has(id)) toggleSelect(id); });
    } else {
      selectMany(ids);
    }
  };
  return (
    <button type="button" onClick={toggle}
            style={{
              justifySelf: 'start',
              border: 0, background: 'transparent', cursor: 'pointer',
              color: 'var(--tax-brand-primary)', fontSize: 11,
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
              padding: '2px 0',
            }}>
      {allSelected
        ? `× ${t('owner.tasks.select.deselectAll')} (${ids.length})`
        : `☑ ${t('owner.tasks.select.selectAll')} (${ids.length})`}
    </button>
  );
}

function TaskRow({ task, auth, community, statuses, employees, customerById, employeeById, productById, isSeedOwner, onEdit, onChange, selected, onToggleSelect, locale, t }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  const customer = task.customer || (task.customer_id ? customerById.get(task.customer_id) : null);
  const product  = task.product  || (task.product_id  ? productById.get(task.product_id)   : null);
  const assignee = task.assignee || (task.assigned_employee_id ? employeeById.get(task.assigned_employee_id) : null);
  const status   = statuses.find(s => s.key === task.status_key);
  const statusLabel = status ? (pickI18n(status.label_i18n, locale).value || status.key) : task.status_key;
  const statusBg = status?.color || '#9ca3af';
  const overdue = task.due_date && task.due_date < new Date().toISOString().slice(0, 10) && !task.completed_at;
  // Phase 4n.47: due-date color treatment shared with Calendar +
  // Kanban. Completed tasks always render neutral — there's no
  // "urgency" once the work is done.
  const thresholds = resolveThresholds(community);
  const urgency = effectiveUrgency(task, thresholds);
  const due = colorOf(urgency, community);
  const prCol = priorityColorOf(task.priority, community);
  // Shown next to a Not-started task so the operator can tell at a
  // glance whether it's actually ready to start, without opening it —
  // the same three fields the server gates any move beyond Not started
  // on (see notStartedFieldsMissing).
  const notStartedMissing = task.status_key === 'not_started' ? [
    !task.assigned_employee_id && t('owner.tasks.field.owner'),
    !task.priority && t('owner.tasks.field.priority'),
    !task.due_date && t('owner.tasks.field.due'),
  ].filter(Boolean) : [];

  const update = async (patch, promptKeyOverride) => {
    // Rather than just refusing and leaving the operator to go find
    // the fields themselves, open the task straight into the edit
    // modal — the Not-started checklist there shows exactly what's
    // missing and lets them fill it in on the spot.
    const fieldsMsg = notStartedFieldsMissing({ task, patch, t });
    if (fieldsMsg) { window.alert(fieldsMsg); onEdit(); return; }
    // Any status change requires a note — see the server-side
    // notes_required_on_status_change check. Prompt the owner inline
    // when the row's status is being changed and there's no note yet,
    // so the server round-trip never has to fail.
    const finalPatch = ensureStatusChangeNotes({
      statuses, task, patch, t,
      promptKey: promptKeyOverride,
      onNewNote: (body) => taxApi.adminCreateTaskNote(auth, task.id, { body }).catch(() => {}),
    });
    if (!finalPatch) return;
    setBusy(true); setErr('');
    try { await taxApi.adminUpdateTask(auth, task.id, finalPatch); onChange(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onDelete = async () => {
    if (!window.confirm(t('owner.tasks.deleteConfirm'))) return;
    setBusy(true); setErr('');
    try { await taxApi.adminDeleteTask(auth, task.id); onChange(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  // A task still sitting in Not started has no real work recorded
  // against it yet, so anyone can clear it. Once it's moved past that —
  // in progress, pending review, completed — deleting it destroys
  // whatever's attached (notes, time entries, review history), so
  // that's reserved for the seeded owner account specifically, not
  // just any admin. Mirrors the server-side check in DELETE /admin/tasks/:id.
  const canDelete = task.status_key === 'not_started' || !!isSeedOwner;

  return (
    <TaskHover task={task} statuses={statuses}
               community={community} locale={locale} t={t}
               side="auto" onDeleted={onChange}>
    <div className="tax-contact-item" style={{
      display: 'grid', gap: 8,
      background: selected ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : undefined,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {onToggleSelect && (
            <input type="checkbox" checked={!!selected}
                   onChange={onToggleSelect}
                   aria-label={t('owner.tasks.select.row')}
                   style={{ marginTop: 3, flexShrink: 0 }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {task.title}
            {task.priority !== 'normal' && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                background: prCol.bg, color: prCol.fg,
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
              }}>{t(`owner.tasks.priority.${task.priority}`)}</span>
            )}
          </div>
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 13, color: 'var(--tax-muted)' }}>
            {customer && (
              <span><strong>{t('owner.tasks.customer')}:</strong>{' '}
                <a href={`/tax/${task.community_id}/employee/customers/${encodeURIComponent(customer.id)}`}
                   style={{ color: 'var(--tax-brand-primary)' }}>
                  <span aria-hidden="true">{customerTypeIcon(customer.customer_type)}</span>{' '}
                  {customer.business_name || displayPersonName(customer) || customer.email}
                </a>
              </span>
            )}
            {product && (
              <span><strong>{t('owner.tasks.service')}:</strong>{' '}
                {pickI18n(product.name_i18n, locale).value || product.slug}</span>
            )}
            {task.auto_task && (
              <>
                <span><strong>{t('owner.tasks.field.taskTemplate')}:</strong>{' '}
                  {pickI18n(task.auto_task.title_i18n, locale).value || ''}</span>
                {task.auto_task.cadence_kind && task.auto_task.cadence_kind !== 'none' && (
                  <span>
                    <strong>{t('owner.tasks.field.frequency')}:</strong>{' '}
                    <span style={{
                      padding: '1px 8px', borderRadius: 999,
                      background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                      fontSize: 11, fontWeight: 700,
                    }}>{formatFrequency(task.auto_task.cadence_kind, task.auto_task.anchor_rule, t, locale)}</span>
                  </span>
                )}
              </>
            )}
            {assignee && (
              <span><strong>{t('owner.tasks.owner')}:</strong>{' '}
                {displayPersonName(assignee) || assignee.email}</span>
            )}
            {task.due_date && (
              <span>
                <strong>{t('owner.tasks.due')}:</strong>{' '}
                {urgency === 'later' ? (
                  <span style={{ color: 'var(--tax-muted)' }}>{task.due_date}</span>
                ) : (
                  <span style={{
                    padding: '1px 8px', borderRadius: 999,
                    background: due.bg, color: due.fg,
                    fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap',
                  }}>
                    {task.due_date}
                    {urgency === 'overdue' && ` · ${t('owner.tasks.urgency.overdue')}`}
                  </span>
                )}
              </span>
            )}
            <span style={{ color: 'var(--tax-muted)' }}>
              {t('owner.tasks.created')}: {task.created_at ? new Date(task.created_at).toLocaleDateString() : ''}
            </span>
            {task.status_key === 'not_started' && (
              notStartedMissing.length > 0 ? (
                <span style={{
                  padding: '1px 8px', borderRadius: 999,
                  background: 'color-mix(in srgb, #d97706 15%, #fff)', color: '#92400e',
                  fontSize: 11, fontWeight: 700,
                }}>{t('owner.tasks.notStartedMissingShort', { fields: notStartedMissing.join(', ') })}</span>
              ) : (
                <span style={{
                  padding: '1px 8px', borderRadius: 999,
                  background: 'color-mix(in srgb, #16a34a 15%, #fff)', color: '#166534',
                  fontSize: 11, fontWeight: 700,
                }}>{t('owner.tasks.readyToStart')}</span>
              )
            )}
          </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          {task.status_key === 'not_started' && (
            <button type="button"
                    onClick={() => update({ statusKey: 'in_progress' }, 'owner.tasks.startNotesPrompt')}
                    disabled={busy}
                    className="tax-btn tax-btn--sm"
                    style={{
                      border: 'none',
                      background: notStartedMissing.length ? 'var(--tax-bg-alt)' : '#166534',
                      color: notStartedMissing.length ? 'var(--tax-muted)' : '#fff',
                    }}>
              {t('owner.tasks.startTask')}
            </button>
          )}
          <select value={task.status_key} onChange={e => update({ statusKey: e.target.value })}
                  disabled={busy}
                  style={{
                    padding: '4px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    border: '1px solid var(--tax-border)',
                    background: `color-mix(in srgb, ${statusBg} 18%, #fff)`,
                  }}>
            {statusSelectOptions(statuses, task, t, locale).map(opt => (
              <option key={opt.id} value={opt.key}>{opt.label}</option>
            ))}
          </select>
          <button type="button" onClick={onEdit} disabled={busy}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
            {t('owner.tasks.edit')}
          </button>
          {canDelete && (
            <button type="button" onClick={onDelete} disabled={busy}
                    className="tax-btn tax-btn--ghost tax-btn--sm"
                    style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
              {t('owner.tasks.delete')}
            </button>
          )}
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {task.notes && (
        <div>
          <button type="button" onClick={() => setShowNotes(s => !s)}
                  style={{ border: 0, background: 'transparent', cursor: 'pointer',
                           color: 'var(--tax-brand-primary)', fontSize: 12, fontWeight: 600 }}>
            {showNotes ? t('owner.tasks.hideNotes') : t('owner.tasks.showNotes')}
          </button>
          {showNotes && (
            <div style={{ marginTop: 6, padding: 10, background: 'var(--tax-bg-alt)',
                          borderRadius: 6, fontSize: 13, whiteSpace: 'pre-wrap' }}>
              {task.notes}
            </div>
          )}
        </div>
      )}
    </div>
    </TaskHover>
  );
}

// Collaborative, timestamped, multi-author notes log for a task — mirrors
// OwnerCustomerDetail.jsx's customer NotesSection. No edit or delete
// (notes are an audit trail, same v1 scope as the customer version);
// newest first.
function NoteCard({ n, locale, t }) {
  return (
    <div style={{
      padding: '8px 10px', border: '1px solid var(--tax-border)',
      borderRadius: 8, background: 'var(--tax-bg-alt)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 8,
        fontSize: 11, color: 'var(--tax-muted)', marginBottom: 4,
      }}>
        <span>
          <strong style={{ color: 'var(--tax-text)' }}>
            {n.author_name || n.author_email || t('owner.customer.notes.unknownAuthor')}
          </strong>
          {n.author_role === 'admin' && (
            <span style={{
              marginLeft: 6, padding: '0 6px', borderRadius: 999,
              background: 'var(--tax-brand-primary)', color: '#fff',
              fontSize: 10, fontWeight: 700,
            }}>ADMIN</span>
          )}
        </span>
        <span>{formatDateTime(n.created_at, locale)}</span>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{n.body}</div>
    </div>
  );
}

function TaskNotesSection({ auth, taskId, locale, t, refreshKey }) {
  const [notes, setNotes] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Collapsed by default — only the latest note shows; older ones are
  // a click away instead of pushing the rest of the task form down.
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = () => {
    setErr('');
    taxApi.adminListTaskNotes(auth, taskId)
      .then(d => setNotes(d.notes || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [taskId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateTaskNote(auth, taskId, { body });
      setDraft('');
      load();
    } catch (e2) {
      setErr(e2?.message || t('respond.error.generic'));
    } finally { setBusy(false); }
  };

  return (
    <div>
      <label>
        {t('owner.tasks.field.notes')}
        {notes && notes.length > 0 && (
          <span style={{ color: 'var(--tax-muted)', fontWeight: 400 }}> ({notes.length})</span>
        )}
      </label>
      {/* Plain div, not <form> — this renders inside TaskFormModal's own
          outer <form>, and a nested <form> is invalid HTML; clicking this
          submit button was triggering the outer form's handler instead
          (a no-op in edit mode), so the note never actually posted. */}
      <div style={{ marginTop: 4, marginBottom: 10 }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
                  }}
                  rows={2} maxLength={4000}
                  placeholder={t('owner.tasks.notes.placeholder')}
                  title={t('owner.tasks.notes.hint')} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                  onClick={onSubmit} disabled={busy || !draft.trim()}>
            {busy ? t('lead.submitting') : t('owner.tasks.notes.addBtn')}
          </button>
        </div>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {notes === null && <p style={{ fontSize: 13, color: 'var(--tax-muted)' }}>{t('loading')}</p>}
      {notes && notes.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--tax-muted)' }}>{t('owner.tasks.notes.empty')}</p>
      )}
      {notes && notes.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <NoteCard n={notes[0]} locale={locale} t={t} />
          {notes.length > 1 && (
            <button type="button" onClick={() => setHistoryOpen(o => !o)}
                    style={{
                      justifySelf: 'start', border: 0, background: 'transparent', cursor: 'pointer',
                      color: 'var(--tax-brand-primary)', fontSize: 12, fontWeight: 600, padding: 0,
                    }}>
              {historyOpen
                ? t('owner.tasks.notes.hideHistory')
                : t('owner.tasks.notes.showHistory', { count: notes.length - 1 })}
            </button>
          )}
          {historyOpen && (
            <div style={{ display: 'grid', gap: 8, maxHeight: 280, overflowY: 'auto' }}>
              {notes.slice(1).map(n => <NoteCard key={n.id} n={n} locale={locale} t={t} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Unified create + edit modal. Customer picker is a typeahead with an
// inline "+ New customer" affordance; picking a customer auto-fills the
// service from the customer's first active relationship (best-effort —
// stays blank if no workflow rule chains to a product).
function TaskFormModal({
  mode, task, auth, community, isAdmin, isSeedOwner, isReviewer, reviewOverrideEnabled,
  statuses, employees, customers, products, relationshipTypes,
  tasks, employeeId,
  defaultAssignee, locale, t, isSimple,
  onCustomersChanged, onClose, onSaved,
}) {
  const isEdit = mode === 'edit';
  // Owner-editable per-community override (Settings → Priority
  // definitions); falls back to the platform default copy when the
  // community hasn't set one for this locale/priority.
  const priorityDef = (p) => community?.tax_task_priority_definitions?.[locale]?.[p]
    || t(`owner.tasks.priority.${p}Def`);
  const [title, setTitle] = useState(isEdit ? (task.title || '') : '');
  const [customerId, setCustomerId] = useState(isEdit ? (task.customer_id || '') : '');
  const [productId, setProductId] = useState(isEdit ? (task.product_id || '') : '');
  const [productAutoFilledFor, setProductAutoFilledFor] = useState('');
  // Leaving these blank silently defaults a new task to "practice-wide"
  // — fine when that's deliberate, surprising when it's just a field the
  // preparer skipped past. Create mode starts untouched and gates the
  // save on an explicit choice (pick one, or confirm practice-wide is
  // right); an existing task's customer/service were already resolved
  // the same way when it was first created.
  const [customerTouched, setCustomerTouched] = useState(isEdit);
  const [productTouched, setProductTouched] = useState(isEdit);
  const [statusKey, setStatusKey] = useState(
    isEdit ? task.status_key : (statuses[0]?.key || 'not_started')
  );
  const [priority, setPriority] = useState(isEdit ? task.priority : 'normal');
  const [assignedTo, setAssignedTo] = useState(
    isEdit ? (task.assigned_employee_id || '') : defaultAssignee
  );
  const [dueDate, setDueDate] = useState(isEdit ? (task.due_date || '') : '');
  const [notes, setNotes] = useState(isEdit ? (task.notes || '') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saveStatus, setSaveStatus] = useState('idle');
  const [delBusy, setDelBusy] = useState(false);
  // Not started has no real work recorded against it yet, so anyone can
  // delete it; past that, only the seeded owner account can — mirrors
  // the server-side check in DELETE /admin/tasks/:id.
  const canDelete = isEdit && (task.status_key === 'not_started' || !!isSeedOwner);
  const onDeleteTask = async () => {
    if (delBusy) return;
    if (!window.confirm(t('owner.tasks.deleteConfirm'))) return;
    setDelBusy(true);
    try { await taxApi.adminDeleteTask(auth, task.id); onSaved(); }
    catch (e) { setErr(e?.message || ''); setDelBusy(false); }
  };
  const debounceRef = useRef(null);
  const savedTimerRef = useRef(null);
  useEffect(() => () => { clearTimeout(debounceRef.current); clearTimeout(savedTimerRef.current); }, []);
  const [suggestions, setSuggestions] = useState([]);
  // Every service's suggestions, slug-tagged, fetched once regardless of
  // which service (if any) is selected — lets the title field offer rich
  // autocomplete before a service is picked, and auto-fill the matching
  // service once the typed title lands on one of these exactly.
  const [allTaggedSuggestions, setAllTaggedSuggestions] = useState([]);
  const [showInlineCreate, setShowInlineCreate] = useState(false);
  const [defaultProductHint, setDefaultProductHint] = useState(null);
  // Only close on a genuine backdrop click — i.e. the mousedown AND the
  // click both landed directly on the backdrop, not inside the panel. A
  // plain onClick==onClose on the backdrop also fires when a drag that
  // *starts* inside the panel (selecting text in Notes, dragging a date
  // picker, etc.) happens to release past the panel's edge, since the
  // browser's synthesized click target becomes the shared ancestor —
  // the backdrop itself. That's what made the modal feel like it closed
  // on an ordinary click.
  const backdropMouseDownRef = useRef(false);
  const onBackdropMouseDown = (e) => { backdropMouseDownRef.current = e.target === e.currentTarget; };
  const onBackdropClick = (e) => {
    if (backdropMouseDownRef.current && e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const product = products.find(p => p.id === productId);
    taxApi.adminTaskSuggestions(auth, product?.slug || '')
      .then(d => {
        setSuggestions(d.suggestions || []);
        // Only needed once — it's the same full catalog regardless of
        // which service is currently selected — but harmless to let it
        // refresh along with the per-service fetch.
        setAllTaggedSuggestions(d.allTagged || []);
      })
      .catch(() => setSuggestions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // title (current locale) -> productSlug, for the auto-fill-service-
  // from-title-match below. A title that happens to match more than one
  // service's suggestions is dropped from the map (ambiguous) rather
  // than guessing; it still appears in the datalist either way.
  const titleToProductSlug = useMemo(() => {
    const map = new Map();
    const dupes = new Set();
    for (const s of allTaggedSuggestions) {
      const label = pickI18n(s, locale).value || s.en || s.es;
      if (!label) continue;
      if (map.has(label) && map.get(label) !== s.productSlug) dupes.add(label);
      map.set(label, s.productSlug);
    }
    for (const label of dupes) map.delete(label);
    return map;
  }, [allTaggedSuggestions, locale]);

  // Title suggestions shown in the datalist: once a service is picked,
  // its own suggestions (plus the cross-service common pack) — same as
  // before. Before that, the full tagged catalog instead of just the
  // common pack, so typing the title first (at least as common a flow
  // as picking the service first) still gets useful autocomplete.
  const titleSuggestions = productId
    ? suggestions
    : [...new Map(allTaggedSuggestions.map(s => [pickI18n(s, locale).value || s.en || s.es, s])).values()];

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // Stamp "last viewed" once per open — lets the owner see whether the
  // assignee has actually looked at the task. Fire-and-forget: a failure
  // here shouldn't block the modal from being usable.
  useEffect(() => {
    if (!isEdit) return;
    taxApi.adminMarkTaskViewed(auth, task.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the customer changes, fetch their default product and pre-fill —
  // but only if the user hasn't manually overridden it. We track which
  // customer the auto-fill came from so a later edit to the same customer
  // doesn't stomp a manual choice.
  useEffect(() => {
    if (!customerId) { setDefaultProductHint(null); return; }
    if (productAutoFilledFor === customerId) return;
    taxApi.adminCustomerDefaultProduct(auth, customerId)
      .then(d => {
        setDefaultProductHint(d?.productId ? d : null);
        // Only auto-fill if the field is currently empty. Avoid clobbering
        // the existing selection on an edit-mode open.
        if (d?.productId && !productId) {
          setProductId(d.productId);
          setProductAutoFilledFor(customerId);
          setProductTouched(true);
        }
      })
      .catch(() => setDefaultProductHint(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  // Which services this customer is actually tagged with — drives the
  // Service field's two groups below (admin-only: the services
  // endpoints are manage_customers-gated, and a non-admin couldn't act
  // on the associate-on-the-spot flow anyway).
  const [customerServiceIds, setCustomerServiceIds] = useState(null);
  const [associatingService, setAssociatingService] = useState(false);
  useEffect(() => {
    if (!isAdmin || !customerId) { setCustomerServiceIds(null); return; }
    taxApi.adminListCustomerServices(auth, customerId)
      .then(d => setCustomerServiceIds(new Set((d.services || []).map(s => s.product_id))))
      .catch(() => setCustomerServiceIds(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, isAdmin]);

  // Owner-disabled services shouldn't be offered on a task — they're
  // retired from the catalog. Still shown if this task is ALREADY
  // pointed at one (e.g. a service disabled after the task was
  // created) so editing it doesn't silently blank the field.
  const visibleProducts = products.filter(p => p.enabled !== false || p.id === productId);

  // A task very often just starts with the service's own name ("Sales
  // Tax Filing - Q3 reconciliation", "IFTA quarterly report for Acme").
  // Longest name first so e.g. a future "Sales Tax" service (if one
  // existed) wouldn't out-match "Sales Tax Filing" for the same prefix.
  const productNamePrefixes = useMemo(() => {
    return visibleProducts
      .map(p => ({ name: pickI18n(p.name_i18n, locale).value || p.slug, product: p }))
      .filter(entry => entry.name)
      .sort((a, b) => b.name.length - a.name.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, productId, locale]);

  // Finds the service whose name the typed title starts with, if any —
  // a word boundary after the name (space/punctuation/end-of-string)
  // keeps "IFTA" from matching a title that just happens to start with
  // "IFTA..." as part of a longer, unrelated word.
  function matchProductByTitlePrefix(val) {
    const lower = val.toLowerCase();
    for (const { name, product } of productNamePrefixes) {
      const nameLower = name.toLowerCase();
      if (!lower.startsWith(nameLower)) continue;
      const next = val[name.length];
      if (next === undefined || /[^a-z0-9]/i.test(next)) return product;
    }
    return null;
  }

  // Picking a service the customer isn't tagged with yet offers to tag
  // it right here instead of forcing a trip to the customer page and
  // back — same tag-and-generate-tasks endpoint the customer detail
  // page's own service picker uses.
  const onSelectService = async (val) => {
    if (!val || !customerId || !customerServiceIds || customerServiceIds.has(val)) {
      setProductId(val);
      setProductTouched(true);
      setProductAutoFilledFor(customerId);
      saveNow({ productId: val });
      return;
    }
    const productLabel = pickI18n(products.find(p => p.id === val)?.name_i18n, locale).value || '';
    if (!window.confirm(t('owner.tasks.field.serviceAssociateConfirm', { service: productLabel }))) return;
    setAssociatingService(true);
    try {
      await taxApi.adminAddCustomerService(auth, customerId, { productId: val });
      setCustomerServiceIds(prev => new Set([...(prev || []), val]));
      setProductId(val);
      setProductTouched(true);
      setProductAutoFilledFor(customerId);
      saveNow({ productId: val });
    } catch (e) {
      window.alert(e?.message || t('respond.error.generic'));
    } finally {
      setAssociatingService(false);
    }
  };

  const doSave = useRef(null);
  doSave.current = async (overrides = {}) => {
    const t_ = overrides.title ?? title;
    const c_ = overrides.customerId ?? customerId;
    const p_ = overrides.productId ?? productId;
    const s_ = overrides.statusKey ?? statusKey;
    const pr_ = overrides.priority ?? priority;
    const a_ = overrides.assignedTo ?? assignedTo;
    const d_ = overrides.dueDate ?? dueDate;
    const n_ = overrides.notes ?? notes;
    if (!t_.trim()) { if (isEdit) { setSaveStatus('Title required'); return; } return; }
    if (isEdit) {
      setSaveStatus('saving');
      try {
        await taxApi.adminUpdateTask(auth, task.id, {
          title: t_.trim(), customerId: c_ || null, productId: p_ || null,
          statusKey: s_, priority: pr_, assignedEmployeeId: a_ || null,
          dueDate: d_ || null, notes: n_.trim(),
        });
        setSaveStatus('saved');
        onSaved();
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2500);
      } catch (e) { setSaveStatus(e?.message || 'Save failed'); }
    }
  };

  const scheduleAutoSave = (overrides = {}) => {
    if (!isEdit) return;
    clearTimeout(debounceRef.current);
    clearTimeout(savedTimerRef.current);
    debounceRef.current = setTimeout(() => doSave.current(overrides), 1200);
  };

  const saveNow = (overrides = {}) => {
    if (!isEdit) return;
    clearTimeout(debounceRef.current);
    clearTimeout(savedTimerRef.current);
    doSave.current(overrides);
  };

  // Bumped whenever a completion note gets logged (see onNewNote below)
  // so the collaborative notes history re-fetches and shows it.
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);

  // Lets TaskProgressPanel's timer-driven reminders (move to in-progress /
  // mark complete), the Status select right below, and the explicit
  // "Start task" button in the Not-started checklist change status
  // through the same path — single source of truth, same completion-
  // notes prompt. `promptKeyOverride` lets a specific trigger (the Start
  // button) use copy that explains why the prompt appeared, instead of
  // the generic "status change" wording.
  const onProgressSetStatus = (key, promptKeyOverride) => {
    // Owner/priority/due live in this same form — use the current
    // local state (not the stale `task` prop) so a value just typed
    // in, but not yet round-tripped, still counts toward the gate.
    const effectiveTask = { ...task, notes, assigned_employee_id: assignedTo, priority, due_date: dueDate };
    const fieldsMsg = notStartedFieldsMissing({ task: effectiveTask, patch: { statusKey: key }, t });
    if (fieldsMsg) { window.alert(fieldsMsg); return; }
    const patch = ensureStatusChangeNotes({
      statuses, task: effectiveTask, patch: { statusKey: key }, t,
      promptKey: promptKeyOverride,
      // Create mode has no task.id yet — the prompted note still lands
      // in local `notes` state below and gets seeded into the log once
      // the task is actually created (see onSave).
      onNewNote: isEdit ? (body) => {
        taxApi.adminCreateTaskNote(auth, task.id, { body })
          .then(() => setNotesRefreshKey(k => k + 1))
          .catch(() => {});
      } : undefined,
    });
    if (!patch) return;
    setStatusKey(patch.statusKey);
    if (patch.notes !== undefined) setNotes(patch.notes);
    saveNow(patch);
  };

  const onSave = async (e) => {
    e?.preventDefault?.();
    if (!title.trim()) { setErr(t('owner.tasks.errTitle')); return; }
    // Every new task needs a note explaining what it's for / why it
    // exists — same reasoning as requiring one on every status change
    // (see ensureStatusChangeNotes above): the task's own history should
    // explain itself without someone having to go ask the creator.
    if (!notes.trim()) { setErr(t('owner.tasks.errNotesRequired')); return; }
    // A task with a customer isn't practice-wide — it needs one of
    // that customer's services too, not a blank/unrelated one.
    if (customerId && !productId) {
      setErr(t('owner.tasks.field.serviceRequiredForCustomer'));
      return;
    }
    if (!customerTouched || !productTouched) {
      const missing = [customerTouched ? null : t('owner.tasks.field.customer'), productTouched ? null : t('owner.tasks.field.service')]
        .filter(Boolean).join(' / ');
      if (!window.confirm(t('owner.tasks.practiceWideConfirm', { fields: missing }))) return;
      setCustomerTouched(true); setProductTouched(true);
    }
    setBusy(true); setErr('');
    try {
      const trimmedNotes = notes.trim();
      const result = await taxApi.adminCreateTask(auth, {
        communitySlug: community.id,
        title: title.trim(), customerId: customerId || null, productId: productId || null,
        statusKey, priority, assignedEmployeeId: assignedTo || null,
        dueDate: dueDate || null, notes: trimmedNotes,
      });
      // Seed the collaborative notes log with the initial note typed at
      // creation, so it shows up in the same history new entries land in.
      if (trimmedNotes && result?.id) {
        taxApi.adminCreateTaskNote(auth, result.id, { body: trimmedNotes }).catch(() => {});
      }
      onSaved();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  // Quick-contact — email/WhatsApp the task's customer directly from
  // the edit modal instead of hunting them down on the Customers page.
  const selectedCustomer = customerId ? customers.find(c => c.id === customerId) : null;
  const contactMsg = selectedCustomer && title.trim()
    ? taskContactMessage({
        locale, taskTitle: title.trim(),
        firstName: selectedCustomer.first_name || displayPersonName(selectedCustomer) || '',
        communityName: community?.name || '',
      })
    : null;
  const mailHref = selectedCustomer && contactMsg ? mailtoHref(selectedCustomer.email, contactMsg) : null;
  const waHref = selectedCustomer && contactMsg
    ? whatsappHref(selectedCustomer.whatsapp || selectedCustomer.phone, contactMsg.whatsapp)
    : null;

  return (
    <div className="tax-modal" role="dialog" aria-modal="true"
         onMouseDown={onBackdropMouseDown} onClick={onBackdropClick}>
      <div className="tax-modal__panel" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <button type="button" className="tax-modal__close"
                onClick={onClose} aria-label={t('preview.close')}>×</button>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <h3 className="tax-modal__title" style={{ margin: 0 }}>
            {isEdit ? t('owner.tasks.editTitle') : t('owner.tasks.add')}
          </h3>
          {isEdit && saveStatus === 'saving' && <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>Saving…</span>}
          {isEdit && saveStatus === 'saved'  && <span style={{ fontSize: 11, color: 'var(--tax-success, #166534)' }}>✓ Saved</span>}
          {isEdit && saveStatus !== 'idle' && saveStatus !== 'saving' && saveStatus !== 'saved' && (
            <span style={{ fontSize: 11, color: 'var(--tax-error)' }}>{saveStatus}</span>
          )}
        </div>
        {canDelete && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <button type="button" onClick={onDeleteTask} disabled={delBusy}
                    style={{
                      border: 0, background: 'transparent',
                      cursor: delBusy ? 'default' : 'pointer',
                      color: 'var(--tax-error)', fontSize: 12, fontWeight: 600,
                    }}>
              {delBusy ? t('owner.tasks.deleting') : t('owner.tasks.delete')}
            </button>
          </div>
        )}
        {isEdit && (
          task.last_viewed_at ? (
            <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginBottom: 8 }}>
              {t('owner.tasks.lastViewed', {
                name: task.last_viewed_by?.name || task.last_viewed_by?.email || t('owner.tasks.lastViewed.someone'),
                date: formatDateTime(task.last_viewed_at, locale),
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700, marginBottom: 8 }}>
              {t('owner.tasks.lastViewed.never')}
            </div>
          )
        )}
        {(mailHref || waHref) && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
            {mailHref && (
              <a href={mailHref} style={{
                fontSize: 12, fontWeight: 600, color: 'var(--tax-brand-primary)', textDecoration: 'none',
              }}>✉️ {t('owner.tasks.contact.email')}</a>
            )}
            {waHref && (
              <a href={waHref} target="_blank" rel="noopener noreferrer" style={{
                fontSize: 12, fontWeight: 600, color: '#25d366', textDecoration: 'none',
              }}>💬 {t('owner.tasks.contact.whatsapp')}</a>
            )}
          </div>
        )}
        <form onSubmit={isEdit ? e => e.preventDefault() : onSave} className="tax-form" style={{ boxShadow: 'none', padding: 0, border: 0, gap: 10 }}>
          <div>
            <label>{t('owner.tasks.field.title')}</label>
            <input type="text" value={title}
                   onChange={e => {
                     const val = e.target.value;
                     setTitle(val);
                     // Picking a suggestion, or just typing a title that
                     // starts with a service's own name ("Sales Tax
                     // Filing - Q3 reconciliation"), before any service is
                     // chosen also fills in that service — one less field
                     // the preparer has to set by hand. Never overrides a
                     // service already picked.
                     let matchedProduct = null;
                     if (!productId) {
                       matchedProduct = matchProductByTitlePrefix(val);
                       if (!matchedProduct) {
                         const matchedSlug = titleToProductSlug.get(val);
                         matchedProduct = matchedSlug
                           ? visibleProducts.find(p => p.slug === matchedSlug) : null;
                       }
                     }
                     if (matchedProduct) {
                       setProductId(matchedProduct.id);
                       scheduleAutoSave({ title: val, productId: matchedProduct.id });
                     } else {
                       scheduleAutoSave({ title: val });
                     }
                   }}
                   title={t('owner.tasks.field.titleHint')}
                   maxLength={300} list="task-suggestions" required autoFocus />
            <datalist id="task-suggestions">
              {titleSuggestions.map((s, i) => (
                <option key={i} value={pickI18n(s, locale).value || s.en || s.es} />
              ))}
            </datalist>
          </div>

          <div>
            <label>{t('owner.tasks.field.customer')}</label>
            <CustomerCombobox
              customers={customers} value={customerId}
              onChange={v => {
                setCustomerId(v); setCustomerTouched(true);
                // A customer requires one of their services — the save
                // would just get rejected server-side without one, so
                // skip the round-trip and say so immediately. The
                // Service field below already re-groups off the live
                // `customerId` state, so their services are right there;
                // picking one saves both fields together (see
                // onSelectService / doSave, which always send the full
                // form state, not just the field that changed).
                if (v && !productId) {
                  window.alert(t('owner.tasks.field.serviceRequiredForCustomer'));
                  return;
                }
                saveNow({ customerId: v });
              }}
              isAdmin={isAdmin} onAddNew={() => setShowInlineCreate(true)}
              locale={locale} t={t}
            />
            {defaultProductHint?.relationshipName_i18n && productId === defaultProductHint.productId ? (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                {t('owner.tasks.field.serviceAutoFilled', {
                  relationship: pickI18n(defaultProductHint.relationshipName_i18n, locale).value || ''
                })}
              </p>
            ) : !isEdit && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                {t('owner.tasks.field.customerValueHint')}
              </p>
            )}
          </div>

          <div className="tax-form__row2">
            <div>
              <label>{t('owner.tasks.field.service')}</label>
              <select value={productId} title={t('owner.tasks.field.serviceHint')} disabled={associatingService}
                      onChange={e => onSelectService(e.target.value)}>
                <option value="">{t('owner.tasks.field.servicePractice')}</option>
                {customerId && customerServiceIds ? (
                  <>
                    {visibleProducts.filter(p => customerServiceIds.has(p.id)).length > 0 && (
                      <optgroup label={t('owner.tasks.field.serviceGroupCustomer')}>
                        {visibleProducts.filter(p => customerServiceIds.has(p.id)).map(p => (
                          <option key={p.id} value={p.id}>{pickI18n(p.name_i18n, locale).value || p.slug}</option>
                        ))}
                      </optgroup>
                    )}
                    {visibleProducts.filter(p => !customerServiceIds.has(p.id)).length > 0 && (
                      <optgroup label={t('owner.tasks.field.serviceGroupOther')}>
                        {visibleProducts.filter(p => !customerServiceIds.has(p.id)).map(p => (
                          <option key={p.id} value={p.id} style={{ color: '#9ca3af' }}>
                            {pickI18n(p.name_i18n, locale).value || p.slug}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </>
                ) : (
                  visibleProducts.map(p => (
                    <option key={p.id} value={p.id}>{pickI18n(p.name_i18n, locale).value || p.slug}</option>
                  ))
                )}
              </select>
              {!productId ? (
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                  {t('owner.tasks.field.servicePracticeNotice')}
                </p>
              ) : !customerId ? (
                // A service picked with no customer is a perfectly normal
                // combination (practice-wide work on a specific service
                // line, e.g. "Q3 sales tax filings") — called out explicitly
                // so it doesn't read as a half-finished task.
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                  {t('owner.tasks.field.servicePracticeWithService')}
                </p>
              ) : !isEdit && (
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                  {t('owner.tasks.field.serviceValueHint')}
                </p>
              )}
            </div>
            <div>
              <label>{t('owner.tasks.field.owner')}</label>
              <select value={assignedTo} title={t('owner.tasks.field.ownerHint')}
                      onChange={e => { setAssignedTo(e.target.value); saveNow({ assignedTo: e.target.value }); }}>
                <option value="">{t('owner.tasks.field.ownerNone')}</option>
                {employees.map(em => (
                  <option key={em.id} value={em.id}>{displayPersonName(em) || em.email}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="tax-form__row2">
            <div>
              <label>{t('owner.tasks.field.priority')}</label>
              <select value={priority} title={priorityDef(priority)}
                      onChange={e => { setPriority(e.target.value); saveNow({ priority: e.target.value }); }}>
                {PRIORITY_OPTIONS.map(p => (
                  <option key={p} value={p} title={priorityDef(p)}>{t(`owner.tasks.priority.${p}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label>{t('owner.tasks.field.status')}</label>
              <select value={statusKey}
                      title={(isEdit ? (task.requires_review && !task.reviewed_at) : true)
                        ? t('owner.tasks.field.statusReviewHint') : t('owner.tasks.field.statusHint')}
                      onChange={e => onProgressSetStatus(e.target.value)}>
                {statusSelectOptions(statuses, isEdit ? task : { requires_review: true, reviewed_at: null }, t, locale).map(opt => (
                  <option key={opt.id} value={opt.key}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Visible up front, not just as a block-on-attempt — shows
              exactly what's missing before the operator tries to move
              the status and gets stopped. Drops away once the task has
              actually moved past Not started. */}
          {statusKey === 'not_started' && (
            <div style={{
              padding: '8px 10px', borderRadius: 8,
              background: 'var(--tax-bg-alt)', fontSize: 12,
            }}>
              <div style={{ fontWeight: 600, color: 'var(--tax-muted)', marginBottom: 4 }}>
                {t('owner.tasks.notStartedChecklist.heading')}
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ color: assignedTo ? 'var(--tax-success, #166534)' : 'var(--tax-muted)' }}>
                  {assignedTo ? '✓' : '○'} {t('owner.tasks.field.owner')}
                </span>
                <span style={{ color: priority ? 'var(--tax-success, #166534)' : 'var(--tax-muted)' }}>
                  {priority ? '✓' : '○'} {t('owner.tasks.field.priority')}
                </span>
                <span style={{ color: dueDate ? 'var(--tax-success, #166534)' : 'var(--tax-muted)' }}>
                  {dueDate ? '✓' : '○'} {t('owner.tasks.field.due')}
                </span>
              </div>
              {isEdit && (
                <button type="button"
                        onClick={() => onProgressSetStatus('in_progress', 'owner.tasks.startNotesPrompt')}
                        className="tax-btn tax-btn--sm"
                        style={{
                          marginTop: 10, border: 'none',
                          background: (assignedTo && priority && dueDate) ? '#166534' : 'var(--tax-border)',
                          color: (assignedTo && priority && dueDate) ? '#fff' : 'var(--tax-muted)',
                        }}>
                  {t('owner.tasks.startTask')}
                </button>
              )}
            </div>
          )}

          <div>
            <label>{t('owner.tasks.field.due')}</label>
            <input type="date" value={dueDate} title={t('owner.tasks.field.dueHint')}
                   onChange={e => { setDueDate(e.target.value); saveNow({ dueDate: e.target.value }); }} />
          </div>

          {isEdit ? (
            <TaskNotesSection auth={auth} taskId={task.id} locale={locale} t={t} refreshKey={notesRefreshKey} />
          ) : (
            <div>
              <label>{t('owner.tasks.field.notes')} <span style={{ color: 'var(--tax-error)', fontWeight: 400 }}>*</span></label>
              <textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000}
                        placeholder={t('owner.tasks.notes.placeholder')}
                        title={t('owner.tasks.notes.hint.create')} />
            </div>
          )}

          {isEdit && !isSimple && (
            <TaskProgressPanel task={task} tasks={tasks}
                                isAdmin={isAdmin} isReviewer={isReviewer}
                                reviewOverrideEnabled={reviewOverrideEnabled}
                                statuses={statuses} currentStatusKey={statusKey}
                                auth={auth} locale={locale} t={t} />
          )}

          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            {!isEdit && (
              <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
                {busy ? t('lead.submitting') : t('owner.tasks.create')}
              </button>
            )}
            <button type="button" className="tax-btn tax-btn--ghost"
                    onClick={onClose} style={{ color: 'var(--tax-text)' }}>
              {t('preview.close')}
            </button>
          </div>
        </form>
      </div>

      {showInlineCreate && (
        <InlineCustomerCreateModal
          auth={auth} community={community}
          relationshipTypes={relationshipTypes}
          locale={locale} t={t}
          onClose={() => setShowInlineCreate(false)}
          onCreated={(c) => {
            setShowInlineCreate(false);
            onCustomersChanged?.(c);
            setCustomerId(c.id);
            setCustomerTouched(true);
          }}
        />
      )}
    </div>
  );
}

// Expand/collapse wrapper for a labeled block inside the task edit
// panel — lets Blocked-by / Review only take up space when there's
// something to look at or the operator asked to see it. `badge`
// (e.g. a status pill) still renders next to the title while
// collapsed, so a glance at the closed header is enough to tell
// whether it needs opening. defaultOpen only decides the first
// render; the user's own toggle wins after that.
function CollapsibleField({ title, badge, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
                textAlign: 'left', fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)',
              }}>
        <span aria-hidden="true" style={{
          fontSize: 10, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .1s',
        }}>▸</span>
        <span>{title}</span>
        {badge}
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

// Per-task progress surface — the part of the picture the plain status
// dropdown doesn't show: is this task blocked on another one, does it
// need a reviewer's sign-off before it really counts as done, and how
// long it's actually been sitting in its current status. Self-contained
// on purpose — it manages its own save calls instead of going through
// the parent form's autosave/onSaved plumbing, so approving a review
// never risks closing the modal.
function TaskProgressPanel({ task, tasks, isAdmin, isReviewer, reviewOverrideEnabled, statuses, currentStatusKey, auth, locale, t }) {
  // ── Time summary — fully automatic, no manual start/stop. Computed
  // from status_changed_at (bumped server-side on every status
  // transition) and created_at; frozen once the task is completed.
  // Re-renders on a slow interval so an open modal doesn't show a
  // stale "just now" forever.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (task.completed_at) return;
    const id = setInterval(() => forceTick(n => n + 1), 60000);
    return () => clearInterval(id);
  }, [task.completed_at]);

  const currentStatus = (statuses || []).find(s => s.key === currentStatusKey);
  const currentStatusLabel = pickI18n(currentStatus?.label_i18n, locale).value || currentStatusKey;
  const endForDuration = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const createdAtMs = task.created_at ? new Date(task.created_at).getTime() : endForDuration;
  const statusStartMs = task.status_changed_at ? new Date(task.status_changed_at).getTime() : createdAtMs;
  const secondsInStatus = Math.max(0, Math.round((endForDuration - statusStartMs) / 1000));
  const secondsTotalAge = Math.max(0, Math.round((endForDuration - createdAtMs) / 1000));

  // ── Review ──────────────────────────────────────────────────────────────
  const [requiresReview, setRequiresReview] = useState(!!task.requires_review);
  const [reviewConfigBusy, setReviewConfigBusy] = useState(false);
  const [reviewConfigErr, setReviewConfigErr] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewErr, setReviewErr] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [reviewDecision, setReviewDecision] = useState(null); // local override right after approve/reject

  const approved = reviewDecision === 'approve' || !!task.reviewed_at;
  const changesRequested = reviewDecision === 'reject';
  const pendingReview = !approved && !changesRequested && !!task.pending_review_at && !task.reviewed_at;
  // Only the Reviewer role can review/complete — no delegation to
  // another admin, matches the server gate on POST /admin/tasks/:id/
  // review and the direct-to-completed path in PATCH /admin/tasks/:id.

  const onSetRequiresReview = async (val) => {
    setRequiresReview(val);
    setReviewConfigBusy(true); setReviewConfigErr('');
    try { await taxApi.adminUpdateTask(auth, task.id, { requiresReview: val }); }
    catch (e) { setReviewConfigErr(e?.message || ''); }
    finally { setReviewConfigBusy(false); }
  };
  const onReview = async (decision) => {
    // Sending it back with nothing but a status change leaves the
    // preparer guessing — matches the server-side note_required check.
    if (decision === 'reject' && !reviewNote.trim()) {
      setReviewErr(t('owner.tasks.progress.reviewNoteRequired'));
      return;
    }
    setReviewBusy(true); setReviewErr('');
    try {
      await taxApi.adminReviewTask(auth, task.id, { decision, note: reviewNote.trim() });
      setReviewDecision(decision);
    } catch (e) { setReviewErr(e?.message || ''); }
    finally { setReviewBusy(false); }
  };

  // ── Blocked by ────────────────────────────────────────────────────────
  const [blockedByTaskId, setBlockedByTaskId] = useState(task.blocked_by_task_id || '');
  const [blockedBusy, setBlockedBusy] = useState(false);
  const [blockedErr, setBlockedErr] = useState('');
  const blocker = (tasks || []).find(x => x.id === blockedByTaskId);
  const blockerDone = blocker ? !!blocker.completed_at : true;

  const onSetBlockedBy = async (id) => {
    setBlockedByTaskId(id);
    setBlockedBusy(true); setBlockedErr('');
    try { await taxApi.adminUpdateTask(auth, task.id, { blockedByTaskId: id }); }
    catch (e) { setBlockedErr(e?.message || ''); }
    finally { setBlockedBusy(false); }
  };

  const badgeStyle = (bg, fg) => ({
    fontSize: 11, fontWeight: 700, color: fg, background: bg,
    padding: '1px 8px', borderRadius: 999,
  });

  return (
    <div style={{
      marginTop: 6, padding: 10, borderRadius: 10,
      background: 'var(--tax-bg-alt)', display: 'grid', gap: 10,
    }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{t('owner.tasks.progress.heading')}</div>

      {/* Blocked by — collapsed unless a blocker is actually set, so an
          unblocked task (the common case) doesn't spend space on it. */}
      <CollapsibleField
        title={t('owner.tasks.progress.blockedBy')}
        defaultOpen={!!blockedByTaskId}
        badge={blocker && (
          <span style={badgeStyle(
            blockerDone ? '#dcfce7' : '#fef3c7',
            blockerDone ? '#166534' : '#92400e',
          )}>
            {blockerDone ? t('owner.tasks.progress.blockerDone') : t('owner.tasks.progress.blockerNotDone')}
          </span>
        )}>
        {isAdmin ? (
          <select value={blockedByTaskId} disabled={blockedBusy}
                  title={t('owner.tasks.progress.blockedByHint')}
                  onChange={e => onSetBlockedBy(e.target.value)}>
            <option value="">{t('owner.tasks.progress.blockedByNone')}</option>
            {(tasks || []).filter(x => x.id !== task.id).map(x => (
              <option key={x.id} value={x.id}>
                {x.title}{x.completed_at ? ` (${t('owner.tasks.progress.done')})` : ''}
              </option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 13, marginTop: 2 }}>
            {blocker ? blocker.title : t('owner.tasks.progress.blockedByNone')}
          </div>
        )}
        {blockedErr && <div className="tax-msg tax-msg--error" style={{ marginTop: 4 }}>{blockedErr}</div>}
      </CollapsibleField>

      {/* Review — open by default whenever review is actually required
          (true for virtually every task), since that's exactly the
          state an operator needs visible, not tucked behind a toggle.
          Only collapses for a task that genuinely doesn't need it. */}
      <CollapsibleField
        title={t('owner.tasks.progress.review')}
        defaultOpen={requiresReview || pendingReview || changesRequested}
        badge={
          (approved && <span style={badgeStyle('#dcfce7', '#166534')}>{t('owner.tasks.progress.reviewApproved')}</span>) ||
          (pendingReview && <span style={badgeStyle('#fffbeb', '#92400e')}>{t('owner.tasks.progress.reviewPending')}</span>) ||
          (changesRequested && <span style={badgeStyle('#fee2e2', '#991b1b')}>{t('owner.tasks.progress.reviewChangesRequested')}</span>) ||
          null
        }>
        {isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                   title={!reviewOverrideEnabled ? t('owner.tasks.progress.requiresReviewLocked') : t('owner.tasks.progress.requiresReviewHint')}>
              <input type="checkbox" checked={requiresReview}
                     disabled={reviewConfigBusy || !reviewOverrideEnabled}
                     onChange={e => onSetRequiresReview(e.target.checked)} />
              {t('owner.tasks.progress.requiresReview')}
            </label>
          </div>
        )}
        {/* No reviewer picker — review always goes to the owner, never a
            delegated admin, so there's nothing to assign. */}
        {!isAdmin && requiresReview && (
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
            {t('owner.tasks.progress.reviewerAny')}
          </div>
        )}
        {reviewConfigErr && <div className="tax-msg tax-msg--error" style={{ marginTop: 4 }}>{reviewConfigErr}</div>}

        {pendingReview && isReviewer && (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            <textarea rows={2} placeholder={t('owner.tasks.progress.reviewNotePlaceholder')}
                      title={t('owner.tasks.progress.reviewNoteHint')}
                      value={reviewNote} onChange={e => setReviewNote(e.target.value)} maxLength={4000} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" disabled={reviewBusy}
                      title={t('owner.tasks.progress.approveHint')}
                      onClick={() => onReview('approve')}>
                {t('owner.tasks.progress.approve')}
              </button>
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={reviewBusy}
                      style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}
                      title={t('owner.tasks.progress.requestChangesHint')}
                      onClick={() => onReview('reject')}>
                {t('owner.tasks.progress.requestChanges')}
              </button>
            </div>
          </div>
        )}
        {reviewErr && <div className="tax-msg tax-msg--error" style={{ marginTop: 4 }}>{reviewErr}</div>}
      </CollapsibleField>

      {/* Time — fully automatic, no manual start/stop. Two numbers:
          how long the task has sat in its current status, and its
          total age since creation. */}
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}
               title={t('owner.tasks.progress.timeSummaryHint')}>
          {t('owner.tasks.progress.timeSummary')}
        </label>
        <div style={{ fontSize: 13, marginTop: 2 }}>
          {t('owner.tasks.progress.timeInStatus', { duration: formatDuration(secondsInStatus), status: currentStatusLabel })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
          {t('owner.tasks.progress.timeTotalAge', { duration: formatDuration(secondsTotalAge) })}
        </div>
      </div>
    </div>
  );
}

// Searchable customer combobox. Renders an input + dropdown; matches
// against name, email, phone. When non-admin or no match, only existing
// customers can be selected. Admins also see a "+ New customer" entry
// at the bottom that opens an inline-create modal.
function CustomerCombobox({ customers, value, onChange, isAdmin, onAddNew, locale, t }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  const selected = customers.find(c => c.id === value) || null;
  const display = selected ? (displayPersonName(selected) || selected.email) : '';

  // Re-seed the visible input when the parent changes value (e.g. inline-
  // create just picked a new customer).
  useEffect(() => { if (!open) setQuery(''); }, [value, open]);

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers.slice(0, 20);
    return customers.filter(c => {
      const hay = `${c.business_name || ''} ${c.name || ''} ${c.first_name || ''} ${c.last_name || ''} ${c.email || ''} ${c.phone || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 30);
  })();

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef} type="text"
        value={open ? query : display}
        onFocus={() => setOpen(true)}
        onChange={e => { setOpen(true); setQuery(e.target.value); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={t('owner.tasks.field.customerSearch')}
        title={t('owner.tasks.field.customerHint')}
        autoComplete="off"
      />
      {value && !open && (
        <button type="button"
                onClick={() => { onChange(''); setQuery(''); inputRef.current?.focus(); }}
                aria-label={t('owner.tasks.field.customerClear')}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  border: 0, background: 'transparent', cursor: 'pointer',
                  fontSize: 18, color: 'var(--tax-muted)', lineHeight: 1,
                }}>×</button>
      )}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
          maxHeight: 280, overflowY: 'auto',
          background: '#fff', border: '1px solid var(--tax-border)',
          borderRadius: 6, boxShadow: '0 8px 16px rgba(0,0,0,.08)',
          zIndex: 50,
        }}>
          <button type="button" onMouseDown={e => { e.preventDefault(); onChange(''); setOpen(false); }}
                  style={comboItemStyle(value === '')}>
            <span style={{ color: 'var(--tax-muted)' }}>
              {t('owner.tasks.field.customerNone')}
            </span>
          </button>
          {filtered.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--tax-muted)' }}>
              {t('owner.tasks.field.customerNoMatch')}
            </div>
          )}
          {filtered.map(c => {
            const name = displayPersonName(c) || c.email;
            // When the customer is a business, surface the contact
            // person on the second line so the picker still shows
            // both names — useful for "Acme LLC (John Smith)".
            const contact = c.business_name
              ? [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
              : '';
            return (
              <button key={c.id} type="button"
                      onMouseDown={e => { e.preventDefault(); onChange(c.id); setOpen(false); }}
                      style={comboItemStyle(value === c.id)}>
                <div style={{ fontWeight: 500 }}>{name}</div>
                <div style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
                  {contact ? `${contact} · ` : ''}{c.email}{c.phone ? ` · ${c.phone}` : ''}
                </div>
              </button>
            );
          })}
          {isAdmin && (
            <button type="button" onMouseDown={e => { e.preventDefault(); onAddNew(); setOpen(false); }}
                    style={{
                      ...comboItemStyle(false),
                      borderTop: '1px solid var(--tax-border)',
                      color: 'var(--tax-brand-primary)', fontWeight: 600,
                    }}>
              + {t('owner.tasks.field.customerCreate')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function comboItemStyle(active) {
  return {
    display: 'block', width: '100%', textAlign: 'left',
    padding: '8px 12px', border: 0, cursor: 'pointer',
    background: active ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : 'transparent',
    fontSize: 13,
  };
}

// Lightweight inline customer-create. Asks for the minimum the welcome-
// email path needs (email, name) plus the first relationship type so the
// "default service" lookup has something to chain on after creation.
function InlineCustomerCreateModal({ auth, community, relationshipTypes, locale, t, onClose, onCreated }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [relTypeId, setRelTypeId] = useState('');
  const [sendWelcome, setSendWelcome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    if (!email.trim() || !firstName.trim()) {
      setErr(t('owner.tasks.customerCreateErr')); return;
    }
    setBusy(true); setErr('');
    try {
      const resp = await taxApi.adminCreateCustomer(auth, {
        communitySlug: community.id,
        email: email.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        businessName: businessName.trim(),
        phone: phone.trim(),
        locale,
        relationshipTypeIds: relTypeId ? [relTypeId] : [],
        sendWelcomeEmail: sendWelcome,
      });
      const relRows = relTypeId ? [{
        relationship_type_id: relTypeId, active: true,
        type: relationshipTypes.find(r => r.id === relTypeId) || null,
      }] : [];
      onCreated({
        id: resp.id, email: email.trim(),
        first_name: firstName.trim(), last_name: lastName.trim(),
        business_name: businessName.trim(),
        name: `${firstName.trim()} ${lastName.trim()}`.trim(),
        phone: phone.trim(), locale, status: 'active',
        relationships: relRows,
      });
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-modal" role="dialog" aria-modal="true"
         onClick={onClose}
         style={{ zIndex: 60 }}>
      <div className="tax-modal__panel" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <button type="button" className="tax-modal__close"
                onClick={onClose} aria-label={t('preview.close')}>×</button>
        <h3 className="tax-modal__title">{t('owner.tasks.field.customerCreate')}</h3>
        <form onSubmit={onSubmit} className="tax-form" style={{ boxShadow: 'none', padding: 0, border: 0 }}>
          <div>
            <label>{t('owner.tasks.field.businessName')}</label>
            <input type="text" value={businessName} onChange={e => setBusinessName(e.target.value)}
                   maxLength={200}
                   placeholder={t('owner.tasks.field.businessNamePlaceholder')} />
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
              {t('owner.tasks.field.businessNameHint')}
            </p>
          </div>
          <div className="tax-form__row2">
            <div>
              <label>{t('owner.tasks.field.firstName')}</label>
              <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)}
                     maxLength={200} required autoFocus />
            </div>
            <div>
              <label>{t('owner.tasks.field.lastName')}</label>
              <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} maxLength={200} />
            </div>
          </div>
          <div className="tax-form__row2">
            <div>
              <label>{t('owner.tasks.field.emailLabel')}</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                     maxLength={200} required />
            </div>
            <div>
              <label>{t('owner.tasks.field.phoneLabel')}</label>
              <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={50} />
            </div>
          </div>
          {relationshipTypes.length > 0 && (
            <div>
              <label>{t('owner.tasks.field.relationship')}</label>
              <select value={relTypeId} onChange={e => setRelTypeId(e.target.value)}>
                <option value="">{t('owner.tasks.field.relationshipNone')}</option>
                {relationshipTypes.map(rt => (
                  <option key={rt.id} value={rt.id}>{pickI18n(rt.name_i18n, locale).value || rt.slug}</option>
                ))}
              </select>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                {t('owner.tasks.field.relationshipHint')}
              </p>
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={sendWelcome} onChange={e => setSendWelcome(e.target.checked)} />
            {t('owner.tasks.field.sendWelcome')}
          </label>

          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
              {busy ? t('lead.submitting') : t('owner.tasks.customerCreateBtn')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost"
                    onClick={onClose} style={{ color: 'var(--tax-text)' }}>
              {t('preview.close')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Toolbar: My-tasks toggle + due chips + view-mode + group-by ─────────
function TaskToolbar({ mine, setMine, hideCompleted, setHideCompleted, filters, setFilters, view, setView, groupBy, setGroupBy, sortKey, setSortKey, periodsGroup, setPeriodsGroup, simple, t }) {
  const DUE_CHIPS = [
    { key: '',         label: t('owner.tasks.chip.all') },
    { key: 'overdue',  label: t('owner.tasks.chip.overdue') },
    { key: 'today',    label: t('owner.tasks.chip.today') },
    { key: 'week',     label: t('owner.tasks.chip.week7') },
    { key: 'month',    label: t('owner.tasks.chip.month30') },
    { key: 'month60',  label: t('owner.tasks.chip.month60') },
    { key: 'month90',  label: t('owner.tasks.chip.month90') },
  ];
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
      padding: 10, marginBottom: 10, background: 'var(--tax-bg-alt)', borderRadius: 8,
    }}>
      <Pill active={mine} onClick={() => setMine(m => !m)}>
        👤 {t('owner.tasks.chip.mine')}
      </Pill>
      <Pill active={hideCompleted} onClick={() => setHideCompleted(h => !h)}>
        🙈 {t('owner.tasks.chip.hideCompleted')}
      </Pill>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {DUE_CHIPS.map(c => (
          <Pill key={c.key || 'all'} active={filters.due === c.key}
                onClick={() => setFilters(prev => ({ ...prev, due: c.key }))}>
            {c.label}
          </Pill>
        ))}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {!simple && (view === 'list' || view === 'kanban') && (
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700 }}>
              {t('owner.tasks.groupBy.label')}
            </span>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value)}
                    style={{ padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 12 }}>
              <option value="none">{t('owner.tasks.groupBy.none')}</option>
              <option value="employee">{t('owner.tasks.groupBy.employee')}</option>
              <option value="service">{t('owner.tasks.groupBy.service')}</option>
              <option value="customer">{t('owner.tasks.groupBy.customer')}</option>
              {view === 'list' && <option value="dueBucket">{t('owner.tasks.groupBy.dueBucket')}</option>}
            </select>
          </label>
        )}
        {!simple && view === 'list' && (
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700 }}>
              {t('owner.tasks.sort.label')}
            </span>
            <select value={sortKey} onChange={e => setSortKey(e.target.value)}
                    style={{ padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 12 }}>
              <option value="dueAsc">{t('owner.tasks.sort.dueAsc')}</option>
              <option value="dueDesc">{t('owner.tasks.sort.dueDesc')}</option>
              <option value="priority">{t('owner.tasks.sort.priority')}</option>
              <option value="createdDesc">{t('owner.tasks.sort.createdDesc')}</option>
              <option value="createdAsc">{t('owner.tasks.sort.createdAsc')}</option>
            </select>
          </label>
        )}
        {!simple && view === 'periods' && (
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700 }}>
              {t('owner.tasks.groupBy.label')}
            </span>
            <select value={periodsGroup} onChange={e => setPeriodsGroup(e.target.value)}
                    style={{ padding: '4px 6px', border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 12 }}>
              <option value="period">{t('owner.tasks.periodsGroup.period')}</option>
              <option value="service">{t('owner.tasks.periodsGroup.service')}</option>
              <option value="month">{t('owner.tasks.periodsGroup.month')}</option>
            </select>
          </label>
        )}
        {!simple && (
          <div role="tablist" style={{
            display: 'inline-flex', border: '1px solid var(--tax-border)', borderRadius: 6, overflow: 'hidden',
          }}>
            {['kanban', 'calendar', 'list'].map(v => (
              <button key={v} type="button" onClick={() => setView(v)}
                      style={{
                        padding: '6px 10px', border: 0, cursor: 'pointer',
                        background: view === v
                          ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                          : '#fff',
                        color: view === v ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                        fontWeight: view === v ? 700 : 500, fontSize: 12,
                      }}>
                {t(`owner.tasks.view.${v}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
function Pill({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
            style={{
              padding: '4px 12px', borderRadius: 999,
              border: '1px solid',
              borderColor: active
                ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                : 'var(--tax-border)',
              background: active
                ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                : '#fff',
              color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
              fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer',
            }}>
      {children}
    </button>
  );
}

// ─── Due-pill shared across views ────────────────────────────────────────
function DuePill({ dueDate, thresholds, t }) {
  if (!dueDate) return null;
  const u = urgencyOf(dueDate, thresholds);
  const c = colorOf(u);
  return (
    <span title={t ? `${t('owner.tasks.due')}: ${dueDate}` : dueDate}
          style={{
            padding: '1px 8px', borderRadius: 999,
            background: c.bg, color: c.fg,
            fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
          }}>
      {dueDate}
    </span>
  );
}

// ─── Grouped list view ───────────────────────────────────────────────────
function TasksGroupedList({ tasks, groupBy, community, statuses, employees,
                            customerById, employeeById, productById, isAdmin, employeeId, isSeedOwner,
                            auth, onEdit, onChange,
                            selectedIds, toggleSelect, selectMany,
                            locale, t }) {
  if (groupBy === 'none') {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <GroupSelectAll tasks={tasks} selectedIds={selectedIds}
                        toggleSelect={toggleSelect} selectMany={selectMany} t={t} />
        {tasks.map(task => (
          <TaskRow key={task.id} task={task} auth={auth} community={community}
                   statuses={statuses} employees={employees}
                   customerById={customerById} employeeById={employeeById}
                   productById={productById} isAdmin={isAdmin} employeeId={employeeId} isSeedOwner={isSeedOwner}
                   onEdit={() => onEdit(task)}
                   onChange={onChange}
                   selected={selectedIds?.has(task.id)}
                   onToggleSelect={toggleSelect ? () => toggleSelect(task.id) : undefined}
                   locale={locale} t={t} />
        ))}
      </div>
    );
  }

  const thresholds = resolveThresholds(community);
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map();
  const keyFor = (task) => {
    if (groupBy === 'employee') {
      const e = task.assignee || (task.assigned_employee_id ? employeeById.get(task.assigned_employee_id) : null);
      return [e?.id || '__unassigned__', e ? (displayPersonName(e) || e.email) : t('owner.tasks.groupBy.unassigned')];
    }
    if (groupBy === 'service') {
      const p = task.product || (task.product_id ? productById.get(task.product_id) : null);
      return [p?.id || '__none__', p ? (pickI18n(p.name_i18n, locale).value || p.slug) : t('owner.tasks.groupBy.noService')];
    }
    if (groupBy === 'customer') {
      const c = task.customer || (task.customer_id ? customerById.get(task.customer_id) : null);
      return [c?.id || '__none__', c ? (c.business_name || displayPersonName(c) || c.email) : t('owner.tasks.groupBy.practiceWide'), c ? customerTypeIcon(c.customer_type) : null];
    }
    if (groupBy === 'dueBucket') {
      const u = effectiveUrgency(task, thresholds, today);
      return [u, t(URGENCY_LABEL_KEY[u])];
    }
    return ['__none__', ''];
  };
  for (const task of tasks) {
    const [key, label, icon] = keyFor(task);
    const slot = groups.get(key) || { label, icon, items: [] };
    slot.items.push(task);
    groups.set(key, slot);
  }

  // Stable ordering — overdue first for dueBucket, alpha for the rest.
  const order = groupBy === 'dueBucket'
    ? ['overdue', 'urgent', 'soon', 'upcoming', 'later']
    : Array.from(groups.keys()).sort((a, b) => {
        if (a === '__unassigned__' || a === '__none__') return 1;
        if (b === '__unassigned__' || b === '__none__') return -1;
        return groups.get(a).label.localeCompare(groups.get(b).label);
      });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {order.filter(k => groups.has(k)).map(k => {
        const g = groups.get(k);
        return (
          <section key={k}>
            <h3 style={{
              margin: '0 0 8px', fontSize: 13, color: 'var(--tax-muted)',
              textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700,
            }}>
              {g.icon && <span aria-hidden="true">{g.icon} </span>}
              {g.label} <span style={{ marginLeft: 4, fontWeight: 500 }}>· {g.items.length}</span>
            </h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <GroupSelectAll tasks={g.items} selectedIds={selectedIds}
                              toggleSelect={toggleSelect} selectMany={selectMany} t={t} />
              {g.items.map(task => (
                <TaskRow key={task.id} task={task} auth={auth} community={community}
                         statuses={statuses} employees={employees}
                         customerById={customerById} employeeById={employeeById}
                         productById={productById} isAdmin={isAdmin} employeeId={employeeId} isSeedOwner={isSeedOwner}
                         onEdit={() => onEdit(task)}
                         onChange={onChange}
                         selected={selectedIds?.has(task.id)}
                         onToggleSelect={toggleSelect ? () => toggleSelect(task.id) : undefined}
                         locale={locale} t={t} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─── Calendar view ───────────────────────────────────────────────────────
// TaskHover (hover card shared by Calendar / Kanban / Dashboard) lives
// in components/TaskHover.jsx so other pages can reuse it.

// ─── Periods view — one row per (auto-task, due-date) ──────────────────
// At ~300 customers each tagged to several services, the flat task
// list has thousands of "Monthly Reconciliation — May 2026" rows that
// differ only by customer. This view collapses them into a single
// row per period so the operator sees aggregate progress at a glance,
// then expands a row to see / act on the underlying customer tasks.
// Derive a human-readable period label from the auto-task's cadence
// + due date. Monthly cadences are "following": work done in April
// is due mid-May, so the period for a May 15 due-date is April. The
// schedule engine already encodes these rules — this mirror keeps
// the rollup header in sync without a server round-trip.
const MONTH_LABELS = {
  en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
  es: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
};
function periodLabelFor(cadenceKind, dueDateIso, locale) {
  if (!dueDateIso) return '';
  const dd = new Date(dueDateIso + 'T00:00:00Z');
  if (Number.isNaN(dd.getTime())) return '';
  const y = dd.getUTCFullYear();
  const m = dd.getUTCMonth();
  const months = MONTH_LABELS[locale === 'en' ? 'en' : 'es'];
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (cadenceKind === 'monthly') {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    return `${cap(months[pm])} ${py}`;
  }
  if (cadenceKind === 'quarterly') {
    const dueMonth = m + 1;
    let qIdx, periodYear = y;
    if (dueMonth >= 1 && dueMonth <= 3) { qIdx = 4; periodYear = y - 1; }
    else if (dueMonth >= 4 && dueMonth <= 6) qIdx = 1;
    else if (dueMonth >= 7 && dueMonth <= 9) qIdx = 2;
    else qIdx = 3;
    return locale === 'es' ? `T${qIdx} ${periodYear}` : `Q${qIdx} ${periodYear}`;
  }
  if (cadenceKind === 'annual') {
    const taxYear = y - 1;
    return locale === 'es' ? `Año Fiscal ${taxYear}` : `Tax Year ${taxYear}`;
  }
  if (cadenceKind === 'weekly') {
    const start = new Date(dd); start.setUTCDate(start.getUTCDate() - 6);
    const sIso = start.toISOString().slice(0, 10);
    return locale === 'es' ? `Semana del ${sIso}` : `Week of ${sIso}`;
  }
  return '';
}

function TasksPeriods({ auth, community, filters, statuses, employees, customerById,
                        employeeById, productById, isAdmin, isSeedOwner, onEdit,
                        selectedIds, toggleSelect, selectMany,
                        periodsGroup = 'period',
                        mine, employeeId, hideCompleted, locale, t }) {
  const [periods, setPeriods] = useState(null);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState({});
  // Group parent expansion (only used when periodsGroup !== 'period').
  // Default open so the operator sees everything on first land; they
  // can collapse individual buckets to focus.
  const [groupExpanded, setGroupExpanded] = useState({});
  useEffect(() => {
    // Default every bucket to open whenever the grouping flips.
    if (!periods) return;
    if (periodsGroup === 'period') { setGroupExpanded({}); return; }
    const next = {};
    for (const p of periods) {
      const k = periodsGroup === 'service'
        ? (p.serviceAutoTaskId || '__none__')
        : ((p.dueDate || '').slice(0, 7) || '__none__');
      next[k] = true;
    }
    setGroupExpanded(next);
  }, [periodsGroup, periods]);
  const [periodTasks, setPeriodTasks] = useState({}); // key → tasks[] or 'loading'
  const thresholds = resolveThresholds(community);
  const todayIso = new Date().toISOString().slice(0, 10);

  const load = () => {
    if (!auth?.uid || !community?.id) return;
    const flat = (v) => Array.isArray(v) ? v.join(',') : v;
    const merged = {
      communitySlug: community.id,
      status: flat(filters.status),
      priority: filters.priority,
      assignedTo: flat(filters.assignedTo),
      productId: flat(filters.productId),
      customerId: flat(filters.customerId),
      due: filters.due,
    };
    if (mine && employeeId) merged.assignedTo = employeeId;
    taxApi.adminListTaskPeriods(auth, merged)
      .then(d => setPeriods(d.periods || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  // Refetch whenever the toolbar filters or community change.
  useEffect(load,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth?.uid, community?.id, JSON.stringify(filters), mine, employeeId]);

  const toggle = async (p) => {
    const isOpen = !!expanded[p.key];
    setExpanded(s => ({ ...s, [p.key]: !isOpen }));
    if (isOpen) return;
    if (periodTasks[p.key]) return; // already fetched
    setPeriodTasks(s => ({ ...s, [p.key]: 'loading' }));
    const flat = (v) => Array.isArray(v) ? v.join(',') : v;
    try {
      const d = await taxApi.adminListTasks(auth, {
        communitySlug: community.id,
        serviceAutoTaskId: p.serviceAutoTaskId,
        dueDateExact: p.dueDate || '',
        status: flat(filters.status),
        assignedTo: flat(filters.assignedTo),
        customerId: flat(filters.customerId),
        priority: filters.priority,
        hideCompleted: hideCompleted ? '1' : undefined,
        limit: 500,
      });
      setPeriodTasks(s => ({ ...s, [p.key]: d.tasks || [] }));
    } catch (e) {
      setPeriodTasks(s => ({ ...s, [p.key]: [] }));
    }
  };

  if (err) return <div className="tax-msg tax-msg--error">{err}</div>;
  if (periods === null) return <p>{t('loading')}</p>;
  if (periods.length === 0) {
    return <p style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.periods.empty')}</p>;
  }

  const renderPeriod = (p, opts = {}) => (
    <PeriodCard key={p.key} period={p}
                isOpen={!!expanded[p.key]}
                onToggle={() => toggle(p)}
                cached={periodTasks[p.key]}
                auth={auth} community={community} thresholds={thresholds} todayIso={todayIso}
                statuses={statuses} employees={employees}
                customerById={customerById} employeeById={employeeById}
                productById={productById} isAdmin={isAdmin} isSeedOwner={isSeedOwner}
                selectedIds={selectedIds} toggleSelect={toggleSelect} selectMany={selectMany}
                onEdit={onEdit}
                onTaskChange={() => {
                  setPeriodTasks(s => ({ ...s, [p.key]: null }));
                  setExpanded(s => ({ ...s, [p.key]: false }));
                  setTimeout(() => toggle(p), 0);
                  load();
                }}
                hideServiceLabel={opts.hideServiceLabel}
                indent={opts.indent}
                locale={locale} t={t} />
  );

  // No grouping → flat list, unchanged behavior.
  if (periodsGroup === 'period') {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {periods.map(p => renderPeriod(p))}
      </div>
    );
  }

  // Bucket periods by service auto-task or by due-month, then render
  // a collapsible parent above each bucket with rolled-up totals.
  const buckets = new Map();
  for (const p of periods) {
    let key, label, sortKey;
    if (periodsGroup === 'service') {
      key = p.serviceAutoTaskId || '__none__';
      const svc = p.product
        ? (pickI18n(p.product.name_i18n, locale).value || p.product.slug)
        : '';
      const at = pickI18n(p.autoTask?.title_i18n, locale).value || '';
      label = svc && at ? `${svc} — ${at}` : (svc || at || '—');
      sortKey = label.toLowerCase();
    } else {
      // Month: bucket by the period's due-month so the parent reads
      // as "May 2026 — due this month".
      const yyyymm = (p.dueDate || '').slice(0, 7);
      key = yyyymm || '__none__';
      if (yyyymm) {
        const [yy, mm] = yyyymm.split('-').map(n => parseInt(n, 10));
        const months = MONTH_LABELS[locale === 'en' ? 'en' : 'es'];
        const monthName = months[(mm || 1) - 1];
        const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
        label = `${cap(monthName)} ${yy}`;
      } else {
        label = t('owner.tasks.periodsGroup.noDate');
      }
      sortKey = yyyymm; // ISO month sorts chronologically as a string
    }
    let g = buckets.get(key);
    if (!g) {
      g = { key, label, sortKey, periods: [],
            totals: { done: 0, in_progress: 0, open: 0, overdue: 0, total: 0 } };
      buckets.set(key, g);
    }
    g.periods.push(p);
    g.totals.done        += p.totals?.done        || 0;
    g.totals.in_progress += p.totals?.in_progress || 0;
    g.totals.open        += p.totals?.open        || 0;
    g.totals.overdue     += p.totals?.overdue     || 0;
    g.totals.total       += p.totals?.total       || 0;
  }
  const ordered = Array.from(buckets.values()).sort((a, b) => {
    if (periodsGroup === 'month') return (a.sortKey || '').localeCompare(b.sortKey || '');
    return (a.sortKey || '').localeCompare(b.sortKey || '');
  });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {ordered.map(g => (
        <PeriodGroupSection key={g.key}
                            isOpen={!!groupExpanded[g.key]}
                            onToggle={() => setGroupExpanded(s => ({ ...s, [g.key]: !s[g.key] }))}
                            label={g.label} totals={g.totals} periodCount={g.periods.length}
                            t={t}>
          <div style={{ display: 'grid', gap: 6, padding: '8px 10px 12px' }}>
            {g.periods.map(p => renderPeriod(p, {
              // Service-grouped: the service is already in the parent
              // header so the period card hides it. Month-grouped:
              // keep service visible since several different services
              // sit under the same month.
              hideServiceLabel: periodsGroup === 'service',
              indent: true,
            }))}
          </div>
        </PeriodGroupSection>
      ))}
    </div>
  );
}

// One row in the Periods view. Expandable to lazy-load + render the
// underlying customer tasks via TaskRow.
function PeriodCard({ period: p, isOpen, onToggle, cached,
                      auth, community, thresholds, todayIso,
                      statuses, employees, customerById, employeeById, productById,
                      isAdmin, isSeedOwner, selectedIds, toggleSelect, selectMany,
                      onEdit, onTaskChange,
                      hideServiceLabel, indent,
                      locale, t }) {
  const title = pickI18n(p.autoTask?.title_i18n, locale).value
             || (p.product ? (pickI18n(p.product.name_i18n, locale).value || p.product.slug) : '—');
  const serviceLabel = p.product
    ? (pickI18n(p.product.name_i18n, locale).value || p.product.slug)
    : '';
  const tot = p.totals || {};
  const pct = tot.total ? Math.round((tot.done / tot.total) * 100) : 0;
  const urgency = effectiveUrgency(
    { due_date: p.dueDate, priority: p.topPriority, completed_at: null },
    thresholds, todayIso);
  const dueCol = colorOf(urgency, community);
  const periodLabel = periodLabelFor(p.autoTask?.cadence_kind, p.dueDate, locale);

  return (
    <section style={{
      border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
      marginLeft: indent ? 0 : 0,
    }}>
      <header onClick={onToggle}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', cursor: 'pointer',
                background: isOpen ? 'var(--tax-bg-alt)' : '#fff',
                borderBottom: isOpen ? '1px solid var(--tax-border)' : 'none',
              }}>
        <span aria-hidden="true" style={{
          fontSize: 11, color: 'var(--tax-muted)',
          transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform .12s ease',
        }}>▶</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--tax-text)',
                        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <span>{title}</span>
            {periodLabel && (
              <span style={{
                padding: '1px 8px', borderRadius: 4,
                background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                fontSize: 12, fontWeight: 700,
              }}>{periodLabel}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 4,
                        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {!hideServiceLabel && serviceLabel && <span>{serviceLabel}</span>}
            {p.dueDate && (
              <span>
                {t('owner.tasks.periods.dueLabel')}{' '}
                <span style={{
                  display: 'inline-block', padding: '1px 8px', borderRadius: 4,
                  background: dueCol.bg, color: dueCol.fg,
                  fontWeight: 700,
                }}>{p.dueDate}</span>
              </span>
            )}
            <span><strong style={{ color: '#166534' }}>{tot.done}</strong> {t('owner.progress.kpi.done').toLowerCase()}</span>
            <span><strong style={{ color: '#3730a3' }}>{tot.in_progress}</strong> {t('owner.progress.kpi.inProgress').toLowerCase()}</span>
            <span><strong style={{ color: '#92400e' }}>{tot.open}</strong> {t('owner.progress.kpi.open').toLowerCase()}</span>
            {tot.overdue > 0 && (
              <span style={{ color: '#991b1b', fontWeight: 700 }}>
                ⚠ {tot.overdue} {t('owner.progress.kpi.overdue').toLowerCase()}
              </span>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
            {tot.done}/{tot.total}
          </span>
          <div style={{
            width: 90, height: 6, background: 'var(--tax-bg-alt)', borderRadius: 999,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: 'var(--tax-brand-primary)',
            }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--tax-brand-primary)',
                         minWidth: 36, textAlign: 'right' }}>{pct}%</span>
        </div>
      </header>
      {isOpen && (
        <div style={{ padding: '6px 8px 10px' }}>
          {cached === 'loading' ? (
            <p style={{ color: 'var(--tax-muted)', fontSize: 13, padding: '8px 10px' }}>
              {t('loading')}
            </p>
          ) : !cached || cached.length === 0 ? (
            <p style={{ color: 'var(--tax-muted)', fontSize: 13, padding: '8px 10px' }}>
              {t('owner.tasks.periods.noTasks')}
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              <GroupSelectAll tasks={cached} selectedIds={selectedIds}
                              toggleSelect={toggleSelect} selectMany={selectMany} t={t} />
              {cached.map(tt => (
                <TaskRow key={tt.id} task={tt} auth={auth} community={community}
                         statuses={statuses} employees={employees}
                         customerById={customerById} employeeById={employeeById}
                         productById={productById} isSeedOwner={isSeedOwner}
                         selected={selectedIds?.has(tt.id)}
                         onToggleSelect={toggleSelect ? () => toggleSelect(tt.id) : undefined}
                         onEdit={onEdit} onChange={onTaskChange}
                         locale={locale} t={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Collapsible parent row that aggregates totals across all the
// PeriodCards nested below it. Click to expand. The progress bar
// reflects the sum (done / total) of every child period.
function PeriodGroupSection({ isOpen, onToggle, label, totals, periodCount, t, children }) {
  const pct = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
  return (
    <section style={{
      border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
    }}>
      <header onClick={onToggle}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', cursor: 'pointer',
                background: 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)',
                borderBottom: isOpen ? '1px solid var(--tax-border)' : 'none',
              }}>
        <span aria-hidden="true" style={{
          fontSize: 11, color: 'var(--tax-brand-primary)',
          transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform .12s ease',
        }}>▶</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--tax-text)' }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 4,
                        display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <span>{periodCount} {periodCount === 1 ? t('owner.tasks.periodsGroup.period1') : t('owner.tasks.periodsGroup.periodN')}</span>
            <span><strong style={{ color: '#166534' }}>{totals.done}</strong> {t('owner.progress.kpi.done').toLowerCase()}</span>
            <span><strong style={{ color: '#3730a3' }}>{totals.in_progress}</strong> {t('owner.progress.kpi.inProgress').toLowerCase()}</span>
            <span><strong style={{ color: '#92400e' }}>{totals.open}</strong> {t('owner.progress.kpi.open').toLowerCase()}</span>
            {totals.overdue > 0 && (
              <span style={{ color: '#991b1b', fontWeight: 700 }}>
                ⚠ {totals.overdue} {t('owner.progress.kpi.overdue').toLowerCase()}
              </span>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--tax-muted)' }}>
            {totals.done}/{totals.total}
          </span>
          <div style={{
            width: 120, height: 8, background: 'var(--tax-bg-alt)', borderRadius: 999,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: 'var(--tax-brand-primary)',
            }} />
          </div>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tax-brand-primary)',
                         minWidth: 40, textAlign: 'right' }}>{pct}%</span>
        </div>
      </header>
      {isOpen && children}
    </section>
  );
}

function TasksCalendar({ tasks, community, statuses, onEdit, onChange, locale, t }) {
  const today = new Date();
  const [cursor, setCursor] = useState(() => ({
    year: today.getUTCFullYear(), month: today.getUTCMonth(),
  }));
  const [drawerDate, setDrawerDate] = useState(null);
  const thresholds = resolveThresholds(community);
  const todayIso = new Date().toISOString().slice(0, 10);

  // Bucket tasks by ISO date.
  const byDate = new Map();
  for (const t1 of tasks) {
    if (!t1.due_date) continue;
    const arr = byDate.get(t1.due_date) || [];
    arr.push(t1);
    byDate.set(t1.due_date, arr);
  }

  // Month grid — pad start with prev month so first cell is a Sunday.
  const first = new Date(Date.UTC(cursor.year, cursor.month, 1));
  const dow = first.getUTCDay(); // 0 = Sun
  const start = new Date(first);
  start.setUTCDate(1 - dow);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    cells.push(d);
  }
  const monthName = first.toLocaleDateString(locale === 'es' ? 'es' : 'en', { month: 'long', year: 'numeric' });

  const drawerTasks = drawerDate ? (byDate.get(drawerDate) || []) : [];

  const prev = () => setCursor(c => {
    const m = c.month - 1;
    return m < 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: m };
  });
  const next = () => setCursor(c => {
    const m = c.month + 1;
    return m > 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: m };
  });
  const goToday = () => setCursor({ year: today.getUTCFullYear(), month: today.getUTCMonth() });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <button type="button" onClick={prev} className="tax-btn tax-btn--ghost tax-btn--sm">◀</button>
        <button type="button" onClick={goToday} className="tax-btn tax-btn--ghost tax-btn--sm">
          {t('owner.tasks.calendar.today')}
        </button>
        <button type="button" onClick={next} className="tax-btn tax-btn--ghost tax-btn--sm">▶</button>
        <strong style={{ fontSize: 15, marginLeft: 8 }}>{monthName}</strong>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: 1, background: 'var(--tax-border)',
        border: '1px solid var(--tax-border)', borderRadius: 8, overflow: 'hidden',
      }}>
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} style={{
            padding: '6px 8px', fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
            textTransform: 'uppercase', background: 'var(--tax-bg-alt)',
          }}>{d}</div>
        ))}
        {cells.map(d => {
          const iso = d.toISOString().slice(0, 10);
          const isThisMonth = d.getUTCMonth() === cursor.month;
          const isToday = iso === todayIso;
          const cellTasks = byDate.get(iso) || [];
          return (
            <button key={iso} type="button"
                    onClick={() => setDrawerDate(iso)}
                    style={{
                      minHeight: 96, padding: 6,
                      textAlign: 'left', border: 0, cursor: 'pointer',
                      background: isToday
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)'
                        : '#fff',
                      opacity: isThisMonth ? 1 : 0.45,
                      display: 'flex', flexDirection: 'column', gap: 3,
                    }}>
              <span style={{
                fontSize: 12, fontWeight: isToday ? 700 : 500,
                color: isToday ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
              }}>
                {/* Today's cell shows "<month> <day>" instead of just
                    a bare number so you can never misread "13" as
                    "the 13th of which month?" when the grid spans
                    a month boundary. Same prefix on the 1st of any
                    visible month — those cells live next to the
                    last few days of the previous month, which is
                    where the off-by-one confusion lands. */}
                {(isToday || d.getUTCDate() === 1)
                  ? `${d.toLocaleDateString(locale === 'es' ? 'es' : 'en', { month: 'short' })} ${d.getUTCDate()}`
                  : d.getUTCDate()}
              </span>
              {cellTasks.slice(0, 4).map(tt => {
                const c = colorOf(effectiveUrgency(tt, thresholds, todayIso), community);
                return (
                  <TaskHover key={tt.id} task={tt} statuses={statuses}
                             community={community} locale={locale} t={t}
                             onDeleted={onChange}>
                    <span style={{
                      display: 'block',
                      fontSize: 10, padding: '1px 4px', borderRadius: 4,
                      background: c.bg, color: c.fg,
                      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                    }}>{tt.title}</span>
                  </TaskHover>
                );
              })}
              {cellTasks.length > 4 && (
                <span style={{ fontSize: 10, color: 'var(--tax-muted)' }}>
                  + {cellTasks.length - 4}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {drawerDate && (
        <div className="tax-modal" role="dialog" aria-modal="true" onClick={() => setDrawerDate(null)}>
          <div className="tax-modal__panel" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <button type="button" className="tax-modal__close"
                    onClick={() => setDrawerDate(null)} aria-label={t('preview.close')}>×</button>
            <h3 className="tax-modal__title">
              {t('owner.tasks.calendar.dayTasks', { date: drawerDate })}
            </h3>
            {drawerTasks.length === 0 ? (
              <p style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.calendar.dayEmpty')}</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {drawerTasks.map(tt => (
                  <button key={tt.id} type="button"
                          onClick={() => { onEdit(tt); setDrawerDate(null); }}
                          style={{
                            display: 'block', textAlign: 'left', cursor: 'pointer',
                            padding: '8px 10px', border: '1px solid var(--tax-border)', borderRadius: 6,
                            background: '#fff',
                          }}>
                    <div style={{ fontWeight: 600 }}>{tt.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                      {tt.customer
                        ? (tt.customer.business_name || displayPersonName(tt.customer) || tt.customer.email)
                        : t('owner.tasks.calendar.practiceWide')}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Short, plain-language explanation of what each default status means,
// shown under every Kanban column header. Custom status keys an owner
// adds beyond the four defaults (not_started/in_progress/pending_review/
// completed, plus the common cancelled) get no subtitle rather than a
// guessed one.
const KANBAN_STATUS_HINT_KEY = {
  not_started: 'owner.tasks.kanban.statusHint.not_started',
  in_progress: 'owner.tasks.kanban.statusHint.in_progress',
  pending_review: 'owner.tasks.kanban.statusHint.pending_review',
  completed: 'owner.tasks.kanban.statusHint.completed',
  cancelled: 'owner.tasks.kanban.statusHint.cancelled',
};

// Same grouping key convention TasksGroupedList uses for the List view —
// kept separate rather than shared, since Kanban cards already carry their
// relations embedded (tt.customer/tt.assignee/tt.product straight off the
// task, no customerById/employeeById/productById lookups needed here).
function kanbanGroupKey(tt, groupBy, locale, t) {
  if (groupBy === 'employee') {
    const e = tt.assignee;
    return [e?.id || '__unassigned__', e ? (displayPersonName(e) || e.email) : t('owner.tasks.groupBy.unassigned')];
  }
  if (groupBy === 'service') {
    const p = tt.product;
    return [p?.id || '__none__', p ? (pickI18n(p.name_i18n, locale).value || p.slug) : t('owner.tasks.groupBy.noService')];
  }
  if (groupBy === 'customer') {
    const c = tt.customer;
    return [c?.id || '__none__', c ? (c.business_name || displayPersonName(c) || c.email) : t('owner.tasks.groupBy.practiceWide'), c ? customerTypeIcon(c.customer_type) : null];
  }
  return ['__none__', ''];
}

// ─── Kanban view (status columns + native drag-and-drop) ─────────────────
function TasksKanban({ tasks, statuses, community, auth, onChange, onEdit, hideCompleted, groupBy, locale, t }) {
  const thresholds = resolveThresholds(community);
  const todayIso = new Date().toISOString().slice(0, 10);
  // Per-(column, group) collapse state — keyed "statusKey::groupKey" so the
  // same customer collapsed in one status column doesn't affect its card
  // in another. Groups default to expanded (nothing in the set).
  const [collapsed, setCollapsed] = useState(() => new Set());
  const showGroups = ['employee', 'service', 'customer'].includes(groupBy);
  const toggleGroup = (gid) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(gid)) next.delete(gid); else next.add(gid);
    return next;
  });
  let cols = statuses.length
    ? statuses.slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    : [{ id: 'fallback', key: 'not_started', label_i18n: { en: 'Not started', es: 'Sin iniciar' } }];
  // Hide-completed also drops the terminal-status column itself (it'd
  // otherwise sit empty) so the remaining columns pick up its width —
  // the grid is evenly split across cols.length, which recomputes here.
  if (hideCompleted) cols = cols.filter(col => !col.is_terminal);
  const tasksByStatus = new Map();
  for (const tt of tasks) {
    const arr = tasksByStatus.get(tt.status_key) || [];
    arr.push(tt);
    tasksByStatus.set(tt.status_key, arr);
  }

  const onDrop = async (e, targetKey) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    const task = tasks.find(tt => tt.id === id);
    if (!task || task.status_key === targetKey) return;
    const fieldsMsg = notStartedFieldsMissing({ task, patch: { statusKey: targetKey }, t });
    if (fieldsMsg) { window.alert(fieldsMsg); onEdit(task); return; }
    const patch = ensureStatusChangeNotes({
      statuses, task, patch: { statusKey: targetKey }, t,
      onNewNote: (body) => taxApi.adminCreateTaskNote(auth, id, { body }).catch(() => {}),
    });
    if (!patch) return;
    try {
      await taxApi.adminUpdateTask(auth, id, patch);
      onChange();
    } catch (err) {
      // Most drag failures are silent-fine to ignore (a stale card from
      // another tab, etc.), but a drag onto a terminal column by a
      // non-Reviewer now fails deliberately (server-side reviewer_required)
      // and deserves to actually say so — the card otherwise just snaps
      // back with zero explanation.
      if (err?.body?.error === 'reviewer_required') window.alert(err.message || t('owner.tasks.reviewerRequiredDrop'));
    }
  };

  // One card's markup, shared between the flat (groupBy='none') and
  // grouped renders below — was duplicated once per render path before.
  const renderCard = (tt) => {
    const c = colorOf(effectiveUrgency(tt, thresholds, todayIso), community);
    const prCol = priorityColorOf(tt.priority, community);
    const custName = tt.customer
      ? (tt.customer.business_name || displayPersonName(tt.customer) || tt.customer.email)
      : '';
    const customerHref = tt.customer
      ? `/tax/${tt.community_id || community?.id}/employee/customers/${encodeURIComponent(tt.customer.id)}`
      : null;
    const serviceName = tt.product
      ? (pickI18n(tt.product.name_i18n, locale).value || tt.product.slug)
      : '';
    const ownerName = tt.assignee ? (displayPersonName(tt.assignee) || tt.assignee.email) : '';
    return (
      <TaskHover key={tt.id} task={tt} statuses={statuses}
                 community={community} locale={locale} t={t}
                 onDeleted={onChange}>
        {/* A real <button> can't contain a real <a> validly, so this is
            a div acting as one (role/tabIndex/onKeyDown) with the
            customer name split into its own link, stopping propagation
            so clicking it navigates to their detail page instead of
            opening the task edit modal. */}
        <div role="button" tabIndex={0}
             draggable
             onDragStart={e => e.dataTransfer.setData('text/plain', tt.id)}
             onClick={() => onEdit(tt)}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(tt); } }}
             style={{
               display: 'block', width: '100%', textAlign: 'left', cursor: 'grab',
               padding: '8px 10px',
               background: '#fff',
               borderRadius: 6, border: '1px solid var(--tax-border)',
               borderLeft: `4px solid ${c.bar}`,
             }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{tt.title}</div>
          {(custName || serviceName) && (
            <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
              {custName && (
                <>
                  <span aria-hidden="true">{customerTypeIcon(tt.customer.customer_type)}</span>{' '}
                  {customerHref ? (
                    <a href={customerHref} onClick={e => e.stopPropagation()}
                       style={{ color: 'var(--tax-brand-primary)' }}>
                      {custName}
                    </a>
                  ) : custName}
                </>
              )}
              {custName && serviceName && ' · '}
              {serviceName}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
            {tt.priority && (
              <span style={{
                padding: '1px 8px', borderRadius: 999,
                background: prCol.bg, color: prCol.fg,
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              }}>{t(`owner.tasks.priority.${tt.priority}`)}</span>
            )}
            {tt.due_date && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--tax-muted)' }}>
                {t('owner.tasks.due')}:
                <DuePill dueDate={tt.due_date} thresholds={thresholds} t={t} />
              </span>
            )}
          </div>
          {ownerName && (
            <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 4 }}>
              {t('owner.tasks.owner')}: {ownerName}
            </div>
          )}
        </div>
      </TaskHover>
    );
  };

  // Universe of every (column, group) id currently on screen, so Expand
  // all / Collapse all can act on exactly what's visible without having
  // to wait for the per-column render pass below.
  const allGroupIds = [];
  if (showGroups) {
    for (const col of cols) {
      const items = tasksByStatus.get(col.key) || [];
      const seen = new Set();
      for (const tt of items) seen.add(kanbanGroupKey(tt, groupBy, locale, t)[0]);
      for (const key of seen) allGroupIds.push(`${col.key}::${key}`);
    }
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        padding: '8px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.4,
        background: 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)',
        border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 18%, #fff)',
        color: 'var(--tax-text)',
      }}>
        <span aria-hidden="true">💡</span>
        <span>{t('owner.tasks.kanban.workflowHint')}</span>
      </div>
      {showGroups && allGroupIds.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
          <button type="button" className="tax-btn tax-btn--sm tax-btn--ghost"
                  onClick={() => setCollapsed(new Set())}>
            {t('owner.tasks.kanban.expandAll')}
          </button>
          <button type="button" className="tax-btn tax-btn--sm tax-btn--ghost"
                  onClick={() => setCollapsed(new Set(allGroupIds))}>
            {t('owner.tasks.kanban.collapseAll')}
          </button>
        </div>
      )}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`,
        overflowX: 'auto',
      }}>
      {cols.map(col => {
        const items = tasksByStatus.get(col.key) || [];

        // Sub-group the column's cards (e.g. by customer, with
        // "Practice-wide" as its own group) when a rollup is active.
        // Each group gets a small header with a count, same convention
        // the List view's "Group by" uses — none/unassigned sorts last.
        // Kanban only supports these three groupings (its dropdown never
        // offers dueBucket) — guards against a stale groupBy value carried
        // over from List view, which would otherwise render one
        // blank-label group instead of the normal flat column.
        let groupedItems = null;
        if (showGroups) {
          const groups = new Map();
          for (const tt of items) {
            const [key, label, icon] = kanbanGroupKey(tt, groupBy, locale, t);
            const slot = groups.get(key) || { label, icon, items: [] };
            slot.items.push(tt);
            groups.set(key, slot);
          }
          const order = Array.from(groups.keys()).sort((a, b) => {
            if (a === '__unassigned__' || a === '__none__') return 1;
            if (b === '__unassigned__' || b === '__none__') return -1;
            return groups.get(a).label.localeCompare(groups.get(b).label);
          });
          groupedItems = order.map(k => ({ key: k, ...groups.get(k) }));
        }

        // "In progress" is the column that answers "what's actively
        // being worked on and who owns it" — the one most worth staff
        // noticing and keeping populated (vs. letting work sit in Not
        // started). Given a tinted background + heavier border, same
        // color language as the status chip elsewhere, so it reads as
        // highlighted without needing a hardcoded color unrelated to
        // whatever the owner picked for this status.
        const isInProgress = col.key === 'in_progress';
        const colColor = col.color || '#9ca3af';
        const hintKey = KANBAN_STATUS_HINT_KEY[col.key];

        return (
          <div key={col.id || col.key}
               onDragOver={e => e.preventDefault()}
               onDrop={e => onDrop(e, col.key)}
               style={{
                 background: isInProgress
                   ? `color-mix(in srgb, ${colColor} 10%, #fff)`
                   : 'var(--tax-bg-alt)',
                 borderRadius: 8,
                 padding: 8, minHeight: 200,
                 // Phase 4n.47: each column carries the status's
                 // owner-configured color along its top, so the
                 // Kanban inherits the same color language the chip
                 // uses in the List view.
                 borderTop: `${isInProgress ? 5 : 3}px solid ${colColor}`,
               }}>
            <div style={{
              padding: '4px 6px 2px', fontSize: 12,
              fontWeight: isInProgress ? 800 : 700,
              color: isInProgress ? colColor : 'var(--tax-muted)',
              textTransform: 'uppercase', letterSpacing: '.04em',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 999,
                  background: colColor,
                }} />
                {pickI18n(col.label_i18n, locale).value || col.key}
              </span>
              <span style={{ fontWeight: 500 }}>· {items.length}</span>
            </div>
            {hintKey && (
              <div style={{
                padding: '0 6px 8px', fontSize: 11, lineHeight: 1.35,
                color: 'var(--tax-muted)', textTransform: 'none', fontWeight: 400,
                letterSpacing: 'normal',
              }}>
                {t(hintKey)}
              </div>
            )}
            {groupedItems && groupedItems.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--tax-muted)', textAlign: 'center', padding: 12 }}>
                {t('owner.tasks.kanban.empty')}
              </div>
            ) : groupedItems ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {groupedItems.map(g => {
                  const gid = `${col.key}::${g.key}`;
                  const isCollapsed = collapsed.has(gid);
                  // Grouped by customer, the group key IS the customer
                  // id (kanbanGroupKey's 'customer' case) — '__none__'
                  // means Practice-wide, which has no detail page.
                  const customerHref = (groupBy === 'customer' && g.key !== '__none__' && community?.id)
                    ? `/tax/${community.id}/employee/customers/${encodeURIComponent(g.key)}`
                    : null;
                  return (
                    <div key={g.key}>
                      {/* A real <button> can't contain a real <a> validly,
                          so the toggle is a div acting as one (role/tabIndex/
                          onKeyDown below) with the customer name split out
                          into its own link when there is one, stopping
                          propagation so clicking it navigates instead of
                          toggling the group. */}
                      <div role="button" tabIndex={0}
                           onClick={() => toggleGroup(gid)}
                           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(gid); } }}
                           className="tax-kanban-group-toggle"
                           title={isCollapsed ? t('owner.tasks.kanban.groupExpand') : t('owner.tasks.kanban.groupCollapse')}
                           aria-expanded={!isCollapsed}
                           style={{
                             width: '100%', cursor: 'pointer',
                             font: 'inherit', fontSize: 11, fontWeight: 700, color: 'var(--tax-text)',
                             textTransform: 'uppercase', letterSpacing: '.03em',
                             borderRadius: 6, padding: '5px 8px',
                             display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                           }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span aria-hidden="true" style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            background: 'color-mix(in srgb, var(--tax-brand-primary) 14%, #fff)',
                            color: 'var(--tax-brand-primary)', fontSize: 10,
                            transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                            transition: 'transform .15s',
                          }}>▾</span>
                          {g.icon && <span aria-hidden="true">{g.icon}</span>}
                          {customerHref ? (
                            <a href={customerHref} onClick={e => e.stopPropagation()}
                               style={{
                                 color: 'var(--tax-brand-primary)', textDecoration: 'none',
                                 overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                               }}>
                              {g.label}
                            </a>
                          ) : (
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                          )}
                        </span>
                        <span style={{ color: 'var(--tax-muted)', fontWeight: 500, flexShrink: 0 }}>· {g.items.length}</span>
                      </div>
                      {!isCollapsed && (
                        <div style={{ display: 'grid', gap: 6 }}>
                          {g.items.map(renderCard)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {items.map(renderCard)}
                {items.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--tax-muted)', textAlign: 'center', padding: 12 }}>
                    {t('owner.tasks.kanban.empty')}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
