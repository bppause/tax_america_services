import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';
import LocaleSwitcher from '../components/LocaleSwitcher';

// Owner-facing magic-link page. No sign-in required — the URL token IS
// the bearer credential, minted daily by start-digest.js for exactly
// one task and its one assigned owner. Lets the owner move a Not-started
// task to In progress straight from the email reminder (see
// POST /start/:token, applyTaskStart in routes.js — same transition the
// in-app Start button uses everywhere else).
export default function StartTask({ token }) {
  const { t } = useT();
  const [state, setState] = useState({ kind: 'loading', data: null });
  const [note, setNote] = useState('');
  const [submitState, setSubmitState] = useState({ kind: 'idle', message: '' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading', data: null });
    taxApi.getTaskStart(token)
      .then(data => { if (!cancelled) setState({ kind: 'ready', data }); })
      .catch(err => {
        if (cancelled) return;
        if (err?.status === 410) setState({ kind: 'used', data: null });
        else if (err?.status === 404) setState({ kind: 'invalid', data: null });
        else if (err?.status === 403) setState({ kind: 'forbidden', data: null });
        else if (err?.status === 409) setState({ kind: 'reassigned', data: null });
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
    return <Shell><div className="tax-msg tax-msg--error">{t('taskStart.error.invalidLink')}</div></Shell>;
  }
  if (state.kind === 'used') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskStart.error.usedLink')}</div></Shell>;
  }
  if (state.kind === 'forbidden') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskStart.error.notActive')}</div></Shell>;
  }
  if (state.kind === 'reassigned') {
    return <Shell><div className="tax-msg tax-msg--error">{t('taskStart.error.reassigned')}</div></Shell>;
  }
  if (state.kind === 'error') {
    return <Shell><div className="tax-msg tax-msg--error">{t('error.loadFailed')}</div></Shell>;
  }

  const { task, customer, readyToStart, alreadyStarted } = state.data;
  const customerLabel = customer ? (customer.business_name || customer.name || '') : '';
  const tasksHref = community ? `/tax/${community.id}/employee/tasks?edit=${encodeURIComponent(task.id)}` : '#';

  if (alreadyStarted || submitState.kind === 'success') {
    return (
      <Shell community={community} brandStyle={brandStyle}>
        <section className="tax-section" style={{ paddingTop: 32 }}>
          <div className="tax-msg tax-msg--success">
            <strong>
              {t(submitState.kind === 'success' ? 'taskStart.success.heading' : 'taskStart.alreadyStarted.heading')}
            </strong>
            <div style={{ marginTop: 6 }}>
              {t(submitState.kind === 'success' ? 'taskStart.success.body' : 'taskStart.alreadyStarted.body')}
            </div>
          </div>
          {community && (
            <div style={{ marginTop: 20 }}>
              <a href={tasksHref} className="tax-btn tax-btn--primary">{t('taskStart.openTask')}</a>
            </div>
          )}
        </section>
      </Shell>
    );
  }

  // Missing priority or due date — not actually startable yet. Same gate
  // POST /start/:token enforces; sending the owner into the full editor
  // is more useful than a button that would just fail.
  if (!readyToStart) {
    return (
      <Shell community={community} brandStyle={brandStyle}>
        <section className="tax-section" style={{ paddingTop: 32 }}>
          <h2>{task.title}</h2>
          <div className="tax-msg tax-msg--error" style={{ marginTop: 12 }}>
            {t('taskStart.notReady', {
              fields: [!task.priority && t('taskStart.field.priority'), !task.due_date && t('taskStart.field.due')]
                .filter(Boolean).join(', '),
            })}
          </div>
          {community && (
            <div style={{ marginTop: 20 }}>
              <a href={tasksHref} className="tax-btn tax-btn--primary">{t('taskStart.openTask')}</a>
            </div>
          )}
        </section>
      </Shell>
    );
  }

  const onStart = async () => {
    if (submitState.kind === 'submitting') return;
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setSubmitState({ kind: 'error', message: t('taskStart.error.noteRequired') });
      return;
    }
    setSubmitState({ kind: 'submitting', message: '' });
    try {
      await taxApi.submitTaskStart(token, { note: trimmedNote });
      setSubmitState({ kind: 'success', message: '' });
    } catch (err) {
      setSubmitState({ kind: 'error', message: err?.message || t('respond.error.generic') });
    }
  };

  const busy = submitState.kind === 'submitting';

  return (
    <Shell community={community} brandStyle={brandStyle}>
      <section className="tax-section" style={{ paddingTop: 32 }}>
        <h2>{t('taskStart.title')}</h2>

        <div style={{
          border: '1px solid var(--tax-border)', borderRadius: 10, padding: 16, margin: '16px 0',
        }}>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>{task.title}</div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0, fontSize: 14 }}>
            {customerLabel && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskStart.field.customer')}</dt>
                <dd style={{ margin: 0 }}>{customerLabel}</dd>
              </>
            )}
            {task.due_date && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskStart.field.due')}</dt>
                <dd style={{ margin: 0 }}>{task.due_date}</dd>
              </>
            )}
            {task.priority && (
              <>
                <dt style={{ color: 'var(--tax-muted)' }}>{t('taskStart.field.priority')}</dt>
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
          <label htmlFor="ts-note">{t('taskStart.noteLabel')}</label>
          <textarea
            id="ts-note" rows={3}
            placeholder={t('taskStart.notePlaceholder')}
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        {submitState.kind === 'error' && (
          <div className="tax-msg tax-msg--error" role="alert" style={{ marginTop: 10 }}>{submitState.message}</div>
        )}

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="tax-btn tax-btn--primary"
            disabled={busy}
            onClick={onStart}
          >
            {busy ? t('taskStart.submitting') : t('taskStart.startBtn')}
          </button>
        </div>
      </section>
    </Shell>
  );
}

// Minimal shell shared by all render states — same pattern as Respond.jsx / TaskReview.jsx.
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
