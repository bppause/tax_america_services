// Shared urgency-color helper. Drives the colored due-date treatment
// on the Tasks list, Calendar pips, and Kanban cards — same visual
// language everywhere.
//
// Two thresholds per community drive the model:
//   urgent_days — due within N days → RED (act-now)
//   soon_days   — due within N days → AMBER (heads-up)
// Anything past today is OVERDUE — rendered in a darker crimson so
// the eye distinguishes "already late" from "due imminently".
// Anything farther out than soon_days has NO color so the operator's
// eye stays on the items that need attention right now.

const DEFAULTS = { urgent: 2, soon: 7 };

export function resolveThresholds(community) {
  return {
    urgent: Number(community?.tax_task_urgent_days ?? DEFAULTS.urgent),
    soon:   Number(community?.tax_task_soon_days   ?? DEFAULTS.soon),
  };
}

// Returns one of:
//   'overdue' — strictly before today (deep crimson)
//   'urgent'  — today + within urgent_days (red)
//   'soon'    — within soon_days (amber)
//   'later'   — farther out, or no due date (NO color)
export function urgencyOf(dueDate, thresholds, todayIso) {
  if (!dueDate) return 'later';
  const today = todayIso || new Date().toISOString().slice(0, 10);
  if (dueDate < today) return 'overdue';
  const days = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000);
  const th = thresholds || DEFAULTS;
  if (days <= th.urgent) return 'urgent';
  if (days <= th.soon)   return 'soon';
  return 'later';
}

// Default color tokens. Picked to read as a four-step gradient at
// a glance: deep crimson (overdue) → red (urgent) → amber (soon)
// → transparent (later). The dark/light split between overdue and
// urgent is the important one — prior version used the same hex
// for both, so the owner couldn't tell a past-due row from a
// due-today row without reading the date. 'later' stays
// transparent so the operator's eye lands on red and amber rows
// only. Owners can override any of the four anchor colors per
// community via tax_task_urgency_colors; the chip background is
// then derived from the anchor as a light tint.
export const URGENCY_DEFAULTS = {
  overdue: '#7f1d1d',
  urgent:  '#dc2626',
  soon:    '#f59e0b',
  later:   'transparent',
};
export const PRIORITY_DEFAULTS = {
  urgent: '#dc2626',
  high:   '#ea580c',
  normal: '#3730a3',
  low:    '#6b7280',
};

// Derive a chip-friendly { bg, fg, dot, bar } palette from a single
// anchor hex. Light tint for the chip background, the anchor itself
// for the chip text + dots + bars. Transparent passes through.
function paletteFromAnchor(anchor) {
  if (!anchor || anchor === 'transparent') {
    return { bg: 'transparent', fg: 'var(--tax-muted)', dot: 'transparent', bar: 'transparent' };
  }
  return {
    bg:  `color-mix(in srgb, ${anchor} 18%, #fff)`,
    fg:  anchor,
    dot: anchor,
    bar: anchor,
  };
}

// Resolve the urgency anchor for a bucket given an optional
// community overrides map. Missing keys fall back to the platform
// defaults.
export function resolveUrgencyAnchor(urgency, overrides) {
  const v = overrides?.[urgency];
  if (typeof v === 'string' && v) return v;
  return URGENCY_DEFAULTS[urgency] || URGENCY_DEFAULTS.later;
}

// Backwards-compat: callers that pre-date the override system call
// colorOf(urgency). Newer callers pass the community so per-
// community overrides apply.
export function colorOf(urgency, community) {
  return paletteFromAnchor(resolveUrgencyAnchor(urgency, community?.tax_task_urgency_colors));
}

// Same shape for priority chips — returns the palette an inline
// chip can use. Falls back to platform defaults when the community
// hasn't set an override for that priority.
export function priorityColorOf(priority, community) {
  const v = community?.tax_task_priority_colors?.[priority];
  const anchor = (typeof v === 'string' && v) ? v : (PRIORITY_DEFAULTS[priority] || PRIORITY_DEFAULTS.normal);
  return paletteFromAnchor(anchor);
}

// Priority-floor urgency. Priority acts as a *minimum* urgency on
// the same color language used for due dates — so the operator
// only memorizes one palette and a glance answers "act now?"
// regardless of whether it's the deadline or the importance
// driving the highlight.
//
//   urgent priority → always red (treated as 'overdue')
//   high   priority → always at least orange ('soon')
//   normal priority → due-date drives entirely
//   low    priority → due-date drives, but capped at orange
//                     (a "low + 2 days" task should NOT scream red)
//
// Completed tasks always render neutral — there's no urgency once
// the work is done.
const PRIORITY_FLOOR = { urgent: 'overdue', high: 'soon', normal: 'later', low: 'later' };
const URGENCY_RANK   = { overdue: 0, urgent: 1, soon: 2, later: 3 };

export function effectiveUrgency(task, thresholds, todayIso) {
  if (!task) return 'later';
  if (task.completed_at) return 'later';
  let dueU = urgencyOf(task.due_date, thresholds, todayIso);
  if (task.priority === 'low' && dueU === 'urgent') dueU = 'soon';
  const floor = PRIORITY_FLOOR[task.priority] || 'later';
  return URGENCY_RANK[floor] < URGENCY_RANK[dueU] ? floor : dueU;
}

export const URGENCY_LABEL_KEY = {
  overdue: 'owner.tasks.urgency.overdue',
  urgent:  'owner.tasks.urgency.urgent',
  soon:    'owner.tasks.urgency.soon',
  later:   'owner.tasks.urgency.later',
};
