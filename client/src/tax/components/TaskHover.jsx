import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickI18n } from '../i18n';
import { displayPersonName } from '../lib/personName';
import { effectiveUrgency, colorOf, priorityColorOf, resolveThresholds } from '../lib/taskUrgency';
import { formatFrequency } from '../lib/taskFrequency';
import { formatDateTime } from '../lib/lastSignIn';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import { mailtoHref, whatsappHref, taskContactMessage } from '../lib/contactLinks';

// Hover card shared by every task surface in the employee portal —
// Calendar pips, Kanban cards, Tasks list rows, Periods view, the
// dashboard urgent list, and the customer-profile task list.
//
// Rendered through a portal at document.body so the popover is never
// clipped by an ancestor's overflow:hidden / scroll container (the
// Kanban columns being the most visible offender). Position is
// computed from the trigger's bounding rect every time the popover
// opens; we then re-measure on scroll + resize so it tracks correctly
// while the user navigates. Smart flip puts the popover above the
// trigger when there isn't enough room below and clamps the left
// edge to keep it on-screen at the right.
//
// 150ms enter delay still applies so quick mouse-drifts across a
// packed Kanban column don't flash tooltips. Leaving the trigger
// schedules a 200ms-delayed hide (instead of closing instantly) so the
// mouse has time to travel onto the popover itself — needed now that
// the popover is interactive (the delete button below) and listens for
// its own hover to stay open.
const ENTER_DELAY_MS = 150;
const LEAVE_DELAY_MS = 200;
const POP_GAP_PX = 6;
const ESTIMATED_POP_HEIGHT = 260;
const POP_WIDTH = 300;

function computeCoords(rect, side) {
  if (!rect || typeof window === 'undefined') return null;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const margin = 8;

  // 'right' is a hint — used by callers (e.g., very narrow Calendar
  // pips) but we still flip back to below/above if 'right' doesn't fit.
  if (side === 'right' && rect.right + POP_GAP_PX + POP_WIDTH + margin <= vw) {
    const left = rect.right + POP_GAP_PX;
    let top = rect.top;
    if (top + ESTIMATED_POP_HEIGHT + margin > vh) {
      top = Math.max(margin, vh - ESTIMATED_POP_HEIGHT - margin);
    }
    return { top, left };
  }

  let top = rect.bottom + POP_GAP_PX;
  if (top + ESTIMATED_POP_HEIGHT + margin > vh) {
    // Not enough room below — flip above the trigger if that fits.
    const above = rect.top - POP_GAP_PX - ESTIMATED_POP_HEIGHT;
    top = above >= margin ? above : Math.max(margin, vh - ESTIMATED_POP_HEIGHT - margin);
  }

  let left = rect.left;
  if (left + POP_WIDTH + margin > vw) left = Math.max(margin, vw - POP_WIDTH - margin);
  if (left < margin) left = margin;

  return { top, left };
}

export default function TaskHover({ task, statuses, community, locale, t, children, side = 'auto', onDeleted }) {
  const triggerRef = useRef(null);
  const timerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');

  // Latest collaborative note, fetched lazily the first time this
  // hover opens (not on every list render) — pulled from auth context
  // directly so every call site (Calendar, Kanban, Tasks list, Periods,
  // dashboard, customer-profile task list) gets it for free, with no
  // prop drilling and no change to those pages' own task queries.
  // undefined = not fetched yet, null = fetched, no notes.
  const { fbUser, employee, community: authCommunity } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: authCommunity?.id };
  const [latestNote, setLatestNote] = useState(undefined);
  const fetchedForTaskId = useRef(null);
  useEffect(() => {
    if (!open || !task?.id) return;
    if (fetchedForTaskId.current === task.id) return;
    fetchedForTaskId.current = task.id;
    taxApi.adminListTaskNotes(auth, task.id)
      .then(d => setLatestNote((d.notes || [])[0] || null))
      .catch(() => setLatestNote(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  // Not started has no real work recorded against it yet, so anyone can
  // delete it; past that (in progress, pending review, completed),
  // deleting destroys whatever's attached, so it's reserved for the
  // seeded owner account specifically. Mirrors the server-side check in
  // DELETE /admin/tasks/:id.
  const canDelete = !!employee && (task.status_key === 'not_started' || !!employee.is_seed_owner);

  const reposition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setCoords(computeCoords(rect, side));
  };

  const clearHideTimer = () => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  const show = () => {
    clearHideTimer();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      reposition();
      setOpen(true);
    }, ENTER_DELAY_MS);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    clearHideTimer();
    setOpen(false);
  };
  // Leaving the trigger schedules a hide instead of closing instantly —
  // the popover renders through a portal, outside the trigger's own DOM
  // subtree, so without a short grace period the mouse could never reach
  // the delete button: it'd close the instant the cursor left the small
  // trigger element on its way down to the popover below it.
  const scheduleHide = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => setOpen(false), LEAVE_DELAY_MS);
  };

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    clearHideTimer();
  }, []);

  const onDeleteClick = async () => {
    if (delBusy) return;
    if (!window.confirm(t('owner.tasks.deleteConfirm'))) return;
    setDelBusy(true); setDelErr('');
    try {
      await taxApi.adminDeleteTask(auth, task.id);
      hide();
      onDeleted?.(task.id);
    } catch (e) {
      setDelErr(e?.message || '');
      setDelBusy(false);
    }
  };

  // Track scroll + resize while the popover is open so it stays
  // anchored to the trigger as the user navigates. Capture-phase
  // scroll listener picks up scrolls in any ancestor container.
  useEffect(() => {
    if (!open) return;
    const onMove = () => reposition();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure once the popover content is in the DOM so we pick up
  // the actual height (instead of the ESTIMATED_POP_HEIGHT used in
  // the initial flip decision).
  useLayoutEffect(() => {
    if (open) reposition();
    // Re-run once the note arrives — it can grow the popover enough to
    // need a different above/below flip than the initial estimate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, latestNote]);

  const customer = task.customer;
  const product  = task.product;
  const contactMsg = customer
    ? taskContactMessage({
        locale, taskTitle: task.title,
        firstName: customer.first_name || displayPersonName(customer) || '',
        communityName: community?.name || '',
      })
    : null;
  const mailHref = customer && contactMsg ? mailtoHref(customer.email, contactMsg) : null;
  const waHref = customer && contactMsg
    ? whatsappHref(customer.whatsapp || customer.phone, contactMsg.whatsapp)
    : null;
  const assignee = task.assignee;
  const status   = (statuses || []).find(s => s.key === task.status_key);
  const thresholds = resolveThresholds(community);
  const urgency = effectiveUrgency(task, thresholds);
  const dueCol  = colorOf(urgency, community);
  const prCol   = priorityColorOf(task.priority, community);

  const popover = open && coords && typeof document !== 'undefined' ? createPortal(
    <div role="tooltip"
         onMouseEnter={clearHideTimer}
         onMouseLeave={scheduleHide}
         style={{
           position: 'fixed', top: coords.top, left: coords.left,
           minWidth: 240, maxWidth: POP_WIDTH, zIndex: 9999,
           background: '#fff', border: '1px solid var(--tax-border)',
           borderRadius: 8, boxShadow: '0 12px 24px rgba(0,0,0,.18)',
           padding: '10px 12px', textAlign: 'left',
           // Interactive now (delete button below) — the gap kept between
           // the trigger and the popover (POP_GAP_PX + the flip logic in
           // computeCoords) keeps this from ever sitting on top of the
           // trigger itself, so enabling pointer events here doesn't
           // intercept the trigger's own click/drag handler.
           pointerEvents: 'auto',
         }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, whiteSpace: 'normal', color: 'var(--tax-text)' }}>
        {task.title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr',
                    columnGap: 8, rowGap: 4, fontSize: 12, color: 'var(--tax-text)' }}>
        <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.customer')}</span>
        <span>{customer
          ? (customer.business_name || displayPersonName(customer) || customer.email)
          : t('owner.tasks.calendar.practiceWide')}</span>
        {product && (
          <>
            <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.service')}</span>
            <span>{pickI18n(product.name_i18n, locale).value || product.slug}</span>
          </>
        )}
        {task.auto_task && (
          <>
            <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.taskTemplate')}</span>
            <span>{pickI18n(task.auto_task.title_i18n, locale).value || '—'}</span>
            {task.auto_task.cadence_kind && task.auto_task.cadence_kind !== 'none' && (
              <>
                <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.frequency')}</span>
                <span>
                  <span style={{
                    display: 'inline-block', padding: '1px 8px', borderRadius: 999,
                    background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                    fontSize: 11, fontWeight: 700,
                  }}>{formatFrequency(task.auto_task.cadence_kind, task.auto_task.anchor_rule, t, locale)}</span>
                </span>
              </>
            )}
          </>
        )}
        <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.priority')}</span>
        <span>
          <span style={{
            display: 'inline-block', padding: '1px 8px', borderRadius: 999,
            background: prCol.bg, color: prCol.fg,
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          }}>{t(`owner.tasks.priority.${task.priority || 'normal'}`)}</span>
        </span>
        {task.due_date && (
          <>
            <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.due')}</span>
            <span>
              <span style={{
                display: 'inline-block', padding: '1px 8px', borderRadius: 4,
                background: dueCol.bg, color: dueCol.fg,
                fontSize: 11, fontWeight: 600,
              }}>{task.due_date}</span>
            </span>
          </>
        )}
        <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.owner')}</span>
        <span>{assignee
          ? (displayPersonName(assignee) || assignee.email)
          : t('owner.tasks.field.ownerNone')}</span>
        {status && (
          <>
            <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.field.status')}</span>
            <span>{pickI18n(status.label_i18n, locale).value || status.key}</span>
          </>
        )}
        <span style={{ color: 'var(--tax-muted)' }}>{t('owner.tasks.lastViewed.label')}</span>
        <span>
          {task.last_viewed_at
            ? t('owner.tasks.lastViewed.hoverValue', {
                name: task.last_viewed_by?.name || task.last_viewed_by?.email || t('owner.tasks.lastViewed.someone'),
                date: formatDateTime(task.last_viewed_at, locale),
              })
            : t('owner.tasks.lastViewed.neverHover')}
        </span>
      </div>
      {(mailHref || waHref) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--tax-border)' }}>
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
      {latestNote !== undefined && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--tax-border)' }}>
          <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginBottom: 2 }}>
            {t('owner.tasks.lastNote.label')}
          </div>
          {latestNote ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--tax-text)', whiteSpace: 'pre-wrap' }}>
                {latestNote.body.length > 180 ? latestNote.body.slice(0, 180) + '…' : latestNote.body}
              </div>
              <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginTop: 2 }}>
                {t('owner.tasks.lastNote.byline', {
                  name: latestNote.author_name || latestNote.author_email || t('owner.tasks.lastViewed.someone'),
                  date: formatDateTime(latestNote.created_at, locale),
                })}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>{t('owner.tasks.lastNote.none')}</div>
          )}
        </div>
      )}
      {canDelete && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--tax-border)', textAlign: 'right' }}>
          {delErr && (
            <div style={{ fontSize: 11, color: 'var(--tax-error)', marginBottom: 4, textAlign: 'left' }}>{delErr}</div>
          )}
          <button type="button" onClick={onDeleteClick} disabled={delBusy}
                  style={{
                    border: 0, background: 'transparent', cursor: delBusy ? 'default' : 'pointer',
                    color: 'var(--tax-error)', fontSize: 12, fontWeight: 600, padding: '2px 0',
                  }}>
            {delBusy ? t('owner.tasks.deleting') : t('owner.tasks.delete')}
          </button>
        </div>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <span ref={triggerRef}
          style={{ display: 'block' }}
          onMouseEnter={show} onMouseLeave={scheduleHide}
          onFocus={show} onBlur={scheduleHide}>
      {children}
      {popover}
    </span>
  );
}
