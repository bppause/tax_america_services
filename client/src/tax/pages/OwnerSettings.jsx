import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import enBundle from '../i18n/en.json';
import esBundle from '../i18n/es.json';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';

// Owner-facing community settings. v1 only carries the Phase 2a
// notification-preference lock toggle, which was curl-only until now.
// Additional community-level toggles (e.g., default reminder offsets,
// outbound-from name) can be added here over time without route changes.
export default function OwnerSettings() {
  const { t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const load = () => {
    if (!fbUser || !community) return;
    taxApi.adminGetCommunitySettings(auth, community.id)
      .then(d => setSettings(d.settings))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const onToggleNotifLock = async (allowChange) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetNotifLock(auth, { communitySlug: community.id, allowCustomerChange: allowChange });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  const onToggleDocsEnabled = async (enabled) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetDocumentsEnabled(auth, { communitySlug: community.id, enabled });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  const onSaveLookahead = async (months) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetTaskLookahead(auth, { communitySlug: community.id, months });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };
  const onSaveThresholds = async (vals) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetTaskThresholds(auth, { communitySlug: community.id, ...vals });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };
  const onSaveColorOverrides = async (payload) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetTaskColorOverrides(auth, { communitySlug: community.id, ...payload });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };
  const onRefreshTasksNow = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminRefreshTasks(auth);
      setMsg({ kind: 'success',
        text: t('owner.settings.lookahead.refreshed', { scanned: r.scanned || 0, created: r.created || 0 }) });
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  const onToggleCustomerEmail = async (type, enabled) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetCustomerEmailEnabled(auth, { communitySlug: community.id, type, enabled });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };
  const onToggleCustomerEmailsMaster = async (enabled) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetCustomerEmailsMaster(auth, { communitySlug: community.id, enabled });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  const onToggleRemindersEnabled = async (enabled) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetRemindersEnabled(auth, { communitySlug: community.id, enabled });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  const onTogglePortalEnabled = async (enabled) => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetPortalEnabled(auth, { communitySlug: community.id, enabled });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
    }
  };

  if (err) return <EmployeeShell community={community} active="settings"><div className="tax-msg tax-msg--error">{err}</div></EmployeeShell>;
  if (!settings) return <EmployeeShell community={community} active="settings"><p>{t('loading')}</p></EmployeeShell>;

  const allowChange = Boolean(settings.tax_allow_customer_notif_pref_change);
  const docsEnabled = Boolean(settings.tax_customer_documents_enabled);
  const portalEnabled = Boolean(settings.tax_customer_portal_enabled);
  const remindersEnabled = Boolean(settings.tax_customer_reminders_enabled);
  const lookaheadMonths = Number(settings.tax_task_lookahead_months) || 6;
  const thresholds = {
    urgent:   Number(settings.tax_task_urgent_days   ?? 3),
    soon:     Number(settings.tax_task_soon_days     ?? 7),
    upcoming: Number(settings.tax_task_upcoming_days ?? 30),
  };

  return (
    <EmployeeShell community={community} active="settings">
      <h2 style={{ marginTop: 0 }}>{t('owner.settings.title')}</h2>
      <p className="tax-section__lede">{t('owner.settings.subtitle')}</p>

      {msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginBottom: 16 }}>{msg.text}</div>
      )}

      <CollapsibleSection
        storageKey="notifLock"
        defaultOpen={allowChange}
        title={t('owner.settings.notifLock.title')}
        subtitle={t('owner.settings.notifLock.subtitle')}
        statusLabel={allowChange ? t('owner.settings.statusEnabled') : t('owner.settings.statusLocked')}
        enabled={allowChange}>
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: !allowChange ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="notif-lock" disabled={busy}
                   checked={!allowChange} onChange={() => onToggleNotifLock(false)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.notifLock.locked')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.notifLock.lockedHint')}
              </div>
            </div>
          </label>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: allowChange ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="notif-lock" disabled={busy}
                   checked={allowChange} onChange={() => onToggleNotifLock(true)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.notifLock.unlocked')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.notifLock.unlockedHint')}
              </div>
            </div>
          </label>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="lookahead"
        defaultOpen={true}
        title={t('owner.settings.lookahead.title')}
        subtitle={t('owner.settings.lookahead.subtitle')}>
        <LookaheadEditor initial={lookaheadMonths} busy={busy}
                         onSave={onSaveLookahead} onRefresh={onRefreshTasksNow} t={t} />
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="urgency"
        defaultOpen={true}
        title={t('owner.settings.urgency.title')}
        subtitle={t('owner.settings.urgency.subtitle')}>
        <ThresholdEditor initial={thresholds} busy={busy} onSave={onSaveThresholds} t={t} />
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="colors"
        defaultOpen={true}
        title={t('owner.settings.colors.title')}
        subtitle={t('owner.settings.colors.subtitle')}>
        <ColorOverridesEditor
          initialPriority={settings.tax_task_priority_colors || {}}
          initialUrgency={settings.tax_task_urgency_colors || {}}
          busy={busy} onSave={onSaveColorOverrides} t={t} />
      </CollapsibleSection>

      <CustomerEmailsSection settings={settings} busy={busy} t={t}
                             onToggle={onToggleCustomerEmail}
                             onToggleMaster={onToggleCustomerEmailsMaster} />

      <CollapsibleSection
        storageKey="reminders"
        defaultOpen={remindersEnabled}
        title={t('owner.settings.reminders.title')}
        subtitle={t('owner.settings.reminders.subtitle')}
        statusLabel={remindersEnabled ? t('owner.settings.statusOn') : t('owner.settings.statusOff')}
        enabled={remindersEnabled}>
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: !remindersEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="reminders-enabled" disabled={busy}
                   checked={!remindersEnabled} onChange={() => onToggleRemindersEnabled(false)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.reminders.off')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.reminders.offHint')}
              </div>
            </div>
          </label>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: remindersEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="reminders-enabled" disabled={busy}
                   checked={remindersEnabled} onChange={() => onToggleRemindersEnabled(true)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.reminders.on')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.reminders.onHint')}
              </div>
            </div>
          </label>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="portal"
        defaultOpen={portalEnabled}
        title={t('owner.settings.portal.title')}
        subtitle={t('owner.settings.portal.subtitle')}
        statusLabel={portalEnabled ? t('owner.settings.statusOn') : t('owner.settings.statusOff')}
        enabled={portalEnabled}>
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: !portalEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="portal-enabled" disabled={busy}
                   checked={!portalEnabled} onChange={() => onTogglePortalEnabled(false)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.portal.off')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.portal.offHint')}
              </div>
            </div>
          </label>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: portalEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="portal-enabled" disabled={busy}
                   checked={portalEnabled} onChange={() => onTogglePortalEnabled(true)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.portal.on')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.portal.onHint')}
              </div>
            </div>
          </label>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="docs"
        defaultOpen={docsEnabled}
        title={t('owner.settings.docs.title')}
        subtitle={t('owner.settings.docs.subtitle')}
        statusLabel={docsEnabled ? t('owner.settings.statusOn') : t('owner.settings.statusOff')}
        enabled={docsEnabled}>
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: !docsEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="docs-enabled" disabled={busy}
                   checked={!docsEnabled} onChange={() => onToggleDocsEnabled(false)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.docs.off')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.docs.offHint')}
              </div>
            </div>
          </label>
          <label style={{
            display: 'flex', gap: 12, padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
            cursor: busy ? 'wait' : 'pointer',
            background: docsEnabled ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
          }}>
            <input type="radio" name="docs-enabled" disabled={busy}
                   checked={docsEnabled} onChange={() => onToggleDocsEnabled(true)}
                   style={{ marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 600 }}>{t('owner.settings.docs.on')}</div>
              <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                {t('owner.settings.docs.onHint')}
              </div>
            </div>
          </label>
        </div>
      </CollapsibleSection>

      <TaskStatusesSection auth={auth} community={community} t={t} />

      <CommunityContactSection settings={settings} auth={auth} community={community}
                               t={t} onSaved={load} />

      <LandingCopySection settings={settings} auth={auth} community={community}
                          t={t} onSaved={load} />
    </EmployeeShell>
  );
}

// Reusable expander for the settings page. Persists open/closed state per
// section in localStorage so an owner who deliberately collapsed something
// doesn't see it spring back open after a refresh. Default state is driven
// by `defaultOpen` — typically the toggle-controlled sections pass the
// Customer-facing email types the owner can toggle independently.
// Each row maps a community column to a friendly label + explainer.
// All four ship as OFF defaults on the schema so a fresh community
// never quietly emails customers — the owner opts each one in.
const CUSTOMER_EMAIL_TYPES = [
  { type: 'welcome',   column: 'tax_email_welcome_enabled',
    labelKey: 'owner.settings.customerEmails.welcome.label',
    descKey:  'owner.settings.customerEmails.welcome.desc' },
  { type: 'document',  column: 'tax_email_document_enabled',
    labelKey: 'owner.settings.customerEmails.document.label',
    descKey:  'owner.settings.customerEmails.document.desc' },
  { type: 'message',   column: 'tax_email_message_enabled',
    labelKey: 'owner.settings.customerEmails.message.label',
    descKey:  'owner.settings.customerEmails.message.desc' },
  { type: 'signature', column: 'tax_email_signature_enabled',
    labelKey: 'owner.settings.customerEmails.signature.label',
    descKey:  'owner.settings.customerEmails.signature.desc' },
];

// Collapsible card with one row per customer-email type. Each row is
// its own toggle pill so the owner can flip exactly the types they
// want on without the all-or-nothing feel of a single switch. Counter
// in the header shows how many are currently on, so the owner can
// tell at a glance how chatty the practice is being with customers.
function CustomerEmailsSection({ settings, busy, t, onToggle, onToggleMaster }) {
  // Master gates everything. When off, the per-type pills still
  // render so the owner can see their saved config — but the
  // "effective" send state is OFF for all of them, and the inputs
  // are disabled so it's obvious that flipping them mid-pause won't
  // start sending. Per-type config is preserved across a pause so a
  // single click restores the prior posture.
  const masterOn = !!(settings && settings.tax_customer_emails_master_enabled);
  const enabledCount = CUSTOMER_EMAIL_TYPES
    .filter(row => settings && settings[row.column]).length;
  const effectiveOnCount = masterOn ? enabledCount : 0;
  return (
    <CollapsibleSection
      storageKey="customerEmails"
      defaultOpen={false}
      title={t('owner.settings.customerEmails.title')}
      subtitle={t('owner.settings.customerEmails.subtitle')}
      statusLabel={!masterOn
        ? t('owner.settings.customerEmails.masterOff')
        : (enabledCount === 0
            ? t('owner.settings.customerEmails.allOff')
            : t('owner.settings.customerEmails.someOn', { count: effectiveOnCount }))}
      enabled={masterOn && enabledCount > 0}>
      <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
        {/* Master row sits above the per-type pills with a thicker
            visual treatment so it reads as the parent control. */}
        <label style={{
          display: 'flex', gap: 12, alignItems: 'flex-start',
          padding: 14, border: '2px solid',
          borderColor: masterOn
            ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
            : 'var(--tax-border)',
          borderRadius: 8, cursor: busy ? 'wait' : 'pointer',
          background: masterOn
            ? 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)'
            : '#fff',
        }}>
          <input type="checkbox" disabled={busy}
                 checked={masterOn}
                 onChange={(e) => onToggleMaster(e.target.checked)}
                 style={{ marginTop: 4 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700 }}>
              {t('owner.settings.customerEmails.master.label')}
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                background: masterOn
                  ? 'color-mix(in srgb, var(--tax-success, #16a34a) 12%, #fff)'
                  : 'color-mix(in srgb, #b91c1c 8%, #fff)',
                color: masterOn ? 'var(--tax-success, #16a34a)' : '#7f1d1d',
                border: '1px solid',
                borderColor: masterOn
                  ? 'color-mix(in srgb, var(--tax-success, #16a34a) 35%, #fff)'
                  : 'color-mix(in srgb, #b91c1c 25%, #fff)',
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              }}>
                {masterOn ? t('owner.settings.statusOn') : t('owner.settings.statusOff')}
              </span>
            </div>
            <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
              {t('owner.settings.customerEmails.master.desc')}
            </div>
          </div>
        </label>

        {/* Per-type rows. Inputs disabled when master is off so it's
            visually clear that flipping one mid-pause doesn't start
            sending — the master gate has to come back on first. The
            saved state still renders so the owner can plan ahead. */}
        {CUSTOMER_EMAIL_TYPES.map(row => {
          const on = !!(settings && settings[row.column]);
          const effective = masterOn && on;
          const inputDisabled = busy || !masterOn;
          return (
            <label key={row.type} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              padding: 14, border: '1px solid var(--tax-border)', borderRadius: 8,
              cursor: inputDisabled ? 'not-allowed' : 'pointer',
              background: effective ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
              opacity: masterOn ? 1 : 0.55,
            }}>
              <input type="checkbox" disabled={inputDisabled}
                     checked={on}
                     onChange={(e) => onToggle(row.type, e.target.checked)}
                     style={{ marginTop: 4 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {t(row.labelKey)}
                  <span style={{
                    marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                    background: effective
                      ? 'color-mix(in srgb, var(--tax-success, #16a34a) 12%, #fff)'
                      : 'var(--tax-bg-alt)',
                    color: effective ? 'var(--tax-success, #16a34a)' : 'var(--tax-muted)',
                    border: '1px solid',
                    borderColor: effective
                      ? 'color-mix(in srgb, var(--tax-success, #16a34a) 35%, #fff)'
                      : 'var(--tax-border)',
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                  }}>
                    {effective
                      ? t('owner.settings.statusOn')
                      : (!masterOn && on
                          ? t('owner.settings.customerEmails.pausedByMaster')
                          : t('owner.settings.statusOff'))}
                  </span>
                </div>
                <div style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 4 }}>
                  {t(row.descKey)}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

// current "enabled" value here so a disabled feature starts collapsed,
// saving vertical space on the screen.
function CollapsibleSection({ storageKey, defaultOpen, title, subtitle, statusLabel, enabled, children }) {
  const lsKey = `tax.ownerSettings.${storageKey}.open`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(lsKey) : null;
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch { /* ignore */ }
    return !!defaultOpen;
  });
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(lsKey, open ? '1' : '0');
      }
    } catch { /* ignore */ }
  }, [open, lsKey]);

  return (
    <section style={{
      marginBottom: 16,
      border: '1px solid var(--tax-border)', borderRadius: 10,
      background: '#fff', overflow: 'hidden',
    }}>
      <button type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', textAlign: 'left',
                padding: '12px 14px', border: 0,
                background: open ? 'color-mix(in srgb, var(--tax-brand-primary) 4%, #fff)' : '#fff',
                cursor: 'pointer',
              }}>
        <span style={{
          display: 'inline-block', transition: 'transform .15s ease',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          fontSize: 11, color: 'var(--tax-muted)',
        }}>▶</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--tax-text)' }}>{title}</span>
        </span>
        {statusLabel && (
          <span style={{
            padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.04em',
            background: enabled
              ? 'color-mix(in srgb, var(--tax-success, #16a34a) 12%, #fff)'
              : 'var(--tax-bg-alt)',
            color: enabled ? 'var(--tax-success, #16a34a)' : 'var(--tax-muted)',
            border: '1px solid',
            borderColor: enabled
              ? 'color-mix(in srgb, var(--tax-success, #16a34a) 35%, #fff)'
              : 'var(--tax-border)',
          }}>{statusLabel}</span>
        )}
      </button>
      {open && (
        <div style={{ padding: '4px 14px 16px' }}>
          {subtitle && (
            <p style={{ color: 'var(--tax-muted)', marginTop: 0, marginBottom: 12, fontSize: 14 }}>
              {subtitle}
            </p>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

// Phase: editable status list for the task tracker. Owner can rename
// labels, add new statuses (e.g., "Waiting on client"), reorder, and
// mark which ones close the task (is_terminal stamps completed_at).
// Deletion is refused server-side when tasks still reference the key.
function TaskStatusesSection({ auth, community, t }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () => {
    taxApi.adminListTaskStatuses(auth, community.id)
      .then(d => setRows(d.statuses || []))
      .catch(e => setErr(e?.message || ''));
  };
  useEffect(load, [community]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CollapsibleSection
      storageKey="taskStatuses"
      defaultOpen={true}
      title={t('owner.settings.taskStatuses.title')}
      subtitle={t('owner.settings.taskStatuses.subtitle')}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        {!adding && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => setAdding(true)}>
            + {t('owner.settings.taskStatuses.add')}
          </button>
        )}
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {adding && (
        <NewStatusForm auth={auth} community={community}
                       onCreated={() => { setAdding(false); load(); }}
                       onCancel={() => setAdding(false)} t={t} />
      )}

      {rows === null ? <p>{t('loading')}</p>
        : rows.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.settings.taskStatuses.empty')}</p>
          : <div style={{ display: 'grid', gap: 6 }}>
              {rows.map(r => (
                <StatusRow key={r.id} row={r} auth={auth} onChange={load} t={t} />
              ))}
            </div>
      }
    </CollapsibleSection>
  );
}

function StatusRow({ row, auth, onChange, t }) {
  const [editing, setEditing] = useState(false);
  const [en, setEn] = useState(row.label_i18n?.en || row.key);
  const [es, setEs] = useState(row.label_i18n?.es || row.key);
  const [color, setColor] = useState(row.color || '#9ca3af');
  const [order, setOrder] = useState(String(row.display_order || 0));
  const [terminal, setTerminal] = useState(!!row.is_terminal);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onSave = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminUpdateTaskStatus(auth, row.id, {
        labelI18n: { en: en.trim(), es: es.trim() },
        color, displayOrder: Number(order) || 0, isTerminal: terminal,
      });
      setEditing(false); onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onDelete = async () => {
    if (!window.confirm(t('owner.settings.taskStatuses.deleteConfirm'))) return;
    setBusy(true); setErr('');
    try { await taxApi.adminDeleteTaskStatus(auth, row.id); onChange(); }
    catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <div className="tax-contact-item" style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block', width: 14, height: 14, borderRadius: 4,
            background: row.color || '#9ca3af',
          }} />
          <strong>{row.label_i18n?.en || row.key}</strong>
          <span style={{ color: 'var(--tax-muted)', fontSize: 12 }}>
            · {row.label_i18n?.es || row.key} · key: {row.key} · {t('owner.settings.taskStatuses.order')}: {row.display_order}
            {row.is_terminal && ` · ${t('owner.settings.taskStatuses.terminalBadge')}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!editing && (
            <button type="button" onClick={() => setEditing(true)}
                    className="tax-btn tax-btn--ghost tax-btn--sm"
                    style={{ color: 'var(--tax-text)' }}>{t('owner.faq.editOverride')}</button>
          )}
          <button type="button" onClick={onDelete} disabled={busy}
                  className="tax-btn tax-btn--ghost tax-btn--sm"
                  style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>×</button>
        </div>
      </div>
      {editing && (
        <div style={{ display: 'grid', gap: 8, padding: 10, background: 'var(--tax-bg-alt)', borderRadius: 6 }}>
          <div className="tax-form__row2">
            <input type="text" value={en} onChange={e => setEn(e.target.value)} placeholder="English"
                   style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
            <input type="text" value={es} onChange={e => setEs(e.target.value)} placeholder="Español"
                   style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
            <label>
              {t('owner.settings.taskStatuses.color')}:&nbsp;
              <input type="color" value={color} onChange={e => setColor(e.target.value)} />
            </label>
            <label>
              {t('owner.settings.taskStatuses.order')}:&nbsp;
              <input type="number" value={order} onChange={e => setOrder(e.target.value)}
                     style={{ width: 70, padding: 4, border: '1px solid var(--tax-border)', borderRadius: 4 }} />
            </label>
            <label>
              <input type="checkbox" checked={terminal} onChange={e => setTerminal(e.target.checked)} />
              {' '}{t('owner.settings.taskStatuses.terminal')}
            </label>
          </div>
          {err && <div className="tax-msg tax-msg--error">{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onSave} disabled={busy}
                    className="tax-btn tax-btn--primary tax-btn--sm">
              {busy ? t('lead.submitting') : t('owner.faq.saveOverride')}
            </button>
            <button type="button" onClick={() => setEditing(false)}
                    className="tax-btn tax-btn--ghost tax-btn--sm" style={{ color: 'var(--tax-text)' }}>
              {t('preview.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewStatusForm({ auth, community, onCreated, onCancel, t }) {
  const [key, setKey] = useState('');
  const [en, setEn] = useState('');
  const [es, setEs] = useState('');
  const [color, setColor] = useState('#6b7280');
  const [order, setOrder] = useState('100');
  const [terminal, setTerminal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const onSave = async () => {
    if (!key.trim() || (!en.trim() && !es.trim())) { setErr(t('owner.settings.taskStatuses.errFields')); return; }
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateTaskStatus(auth, {
        communitySlug: community.id, key: key.trim(),
        labelI18n: { en: en.trim(), es: es.trim() },
        color, displayOrder: Number(order) || 100, isTerminal: terminal,
      });
      onCreated();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8, marginBottom: 12 }}>
      <div className="tax-form__row2">
        <input type="text" value={key} onChange={e => setKey(e.target.value)}
               placeholder={t('owner.settings.taskStatuses.keyPlaceholder')}
               style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <input type="color" value={color} onChange={e => setColor(e.target.value)} />
      </div>
      <div className="tax-form__row2">
        <input type="text" value={en} onChange={e => setEn(e.target.value)} placeholder="English label"
               style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <input type="text" value={es} onChange={e => setEs(e.target.value)} placeholder="Etiqueta en español"
               style={{ padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
        <label>
          {t('owner.settings.taskStatuses.order')}:&nbsp;
          <input type="number" value={order} onChange={e => setOrder(e.target.value)}
                 style={{ width: 70, padding: 4, border: '1px solid var(--tax-border)', borderRadius: 4 }} />
        </label>
        <label>
          <input type="checkbox" checked={terminal} onChange={e => setTerminal(e.target.checked)} />
          {' '}{t('owner.settings.taskStatuses.terminal')}
        </label>
      </div>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy} onClick={onSave}>
          {busy ? t('lead.submitting') : t('owner.settings.taskStatuses.create')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onCancel}
                style={{ color: 'var(--tax-text)' }}>
          {t('preview.close')}
        </button>
      </div>
    </div>
  );
}

// Phase 4n.14: contact-card editor. Phone, WhatsApp, contact email, and
// address fields drive the public landing page "Visit us" card + the map
// embed. Name and default locale stay read-only here — they live on the
// platform community editor for now.
function CommunityContactSection({ settings, auth, community, t, onSaved }) {
  const [form, setForm] = useState({
    contact_email: '', phone: '', whatsapp: '',
    address_line1: '', address_line2: '',
    city: '', state: '', postal_code: '', country: '',
    calendly_url: '',
  });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  useEffect(() => {
    if (!settings) return;
    setForm({
      contact_email: settings.contact_email || '',
      phone: settings.phone || '',
      whatsapp: settings.whatsapp || '',
      address_line1: settings.address_line1 || '',
      address_line2: settings.address_line2 || '',
      city: settings.city || '',
      state: settings.state || '',
      postal_code: settings.postal_code || '',
      country: settings.country || '',
      calendly_url: settings.calendly_url || '',
    });
  }, [settings]);

  const onField = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const onSave = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminUpdateCommunityContact(auth, {
        communitySlug: community.id,
        contact_email: form.contact_email.trim(),
        phone: form.phone.trim(),
        whatsapp: form.whatsapp.trim(),
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        postal_code: form.postal_code.trim(),
        country: form.country.trim(),
        calendly_url: form.calendly_url.trim(),
      });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      setEditing(false);
      onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };

  return (
    <CollapsibleSection
      storageKey="community"
      defaultOpen={true}
      title={t('owner.settings.community.title')}
      subtitle={t('owner.settings.community.subtitle')}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        {!editing && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  onClick={() => setEditing(true)}>
            {t('owner.settings.community.editBtn')}
          </button>
        )}
      </div>

      {msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginBottom: 12 }}>{msg.text}</div>
      )}

      {!editing ? (
        <div className="tax-contact-grid">
          <ReadRow label={t('owner.settings.community.name')}         value={settings.name} />
          <ReadRow label={t('owner.settings.community.contactEmail')} value={settings.contact_email} />
          <ReadRow label={t('owner.settings.community.phone')}        value={settings.phone} />
          <ReadRow label={t('owner.settings.community.whatsapp')}     value={settings.whatsapp} />
          <ReadRow label={t('owner.settings.community.address')}      value={[settings.address_line1, settings.address_line2, settings.city, settings.state, settings.postal_code, settings.country].filter(Boolean).join(', ')} />
          <ReadRow label={t('owner.settings.community.calendly')}     value={settings.calendly_url} />
          <ReadRow label={t('owner.settings.community.defaultLocale')} value={settings.default_locale === 'en' ? 'English' : 'Español'} />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
          <Field id="cs-email" label={t('owner.settings.community.contactEmail')}
                 type="email" value={form.contact_email}
                 onChange={v => onField('contact_email', v)} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field id="cs-phone" label={t('owner.settings.community.phone')}
                   type="tel" value={form.phone} onChange={v => onField('phone', v)} />
            <Field id="cs-wa" label={t('owner.settings.community.whatsapp')}
                   placeholder="+14155551234"
                   hint={t('owner.settings.community.whatsappHint')}
                   value={form.whatsapp} onChange={v => onField('whatsapp', v)} />
          </div>
          <Field id="cs-a1" label={t('owner.settings.community.addressLine1')}
                 value={form.address_line1} onChange={v => onField('address_line1', v)} />
          <Field id="cs-a2" label={t('owner.settings.community.addressLine2')}
                 value={form.address_line2} onChange={v => onField('address_line2', v)} />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field id="cs-city" label={t('owner.settings.community.city')}
                   value={form.city} onChange={v => onField('city', v)} />
            <Field id="cs-state" label={t('owner.settings.community.state')}
                   value={form.state} onChange={v => onField('state', v)} />
            <Field id="cs-zip" label={t('owner.settings.community.postalCode')}
                   value={form.postal_code} onChange={v => onField('postal_code', v)} />
          </div>
          <Field id="cs-country" label={t('owner.settings.community.country')}
                 value={form.country} onChange={v => onField('country', v)} />
          <Field id="cs-calendly" label={t('owner.settings.community.calendly')}
                 type="url" placeholder="https://calendly.com/your-handle"
                 hint={t('owner.settings.community.calendlyHint')}
                 value={form.calendly_url}
                 onChange={v => onField('calendly_url', v)} />

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                    disabled={busy} onClick={onSave}>
              {busy ? t('lead.submitting') : t('owner.settings.community.saveBtn')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    disabled={busy} onClick={() => setEditing(false)}>
              {t('preview.close')}
            </button>
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

function ReadRow({ label, value }) {
  return (
    <div className="tax-contact-item">
      <div className="tax-contact-item__label">{label}</div>
      <div className="tax-contact-item__value">{value || '—'}</div>
    </div>
  );
}

function Field({ id, label, type, value, onChange, placeholder, hint }) {
  return (
    <div>
      <label htmlFor={id} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>{label}</label>
      <input id={id} type={type || 'text'} value={value || ''}
             placeholder={placeholder || ''}
             onChange={e => onChange(e.target.value)}
             style={{ width: '100%' }} />
      {hint && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>{hint}</p>}
    </div>
  );
}

function LookaheadEditor({ initial, busy, onSave, onRefresh, t }) {
  const [draft, setDraft] = useState(String(initial));
  const dirty = String(initial) !== String(draft);
  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13 }}>{t('owner.settings.lookahead.label')}</span>
        <input type="number" min="1" max="24" value={draft}
               onChange={e => setDraft(e.target.value)} disabled={busy}
               style={{ width: 80, padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={busy || !dirty
                          || !Number.isFinite(Number(draft))
                          || Number(draft) < 1 || Number(draft) > 24}
                onClick={() => onSave(Math.max(1, Math.min(24, Math.round(Number(draft) || 6))))}>
          {t('owner.settings.lookahead.save')}
        </button>
      </label>
      <div>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                disabled={busy} onClick={onRefresh}
                style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
          {t('owner.settings.lookahead.refreshNow')}
        </button>
        <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>
          {t('owner.settings.lookahead.refreshHint')}
        </p>
      </div>
    </div>
  );
}

// Editor for the three urgency thresholds — shared by Tasks list,
// Calendar pips, and Kanban card borders. Server clamps + enforces
// urgent < soon < upcoming, but we surface a friendly warning on
// the client too so the owner sees it before submitting.
function ThresholdEditor({ initial, busy, onSave, t }) {
  const [draft, setDraft] = useState({
    urgent: String(initial.urgent ?? 2),
    soon:   String(initial.soon   ?? 7),
  });
  const u = Number(draft.urgent);
  const s = Number(draft.soon);
  const validNums = Number.isFinite(u) && Number.isFinite(s);
  const ordered = validNums && u <= s;
  const dirty = String(initial.urgent) !== draft.urgent
             || String(initial.soon) !== draft.soon;
  return (
    <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <ThresholdField label={t('owner.settings.urgency.red')}    color="#dc2626"
                        value={draft.urgent} busy={busy}
                        onChange={v => setDraft(d => ({ ...d, urgent: v }))} />
        <ThresholdField label={t('owner.settings.urgency.orange')} color="#ea580c"
                        value={draft.soon} busy={busy}
                        onChange={v => setDraft(d => ({ ...d, soon: v }))} />
      </div>
      {!ordered && validNums && (
        <div className="tax-msg tax-msg--error" style={{ marginTop: 4 }}>
          {t('owner.settings.urgency.outOfOrder')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={busy || !dirty || !ordered}
                onClick={() => onSave({ urgentDays: u, soonDays: s, upcomingDays: 0 })}>
          {t('owner.settings.urgency.save')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.settings.urgency.preview', { urgent: u || '?', soon: s || '?' })}
        </span>
      </div>
    </div>
  );
}
function ThresholdField({ label, color, value, onChange, busy }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--tax-muted)', textTransform: 'uppercase',
                     fontWeight: 700, letterSpacing: '.04em' }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: color, marginRight: 6 }} />
        {label}
      </span>
      <input type="number" min="0" max="365" value={value} disabled={busy}
             onChange={e => onChange(e.target.value)}
             style={{ padding: '6px 8px', border: '1px solid var(--tax-border)', borderRadius: 6 }} />
    </label>
  );
}

// Priority + urgency color overrides. Each row is one bucket
// with a color input (or "default" toggle) and a live preview
// chip. Saves once via PUT /admin/community-settings/task-color-overrides
// — payload only includes keys the owner has explicitly overridden,
// so the platform defaults stay in play for everything else.
const PRIORITY_BUCKETS = ['urgent', 'high', 'normal', 'low'];
const URGENCY_BUCKETS  = ['overdue', 'urgent', 'soon', 'later'];
const PLATFORM_PRIORITY_DEFAULTS = {
  urgent: '#dc2626', high: '#ea580c', normal: '#3730a3', low: '#6b7280',
};
const PLATFORM_URGENCY_DEFAULTS = {
  overdue: '#dc2626', urgent: '#dc2626', soon: '#ea580c', later: 'transparent',
};

function ColorOverridesEditor({ initialPriority, initialUrgency, busy, onSave, t }) {
  const [priority, setPriority] = useState(initialPriority || {});
  const [urgency,  setUrgency]  = useState(initialUrgency  || {});
  useEffect(() => { setPriority(initialPriority || {}); }, [initialPriority]);
  useEffect(() => { setUrgency(initialUrgency || {}); }, [initialUrgency]);

  const setPColor = (k, v) => setPriority(p => ({ ...p, [k]: v }));
  const clearPColor = (k) => setPriority(p => { const n = { ...p }; delete n[k]; return n; });
  const setUColor = (k, v) => setUrgency(p => ({ ...p, [k]: v }));
  const clearUColor = (k) => setUrgency(p => { const n = { ...p }; delete n[k]; return n; });

  const dirty =
    JSON.stringify(priority) !== JSON.stringify(initialPriority || {}) ||
    JSON.stringify(urgency)  !== JSON.stringify(initialUrgency  || {});

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 720 }}>
      <ColorGroup
        heading={t('owner.settings.colors.priority')}
        subheading={t('owner.settings.colors.priorityHint')}
        buckets={PRIORITY_BUCKETS}
        labelKey="owner.tasks.priority"
        defaults={PLATFORM_PRIORITY_DEFAULTS}
        overrides={priority}
        setColor={setPColor} clearColor={clearPColor}
        busy={busy} t={t}
      />
      <ColorGroup
        heading={t('owner.settings.colors.urgency')}
        subheading={t('owner.settings.colors.urgencyHint')}
        buckets={URGENCY_BUCKETS}
        labelKey="owner.tasks.urgency"
        defaults={PLATFORM_URGENCY_DEFAULTS}
        overrides={urgency}
        setColor={setUColor} clearColor={clearUColor}
        busy={busy} t={t}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={busy || !dirty}
                onClick={() => onSave({
                  priorityColors: priority,
                  urgencyColors:  urgency,
                })}>
          {t('owner.settings.colors.save')}
        </button>
        {dirty && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  disabled={busy}
                  onClick={() => {
                    setPriority(initialPriority || {});
                    setUrgency(initialUrgency || {});
                  }}
                  style={{ color: 'var(--tax-text)' }}>
            {t('owner.settings.colors.discard')}
          </button>
        )}
      </div>
    </div>
  );
}

function ColorGroup({ heading, subheading, buckets, labelKey, defaults, overrides, setColor, clearColor, busy, t }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{heading}</div>
      <div style={{ fontSize: 11, color: 'var(--tax-muted)', marginBottom: 10 }}>{subheading}</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {buckets.map(k => {
          const isOverridden = !!overrides[k];
          const anchor = overrides[k] || defaults[k];
          const safeAnchor = anchor === 'transparent' ? '#ffffff' : anchor;
          return (
            <div key={k} style={{
              display: 'grid', gap: 10, alignItems: 'center',
              gridTemplateColumns: 'minmax(120px, 1fr) 140px 80px 90px',
              padding: '8px 10px', border: '1px solid var(--tax-border)', borderRadius: 6,
              background: '#fff',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t(`${labelKey}.${k}`, { _: k })}</div>
                {!isOverridden && (
                  <div style={{ fontSize: 10, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    {t('owner.settings.colors.usingDefault')}
                  </div>
                )}
              </div>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '4px 10px', borderRadius: 999,
                background: anchor === 'transparent' ? 'transparent' : `color-mix(in srgb, ${anchor} 18%, #fff)`,
                color: anchor === 'transparent' ? 'var(--tax-muted)' : anchor,
                border: anchor === 'transparent' ? '1px dashed var(--tax-border)' : `1px solid ${anchor}`,
                fontSize: 11, fontWeight: 700,
              }}>
                {t(`${labelKey}.${k}`, { _: k })}
              </span>
              <input type="color"
                     value={safeAnchor}
                     disabled={busy}
                     onChange={e => setColor(k, e.target.value)}
                     style={{ width: 60, height: 30, padding: 0, border: '1px solid var(--tax-border)', borderRadius: 4 }} />
              {isOverridden ? (
                <button type="button" onClick={() => clearColor(k)} disabled={busy}
                        className="tax-btn tax-btn--ghost tax-btn--sm"
                        style={{ color: 'var(--tax-muted)', fontSize: 11 }}>
                  {t('owner.settings.colors.reset')}
                </button>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--tax-muted)' }}>—</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Editable copy for the public landing page. JSONB blob on the community
// row keyed by the same i18n keys the landing components otherwise read
// from the bundled translations. Grouped by section, each group is its
// own nested collapsible card so the owner can focus on one area at a
// time. Empty inputs clear the override (fall back to platform default).
const LANDING_COPY_GROUPS = [
  {
    key: 'hero', titleKey: 'owner.settings.copy.group.hero',
    fields: [
      { key: 'hero.subtitle', labelKey: 'owner.settings.copy.field.heroSubtitle', multiline: true },
      { key: 'hero.cta_book', labelKey: 'owner.settings.copy.field.heroCtaBook' },
      { key: 'hero.cta_primary', labelKey: 'owner.settings.copy.field.heroCtaPrimary' },
      { key: 'hero.cta_secondary', labelKey: 'owner.settings.copy.field.heroCtaSecondary' },
    ],
  },
  {
    key: 'getStarted', titleKey: 'owner.settings.copy.group.getStarted',
    fields: [
      { key: 'getStarted.heading', labelKey: 'owner.settings.copy.field.gsHeading' },
      { key: 'getStarted.subheading', labelKey: 'owner.settings.copy.field.gsSubheading', multiline: true },
      { key: 'getStarted.scheduleHeading', labelKey: 'owner.settings.copy.field.gsScheduleHeading' },
      { key: 'getStarted.scheduleBody', labelKey: 'owner.settings.copy.field.gsScheduleBody', multiline: true },
      { key: 'landing.calendly.cta', labelKey: 'owner.settings.copy.field.gsScheduleCta' },
      { key: 'getStarted.messageHeading', labelKey: 'owner.settings.copy.field.gsMessageHeading' },
      { key: 'getStarted.messageBody', labelKey: 'owner.settings.copy.field.gsMessageBody', multiline: true },
    ],
  },
  {
    key: 'sections', titleKey: 'owner.settings.copy.group.sections',
    fields: [
      { key: 'services.heading', labelKey: 'owner.settings.copy.field.servicesHeading' },
      { key: 'services.subheading', labelKey: 'owner.settings.copy.field.servicesSubheading', multiline: true },
      { key: 'landing.team.heading', labelKey: 'owner.settings.copy.field.teamHeading' },
      { key: 'landing.team.subheading', labelKey: 'owner.settings.copy.field.teamSubheading', multiline: true },
      { key: 'landing.articles.heading', labelKey: 'owner.settings.copy.field.articlesHeading' },
      { key: 'landing.articles.subheading', labelKey: 'owner.settings.copy.field.articlesSubheading', multiline: true },
      { key: 'landing.faqs.heading', labelKey: 'owner.settings.copy.field.faqsHeading' },
      { key: 'landing.faqs.subheading', labelKey: 'owner.settings.copy.field.faqsSubheading', multiline: true },
    ],
  },
  {
    key: 'about', titleKey: 'owner.settings.copy.group.about',
    fields: [
      { key: 'about.heading', labelKey: 'owner.settings.copy.field.aboutHeading' },
      { key: 'about.body', labelKey: 'owner.settings.copy.field.aboutBody', multiline: true },
    ],
  },
];

function LandingCopySection({ settings, auth, community, t, onSaved }) {
  // Platform defaults for every editable key, in both locales. Used to
  // seed the inputs (so the owner edits existing text instead of a blank
  // box) and to detect whether the owner actually changed something at
  // save time. Static — bundles never change at runtime.
  const defaults = useMemo(() => {
    const out = {};
    for (const group of LANDING_COPY_GROUPS) {
      for (const field of group.fields) {
        out[field.key] = {
          en: enBundle[field.key] || '',
          es: esBundle[field.key] || '',
        };
      }
    }
    return out;
  }, []);

  // Seed: prefer the override, fall back to the platform default per
  // locale. Result is the "effective" text shown in each field — the
  // owner sees what visitors actually see today and can just edit it.
  const seedFrom = (overrides) => {
    const out = {};
    for (const group of LANDING_COPY_GROUPS) {
      for (const field of group.fields) {
        const ov = (overrides && overrides[field.key]) || {};
        out[field.key] = {
          en: (typeof ov.en === 'string' && ov.en) ? ov.en : defaults[field.key].en,
          es: (typeof ov.es === 'string' && ov.es) ? ov.es : defaults[field.key].es,
        };
      }
    }
    return out;
  };

  const [draft, setDraft] = useState(() => seedFrom(settings?.landing_copy_i18n));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  useEffect(() => { setDraft(seedFrom(settings?.landing_copy_i18n)); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key, lang, value) => setDraft(prev => ({
    ...prev,
    [key]: { ...(prev[key] || defaults[key]), [lang]: value },
  }));

  const resetField = (key) => setDraft(prev => ({
    ...prev,
    [key]: { ...defaults[key] },
  }));

  // Build the persistable copy blob: only include fields where the
  // current value differs from the platform default. A field that
  // matches the default in both locales reverts to "no override" and
  // drops out of the JSONB column entirely.
  const payload = useMemo(() => {
    const out = {};
    for (const group of LANDING_COPY_GROUPS) {
      for (const field of group.fields) {
        const cur = draft[field.key] || defaults[field.key];
        const def = defaults[field.key];
        const enChanged = (cur.en || '').trim() !== (def.en || '').trim();
        const esChanged = (cur.es || '').trim() !== (def.es || '').trim();
        if (!enChanged && !esChanged) continue;
        // Empty strings here mean "use default for this locale". Keep
        // them so a mixed override (e.g., custom EN, default ES) round-
        // trips correctly through the seed-from-override path above.
        out[field.key] = {
          en: enChanged ? cur.en.trim() : '',
          es: esChanged ? cur.es.trim() : '',
        };
      }
    }
    return out;
  }, [draft, defaults]);

  const dirty = JSON.stringify(payload) !== JSON.stringify(settings?.landing_copy_i18n || {});

  const isCustomized = (key) => {
    const cur = draft[key] || defaults[key];
    const def = defaults[key];
    return (cur.en || '').trim() !== (def.en || '').trim()
        || (cur.es || '').trim() !== (def.es || '').trim();
  };

  const onSave = async () => {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminUpdateLandingCopy(auth, {
        communitySlug: community.id, copy: payload,
      });
      setMsg({ kind: 'success', text: t('owner.settings.saved') });
      onSaved && onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  };
  const onResetAll = () => setDraft(seedFrom(settings?.landing_copy_i18n));

  return (
    <CollapsibleSection
      storageKey="landingCopy"
      defaultOpen={false}
      title={t('owner.settings.copy.title')}
      subtitle={t('owner.settings.copy.subtitle')}>
      {msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginBottom: 12 }}>{msg.text}</div>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        {LANDING_COPY_GROUPS.map(group => (
          <CollapsibleSection
            key={group.key}
            storageKey={`landingCopy.${group.key}`}
            defaultOpen={false}
            title={t(group.titleKey)}>
            <div style={{ display: 'grid', gap: 14 }}>
              {group.fields.map(field => {
                const cur = draft[field.key] || defaults[field.key];
                const customized = isCustomized(field.key);
                return (
                  <div key={field.key} style={{
                    padding: 12, borderRadius: 8,
                    border: '1px solid var(--tax-border)',
                    background: customized
                      ? 'color-mix(in srgb, var(--tax-brand-primary) 4%, #fff)'
                      : '#fff',
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'baseline',
                      justifyContent: 'space-between', gap: 8, marginBottom: 8,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {t(field.labelKey, { _: field.key })}
                        </span>
                        {customized && (
                          <span style={{
                            padding: '1px 8px', borderRadius: 999, fontSize: 10,
                            fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
                            background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                            color: 'var(--tax-brand-primary)',
                            border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)',
                          }}>{t('owner.settings.copy.customizedBadge')}</span>
                        )}
                      </div>
                      {customized && (
                        <button type="button" disabled={busy}
                                onClick={() => resetField(field.key)}
                                style={{
                                  border: 0, background: 'transparent', cursor: 'pointer',
                                  color: 'var(--tax-brand-primary)',
                                  fontSize: 11, fontWeight: 700,
                                }}>
                          {t('owner.settings.copy.resetField')}
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'grid', gap: 8,
                                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                      <CopyInput label="English"
                        value={cur.en || ''}
                        multiline={field.multiline}
                        disabled={busy}
                        onChange={(v) => set(field.key, 'en', v)} />
                      <CopyInput label="Español"
                        value={cur.es || ''}
                        multiline={field.multiline}
                        disabled={busy}
                        onChange={(v) => set(field.key, 'es', v)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CollapsibleSection>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={!dirty || busy} onClick={onSave}>
          {busy ? t('lead.submitting') : t('owner.settings.copy.save')}
        </button>
        {dirty && (
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                  disabled={busy} onClick={onResetAll} style={{ color: 'var(--tax-text)' }}>
            {t('owner.settings.copy.discard')}
          </button>
        )}
      </div>
    </CollapsibleSection>
  );
}

// Per-language input cell. `label` is intentionally static text — using
// the active UI locale here would make "English" and "Spanish" both
// translate to Spanish words for an owner browsing in es, hiding which
// column is which. The owner should always be able to edit both
// languages regardless of which UI language they're currently viewing.
function CopyInput({ label, value, onChange, multiline, disabled }) {
  const Field = multiline ? 'textarea' : 'input';
  return (
    <label style={{ display: 'block' }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                     textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {label}
      </span>
      <Field type={multiline ? undefined : 'text'}
             value={value}
             onChange={(e) => onChange(e.target.value)}
             disabled={disabled}
             rows={multiline ? 3 : undefined}
             maxLength={800}
             style={{
               width: '100%', marginTop: 4, padding: 8,
               border: '1px solid var(--tax-border)', borderRadius: 6,
               font: 'inherit', fontSize: 13, resize: multiline ? 'vertical' : 'none',
             }} />
    </label>
  );
}
