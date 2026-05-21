import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

function relTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch (_e) { return ''; }
}

export default function EmployeeThread({ threadId }) {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [state, setState] = useState({ kind: 'loading' });
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  const load = () => {
    taxApi.getEmployeeThread(auth, threadId)
      .then(d => setState({ kind: 'ready', thread: d.thread, messages: d.messages || [] }))
      .catch(e => setState({ kind: e?.status === 404 ? 'not-found' : 'error', error: e?.message || '' }));
  };
  useEffect(() => {
    if (!employee || !community) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, threadId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [state]);

  const inboxBase = community ? `/tax/${community.id}/employee` : '#';

  if (state.kind === 'loading') return <EmployeeShell community={community} active="inbox"><p>{t('loading')}</p></EmployeeShell>;
  if (state.kind === 'not-found') return <EmployeeShell community={community} active="inbox"><div className="tax-msg tax-msg--error">{t('employee.thread.notFound')}</div></EmployeeShell>;
  if (state.kind === 'error') return <EmployeeShell community={community} active="inbox"><div className="tax-msg tax-msg--error">{state.error || t('error.loadFailed')}</div></EmployeeShell>;

  const { thread, messages } = state;
  const customer = thread.customer || {};

  const onSend = async (e) => {
    e.preventDefault();
    if (!reply.trim()) return;
    setSending(true); setErr('');
    try {
      await taxApi.postEmployeeMessage(auth, threadId, { body: reply.trim() });
      setReply('');
      load();
    } catch (e) { setErr(e?.message || t('respond.error.generic')); }
    finally { setSending(false); }
  };

  return (
    <EmployeeShell community={community} active="inbox">
      <a href={inboxBase} style={{ fontSize: 14, color: 'var(--tax-muted)' }}>← {t('employee.thread.backToInbox')}</a>
      <h2 style={{ marginTop: 8, marginBottom: 4 }}>{thread.subject || t('employee.inbox.untitled')}</h2>

      {/* Customer context strip — gives the employee everything they need
          at a glance without leaving the thread (preferred email,
          WhatsApp, phone). */}
      <div className="tax-contact-item" style={{ marginBottom: 16, fontSize: 13 }}>
        <div style={{ fontWeight: 600 }}>{customer.name || t('employee.thread.unnamedCustomer')}</div>
        <div style={{ color: 'var(--tax-muted)', marginTop: 4, display: 'grid', gap: 4 }}>
          {customer.email && (
            <div>{t('employee.thread.contactEmail')}: <a href={`mailto:${customer.email}`}>{customer.email}</a>
              {customer.preferred_communication_email && customer.preferred_communication_email !== customer.email && (
                <span> ({t('employee.thread.preferred')}: <a href={`mailto:${customer.preferred_communication_email}`}>{customer.preferred_communication_email}</a>)</span>
              )}
            </div>
          )}
          {customer.phone && <div>{t('employee.thread.contactPhone')}: {customer.phone}</div>}
          {customer.whatsapp && (
            <div>WhatsApp: <a href={`https://wa.me/${customer.whatsapp.replace(/^\+/, '')}`}
                              target="_blank" rel="noopener noreferrer">{customer.whatsapp}</a></div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, margin: '16px 0' }}>
        {messages.map(m => {
          const fromCustomer = m.author_role === 'customer';
          const align = fromCustomer ? 'flex-start' : 'flex-end';
          const bg = fromCustomer ? '#f7f7f9' : 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)';
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: align }}>
              <div style={{
                maxWidth: '80%', background: bg,
                borderRadius: 12, padding: '10px 14px',
                border: '1px solid var(--tax-border)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)', marginBottom: 4 }}>
                  {fromCustomer
                    ? (customer.name || t('employee.thread.customerLabel'))
                    : (m.author_name || m.author_email || t('employee.thread.staffLabel'))}
                  <span style={{ marginLeft: 8, fontWeight: 400 }}>{relTime(m.created_at)}</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>{m.body}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSend} className="tax-form" style={{ marginTop: 16 }}>
        <div>
          <label htmlFor="ep-reply">{t('employee.thread.replyAs', { name: employee?.name || employee?.email || 'staff' })}</label>
          <textarea id="ep-reply" rows={4} value={reply}
                    onChange={e => setReply(e.target.value)}
                    placeholder={t('employee.thread.replyPlaceholder')} maxLength={4000} />
        </div>
        {err && <div className="tax-msg tax-msg--error">{err}</div>}
        <button type="submit" className="tax-btn tax-btn--primary" disabled={sending || !reply.trim()}>
          {sending ? t('lead.submitting') : t('employee.thread.send')}
        </button>
      </form>
    </EmployeeShell>
  );
}
