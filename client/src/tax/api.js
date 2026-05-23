// Thin fetch wrapper for /api/m/tax/* endpoints.
// Errors throw with .status and .body attached so callers can branch on 4xx/5xx.
//
// Portal calls take an `auth` object { uid, email, communitySlug } that
// becomes x-firebase-uid, x-firebase-email, x-tax-community headers. The
// server validates these against tax_customers on every request.

const BASE = '/api/m/tax';
const IMPERSONATION_KEY = 'tax-impersonation';

// Impersonation state lives in sessionStorage (tab-scoped). When present,
// portal/employee requests send x-impersonation-token instead of Firebase
// auth headers; admin requests do NOT use the impersonation header (the
// admin's normal identity stays in charge for admin endpoints).
export function getImpersonation() {
  try {
    const raw = sessionStorage.getItem(IMPERSONATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_e) { return null; }
}
export function setImpersonation(state) {
  try { sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(state)); } catch (_e) {}
}
export function clearImpersonation() {
  try { sessionStorage.removeItem(IMPERSONATION_KEY); } catch (_e) {}
}

function authHeaders(auth) {
  // When impersonating, use the token instead of Firebase headers. Server
  // resolves the target identity from the token; community is included
  // for symmetry but not strictly needed (the token is community-bound).
  const imp = getImpersonation();
  if (imp && imp.token) {
    return {
      'x-impersonation-token': imp.token,
      'x-tax-community': imp.communitySlug || '',
    };
  }
  if (!auth || !auth.uid || !auth.email) return {};
  return {
    'x-firebase-uid': auth.uid,
    'x-firebase-email': auth.email,
    'x-tax-community': auth.communitySlug || '',
  };
}

// Admin headers: always uses the real admin identity, never the impersonation
// token. Admin actions (including start/end impersonation) must trace back
// to the real human.
function adminAuthHeaders(auth) {
  const hdrs = {
    'x-admin-email': auth?.adminEmail || auth?.email || '',
  };
  if (auth?.uid)   hdrs['x-firebase-uid']   = auth.uid;
  if (auth?.email) hdrs['x-firebase-email'] = auth.email;
  if (auth?.communitySlug) hdrs['x-tax-community'] = auth.communitySlug;
  return hdrs;
}

async function request(method, path, body, auth, { admin } = {}) {
  const headers = admin ? adminAuthHeaders(auth) : authHeaders(auth);
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text }; }
  if (!res.ok) {
    const err = new Error((parsed && parsed.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export const taxApi = {
  // Public (Phase 1 + 1.5)
  getCommunity(slug)              { return request('GET',  `/community/${encodeURIComponent(slug)}`); },
  getCommunityFaqs(slug)          { return request('GET',  `/community/${encodeURIComponent(slug)}/faqs`); },
  getCommunityArticles(slug)      { return request('GET',  `/community/${encodeURIComponent(slug)}/articles`); },
  getCommunityTeam(slug)          { return request('GET',  `/community/${encodeURIComponent(slug)}/team`); },
  submitLead(payload)             { return request('POST', '/leads', payload); },
  getResponse(token)              { return request('GET',  `/respond/${encodeURIComponent(token)}`); },
  submitResponse(token, payload)  { return request('POST', `/respond/${encodeURIComponent(token)}`, payload); },

  // Portal (Phase 2a) — `auth = { uid, email, communitySlug }`
  authLink(payload)               { return request('POST', '/auth/link', payload); },
  getMe(auth)                     { return request('GET',  '/portal/me', undefined, auth); },
  getFilings(auth)                { return request('GET',  '/portal/filings', undefined, auth); },
  getFiling(auth, id)             { return request('GET',  `/portal/filings/${encodeURIComponent(id)}`, undefined, auth); },
  submitFiling(auth, id, payload) { return request('POST', `/portal/filings/${encodeURIComponent(id)}/respond`, payload, auth); },
  getNotifications(auth)          { return request('GET',  '/portal/notifications', undefined, auth); },
  markNotificationRead(auth, id)  { return request('POST', `/portal/notifications/${encodeURIComponent(id)}/read`, {}, auth); },
  updatePreferences(auth, payload){ return request('PUT',  '/portal/preferences', payload, auth); },
  updateProfile(auth, payload)    { return request('PUT',  '/portal/profile', payload, auth); },

  // Portal (Phase 2b) — relationships + FAQs
  getRelationships(auth)          { return request('GET',  '/portal/relationships', undefined, auth); },
  getFaqs(auth)                   { return request('GET',  '/portal/faqs', undefined, auth); },

  // Portal (Phase 2c) — relationship-tailored tips
  getTips(auth)                   { return request('GET',  '/portal/tips', undefined, auth); },

  // Portal + employee (Phase 4c) — help center
  getHelp(auth)                   { return request('GET',  '/portal/help', undefined, auth); },
  getEmployeeHelp(auth)           { return request('GET',  '/employee/help', undefined, auth); },

  // Portal (Phase 2f) — messaging
  getThreads(auth)                              { return request('GET',  '/portal/threads', undefined, auth); },
  createThread(auth, payload)                   { return request('POST', '/portal/threads', payload, auth); },
  getThread(auth, id)                           { return request('GET',  `/portal/threads/${encodeURIComponent(id)}`, undefined, auth); },
  postMessage(auth, id, payload)                { return request('POST', `/portal/threads/${encodeURIComponent(id)}/messages`, payload, auth); },
  markThreadRead(auth, id)                      { return request('POST', `/portal/threads/${encodeURIComponent(id)}/read`, {}, auth); },

  // Portal (Phase 2d) — customer documents
  getDocuments(auth)                            { return request('GET',  '/portal/documents', undefined, auth); },
  createDocumentUploadUrl(auth, payload)        { return request('POST', '/portal/documents/upload-url', payload, auth); },
  finalizeDocumentUpload(auth, id)              { return request('POST', `/portal/documents/${encodeURIComponent(id)}/finalize`, {}, auth); },
  getDocumentDownloadUrl(auth, id)              { return request('GET',  `/portal/documents/${encodeURIComponent(id)}/download-url`, undefined, auth); },
  deleteDocument(auth, id)                      { return request('DELETE', `/portal/documents/${encodeURIComponent(id)}`, undefined, auth); },

  // Employee portal (Phase 3) — `auth = { uid, email, communitySlug }`
  employeeAuthLink(payload)                     { return request('POST', '/employee/auth/link', payload); },
  getEmployeeMe(auth)                           { return request('GET',  '/employee/me', undefined, auth); },
  updateEmployeeProfile(auth, payload)          { return request('PUT',  '/employee/profile', payload, auth); },
  getEmployeeNotificationTypes(auth)            { return request('GET',  '/employee/notification-types', undefined, auth); },
  getEmployeeThreads(auth)                      { return request('GET',  '/employee/threads', undefined, auth); },
  getEmployeeThread(auth, id)                   { return request('GET',  `/employee/threads/${encodeURIComponent(id)}`, undefined, auth); },
  postEmployeeMessage(auth, id, payload)        { return request('POST', `/employee/threads/${encodeURIComponent(id)}/messages`, payload, auth); },
  markEmployeeThreadRead(auth, id)              { return request('POST', `/employee/threads/${encodeURIComponent(id)}/read`, {}, auth); },
  getEmployeeNotifications(auth)                { return request('GET',  '/employee/notifications', undefined, auth); },
  markEmployeeNotificationRead(auth, id)        { return request('POST', `/employee/notifications/${encodeURIComponent(id)}/read`, {}, auth); },

  // Owner-admin (Phase 4a) — all admin endpoints. Pass auth =
  // { uid, email, communitySlug, adminEmail }. adminEmail is the address
  // that should match GLOBAL_ADMIN_EMAILS (legacy endpoints); when omitted
  // we fall back to auth.email.
  adminListCustomers(auth, communitySlug, opts = {}) {
    const qs = new URLSearchParams({ communitySlug });
    if (opts.q) qs.set('q', opts.q);
    if (opts.relationshipTypeIds && opts.relationshipTypeIds.length) {
      qs.set('relationshipTypeIds', opts.relationshipTypeIds.join(','));
    }
    if (opts.customerType) qs.set('customerType', opts.customerType);
    if (opts.includeArchived) qs.set('includeArchived', 'true');
    return request('GET',  `/admin/customers?${qs.toString()}`, undefined, auth, { admin: true });
  },

  // Staff + admin: scoped customer search via the employee gate.
  listEmployeeCustomers(auth, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.q) qs.set('q', opts.q);
    if (opts.relationshipTypeIds && opts.relationshipTypeIds.length) {
      qs.set('relationshipTypeIds', opts.relationshipTypeIds.join(','));
    }
    if (opts.customerType) qs.set('customerType', opts.customerType);
    if (opts.includeArchived) qs.set('includeArchived', 'true');
    const path = '/employee/customers' + (qs.toString() ? `?${qs.toString()}` : '');
    return request('GET',  path, undefined, auth);
  },
  adminCreateCustomer(auth, payload)            { return request('POST', '/admin/customers', payload, auth, { admin: true }); },
  adminCustomerDefaultProduct(auth, customerId) {
    return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/default-product`, undefined, auth);
  },
  adminListCustomerServices(auth, customerId) {
    return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/services`, undefined, auth, { admin: true });
  },
  adminAddCustomerService(auth, customerId, payload) {
    return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/services`, payload, auth, { admin: true });
  },
  adminRemoveCustomerService(auth, customerId, linkId) {
    return request('DELETE', `/admin/customers/${encodeURIComponent(customerId)}/services/${encodeURIComponent(linkId)}`, undefined, auth, { admin: true });
  },
  adminImportCustomers(auth, payload)           { return request('POST', '/admin/customers/import', payload, auth, { admin: true }); },
  adminGetCustomer(auth, id)                    { return request('GET',  `/admin/customers/${encodeURIComponent(id)}`, undefined, auth, { admin: true }); },
  adminSendWelcomeEmail(auth, id)               { return request('POST', `/admin/customers/${encodeURIComponent(id)}/send-welcome`, {}, auth, { admin: true }); },

  adminListRelationshipTypes(auth, opts = {})   {
    const qs = new URLSearchParams();
    if (opts.communitySlug) qs.set('communitySlug', opts.communitySlug);
    if (opts.includeInactive) qs.set('includeInactive', '1');
    const tail = qs.toString();
    return request('GET',  `/admin/relationship-types${tail ? `?${tail}` : ''}`, undefined, auth, { admin: true });
  },
  adminCreateRelationshipType(auth, payload)    { return request('POST', '/admin/relationship-types', payload, auth, { admin: true }); },
  adminUpdateRelationshipType(auth, id, payload){ return request('PUT', `/admin/relationship-types/${encodeURIComponent(id)}`, payload, auth, { admin: true }); },
  adminListCustomerRelationships(auth, customerId) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/relationships`, undefined, auth, { admin: true }); },
  adminAddCustomerRelationship(auth, customerId, payload) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/relationships`, payload, auth, { admin: true }); },
  adminRemoveCustomerRelationship(auth, customerId, relId) { return request('DELETE', `/admin/customers/${encodeURIComponent(customerId)}/relationships/${encodeURIComponent(relId)}`, undefined, auth, { admin: true }); },

  adminListCustomerDocuments(auth, customerId)  { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/documents`, undefined, auth, { admin: true }); },
  adminCustomerDocumentUploadUrl(auth, customerId, payload) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/documents/upload-url`, payload, auth, { admin: true }); },
  adminFinalizeDocument(auth, docId)            { return request('POST', `/admin/documents/${encodeURIComponent(docId)}/finalize`, {}, auth, { admin: true }); },
  adminGetDocumentDownloadUrl(auth, docId)      { return request('GET',  `/admin/documents/${encodeURIComponent(docId)}/download-url`, undefined, auth, { admin: true }); },
  adminDeleteDocument(auth, docId)              { return request('DELETE', `/admin/documents/${encodeURIComponent(docId)}`, undefined, auth, { admin: true }); },

  adminGetSetupStatus(auth, communitySlug)      { return request('GET',  `/admin/setup-status?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminListEmployees(auth, communitySlug)       { return request('GET',  `/admin/employees?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminCreateEmployee(auth, payload)            { return request('POST', '/admin/employees', payload, auth, { admin: true }); },
  adminSendStaffWelcomeEmail(auth, id)          { return request('POST', `/admin/employees/${encodeURIComponent(id)}/send-welcome`, {}, auth, { admin: true }); },
  adminSetEmployeeStatus(auth, id, payload)     { return request('PUT', `/admin/employees/${encodeURIComponent(id)}/status`, payload, auth, { admin: true }); },
  adminListPermissions(auth)                    { return request('GET', '/admin/permissions', undefined, auth, { admin: true }); },
  adminSetEmployeePermissions(auth, id, permissions) {
    return request('PUT', `/admin/employees/${encodeURIComponent(id)}/permissions`, { permissions }, auth, { admin: true });
  },
  adminSetEmployeePublicProfile(auth, id, payload) {
    return request('PUT', `/admin/employees/${encodeURIComponent(id)}/public-profile`, payload, auth, { admin: true });
  },
  adminEmployeePhotoUploadUrl(auth, id, payload) {
    return request('POST', `/admin/employees/${encodeURIComponent(id)}/photo/upload-url`, payload, auth, { admin: true });
  },

  adminListEmailTemplates(auth, communitySlug)  { return request('GET',  `/admin/email-templates?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminUpdateEmailTemplate(auth, key, lang, payload) { return request('PUT', `/admin/email-templates/${encodeURIComponent(key)}/${encodeURIComponent(lang)}`, payload, auth, { admin: true }); },
  adminResetEmailTemplate(auth, key, lang, communitySlug) { return request('DELETE', `/admin/email-templates/${encodeURIComponent(key)}/${encodeURIComponent(lang)}?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminPreviewEmailTemplate(auth, payload) { return request('POST', '/admin/email-templates/preview', payload, auth, { admin: true }); },
  adminGetEmailTemplateDefaults(auth, key, lang) { return request('GET', `/admin/email-templates/defaults?key=${encodeURIComponent(key)}&lang=${encodeURIComponent(lang)}`, undefined, auth, { admin: true }); },

  adminListFilingSchedules(auth, communitySlug)  { return request('GET', `/admin/filing-schedules?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminCreateFilingSchedule(auth, payload) { return request('POST', '/admin/filing-schedules', payload, auth, { admin: true }); },
  adminListWorkflowTemplates(auth) { return request('GET', '/admin/workflow-templates', undefined, auth, { admin: true }); },
  adminCloneWorkflowTemplate(auth, templateId, payload) { return request('POST', `/admin/workflow-templates/${encodeURIComponent(templateId)}/clone`, payload, auth, { admin: true }); },
  adminGetWorkflowAudit(auth, ruleId, limit = 20) { return request('GET', `/admin/workflows/${encodeURIComponent(ruleId)}/audit?limit=${limit}`, undefined, auth, { admin: true }); },
  adminUpdateCommunityContact(auth, payload) { return request('PUT', '/admin/community-settings/contact', payload, auth, { admin: true }); },
  adminUpdateLandingCopy(auth, payload) { return request('PUT', '/admin/community-settings/landing-copy', payload, auth, { admin: true }); },
  adminPromoteCustomerToStaff(auth, customerId, payload) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/promote-to-staff`, payload, auth, { admin: true }); },
  adminSetCustomerStatus(auth, customerId, payload) { return request('PUT', `/admin/customers/${encodeURIComponent(customerId)}/status`, payload, auth, { admin: true }); },
  // Customer notes — admin-scoped routes; auth headers are admin headers.
  adminListCustomerNotes(auth, customerId) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/notes`, undefined, auth, { admin: true }); },
  adminCreateCustomerNote(auth, customerId, payload) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/notes`, payload, auth, { admin: true }); },
  adminGetCustomerActivity(auth, customerId, limit = 100) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/activity?limit=${limit}`, undefined, auth, { admin: true }); },
  adminUndoCustomerActivity(auth, customerId, auditId) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/activity/undo`, { auditId }, auth, { admin: true }); },
  getEmployeeTriage(auth, windowDays = 7) { return request('GET', `/employee/triage?windowDays=${windowDays}`, undefined, auth); },

  // Phase 4n.55: time tracking on tasks. The list/start/stop/add/edit/delete
  // endpoints below all sit under the standard employee-auth surface so the
  // header timer pill and the task-editor section can share one wrapper.
  adminListTaskTimeEntries(auth, taskId)             { return request('GET',    `/admin/tasks/${encodeURIComponent(taskId)}/time-entries`, undefined, auth); },
  adminStartTaskTimer(auth, taskId, payload = {})    { return request('POST',   `/admin/tasks/${encodeURIComponent(taskId)}/time-entries/start`, payload, auth); },
  adminStopTaskTimer(auth, taskId, payload = {})     { return request('POST',   `/admin/tasks/${encodeURIComponent(taskId)}/time-entries/stop`, payload, auth); },
  adminAddTaskTimeEntry(auth, taskId, payload)       { return request('POST',   `/admin/tasks/${encodeURIComponent(taskId)}/time-entries`, payload, auth); },
  adminUpdateTimeEntry(auth, entryId, payload)       { return request('PUT',    `/admin/time-entries/${encodeURIComponent(entryId)}`, payload, auth); },
  adminDeleteTimeEntry(auth, entryId)                { return request('DELETE', `/admin/time-entries/${encodeURIComponent(entryId)}`, undefined, auth); },
  getMyRunningTimer(auth)                            { return request('GET',    '/admin/employees/me/running-timer', undefined, auth); },

  // Phase 4n.24: signature requests
  adminListSignatureRequests(auth, customerId) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/signature-requests`, undefined, auth, { admin: true }); },
  adminCreateSignatureRequest(auth, customerId, payload) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/signature-requests`, payload, auth, { admin: true }); },
  adminCancelSignatureRequest(auth, customerId, reqId) { return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/signature-requests/${encodeURIComponent(reqId)}/cancel`, {}, auth, { admin: true }); },
  getPortalSignatureRequests(auth) { return request('GET', '/portal/signature-requests', undefined, auth); },
  getPortalSignatureRequest(auth, id) { return request('GET', `/portal/signature-requests/${encodeURIComponent(id)}`, undefined, auth); },
  signPortalSignatureRequest(auth, id, payload) { return request('POST', `/portal/signature-requests/${encodeURIComponent(id)}/sign`, payload, auth); },
  declinePortalSignatureRequest(auth, id) { return request('POST', `/portal/signature-requests/${encodeURIComponent(id)}/decline`, {}, auth); },
  adminListCustomerWorkflowOverrides(auth, customerId) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/workflow-overrides`, undefined, auth, { admin: true }); },
  adminUpsertCustomerWorkflowOverride(auth, customerId, ruleId, payload) { return request('PUT', `/admin/customers/${encodeURIComponent(customerId)}/workflow-overrides/${encodeURIComponent(ruleId)}`, payload, auth, { admin: true }); },
  adminDeleteCustomerWorkflowOverride(auth, customerId, ruleId) { return request('DELETE', `/admin/customers/${encodeURIComponent(customerId)}/workflow-overrides/${encodeURIComponent(ruleId)}`, undefined, auth, { admin: true }); },
  adminGetWorkflowEngagement(auth, ruleId, windowDays = 90) { return request('GET', `/admin/workflows/${encodeURIComponent(ruleId)}/engagement?windowDays=${windowDays}`, undefined, auth, { admin: true }); },
  adminSendWorkflowTestReminder(auth, ruleId, payload) { return request('POST', `/admin/workflows/${encodeURIComponent(ruleId)}/test-reminder`, payload, auth, { admin: true }); },
  adminListRelationshipWorkflowRules(auth, communitySlug) { return request('GET', `/admin/relationship-workflow-rules?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminUpdateRelationshipWorkflowRule(auth, relTypeId, scheduleSlug, payload) { return request('PUT', `/admin/relationship-workflow-rules/${encodeURIComponent(relTypeId)}/${encodeURIComponent(scheduleSlug)}`, payload, auth, { admin: true }); },
  adminDeleteRelationshipWorkflowRule(auth, relTypeId, scheduleSlug, communitySlug) { return request('DELETE', `/admin/relationship-workflow-rules/${encodeURIComponent(relTypeId)}/${encodeURIComponent(scheduleSlug)}?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },

  adminListEmployeeAssignments(auth, empId)     { return request('GET', `/admin/employees/${encodeURIComponent(empId)}/assignments`, undefined, auth, { admin: true }); },
  adminAddEmployeeAssignment(auth, empId, payload) { return request('POST', `/admin/employees/${encodeURIComponent(empId)}/assignments`, payload, auth, { admin: true }); },
  adminRemoveEmployeeAssignment(auth, empId, customerId) { return request('DELETE', `/admin/employees/${encodeURIComponent(empId)}/assignments/${encodeURIComponent(customerId)}`, undefined, auth, { admin: true }); },
  adminListCustomerAssignments(auth, customerId) { return request('GET', `/admin/customers/${encodeURIComponent(customerId)}/assignments`, undefined, auth, { admin: true }); },

  // Phase 4b — subscriptions, leads, community settings
  adminGetCommunitySettings(auth, communitySlug) { return request('GET',  `/admin/community-settings?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminSetNotifLock(auth, payload)               { return request('PUT',  '/admin/community-settings/notif-lock', payload, auth, { admin: true }); },
  adminSetDocumentsEnabled(auth, payload)        { return request('PUT',  '/admin/community-settings/documents-enabled', payload, auth, { admin: true }); },
  adminSetPortalEnabled(auth, payload)           { return request('PUT',  '/admin/community-settings/portal-enabled', payload, auth, { admin: true }); },

  adminListProducts(auth, communitySlug)         { return request('GET',  `/admin/products?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true }); },
  adminCreateProduct(auth, payload)              { return request('POST', '/admin/products', payload, auth, { admin: true }); },
  adminUpdateProduct(auth, productId, payload)   { return request('PUT',  `/admin/products/${encodeURIComponent(productId)}`, payload, auth, { admin: true }); },
  adminDeleteProduct(auth, productId, opts = {}) {
    const qs = opts.force ? '?force=1' : '';
    return request('DELETE', `/admin/products/${encodeURIComponent(productId)}${qs}`, undefined, auth, { admin: true });
  },
  adminListAutoTasks(auth, productId) {
    return request('GET', `/admin/products/${encodeURIComponent(productId)}/auto-tasks`, undefined, auth, { admin: true });
  },
  adminReplaceAutoTasks(auth, productId, autoTasks) {
    return request('PUT', `/admin/products/${encodeURIComponent(productId)}/auto-tasks`, { autoTasks }, auth, { admin: true });
  },

  adminDashboard(auth, communitySlug) {
    const qs = communitySlug ? `?communitySlug=${encodeURIComponent(communitySlug)}` : '';
    return request('GET', `/admin/dashboard${qs}`, undefined, auth);
  },
  adminTaskProgress(auth, opts = {}) {
    const qs = new URLSearchParams();
    if (opts.communitySlug) qs.set('communitySlug', opts.communitySlug);
    if (opts.assignedTo)    qs.set('assignedTo', opts.assignedTo);
    if (opts.customerId)    qs.set('customerId', opts.customerId);
    if (opts.customerType)  qs.set('customerType', opts.customerType);
    return request('GET', `/admin/progress?${qs.toString()}`, undefined, auth);
  },
  adminSetRemindersEnabled(auth, payload) {
    return request('PUT', '/admin/community-settings/reminders-enabled', payload, auth, { admin: true });
  },
  adminSetCustomerEmailEnabled(auth, payload) {
    return request('PUT', '/admin/community-settings/customer-email-enabled', payload, auth, { admin: true });
  },
  adminSetCustomerEmailsMaster(auth, payload) {
    return request('PUT', '/admin/community-settings/customer-emails-master', payload, auth, { admin: true });
  },
  adminSetStaffEmailEnabled(auth, payload) {
    return request('PUT', '/admin/community-settings/staff-email-enabled', payload, auth, { admin: true });
  },
  adminSetStaffEmailsMaster(auth, payload) {
    return request('PUT', '/admin/community-settings/staff-emails-master', payload, auth, { admin: true });
  },
  adminSetDigestSchedule(auth, payload) {
    return request('PUT', '/admin/community-settings/digest-schedule', payload, auth, { admin: true });
  },
  adminSetEmailFrom(auth, payload) {
    return request('PUT', '/admin/community-settings/email-from', payload, auth, { admin: true });
  },
  adminSetTaskLookahead(auth, payload) {
    return request('PUT', '/admin/community-settings/task-lookahead-months', payload, auth, { admin: true });
  },
  adminSetTaskThresholds(auth, payload) {
    return request('PUT', '/admin/community-settings/task-thresholds', payload, auth, { admin: true });
  },
  adminSetTaskColorOverrides(auth, payload) {
    return request('PUT', '/admin/community-settings/task-color-overrides', payload, auth, { admin: true });
  },
  adminRefreshTasks(auth) {
    return request('POST', '/admin/tasks/refresh', {}, auth, { admin: true });
  },

  adminListUpcomingReminders(auth, opts = {}) {
    const qs = new URLSearchParams();
    for (const k of ['communitySlug','status','due','productId','q']) {
      if (opts[k] !== undefined && opts[k] !== '') qs.set(k, opts[k]);
    }
    return request('GET', `/admin/upcoming-reminders?${qs.toString()}`, undefined, auth);
  },
  adminSendReminderNow(auth, periodId, opts = {}) {
    return request('POST', `/admin/upcoming-reminders/${encodeURIComponent(periodId)}/send`, opts, auth);
  },

  // ── Tasks ────────────────────────────────────────────────────────────
  adminListTaskStatuses(auth, communitySlug) {
    return request('GET', `/admin/task-statuses?communitySlug=${encodeURIComponent(communitySlug)}`, undefined, auth, { admin: true });
  },
  adminCreateTaskStatus(auth, payload)        { return request('POST',   '/admin/task-statuses', payload, auth, { admin: true }); },
  adminUpdateTaskStatus(auth, id, payload)    { return request('PATCH',  `/admin/task-statuses/${encodeURIComponent(id)}`, payload, auth, { admin: true }); },
  adminDeleteTaskStatus(auth, id)             { return request('DELETE', `/admin/task-statuses/${encodeURIComponent(id)}`, undefined, auth, { admin: true }); },
  adminTaskSuggestions(auth, productSlug) {
    const qs = productSlug ? `?productSlug=${encodeURIComponent(productSlug)}` : '';
    return request('GET', `/admin/task-suggestions${qs}`, undefined, auth, { admin: true });
  },
  adminListTasks(auth, opts = {}) {
    const qs = new URLSearchParams();
    for (const k of ['communitySlug','status','priority','assignedTo','customerId','customerType','productId','due','q','limit','sort','serviceAutoTaskId','dueDateExact']) {
      if (opts[k] !== undefined && opts[k] !== '') qs.set(k, opts[k]);
    }
    return request('GET', `/admin/tasks?${qs.toString()}`, undefined, auth);
  },
  adminListTaskPeriods(auth, opts = {}) {
    const qs = new URLSearchParams();
    for (const k of ['communitySlug','status','priority','assignedTo','customerId','customerType','productId','due']) {
      if (opts[k] !== undefined && opts[k] !== '') qs.set(k, opts[k]);
    }
    return request('GET', `/admin/tasks/periods?${qs.toString()}`, undefined, auth);
  },
  adminCreateTask(auth, payload)              { return request('POST',   '/admin/tasks', payload, auth); },
  adminUpdateTask(auth, id, payload)          { return request('PATCH',  `/admin/tasks/${encodeURIComponent(id)}`, payload, auth); },
  adminBulkUpdateTasks(auth, payload)         { return request('PATCH',  '/admin/tasks/bulk', payload, auth); },
  adminDeleteTask(auth, id)                   { return request('DELETE', `/admin/tasks/${encodeURIComponent(id)}`, undefined, auth); },
  adminAddSubscription(auth, customerId, payload){ return request('POST', `/admin/customers/${encodeURIComponent(customerId)}/subscriptions`, payload, auth, { admin: true }); },
  adminUpdateSubscription(auth, subId, payload)  { return request('PUT',  `/admin/subscriptions/${encodeURIComponent(subId)}`, payload, auth, { admin: true }); },
  adminCancelSubscription(auth, subId)           { return request('DELETE', `/admin/subscriptions/${encodeURIComponent(subId)}`, undefined, auth, { admin: true }); },

  adminListLeads(auth, communitySlug, opts = {}) {
    const qs = new URLSearchParams({ communitySlug });
    if (opts.status) qs.set('status', opts.status);
    if (opts.customerType) qs.set('customerType', opts.customerType);
    if (opts.businessName) qs.set('businessName', opts.businessName);
    return request('GET',  `/admin/leads?${qs.toString()}`, undefined, auth, { admin: true });
  },
  adminUpdateLead(auth, leadId, payload)         { return request('PUT',  `/admin/leads/${encodeURIComponent(leadId)}`, payload, auth, { admin: true }); },
  adminConvertLead(auth, leadId, payload = {})   { return request('POST', `/admin/leads/${encodeURIComponent(leadId)}/convert`, payload, auth, { admin: true }); },

  // Phase 4d — admin overrides
  adminUpdateCustomer(auth, customerId, payload) { return request('PUT',  `/admin/customers/${encodeURIComponent(customerId)}`, payload, auth, { admin: true }); },
  adminUpdatePeriod(auth, periodId, payload)     { return request('PUT',  `/admin/periods/${encodeURIComponent(periodId)}`, payload, auth, { admin: true }); },

  // Impersonation (admin-only)
  adminStartImpersonation(auth, payload)         { return request('POST', '/admin/impersonation/start', payload, auth, { admin: true }); },
  adminEndImpersonation(auth, token)             { return request('POST', `/admin/impersonation/${encodeURIComponent(token)}/end`, {}, auth, { admin: true }); },

  // Phase 4e — owner-managed help articles
  adminListHelp(auth, communitySlug, audience)   {
    const qs = new URLSearchParams({ communitySlug });
    if (audience) qs.set('audience', audience);
    return request('GET',  `/admin/help?${qs.toString()}`, undefined, auth, { admin: true });
  },
  adminOverrideHelp(auth, defaultId, payload)    { return request('PUT',  `/admin/help/override/${encodeURIComponent(defaultId)}`, payload, auth, { admin: true }); },
  adminCreateHelp(auth, payload)                 { return request('POST', '/admin/help/custom', payload, auth, { admin: true }); },
  adminDeleteHelp(auth, rowId)                   { return request('DELETE', `/admin/help/${encodeURIComponent(rowId)}`, undefined, auth, { admin: true }); },

  // Phase 4f — audit log viewer + FAQ admin (uses existing Phase 2b endpoints)
  adminListAudit(auth, filters = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, String(v));
    return request('GET', `/admin/audit?${qs.toString()}`, undefined, auth, { admin: true });
  },
  adminListCommunityFaqs(auth, communitySlug)    { return request('GET', `/admin/communities/${encodeURIComponent(communitySlug)}/faqs`, undefined, auth, { admin: true }); },
  adminOverrideFaq(auth, defaultFaqId, payload)  { return request('PUT', `/admin/communities/${encodeURIComponent(payload.communitySlug)}/faqs/override/${encodeURIComponent(defaultFaqId)}`, payload, auth, { admin: true }); },
  adminAddCustomFaq(auth, communitySlug, payload){ return request('POST', `/admin/communities/${encodeURIComponent(communitySlug)}/faqs/custom`, payload, auth, { admin: true }); },
  adminDeleteCommunityFaq(auth, communitySlug, overrideId) { return request('DELETE', `/admin/communities/${encodeURIComponent(communitySlug)}/faqs/${encodeURIComponent(overrideId)}`, undefined, auth, { admin: true }); },

  // Phase 5 — platform admin (cross-tenant). Auth uses x-firebase-uid +
  // x-firebase-email; the server checks against GLOBAL_ADMIN_EMAILS.
  // Phase 5 — platform admin (cross-tenant). Server's requirePlatformAdmin
  // reads the signed-in email from x-firebase-email or x-admin-email and
  // checks it against GLOBAL_ADMIN_EMAILS. The non-admin authHeaders path
  // refuses to attach Firebase headers when uid is empty, so all three
  // platform calls go through the admin header path which always sends
  // x-admin-email (and optionally x-firebase-* when present).
  platformVerify(auth)                         { return request('POST', '/platform/auth/verify', {}, auth, { admin: true }); },
  platformListCommunities(auth)                { return request('GET',  '/platform/communities', undefined, auth, { admin: true }); },
  platformCreateCommunity(auth, payload)       { return request('POST', '/platform/communities', payload, auth, { admin: true }); },
};
