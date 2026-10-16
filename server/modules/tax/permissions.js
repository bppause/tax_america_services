// Employee permission registry for the tax module.
//
// Owners can selectively revoke specific powers from each employee.
// The default for every key is "granted" — a new employee starts with
// the same access surface as the owner. The owner toggles individual
// keys off through the Team-detail UI; a `false` in the employee's
// `permissions` JSON column means revoked. Anything else (missing,
// true, null) is treated as granted.
//
// To add a new permission:
//   1. Add it to PERMISSIONS below (key + i18n label/description keys)
//   2. Wire `requireTaxPermission(req, res, KEY)` at the route(s) that
//      should respect it
//   3. (Optional) hide the corresponding nav link in the frontend by
//      checking `employee?.permissions?.[KEY] !== false`
//
// Keys are namespaced to keep this file self-documenting. Pure-read
// endpoints generally stay role-gated; this registry is for *write*
// and *configuration* powers an owner might want to keep to
// themselves while still delegating day-to-day work.

const PERMISSIONS = [
  { key: 'view_customers',
    labelKey: 'owner.permissions.view_customers.label',
    descKey:  'owner.permissions.view_customers.desc' },
  { key: 'manage_customers',
    labelKey: 'owner.permissions.manage_customers.label',
    descKey:  'owner.permissions.manage_customers.desc' },
  { key: 'manage_leads',
    labelKey: 'owner.permissions.manage_leads.label',
    descKey:  'owner.permissions.manage_leads.desc' },
  { key: 'manage_services',
    labelKey: 'owner.permissions.manage_services.label',
    descKey:  'owner.permissions.manage_services.desc' },
  { key: 'manage_workflows',
    labelKey: 'owner.permissions.manage_workflows.label',
    descKey:  'owner.permissions.manage_workflows.desc' },
  { key: 'manage_email_templates',
    labelKey: 'owner.permissions.manage_email_templates.label',
    descKey:  'owner.permissions.manage_email_templates.desc' },
  { key: 'manage_settings',
    labelKey: 'owner.permissions.manage_settings.label',
    descKey:  'owner.permissions.manage_settings.desc' },
  { key: 'manage_employees',
    labelKey: 'owner.permissions.manage_employees.label',
    descKey:  'owner.permissions.manage_employees.desc' },
  { key: 'send_reminders',
    labelKey: 'owner.permissions.send_reminders.label',
    descKey:  'owner.permissions.send_reminders.desc' },
  { key: 'view_audit_logs',
    labelKey: 'owner.permissions.view_audit_logs.label',
    descKey:  'owner.permissions.view_audit_logs.desc' },
];
const VALID_KEYS = new Set(PERMISSIONS.map(p => p.key));

// Effective check. Returns true unless the employee row explicitly
// stamps `permissions[key] === false`. Owner-admin actors are
// handled at the caller (requireOwnerAdmin path). This helper just
// answers "given THIS employee row, are they granted this key?"
function hasEmployeePermission(employee, key) {
  if (!employee) return false;
  return employee.permissions?.[key] !== false;
}

// Sanitize an incoming permissions payload to drop unknown keys and
// coerce values to booleans. Returns an object that only contains
// explicit `false` entries; granted keys are omitted so the column
// default (`{}`) keeps doing the work.
function sanitizePermissions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    if (!VALID_KEYS.has(k)) continue;
    if (raw[k] === false) out[k] = false;
  }
  return out;
}

module.exports = {
  PERMISSIONS,
  VALID_KEYS,
  hasEmployeePermission,
  sanitizePermissions,
};
