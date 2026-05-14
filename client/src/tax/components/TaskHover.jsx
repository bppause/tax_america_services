import { useEffect, useRef, useState } from 'react';
import { pickI18n } from '../i18n';
import { displayPersonName } from '../lib/personName';
import { effectiveUrgency, colorOf, priorityColorOf, resolveThresholds } from '../lib/taskUrgency';
import { formatFrequency } from '../lib/taskFrequency';

// Hover card shared by Calendar pips, Kanban cards, and the
// owner-dashboard urgent task list. Wraps a trigger element with a
// hover-revealed popover that shows the fields not visible on the
// small surface — customer/company, service, priority chip, due date,
// owner, status. ~150ms enter delay so quick mouse-drifts across a
// packed calendar don't flash tooltips. The popover sets
// `pointer-events: none` so it never blocks the underlying
// click/drag handler on the trigger.
export default function TaskHover({ task, statuses, community, locale, t, children, side = 'below' }) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);
  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), 150);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  };
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const customer = task.customer;
  const product  = task.product;
  const assignee = task.assignee;
  const status   = (statuses || []).find(s => s.key === task.status_key);
  const thresholds = resolveThresholds(community);
  const urgency = effectiveUrgency(task, thresholds);
  const dueCol  = colorOf(urgency, community);
  const prCol   = priorityColorOf(task.priority, community);

  const posStyle = side === 'right'
    ? { top: 0, left: 'calc(100% + 6px)' }
    : { top: 'calc(100% + 6px)', left: 0 };

  return (
    <span style={{ position: 'relative', display: 'block' }}
          onMouseEnter={show} onMouseLeave={hide}
          onFocus={show} onBlur={hide}>
      {children}
      {open && (
        <div role="tooltip"
             style={{
               position: 'absolute', ...posStyle,
               minWidth: 240, maxWidth: 320, zIndex: 60,
               background: '#fff', border: '1px solid var(--tax-border)',
               borderRadius: 8, boxShadow: '0 12px 24px rgba(0,0,0,.12)',
               padding: '10px 12px', textAlign: 'left',
               pointerEvents: 'none',
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
          </div>
        </div>
      )}
    </span>
  );
}
