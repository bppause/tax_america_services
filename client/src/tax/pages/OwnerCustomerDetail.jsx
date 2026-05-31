import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi, setImpersonation } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import TaskHover from '../components/TaskHover';
import { ensureCompletionNotes } from './OwnerTasks';

import { formatLastSignIn } from '../lib/lastSignIn';
import { displayPersonName } from '../lib/personName';

const CATEGORY_KEY = {
  business: 'portal.profile.category.business',
  individual: 'portal.profile.category.individual',
  general: 'portal.profile.category.general',
  audit: 'portal.profile.category.audit',
};

function CollapsibleSection({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ marginTop: 28 }}>
      <button type="button" onClick={() => setOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none',
                       border: 'none', padding: 0, cursor: 'pointer', width: '100%',
                       textAlign: 'left' }}>
        <span style={{ fontSize: 13, color: 'var(--tax-muted)', width: 14, flexShrink: 0 }}>
          {open ? '▾' : '▸'}
        </span>
        <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </section>
  );
}

// Match the order used by the customer-list filter (OwnerCustomers).
const CATEGORY_ORDER = ['business', 'individual', 'general', 'audit'];

function groupRelationshipsByCategory(types) {
  const buckets = new Map();
  for (const t of types) {
    const c = t.category || 'other';
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(t);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
  }
  const known = CATEGORY_ORDER.filter(c => buckets.has(c));
  const extras = Array.from(buckets.keys())
    .filter(c => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extras].map(c => ({ category: c, types: buckets.get(c) }));
}

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'text/plain',
]);

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch (_e) { return ''; }
}

// Phase 4a owner detail page. Composes one /admin/customers/:id round trip
// for all the read-only data, then per-action mutations via the matching
// /admin/* endpoints. Each section is independently re-fetched on action so
// we don't reload unrelated chunks.
export default function OwnerCustomerDetail({ customerId }) {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  const [data, setData] = useState(null);
  const [types, setTypes] = useState([]);
  const [err, setErr] = useState('');

  const load = () => {
    if (!employee || !community) return;
    taxApi.adminGetCustomer(auth, customerId)
      .then(d => setData(d))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(() => {
    load();
    taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id })
      .then(d => setTypes(d.types || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community, customerId]);

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }
  if (err) return <EmployeeShell community={community} active="customers"><div className="tax-msg tax-msg--error">{err}</div></EmployeeShell>;
  if (!data) return <EmployeeShell community={community} active="customers"><p>{t('loading')}</p></EmployeeShell>;

  const c = data.customer;
  const back = community ? `/tax/${community.id}/employee/customers` : '#';

  return (
    <EmployeeShell community={community} active="customers">
      <a href={back} style={{ fontSize: 14, color: 'var(--tax-muted)' }}>← {t('owner.customer.back')}</a>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, marginBottom: 4 }}>{displayPersonName(c) || c.email}</h2>
          {c.business_name && (c.first_name || c.last_name) && (
            <p style={{ color: 'var(--tax-muted)', margin: '0 0 4px', fontSize: 13 }}>
              {t('owner.customer.contactPerson')}: {[c.first_name, c.last_name].filter(Boolean).join(' ')}
            </p>
          )}
          <p style={{ color: 'var(--tax-muted)', marginTop: 0, fontSize: 13 }}>
            {c.email}{c.phone ? ` • ${c.phone}` : ''}{c.whatsapp ? ` • WhatsApp ${c.whatsapp}` : ''}
            {' • '}{c.locale === 'en' ? 'English' : 'Español'}
            {' • '}{formatLastSignIn(c.last_sign_in_at, locale, t)}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
          <ImpersonateCustomerButton customer={c} auth={auth} community={community} t={t} />
          <SendWelcomeButton customer={c} auth={auth} t={t} />
          <PromoteToStaffButton customer={c} auth={auth} onChanged={load} t={t} />
          <ArchiveCustomerButton customer={c} auth={auth} onChanged={load} t={t} />
        </div>
      </div>

      {c.status === 'archived' && (
        <div className="tax-msg" style={{
          background: 'color-mix(in srgb, #b91c1c 8%, #fff)',
          borderLeft: '3px solid #b91c1c', color: '#7f1d1d',
          padding: '10px 14px', marginTop: 8,
        }}>
          <strong>{t('owner.customer.archivedBanner.title')}</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            {t('owner.customer.archivedBanner.body')}
          </div>
        </div>
      )}

      {/* Phase 4n.41: simplified customer record. Retired sections
          (Workflow Overrides, Reminder Activity, Inbox Threads,
          Filings, Subscription Offsets) live as dead code below but
          no longer render — workflows and customer-facing reminders
          are gone, and tasks replaced filing-periods. The order
          mirrors the new task-first model: Profile → who they are,
          Relationships → which services drive their tasks, Tasks →
          the work itself, Notes → internal commentary, the rest as
          supporting context. */}
      <CollapsibleSection title={t('owner.customer.section.profile')} defaultOpen>
        <ProfileSection customer={c} auth={auth} customerId={customerId} onChange={load} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.section.services')}>
        <ServicesSection community={community} auth={auth} customerId={customerId} locale={locale} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.inquiry.heading')}>
        <ServiceInquirySection customer={c} auth={auth} community={community} locale={locale} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.section.tasks')} defaultOpen>
        <TasksSection auth={auth} customer={c} customerId={customerId} community={community}
                      isAdmin={employee?.role === 'admin'} locale={locale} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.section.notes')}>
        <NotesSection auth={auth} customerId={customerId} locale={locale} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.section.documents')}>
        <DocumentsSection data={data} auth={auth} customerId={customerId} onChange={load} t={t} />
      </CollapsibleSection>

      {community?.tax_customer_portal_enabled && (
        <CollapsibleSection title={t('owner.customer.section.signatures')}>
          <SignatureRequestsSection auth={auth} customerId={customerId} locale={locale} t={t} />
        </CollapsibleSection>
      )}

      <CollapsibleSection title={t('owner.customer.section.assignments')}>
        <AssignmentsSection data={data} t={t} />
      </CollapsibleSection>

      <CollapsibleSection title={t('owner.customer.section.threads')}>
        <ActivityTimelineSection auth={auth} customerId={customerId} locale={locale} t={t} />
      </CollapsibleSection>
    </EmployeeShell>
  );
}

// Phase 4n.8: per-customer workflow override editor. Lists every workflow
// active for this customer (resolved through their relationships) and
// shows whether an override row exists. Click "Customize" → modal with a
// checklist editor and optional reminder offsets; Save upserts the row.
// Reset deletes the row, falling back to the workflow rule's defaults.


// Phase 4n: per-customer reminder send + open/click timeline. Engagement
// Phase 4n.21: threaded customer notes. Any employee assigned to this
// customer (admins always) can add a note. Notes are append-only — the
// author + timestamp are baked at write so the audit trail survives staff
// turnover.
// Phase 4n.27: per-customer activity timeline. Merged chronological feed
// of notes, signatures, filings, threads, and email engagement so staff
// can answer "what's been going on with this customer?" in one scan
// instead of scrolling 7 sibling sections.
// ── Service Inquiry Sender ───────────────────────────────────────────────────
// Lets the owner pick services and send an inquiry message to the customer
// via email or WhatsApp (wa.me pre-fill). Language defaults to the customer's
// locale but can be overridden.
function ServiceInquirySection({ customer, auth, community, locale, t }) {
  const [products, setProducts] = useState([]);
  const [selected, setSelected] = useState({});
  const [serviceFilter, setServiceFilter] = useState('');
  const [lang, setLang] = useState(customer?.locale === 'en' ? 'en' : 'es');
  const [status, setStatus] = useState('idle');
  const [storedWa, setStoredWa] = useState(customer?.whatsapp || ''); // reactive; updates after save
  const [waInput, setWaInput] = useState(customer?.whatsapp || ''); // editable field value
  const [waOverride, setWaOverride] = useState('');
  const [waSaveStatus, setWaSaveStatus] = useState('idle'); // idle | saving | saved | error
  const [preview, setPreview] = useState(null);   // null = closed; string = modal open
  const [previewing, setPreviewing] = useState(false);
  const [sendingFromPreview, setSendingFromPreview] = useState(false);
  const [previewStatus, setPreviewStatus] = useState('idle');

  const WHATSAPP_E164 = /^\+[1-9]\d{6,14}$/;
  const normalizeWa = (raw) => '+' + String(raw || '').replace(/^\+/, '').replace(/\D+/g, '');
  // When a number is stored, waInput is the editable version of it.
  // When no number is stored, waOverride is the entry field.
  const activeRaw = storedWa ? waInput : waOverride;
  const activeNorm = activeRaw.trim() ? normalizeWa(activeRaw) : '';
  const activeValid = !activeRaw.trim() || WHATSAPP_E164.test(activeNorm);
  const effectiveWa = activeValid && activeNorm ? activeNorm : '';
  // legacy aliases used in openWhatsApp / JSX
  const waValid = activeValid;

  const saveWaNumber = async () => {
    if (!activeRaw.trim() || !WHATSAPP_E164.test(activeNorm)) return;
    if (activeNorm === storedWa) return; // unchanged — skip
    setWaSaveStatus('saving');
    try {
      await taxApi.adminUpdateCustomer(auth, customer.id, { whatsapp: activeNorm });
      setStoredWa(activeNorm);
      if (!storedWa) setWaOverride(''); // clear entry field after first save
      setWaSaveStatus('saved');
      setTimeout(() => setWaSaveStatus('idle'), 3000);
    } catch (_) {
      setWaSaveStatus('error');
    }
  };

  useEffect(() => {
    if (!community?.id) return;
    taxApi.adminListProducts(auth, community.id)
      .then(d => setProducts((d.products || []).filter(p => p.enabled !== false)))
      .catch(() => {});
  }, [community?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const CATEGORY_EMOJI = { individual: '📋', business: '🏢', general: '📚', audit: '📋' };

  const filteredProducts = serviceFilter.trim()
    ? products.filter(p => {
        const name = (p.name_i18n?.[lang] || p.name_i18n?.en || p.name_i18n?.es || p.slug).toLowerCase();
        return name.includes(serviceFilter.toLowerCase());
      })
    : products;

  const toggle = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));
  const selectedIds = Object.keys(selected).filter(k => selected[k]);

  const openPreview = async () => {
    if (!selectedIds.length) return;
    setPreviewing(true);
    setPreviewStatus('idle');
    try {
      const r = await taxApi.adminPreviewServiceInquiry(auth, customer.id, { productIds: selectedIds, lang });
      setPreview(r.text || '');
    } catch (e) {
      setStatus(e?.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const openWhatsApp = async () => {
    if (!selectedIds.length) return;
    if (!effectiveWa) { setStatus(t('owner.customer.inquiry.provideWhatsapp')); return; }
    if (!WHATSAPP_E164.test(effectiveWa)) { setStatus(t('portal.profile.whatsapp.invalid')); return; }
    setStatus('sending');
    try {
      const r = await taxApi.adminSendServiceInquiry(auth, customer.id, {
        productIds: selectedIds, channel: 'whatsapp', lang,
        waOverride: effectiveWa, // server uses this if customer.whatsapp not set
      });
      if (r.waUrl) { window.open(r.waUrl, '_blank', 'noopener'); setStatus('sent'); }
      else setStatus(r.error || 'Failed');
    } catch (e) { setStatus(e?.message || 'Failed'); }
  };

  const sendEmail = async (customMessage) => {
    setSendingFromPreview(true);
    setPreviewStatus('sending');
    try {
      const r = await taxApi.adminSendServiceInquiry(auth, customer.id, {
        productIds: selectedIds, channel: 'email', lang,
        customMessage: customMessage || undefined,
      });
      if (r.ok) {
        setPreviewStatus('sent');
        setStatus('sent');
        setTimeout(() => { setPreview(null); setPreviewStatus('idle'); }, 1800);
      } else {
        setPreviewStatus(r.error || 'Send failed');
      }
    } catch (e) {
      setPreviewStatus(e?.message || 'Send failed');
    } finally {
      setSendingFromPreview(false);
    }
  };

  return (
    <div style={{ padding: 16, border: '1px solid var(--tax-border)', borderRadius: 8 }}>

      {/* ── Action bar ── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
        {/* Language */}
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--tax-muted)', display: 'block', marginBottom: 3 }}>
            {t('owner.customer.inquiry.language')}
          </label>
          <select value={lang} onChange={e => setLang(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--tax-border)', fontSize: 13 }}>
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </div>

        {/* WhatsApp — always an editable input; pre-filled when stored */}
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--tax-muted)', display: 'block', marginBottom: 3 }}>
            WhatsApp
          </label>
          <input type="tel"
                 value={storedWa ? waInput : waOverride}
                 placeholder="+14155551234"
                 onChange={e => {
                   setWaSaveStatus('idle'); setStatus('idle');
                   storedWa ? setWaInput(e.target.value) : setWaOverride(e.target.value);
                 }}
                 onBlur={saveWaNumber}
                 maxLength={20}
                 style={{
                   padding: '6px 10px', borderRadius: 6, fontSize: 13, width: 170,
                   border: `1px solid ${activeRaw && !activeValid ? 'var(--tax-error)' : 'var(--tax-border)'}`,
                 }} />
          {activeRaw && !activeValid && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--tax-error)' }}>{t('portal.profile.whatsapp.invalid')}</p>}
          {waSaveStatus === 'saving' && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>Saving…</p>}
          {waSaveStatus === 'saved' && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--tax-success, #166534)' }}>✓ Saved to contact</p>}
          {waSaveStatus === 'error' && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--tax-error)' }}>Save failed</p>}
        </div>

        {/* Action buttons — right-aligned */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {/* WhatsApp — disabled if no number available yet */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <button type="button"
                    onClick={openWhatsApp}
                    disabled={status === 'sending' || selectedIds.length === 0 || !effectiveWa}
                    style={{
                      padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      background: '#25d366', color: '#fff', border: 'none',
                      opacity: (selectedIds.length === 0 || !effectiveWa) ? 0.5 : 1,
                    }}>
              💬 {t('owner.customer.inquiry.openWhatsapp')}
            </button>
            {!storedWa && !effectiveWa && <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--tax-muted)' }}>Enter number above</p>}
          </div>
          {/* Preview & Send Email */}
          <button type="button"
                  onClick={openPreview}
                  disabled={previewing || selectedIds.length === 0}
                  style={{
                    padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    background: 'var(--tax-brand-primary)', color: '#fff', border: 'none',
                    opacity: selectedIds.length === 0 ? 0.5 : 1,
                  }}>
            {previewing ? '…' : `📧 ${t('owner.customer.inquiry.previewAndSend')}`}
          </button>
        </div>
      </div>

      {/* Status line */}
      {status === 'sent' && (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tax-success, #166534)' }}>
          ✓ {t('owner.customer.inquiry.whatsappOpened')}
        </p>
      )}
      {status !== 'idle' && status !== 'sending' && status !== 'sent' && (
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tax-error)' }}>{status}</p>
      )}

      {/* ── Service checklist ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
            {t('owner.customer.inquiry.services')}
            <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 999,
                           background: selectedIds.length === 0 ? '#fee2e2' : '#dcfce7',
                           color: selectedIds.length === 0 ? '#991b1b' : '#166534', fontSize: 11 }}>
              {selectedIds.length}/{products.length}
            </span>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="search" value={serviceFilter}
                   onChange={e => setServiceFilter(e.target.value)}
                   placeholder={t('owner.customer.inquiry.filterPlaceholder')}
                   style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--tax-border)', fontSize: 12, width: 140 }} />
            <button type="button" onClick={() => setSelected(Object.fromEntries(products.map(p => [p.id, true])))}
                    style={{ fontSize: 11, color: 'var(--tax-brand-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}>
              {t('owner.customer.inquiry.selectAll')}
            </button>
            <button type="button" onClick={() => setSelected({})}
                    style={{ fontSize: 11, color: 'var(--tax-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              {t('owner.customer.inquiry.clearAll')}
            </button>
          </div>
        </div>
        {products.length === 0 && <p style={{ color: 'var(--tax-muted)', fontSize: 13 }}>Loading services…</p>}
        <div style={{ display: 'grid', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {filteredProducts.map(p => {
            const name = p.name_i18n?.[lang] || p.name_i18n?.en || p.name_i18n?.es || p.slug;
            const desc = p.description_i18n?.[lang] || p.description_i18n?.en || '';
            const emoji = CATEGORY_EMOJI[p.category] || '📄';
            return (
              <label key={p.id} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                background: selected[p.id] ? 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)' : '#f9fafb',
                border: `1px solid ${selected[p.id] ? 'color-mix(in srgb, var(--tax-brand-primary) 25%, #fff)' : 'var(--tax-border)'}`,
              }}>
                <input type="checkbox" checked={!!selected[p.id]} onChange={() => toggle(p.id)}
                       style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{emoji} {name}</div>
                  {desc && <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>{desc}</div>}
                </div>
              </label>
            );
          })}
          {filteredProducts.length === 0 && serviceFilter && (
            <p style={{ color: 'var(--tax-muted)', fontSize: 13, padding: '8px 0' }}>No services match "{serviceFilter}"</p>
          )}
        </div>
      </div>

      {/* ── Preview modal ── */}
      {preview !== null && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 16,
        }}
          onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div style={{
            background: '#fff', borderRadius: 10, boxShadow: '0 8px 40px rgba(0,0,0,.25)',
            width: '100%', maxWidth: 640, maxHeight: '90vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '14px 20px', borderBottom: '1px solid var(--tax-border)' }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>
                📧 {t('owner.customer.inquiry.preview')}
              </span>
              <button type="button" onClick={() => setPreview(null)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--tax-muted)', lineHeight: 1 }}>
                ✕
              </button>
            </div>
            {/* Editable message */}
            <textarea
              value={preview}
              onChange={e => setPreview(e.target.value)}
              style={{
                flex: 1, minHeight: 0, fontFamily: 'monospace', fontSize: 12,
                padding: 16, border: 'none', borderBottom: '1px solid var(--tax-border)',
                resize: 'none', lineHeight: 1.6, outline: 'none',
              }} />
            {/* Modal footer */}
            <div style={{ padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button"
                      className="tax-btn tax-btn--primary tax-btn--sm"
                      onClick={() => sendEmail(preview)}
                      disabled={sendingFromPreview}>
                {sendingFromPreview ? t('lead.submitting') : `📧 ${t('owner.customer.inquiry.sendEmail')}`}
              </button>
              <button type="button"
                      className="tax-btn tax-btn--sm"
                      onClick={() => setPreview(null)}
                      style={{ background: '#f1f5f9', border: '1px solid var(--tax-border)', color: 'var(--tax-text)' }}>
                {t('owner.customer.inquiry.closePreview')}
              </button>
              {previewStatus === 'sent' && (
                <span style={{ fontSize: 12, color: 'var(--tax-success, #166534)' }}>✓ {t('owner.customer.inquiry.emailSent')}</span>
              )}
              {previewStatus !== 'idle' && previewStatus !== 'sending' && previewStatus !== 'sent' && (
                <span style={{ fontSize: 12, color: 'var(--tax-error)' }}>{previewStatus}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityTimelineSection({ auth, customerId, locale, t }) {
  const [events, setEvents] = useState(null);
  const [filter, setFilter] = useState('all');
  const [err, setErr] = useState('');
  const [undoing, setUndoing] = useState('');
  const [undoMsg, setUndoMsg] = useState({ kind: 'idle', text: '' });
  const reload = () => {
    setErr(''); setEvents(null);
    taxApi.adminGetCustomerActivity(auth, customerId, 100)
      .then(d => setEvents(d.events || []))
      .catch(e => setErr(e?.message || ''));
  };
  useEffect(() => { reload(); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onUndo = async (auditId) => {
    setUndoing(auditId); setUndoMsg({ kind: 'idle', text: '' });
    try {
      const r = await taxApi.adminUndoCustomerActivity(auth, customerId, auditId);
      setUndoMsg({ kind: 'success',
        text: t('owner.activity.undo.success', { n: r.tasksCreated || 0 }) });
      reload();
    } catch (e) {
      setUndoMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setUndoing('');
    }
  };

  function fmt(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
        { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .format(new Date(iso));
    } catch (_e) { return iso; }
  }
  function relTime(iso) {
    if (!iso) return '';
    try {
      const diffMs = Date.now() - new Date(iso).getTime();
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin < 1) return t('owner.activity.justNow');
      if (diffMin < 60) return t('owner.activity.minutesAgo', { n: diffMin });
      if (diffMin < 60 * 24) return t('owner.activity.hoursAgo', { n: Math.round(diffMin / 60) });
      const days = Math.round(diffMin / (60 * 24));
      if (days < 14) return t('owner.activity.daysAgo', { n: days });
      return fmt(iso);
    } catch (_e) { return fmt(iso); }
  }

  // Filter chips group multiple kinds. "All" / "Messages" / "Emails" /
  // "Signatures" / "Filings" / "Notes" — keeps the scan-time small when
  // a customer has lots of events.
  const FILTER_GROUPS = {
    all: () => true,
    messages: e => e.kind === 'message_in' || e.kind === 'message_out' || e.kind === 'thread_created',
    emails: e => e.kind.startsWith('email_'),
    signatures: e => e.kind.startsWith('sig_'),
    filings: e => e.kind.startsWith('filing_'),
    notes: e => e.kind === 'note_added',
  };
  const shown = (events || []).filter(FILTER_GROUPS[filter] || (() => true));

  if (err) return null;

  return (
    <section className="tax-section" style={{ paddingTop: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all', 'messages', 'emails', 'signatures', 'filings', 'notes'].map(f => {
            const isActive = filter === f;
            return (
              <button key={f} type="button"
                      onClick={() => setFilter(f)}
                      style={{
                        padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                        border: `1px solid ${isActive ? 'var(--tax-brand-primary)' : 'var(--tax-border)'}`,
                        background: isActive ? 'var(--tax-brand-primary)' : '#fff',
                        color: isActive ? '#fff' : 'var(--tax-text)',
                        cursor: 'pointer',
                      }}>
                {t(`owner.activity.filter.${f}`)}
              </button>
            );
          })}
        </div>
      </div>

      {events === null && <p style={{ marginTop: 12 }}>{t('loading')}</p>}
      {events && shown.length === 0 && (
        <p style={{ color: 'var(--tax-muted)', marginTop: 12 }}>
          {t('owner.activity.empty')}
        </p>
      )}
      {undoMsg.text && (
        <div className={`tax-msg tax-msg--${undoMsg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginTop: 12 }}>{undoMsg.text}</div>
      )}
      {events && shown.length > 0 && (
        <div style={{ marginTop: 16, position: 'relative' }}>
          {/* Vertical rail behind the dots. */}
          <div style={{
            position: 'absolute', left: 11, top: 6, bottom: 6, width: 2,
            background: 'var(--tax-border)',
          }} />
          <div style={{ display: 'grid', gap: 12 }}>
            {shown.map((e, i) => (
              <ActivityRow key={i} event={e} fmt={fmt} relTime={relTime} t={t}
                           undoing={undoing === e.ref?.id} onUndo={onUndo} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ActivityRow({ event, fmt, relTime, t, undoing, onUndo }) {
  const ICON = {
    note_added: '📝',
    sig_requested: '✎',  sig_signed: '✓',  sig_declined: '✕',  sig_cancelled: '⊘',
    filing_responded: '📥',  filing_filed: '🗂️',
    message_in: '↳',  message_out: '↲',  thread_created: '💬',
    email_sent: '✉',  email_delivered: '✉',  email_opened: '👁',  email_clicked: '🖱',
    email_bounced: '!',
    customer_created: '★',
    service_removed: '⊗',  relationship_removed: '⊗',
    audit: '⚙',
  };
  const TONE = {
    ok: { bg: '#dcfce7', fg: '#166534' },
    info: { bg: '#dbeafe', fg: '#1e40af' },
    warn: { bg: '#fef3c7', fg: '#854d0e' },
    danger: { bg: '#fee2e2', fg: '#b91c1c' },
    muted: { bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)' },
  };
  const tone = TONE[event.tone] || TONE.muted;
  const icon = ICON[event.kind] || '•';

  // Hover tooltip — gives the full untruncated detail (the inline row
  // keeps the 280-char clamp so the timeline stays scannable). Built as
  // a multi-line string so the browser's native tooltip renders it.
  const hoverLines = [
    event.title,
    event.detail ? event.detail : null,
    event.actor ? t('owner.activity.by', { name: event.actor }) : null,
    fmt(event.ts),
  ].filter(Boolean);
  const hoverText = hoverLines.join('\n');

  const canUndo = event.undoable && event.ref?.id;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '24px 1fr', gap: 12, alignItems: 'flex-start',
      paddingLeft: 0, position: 'relative',
    }} title={hoverText}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%',
        background: tone.bg, color: tone.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, flexShrink: 0,
        boxShadow: '0 0 0 2px #fff',
      }} aria-hidden="true">{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>{event.title}</strong>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {canUndo && (
              <button type="button"
                      onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onUndo(event.ref.id); }}
                      disabled={undoing}
                      style={{
                        padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                        background: '#fff', color: 'var(--tax-brand-primary)',
                        border: '1px solid var(--tax-brand-primary)', cursor: undoing ? 'wait' : 'pointer',
                        textTransform: 'uppercase', letterSpacing: '.04em',
                      }}>
                {undoing ? t('owner.activity.undo.busy') : t('owner.activity.undo.button')}
              </button>
            )}
            <span style={{ fontSize: 12, color: 'var(--tax-muted)', whiteSpace: 'nowrap' }}
                  title={fmt(event.ts)}>
              {relTime(event.ts)}
            </span>
          </span>
        </div>
        {event.detail && (
          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {event.detail.length > 280 ? event.detail.slice(0, 280) + '…' : event.detail}
          </div>
        )}
        {event.actor && (
          <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
            {t('owner.activity.by', { name: event.actor })}
            {event.actorRole === 'admin' && (
              <span style={{
                marginLeft: 6, padding: '0 6px', borderRadius: 999,
                background: 'var(--tax-brand-primary)', color: '#fff',
                fontSize: 10, fontWeight: 700,
              }}>ADMIN</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesSection({ auth, customerId, locale, t }) {
  const [notes, setNotes] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load() {
    setErr('');
    taxApi.adminListCustomerNotes(auth, customerId)
      .then(d => setNotes(d.notes || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  }
  useEffect(load, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onSubmit(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateCustomerNote(auth, customerId, { body });
      setDraft('');
      load();
    } catch (e2) {
      setErr(e2?.message || t('respond.error.generic'));
    } finally { setBusy(false); }
  }

  function fmt(iso) {
    try {
      return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
        { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .format(new Date(iso));
    } catch (_e) { return iso; }
  }

  return (
    <section className="tax-section" style={{ paddingTop: 0 }}>
      <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 12px' }}>
        {t('owner.customer.notes.hint')}
      </p>

      <form onSubmit={onSubmit} style={{ marginBottom: 12 }}>
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
                  rows={3} maxLength={4000}
                  placeholder={t('owner.customer.notes.placeholder')}
                  style={{ width: '100%' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>
            {t('owner.customer.notes.author')}
          </span>
          <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm"
                  disabled={busy || !draft.trim()}>
            {busy ? t('lead.submitting') : t('owner.customer.notes.addBtn')}
          </button>
        </div>
      </form>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {notes === null && <p>{t('loading')}</p>}
      {notes && notes.length === 0 && (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.notes.empty')}</p>
      )}
      {notes && notes.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {notes.map(n => (
            <div key={n.id} style={{
              padding: '10px 12px', border: '1px solid var(--tax-border)',
              borderRadius: 8, background: '#fff',
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', gap: 8,
                fontSize: 12, color: 'var(--tax-muted)', marginBottom: 4,
              }}>
                <span>
                  <strong style={{ color: 'var(--tax-text)' }}>
                    {n.author_name || n.author_email || t('owner.customer.notes.unknownAuthor')}
                  </strong>
                  {n.author_role === 'admin' && (
                    <span style={{
                      marginLeft: 6, padding: '0 6px', borderRadius: 999,
                      background: 'var(--tax-brand-primary)', color: '#fff',
                      fontSize: 10, fontWeight: 700,
                    }}>ADMIN</span>
                  )}
                </span>
                <span>{fmt(n.created_at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Phase 4n.24: e-signature requests on the customer detail. Owner creates
// a request (title + optional description); customer sees it in the
// portal, types their legal name, and the row flips to 'signed' with a
// captured IP + timestamp + consent-text snapshot.
function SignatureRequestsSection({ auth, customerId, locale, t }) {
  const [requests, setRequests] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function load() {
    setErr('');
    taxApi.adminListSignatureRequests(auth, customerId)
      .then(d => setRequests(d.requests || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  }
  useEffect(load, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onCreate(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateSignatureRequest(auth, customerId, {
        title: form.title.trim(),
        description: form.description.trim(),
      });
      setForm({ title: '', description: '' });
      setAdding(false);
      load();
    } catch (e2) {
      setErr(e2?.message || t('respond.error.generic'));
    } finally { setBusy(false); }
  }

  async function onCancel(reqId) {
    if (!window.confirm(t('owner.customer.signatures.confirmCancel'))) return;
    try {
      await taxApi.adminCancelSignatureRequest(auth, customerId, reqId);
      load();
    } catch (e2) { setErr(e2?.message || t('respond.error.generic')); }
  }

  function fmt(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'es-ES',
        { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        .format(new Date(iso));
    } catch (_e) { return iso; }
  }

  const STATUS_TONE = {
    pending: { bg: '#fef3c7', fg: '#854d0e', label: t('owner.customer.signatures.status.pending') },
    signed: { bg: '#dcfce7', fg: '#166534', label: t('owner.customer.signatures.status.signed') },
    declined: { bg: '#fee2e2', fg: '#b91c1c', label: t('owner.customer.signatures.status.declined') },
    cancelled: { bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)', label: t('owner.customer.signatures.status.cancelled') },
    expired: { bg: 'var(--tax-bg-alt)', fg: 'var(--tax-muted)', label: t('owner.customer.signatures.status.expired') },
  };

  return (
    <section className="tax-section" style={{ paddingTop: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 12px' }}>
            {t('owner.customer.signatures.hint')}
          </p>
        </div>
        {!adding && (
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                  onClick={() => setAdding(true)}>
            + {t('owner.customer.signatures.newBtn')}
          </button>
        )}
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {adding && (
        <form onSubmit={onCreate} style={{
          marginBottom: 12, padding: 12, border: '1px solid var(--tax-border)',
          borderRadius: 8, background: 'var(--tax-bg-alt)', display: 'grid', gap: 8,
        }}>
          <input type="text" value={form.title}
                 placeholder={t('owner.customer.signatures.titlePlaceholder')}
                 onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                 maxLength={300} required style={{ width: '100%' }} />
          <textarea value={form.description} rows={3}
                    placeholder={t('owner.customer.signatures.descriptionPlaceholder')}
                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                    maxLength={16000} style={{ width: '100%' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm"
                    disabled={busy || !form.title.trim()}>
              {busy ? t('lead.submitting') : t('owner.customer.signatures.sendBtn')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                    onClick={() => { setAdding(false); setForm({ title: '', description: '' }); }}>
              {t('preview.close')}
            </button>
          </div>
        </form>
      )}

      {requests === null && <p>{t('loading')}</p>}
      {requests && requests.length === 0 && !adding && (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.signatures.empty')}</p>
      )}
      {requests && requests.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {requests.map(r => {
            const tone = STATUS_TONE[r.status] || STATUS_TONE.pending;
            return (
              <div key={r.id} style={{
                padding: '10px 12px', border: '1px solid var(--tax-border)',
                borderRadius: 8, background: '#fff',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{r.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                      {t('owner.customer.signatures.requestedBy', {
                        name: r.requested_by_name || r.requested_by_email || '—',
                        date: fmt(r.created_at),
                      })}
                    </div>
                  </div>
                  <span style={{
                    padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
                    background: tone.bg, color: tone.fg,
                  }}>{tone.label}</span>
                </div>
                {r.status === 'signed' && (
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 6 }}>
                    {t('owner.customer.signatures.signedSummary', {
                      name: r.signer_name || r.signer_email,
                      date: fmt(r.signed_at),
                    })}
                  </div>
                )}
                {r.status === 'pending' && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                            onClick={() => onCancel(r.id)}
                            style={{ color: '#b91c1c', borderColor: '#b91c1c' }}>
                      {t('owner.customer.signatures.cancelBtn')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// summary at the top + a colored pill per row makes "did this customer
// actually read it" answerable at a glance. Apple Mail Privacy caveat is
// shown inline so the team doesn't over-trust open counts.


// Phase 4d: profile is now editable from the admin side. The login email
// stays read-only — it's the Firebase identity. Customer self-serves the
// same fields via /portal/profile; this endpoint is for owner-side fixes
// (typos, fill-in before customer sign-in, etc.).
function ProfileSection({ customer: c, auth, customerId, onChange, t }) {
  const [form, setForm] = useState({
    businessName: c.business_name || '',
    firstName: c.first_name || '',
    middleName: c.middle_name || '',
    lastName: c.last_name || '',
    phone: c.phone || '',
    whatsapp: c.whatsapp || '',
    preferredEmail: c.preferred_communication_email || '',
    locale: c.locale || 'es',
    status: c.status || 'active',
    addr: {
      line1: c.address?.line1 || '', line2: c.address?.line2 || '',
      city: c.address?.city || '', state: c.address?.state || '',
      postal_code: c.address?.postal_code || '',
      country: c.address?.country || 'US',
    },
  });
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | saved | error
  const debounceRef = useRef(null);
  const savedTimerRef = useRef(null);
  const doSave = useRef(null);

  doSave.current = async (overrides) => {
    const f = overrides ? { ...form, ...overrides } : form;
    setSaveStatus('saving');
    const address = {};
    for (const k of ['line1', 'line2', 'city', 'state', 'postal_code', 'country']) {
      const v = String(f.addr[k] || '').trim();
      if (v) address[k] = v;
    }
    try {
      await taxApi.adminUpdateCustomer(auth, customerId, {
        businessName: f.businessName.trim(),
        firstName: f.firstName.trim(),
        middleName: f.middleName.trim(),
        lastName: f.lastName.trim(),
        phone: f.phone.trim(),
        whatsapp: f.whatsapp.trim(),
        preferredCommunicationEmail: f.preferredEmail.trim(),
        locale: f.locale,
        status: f.status,
        address,
      });
      setSaveStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2500);
      onChange();
    } catch (_) { setSaveStatus('error'); }
  };

  const scheduleAutoSave = (overrides) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSave.current(overrides), 1200);
  };

  const saveNow = (overrides) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    doSave.current(overrides);
  };

  const setField = (key, val, immediate = false) => {
    const next = { ...form, [key]: val };
    setForm(next);
    immediate ? saveNow(next) : scheduleAutoSave(next);
  };

  const setAddr = (key, val) => {
    const next = { ...form, addr: { ...form.addr, [key]: val } };
    setForm(next);
    scheduleAutoSave(next);
  };

  const a = c.address || {};

  return (
    <section style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, minHeight: 22 }}>
        {saveStatus === 'saving' && <span style={{ fontSize: 12, color: 'var(--tax-muted)' }}>Saving…</span>}
        {saveStatus === 'saved'  && <span style={{ fontSize: 12, color: 'var(--tax-success, #166534)' }}>✓ Saved</span>}
        {saveStatus === 'error'  && <span style={{ fontSize: 12, color: 'var(--tax-error)' }}>Save failed</span>}
      </div>
      <div className="tax-form" style={{ maxWidth: 720 }}>
        <div>
          <label>{t('owner.customers.fieldBusinessName')}</label>
          <input type="text" value={form.businessName}
                 onChange={e => setField('businessName', e.target.value)}
                 maxLength={200}
                 placeholder={t('owner.customers.fieldBusinessNamePlaceholder')} />
          <small style={{ color: 'var(--tax-muted)' }}>
            {t('owner.customers.fieldBusinessNameHint')}
          </small>
        </div>
        <div className="tax-form__row3">
          <div>
            <label>{t('owner.customers.fieldFirstName')}</label>
            <input type="text" value={form.firstName}
                   onChange={e => setField('firstName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label>{t('owner.customers.fieldMiddleName')}</label>
            <input type="text" value={form.middleName}
                   onChange={e => setField('middleName', e.target.value)} maxLength={80} />
          </div>
          <div>
            <label>{t('owner.customers.fieldLastName')}</label>
            <input type="text" value={form.lastName}
                   onChange={e => setField('lastName', e.target.value)} maxLength={80} />
          </div>
        </div>
        <div>
          <label>{t('owner.customer.status')}</label>
          <select value={form.status} onChange={e => setField('status', e.target.value, true)}>
            <option value="active">{t('owner.customer.profile.status.active')}</option>
            <option value="paused">{t('owner.customer.profile.status.paused')}</option>
            <option value="archived">{t('owner.customer.profile.status.archived')}</option>
          </select>
        </div>
        <div className="tax-form__row2">
          <div>
            <label>{t('portal.profile.phone')}</label>
            <input type="tel" value={form.phone}
                   onChange={e => setField('phone', e.target.value)} maxLength={40} />
          </div>
          <div>
            <label>
              {t('portal.profile.whatsapp')}
              <span style={{ color: 'var(--tax-muted)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                {t('portal.profile.whatsapp.format')}
              </span>
            </label>
            <input type="tel" value={form.whatsapp}
                   placeholder="+14155551234"
                   onChange={e => setField('whatsapp', e.target.value)} maxLength={20} />
          </div>
        </div>
        <div className="tax-form__row2">
          <div>
            <label>{t('portal.profile.preferredEmail')}</label>
            <input type="email" value={form.preferredEmail}
                   placeholder={c.email}
                   onChange={e => setField('preferredEmail', e.target.value)} maxLength={200} />
          </div>
          <div>
            <label>{t('owner.customers.fieldLocale')}</label>
            <select value={form.locale} onChange={e => setField('locale', e.target.value, true)}>
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
        <fieldset style={{ border: '1px solid var(--tax-border)', borderRadius: 8, padding: 16, margin: 0 }}>
          <legend style={{ padding: '0 8px', fontWeight: 600, fontSize: 14 }}>{t('portal.profile.address')}</legend>
          <div style={{ display: 'grid', gap: 12 }}>
            <input type="text" placeholder={t('portal.profile.address.line1')} value={form.addr.line1}
                   onChange={e => setAddr('line1', e.target.value)} maxLength={200} />
            <input type="text" placeholder={t('portal.profile.address.line2')} value={form.addr.line2}
                   onChange={e => setAddr('line2', e.target.value)} maxLength={200} />
            <div className="tax-form__row2">
              <input type="text" placeholder={t('portal.profile.address.city')} value={form.addr.city}
                     onChange={e => setAddr('city', e.target.value)} maxLength={120} />
              <input type="text" placeholder={t('portal.profile.address.state')} value={form.addr.state}
                     onChange={e => setAddr('state', e.target.value)} maxLength={80} />
            </div>
            <div className="tax-form__row2">
              <input type="text" placeholder={t('portal.profile.address.postal')} value={form.addr.postal_code}
                     onChange={e => setAddr('postal_code', e.target.value)} maxLength={20} />
              <input type="text" placeholder={t('portal.profile.address.country')} value={form.addr.country}
                     onChange={e => setAddr('country', e.target.value)} maxLength={4} />
            </div>
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function RelationshipsSection({ data, types, auth, customerId, onChange, locale, t }) {
  const rels = data.relationships || [];
  const [picking, setPicking] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Hide already-attached types from the picker.
  const attached = new Set(rels.map(r => r.relationship_type_id));
  const available = types.filter(tp => !attached.has(tp.id));

  const onAdd = async () => {
    if (!typeId) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminAddCustomerRelationship(auth, customerId, { relationshipTypeId: typeId });
      setTypeId(''); setPicking(false);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onAddType = async (id) => {
    if (!id || busy) return;
    setBusy(true); setErr('');
    try {
      await taxApi.adminAddCustomerRelationship(auth, customerId, { relationshipTypeId: id });
      setPicking(false);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const onRemove = async (rel) => {
    if (!window.confirm(t('owner.customer.relationship.confirmRemove', { name: pickI18n(rel.type?.name_i18n, locale).value || '' }))) return;
    try {
      await taxApi.adminRemoveCustomerRelationship(auth, customerId, rel.id);
      onChange();
    } catch (e) { setErr(e?.message || ''); }
  };

  return (
    <section style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div />
        {available.length > 0 && (
          <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                  onClick={() => setPicking(p => !p)}>
            {picking ? t('owner.customer.relationship.cancel') : t('owner.customer.relationship.addBtn')}
          </button>
        )}
      </div>

      {picking && (
        <div className="tax-contact-item" style={{ marginBottom: 12 }}>
          {available.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--tax-muted)' }}>{t('owner.customer.relationship.allAttached')}</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {groupRelationshipsByCategory(available).map(({ category, types }) => (
                <div key={category}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                    textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4,
                  }}>
                    {t(`owner.customers.category.${category}`, { _: category })}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {types.map(tp => (
                      <button key={tp.id} type="button"
                              onClick={() => onAddType(tp.id)}
                              disabled={busy}
                              style={{
                                padding: '4px 10px', borderRadius: 999,
                                background: '#fff', color: 'var(--tax-text)',
                                border: '1px solid var(--tax-border)',
                                fontSize: 12, fontWeight: 500, cursor: busy ? 'wait' : 'pointer',
                              }}>
                        + {pickI18n(tp.name_i18n, locale).value || tp.slug}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {rels.length === 0 ? (
        <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.relationship.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {rels.map(r => (
            <span key={r.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '6px 6px 6px 12px', borderRadius: 999,
              background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
              color: 'var(--tax-brand-primary)',
              border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 20%, #fff)',
              fontSize: 13, fontWeight: 600,
            }}>
              {pickI18n(r.type?.name_i18n, locale).value}
              <span style={{ fontSize: 11, color: 'var(--tax-muted)', fontWeight: 400 }}>
                ({t(CATEGORY_KEY[r.type?.category] || 'portal.profile.category.business')})
              </span>
              <button type="button" onClick={() => onRemove(r)} aria-label={t('owner.customer.relationship.removeAria')}
                      style={{
                        border: 'none', background: 'transparent', color: 'var(--tax-error)',
                        cursor: 'pointer', fontSize: 16, padding: '0 8px 0 2px',
                      }}>×</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function DocumentsSection({ data, auth, customerId, onChange, t }) {
  const docs = data.documents || [];
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const onUploadClick = () => fileRef.current?.click();

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_MIME.has(file.type)) {
      setMsg({ kind: 'error', text: t('portal.documents.errUnsupported') }); return;
    }
    if (file.size > MAX_BYTES) {
      setMsg({ kind: 'error', text: t('portal.documents.errTooLarge') }); return;
    }
    setUploading(true);
    setMsg({ kind: 'idle', text: t('portal.documents.uploading', { name: file.name }) });
    try {
      const { id, signedUrl } = await taxApi.adminCustomerDocumentUploadUrl(auth, customerId, {
        fileName: file.name, mimeType: file.type, sizeBytes: file.size,
      });
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
      await taxApi.adminFinalizeDocument(auth, id);
      setMsg({ kind: 'success', text: t('owner.customer.document.uploadSuccess', { name: file.name }) });
      onChange();
    } catch (err) {
      setMsg({ kind: 'error', text: err?.message || t('portal.documents.errGeneric') });
    } finally {
      setUploading(false);
    }
  };

  const onDownload = async (id) => {
    try {
      const { signedUrl } = await taxApi.adminGetDocumentDownloadUrl(auth, id);
      window.location.href = signedUrl;
    } catch (e) { setMsg({ kind: 'error', text: e?.message || '' }); }
  };
  const onDelete = async (doc) => {
    if (!window.confirm(t('owner.customer.document.confirmDelete', { name: doc.file_name }))) return;
    try {
      await taxApi.adminDeleteDocument(auth, doc.id);
      onChange();
    } catch (e) { setMsg({ kind: 'error', text: e?.message || '' }); }
  };

  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" className="tax-btn tax-btn--primary tax-btn--sm"
                onClick={onUploadClick} disabled={uploading}>
          {uploading ? t('portal.documents.uploading_short') : t('owner.customer.document.uploadBtn')}
        </button>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile}
               accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.csv,.txt" />
      </div>
      <p style={{ color: 'var(--tax-muted)', fontSize: 13, margin: '0 0 12px' }}>
        {t('owner.customer.document.hint')}
      </p>

      {msg.text && (
        <div className={`tax-msg tax-msg--${msg.kind === 'error' ? 'error' : 'success'}`}
             style={{ marginBottom: 12 }}>{msg.text}</div>
      )}

      {docs.length === 0
        ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.document.empty')}</p>
        : <div style={{ display: 'grid', gap: 8 }}>
            {docs.map(d => (
              <div key={d.id} className="tax-contact-item"
                   style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.file_name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--tax-muted)', marginTop: 2 }}>
                    {d.source === 'practice' ? t('owner.customer.document.byPractice', { who: d.uploaded_by_email || 'practice' })
                                             : t('owner.customer.document.byCustomer')}
                    {' • '}{fmtBytes(d.size_bytes)}{' • '}{fmtDate(d.uploaded_at || d.created_at)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          onClick={() => onDownload(d.id)} style={{ color: 'var(--tax-text)' }}>
                    {t('portal.documents.download')}
                  </button>
                  <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                          onClick={() => onDelete(d)}
                          style={{ color: 'var(--tax-error)', borderColor: 'var(--tax-error)' }}>
                    {t('portal.documents.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
      }
    </section>
  );
}


// Phase 4d: per-period status override. Most filings auto-advance via the
// reminder cron (pending → info_requested when a reminder fires, →
// info_received when the customer submits via /respond or portal). Owner
// uses this to mark a period as 'skipped' (business was closed that
// month) or to manually flag as 'filed' after submitting through agency
// portal outside the platform.


function AssignmentsSection({ data, t }) {
  const assignments = data.assignments || [];
  return (
    <section style={{ marginTop: 8, marginBottom: 8 }}>
      {assignments.length === 0
        ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.assignment.empty')}</p>
        : <ul style={{ paddingLeft: 20, margin: 0 }}>
            {assignments.map(a => (
              <li key={a.id} style={{ marginBottom: 4 }}>
                {a.employee?.name || a.employee?.email}
                {a.employee?.role && (
                  <span style={{ color: 'var(--tax-muted)', fontSize: 12, marginLeft: 6 }}>({a.employee.role})</span>
                )}
                {a.is_primary && (
                  <span style={{
                    marginLeft: 8, padding: '1px 7px', borderRadius: 999,
                    background: 'var(--tax-brand-primary)', color: '#fff',
                    fontSize: 11, fontWeight: 700,
                  }}>{t('employee.profile.assignments.primary')}</span>
                )}
              </li>
            ))}
          </ul>
      }
      <p style={{ color: 'var(--tax-muted)', fontSize: 13, marginTop: 8 }}>
        {t('owner.customer.assignment.hint')}
      </p>
    </section>
  );
}

// "Impersonate" button — admin previews the customer portal as this user.
// Stores impersonation state in sessionStorage (tab-scoped) and navigates
// the same tab to /portal, where the customer-side AuthProvider detects
// the state and skips Firebase. The admin's real Firebase session stays
// intact and resumes when impersonation exits.
function ImpersonateCustomerButton({ customer, auth, community, t }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const onClick = async () => {
    if (!window.confirm(t('impersonation.confirm.customer', { name: displayPersonName(customer) || customer.email }))) return;
    setBusy(true); setErr('');
    try {
      const r = await taxApi.adminStartImpersonation(auth, {
        communitySlug: community.id,
        targetType: 'customer',
        targetId: customer.id,
      });
      setImpersonation({
        token: r.token,
        targetType: 'customer',
        targetId: customer.id,
        targetEmail: customer.email,
        targetName: displayPersonName(customer) || customer.email,
        communitySlug: community.id,
        realAdminEmail: auth.adminEmail || auth.email,
        realAdminUid: auth.uid,
        expiresAt: r.expiresAt,
      });
      window.location.href = `/tax/${community.id}/portal`;
    } catch (e) {
      setErr(e?.message || '');
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: '#b91c1c', borderColor: '#b91c1c', flexShrink: 0 }}>
        {busy ? t('impersonation.starting') : t('impersonation.viewAsCustomer')}
      </button>
      {err && <span style={{ color: 'var(--tax-error)', fontSize: 11 }}>{err}</span>}
    </div>
  );
}

// "Send welcome email" — manual resend of the bilingual portal-invite.
// Uses the customer's current locale + current relationships (so adding
// more services after the initial send + clicking this again will surface
// the new services in the email body).
function SendWelcomeButton({ customer: c, auth, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const onClick = async () => {
    if (!window.confirm(t('owner.customer.welcome.confirm', {
      name: displayPersonName(c) || c.email, lang: c.locale === 'en' ? 'English' : 'Español',
    }))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const result = await taxApi.adminSendWelcomeEmail(auth, c.id);
      if (result?.ok || result?.sent) {
        setMsg({ kind: 'success', text: t('owner.customer.welcome.sent') });
      } else if (result?.skipped) {
        setMsg({ kind: 'error', text: t('owner.customer.welcome.skipped', {
          reason: result.reason || 'unknown',
        }) });
      } else {
        setMsg({ kind: 'error', text: result?.error || t('respond.error.generic') });
      }
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 6000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
        {busy ? t('owner.customer.welcome.sending') : t('owner.customer.welcome.button')}
      </button>
      {msg.text && (
        <span style={{
          fontSize: 11,
          color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)',
        }}>{msg.text}</span>
      )}
    </div>
  );
}

// Phase 4n.15: promote an existing customer to staff/admin. Creates a
// tax_employees row keyed by the same email so the existing dual-role
// switch (staffAccess banner on the customer portal) lights up
// automatically. Sends the welcome email by default.
function PromoteToStaffButton({ customer: c, auth, onChanged, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });

  const onClick = async () => {
    const role = window.prompt(t('owner.customer.promote.rolePrompt'), 'staff');
    if (!role) return;
    const r = role.trim().toLowerCase();
    if (r !== 'staff' && r !== 'admin') {
      setMsg({ kind: 'error', text: t('owner.customer.promote.invalidRole') });
      return;
    }
    if (!window.confirm(t('owner.customer.promote.confirm', { name: displayPersonName(c) || c.email, role: r }))) return;
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      const result = await taxApi.adminPromoteCustomerToStaff(auth, c.id, { role: r });
      setMsg({ kind: 'success', text: t('owner.customer.promote.success', { role: r }) });
      onChanged && onChanged();
      return result;
    } catch (e) {
      if (e?.body?.error === 'already_employee') {
        setMsg({ kind: 'error', text: t('owner.customer.promote.alreadyEmployee') });
      } else {
        setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
      }
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 8000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
        {busy ? t('lead.submitting') : t('owner.customer.promote.button')}
      </button>
      {msg.text && (
        <span style={{
          fontSize: 11,
          color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)',
        }}>{msg.text}</span>
      )}
    </div>
  );
}

// Phase 4n.15: archive (status='archived') a customer. Records retained;
// relationships are deactivated so the cron stops generating periods.
// When already archived, swaps to a "Restore" affordance.
function ArchiveCustomerButton({ customer: c, auth, onChanged, t }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ kind: 'idle', text: '' });
  const isArchived = c.status === 'archived';

  const onClick = async () => {
    if (!isArchived) {
      if (!window.confirm(t('owner.customer.archive.confirm', { name: displayPersonName(c) || c.email }))) return;
    }
    setBusy(true); setMsg({ kind: 'idle', text: '' });
    try {
      await taxApi.adminSetCustomerStatus(auth, c.id, {
        status: isArchived ? 'active' : 'archived',
      });
      setMsg({ kind: 'success',
        text: isArchived ? t('owner.customer.archive.restored') : t('owner.customer.archive.done') });
      onChanged && onChanged();
    } catch (e) {
      setMsg({ kind: 'error', text: e?.message || t('respond.error.generic') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg({ kind: 'idle', text: '' }), 6000);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
              onClick={onClick} disabled={busy}
              style={{ color: '#b91c1c', borderColor: '#b91c1c' }}>
        {busy
          ? t('lead.submitting')
          : (isArchived ? t('owner.customer.archive.restoreBtn') : t('owner.customer.archive.button'))}
      </button>
      {msg.text && (
        <span style={{
          fontSize: 11,
          color: msg.kind === 'success' ? 'var(--tax-success)' : 'var(--tax-error)',
        }}>{msg.text}</span>
      )}
    </div>
  );
}

// Phase: per-customer task list. Inline-edit status, add new tasks, mark
// complete. Filters down to this customer's tasks via customerId on the
// /admin/tasks endpoint.
function TasksSection({ auth, customer, customerId, community, isAdmin, locale, t }) {
  const [tasks, setTasks] = useState(null);
  const [statuses, setStatuses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [products, setProducts] = useState([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);

  const load = () => {
    taxApi.adminListTasks(auth, { communitySlug: community.id, customerId })
      .then(d => setTasks(d.tasks || []))
      .catch(e => setErr(e?.message || ''));
  };
  useEffect(() => {
    if (!community) return;
    load();
    Promise.all([
      taxApi.adminListTaskStatuses(auth, community.id).catch(() => ({ statuses: [] })),
      taxApi.adminListEmployees(auth, community.id).catch(() => ({ employees: [] })),
      taxApi.adminListProducts(auth, community.id).catch(() => ({ products: [] })),
    ]).then(([s, e, p]) => {
      setStatuses(s.statuses || []);
      setEmployees((e.employees || []).filter(em => em.status !== 'archived'));
      setProducts(p.products || []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community, customerId]);

  const updateTask = async (id, patch) => {
    // Completing requires a closing note — prompt up-front so the
    // round-trip never has to fail with notes_required_on_complete.
    const target = (tasks || []).find(t0 => t0.id === id);
    const finalPatch = ensureCompletionNotes({ statuses, task: target || {}, patch, t });
    if (!finalPatch) return;
    try { await taxApi.adminUpdateTask(auth, id, finalPatch); load(); }
    catch (e) { setErr(e?.message || ''); }
  };
  const deleteTask = async (id) => {
    if (!window.confirm(t('owner.tasks.deleteConfirm'))) return;
    try { await taxApi.adminDeleteTask(auth, id); load(); }
    catch (e) { setErr(e?.message || ''); }
  };

  return (
    <section style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={() => setAdding(true)} style={{ color: 'var(--tax-brand-primary)' }}>
          + {t('owner.tasks.add')}
        </button>
      </div>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      {adding && (
        <InlineAddTask auth={auth} community={community}
                       customerId={customerId}
                       statuses={statuses} employees={employees} products={products}
                       locale={locale} t={t}
                       onCreated={() => { setAdding(false); load(); }}
                       onCancel={() => setAdding(false)} />
      )}

      {tasks === null ? <p style={{ color: 'var(--tax-muted)' }}>{t('loading')}</p>
        : tasks.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.customer.tasks.empty')}</p>
          : <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {tasks.map(task => {
                const status = statuses.find(s => s.key === task.status_key);
                const statusBg = status?.color || '#9ca3af';
                const product = task.product;
                const assignee = task.assignee;
                const overdue = task.due_date && task.due_date < new Date().toISOString().slice(0, 10) && !task.completed_at;
                const editHref = `/tax/${community.id}/employee/tasks?edit=${encodeURIComponent(task.id)}`;
                return (
                  <TaskHover key={task.id} task={task} statuses={statuses}
                             community={community} locale={locale} t={t}>
                    <div className="tax-contact-item"
                         style={{ display: 'grid', gap: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                        <a href={editHref}
                           style={{
                             minWidth: 0, flex: 1, textDecoration: 'none',
                             color: 'inherit', cursor: 'pointer',
                           }}>
                          <div style={{ fontWeight: 600 }}>{task.title}</div>
                          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--tax-muted)', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                            {product && <span>{pickI18n(product.name_i18n, locale).value || product.slug}</span>}
                            {assignee && <span>· {(assignee.name || assignee.email)}</span>}
                            {task.due_date && (
                              <span style={overdue ? { color: '#b91c1c', fontWeight: 600 } : undefined}>
                                · {t('owner.tasks.due')}: {task.due_date}{overdue ? ` (${t('owner.tasks.overdue')})` : ''}
                              </span>
                            )}
                            {task.priority !== 'normal' && <span>· {t(`owner.tasks.priority.${task.priority}`)}</span>}
                          </div>
                        </a>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <select value={task.status_key}
                                  onChange={e => updateTask(task.id, { statusKey: e.target.value })}
                                  onClick={e => e.stopPropagation()}
                                  style={{
                                    padding: '4px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                                    border: '1px solid var(--tax-border)',
                                    background: `color-mix(in srgb, ${statusBg} 18%, #fff)`,
                                  }}>
                            {statuses.map(s => (
                              <option key={s.id} value={s.key}>{pickI18n(s.label_i18n, locale).value || s.key}</option>
                            ))}
                          </select>
                          {isAdmin && (
                            <button type="button"
                                    onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }}
                                    className="tax-btn tax-btn--ghost tax-btn--sm"
                                    style={{ color: 'var(--tax-muted)' }}>×</button>
                          )}
                        </div>
                      </div>
                      {task.notes && (
                        <div style={{ fontSize: 12, color: 'var(--tax-muted)', whiteSpace: 'pre-wrap' }}>
                          {task.notes}
                        </div>
                      )}
                    </div>
                  </TaskHover>
                );
              })}
            </div>
      }
    </section>
  );
}

function InlineAddTask({ auth, community, customerId, statuses, employees, products, locale, t, onCreated, onCancel }) {
  const [title, setTitle] = useState('');
  const [productId, setProductId] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('normal');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    const product = products.find(p => p.id === productId);
    taxApi.adminTaskSuggestions(auth, product?.slug || '')
      .then(d => setSuggestions(d.suggestions || []))
      .catch(() => setSuggestions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const onSave = async (e) => {
    e?.preventDefault?.();
    if (!title.trim()) { setErr(t('owner.tasks.errTitle')); return; }
    setBusy(true); setErr('');
    try {
      await taxApi.adminCreateTask(auth, {
        communitySlug: community.id,
        title: title.trim(),
        customerId,
        productId: productId || null,
        statusKey: statuses[0]?.key || 'not_started',
        priority,
        assignedEmployeeId: assignedTo || null,
        dueDate: dueDate || null,
        notes: notes.trim(),
      });
      onCreated();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={onSave}
          className="tax-form"
          style={{ marginTop: 12, padding: 12, gap: 10 }}>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.title')}</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
               maxLength={300} list="task-suggestions-inline" required autoFocus
               style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        <datalist id="task-suggestions-inline">
          {suggestions.map((s, i) => (
            <option key={i} value={pickI18n(s, locale).value || s.en || s.es} />
          ))}
        </datalist>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.service')}</label>
          <select value={productId} onChange={e => setProductId(e.target.value)}
                  style={{ width: '100%', padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="">—</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>{pickI18n(p.name_i18n, locale).value || p.slug}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.owner')}</label>
          <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
                  style={{ width: '100%', padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            <option value="">—</option>
            {employees.map(em => (
              <option key={em.id} value={em.id}>{(em.name || em.email)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="tax-form__row2">
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.due')}</label>
          <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                 style={{ width: '100%', padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.priority')}</label>
          <select value={priority} onChange={e => setPriority(e.target.value)}
                  style={{ width: '100%', padding: 6, border: '1px solid var(--tax-border)', borderRadius: 6 }}>
            {['urgent','high','normal','low'].map(p => (
              <option key={p} value={p}>{t(`owner.tasks.priority.${p}`)}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>{t('owner.tasks.field.notes')}</label>
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} maxLength={4000}
                  style={{ width: '100%', padding: 8, border: '1px solid var(--tax-border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }} />
      </div>
      {err && <div className="tax-msg tax-msg--error">{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm" disabled={busy}>
          {busy ? t('lead.submitting') : t('owner.tasks.create')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} style={{ color: 'var(--tax-text)' }}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}

// Phase 4n.48: direct customer ↔ service tagging. Replaces the
// Relationships section as the customer-side "what does this person
// use" surface. Adding a service immediately fires the task
// generator for it; removing a service hard-deletes the untouched
// auto-tasks (same safety rule as relationship removal).

// Phase 4n.50: chip-toggle pattern for tagging services. Mirrors
// how the legacy "relationship chips" worked — one click to add,
// one click on a tagged chip's × to remove. Tagged services sit in
// a filled row at the top; untagged services sit below as a row of
// outlined chips the owner can click to add. Same data flow as the
// dropdown variant: each toggle fires the generator immediately so
// the team has tasks queued before the screen settles.
function ServicesSection({ community, auth, customerId, locale, t }) {
  const [services, setServices] = useState(null);
  const [products, setProducts] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    if (!auth?.uid || !community?.id) return;
    taxApi.adminListCustomerServices(auth, customerId)
      .then(d => setServices(d.services || []))
      .catch(e => setErr(e?.message || ''));
  };
  useEffect(() => {
    if (!auth?.uid || !community?.id) return;
    taxApi.adminListProducts(auth, community.id)
      .then(d => setProducts((d.products || []).filter(p => p.enabled !== false)))
      .catch(() => setProducts([]));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.uid, community?.id, customerId]);

  const taggedByProduct = new Map((services || []).map(s => [s.product_id, s]));
  const taggedIds = new Set(taggedByProduct.keys());
  const untagged = products.filter(p => !taggedIds.has(p.id));

  const onAdd = async (product) => {
    setBusyId(product.id); setErr(''); setMsg('');
    try {
      const r = await taxApi.adminAddCustomerService(auth, customerId, { productId: product.id });
      const name = pickI18n(product.name_i18n, locale).value || product.slug;
      setMsg(r.tasksCreated
        ? t('owner.customer.services.addedWithTasks', { count: r.tasksCreated, name })
        : t('owner.customer.services.addedNamed', { name }));
      load();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusyId(null); }
  };
  const onRemove = async (link) => {
    const name = pickI18n(link.product?.name_i18n, locale).value || link.product?.slug || '';
    if (!window.confirm(t('owner.customer.services.removeConfirm', { name }))) return;
    setBusyId(link.id); setErr(''); setMsg('');
    try {
      const r = await taxApi.adminRemoveCustomerService(auth, customerId, link.id);
      setMsg(r.tasksDeleted
        ? t('owner.customer.services.removedWithTasks', { count: r.tasksDeleted, name })
        : t('owner.customer.services.removedNamed', { name }));
      load();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusyId(null); }
  };

  return (
    <section style={{ marginTop: 8 }}>
      <p className="tax-section__lede" style={{ marginTop: 0, marginBottom: 12 }}>
        {t('owner.customer.section.servicesHint')}
      </p>

      {err && <div className="tax-msg tax-msg--error" style={{ marginBottom: 8 }}>{err}</div>}
      {msg && <div className="tax-msg" style={{
        background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
        borderLeft: '3px solid var(--tax-brand-primary)', padding: '6px 10px',
        fontSize: 13, marginBottom: 8,
      }}>{msg}</div>}

      {services === null ? <p style={{ color: 'var(--tax-muted)' }}>{t('loading')}</p>
        : (
          <>
            <div style={{
              fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
              textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6,
            }}>
              {t('owner.customer.services.taggedHeading')}
            </div>
            {services.length === 0 ? (
              <p style={{ color: 'var(--tax-muted)', fontSize: 13, marginBottom: 14 }}>
                {t('owner.customer.services.empty')}
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {services.map(link => {
                  const name = pickI18n(link.product?.name_i18n, locale).value || link.product?.slug || '';
                  const isBusy = busyId === link.id;
                  return (
                    <span key={link.id} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '4px 4px 4px 12px', borderRadius: 999,
                      background: 'color-mix(in srgb, var(--tax-brand-primary) 14%, #fff)',
                      color: 'var(--tax-brand-primary)',
                      border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 28%, #fff)',
                      fontSize: 13, fontWeight: 600,
                      opacity: isBusy ? 0.5 : 1,
                    }}>
                      {name}
                      <button type="button"
                              onClick={() => onRemove(link)} disabled={isBusy}
                              aria-label={t('owner.customer.services.remove')}
                              style={{
                                border: 0, background: 'transparent',
                                color: 'var(--tax-brand-primary)',
                                cursor: isBusy ? 'wait' : 'pointer',
                                padding: '0 6px',
                                fontSize: 16, lineHeight: 1, fontWeight: 700,
                              }}>×</button>
                    </span>
                  );
                })}
              </div>
            )}

            {untagged.length > 0 && (
              <>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: 'var(--tax-muted)',
                  textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6,
                }}>
                  {t('owner.customer.services.availableHeading')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {untagged.map(p => {
                    const name = pickI18n(p.name_i18n, locale).value || p.slug;
                    const isBusy = busyId === p.id;
                    return (
                      <button key={p.id} type="button"
                              onClick={() => onAdd(p)} disabled={isBusy}
                              style={{
                                padding: '4px 12px', borderRadius: 999,
                                background: '#fff',
                                color: 'var(--tax-text)',
                                border: '1px solid var(--tax-border)',
                                fontSize: 13, fontWeight: 500,
                                cursor: isBusy ? 'wait' : 'pointer',
                                opacity: isBusy ? 0.5 : 1,
                              }}>
                        + {name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {untagged.length === 0 && services.length > 0 && (
              <p style={{ color: 'var(--tax-muted)', fontSize: 12, marginTop: 4 }}>
                {t('owner.customer.services.allTagged')}
              </p>
            )}
          </>
        )}
    </section>
  );
}
