import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';
import LocaleSwitcher from '../components/LocaleSwitcher';

// Reviewer-facing magic-link page. No sign-in required — the URL token
// IS the bearer credential, minted daily by review-digest.js for exactly
// one task and one Reviewer. Lets a Reviewer approve a task, or send it
// back to In progress with a note for whoever is working it, straight
// from the email reminder (see POST /review/:token, applyTaskReviewDecision
// in routes.js — same transition the in-app review panel uses).
export default function TaskReview({ token }) {
  const { t } = useT();
  const [state, setState] = useState({ kind: 'loading', data: null });
  const [note, setNote] = useState('');
  const [submitState, setSubmitState] = useState({ kind: 'idle', message: '', decision: null });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading', data: null });
    taxApi.getTaskReview(token)
      .then(data => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch(err => {
        if (cancelled) return;
        if (err?.status === 410) setState({ kind: 'used', data: null });
        else if (err?.status === 404) setState({ kind: 'invalid', data: null });
        else if (err?.status === 403) setState({ kind: 'forbidden', data: null });
        else setState({ kind: 'error', data: null });
      });
    return () => { cancelled = true; };
  }, [token]);

  const community = state.data?.community;
  const brandStyle = community ? {
    '--tax-brand-primary': community.brand_primary_color || undefined,
    '--tax-brand-secondary': community.brand_secondary_color || undefined,
  } : {};

  if (state.kind === 'loading') {
    return <Shell><p>{t('loading')}</p></Shell>;
  }
  if (state.kind === 'invalid') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskReview.error.invalidLink')}</div></Shell>;
  }
  if (state.kind === 'used') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskReview.error.usedLink')}</div></Shell>;
  }
  if (state.kind === 'forbidden') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskReview.error.notReviewer')}</div></Shell>;
  }
  if (state.kind === 'error') {
    return <Shell><div className="tax-msg tax-msg--error">{t('error.loadFailed')}</div></Shell>;
  }

  const { task, customer, assignee, alreadyHandled } = state.data;
  const customerLabel = customer ? (customer.business_name || customer.name || '') : '';

  if (alreadyHandled || submitState.kind === 'success') {
    const portalUrl = community ? `/tax/${community.id}/employee/tasks` : '#';
    return (
      <Shell community={community} brandStyle={brandStyle}>
        <section className="tax-section" style={{ paddingTop: 32 }}>
          <div className="tax-msg tax-msg--success">
            <strong>
              {t(submitState.kind === 'success'
                ? (submitState.decision === 'approve' ? 'taskReview.success.approved' : 'taskReview.success.sentBack')
                : 'taskReview.alreadyHandled.heading')}
            </strong>
            <div style={{ marginTop: 6 }}>
              {t(submitState.kind === 'success' ? 'taskReview.success.body' : 'taskReview.alreadyHandled.body')}
            </div>
          </div>
          {community && (
            <div style={{ marginTop: 20 }}>
              <a href={portalUrl} className="tax-btn tax-btn--primary">{t('taskReview.openTasksBoard')}</a>
            </div>
          )}
        </section>
      </Shell>
    );
  }

  const onDecide = async (decision) => {
    if (submitState.kind === 'submitting') return;
    const trimmedNote = note.trim();
    if (decision === 'reject' && !trimmedNote) {
      setSubmitState({ kind: 'error', message: t('taskReview.error.noteRequired'), decision: null });
      return;
    }
    setSubmitState({ kind: 'submitting', message: '', decision });
    try {
      await taxApi.submitTaskReview(token, { decision, note: trimmedNote });
      setSubmitState({ kind: 'success', message: '', decision });
    } catch (err) {
      setSubmitState({ kind: 'error', message: err?.message || t('respond.error.generic'), decision: null });
    }
  };

  const busy = submitState.kind === 'submitting';

  return (
    <Shell community={community} brandStyle={brandStyle}>
      <section className="tax-section" style={{ paddingTop: 32 }}>
        <h2>{t('taskReview.title')}</h2>

        <div style={{
          border: '1px solid var(--tax-border)', borderRadius: 10, padding: 16, margin: '16px 0',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>{task.title}</div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0, fontSize: 14 }}>
            {customerLabel && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskReview.field.customer')}</dt>
                <dd style={{ margin: 0 }}>{customerLabel}</dd>
              </>
            )}
            {assignee && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskReview.field.assignee')}</dt>
                <dd style={{ margin: 0 }}>{assignee.name || assignee.email}</dd>
              </>
            )}
            {task.due_date && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskReview.field.due')}</dt>
                <dd style={{ margin: 0 }}>{task.due_date}</dd>
              </>
            )}
            {task.priority && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskReview.field.priority')}</dt>
                <dd style={{ margin: 0, textTransform: 'capitalize' }}>{task.priority}</dd>
              </>
            )}
          </dl>
          {task.notes && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--tax-border)', fontSize: 13, color: 'var(--tax-muted)', whiteSpace: 'pre-wrap' }}>
              {task.notes}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="tr-note">{t('taskReview.noteLabel')}</label>
          <textarea
            id="tr-note" rows={3}
            placeholder={t('taskReview.notePlaceholder')}
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        {submitState.kind === 'error' && (
          <div className="tax-msg tax-msg--error" role="alert" style={{ marginTop: 10 }}>{submitState.message}</div>
        )}

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <button
            type="button"
            className="tax-btn tax-btn--primary"
            disabled={busy}
            onClick={() => onDecide('approve')}
          >
            {busy && submitState.decision === 'approve' ? t('taskReview.submitting') : t('taskReview.approveBtn')}
          </button>
          <button
            type="button"
            className="tax-btn tax-btn--ghost"
            disabled={busy}
            onClick={() => onDecide('reject')}
          >
            {busy && submitState.decision === 'reject' ? t('taskReview.submitting') : t('taskReview.sendBackBtn')}
          </button>
        </div>
        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--tax-muted)' }}>{t('taskReview.sendBackHint')}</p>
      </section>
    </Shell>
  );
}

// Minimal shell shared by all render states — same pattern as Respond.jsx.
function Shell({ children, community, brandStyle }) {
  const initials = (community?.name || 'TAX')
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  return (
    <div className="tax-app" style={brandStyle || {}}>
      <header className="tax-header">
        <div className="tax-container tax-header__row">
          <div className="tax-brand">
            {community?.logo_url
              ? <img src={community.logo_url} alt={community?.name || 'Tax Services'} className="tax-brand__logo" />
              : <>
                  <span className="tax-brand__mark">{initials}</span>
                  <span className="tax-brand__name">{community?.name || 'Tax Services'}</span>
                </>}
          </div>
          <div className="tax-nav" aria-label="Language">
            <LocaleSwitcher />
          </div>
        </div>
      </header>
      <div className="tax-container" style={{ paddingTop: 8 }}>
        {children}
      </div>
    </div>
  );
}
