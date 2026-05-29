import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickI18n } from '../i18n';
import { displayPersonName } from '../lib/personName';
import { effectiveUrgency, colorOf, priorityColorOf, resolveThresholds } from '../lib/taskUrgency';
import { formatFrequency } from '../lib/taskFrequency';

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
// packed Kanban column don't flash tooltips. `pointer-events: none`
// stays so the popover never blocks the underlying click / drag
// handler on the trigger element.
const ENTER_DELAY_MS = 150;
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

export default function TaskHover({ task, statuses, community, locale, t, children, side = 'auto' }) {
  const triggerRef = useRef(null);
  const timerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);

  const reposition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setCoords(computeCoords(rect, side));
  };

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      reposition();
      setOpen(true);
    }, ENTER_DELAY_MS);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const customer = task.customer;
  const product  = task.product;
  const assignee = task.assignee;
  const status   = (statuses || []).find(s => s.key === task.status_key);
  const thresholds = resolveThresholds(community);
  const urgency = effectiveUrgency(task, thresholds);
  const dueCol  = colorOf(urgency, community);
  const prCol   = priorityColorOf(task.priority, community);

  const popover = open && coords && typeof document !== 'undefined' ? createPortal(
    <div role="tooltip"
         style={{
           position: 'fixed', top: coords.top, left: coords.left,
           minWidth: 240, maxWidth: POP_WIDTH, zIndex: 9999,
           background: '#fff', border: '1px solid var(--tax-border)',
           borderRadius: 8, boxShadow: '0 12px 24px rgba(0,0,0,.18)',
           padding: '10px 12px', textAlign: 'left',
           pointerEvents: 'none',
         }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, whiteSpace: 'normal', color: 'var(--tax-text)' }}>
        {task.title_i18n?.[locale] || task.title || task.title_i18n?.[locale === 'en' ? 'es' : 'en']}
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
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <span ref={triggerRef}
          style={{ display: 'block' }}
          onMouseEnter={show} onMouseLeave={hide}
          onFocus={show} onBlur={hide}>
      {children}
      {popover}
    </span>
  );
}
