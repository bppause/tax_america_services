import { useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { displayPersonName } from '../lib/personName';
import { urgencyOf, effectiveUrgency, colorOf, priorityColorOf, resolveThresholds, URGENCY_LABEL_KEY } from '../lib/taskUrgency';
import { formatFrequency } from '../lib/taskFrequency';
import TaskHover from '../components/TaskHover';
import SavedSearchesMenu from '../components/SavedSearchesMenu';

// Single source of truth for an empty filter set. Used by Clear-all,
// by the saved-search apply path, and by the built-in starter views
// so each built-in only needs to override the dimensions it cares
// about (e.g. due='overdue') without clobbering the others.
const EMPTY_FILTERS = {
  status: [], priority: '', assignedTo: [], productId: [], customerId: [], due: '',
  customerType: 'all', q: '',
};

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

// Inline completion-note prompt. When a status change would move the
// task into a terminal bucket and there's no existing note (or the
// patch isn't already supplying one), prompt the user via
// window.prompt and merge the result into the patch. Returns null
// when the user cancels — the caller should skip the API call.
// Keeps the inline status dropdown and the Kanban drag-drop from
// surprising the user with a server 400.
export function ensureCompletionNotes({ statuses, task, patch, t }) {
  if (!patch || !patch.statusKey) return patch;
  const target = (statuses || []).find(s => s.key === patch.statusKey);
  if (!target?.is_terminal) return patch;
  const incoming = String(patch.notes || '').trim();
  const existing = String(task?.notes || '').trim();
  if (incoming || existing) return patch;
  const note = typeof window !== 'undefined'
    ? window.prompt(t('owner.tasks.completeNotesPrompt'))
    : null;
  if (note === null) return null;
  const trimmed = String(note).trim();
  if (!trimmed) {
    if (typeof window !== 'undefined') window.alert(t('owner.tasks.completeNotesRequired'));
    return null;
  }
  return { ...patch, notes: trimmed };
}

export default function OwnerTasks() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };
  const isAdmin = employee?.role === 'admin';

  const [statuses, setStatuses] = useState([]);
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
  // pickers.
  const [filters, setFilters] = useState({
    status: [], priority: '', assignedTo: [], productId: [], customerId: [], due: '',
    customerType: 'all',   // 'all' | 'individual' | 'business'
    q: '',
  });
  // Phase 4n.45: view mode (list/calendar/kanban), group-by, and the
  // My-tasks toggle. View + group-by persist per browser via
  // localStorage so the operator's preference sticks across sessions.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('tax.tasks.view') || 'list'; }
    catch { return 'list'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.view', view); } catch { /* ignore */ }
  }, [view]);
  const [groupBy, setGroupBy] = useState(() => {
    try { return localStorage.getItem('tax.tasks.groupBy') || 'none'; }
    catch { return 'none'; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.tasks.groupBy', groupBy); } catch { /* ignore */ }
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
  const [mine, setMine] = useState(false);
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
      dueDateExact: filters.dueDateExact || '',
      q: filters.q,
      sort: sortKey,
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
    ]).then(([s, e, c, p, rt]) => {
      setStatuses(s.statuses || []);
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
      setCustomers(c.customers || []);
      setProducts(p.products || []);
      setRelationshipTypes((rt.types || []).filter(r => r.active !== false));
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
  }, [fbUser, community, filters, mine, employee?.id, sortKey]);

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

  // Background fill: when tasks load and any are missing the current locale's
  // title, call the fill endpoint so subsequent views show the right language.
  // Fire-and-forget — on success, reload the task list to pick up the new titles.
  useEffect(() => {
    if (!Array.isArray(tasks) || !tasks.length || !auth) return;
    const hasMissing = tasks.some(t => !(t.title_i18n?.[locale]));
    if (!hasMissing) return;
    taxApi.adminFillMissingTranslations(auth)
      .then(d => { if (d.queued > 0) load(); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Workload-heatmap drill-through: ?assignedTo=<empId>&dueDate=YYYY-MM-DD.
  // Applied once on mount. The params are stripped after they land so
  // a refresh doesn't keep re-applying them after the operator changes
  // filters by hand.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const assignedTo = params.get('assignedTo');
    const dueDate = params.get('dueDate');
    if (!assignedTo && !dueDate) return;
    setFilters(prev => ({
      ...prev,
      assignedTo: assignedTo ? [assignedTo] : prev.assignedTo,
      dueDateExact: dueDate || prev.dueDateExact || '',
    }));
    params.delete('assignedTo');
    params.delete('dueDate');
    const qs = params.toString();
    const next = window.location.pathname + (qs ? `?${qs}` : '');
    window.history.replaceState(null, '', next);
  }, []);

  const onClearFilters = () => setFilters({ ...EMPTY_FILTERS });
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SavedSearchesMenu
            auth={auth} scope="tasks" t={t}
            builtIns={[
              { key: 'bi-mine-today',    name: t('owner.tasks.smart.mineToday'),    params: { mine: true, filters: { ...EMPTY_FILTERS, due: 'today' } } },
              { key: 'bi-mine-overdue',  name: t('owner.tasks.smart.mineOverdue'),  params: { mine: true, filters: { ...EMPTY_FILTERS, due: 'overdue' } } },
              { key: 'bi-overdue',       name: t('owner.tasks.smart.overdue'),      params: { mine: false, filters: { ...EMPTY_FILTERS, due: 'overdue' } } },
              { key: 'bi-due-today',     name: t('owner.tasks.smart.dueToday'),     params: { mine: false, filters: { ...EMPTY_FILTERS, due: 'today' } } },
              { key: 'bi-unassigned',    name: t('owner.tasks.smart.unassigned'),   params: { mine: false, filters: { ...EMPTY_FILTERS, assignedTo: ['unassigned'] } } },
            ]}
            getCurrentParams={() => ({ mine, filters, view, groupBy, sortKey, periodsGroup })}
            applyParams={(p) => {
              if (p.filters) setFilters({ ...EMPTY_FILTERS, ...p.filters });
              if (typeof p.mine === 'boolean') setMine(p.mine);
              if (p.view) setView(p.view);
              if (p.groupBy) setGroupBy(p.groupBy);
              if (p.sortKey) setSortKey(p.sortKey);
              if (p.periodsGroup) setPeriodsGroup(p.periodsGroup);
            }}
          />
          <button type="button" className="tax-btn tax-btn--primary"
                  onClick={() => setShowAdd(true)}>
            + {t('owner.tasks.add')}
          </button>
        </div>
      </div>

      {showAdd && (
        <TaskFormModal
          mode="create"
          auth={auth} community={community} isAdmin={isAdmin}
          statuses={statuses} employees={employees} customers={customers}
          products={products} relationshipTypes={relationshipTypes}
          defaultAssignee={employee?.id || ''} locale={locale} t={t}
          onCustomersChanged={(c) => setCustomers(prev => [c, ...prev])}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}

      {editingTask && (
        <TaskFormModal
          mode="edit" task={editingTask}
          auth={auth} community={community} isAdmin={isAdmin}
          statuses={statuses} employees={employees} customers={customers}
          products={products} relationshipTypes={relationshipTypes}
          defaultAssignee={employee?.id || ''} locale={locale} t={t}
          onCustomersChanged={(c) => setCustomers(prev => [c, ...prev])}
          onClose={() => setEditingTask(null)}
          onSaved={() => { setEditingTask(null); load(); }}
        />
      )}

      <TaskToolbar
        mine={mine} setMine={setMine}
        filters={filters} setFilters={setFilters}
        view={view} setView={setView}
        groupBy={groupBy} setGroupBy={setGroupBy}
        sortKey={sortKey} setSortKey={setSortKey}
        periodsGroup={periodsGroup} setPeriodsGroup={setPeriodsGroup}
        t={t}
      />

      <FilterBar
        filters={filters} setFilters={setFilters}
        statuses={statuses} employees={employees} products={products}
        customers={customers}
        onClear={onClearFilters} active={filtersActive}
        locale={locale} t={t}
      />

      {selectedIds.size > 0 && (
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
                      productById={productById} isAdmin={isAdmin}
                      onEdit={setEditingTask}
                      selectedIds={selectedIds} toggleSelect={toggleSelect}
                      selectMany={selectMany}
                      periodsGroup={periodsGroup}
                      mine={mine} employeeId={employee?.id}
                      locale={locale} t={t} />
      ) : tasks === null ? <p>{t('loading')}</p>
        : tasks.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>
              {filtersActive ? t('owner.tasks.noMatch') : t('owner.tasks.empty')}
            </p>
          : view === 'calendar' ? (
              <TasksCalendar tasks={tasks} community={community} statuses={statuses}
                             onEdit={setEditingTask} locale={locale} t={t} />
            )
          : view === 'kanban' ? (
              <TasksKanban tasks={tasks} statuses={statuses} community={community}
                           auth={auth} onChange={load}
                           onEdit={setEditingTask} locale={locale} t={t} />
            )
          : (
            <TasksGroupedList tasks={tasks} groupBy={groupBy} community={community}
                              statuses={statuses} employees={employees}
                              customerById={customerById} employeeById={employeeById}
                              productById={productById} isAdmin={isAdmin}
                              auth={auth} onEdit={setEditingTask} onChange={load}
                              selectedIds={selectedIds} toggleSelect={toggleSelect}
                              selectMany={selectMany}
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
  const productOptions = products.map(p => ({
    id: p.id,
    label: pickI18n(p.name_i18n, locale).value || p.slug,
  }));
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
function MultiSelect({ label, options, value, onToggle, onClear, searchable, searchPlaceholder, t }) {
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
                  if (v) apply({ statusKey: v });
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

function TaskRow({ task, auth, community, statuses, employees, customerById, employeeById, productById, isAdmin, onEdit, onChange, selected, onToggleSelect, locale, t }) {
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

  const update = async (patch) => {
    // Completing a task requires a closing note — see the server-side
    // notes_required_on_complete check. Prompt the owner inline when
    // the row's status is being flipped to terminal and there's no
    // note yet, so the server round-trip never has to fail.
    const finalPatch = ensureCompletionNotes({ statuses, task, patch, t });
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

  return (
    <TaskHover task={task} statuses={statuses}
               community={community} locale={locale} t={t}
               side="auto">
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
            {task.title_i18n?.[locale] || task.title_i18n?.[locale === 'en' ? 'es' : 'en'] || task.title}
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
          </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <select value={task.status_key} onChange={e => update({ statusKey: e.target.value })}
                  disabled={busy}
                  style={{
                    padding: '4px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                    border: '1px solid var(--tax-border)',
                    background: `color-mix(in srgb, ${statusBg} 18%, #fff)`,
                  }}>
            {statuses.map(s => (
              <option key={s.id} value={s.key}>{pickI18n(s.label_i18n, locale).value || s.key}</option>
            ))}
          </select>
          <button type="button" onClick={onEdit} disabled={busy}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
            {t('owner.tasks.edit')}
          </button>
          {isAdmin && (
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

// Unified create + edit modal. Customer picker is a typeahead with an
// inline "+ New customer" affordance; picking a customer auto-fills the
// service from the customer's first active relationship (best-effort —
// stays blank if no workflow rule chains to a product).
function TaskFormModal({
  mode, task, auth, community, isAdmin,
  statuses, employees, customers, products, relationshipTypes,
  defaultAssignee, locale, t,
  onCustomersChanged, onClose, onSaved,
}) {
  const isEdit = mode === 'edit';
  const [titleEn, setTitleEn] = useState(isEdit ? (task.title_i18n?.en || task.title || '') : '');
  const [titleEs, setTitleEs] = useState(isEdit ? (task.title_i18n?.es || '') : '');
  const [customerId, setCustomerId] = useState(isEdit ? (task.customer_id || '') : '');
  const [productId, setProductId] = useState(isEdit ? (task.product_id || '') : '');
  const [productAutoFilledFor, setProductAutoFilledFor] = useState('');
  const [statusKey, setStatusKey] = useState(
    isEdit ? task.status_key : (statuses[0]?.key || 'not_started')
  );
  const [priority, setPriority] = useState(isEdit ? task.priority : 'normal');
  const [assignedTo, setAssignedTo] = useState(
    isEdit ? (task.assigned_employee_id || '') : defaultAssignee
  );
  const [dueDate, setDueDate] = useState(isEdit ? (task.due_date || '') : '');
  const [notes, setNotes] = useState(isEdit ? (task.notes || '') : '');
  const [blockedBy, setBlockedBy] = useState(isEdit ? (task.blocked_by_task_id || '') : '');
  const [requiresReview, setRequiresReview] = useState(isEdit ? !!task.requires_review : false);
  const [reviewerId, setReviewerId] = useState(isEdit ? (task.reviewer_employee_id || '') : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showInlineCreate, setShowInlineCreate] = useState(false);
  const [defaultProductHint, setDefaultProductHint] = useState(null);
  // Reviewer-side state for the in-review banner.
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNote, setReviewNote] = useState('');

  useEffect(() => {
    const product = products.find(p => p.id === productId);
    taxApi.adminTaskSuggestions(auth, product?.slug || '')
      .then(d => setSuggestions(d.suggestions || []))
      .catch(() => setSuggestions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // On edit-open, fill any blank language slot with the other language's value.
  useEffect(() => {
    if (!isEdit) return;
    const enStored = task.title_i18n?.en || '';
    const esStored = task.title_i18n?.es || '';
    if (!esStored) {
      const src = enStored || task.title || '';
      if (src) setTitleEs(src);
    } else if (!enStored) {
      setTitleEn(esStored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        }
      })
      .catch(() => setDefaultProductHint(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const onSave = async (e) => {
    e?.preventDefault?.();
    const activeTitle = locale === 'en' ? titleEn.trim() : titleEs.trim();
    if (!activeTitle) { setErr(t('owner.tasks.errTitle')); return; }
    setBusy(true); setErr('');
    try {
      const activeTitle = locale === 'en' ? titleEn.trim() : titleEs.trim();
      const payload = {
        title: activeTitle,
        titleI18n: { [locale]: activeTitle }, // server translates to the other language
        activeLocale: locale,
        customerId: customerId || null,
        productId: productId || null,
        statusKey, priority,
        assignedEmployeeId: assignedTo || null,
        dueDate: dueDate || null,
        notes: notes.trim(),
        blockedByTaskId: blockedBy || null,
        requiresReview,
        reviewerEmployeeId: requiresReview ? (reviewerId || null) : null,
      };
      if (isEdit) {
        await taxApi.adminUpdateTask(auth, task.id, payload);
      } else {
        await taxApi.adminCreateTask(auth, { communitySlug: community.id, ...payload });
      }
      onSaved();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tax-modal__panel" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <button type="button" className="tax-modal__close"
                onClick={onClose} aria-label={t('preview.close')}>×</button>
        <h3 className="tax-modal__title">
          {isEdit ? t('owner.tasks.editTitle') : t('owner.tasks.add')}
        </h3>
        {isEdit && task?.pending_review_at && !task?.reviewed_at && (
          <ReviewBanner task={task} auth={auth} isAdmin={isAdmin} t={t}
                        busy={reviewBusy} setBusy={setReviewBusy}
                        note={reviewNote} setNote={setReviewNote}
                        onActioned={onSaved} />
        )}
        {isEdit && task?.blocked_by_task_id && (
          <BlockerBanner task={task} customers={customers} t={t} />
        )}
        <form onSubmit={onSave} className="tax-form" style={{ boxShadow: 'none', padding: 0, border: 0 }}>
          <div>
            <label>{t('owner.tasks.field.title')}</label>
            <input type="text"
                   value={locale === 'en' ? titleEn : titleEs}
                   onChange={e => locale === 'en' ? setTitleEn(e.target.value) : setTitleEs(e.target.value)}
                   maxLength={300} list="task-suggestions" required autoFocus
                   />
            <datalist id="task-suggestions">
              {suggestions.map((s, i) => (
                <option key={i} value={locale === 'en' ? (s.en || s.es || '') : (s.es || s.en || '')} />
              ))}
            </datalist>
          </div>

          <div>
            <label>{t('owner.tasks.field.customer')}</label>
            <CustomerCombobox
              customers={customers} value={customerId} onChange={setCustomerId}
              isAdmin={isAdmin} onAddNew={() => setShowInlineCreate(true)}
              locale={locale} t={t}
            />
            {defaultProductHint?.relationshipName_i18n && productId === defaultProductHint.productId && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                {t('owner.tasks.field.serviceAutoFilled', {
                  relationship: pickI18n(defaultProductHint.relationshipName_i18n, locale).value || ''
                })}
              </p>
            )}
          </div>

          <div className="tax-form__row2">
            <div>
              <label>{t('owner.tasks.field.service')}</label>
              <select value={productId} onChange={e => {
                setProductId(e.target.value);
                setProductAutoFilledFor(customerId);  // mark as user-edited
              }}>
                <option value="">{t('owner.tasks.field.servicePractice')}</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{pickI18n(p.name_i18n, locale).value || p.slug}</option>
                ))}
              </select>
            </div>
            <div>
              <label>{t('owner.tasks.field.owner')}</label>
              <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
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
              <select value={priority} onChange={e => setPriority(e.target.value)}>
                {PRIORITY_OPTIONS.map(p => (
                  <option key={p} value={p}>{t(`owner.tasks.priority.${p}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label>{t('owner.tasks.field.status')}</label>
              <select value={statusKey} onChange={e => setStatusKey(e.target.value)}>
                {statuses.map(s => (
                  <option key={s.id} value={s.key}>{pickI18n(s.label_i18n, locale).value || s.key}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label>{t('owner.tasks.field.due')}</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>

          {/* Phase 4n.56 — workflow controls. Blocker keeps a sequential
              chain enforceable (return prep blocked by docs received).
              Requires-review routes the task into the review queue when
              the preparer flips it to a terminal status. */}
          <details style={{ background: 'var(--tax-bg-alt)', borderRadius: 8, padding: 10 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              {t('owner.tasks.field.workflow')}
            </summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
                  {t('owner.tasks.field.blockedBy')}
                </label>
                <BlockerPicker
                  customers={customers} locale={locale} t={t}
                  currentTaskId={isEdit ? task.id : ''}
                  customerScopeId={customerId || (isEdit ? task.customer_id : '')}
                  auth={auth} community={community}
                  value={blockedBy} onChange={setBlockedBy} />
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                  {t('owner.tasks.field.blockedByHint')}
                </p>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={requiresReview}
                       onChange={e => setRequiresReview(e.target.checked)} />
                {t('owner.tasks.field.requiresReview')}
              </label>
              {requiresReview && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
                    {t('owner.tasks.field.reviewer')}
                  </label>
                  <select value={reviewerId} onChange={e => setReviewerId(e.target.value)}>
                    <option value="">{t('owner.tasks.field.reviewerNone')}</option>
                    {employees.filter(em => em.id !== assignedTo).map(em => (
                      <option key={em.id} value={em.id}>
                        {displayPersonName(em) || em.email}
                      </option>
                    ))}
                  </select>
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
                    {t('owner.tasks.field.reviewerHint')}
                  </p>
                </div>
              )}
            </div>
          </details>

          <div>
            <label>{t('owner.tasks.field.notes')}</label>
            <textarea rows={4} value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000} />
          </div>

          {isEdit && task?.id && (
            <TaskTimeTrackingSection auth={auth} taskId={task.id} isAdmin={isAdmin} locale={locale} t={t} />
          )}

          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
              {busy ? t('lead.submitting')
                    : (isEdit ? t('owner.tasks.save') : t('owner.tasks.create'))}
            </button>
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
          }}
        />
      )}
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

// Top-of-modal banner shown when this task is sitting in the review
// queue. Reviewer (or any admin) gets Approve / Reject buttons +
// a note field; preparers see a passive "waiting for <reviewer>" line.
function ReviewBanner({ task, auth, isAdmin, t, busy, setBusy, note, setNote, onActioned }) {
  const reviewerName = displayPersonName(task.reviewer) || task.reviewer?.email || '';
  // Approve/reject is restricted server-side too — surface the buttons
  // only when the client can plausibly use them, but the server is the
  // authority.
  const canDecide = isAdmin || /* hint from server-emitted role */ false; // overridden below
  const action = async (decision) => {
    setBusy(true);
    try {
      await taxApi.adminReviewTask(auth, task.id, { decision, note: note.trim() });
      onActioned();
    } catch (e) {
      alert(e?.message || '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{
      padding: 12, borderRadius: 8,
      background: 'color-mix(in srgb, #d97706 14%, #fff)',
      borderLeft: '4px solid #d97706',
      marginBottom: 12, display: 'grid', gap: 8,
    }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>
        ⏳ {t('owner.tasks.review.pending')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--tax-text)' }}>
        {reviewerName
          ? t('owner.tasks.review.waitingOn', { name: reviewerName })
          : t('owner.tasks.review.waitingAnyReviewer')}
      </div>
      <input type="text" value={note} onChange={e => setNote(e.target.value)}
             placeholder={t('owner.tasks.review.notePlaceholder')} maxLength={500}
             style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontSize: 13 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" disabled={busy} onClick={() => action('approve')}
                className="tax-btn tax-btn--sm"
                style={{ background: '#166534', color: '#fff', border: '1px solid #166534' }}>
          ✓ {t('owner.tasks.review.approve')}
        </button>
        <button type="button" disabled={busy} onClick={() => action('reject')}
                className="tax-btn tax-btn--ghost tax-btn--sm"
                style={{ color: '#991b1b', borderColor: '#991b1b' }}>
          ✕ {t('owner.tasks.review.reject')}
        </button>
        <span style={{ alignSelf: 'center', fontSize: 11, color: 'var(--tax-muted)' }}>
          {t('owner.tasks.review.permissionHint')}
        </span>
      </div>
    </div>
  );
}

// Static "this task is blocked by …" header banner. Click-through
// jumps to the blocker via ?edit=. The PATCH endpoint already
// refuses terminal transitions while the blocker is open, so this
// is just a visual hint.
function BlockerBanner({ task, customers, t }) {
  const [blocker, setBlocker] = useState(null);
  useEffect(() => {
    let cancelled = false;
    // Lazy lookup — pull the blocker title via the same /admin/tasks
    // list cached on the parent. Customers prop already in scope; we
    // could pass tasks list through but a single fetch is fine.
    fetch(`/api/m/tax/admin/tasks/${encodeURIComponent(task.blocked_by_task_id)}`, {
      headers: { 'x-firebase-uid': '', 'x-firebase-email': '' },
    }).catch(() => {});
    // The simpler path: render the id as a fallback if we don't have
    // the title yet. Reading from /admin/tasks isn't a single-row
    // endpoint, so we just show the truncated id and trust the
    // server's 400 error to describe the blocker on completion.
    if (!cancelled) setBlocker({ id: task.blocked_by_task_id });
    return () => { cancelled = true; };
  }, [task.blocked_by_task_id]);
  if (!blocker) return null;
  const editHref = `?edit=${encodeURIComponent(task.blocked_by_task_id)}`;
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: 'color-mix(in srgb, #b91c1c 10%, #fff)',
      borderLeft: '4px solid #b91c1c',
      marginBottom: 12, fontSize: 13,
    }}>
      🔒 {t('owner.tasks.blockedBanner')}{' '}
      <a href={editHref} style={{ color: '#b91c1c', fontWeight: 600 }}>
        {t('owner.tasks.openBlocker')}
      </a>
    </div>
  );
}

// Blocker picker — searches other open tasks for the same customer
// (or community-wide when the task is practice-wide) and lets the
// owner pick one. Keeps the dropdown small by limiting to 50 rows
// scoped to the customer/community.
function BlockerPicker({ value, onChange, currentTaskId, customerScopeId, auth, community, customers, locale, t }) {
  const [tasks, setTasks] = useState([]);
  useEffect(() => {
    if (!community?.id) return;
    taxApi.adminListTasks(auth, community.id)
      .then(d => {
        const rows = (d.tasks || [])
          .filter(t1 => t1.id !== currentTaskId)
          .filter(t1 => !t1.completed_at)
          .filter(t1 => !customerScopeId || t1.customer_id === customerScopeId || !t1.customer_id)
          .slice(0, 50);
        setTasks(rows);
      })
      .catch(() => setTasks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.id, customerScopeId, currentTaskId]);
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
            style={{ width: '100%' }}>
      <option value="">{t('owner.tasks.field.blockedByNone')}</option>
      {tasks.map(t1 => (
        <option key={t1.id} value={t1.id}>
          {t1.title} {t1.due_date ? `· ${t1.due_date}` : ''}
        </option>
      ))}
    </select>
  );
}

// Time tracking on a task — shown inside the edit modal. Loads the
// full entry list on mount, surfaces Start/Stop for the caller, shows
// a running ticker for any in-flight entry, and lets the caller add a
// manual back-fill entry. Each entry is editable inline (by its
// author or admin); deletion is the same. Total at the top includes
// the live portion of any running timer so the number moves while a
// timer is on.
function TaskTimeTrackingSection({ auth, taskId, isAdmin, locale, t }) {
  const [entries, setEntries] = useState(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = () => {
    taxApi.adminListTaskTimeEntries(auth, taskId)
      .then(d => {
        setEntries(d.entries || []);
        setTotal(d.total_seconds || 0);
      })
      .catch(e => setErr(e?.message || ''));
  };
  useEffect(load, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tick once per second so the running-timer ticker + the total
  // updates without polling the server. The interval is paused when
  // no timer is running so we don't waste cycles.
  const running = (entries || []).find(e => !e.ended_at);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStart = async () => {
    setBusy(true); setErr('');
    try { await taxApi.adminStartTaskTimer(auth, taskId); load(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onStop = async () => {
    setBusy(true); setErr('');
    try { await taxApi.adminStopTaskTimer(auth, taskId); load(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onDelete = async (entryId) => {
    if (!window.confirm(t('owner.tasks.time.deleteConfirm'))) return;
    setBusy(true); setErr('');
    try { await taxApi.adminDeleteTimeEntry(auth, entryId); load(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  // Total = closed seconds + running seconds (computed live)
  const liveTotal = total + (running
    ? Math.max(0, Math.round((now - new Date(running.started_at).getTime()) / 1000))
    : 0);

  return (
    <div style={{
      marginTop: 4, padding: 12, borderRadius: 8,
      background: 'var(--tax-bg-alt)', display: 'grid', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            ⏱ {t('owner.tasks.time.heading')}
            <span style={{
              marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              background: '#fff', color: 'var(--tax-text)',
              fontSize: 12, fontWeight: 700,
            }}>{formatHm(liveTotal, t)}</span>
          </div>
          {running && (
            <div style={{ fontSize: 12, color: '#166534', marginTop: 4 }}>
              ● {t('owner.tasks.time.runningSince', { since: formatHm(Math.max(0, Math.round((now - new Date(running.started_at).getTime()) / 1000)), t) })}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!running && (
            <button type="button" onClick={onStart} disabled={busy}
                    className="tax-btn tax-btn--primary tax-btn--sm">
              ▶ {t('owner.tasks.time.start')}
            </button>
          )}
          {running && (
            <button type="button" onClick={onStop} disabled={busy}
                    className="tax-btn tax-btn--sm"
                    style={{ background: '#991b1b', color: '#fff', border: '1px solid #991b1b' }}>
              ◼ {t('owner.tasks.time.stop')}
            </button>
          )}
          <button type="button" onClick={() => setShowAdd(s => !s)}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-text)' }}>
            + {t('owner.tasks.time.addManual')}
          </button>
        </div>
      </div>

      {showAdd && (
        <ManualTimeEntryForm auth={auth} taskId={taskId} t={t}
                             onClose={() => setShowAdd(false)}
                             onSaved={() => { setShowAdd(false); load(); }} />
      )}

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {entries === null ? <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: 0 }}>{t('loading')}</p>
        : entries.length === 0 ? <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: 0 }}>{t('owner.tasks.time.empty')}</p>
        : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {entries.map(e => (
              <TimeEntryRow key={e.id} entry={e} isAdmin={isAdmin}
                            now={now} locale={locale} t={t}
                            onDelete={() => onDelete(e.id)} onChanged={load} auth={auth} />
            ))}
          </ul>
        )}
    </div>
  );
}

function ManualTimeEntryForm({ auth, taskId, t, onClose, onSaved }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [note, setNote] = useState('');
  const [billable, setBillable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    setBusy(true); setErr('');
    try {
      const startedAt = new Date(`${date}T${startTime}`).toISOString();
      const endedAt   = new Date(`${date}T${endTime}`).toISOString();
      await taxApi.adminAddTaskTimeEntry(auth, taskId, { startedAt, endedAt, note: note.trim(), billable });
      onSaved();
    } catch (e) {
      setErr(e?.message || '');
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 8, padding: 10, background: '#fff', borderRadius: 6 }}>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.tasks.time.manual.date')}
          </label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.tasks.time.manual.start')}
            </label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} required />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
              {t('owner.tasks.time.manual.end')}
            </label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} required />
          </div>
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
          {t('owner.tasks.time.manual.note')}
        </label>
        <input type="text" value={note} onChange={e => setNote(e.target.value)} maxLength={500}
               placeholder={t('owner.tasks.time.manual.notePlaceholder')} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} />
        {t('owner.tasks.time.manual.billable')}
      </label>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.tasks.time.manual.save')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}

function TimeEntryRow({ entry, isAdmin, now, locale, t, onDelete, onChanged, auth }) {
  const [editing, setEditing] = useState(false);
  const closed = !!entry.ended_at;
  const seconds = closed
    ? (entry.duration_seconds || 0)
    : Math.max(0, Math.round((now - new Date(entry.started_at).getTime()) / 1000));
  const author = displayPersonName(entry.employee) || entry.employee?.email || '—';
  const startedFmt = formatTs(entry.started_at, locale);
  const endedFmt = closed ? formatTs(entry.ended_at, locale) : null;

  if (editing) {
    return (
      <li style={{ background: '#fff', borderRadius: 6, padding: 8 }}>
        <TimeEntryEditForm entry={entry} auth={auth} t={t}
                           onClose={() => setEditing(false)}
                           onSaved={() => { setEditing(false); onChanged(); }} />
      </li>
    );
  }

  return (
    <li style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 8, padding: '8px 10px', background: '#fff', borderRadius: 6,
      borderLeft: closed ? '3px solid #16a34a' : '3px solid #f59e0b',
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {formatHm(seconds, t)}
          <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: 'var(--tax-muted)' }}>
            {author}
          </span>
          {!entry.billable && (
            <span style={{
              marginLeft: 6, padding: '0 6px', borderRadius: 999,
              background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            }}>{t('owner.tasks.time.nonBillable')}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 1 }}>
          {startedFmt}{endedFmt ? ` → ${endedFmt}` : ` · ${t('owner.tasks.time.runningNow')}`}
          {entry.note && <> · {entry.note}</>}
        </div>
      </div>
      {(isAdmin || /* author can edit own */ true) && closed && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" onClick={() => setEditing(true)}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-muted)' }}>
            {t('owner.tasks.time.edit')}
          </button>
          <button type="button" onClick={onDelete}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-error)' }}>
            {t('owner.services.delete')}
          </button>
        </div>
      )}
    </li>
  );
}

function TimeEntryEditForm({ entry, auth, t, onClose, onSaved }) {
  const startD = new Date(entry.started_at);
  const endD   = new Date(entry.ended_at);
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const [date, setDate] = useState(fmtDate(startD));
  const [startTime, setStartTime] = useState(fmtTime(startD));
  const [endTime, setEndTime] = useState(fmtTime(endD));
  const [note, setNote] = useState(entry.note || '');
  const [billable, setBillable] = useState(entry.billable !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    setBusy(true); setErr('');
    try {
      const startedAt = new Date(`${date}T${startTime}`).toISOString();
      const endedAt   = new Date(`${date}T${endTime}`).toISOString();
      await taxApi.adminUpdateTimeEntry(auth, entry.id, {
        startedAt, endedAt, note: note.trim(), billable,
      });
      onSaved();
    } catch (e) {
      setErr(e?.message || '');
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 6 }}>
      <div className="tax-form__row2">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} required />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} required />
          <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} required />
        </div>
      </div>
      <input type="text" value={note} onChange={e => setNote(e.target.value)} maxLength={500}
             placeholder={t('owner.tasks.time.manual.notePlaceholder')} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={billable} onChange={e => setBillable(e.target.checked)} />
        {t('owner.tasks.time.manual.billable')}
      </label>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.tasks.time.manual.save')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}

function formatHm(totalSeconds, t) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return `0${t('owner.tasks.time.unit.min')}`;
  if (h === 0) return `${m}${t('owner.tasks.time.unit.min')}`;
  if (m === 0) return `${h}${t('owner.tasks.time.unit.hr')}`;
  return `${h}${t('owner.tasks.time.unit.hr')} ${m}${t('owner.tasks.time.unit.min')}`;
}

function formatTs(iso, locale) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  } catch (_e) { return iso; }
}

// ─── Toolbar: My-tasks toggle + due chips + view-mode + group-by ─────────
function TaskToolbar({ mine, setMine, filters, setFilters, view, setView, groupBy, setGroupBy, sortKey, setSortKey, periodsGroup, setPeriodsGroup, t }) {
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
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {DUE_CHIPS.map(c => (
          <Pill key={c.key || 'all'} active={filters.due === c.key}
                onClick={() => setFilters(prev => ({ ...prev, due: c.key }))}>
            {c.label}
          </Pill>
        ))}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {view === 'list' && (
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
              <option value="dueBucket">{t('owner.tasks.groupBy.dueBucket')}</option>
            </select>
          </label>
        )}
        {view === 'list' && (
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
        {view === 'periods' && (
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
        <div role="tablist" style={{
          display: 'inline-flex', border: '1px solid var(--tax-border)', borderRadius: 6, overflow: 'hidden',
        }}>
          {['list', 'periods', 'calendar', 'kanban'].map(v => (
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
    <span style={{
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
                            customerById, employeeById, productById, isAdmin,
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
                   productById={productById} isAdmin={isAdmin}
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
      return [c?.id || '__none__', c ? (c.business_name || displayPersonName(c) || c.email) : t('owner.tasks.groupBy.practiceWide')];
    }
    if (groupBy === 'dueBucket') {
      const u = effectiveUrgency(task, thresholds, today);
      return [u, t(URGENCY_LABEL_KEY[u])];
    }
    return ['__none__', ''];
  };
  for (const task of tasks) {
    const [key, label] = keyFor(task);
    const slot = groups.get(key) || { label, items: [] };
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
              {g.label} <span style={{ marginLeft: 4, fontWeight: 500 }}>· {g.items.length}</span>
            </h3>
            <div style={{ display: 'grid', gap: 8 }}>
              <GroupSelectAll tasks={g.items} selectedIds={selectedIds}
                              toggleSelect={toggleSelect} selectMany={selectMany} t={t} />
              {g.items.map(task => (
                <TaskRow key={task.id} task={task} auth={auth} community={community}
                         statuses={statuses} employees={employees}
                         customerById={customerById} employeeById={employeeById}
                         productById={productById} isAdmin={isAdmin}
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
                        employeeById, productById, isAdmin, onEdit,
                        selectedIds, toggleSelect, selectMany,
                        periodsGroup = 'period',
                        mine, employeeId, locale, t }) {
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
                productById={productById} isAdmin={isAdmin}
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
                      isAdmin, selectedIds, toggleSelect, selectMany,
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
                         productById={productById} isAdmin={isAdmin}
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

function TasksCalendar({ tasks, community, statuses, onEdit, locale, t }) {
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
                             community={community} locale={locale} t={t}>
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

// ─── Kanban view (status columns + native drag-and-drop) ─────────────────
function TasksKanban({ tasks, statuses, community, auth, onChange, onEdit, locale, t }) {
  const thresholds = resolveThresholds(community);
  const todayIso = new Date().toISOString().slice(0, 10);
  const cols = statuses.length
    ? statuses.slice().sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
    : [{ id: 'fallback', key: 'not_started', label_i18n: { en: 'Not started', es: 'Sin iniciar' } }];
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
    const patch = ensureCompletionNotes({
      statuses, task, patch: { statusKey: targetKey }, t,
    });
    if (!patch) return;
    try {
      await taxApi.adminUpdateTask(auth, id, patch);
      onChange();
    } catch (_e) { /* swallow */ }
  };

  return (
    <div style={{
      display: 'grid', gap: 12,
      gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`,
      overflowX: 'auto',
    }}>
      {cols.map(col => {
        const items = tasksByStatus.get(col.key) || [];
        return (
          <div key={col.id || col.key}
               onDragOver={e => e.preventDefault()}
               onDrop={e => onDrop(e, col.key)}
               style={{
                 background: 'var(--tax-bg-alt)', borderRadius: 8,
                 padding: 8, minHeight: 200,
                 // Phase 4n.47: each column carries the status's
                 // owner-configured color along its top, so the
                 // Kanban inherits the same color language the chip
                 // uses in the List view.
                 borderTop: `3px solid ${col.color || '#9ca3af'}`,
               }}>
            <div style={{
              padding: '4px 6px 8px', fontSize: 12, fontWeight: 700,
              color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.04em',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 999,
                  background: col.color || '#9ca3af',
                }} />
                {pickI18n(col.label_i18n, locale).value || col.key}
              </span>
              <span style={{ fontWeight: 500 }}>· {items.length}</span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map(tt => {
                const c = colorOf(effectiveUrgency(tt, thresholds, todayIso), community);
                const custName = tt.customer
                  ? (tt.customer.business_name || displayPersonName(tt.customer) || tt.customer.email)
                  : '';
                return (
                  <TaskHover key={tt.id} task={tt} statuses={statuses}
                             community={community} locale={locale} t={t}>
                    <button type="button"
                            draggable
                            onDragStart={e => e.dataTransfer.setData('text/plain', tt.id)}
                            onClick={() => onEdit(tt)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left', cursor: 'grab',
                              padding: '8px 10px',
                              background: '#fff',
                              borderRadius: 6, border: '1px solid var(--tax-border)',
                              borderLeft: `4px solid ${c.bar}`,
                            }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{tt.title_i18n?.[locale] || tt.title_i18n?.[locale === 'en' ? 'es' : 'en'] || tt.title}</div>
                      {custName && (
                        <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
                          {custName}
                        </div>
                      )}
                      {tt.due_date && (
                        <div style={{ marginTop: 4 }}>
                          <DuePill dueDate={tt.due_date} thresholds={thresholds} t={t} />
                        </div>
                      )}
                    </button>
                  </TaskHover>
                );
              })}
              {items.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--tax-muted)', textAlign: 'center', padding: 12 }}>
                  {t('owner.tasks.kanban.empty')}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
