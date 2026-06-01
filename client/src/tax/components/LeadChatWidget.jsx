import { useEffect, useRef, useState } from 'react';
import { pickI18n, useT } from '../i18n';
import { taxApi } from '../api';

// AI-driven pre-sales chat widget.
//
// Flow A — general (no preselectedProduct):
//   1. Service picker: lead taps 1+ service chips → "Ask about these →"
//   2. AI greeting focused on selected services → Q&A
//   3. AI signals readiness → inline contact form → appointment handoff
//
// Flow B — service-specific (preselectedProduct set from service modal):
//   1. Skip picker; AI greeting focused on that one service → Q&A
//   2. Same contact + handoff
export default function LeadChatWidget({ community, products, preselectedProduct }) {
  const { locale, t } = useT();
  const es = locale === 'es';

  // 'pick' → service selection step (only when no preselectedProduct)
  // 'chat' → AI conversation
  // 'contact' | 'submitting' | 'done' → handoff flow
  const [phase, setPhase] = useState(preselectedProduct ? 'chat' : 'pick');

  // Services the lead has selected (slugs). Starts with the preselected one if provided.
  const [selectedSlugs, setSelectedSlugs] = useState(
    preselectedProduct ? [preselectedProduct.slug] : []
  );

  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [err, setErr]             = useState('');
  // Restore saved contact info from a previous session on this device.
  const STORAGE_KEY = 'tax_ai_contact_v1';
  const savedContact = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  })();

  const [form, setForm]           = useState({
    firstName:    savedContact?.firstName    || '',
    lastName:     savedContact?.lastName     || '',
    email:        savedContact?.email        || '',
    phone:        savedContact?.phone        || '',
    customerType: savedContact?.customerType || 'individual',
    company:      savedContact?.company      || '',
    website: '',
  });
  const [formErrs, setFormErrs] = useState({});
  // true when saved info was found and the lead hasn't cleared it yet.
  const [usingRemembered, setUsingRemembered] = useState(!!savedContact);
  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const sessionRef = useRef(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

  const visibleProducts = (products || []).filter(p => p.enabled !== false);

  // Scroll to bottom when messages or phase change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase]);

  // Post the initial AI greeting when we enter 'chat' phase.
  useEffect(() => {
    if (phase !== 'chat') return;

    const realSelected = visibleProducts.filter(p => selectedSlugs.includes(p.slug));
    const nameList = realSelected.map(p =>
      pickI18n(p.name_i18n, locale).value || p.slug
    ).join(', ');
    const notSure = selectedSlugs.includes('__other__');

    const greeting = notSure
      ? (es
          ? `¡Hola! No hay problema si no estás seguro/a. Cuéntame un poco sobre tu situación — ¿eres particular o empresa, y qué necesitas resolver? Te ayudo a identificar el servicio adecuado.`
          : `Hi! No worries if you're not sure — tell me a bit about your situation. Are you an individual or a business, and what are you trying to solve? I'll help point you to the right service.`)
      : realSelected.length === 1
        ? (es
            ? `¡Hola! Estoy aquí para responder tus preguntas sobre **${nameList}**. ¿Qué te gustaría saber?`
            : `Hi! I'm here to answer your questions about **${nameList}**. What would you like to know?`)
        : (es
            ? `¡Hola! Puedo ayudarte con: **${nameList}**. ¿Por dónde quieres empezar?`
            : `Hi! I can help you with: **${nameList}**. Where would you like to start?`);

    setMessages([{ role: 'assistant', content: greeting }]);
    setTimeout(() => inputRef.current?.focus(), 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleSlug = (slug) => {
    setSelectedSlugs(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  const startChat = () => {
    if (selectedSlugs.length === 0) return;
    setPhase('chat');
  };

  // Real slugs excluding the synthetic "not sure" sentinel.
  const realSlugs = selectedSlugs.filter(s => s !== '__other__');
  const isUnsure  = selectedSlugs.includes('__other__');

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || aiLoading) return;
    setInput('');
    setErr('');
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setAiLoading(true);
    try {
      const res = await taxApi.chatWithAi({
        communitySlug: community.id,
        productSlug: realSlugs[0] || '',
        productSlugs: realSlugs,   // empty when "not sure" → AI covers all services
        messages: next,
      });
      const updated = [...next, { role: 'assistant', content: res.message }];
      setMessages(updated);
      if (res.readyToConnect) setPhase('contact');
    } catch (e) {
      setErr(e?.message || t('error.generic'));
    } finally {
      setAiLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const setF = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setFormErrs(fe => ({ ...fe, [k]: '' }));
  };

  const validateForm = () => {
    const errs = {};
    if (!form.firstName.trim()) errs.firstName = t('lead.field.firstName') + ' is required';
    if (!form.lastName.trim())  errs.lastName  = t('lead.field.lastName')  + ' is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = t('lead.field.email') + ' is required';
    if (!form.phone.trim()) errs.phone = t('lead.field.phone.required') + ' is required';
    if (form.customerType === 'business' && !form.company.trim()) errs.company = t('lead.field.businessName') + ' is required';
    return errs;
  };

  const submitContact = async () => {
    const errs = validateForm();
    if (Object.keys(errs).length) { setFormErrs(errs); return; }
    if (form.website) { setPhase('done'); return; } // honeypot
    setPhase('submitting');
    setErr('');
    // Use real selected slugs; if "not sure" was picked use all products.
    const productSlugs = realSlugs.length
      ? realSlugs
      : visibleProducts.map(p => p.slug).slice(0, 3);
    try {
      await taxApi.submitLead({
        communitySlug: community.id,
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        email:     form.email.trim().toLowerCase(),
        phone:     form.phone.trim(),
        customerType: form.customerType,
        company:   form.company.trim(),
        productSlugs,
        locale,
        website:   form.website,
        // Exclude the opening AI greeting (boilerplate) from the transcript.
        aiConversation: messages.filter((_m, i) => !(i === 0 && messages[0].role === 'assistant')),
        message: '',
      });
      // Persist contact info so returning users don't have to re-type it.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          firstName:    form.firstName.trim(),
          lastName:     form.lastName.trim(),
          email:        form.email.trim().toLowerCase(),
          phone:        form.phone.trim(),
          customerType: form.customerType,
          company:      form.company.trim(),
        }));
      } catch { /* ignore storage errors */ }
      setPhase('done');
    } catch (e) {
      setErr(e?.message || t('error.generic'));
      setPhase('contact');
    }
  };

  const clearRemembered = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setUsingRemembered(false);
    setForm({ firstName: '', lastName: '', email: '', phone: '', customerType: 'individual', company: '', website: '' });
    setFormErrs({});
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // Step 1: service picker (general widget only)
  if (phase === 'pick') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 340 }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 4px' }}>
          {/* Practice identity header */}
          <PracticeHeader community={community} />
          {/* AI-style opening bubble */}
          <ChatBubble role="assistant" content={
            es
              ? `¡Hola! Soy el asistente virtual de **${community.name}**.\n\n¿Sobre qué servicio(s) tienes preguntas? Selecciona uno o varios y te ayudaré al instante.`
              : `Hi! I'm the AI assistant for **${community.name}**.\n\nWhich service(s) do you have questions about? Select one or more and I'll answer them right away.`
          } />

          {/* Service chip grid */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
            {visibleProducts.map(p => {
              const name = pickI18n(p.name_i18n, locale).value || p.slug;
              const selected = selectedSlugs.includes(p.slug);
              return (
                <button key={p.slug} type="button"
                  onClick={() => toggleSlug(p.slug)}
                  style={{
                    padding: '7px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
                    fontWeight: selected ? 700 : 500,
                    border: `1.5px solid ${selected ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-border)'}`,
                    background: selected ? 'var(--tax-brand-primary, #1d3a6d)' : '#fff',
                    color: selected ? '#fff' : 'var(--tax-text)',
                    transition: 'all .12s',
                  }}>
                  {selected ? '✓ ' : ''}{name}
                </button>
              );
            })}
            {/* "Not sure" escape hatch — selects all services so the AI can help narrow down */}
            {(() => {
              const OTHER = '__other__';
              const selected = selectedSlugs.includes(OTHER);
              return (
                <button type="button"
                  onClick={() => {
                    if (selected) {
                      setSelectedSlugs([]);
                    } else {
                      // Select "other" exclusively; clear any specific picks
                      setSelectedSlugs([OTHER]);
                    }
                  }}
                  style={{
                    padding: '7px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
                    fontWeight: selected ? 700 : 500,
                    border: `1.5px dashed ${selected ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-border)'}`,
                    background: selected ? 'color-mix(in srgb, var(--tax-brand-primary) 10%, #fff)' : '#fff',
                    color: selected ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-muted)',
                    transition: 'all .12s',
                  }}>
                  {selected ? '✓ ' : ''}{es ? 'No estoy seguro/a' : 'Not sure / Other'}
                </button>
              );
            })()}
          </div>

          {selectedSlugs.length > 0 && (
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--tax-muted)' }}>
              {es
                ? `Seleccionado: ${selectedSlugs.length} servicio${selectedSlugs.length > 1 ? 's' : ''}`
                : `Selected: ${selectedSlugs.length} service${selectedSlugs.length > 1 ? 's' : ''}`}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div style={{ paddingTop: 10, borderTop: '1px solid var(--tax-border)' }}>
          <button type="button" className="tax-btn tax-btn--primary"
            onClick={startChat}
            disabled={selectedSlugs.length === 0}
            style={{ width: '100%' }}>
            {es ? 'Preguntar sobre estos servicios →' : 'Ask about these services →'}
          </button>
        </div>
      </div>
    );
  }

  // Steps 2-4: chat → contact → done
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 340 }}>
      {/* Selected-services bar */}
      {selectedSlugs.length > 0 && phase === 'chat' && (
        <div style={{
          display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
          padding: '6px 0 8px', borderBottom: '1px solid var(--tax-border)', marginBottom: 4,
        }}>
          <span style={{ fontSize: 11, color: 'var(--tax-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
            {es ? 'Sobre:' : 'Topic:'}
          </span>
          {isUnsure ? (
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
              background: 'color-mix(in srgb, var(--tax-brand-primary) 8%, #fff)',
              color: 'var(--tax-brand-primary)',
              border: '1px dashed color-mix(in srgb, var(--tax-brand-primary) 25%, #fff)',
            }}>{es ? 'No estoy seguro/a' : 'Not sure / Other'}</span>
          ) : realSlugs.map(slug => {
            const p = visibleProducts.find(x => x.slug === slug);
            const name = p ? (pickI18n(p.name_i18n, locale).value || slug) : slug;
            return (
              <span key={slug} style={{
                fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
                background: 'color-mix(in srgb, var(--tax-brand-primary) 12%, #fff)',
                color: 'var(--tax-brand-primary)',
                border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 25%, #fff)',
              }}>{name}</span>
            );
          })}
          {!preselectedProduct && (
            <button type="button" onClick={() => setPhase('pick')}
              style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer',
                       color: 'var(--tax-muted)', textDecoration: 'underline', padding: 0 }}>
              {es ? 'cambiar' : 'change'}
            </button>
          )}
        </div>
      )}

      {/* Message thread */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map((m, i) => (
          <ChatBubble key={i} role={m.role} content={m.content} />
        ))}
        {aiLoading && <ChatBubble role="assistant" content="…" typing />}
        {err && (
          <div style={{ fontSize: 13, color: 'var(--tax-error, #c0392b)', textAlign: 'center' }}>{err}</div>
        )}

        {/* Contact mini-form */}
        {(phase === 'contact' || phase === 'submitting') && (
          <div style={{ border: '1px solid var(--tax-border)', borderRadius: 10, overflow: 'hidden', background: 'var(--tax-bg-alt)' }}>
            {/* Who they're connecting with */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', background: 'var(--tax-brand-primary, #1d3a6d)', color: '#fff',
            }}>
              {community.logo_url && (
                <img src={community.logo_url} alt={community.name}
                  style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'contain', background: '#fff', padding: 2 }} />
              )}
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{community.name}</div>
                <div style={{ fontSize: 11, opacity: .85 }}>
                  {es ? 'Te responderemos por email o WhatsApp' : 'We\'ll reply via email or WhatsApp'}
                </div>
              </div>
            </div>
            <div style={{ padding: 14 }}>
            {usingRemembered && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8,
                padding: '8px 12px', marginBottom: 12, gap: 8,
              }}>
                <span style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>
                  👋 {es ? `Bienvenido/a de nuevo, ${form.firstName}!` : `Welcome back, ${form.firstName}!`}
                  <span style={{ fontWeight: 400, marginLeft: 6 }}>
                    {es ? 'Tu información está pre-llenada.' : 'Your info is pre-filled.'}
                  </span>
                </span>
                <button type="button" onClick={clearRemembered}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
                           color: '#166534', textDecoration: 'underline', whiteSpace: 'nowrap', padding: 0 }}>
                  {es ? '¿No eres tú?' : 'Not you?'}
                </button>
              </div>
            )}
            <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>
              {es ? '¿Cómo te contactamos?' : 'How should we reach you?'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {['individual', 'business'].map(ct => (
                <button key={ct} type="button" onClick={() => setF('customerType', ct)}
                  style={{
                    padding: '5px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
                    border: '1.5px solid var(--tax-brand-primary, #1d3a6d)',
                    background: form.customerType === ct ? 'var(--tax-brand-primary, #1d3a6d)' : 'transparent',
                    color: form.customerType === ct ? '#fff' : 'var(--tax-brand-primary, #1d3a6d)',
                    fontWeight: 600,
                  }}>
                  {t(`lead.field.customerType.${ct}`)}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <Field label={t('lead.field.firstName')} value={form.firstName} onChange={v => setF('firstName', v)} err={formErrs.firstName} />
              <Field label={t('lead.field.lastName')}  value={form.lastName}  onChange={v => setF('lastName', v)}  err={formErrs.lastName} />
            </div>
            {form.customerType === 'business' && (
              <Field label={t('lead.field.businessName')} value={form.company} onChange={v => setF('company', v)} err={formErrs.company} style={{ marginBottom: 8 }} />
            )}
            <Field label={t('lead.field.email')}          value={form.email}  onChange={v => setF('email', v)}  err={formErrs.email}  type="email" style={{ marginBottom: 8 }} />
            <Field label={t('lead.field.phone.required')} value={form.phone}  onChange={v => setF('phone', v)}  err={formErrs.phone}  type="tel"   style={{ marginBottom: 8 }} />
            <input type="text" tabIndex={-1} aria-hidden="true" value={form.website}
              onChange={e => setF('website', e.target.value)}
              style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
            <button type="button" className="tax-btn tax-btn--primary"
              onClick={submitContact} disabled={phase === 'submitting'}
              style={{ width: '100%', marginTop: 4 }}>
              {phase === 'submitting'
                ? (es ? 'Enviando…' : 'Sending…')
                : (es ? `Conectar con ${community.name} →` : `Connect with ${community.name} →`)}
            </button>
            </div>{/* /padding wrapper */}
          </div>
        )}

        {phase === 'done' && <AppointmentHandoff community={community} locale={locale} />}
        <div ref={bottomRef} />
      </div>

      {/* Text input — hidden once contact form is showing */}
      {phase === 'chat' && (
        <>
          <div style={{ fontSize: 10, color: 'var(--tax-muted)', textAlign: 'center', padding: '6px 8px 0', lineHeight: 1.4 }}>
            {es
              ? 'Este asistente de IA ofrece información general. No constituye asesoramiento legal ni fiscal.'
              : 'This AI assistant provides general information only and does not constitute legal or tax advice.'}
          </div>
          <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--tax-border)' }}>
            <textarea ref={inputRef} rows={2} value={input}
              onChange={e => setInput(e.target.value)} onKeyDown={onKey}
              placeholder={es ? 'Escribe tu pregunta…' : 'Ask a question…'}
              style={{
                flex: 1, padding: '8px 10px', border: '1px solid var(--tax-border)',
                borderRadius: 8, font: 'inherit', fontSize: 14, resize: 'none',
              }} />
            <button type="button" className="tax-btn tax-btn--primary"
              onClick={sendMessage} disabled={aiLoading || !input.trim()}
              style={{ alignSelf: 'flex-end', padding: '8px 16px' }}>
              {es ? 'Enviar' : 'Send'}
            </button>
          </div>
          {messages.length >= 3 && (
            <button type="button" onClick={() => setPhase('contact')}
              style={{
                marginTop: 8, background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, color: 'var(--tax-brand-primary, #1d3a6d)',
                textDecoration: 'underline', textAlign: 'center',
              }}>
              {es ? 'Listo para contactar al equipo →' : "I'm ready to connect with the team →"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ChatBubble({ role, content, typing }) {
  const isUser = role === 'user';
  // Render **bold** markdown in assistant messages (service names).
  const html = !isUser && content
    ? content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>')
    : null;
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '82%', padding: '8px 12px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
        background: isUser ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-bg-alt, #f4f5f7)',
        color: isUser ? '#fff' : 'var(--tax-text)',
        fontSize: 14, lineHeight: 1.5,
        fontStyle: typing ? 'italic' : 'normal',
        opacity: typing ? 0.6 : 1,
        whiteSpace: isUser ? 'pre-wrap' : undefined,
      }}
        dangerouslySetInnerHTML={html ? { __html: html } : undefined}>
        {html ? undefined : content}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, err, type = 'text', style }) {
  return (
    <div style={style}>
      <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 3, color: 'var(--tax-muted)' }}>
        {label}
      </label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', padding: '7px 10px',
          border: `1px solid ${err ? 'var(--tax-error, #c0392b)' : 'var(--tax-border)'}`,
          borderRadius: 6, font: 'inherit', fontSize: 14, boxSizing: 'border-box',
        }} />
      {err && <div style={{ fontSize: 11, color: 'var(--tax-error, #c0392b)', marginTop: 2 }}>{err}</div>}
    </div>
  );
}

// Small branded header shown at the top of the picker so the lead
// immediately knows whose assistant they're talking to.
function PracticeHeader({ community }) {
  if (!community) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', marginBottom: 10,
      background: 'color-mix(in srgb, var(--tax-brand-primary) 6%, #fff)',
      border: '1px solid color-mix(in srgb, var(--tax-brand-primary) 18%, #fff)',
      borderRadius: 8,
    }}>
      {community.logo_url && (
        <img src={community.logo_url} alt={community.name}
          style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }} />
      )}
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--tax-brand-primary, #1d3a6d)' }}>
          {community.name}
        </div>
        <div style={{ fontSize: 11, color: 'var(--tax-muted)' }}>
          🤖 AI assistant · powered by Claude
        </div>
      </div>
    </div>
  );
}

function AppointmentHandoff({ community, locale }) {
  const es = locale === 'es';
  const waDigits = String(community?.whatsapp || community?.phone || '')
    .replace(/^\+/, '').replace(/\D+/g, '');
  const waHref = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(
        es ? `Hola, acabo de enviar mis datos en el chat de ${community.name}. Me gustaría coordinar una cita.`
           : `Hi, I just submitted my info in the ${community.name} chat. I'd love to schedule an appointment.`
      )}`
    : null;
  const emailHref = community?.contact_email
    ? `mailto:${community.contact_email}?subject=${encodeURIComponent(
        es ? `Solicitud de cita — ${community.name}` : `Appointment request — ${community.name}`
      )}`
    : null;
  const calendlyUrl = community?.calendly_url || null;

  return (
    <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #2ecc71' }}>
      <div style={{ background: '#f0fff4', padding: '16px 16px 12px', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 6 }}>✓</div>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
          {es ? '¡Gracias! Hemos recibido tu información.' : 'Got it — we received your info!'}
        </div>
        <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>
          {es
            ? `${community?.name || 'El equipo'} te contactará por email o WhatsApp en menos de un día hábil.`
            : `${community?.name || 'The team'} will reach out via email or WhatsApp within one business day.`}
        </div>
      </div>
      <div style={{ background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--tax-muted)', marginBottom: 2 }}>
          {es ? 'Agenda tu cita ahora' : 'Book your appointment now'}
        </div>
        {calendlyUrl && (
          <a href={calendlyUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                     background: 'var(--tax-brand-primary, #1d3a6d)', color: '#fff',
                     borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>
            <span style={{ fontSize: 18 }}>📅</span>
            <span>{es ? 'Reservar una cita →' : 'Book an appointment →'}</span>
          </a>
        )}
        {waHref && (
          <a href={waHref} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                     background: '#25d366', color: '#fff',
                     borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14 }}>
            <span style={{ fontSize: 18 }}>💬</span>
            <span>{es ? 'Escribir por WhatsApp →' : 'Message us on WhatsApp →'}</span>
          </a>
        )}
        {emailHref && !calendlyUrl && (
          <a href={emailHref}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                     background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
                     borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14,
                     border: '1px solid var(--tax-border)' }}>
            <span style={{ fontSize: 18 }}>✉️</span>
            <span>{es ? 'Enviar un email →' : 'Send us an email →'}</span>
          </a>
        )}
      </div>
    </div>
  );
}
