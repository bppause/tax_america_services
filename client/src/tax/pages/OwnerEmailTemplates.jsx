import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import EmailPreviewModal from '../components/EmailPreviewModal';

// Phase 4i: owner-editable email subject + body per template_key × lang.
// When all three fields (subject / body_text / body_html) are empty for a
// (key, lang), the sender uses its bilingual hardcoded default. Owners can
// override any subset — e.g. only the subject — and the rest stay default.
//
// Placeholders use {{var}} syntax; the variable list varies by template
// and is shown in a reference panel next to the editor.
const PLACEHOLDER_REF = {
  welcome_customer:    ['customer_name', 'practice_name', 'customer_email', 'portal_url', 'relationships_list'],
  welcome_staff:       ['staff_name', 'practice_name', 'staff_email', 'role', 'role_label', 'employee_url'],
  reminder:            ['customer_name', 'practice_name', 'filing_name', 'filing_description', 'period_label', 'due_date', 'offset_days', 'magic_url'],
  document:            ['customer_name', 'practice_name', 'file_name', 'portal_url'],
  message_to_customer: ['customer_name', 'practice_name', 'thread_subject', 'author_name', 'message_preview', 'portal_url'],
  message_to_practice: ['customer_name', 'customer_email', 'practice_name', 'thread_subject', 'thread_id', 'message_preview'],
  message_to_employee: ['customer_name', 'customer_email', 'employee_name', 'practice_name', 'thread_subject', 'message_preview'],
  lead:                ['practice_name', 'lead_name', 'lead_email', 'lead_phone', 'lead_service', 'lead_locale', 'lead_message', 'lead_id', 'lead_submitted'],
  signature_request:   ['customer_name', 'practice_name', 'title', 'description', 'sign_url'],
  signature_signed:    ['employee_name', 'practice_name', 'customer_name', 'customer_email', 'title', 'customer_url'],
};

export default function OwnerEmailTemplates() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [templates, setTemplates] = useState([]);
  const [keys, setKeys] = useState([]);
  const [langs, setLangs] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  // Active selection
  const [activeKey, setActiveKey] = useState('welcome_customer');
  const [activeLang, setActiveLang] = useState('en');

  // Editor state — null = loaded default (use system); otherwise editing.
  const [form, setForm] = useState({ subject: '', body_text: '', body_html: '', enabled: true });
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const load = () => {
    if (!employee || !community) return;
    setLoading(true); setErr('');
    taxApi.adminListEmailTemplates(auth, community.id)
      .then(d => {
        setTemplates(d.templates || []);
        setKeys(d.keys || []);
        setLangs(d.langs || []);
      })
      .catch(e => setErr(e?.message || t('error.loadFailed')))
      .finally(() => setLoading(false));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the active (key, lang) changes, hydrate the form from existing row.
  const current = useMemo(() =>
    templates.find(r => r.template_key === activeKey && r.lang === activeLang) || null,
  [templates, activeKey, activeLang]);

  // Phase 4n.2: when there's no override row for this (key, lang), prefill
  // the form with the factored {{placeholder}} default so the owner edits a
  // realistic starting template instead of an empty textarea. When an
  // override exists, prefer it. `prefilledFromDefault` drives the banner.
  const [prefilledFromDefault, setPrefilledFromDefault] = useState(false);

  useEffect(() => {
    setMsg({ kind: 'idle', text: '' });
    if (current) {
      setForm({
        subject: current.subject || '',
        body_text: current.body_text || '',
        body_html: current.body_html || '',
        enabled: current.enabled,
      });
      setPrefilledFromDefault(false);
      return;
    }
    // No override yet — try to fetch the factored default.
    let cancelled = false;
    setForm({ subject: '', body_text: '', body_html: '', enabled: true });
    setPrefilledFromDefault(false);
    taxApi.adminGetEmailTemplateDefaults(auth, activeKey, activeLang)
      .then(d => {
        if (cancelled) return;
        const anyFilled = (d.subject || d.body_text || d.body_html);
        setForm({
          subject: d.subject || '',
          body_text: d.body_text || '',
          body_html: d.body_html || '',
          enabled: true,
        });
        setPrefilledFromDefault(!!anyFilled);
      })
      .catch(() => { /* leave the form empty if defaults aren't available */ });
    return () => { cancelled = true; };
  }, [activeKey, activeLang, current]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = async () => {
    if (!community) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminUpdateEmailTemplate(auth, activeKey, activeLang, {
        communitySlug: community.id,
        subject: form.subject,
        body_text: form.body_text,
        body_html: form.body_html,
        enabled: form.enabled,
      });
      setMsg({ kind: 'success', text: t('owner.emailTemplates.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  const onReset = async () => {
    if (!community || !current) return;
    if (!window.confirm(t('owner.emailTemplates.resetConfirm'))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminResetEmailTemplate(auth, activeKey, activeLang, community.id);
      setMsg({ kind: 'success', text: t('owner.emailTemplates.resetDone') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  // Non-admin staff: same gate as other owner pages.
  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community} active="email-templates">
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const placeholders = PLACEHOLDER_REF[activeKey] || [];
  const isOverridden = !!current;

  return (
    <EmployeeShell community={community} active="email-templates">
      <h2 style={{ marginTop: 0 }}>{t('owner.emailTemplates.title')}</h2>
      <p className="tax-section__lede">{t('owner.emailTemplates.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {loading && <p>{t('loading')}</p>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <label htmlFor="tmpl-key" style={{ display: 'block', fontSize: 13, color: 'var(--tax-muted)', marginBottom: 4 }}>
            {t('owner.emailTemplates.template')}
          </label>
          <select id="tmpl-key" value={activeKey} onChange={e => setActiveKey(e.target.value)}>
            {keys.map(k => (
              <option key={k} value={k}>{t(`owner.emailTemplates.key.${k}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tmpl-lang" style={{ display: 'block', fontSize: 13, color: 'var(--tax-muted)', marginBottom: 4 }}>
            {t('owner.emailTemplates.language')}
          </label>
          <select id="tmpl-lang" value={activeLang} onChange={e => setActiveLang(e.target.value)}>
            {langs.map(l => (
              <option key={l} value={l}>{l === 'es' ? 'Español' : 'English'}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{
              padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
              background: isOverridden ? 'var(--tax-brand-primary)' : 'var(--tax-bg-alt)',
              color: isOverridden ? '#fff' : 'var(--tax-muted)',
            }}>
              {isOverridden ? t('owner.emailTemplates.statusOverride') : t('owner.emailTemplates.statusDefault')}
            </span>
            {isOverridden && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={form.enabled}
                       onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />
                <span>{t('owner.emailTemplates.enabled')}</span>
              </label>
            )}
          </div>

          {prefilledFromDefault && !isOverridden && (
            <div style={{
              margin: '0 0 12px', padding: '10px 12px', borderRadius: 8,
              background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e3a8a',
              fontSize: 13,
            }}>
              {t('owner.emailTemplates.prefillBanner')}
            </div>
          )}

          <div className="tax-form" style={{ display: 'grid', gap: 12 }}>
            <div>
              <label htmlFor="tmpl-subject">{t('owner.emailTemplates.subject')}</label>
              <input id="tmpl-subject" type="text" value={form.subject}
                     placeholder={t('owner.emailTemplates.subjectPlaceholder')}
                     onChange={e => setForm(p => ({ ...p, subject: e.target.value }))}
                     maxLength={4000} />
            </div>
            <div>
              <label htmlFor="tmpl-body-text">{t('owner.emailTemplates.bodyText')}</label>
              <textarea id="tmpl-body-text" rows={10} value={form.body_text}
                        placeholder={t('owner.emailTemplates.bodyTextPlaceholder')}
                        onChange={e => setForm(p => ({ ...p, body_text: e.target.value }))}
                        style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }} />
            </div>
            <div>
              <label htmlFor="tmpl-body-html">{t('owner.emailTemplates.bodyHtml')}</label>
              <textarea id="tmpl-body-html" rows={8} value={form.body_html}
                        placeholder={t('owner.emailTemplates.bodyHtmlPlaceholder')}
                        onChange={e => setForm(p => ({ ...p, body_html: e.target.value }))}
                        style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }} />
              <p style={{ fontSize: 12, color: 'var(--tax-muted)', margin: '4px 0 0' }}>
                {t('owner.emailTemplates.bodyHtmlHint')}
              </p>
            </div>
          </div>

          {msg.text && (
            <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`} style={{ marginTop: 12 }}>
              {msg.text}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="button" className="tax-btn tax-btn--primary"
                    disabled={busy} onClick={onSave}>
              {busy ? t('lead.submitting') : t('owner.emailTemplates.saveBtn')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost"
                    onClick={() => setPreviewOpen(true)}>
              {t('preview.title')}
            </button>
            {isOverridden && (
              <button type="button" className="tax-btn tax-btn--ghost"
                      disabled={busy} onClick={onReset}>
                {t('owner.emailTemplates.resetBtn')}
              </button>
            )}
          </div>
        </div>

        <aside style={{
          background: 'var(--tax-bg-alt)', padding: 16, borderRadius: 8,
          fontSize: 13, color: 'var(--tax-text)', alignSelf: 'start',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('owner.emailTemplates.placeholderRef')}</div>
          <p style={{ margin: '0 0 12px', color: 'var(--tax-muted)' }}>
            {t('owner.emailTemplates.placeholderHint')}
          </p>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {placeholders.map(p => (
              <li key={p} style={{ marginBottom: 4 }}>
                <code style={{ background: '#fff', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>{'{{' + p + '}}'}</code>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <EmailPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        auth={auth}
        communitySlug={community?.id}
        templateKey={activeKey}
        lang={activeLang}
        override={{ subject: form.subject, body_text: form.body_text, body_html: form.body_html }}
      />
    </EmployeeShell>
  );
}
