// Shared task status-change helpers — used by every surface that can
// change a task's status_key (the Tasks list row, Kanban drag-drop, the
// task edit modal, the customer-profile task list, and the TaskHover
// popover shared across Calendar/Kanban/Dashboard/etc.). Lives outside
// pages/OwnerTasks.jsx specifically so TaskHover (which OwnerTasks.jsx
// itself imports) can use these too without a circular import.

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
// in OwnerTasks.jsx) so it shows up in that shared history too —
// `onNewNote(trimmedNote)`, when supplied, fires for exactly that case
// (never for an already-existing note, which would just duplicate it).
//
// `promptKey`, when passed, overrides the default terminal/non-terminal
// copy selection below — used when a status change is itself implied by
// some other action (e.g. the explicit "Start task" button) and the
// generic "status change" wording wouldn't explain why the prompt
// appeared.
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
