import { useEffect, useMemo, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import EmailPreviewModal from '../components/EmailPreviewModal';
import ChecklistField from '../components/ChecklistField';
import { generatePeriods, upcomingReminderFires, todayIsoUtc } from '../lib/schedulePeriods';

// Phase 4j: for each (relationship_type, filing_schedule) the owner can
// configure custom reminder offsets (positive days before due-date) and
// extra required documents. These layer between the per-customer override
// (tax_subscriptions.reminder_offsets_days / custom_info_checklist) and the
// per-schedule system default ([14, 7, 3] days and schedule.info_checklist).
//
// Required-docs editor: each extra doc has { key, label_i18n: {en, es},
// type, required }. Schema is the same as schedule.info_checklist so the
// reminder rendering loop doesn't need to branch.

// Phase 4n.5: type values aligned with what PortalFiling/Respond actually
// render. `currency` → numeric input with $0.01 step, `number` → numeric,
// `text` → multi-line textarea, `date` → native date picker, `file` → file
// upload that writes to tax_documents with the filing context.
const DOC_TYPES = ['currency', 'number', 'text', 'date', 'file'];

export default function OwnerRelationshipWorkflows() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [types, setTypes] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [rules, setRules] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const [activeRel, setActiveRel] = useState('');     // relationship_type_id
  // Editor state per (relTypeId, scheduleSlug): { offsetsInput, docs[] }.
  const [editor, setEditor] = useState({});           // key = `${rel}|${slug}`
  const [busy, setBusy] = useState({});               // same key → bool
  const [msg, setMsg] = useState({});                 // same key → {kind,text}
  const [preview, setPreview] = useState(null);       // { lang, extraDocs, offsetDays }

  // Advanced view: hides the Service / Form / Journey tabs by default so
  // the editor focuses on what most owners care about — Schedule +
  // Reminders. Power users toggle this on to see the full lifecycle.
  // Persisted in localStorage so the choice survives reloads.
  const [advanced, setAdvanced] = useState(() => {
    try { return localStorage.getItem('tax.workflows.advanced') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('tax.workflows.advanced', advanced ? '1' : '0'); }
    catch { /* ignore */ }
  }, [advanced]);

  const load = () => {
    if (!employee || !community) return;
    setLoading(true); setErr('');
    Promise.all([
      taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id }),
      taxApi.adminListFilingSchedules(auth, community.id),
      taxApi.adminListRelationshipWorkflowRules(auth, community.id),
    ])
      .then(([rT, rS, rR]) => {
        const ts = (rT.types || []).filter(x => x.active !== false);
        setTypes(ts);
        setSchedules(rS.schedules || []);
        setRules(rR.rules || []);
        if (!activeRel && ts.length) setActiveRel(ts[0].id);
      })
      .catch(e => setErr(e?.message || t('error.loadFailed')))
      .finally(() => setLoading(false));
  };
  useEffect(load, [fbUser, community]); // eslint-disable-line react-hooks/exhaustive-deps

  const enabledSchedules = useMemo(() =>
    schedules.filter(s => s.enabled !== false), [schedules]);

  // Phase 4n.3: "configured" = there's a rule binding this schedule slug to
  // the active relationship. Hides schedules the owner hasn't explicitly
  // chosen for this relationship — answers "what workflows does Payroll
  // actually run on?" rather than "every schedule in the catalog".
  const configuredSchedules = useMemo(() => {
    if (!activeRel) return [];
    const slugs = new Set(rules
      .filter(r => r.relationship_type_id === activeRel && r.active !== false)
      .map(r => r.filing_schedule_slug));
    return enabledSchedules.filter(s => slugs.has(s.slug));
  }, [enabledSchedules, rules, activeRel]);

  const unconfiguredSchedules = useMemo(() => {
    if (!activeRel) return enabledSchedules;
    const slugs = new Set(rules
      .filter(r => r.relationship_type_id === activeRel && r.active !== false)
      .map(r => r.filing_schedule_slug));
    return enabledSchedules.filter(s => !slugs.has(s.slug));
  }, [enabledSchedules, rules, activeRel]);

  const [showAddPicker, setShowAddPicker] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false);
  const [testSend, setTestSend] = useState(null);     // { ruleId, name }
  const [historyFor, setHistoryFor] = useState(null); // { ruleId, name }

  // System default — kept in sync with reminders.js' fallback. Used for the
  // preview when the user hasn't typed any custom offsets yet.
  const SYSTEM_DEFAULT_OFFSETS = [14, 7, 3];
  const HORIZONS = [30, 60, 90, 365];

  // Parse the offsets the same way onSave does, so the preview matches what
  // will actually be saved. Falls back to the system default when empty/invalid.
  function parseOffsets(input) {
    const parsed = String(input || '')
      .split(/[\s,;]+/).map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
    return { offsets: parsed, usingDefault: parsed.length === 0 };
  }

  // Format an ISO yyyy-mm-dd as a short localized date (e.g. "Jun 1, 2026").
  function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    try {
      return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
    } catch (_e) {
      return iso;
    }
  }

  const ruleFor = (relId, slug) =>
    rules.find(r => r.relationship_type_id === relId && r.filing_schedule_slug === slug) || null;

  // Pull current editor state, falling back to whatever is stored.
  const getEditState = (relId, slug) => {
    const k = `${relId}|${slug}`;
    if (editor[k]) return editor[k];
    const r = ruleFor(relId, slug);
    return {
      offsetsInput: Array.isArray(r?.reminder_offsets_days) ? r.reminder_offsets_days.join(', ') : '',
      docs: Array.isArray(r?.required_documents) ? r.required_documents : [],
    };
  };
  const setEditState = (relId, slug, patch) => {
    const k = `${relId}|${slug}`;
    setEditor(prev => ({ ...prev, [k]: { ...getEditState(relId, slug), ...patch } }));
  };

  const onSave = async (relId, slug) => {
    const k = `${relId}|${slug}`;
    const st = getEditState(relId, slug);
    setBusy(p => ({ ...p, [k]: true }));
    setMsg(p => ({ ...p, [k]: { kind: 'idle', text: '' } }));
    try {
      // Parse "14, 7, 2" or "14 7 2" or "14;7;2"
      const offsets = String(st.offsetsInput || '')
        .split(/[\s,;]+/).map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
      await taxApi.adminUpdateRelationshipWorkflowRule(auth, relId, slug, {
        communitySlug: community.id,
        reminderOffsetsDays: offsets,
        requiredDocuments: st.docs,
        active: true,
      });
      setMsg(p => ({ ...p, [k]: { kind: 'success', text: t('owner.workflows.saved') } }));
      // Clear editor cache for this key so next render shows DB state.
      setEditor(prev => { const n = { ...prev }; delete n[k]; return n; });
      load();
    } catch (e) {
      setMsg(p => ({ ...p, [k]: { kind: 'error', text: e?.message || t('respond.error.generic') } }));
    } finally {
      setBusy(p => ({ ...p, [k]: false }));
    }
  };

  const onReset = async (relId, slug) => {
    if (!window.confirm(t('owner.workflows.resetConfirm'))) return;
    const k = `${relId}|${slug}`;
    setBusy(p => ({ ...p, [k]: true }));
    setMsg(p => ({ ...p, [k]: { kind: 'idle', text: '' } }));
    try {
      await taxApi.adminDeleteRelationshipWorkflowRule(auth, relId, slug, community.id);
      setEditor(prev => { const n = { ...prev }; delete n[k]; return n; });
      setMsg(p => ({ ...p, [k]: { kind: 'success', text: t('owner.workflows.resetDone') } }));
      load();
    } catch (e) {
      setMsg(p => ({ ...p, [k]: { kind: 'error', text: e?.message || t('respond.error.generic') } }));
    } finally {
      setBusy(p => ({ ...p, [k]: false }));
    }
  };

  const addDoc = (relId, slug) => {
    const st = getEditState(relId, slug);
    setEditState(relId, slug, {
      docs: [...st.docs, { key: '', label_i18n: { en: '', es: '' }, type: 'text', required: true }],
    });
  };
  const updateDoc = (relId, slug, idx, patch) => {
    const st = getEditState(relId, slug);
    const next = st.docs.slice();
    next[idx] = { ...next[idx], ...patch };
    setEditState(relId, slug, { docs: next });
  };
  const removeDoc = (relId, slug, idx) => {
    const st = getEditState(relId, slug);
    setEditState(relId, slug, { docs: st.docs.filter((_, i) => i !== idx) });
  };

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community} active="workflows">
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  return (
    <EmployeeShell community={community} active="workflows">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{t('owner.workflows.title')}</h2>
          <p className="tax-section__lede">{t('owner.workflows.subtitle')}</p>
        </div>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13,
          padding: '6px 12px', border: '1px solid var(--tax-border)', borderRadius: 999,
          background: advanced ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : '#fff',
          cursor: 'pointer',
        }}>
          <input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)} />
          {t('owner.workflows.advanced')}
        </label>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      {loading && <p>{t('loading')}</p>}

      {types.length === 0 && !loading && (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.noRelationships')}</p>
      )}

      {types.length > 0 && (
        <>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="wkfl-rel" style={{ display: 'block', fontSize: 13, color: 'var(--tax-muted)', marginBottom: 4 }}>
              {t('owner.workflows.relationship')}
            </label>
            <select id="wkfl-rel" value={activeRel} onChange={e => setActiveRel(e.target.value)}>
              {types.map(rt => (
                <option key={rt.id} value={rt.id}>
                  {rt.category} — {pickI18n(rt.name_i18n, locale).value || rt.slug}
                </option>
              ))}
            </select>
          </div>

          {enabledSchedules.length === 0 && (
            <p style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.noSchedules')}</p>
          )}

          {configuredSchedules.length === 0 ? (
            // Phase 4n.26: hero empty state — three big action cards instead
            // of a tiny "use the buttons above" line. Owners new to a
            // relationship type land here first; this is where they decide
            // whether to clone a template, enable an existing schedule, or
            // build from scratch.
            <div style={{
              marginTop: 24, padding: '32px 24px', borderRadius: 12,
              background: 'var(--tax-bg-alt)', border: '1px solid var(--tax-border)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 36, marginBottom: 8 }} aria-hidden="true">⚙️</div>
              <h3 style={{ margin: '0 0 6px', fontSize: 18 }}>
                {t('owner.workflows.empty.title')}
              </h3>
              <p style={{
                margin: '0 auto 20px', maxWidth: 520,
                fontSize: 14, color: 'var(--tax-muted)',
              }}>
                {t('owner.workflows.empty.body')}
              </p>
              <div style={{
                display: 'grid', gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                maxWidth: 720, margin: '0 auto', textAlign: 'left',
              }}>
                <EmptyChoiceCard
                  recommended
                  icon="📚"
                  title={t('owner.workflows.empty.template.title')}
                  body={t('owner.workflows.empty.template.body')}
                  cta={t('owner.workflows.fromTemplateBtn')}
                  onClick={() => setShowTemplateLibrary(true)} />
                <EmptyChoiceCard
                  icon="✚"
                  title={t('owner.workflows.empty.create.title')}
                  body={t('owner.workflows.empty.create.body')}
                  cta={t('owner.workflows.createNewBtn')}
                  onClick={() => setShowCreateModal(true)} />
                {unconfiguredSchedules.length > 0 && (
                  <EmptyChoiceCard
                    icon="🔗"
                    title={t('owner.workflows.empty.existing.title')}
                    body={t('owner.workflows.empty.existing.body', { count: unconfiguredSchedules.length })}
                    cta={t('owner.workflows.addExistingBtn')}
                    onClick={() => setShowAddPicker(true)} />
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
              {unconfiguredSchedules.length > 0 && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={() => setShowAddPicker(true)}>
                  + {t('owner.workflows.addExistingBtn')}
                </button>
              )}
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                      onClick={() => setShowTemplateLibrary(true)}>
                + {t('owner.workflows.fromTemplateBtn')}
              </button>
              <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                      onClick={() => setShowCreateModal(true)}>
                + {t('owner.workflows.createNewBtn')}
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gap: 16 }}>
            {configuredSchedules.map(sch => {
              const k = `${activeRel}|${sch.slug}`;
              const st = getEditState(activeRel, sch.slug);
              const r = ruleFor(activeRel, sch.slug);
              return (
                <WorkflowCard key={sch.id}
                  sch={sch} st={st} rule={r} mkey={msg[k]} busy={!!busy[k]}
                  activeRel={activeRel} locale={locale} t={t} auth={auth} community={community}
                  advanced={advanced}
                  parseOffsets={parseOffsets} fmtDate={fmtDate}
                  SYSTEM_DEFAULT_OFFSETS={SYSTEM_DEFAULT_OFFSETS} HORIZONS={HORIZONS}
                  setEditState={setEditState}
                  addDoc={addDoc} updateDoc={updateDoc} removeDoc={removeDoc}
                  onSave={() => onSave(activeRel, sch.slug)}
                  onReset={() => onReset(activeRel, sch.slug)}
                  onPreviewEmail={() => {
                    const { offsets, usingDefault } = parseOffsets(st.offsetsInput);
                    const effective = usingDefault ? SYSTEM_DEFAULT_OFFSETS : offsets;
                    setPreview({
                      extraDocs: Array.isArray(st.docs) ? st.docs : [],
                      offsetDays: effective[0] || 14,
                    });
                  }}
                  onTestSend={() => r && setTestSend({ ruleId: r.id, name: pickI18n(sch.name_i18n, locale).value || sch.slug })}
                  onHistory={() => r && setHistoryFor({ ruleId: r.id, name: pickI18n(sch.name_i18n, locale).value || sch.slug })}
                />
              );
            })}
          </div>
        </>
      )}

      <EmailPreviewModal
        open={!!preview}
        onClose={() => setPreview(null)}
        auth={auth}
        communitySlug={community?.id}
        templateKey="reminder"
        lang={locale === 'en' ? 'en' : 'es'}
        override={null}
        extraDocs={preview?.extraDocs || null}
        offsetDays={preview?.offsetDays || 14}
      />

      <AddExistingSchedulePicker
        open={showAddPicker}
        onClose={() => setShowAddPicker(false)}
        schedules={unconfiguredSchedules}
        locale={locale}
        t={t}
        onEnable={async (sch) => {
          // Create an inactive-by-default rule so the schedule shows up on
          // this relationship's page. Owner can then tune offsets / docs.
          try {
            await taxApi.adminUpdateRelationshipWorkflowRule(auth, activeRel, sch.slug, {
              communitySlug: community.id,
              reminderOffsetsDays: [],     // empty → falls back to schedule default
              requiredDocuments: [],
              active: true,
            });
            setShowAddPicker(false);
            load();
          } catch (e) {
            window.alert(e?.message || t('respond.error.generic'));
          }
        }}
      />

      <CreateWorkflowModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        t={t}
        onCreate={async (payload) => {
          try {
            await taxApi.adminCreateFilingSchedule(auth, {
              ...payload,
              communitySlug: community.id,
              relationshipTypeId: activeRel,
            });
            setShowCreateModal(false);
            load();
          } catch (e) {
            window.alert(e?.message || t('respond.error.generic'));
          }
        }}
      />

      <TestSendModal
        open={!!testSend}
        onClose={() => setTestSend(null)}
        auth={auth}
        ruleId={testSend?.ruleId}
        workflowName={testSend?.name}
        defaultEmail={fbUser?.email || ''}
        t={t}
      />

      <TemplateLibraryModal
        open={showTemplateLibrary}
        onClose={() => setShowTemplateLibrary(false)}
        auth={auth}
        relationshipTypeId={activeRel}
        communitySlug={community?.id}
        locale={locale}
        t={t}
        onCloned={() => { setShowTemplateLibrary(false); load(); }}
      />

      <WorkflowHistoryModal
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        auth={auth}
        ruleId={historyFor?.ruleId}
        workflowName={historyFor?.name}
        locale={locale}
        t={t}
      />
    </EmployeeShell>
  );
}

// Phase 4n.22: tabbed workflow editor. Owner sees one card per workflow
// configured for the active relationship. Collapsed = one-line summary.
// Expanded = five tabs that mirror the lifecycle: Service, Schedule,
// Form, Reminders, and the customer Journey. Existing handlers (save,
// reset, preview, test, history) are surfaced as a single action row
// at the bottom of every tab so the owner never has to scroll to find
// "Save".
function WorkflowCard({
  sch, st, rule, mkey, busy,
  activeRel, locale, t, auth, community, advanced,
  parseOffsets, fmtDate, SYSTEM_DEFAULT_OFFSETS, HORIZONS,
  setEditState, addDoc, updateDoc, removeDoc,
  onSave, onReset, onPreviewEmail, onTestSend, onHistory,
}) {
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState('schedule');
  // If the active tab is one that's hidden by the basic view, fall back
  // to Schedule so the panel stays in sync with the visible tab bar.
  useEffect(() => {
    if (!advanced && !['schedule', 'reminders'].includes(tab)) setTab('schedule');
  }, [advanced, tab]);
  const isOverride = !!rule;
  const name = pickI18n(sch.name_i18n, locale).value || sch.slug;
  const description = pickI18n(sch.description_i18n, locale).value || '';

  const { offsets: rawOffsets, usingDefault } = parseOffsets(st.offsetsInput);
  const effectiveOffsets = usingDefault ? SYSTEM_DEFAULT_OFFSETS : rawOffsets;
  const today = todayIsoUtc();
  const periods = generatePeriods(sch.anchor_rule, today, 8);

  // Basic view = email reminders only. Service / Form / Journey are
  // power-user tabs hidden until the Advanced toggle on the page header
  // flips on.
  const ALL_TABS = [
    { key: 'service',   label: t('owner.workflows.tab.service'),   advanced: true },
    { key: 'schedule',  label: t('owner.workflows.tab.schedule'),  advanced: false },
    { key: 'form',      label: t('owner.workflows.tab.form'),      advanced: true,
      badge: st.docs.length || null },
    { key: 'reminders', label: t('owner.workflows.tab.reminders'), advanced: false,
      badge: effectiveOffsets.length || null },
    { key: 'journey',   label: t('owner.workflows.tab.journey'),   advanced: true },
  ];
  const tabs = ALL_TABS.filter(tt => advanced || !tt.advanced);

  return (
    <section style={{
      border: '1px solid var(--tax-border)', borderRadius: 10,
      background: 'var(--tax-bg)', overflow: 'hidden',
    }}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, padding: '12px 16px', cursor: 'pointer',
        background: expanded ? 'var(--tax-bg-alt)' : '#fff',
        borderBottom: expanded ? '1px solid var(--tax-border)' : 'none',
      }} onClick={() => setExpanded(v => !v)}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15 }}>{name}</strong>
            <span style={{
              padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: 'var(--tax-bg-alt)', color: 'var(--tax-muted)',
              textTransform: 'uppercase', letterSpacing: '.04em',
            }}>{sch.cadence}</span>
            <span style={{
              padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
              background: isOverride ? 'var(--tax-brand-primary)' : 'var(--tax-bg-alt)',
              color: isOverride ? '#fff' : 'var(--tax-muted)',
            }}>
              {isOverride ? t('owner.workflows.statusOverride') : t('owner.workflows.statusDefault')}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
            <code>{sch.slug}</code>
            {' · '}{t('owner.workflows.cardSummary', {
              offsets: effectiveOffsets.join(', ') || '—',
              docs: st.docs.length,
            })}
          </div>
        </div>
        <span aria-hidden="true" style={{
          fontSize: 14, color: 'var(--tax-muted)',
          transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
          transition: 'transform .12s ease',
        }}>▾</span>
      </header>

      {expanded && (
        <>
          {/* ── Tab bar ──────────────────────────────────────────── */}
          <nav role="tablist" style={{
            display: 'flex', gap: 4, padding: '8px 12px',
            borderBottom: '1px solid var(--tax-border)',
            background: '#fff', overflowX: 'auto',
          }}>
            {tabs.map(t1 => {
              const isActive = tab === t1.key;
              return (
                <button key={t1.key} type="button" role="tab" aria-selected={isActive}
                        onClick={() => setTab(t1.key)}
                        style={{
                          padding: '6px 12px', borderRadius: 6,
                          border: '1px solid transparent', cursor: 'pointer',
                          background: isActive ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : 'transparent',
                          color: isActive ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                          fontWeight: isActive ? 700 : 500,
                          fontSize: 13, whiteSpace: 'nowrap',
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                        }}>
                  {t1.label}
                  {t1.badge != null && (
                    <span style={{
                      minWidth: 18, padding: '0 6px', borderRadius: 999, fontSize: 11,
                      background: isActive ? 'var(--tax-brand-primary)' : 'var(--tax-bg-alt)',
                      color: isActive ? '#fff' : 'var(--tax-muted)',
                      textAlign: 'center',
                    }}>{t1.badge}</span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* ── Tab content ──────────────────────────────────────── */}
          <div style={{ padding: 16 }}>
            {tab === 'service' && (
              <ServiceTab sch={sch} name={name} description={description} t={t} />
            )}
            {tab === 'schedule' && (
              <ScheduleTab sch={sch} periods={periods} fmtDate={fmtDate} t={t} />
            )}
            {tab === 'form' && (
              <FormTab st={st} addDoc={() => addDoc(activeRel, sch.slug)}
                       updateDoc={(i, patch) => updateDoc(activeRel, sch.slug, i, patch)}
                       removeDoc={i => removeDoc(activeRel, sch.slug, i)}
                       auth={auth} locale={locale} t={t} />
            )}
            {tab === 'reminders' && (
              <RemindersTab st={st} sch={sch} activeRel={activeRel}
                            effectiveOffsets={effectiveOffsets}
                            usingDefault={usingDefault} periods={periods}
                            SYSTEM_DEFAULT_OFFSETS={SYSTEM_DEFAULT_OFFSETS}
                            HORIZONS={HORIZONS}
                            setEditState={setEditState}
                            fmtDate={fmtDate} today={today} t={t}
                            onPreviewEmail={onPreviewEmail} />
            )}
            {tab === 'journey' && (
              <JourneyTab effectiveOffsets={effectiveOffsets}
                          periods={periods} docs={st.docs}
                          fmtDate={fmtDate} t={t} />
            )}

            {mkey?.text && (
              <div className={`tax-msg tax-msg--${mkey.kind === 'error' ? 'error' : 'success'}`}
                   style={{ marginTop: 12 }}>{mkey.text}</div>
            )}

            {rule && (
              <div style={{ marginTop: 12 }}>
                <EngagementBar ruleId={rule.id} auth={auth} t={t} />
              </div>
            )}

            {/* ── Persistent action row ─────────────────────────── */}
            <div style={{
              display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap',
              borderTop: '1px solid var(--tax-border)', paddingTop: 12,
            }}>
              <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                      disabled={busy} onClick={onSave}>
                {busy ? t('lead.submitting') : t('owner.workflows.saveBtn')}
              </button>
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                      onClick={onPreviewEmail}>
                {t('owner.workflows.previewEmailBtn')}
              </button>
              {rule && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={onTestSend}>
                  {t('owner.workflows.sendTestBtn')}
                </button>
              )}
              {rule && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={onHistory}>
                  {t('owner.workflows.historyBtn')}
                </button>
              )}
              {isOverride && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        disabled={busy} onClick={onReset}
                        style={{ marginLeft: 'auto', color: '#b91c1c', borderColor: '#b91c1c' }}>
                  {t('owner.workflows.resetBtn')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ── Tab: Service — read-only descriptor of what this workflow IS. ───────
function ServiceTab({ sch, name, description, t }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Row label={t('owner.workflows.tabService.name')} value={name} />
      {description && (
        <Row label={t('owner.workflows.tabService.description')} value={description} />
      )}
      <Row label={t('owner.workflows.tabService.slug')} value={<code>{sch.slug}</code>} />
      <Row label={t('owner.workflows.tabService.cadence')} value={sch.cadence} />
      {sch.jurisdiction && (
        <Row label={t('owner.workflows.tabService.jurisdiction')} value={sch.jurisdiction} />
      )}
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
        {t('owner.workflows.tabService.note')}
      </p>
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'baseline' }}>
      <div style={{ fontSize: 12, color: 'var(--tax-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 14 }}>{value}</div>
    </div>
  );
}

// ── Tab: Schedule — when this workflow's filings are actually due. ──────
function ScheduleTab({ sch, periods, fmtDate, t }) {
  return (
    <div>
      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('owner.workflows.tabSchedule.intro', { cadence: sch.cadence })}
      </p>
      {periods.length === 0 ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.previewUnsupported')}</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          {periods.slice(0, 6).map((p, i) => (
            <li key={p.dueDate} style={{
              display: 'grid', gridTemplateColumns: '36px 1fr', gap: 10, alignItems: 'center',
              padding: '8px 12px', border: '1px solid var(--tax-border)', borderRadius: 8,
              background: i === 0 ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#fff',
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 6, display: 'grid', placeItems: 'center',
                background: 'var(--tax-bg-alt)', color: 'var(--tax-brand-primary)', fontWeight: 700,
              }}>{i + 1}</div>
              <div>
                <div style={{ fontWeight: 600 }}>{p.periodLabel || sch.cadence}</div>
                <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                  {t('owner.workflows.tabSchedule.dueOn', { date: fmtDate(p.dueDate) })}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Tab: Form — checklist editor (left) + live customer form preview (right). ──
function FormTab({ st, addDoc, updateDoc, removeDoc, auth, locale, t }) {
  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('owner.workflows.docsLabel')}</span>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addDoc}>
            + {t('owner.workflows.addDoc')}
          </button>
        </div>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.workflows.docsHint')}
        </p>
        {st.docs.length === 0 && (
          <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>{t('owner.workflows.docsEmpty')}</p>
        )}
        <div style={{ display: 'grid', gap: 8 }}>
          {st.docs.map((d, i) => (
            <div key={i} style={{
              display: 'grid', gap: 6, padding: 8,
              gridTemplateColumns: '1fr 1fr',
              border: '1px dashed var(--tax-border)', borderRadius: 6,
            }}>
              <input type="text" value={d.key} placeholder={t('owner.workflows.docKey')}
                     onChange={e => updateDoc(i, { key: e.target.value })} />
              <select value={d.type || 'text'} onChange={e => updateDoc(i, { type: e.target.value })}>
                {DOC_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              <input type="text" value={d.label_i18n?.en || ''} placeholder={t('owner.workflows.docLabelEn')}
                     onChange={e => updateDoc(i, { label_i18n: { ...(d.label_i18n || {}), en: e.target.value } })} />
              <input type="text" value={d.label_i18n?.es || ''} placeholder={t('owner.workflows.docLabelEs')}
                     onChange={e => updateDoc(i, { label_i18n: { ...(d.label_i18n || {}), es: e.target.value } })} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={d.required !== false}
                       onChange={e => updateDoc(i, { required: e.target.checked })} />
                {t('owner.workflows.docRequired')}
              </label>
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                      onClick={() => removeDoc(i)}>×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Live preview — the same <ChecklistField> the customer sees. */}
      <div style={{
        background: 'var(--tax-bg-alt)', borderRadius: 8, padding: 12,
        border: '1px solid var(--tax-border)', minHeight: 200,
      }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em',
                      color: 'var(--tax-muted)', fontWeight: 700, marginBottom: 8 }}>
          {t('owner.workflows.tabForm.previewLabel')}
        </div>
        {st.docs.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--tax-muted)' }}>
            {t('owner.workflows.tabForm.previewEmpty')}
          </p>
        ) : (
          <div className="tax-form" style={{ background: '#fff', padding: 12, borderRadius: 6 }}>
            {st.docs.filter(d => d.key).map(d => (
              <ChecklistField key={d.key} item={d} fieldIdPrefix={`prv-${d.key}`}
                              value="" onChange={() => {}}
                              auth={auth} supportsFileUpload={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: Reminders — when emails fire + horizon previews. ────────────────
function RemindersTab({
  st, activeRel, sch, effectiveOffsets, usingDefault, periods,
  SYSTEM_DEFAULT_OFFSETS, HORIZONS, setEditState, fmtDate, today, t, onPreviewEmail,
}) {
  const k = `${activeRel}|${sch.slug}`;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <label htmlFor={`off-${k}`} style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
          {t('owner.workflows.offsetsLabel')}
        </label>
        <input id={`off-${k}`} type="text" value={st.offsetsInput}
               placeholder="14, 7, 2"
               onChange={e => setEditState(activeRel, sch.slug, { offsetsInput: e.target.value })}
               style={{ width: 220 }} />
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
          {t('owner.workflows.offsetsHint')}
        </p>
      </div>

      <div style={{
        padding: 12, borderRadius: 8,
        background: 'var(--tax-bg-alt)', border: '1px solid var(--tax-border)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          {t('owner.workflows.previewTitle')}
        </div>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--tax-muted)' }}>
          {usingDefault
            ? t('owner.workflows.previewUsingDefault', { offsets: SYSTEM_DEFAULT_OFFSETS.join(', ') })
            : t('owner.workflows.previewUsingCustom', { offsets: effectiveOffsets.join(', ') })}
          {' · '}{t('owner.workflows.previewToday', { date: fmtDate(today) })}
        </p>
        {!periods.length && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.workflows.previewUnsupported')}
          </p>
        )}
        {periods.length > 0 && !effectiveOffsets.length && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.workflows.previewNoOffsets')}
          </p>
        )}
        {periods.length > 0 && effectiveOffsets.length > 0 && (
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            {HORIZONS.map(days => {
              const fires = upcomingReminderFires(periods, effectiveOffsets, today, days);
              return (
                <div key={days} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ color: 'var(--tax-text)' }}>
                    {t('owner.workflows.previewHorizon', { days })}
                  </strong>
                  <span style={{ color: fires.length ? 'var(--tax-text)' : 'var(--tax-muted)' }}>
                    {fires.length
                      ? fires.map(f =>
                          `${fmtDate(f.dateIso)} (T-${f.offset}d, ${t('owner.workflows.previewDueShort')} ${fmtDate(f.dueDate)})`
                        ).join(' · ')
                      : t('owner.workflows.previewNone')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--tax-muted)' }}>
          {t('owner.workflows.tabReminders.emailHint')}
        </p>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onPreviewEmail}>
          {t('owner.workflows.previewEmailBtn')}
        </button>
      </div>
    </div>
  );
}

// ── Tab: Journey — chronological strip showing what the customer experiences. ──
function JourneyTab({ effectiveOffsets, periods, docs, fmtDate, t }) {
  const sortedOffsets = [...effectiveOffsets].sort((a, b) => b - a);
  const firstDue = periods[0]?.dueDate;
  // Steps are displayed chronologically in the customer's perspective.
  const steps = [
    {
      key: 'enroll',
      label: t('owner.workflows.tabJourney.enroll.label'),
      detail: t('owner.workflows.tabJourney.enroll.detail'),
      tone: 'muted',
    },
    ...sortedOffsets.map((o, i) => ({
      key: `rem-${o}-${i}`,
      label: t('owner.workflows.tabJourney.reminder.label', { days: o }),
      detail: firstDue
        ? t('owner.workflows.tabJourney.reminder.detail', {
            date: fmtDate(reminderFireDateFor(firstDue, o)),
            count: i + 1,
          })
        : t('owner.workflows.tabJourney.reminder.noPeriod'),
      tone: 'warn',
    })),
    {
      key: 'due',
      label: t('owner.workflows.tabJourney.due.label'),
      detail: firstDue ? fmtDate(firstDue) : t('owner.workflows.tabJourney.due.noPeriod'),
      tone: 'danger',
    },
    {
      key: 'fillForm',
      label: t('owner.workflows.tabJourney.fillForm.label'),
      detail: t('owner.workflows.tabJourney.fillForm.detail', { count: docs.length }),
      tone: 'info',
    },
    {
      key: 'submitted',
      label: t('owner.workflows.tabJourney.submitted.label'),
      detail: t('owner.workflows.tabJourney.submitted.detail'),
      tone: 'ok',
    },
  ];
  const toneBg = {
    muted: 'var(--tax-bg-alt)', warn: '#fef3c7', danger: '#fee2e2',
    info: '#dbeafe', ok: '#dcfce7',
  };
  const toneText = {
    muted: 'var(--tax-muted)', warn: '#854d0e', danger: '#b91c1c',
    info: '#1e40af', ok: '#166534',
  };
  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--tax-muted)' }}>
        {t('owner.workflows.tabJourney.intro')}
      </p>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
        {steps.map((s, idx) => (
          <div key={s.key} style={{
            flex: '0 0 auto', minWidth: 160, maxWidth: 220,
            padding: '10px 12px', borderRadius: 8,
            background: toneBg[s.tone], color: toneText[s.tone],
            border: '1px solid color-mix(in srgb, ' + toneText[s.tone] + ' 25%, transparent)',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              {t('owner.workflows.tabJourney.step', { n: idx + 1 })}
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--tax-text)' }}>{s.label}</div>
            <div style={{ fontSize: 12 }}>{s.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Phase 4n.26: single choice card on the empty-state hero. `recommended`
// gives the primary card a brand-tinted border + "Recommended" pill so a
// new owner has an obvious starting point instead of having to think
// about which of three buttons to click.
function EmptyChoiceCard({ icon, title, body, cta, onClick, recommended }) {
  return (
    <button type="button" onClick={onClick}
            style={{
              textAlign: 'left', display: 'flex', flexDirection: 'column',
              gap: 8, padding: 16, borderRadius: 10, cursor: 'pointer',
              background: '#fff',
              border: `1px solid ${recommended ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`,
              boxShadow: recommended ? '0 1px 0 var(--tax-brand-primary)' : 'none',
            }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 22 }} aria-hidden="true">{icon}</span>
        {recommended && (
          <span style={{
            padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
            background: 'var(--tax-brand-primary)', color: '#fff',
            textTransform: 'uppercase', letterSpacing: '.04em',
          }}>Recommended</span>
        )}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--tax-muted)', lineHeight: 1.4 }}>{body}</div>
      <div style={{
        marginTop: 'auto', paddingTop: 4,
        fontSize: 13, fontWeight: 600,
        color: recommended ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
      }}>
        {cta} →
      </div>
    </button>
  );
}

function reminderFireDateFor(dueIso, daysBefore) {
  try {
    const d = new Date(dueIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - Math.abs(daysBefore));
    return d.toISOString().slice(0, 10);
  } catch (_e) { return dueIso; }
}

// Phase 4n.10: catalog browser. Lists hard-coded templates grouped by
// category (federal / state / business). One-click clone creates the
// underlying tax_filing_schedules row, auto-binds a rule to the current
// relationship, and refreshes the page.
function TemplateLibraryModal({ open, onClose, auth, relationshipTypeId, communitySlug, locale, t, onCloned }) {
  const [templates, setTemplates] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr(''); setTemplates(null);
    taxApi.adminListWorkflowTemplates(auth)
      .then(d => setTemplates(d.templates || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const byCategory = (templates || []).reduce((acc, tpl) => {
    const k = tpl.category || 'other';
    if (!acc[k]) acc[k] = [];
    acc[k].push(tpl);
    return acc;
  }, {});

  async function clone(tpl) {
    if (!relationshipTypeId) {
      setErr(t('owner.workflows.templates.errNoRel'));
      return;
    }
    setBusyId(tpl.id); setErr('');
    try {
      await taxApi.adminCloneWorkflowTemplate(auth, tpl.id, {
        communitySlug, relationshipTypeId,
      });
      onCloned();
    } catch (e) {
      setErr(e?.message || t('respond.error.generic'));
    } finally { setBusyId(''); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
      zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: 16, overflow: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--tax-bg)', borderRadius: 12, maxWidth: 720, width: '100%',
        margin: '40px 0', border: '1px solid var(--tax-border)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tax-border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('owner.workflows.templates.title')}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
            {t('preview.close')}
          </button>
        </div>
        <div style={{ padding: 18 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--tax-muted)' }}>
            {t('owner.workflows.templates.note')}
          </p>
          {err && <div className="tax-msg tax-msg--error" style={{ marginBottom: 12 }}>{err}</div>}
          {templates === null && <p>{t('loading')}</p>}
          {Object.entries(byCategory).map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 18 }}>
              <h4 style={{
                fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em',
                color: 'var(--tax-muted)', margin: '0 0 8px',
              }}>{t(`owner.workflows.templates.cat.${cat}`)}</h4>
              <div style={{ display: 'grid', gap: 8 }}>
                {list.map(tpl => (
                  <div key={tpl.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between',
                    padding: 12, border: '1px solid var(--tax-border)', borderRadius: 8,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{pickI18n(tpl.name_i18n, locale).value}</div>
                      <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
                        {pickI18n(tpl.description_i18n, locale).value}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 6 }}>
                        {tpl.cadence} · {tpl.info_checklist.length} {t('owner.workflows.templates.fields')} ·{' '}
                        {t('owner.workflows.templates.offsets', { offsets: (tpl.suggested_offsets || []).join(', ') })}
                      </div>
                    </div>
                    <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                            disabled={busyId === tpl.id || !relationshipTypeId}
                            onClick={() => clone(tpl)}>
                      {busyId === tpl.id ? t('lead.submitting') : t('owner.workflows.templates.useBtn')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Phase 4n.10: per-workflow audit history. Renders the 20 most recent
// audit_logs entries for this workflow with a compact before→after diff
// per change (only fields that actually moved).
function WorkflowHistoryModal({ open, onClose, auth, ruleId, workflowName, locale, t }) {
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || !ruleId) return;
    setEvents(null); setErr('');
    taxApi.adminGetWorkflowAudit(auth, ruleId, 20)
      .then(d => setEvents(d.events || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  }, [open, ruleId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
        { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .format(new Date(iso));
    } catch (_e) { return iso; }
  }

  function diff(before, after) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    const changes = [];
    for (const k of keys) {
      const b = before ? before[k] : undefined;
      const a = after ? after[k] : undefined;
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      changes.push({ key: k, before: b, after: a });
    }
    return changes;
  }

  function fmtValue(v) {
    if (v === undefined || v === null) return '∅';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return v.length <= 6 ? JSON.stringify(v) : `[${v.length} items]`;
    }
    if (typeof v === 'object') {
      const json = JSON.stringify(v);
      return json.length <= 80 ? json : `${json.slice(0, 77)}…`;
    }
    return String(v);
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
      zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: 16, overflow: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--tax-bg)', borderRadius: 12, maxWidth: 720, width: '100%',
        margin: '40px 0', border: '1px solid var(--tax-border)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tax-border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('owner.workflows.history.title', { name: workflowName || '' })}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
            {t('preview.close')}
          </button>
        </div>
        <div style={{ padding: 18 }}>
          {err && <div className="tax-msg tax-msg--error">{err}</div>}
          {events === null && <p>{t('loading')}</p>}
          {events && events.length === 0 && (
            <p style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.history.empty')}</p>
          )}
          {events && events.length > 0 && (
            <div style={{ display: 'grid', gap: 12 }}>
              {events.map(ev => {
                const changes = diff(ev.before_data, ev.after_data);
                return (
                  <div key={ev.id} style={{
                    padding: 10, border: '1px solid var(--tax-border)', borderRadius: 8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{t(`owner.workflows.history.action.${ev.action}`)}</strong>
                      <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                        {fmtTime(ev.created_at)}
                        {ev.actor_email ? ` · ${ev.actor_email}` : ''}
                      </span>
                    </div>
                    {changes.length === 0 ? (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
                        {t('owner.workflows.history.noChanges')}
                      </p>
                    ) : (
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
                        {changes.map(c => (
                          <li key={c.key} style={{ marginBottom: 2 }}>
                            <code style={{ background: 'var(--tax-bg-alt)', padding: '0 4px', borderRadius: 3 }}>{c.key}</code>
                            {': '}
                            <span style={{ color: 'var(--tax-muted)', textDecoration: 'line-through' }}>{fmtValue(c.before)}</span>
                            {' → '}
                            <span style={{ color: 'var(--tax-text)' }}>{fmtValue(c.after)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 4n.9: tiny engagement strip rendered inside each workflow card.
// Fetches the 90-day window aggregate from the server. Stays compact —
// owners scan it; clicking on a workflow elsewhere drills in.
function EngagementBar({ ruleId, auth, t }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    taxApi.adminGetWorkflowEngagement(auth, ruleId, 90)
      .then(d => { if (!cancelled) setData(d.summary); })
      .catch(() => { /* silent — engagement is a nice-to-have, not blocking */ });
    return () => { cancelled = true; };
  }, [ruleId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  if (data.sent === 0) {
    return (
      <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
        {t('owner.workflows.engagement.none')}
      </p>
    );
  }
  const pct = (n) => Math.round((n / data.sent) * 100);
  return (
    <div style={{
      margin: '12px 0 0', padding: '8px 10px', borderRadius: 6,
      background: 'var(--tax-bg-alt)', border: '1px solid var(--tax-border)',
      display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline', fontSize: 12,
    }}>
      <strong style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.engagement.label')}</strong>
      <span>{t('owner.workflows.engagement.sent', { count: data.sent })}</span>
      <span style={{ color: data.opened ? 'var(--tax-success)' : 'var(--tax-muted)' }}>
        {t('owner.workflows.engagement.opened', { count: data.opened, pct: pct(data.opened) })}
      </span>
      <span style={{ color: data.clicked ? 'var(--tax-success)' : 'var(--tax-muted)' }}>
        {t('owner.workflows.engagement.clicked', { count: data.clicked, pct: pct(data.clicked) })}
      </span>
      <span style={{ color: 'var(--tax-muted)' }}>
        {t('owner.workflows.engagement.unique', { count: data.uniqueCustomers })}
      </span>
    </div>
  );
}

function TestSendModal({ open, onClose, auth, ruleId, workflowName, defaultEmail, t }) {
  const [email, setEmail] = useState(defaultEmail || '');
  const [lang, setLang] = useState('en');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  useEffect(() => { if (open) { setEmail(defaultEmail || ''); setMsg({ kind: 'idle', text: '' }); } },
    [open, defaultEmail]);
  if (!open) return null;

  async function send() {
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const result = await taxApi.adminSendWorkflowTestReminder(auth, ruleId, {
        toEmail: email, lang,
      });
      if (result.skipped) {
        setMsg({ kind: 'error', text: t('owner.workflows.testSend.skipped', { reason: result.reason || '' }) });
      } else {
        setMsg({ kind: 'success', text: t('owner.workflows.testSend.sent', { email }) });
      }
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--tax-bg)', borderRadius: 12, maxWidth: 480, width: '100%',
        border: '1px solid var(--tax-border)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tax-border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('owner.workflows.testSend.title', { name: workflowName || '' })}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
            {t('preview.close')}
          </button>
        </div>
        <div style={{ padding: 18, display: 'grid', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--tax-muted)' }}>
            {t('owner.workflows.testSend.note')}
          </p>
          <div>
            <label htmlFor="ts-email" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
              {t('owner.workflows.testSend.toEmail')}
            </label>
            <input id="ts-email" type="email" value={email}
                   onChange={e => setEmail(e.target.value)} style={{ width: '100%' }} />
          </div>
          <div>
            <label htmlFor="ts-lang" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
              {t('owner.workflows.testSend.lang')}
            </label>
            <select id="ts-lang" value={lang} onChange={e => setLang(e.target.value)}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </div>
          {msg.text && (
            <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}>{msg.text}</div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
              {t('preview.close')}
            </button>
            <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                    disabled={busy || !email} onClick={send}>
              {busy ? t('lead.submitting') : t('owner.workflows.testSend.send')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Phase 4n.3: simple list picker — shows community schedules the active
// relationship hasn't enabled yet. Click one to create a default rule.
function AddExistingSchedulePicker({ open, onClose, schedules, locale, t, onEnable }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--tax-bg)', borderRadius: 12, maxWidth: 560, width: '100%',
        maxHeight: '85vh', overflow: 'auto', border: '1px solid var(--tax-border)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tax-border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('owner.workflows.addExistingTitle')}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
            {t('preview.close')}
          </button>
        </div>
        <div style={{ padding: 18 }}>
          {schedules.length === 0 ? (
            <p style={{ color: 'var(--tax-muted)' }}>{t('owner.workflows.addExistingEmpty')}</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {schedules.map(sch => (
                <li key={sch.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 12, padding: 10, border: '1px solid var(--tax-border)', borderRadius: 8,
                }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{pickI18n(sch.name_i18n, locale).value || sch.slug}</div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
                      <code>{sch.slug}</code> · {sch.cadence}
                    </div>
                  </div>
                  <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                          onClick={() => onEnable(sch)}>
                    {t('owner.workflows.enableBtn')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 4n.3: full create-workflow form. Owner picks cadence (weekly /
// monthly / quarterly / annual), an optional day override (default = end
// of period), reminder offsets, and required docs. Saves a new
// tax_filing_schedule and auto-binds it to the active relationship.
function CreateWorkflowModal({ open, onClose, t, onCreate }) {
  const [form, setForm] = useState(initialFormState);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  function initialFormState() {
    return {
      cadence: 'monthly',
      nameEn: '', nameEs: '',
      descriptionEn: '', descriptionEs: '',
      dayOfMonth: '',     // empty → server defaults (28 monthly, 15 quarterly)
      dayOfWeek: '5',     // Friday default for weekly
      date: '12-31',      // annual default
      jurisdiction: 'federal',
      offsetsInput: '14, 7, 3',
      docs: [],
    };
  }
  // Reset form whenever the modal opens.
  useEffect(() => { if (open) { setForm(initialFormState()); setErr(''); } }, [open]);

  if (!open) return null;

  const addDoc = () => setForm(p => ({
    ...p,
    docs: [...p.docs, { key: '', label_i18n: { en: '', es: '' }, type: 'text', required: true }],
  }));
  const updateDoc = (i, patch) => setForm(p => ({
    ...p,
    docs: p.docs.map((d, idx) => idx === i ? { ...d, ...patch } : d),
  }));
  const removeDoc = (i) => setForm(p => ({ ...p, docs: p.docs.filter((_, idx) => idx !== i) }));

  async function submit() {
    setErr('');
    if (!form.nameEn && !form.nameEs) { setErr(t('owner.workflows.create.errName')); return; }
    const offsets = String(form.offsetsInput || '')
      .split(/[\s,;]+/).map(s => parseInt(s, 10))
      .filter(n => Number.isFinite(n) && n >= 0 && n <= 365);
    const payload = {
      cadence: form.cadence,
      nameEn: form.nameEn, nameEs: form.nameEs,
      descriptionEn: form.descriptionEn, descriptionEs: form.descriptionEs,
      jurisdiction: form.jurisdiction || 'federal',
      reminderOffsetsDays: offsets,
      extraDocs: [], // doc set lives in the schedule's info_checklist below
      infoChecklist: form.docs,
    };
    if (form.cadence === 'weekly') payload.dayOfWeek = parseInt(form.dayOfWeek, 10);
    else if (form.cadence === 'monthly') {
      if (form.dayOfMonth) payload.dayOfMonth = parseInt(form.dayOfMonth, 10);
    } else if (form.cadence === 'quarterly') {
      if (form.dayOfMonth) payload.dayOfMonth = parseInt(form.dayOfMonth, 10);
    } else if (form.cadence === 'annual') {
      payload.date = form.date || '12-31';
    }
    setBusy(true);
    try {
      await onCreate(payload);
    } catch (e) { setErr(e?.message || t('respond.error.generic')); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
      zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16,
      overflow: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--tax-bg)', borderRadius: 12, maxWidth: 720, width: '100%',
        margin: '40px 0', border: '1px solid var(--tax-border)',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--tax-border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('owner.workflows.create.title')}</strong>
          <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
            {t('preview.close')}
          </button>
        </div>
        <div style={{ padding: 18, display: 'grid', gap: 12 }}>
          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label htmlFor="cw-name-en" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                {t('owner.workflows.create.nameEn')}
              </label>
              <input id="cw-name-en" type="text" value={form.nameEn}
                     onChange={e => setForm(p => ({ ...p, nameEn: e.target.value }))}
                     style={{ width: '100%' }} maxLength={200} />
            </div>
            <div>
              <label htmlFor="cw-name-es" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                {t('owner.workflows.create.nameEs')}
              </label>
              <input id="cw-name-es" type="text" value={form.nameEs}
                     onChange={e => setForm(p => ({ ...p, nameEs: e.target.value }))}
                     style={{ width: '100%' }} maxLength={200} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 12, alignItems: 'end' }}>
            <div>
              <label htmlFor="cw-cadence" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                {t('owner.workflows.create.cadence')}
              </label>
              <select id="cw-cadence" value={form.cadence}
                      onChange={e => setForm(p => ({ ...p, cadence: e.target.value }))}>
                <option value="weekly">{t('owner.workflows.create.cadence.weekly')}</option>
                <option value="monthly">{t('owner.workflows.create.cadence.monthly')}</option>
                <option value="quarterly">{t('owner.workflows.create.cadence.quarterly')}</option>
                <option value="annual">{t('owner.workflows.create.cadence.annual')}</option>
              </select>
            </div>
            <div>
              {form.cadence === 'weekly' && (
                <>
                  <label htmlFor="cw-dow" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                    {t('owner.workflows.create.dayOfWeek')}
                  </label>
                  <select id="cw-dow" value={form.dayOfWeek}
                          onChange={e => setForm(p => ({ ...p, dayOfWeek: e.target.value }))}>
                    <option value="1">{t('owner.workflows.create.dow.mon')}</option>
                    <option value="2">{t('owner.workflows.create.dow.tue')}</option>
                    <option value="3">{t('owner.workflows.create.dow.wed')}</option>
                    <option value="4">{t('owner.workflows.create.dow.thu')}</option>
                    <option value="5">{t('owner.workflows.create.dow.fri')}</option>
                    <option value="6">{t('owner.workflows.create.dow.sat')}</option>
                    <option value="7">{t('owner.workflows.create.dow.sun')}</option>
                  </select>
                </>
              )}
              {(form.cadence === 'monthly' || form.cadence === 'quarterly') && (
                <>
                  <label htmlFor="cw-dom" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                    {t('owner.workflows.create.dayOfMonth')}
                  </label>
                  <input id="cw-dom" type="number" min={1} max={28}
                         value={form.dayOfMonth}
                         placeholder={form.cadence === 'monthly' ? '20' : '15'}
                         onChange={e => setForm(p => ({ ...p, dayOfMonth: e.target.value }))}
                         style={{ width: 120 }} />
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
                    {t('owner.workflows.create.dayOfMonthHint')}
                  </p>
                </>
              )}
              {form.cadence === 'annual' && (
                <>
                  <label htmlFor="cw-date" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                    {t('owner.workflows.create.annualDate')}
                  </label>
                  <input id="cw-date" type="text" placeholder="MM-DD"
                         value={form.date} pattern="^\d{1,2}-\d{1,2}$"
                         onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                         style={{ width: 120 }} />
                </>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="cw-offsets" style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
              {t('owner.workflows.create.offsets')}
            </label>
            <input id="cw-offsets" type="text" value={form.offsetsInput}
                   placeholder="14, 7, 3"
                   onChange={e => setForm(p => ({ ...p, offsetsInput: e.target.value }))}
                   style={{ width: 220 }} />
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('owner.workflows.create.offsetsHint')}
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('owner.workflows.create.docsLabel')}</span>
              <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={addDoc}>
                + {t('owner.workflows.addDoc')}
              </button>
            </div>
            {form.docs.length === 0 && (
              <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '4px 0 0' }}>
                {t('owner.workflows.docsEmpty')}
              </p>
            )}
            {form.docs.map((d, i) => (
              <div key={i} style={{
                display: 'grid', gap: 8, padding: 8, marginTop: 8,
                gridTemplateColumns: '1fr 1fr 1fr 110px 60px 32px',
                alignItems: 'center', border: '1px dashed var(--tax-border)', borderRadius: 6,
              }}>
                <input type="text" value={d.key} placeholder={t('owner.workflows.docKey')}
                       onChange={e => updateDoc(i, { key: e.target.value })} />
                <input type="text" value={d.label_i18n?.en || ''} placeholder={t('owner.workflows.docLabelEn')}
                       onChange={e => updateDoc(i, { label_i18n: { ...(d.label_i18n || {}), en: e.target.value } })} />
                <input type="text" value={d.label_i18n?.es || ''} placeholder={t('owner.workflows.docLabelEs')}
                       onChange={e => updateDoc(i, { label_i18n: { ...(d.label_i18n || {}), es: e.target.value } })} />
                <select value={d.type || 'text'} onChange={e => updateDoc(i, { type: e.target.value })}>
                  {DOC_TYPES.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input type="checkbox" checked={d.required !== false}
                         onChange={e => updateDoc(i, { required: e.target.checked })} />
                  {t('owner.workflows.docRequired')}
                </label>
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={() => removeDoc(i)} aria-label={t('owner.workflows.removeDoc')}>×</button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" onClick={onClose}>
              {t('preview.close')}
            </button>
            <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                    disabled={busy} onClick={submit}>
              {busy ? t('lead.submitting') : t('owner.workflows.create.saveBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
