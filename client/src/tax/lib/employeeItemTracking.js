// Records that the signed-in employee opened one specific record — a
// customer, task, lead, message thread or staff profile — for the
// owner-facing Activity dashboard (GET /admin/activity/summary). Sits
// beside EmployeeShell.jsx's feature-level ping, which only knows which
// page is open, not which record on it.

import { useEffect } from 'react';
import { taxApi } from '../api';

// `kind` is 'customer' | 'task' | 'lead' | 'thread' | 'employee'. Pass an
// empty itemId while nothing is open (a collapsed lead row, a "new task"
// form). Best-effort: a failed ping never surfaces to the employee.
export function useEmployeeItemView(auth, kind, itemId) {
  const { uid, email, communitySlug } = auth || {};
  useEffect(() => {
    if (!uid || !communitySlug || !itemId) return;
    taxApi.employeeActivityItemView({ uid, email, communitySlug }, { kind, itemId }).catch(() => {});
  }, [uid, email, communitySlug, kind, itemId]);
}
