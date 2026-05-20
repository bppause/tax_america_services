import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { useEmployeeAuth } from '../auth/EmployeeAuthProvider';
import { taxApi } from '../api';
import EmployeeShell from '../components/EmployeeShell';
import { displayPersonName } from '../lib/personName';

// Display statuses surface in the inbox. The DB still permits 'contacted'
// for back-compat with legacy rows; we bucket those into "open" alongside
// 'new' so a simplified UI flow (convert ↔ close) doesn't lose them.
const STATUS_VALUES = ['new', 'converted', 'closed'];

// Standard close-reason options. The "Other" bucket lets the owner write
// a free-text note so a reason that isn't in the preset list isn't lost.
const CLOSE_REASONS = ['not_interested', 'no_response', 'duplicate', 'out_of_scope', 'spam', 'other'];

export default function OwnerLeads() {
  const { locale, t } = useT();
  const { fbUser, employee, community } = useEmployeeAuth();
  const auth = { uid: fbUser?.uid, email: fbUser?.email, communitySlug: community?.id };

  // The lead-arrival notification email deep-links here as
  // `…/employee/leads?lead=<id>` so the recipient lands directly on
  // the row instead of having to scan the inbox.
  const focusLeadId = (() => {
    try { return new URLSearchParams(window.location.search).get('lead') || ''; }
    catch { return ''; }
  })();

  const [leads, setLeads] = useState(null);
  // Force the filter to "all" when we have a target lead so the row
  // never gets hidden by the current filter (closed / converted / etc).
  const [filter, setFilter] = useState(focusLeadId ? 'all' : 'open'); // 'open' = new|contacted, 'all', or specific status
  // Customer-type chip filter — mirrors the customer-list one so the
  // two surfaces feel like the same product.
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'individual' | 'business'
  // Business-name fragment input that surfaces only when typeFilter
  // is 'business' so the inbox can narrow to a single company.
  const [businessNameInput, setBusinessNameInput] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [products, setProducts] = useState([]);
  const [relTypes, setRelTypes] = useState([]);
  const [err, setErr] = useState('');

  // Debounce the business-name input so each keystroke doesn't refetch.
  useEffect(() => {
    const id = setTimeout(() => setBusinessName(businessNameInput.trim()), 300);
    return () => clearTimeout(id);
  }, [businessNameInput]);

  const load = () => {
    if (!fbUser || !community) return;
    const opts = {};
    // 'open' is a virtual bucket — fetch all and filter client-side.
    if (STATUS_VALUES.includes(filter)) opts.status = filter;
    if (typeFilter !== 'all') opts.customerType = typeFilter;
    if (typeFilter === 'business' && businessName) opts.businessName = businessName;
    taxApi.adminListLeads(auth, community.id, opts)
      .then(d => setLeads(d.leads || []))
      .catch(e => setErr(e?.message || t('error.loadFailed')));
  };
  useEffect(load, [fbUser, community, filter, typeFilter, businessName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Products + relationship types — needed by the convert dialog to
  // suggest relationships based on the lead's requested services.
  useEffect(() => {
    if (!fbUser || !community) return;
    Promise.all([
      taxApi.adminListProducts(auth, community.id).catch(() => ({ products: [] })),
      taxApi.adminListRelationshipTypes(auth, { communitySlug: community.id }).catch(() => ({ types: [] })),
    ]).then(([p, r]) => {
      setProducts(p.products || []);
      setRelTypes((r.types || []).filter(rt => rt.active !== false));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbUser, community]);

  if (employee && employee.role !== 'admin') {
    return <EmployeeShell community={community}>
      <div className="tax-msg tax-msg--error">{t('owner.notAuthorized')}</div>
    </EmployeeShell>;
  }

  const shown = !leads ? null
    : (filter === 'open' ? leads.filter(l => l.status === 'new' || l.status === 'contacted') : leads);

  return (
    <EmployeeShell community={community} active="leads">
      <h2 style={{ marginTop: 0 }}>{t('owner.leads.title')}</h2>
      <p className="tax-section__lede">{t('owner.leads.subtitle')}</p>

      {err && <div className="tax-msg tax-msg--error">{err}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {[
          { id: 'open',      labelKey: 'owner.leads.filter.open' },
          { id: 'converted', labelKey: 'owner.leads.filter.converted' },
          { id: 'closed',    labelKey: 'owner.leads.filter.closed' },
          { id: 'all',       labelKey: 'owner.leads.filter.all' },
        ].map(f => (
          <button key={f.id} type="button"
                  className={`tax-btn tax-btn--sm ${filter === f.id ? 'tax-btn--primary' : 'tax-btn--ghost'}`}
                  onClick={() => setFilter(f.id)}
                  style={filter !== f.id ? { color: 'var(--tax-text)', borderColor: 'var(--tax-border)' } : undefined}>
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      {/* Customer-type chip row. Mirrors the customer list so the two
          inboxes feel like the same product. When 'business' is on,
          a business-name fragment input also surfaces so the owner
          can narrow to a specific company without scanning the list. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {[
          { key: 'all',        label: t('owner.customers.typeFilter.all') },
          { key: 'individual', label: t('owner.customers.customerType.individual') },
          { key: 'business',   label: t('owner.customers.customerType.business') },
        ].map(opt => {
          const active = typeFilter === opt.key;
          return (
            <button key={opt.key} type="button"
                    onClick={() => setTypeFilter(opt.key)}
                    style={{
                      padding: '4px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                      background: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                        : '#fff',
                      color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                      border: '1px solid',
                      borderColor: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                        : 'var(--tax-border)',
                      fontWeight: active ? 700 : 500,
                    }}>
              {opt.label}
            </button>
          );
        })}
        {typeFilter === 'business' && (
          <input type="search"
                 placeholder={t('owner.leads.businessNameFilter.placeholder')}
                 value={businessNameInput}
                 onChange={e => setBusinessNameInput(e.target.value)}
                 style={{
                   marginLeft: 4, flex: '1 1 200px', minWidth: 200,
                   padding: '6px 10px', border: '1px solid var(--tax-border)',
                   borderRadius: 999, fontSize: 13,
                 }} />
        )}
      </div>

      {shown === null ? <p>{t('loading')}</p>
        : shown.length === 0
          ? <p style={{ color: 'var(--tax-muted)' }}>{t('owner.leads.empty')}</p>
          : <div style={{ display: 'grid', gap: 8 }}>
              {shown.map(lead => (
                <LeadRow key={lead.id} lead={lead} auth={auth} onChange={load}
                         communitySlug={community.id}
                         products={products} relTypes={relTypes}
                         focused={lead.id === focusLeadId}
                         locale={locale} t={t} />
              ))}
            </div>}
    </EmployeeShell>
  );
}

function statusBadge(status) {
  if (status === 'new' || status === 'contacted') return { bg: '#dbeafe', fg: '#1e40af' };
  if (status === 'converted')                     return { bg: '#dcfce7', fg: '#166534' };
  return { bg: '#f3f4f6', fg: '#4b5563' };
}

function statusLabel(status, t) {
  if (status === 'converted') return t('owner.leads.status.converted');
  if (status === 'closed')    return t('owner.leads.status.closed');
  return t('owner.leads.status.open');
}

function LeadRow({ lead, auth, onChange, communitySlug, products, relTypes, focused, locale, t }) {
  const [expanded, setExpanded] = useState(!!focused);
  const [notes, setNotes] = useState(lead.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [convertOpen, setConvertOpen] = useState(false);
  // The close affordance opens an inline reason picker rather than
  // closing immediately, so the owner is forced to record why this
  // lead didn't pan out (the simplified flow is convert-or-close).
  const [closing, setClosing] = useState(false);
  const b = statusBadge(lead.status);

  // When the user lands here from the new-lead notification email
  // (`?lead=<id>`), auto-expand the row and scroll it into view so
  // the lead they came to see is immediately readable.
  const rowRef = useRef(null);
  useEffect(() => {
    if (!focused || !rowRef.current) return;
    rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);

  const setStatus = async (next, extra = {}) => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminUpdateLead(auth, lead.id, { status: next, ...extra });
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };
  const saveNotes = async () => {
    setBusy(true); setErr('');
    try {
      await taxApi.adminUpdateLead(auth, lead.id, { notes });
      onChange();
    } catch (e) { setErr(e?.message || ''); }
    finally { setBusy(false); }
  };

  // Open the convert dialog. The dialog pre-selects relationships
  // based on the lead's requested product_slugs (translated via the
  // products list → linked relationship_types) and lets the owner
  // confirm/adjust before submitting. The server then creates the
  // customer, attaches relationships, and kicks off task generation
  // in a single request.
  const onConvert = () => setConvertOpen(true);

  return (
    <div ref={rowRef} className="tax-contact-item"
         style={focused ? {
           boxShadow: '0 0 0 2px color-mix(in srgb, var(--tax-brand-primary) 50%, transparent)',
         } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {displayPersonName(lead) || lead.email}
            {lead.customer_type === 'business' && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                color: 'var(--tax-brand-primary)',
                border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 30%, #fff)',
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
              }}>{t('owner.customers.customerType.business')}</span>
            )}
            {lead.company && (
              <span style={{ marginLeft: 8, fontWeight: 500, color: 'var(--tax-muted)' }}>
                · {lead.company}
              </span>
            )}
            <span style={{
              marginLeft: 8, padding: '1px 8px', borderRadius: 999,
              background: b.bg, color: b.fg, fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            }}>{statusLabel(lead.status, t)}</span>
            {lead.preferred_locale && (
              <span style={{ marginLeft: 6, color: 'var(--tax-muted)', fontSize: 11 }}>
                {lead.preferred_locale === 'en' ? 'EN' : 'ES'}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--tax-muted)', marginTop: 2 }}>
            <a href={`mailto:${lead.email}`}>{lead.email}</a>
            {lead.phone ? <> • {lead.phone}</> : null}
            {lead.whatsapp ? <> • WhatsApp {lead.whatsapp}</> : null}
            {(() => {
              const services = Array.isArray(lead.product_slugs) && lead.product_slugs.length
                ? lead.product_slugs
                : (lead.product_slug ? [lead.product_slug] : []);
              return services.length ? <> • {services.join(', ')}</> : null;
            })()}
            <> • {new Date(lead.created_at).toLocaleDateString()}</>
          </div>
        </div>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={() => setExpanded(x => !x)}
                style={{ color: 'var(--tax-text)' }}>
          {expanded ? t('owner.leads.collapse') : t('owner.leads.expand')}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, padding: 12, background: 'var(--tax-bg-alt)', borderRadius: 8 }}>
          {lead.message && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)', marginBottom: 4 }}>
                {t('owner.leads.message')}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55 }}>{lead.message}</div>
            </div>
          )}
          <div style={{ marginBottom: 12 }}>
            <label htmlFor={`ln-${lead.id}`} style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)', display: 'block', marginBottom: 4 }}>
              {t('owner.leads.notes')}
            </label>
            <textarea id={`ln-${lead.id}`} rows={3} value={notes}
                      onChange={e => setNotes(e.target.value)} maxLength={4000}
                      style={{
                        width: '100%', padding: 10, border: '1px solid var(--tax-border)',
                        borderRadius: 8, font: 'inherit', fontSize: 14,
                      }} />
            <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm" disabled={busy}
                    onClick={saveNotes}
                    style={{ marginTop: 6, color: 'var(--tax-text)' }}>
              {t('owner.leads.saveNotes')}
            </button>
          </div>

          {lead.status === 'closed' && (lead.close_reason || lead.close_reason_note) && (
            <div style={{
              marginBottom: 12, padding: 10, background: '#fff',
              border: '1px solid var(--tax-border)', borderRadius: 8,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)', marginBottom: 4 }}>
                {t('owner.leads.closeReason.heading')}
              </div>
              <div style={{ fontSize: 14 }}>
                {lead.close_reason
                  ? t(`owner.leads.closeReason.${lead.close_reason}`, { _: lead.close_reason })
                  : t('owner.leads.closeReason.other')}
              </div>
              {lead.close_reason_note && (
                <div style={{ marginTop: 4, fontSize: 13, color: 'var(--tax-muted)', whiteSpace: 'pre-wrap' }}>
                  {lead.close_reason_note}
                </div>
              )}
            </div>
          )}

          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          {closing && (
            <CloseReasonForm busy={busy} t={t}
                             onCancel={() => setClosing(false)}
                             onSubmit={async ({ reason, note }) => {
                               await setStatus('closed', { closeReason: reason, closeReasonNote: note });
                               setClosing(false);
                             }} />
          )}

          {!closing && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {lead.status !== 'converted' && (
                <button type="button" onClick={onConvert} disabled={busy}
                        className="tax-btn tax-btn--primary tax-btn--sm">
                  {t('owner.leads.action.convert')}
                </button>
              )}
              {lead.status === 'converted' && lead.converted_customer_id && (
                <a href={`/tax/${communitySlug}/employee/customers/${encodeURIComponent(lead.converted_customer_id)}`}
                   className="tax-btn tax-btn--ghost tax-btn--sm"
                   style={{ color: 'var(--tax-brand-primary)', borderColor: 'var(--tax-brand-primary)' }}>
                  {t('owner.leads.action.viewCustomer')}
                </a>
              )}
              {lead.status !== 'converted' && lead.status !== 'closed' && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={() => setClosing(true)} disabled={busy}
                        style={{ color: 'var(--tax-muted)' }}>
                  {t('owner.leads.action.close')}
                </button>
              )}
              {lead.status === 'closed' && (
                <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                        onClick={() => setStatus('new')} disabled={busy}
                        style={{ color: 'var(--tax-muted)' }}>
                  {t('owner.leads.action.reopen')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {convertOpen && (
        <ConvertLeadModal lead={lead} auth={auth}
                          communitySlug={communitySlug}
                          products={products} relTypes={relTypes}
                          locale={locale} t={t}
                          onClose={() => setConvertOpen(false)}
                          onDone={(customerId) => {
                            window.location.href =
                              `/tax/${communitySlug}/employee/customers/${encodeURIComponent(customerId)}`;
                          }} />
      )}
    </div>
  );
}

// Lead → Customer conversion dialog. Pre-selects relationship tags
// derived from the lead's product_slugs (each slug → tax_products
// row → linked tax_relationship_types row). Owner confirms or
// adjusts, then the convert endpoint creates the customer, attaches
// the relationships, and kicks off task generation in one call.
function ConvertLeadModal({ lead, auth, communitySlug, products, relTypes, locale, t, onClose, onDone }) {
  // Phase 4n.48: direct service tagging on lead convert. Map the
  // lead's requested product_slugs to product_ids and pre-select
  // them in the picker. No relationship hop.
  const requestedSlugs = Array.isArray(lead.product_slugs) && lead.product_slugs.length
    ? lead.product_slugs : (lead.product_slug ? [lead.product_slug] : []);
  const initialProductIds = (products || [])
    .filter(p => requestedSlugs.includes(p.slug))
    .map(p => p.id);

  const [selected, setSelected] = useState(new Set(initialProductIds));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const onSubmit = async (e) => {
    e?.preventDefault?.();
    setBusy(true); setErr('');
    try {
      const r = await taxApi.adminConvertLead(auth, lead.id, {
        productIds: Array.from(selected),
      });
      onDone(r.customerId);
    } catch (e) {
      setErr(e?.message || t('respond.error.generic'));
    } finally { setBusy(false); }
  };

  return (
    <div className="tax-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tax-modal__panel" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
        <button type="button" className="tax-modal__close"
                onClick={onClose} aria-label={t('preview.close')}>×</button>
        <h3 className="tax-modal__title">
          {t('owner.leads.convert.title', { name: displayPersonName(lead) || lead.email })}
        </h3>

        <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--tax-muted)' }}>
          {t('owner.leads.convert.identity')}: <strong>{lead.email}</strong>
          {lead.phone ? <> · {lead.phone}</> : null}
          {lead.whatsapp ? <> · WhatsApp {lead.whatsapp}</> : null}
        </div>

        <form onSubmit={onSubmit} className="tax-form" style={{ boxShadow: 'none', padding: 0, border: 0 }}>
          <div>
            <label style={{ fontWeight: 600 }}>{t('owner.leads.convert.services')}</label>
            <p style={{ margin: '4px 0 10px', fontSize: 12, color: 'var(--tax-muted)' }}>
              {t('owner.leads.convert.servicesHint')}
            </p>
            <div style={{ display: 'grid', gap: 6 }}>
              {(products || []).length === 0 && (
                <p style={{ color: 'var(--tax-muted)' }}>
                  {t('owner.leads.convert.noServices')}
                </p>
              )}
              {(products || []).filter(p => p.enabled !== false).map(p => {
                const isChecked = selected.has(p.id);
                const wasRequested = initialProductIds.includes(p.id);
                return (
                  <label key={p.id} style={{
                    display: 'flex', gap: 10, padding: '8px 10px',
                    border: '1px solid var(--tax-border)', borderRadius: 6,
                    background: isChecked
                      ? 'color-mix(in srgb, var(--tax-brand-primary) 7%, #fff)'
                      : '#fff',
                    cursor: 'pointer',
                  }}>
                    <input type="checkbox" checked={isChecked} disabled={busy}
                           onChange={() => toggle(p.id)} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>
                        {pickI18n(p.name_i18n, locale).value || p.slug}
                        {wasRequested && (
                          <span style={{
                            marginLeft: 8, padding: '1px 8px', borderRadius: 999,
                            background: 'color-mix(in srgb, var(--tax-brand-primary) 14%, #fff)',
                            color: 'var(--tax-brand-primary)',
                            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                          }}>{t('owner.leads.convert.requested')}</span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {err && <div className="tax-msg tax-msg--error">{err}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="tax-btn tax-btn--primary" disabled={busy}>
              {busy ? t('lead.submitting') : t('owner.leads.convert.submit')}
            </button>
            <button type="button" className="tax-btn tax-btn--ghost"
                    onClick={onClose} disabled={busy} style={{ color: 'var(--tax-text)' }}>
              {t('preview.close')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Inline reason picker shown when the owner clicks Close. Forces a
// reason selection so we have a record of why this lead didn't convert.
// "Other" turns the note field required-ish on the client; the server
// stores whatever comes through but the standard set keeps the data tidy.
function CloseReasonForm({ busy, t, onCancel, onSubmit }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const requireNote = reason === 'other';
  const canSubmit = !!reason && (!requireNote || note.trim().length > 0);

  const submit = (e) => {
    e?.preventDefault?.();
    if (!canSubmit || busy) return;
    onSubmit({ reason, note: note.trim() });
  };

  return (
    <form onSubmit={submit} style={{
      marginBottom: 12, padding: 12, background: '#fff',
      border: '1px solid var(--tax-border)', borderRadius: 8,
      display: 'grid', gap: 10,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
        {t('owner.leads.closeReason.prompt')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CLOSE_REASONS.map(r => {
          const active = reason === r;
          return (
            <button key={r} type="button"
                    onClick={() => setReason(r)}
                    disabled={busy}
                    style={{
                      padding: '4px 12px', borderRadius: 999,
                      background: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)'
                        : '#fff',
                      color: active ? 'var(--tax-brand-primary)' : 'var(--tax-text)',
                      border: '1px solid',
                      borderColor: active
                        ? 'color-mix(in srgb, var(--tax-brand-primary) 35%, #fff)'
                        : 'var(--tax-border)',
                      fontSize: 12, fontWeight: active ? 700 : 500, cursor: 'pointer',
                    }}>
              {t(`owner.leads.closeReason.${r}`)}
            </button>
          );
        })}
      </div>
      <div>
        <label htmlFor="lead-close-note" style={{ fontSize: 12, fontWeight: 600, color: 'var(--tax-muted)' }}>
          {requireNote
            ? t('owner.leads.closeReason.noteRequired')
            : t('owner.leads.closeReason.noteOptional')}
        </label>
        <textarea id="lead-close-note" rows={2} value={note}
                  onChange={e => setNote(e.target.value)} maxLength={4000}
                  disabled={busy}
                  style={{
                    width: '100%', padding: 8, marginTop: 4,
                    border: '1px solid var(--tax-border)', borderRadius: 6,
                    font: 'inherit', fontSize: 13,
                  }} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="tax-btn tax-btn--primary tax-btn--sm"
                disabled={!canSubmit || busy}>
          {busy ? t('lead.submitting') : t('owner.leads.closeReason.confirm')}
        </button>
        <button type="button" className="tax-btn tax-btn--ghost tax-btn--sm"
                onClick={onCancel} disabled={busy}
                style={{ color: 'var(--tax-text)' }}>
          {t('preview.close')}
        </button>
      </div>
    </form>
  );
}
