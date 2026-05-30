import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { taxApi } from '../api';

// AI-driven pre-sales chat widget.
// Props:
//   community       — community object (id, name, etc.)
//   products        — list of enabled products
//   preselectedProduct — product object to seed the AI context with (optional)
//   onClose         — called when user closes a standalone widget (optional)
//
// Flow:
//   1. Mounts → fetches initial AI greeting seeded with service context.
//   2. User types questions → AI answers, gathers info about their needs.
//   3. After a few exchanges the AI signals readiness via readyToConnect flag.
//   4. Contact mini-form appears; on submit the conversation is sent with the lead.
export default function LeadChatWidget({ community, products, preselectedProduct, onClose }) {
  const { locale, t } = useT();
  const [messages, setMessages] = useState([]); // {role, content}[]
  const [input, setInput]       = useState('');
  const [phase, setPhase]       = useState('chat'); // 'chat' | 'contact' | 'submitting' | 'done'
  const [aiLoading, setAiLoading] = useState(false);
  const [err, setErr]           = useState('');
  const [form, setForm]         = useState({
    firstName: '', lastName: '', email: '', phone: '',
    customerType: 'individual', company: '', website: '',
  });
  const [formErrs, setFormErrs] = useState({});
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // Scroll to latest message whenever messages change.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, phase]);

  // Kick off with an AI greeting on mount.
  useEffect(() => {
    const greeting = preselectedProduct
      ? (locale === 'es'
          ? `Hola, ¿en qué te puedo ayudar con el servicio de ${preselectedProduct.name_i18n?.es || preselectedProduct.name_i18n?.en || ''}?`
          : `Hi! I'm here to answer your questions about ${preselectedProduct.name_i18n?.en || preselectedProduct.name_i18n?.es || 'our services'}. What would you like to know?`)
      : (locale === 'es'
          ? '¡Hola! Soy el asistente virtual. ¿Sobre qué servicio tienes preguntas?'
          : "Hi! I'm the virtual assistant for " + community.name + ". What service can I help you with today?");
    setMessages([{ role: 'assistant', content: greeting }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        productSlug: preselectedProduct?.slug || '',
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
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());
    if (!emailOk) errs.email = t('lead.field.email') + ' is required';
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

    // Collect all requested services from the conversation context.
    const productSlugs = preselectedProduct
      ? [preselectedProduct.slug]
      : (products || []).filter(p => p.enabled !== false).map(p => p.slug).slice(0, 1);

    try {
      await taxApi.submitLead({
        communitySlug: community.id,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        customerType: form.customerType,
        company: form.company.trim(),
        productSlugs,
        locale,
        website: form.website,
        // Exclude the initial AI greeting from the transcript (it's boilerplate).
        aiConversation: messages.filter((_m, i) => !(i === 0 && messages[0].role === 'assistant')),
        message: '',
      });
      setPhase('done');
    } catch (e) {
      setErr(e?.message || t('error.generic'));
      setPhase('contact');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 340 }}>
      {/* Message thread */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '12px 4px', display: 'flex',
        flexDirection: 'column', gap: 10,
      }}>
        {messages.map((m, i) => (
          <ChatBubble key={i} role={m.role} content={m.content} />
        ))}
        {aiLoading && (
          <ChatBubble role="assistant" content="…" typing />
        )}
        {err && (
          <div style={{ fontSize: 13, color: 'var(--tax-error, #c0392b)', textAlign: 'center' }}>{err}</div>
        )}

        {/* Contact mini-form */}
        {(phase === 'contact' || phase === 'submitting') && (
          <div style={{
            border: '1px solid var(--tax-border)', borderRadius: 10,
            padding: 16, background: 'var(--tax-bg-alt)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 14 }}>
              {locale === 'es' ? '¿Cómo te contactamos?' : 'How should we reach you?'}
            </div>

            {/* Type toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {['individual', 'business'].map(ct => (
                <button key={ct} type="button"
                  onClick={() => setF('customerType', ct)}
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
              <Field label={t('lead.field.lastName')} value={form.lastName} onChange={v => setF('lastName', v)} err={formErrs.lastName} />
            </div>
            {form.customerType === 'business' && (
              <Field label={t('lead.field.businessName')} value={form.company} onChange={v => setF('company', v)} err={formErrs.company} style={{ marginBottom: 8 }} />
            )}
            <Field label={t('lead.field.email')} value={form.email} onChange={v => setF('email', v)} err={formErrs.email} type="email" style={{ marginBottom: 8 }} />
            <Field label={t('lead.field.phone.required')} value={form.phone} onChange={v => setF('phone', v)} err={formErrs.phone} type="tel" style={{ marginBottom: 8 }} />
            {/* honeypot */}
            <input type="text" tabIndex={-1} aria-hidden="true" value={form.website}
              onChange={e => setF('website', e.target.value)}
              style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
            <button type="button" className="tax-btn tax-btn--primary"
              onClick={submitContact} disabled={phase === 'submitting'}
              style={{ width: '100%', marginTop: 4 }}>
              {phase === 'submitting'
                ? (locale === 'es' ? 'Enviando…' : 'Sending…')
                : (locale === 'es' ? 'Enviar y conectar con el equipo →' : 'Send & connect with the team →')}
            </button>
          </div>
        )}

        {phase === 'done' && (
          <AppointmentHandoff community={community} locale={locale} />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row — hidden after contact form appears */}
      {phase === 'chat' && (
        <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--tax-border)' }}>
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={locale === 'es' ? 'Escribe tu pregunta…' : 'Ask a question…'}
            style={{
              flex: 1, padding: '8px 10px', border: '1px solid var(--tax-border)',
              borderRadius: 8, font: 'inherit', fontSize: 14, resize: 'none',
            }}
          />
          <button type="button" className="tax-btn tax-btn--primary"
            onClick={sendMessage} disabled={aiLoading || !input.trim()}
            style={{ alignSelf: 'flex-end', padding: '8px 16px' }}>
            {locale === 'es' ? 'Enviar' : 'Send'}
          </button>
        </div>
      )}

      {/* Prompt to show the contact form even if AI hasn't triggered it yet */}
      {phase === 'chat' && messages.length >= 3 && (
        <button type="button"
          onClick={() => setPhase('contact')}
          style={{
            marginTop: 8, background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 13, color: 'var(--tax-brand-primary, #1d3a6d)', textDecoration: 'underline',
            textAlign: 'center',
          }}>
          {locale === 'es' ? 'Ya tengo suficiente información — quiero contactar al equipo' : "I'm ready to connect with the team →"}
        </button>
      )}
    </div>
  );
}

function ChatBubble({ role, content, typing }) {
  const isUser = role === 'user';
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '80%', padding: '8px 12px', borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
        background: isUser ? 'var(--tax-brand-primary, #1d3a6d)' : 'var(--tax-bg-alt, #f4f5f7)',
        color: isUser ? '#fff' : 'var(--tax-text)',
        fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap',
        fontStyle: typing ? 'italic' : 'normal',
        opacity: typing ? 0.6 : 1,
      }}>
        {content}
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
          width: '100%', padding: '7px 10px', border: `1px solid ${err ? 'var(--tax-error, #c0392b)' : 'var(--tax-border)'}`,
          borderRadius: 6, font: 'inherit', fontSize: 14, boxSizing: 'border-box',
        }} />
      {err && <div style={{ fontSize: 11, color: 'var(--tax-error, #c0392b)', marginTop: 2 }}>{err}</div>}
    </div>
  );
}

// Shown after the lead submits their contact info. Priority order:
// 1. Book an appointment (Calendly) — strongest next step
// 2. WhatsApp the owner directly
// 3. Email the owner
// Always reassures them the owner will follow up either way.
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
      {/* Confirmation header */}
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

      {/* Next-step CTAs */}
      <div style={{ background: '#fff', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--tax-muted)', marginBottom: 2 }}>
          {es ? 'Agenda tu cita ahora' : 'Book your appointment now'}
        </div>

        {calendlyUrl && (
          <a href={calendlyUrl} target="_blank" rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              background: 'var(--tax-brand-primary, #1d3a6d)', color: '#fff',
              borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14,
            }}>
            <span style={{ fontSize: 18 }}>📅</span>
            <span>{es ? 'Reservar una cita →' : 'Book an appointment →'}</span>
          </a>
        )}

        {waHref && (
          <a href={waHref} target="_blank" rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              background: '#25d366', color: '#fff',
              borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14,
            }}>
            <span style={{ fontSize: 18 }}>💬</span>
            <span>{es ? 'Escribir por WhatsApp →' : 'Message us on WhatsApp →'}</span>
          </a>
        )}

        {emailHref && !calendlyUrl && (
          <a href={emailHref}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              background: 'var(--tax-bg-alt)', color: 'var(--tax-text)',
              borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 14,
              border: '1px solid var(--tax-border)',
            }}>
            <span style={{ fontSize: 18 }}>✉️</span>
            <span>{es ? 'Enviar un email →' : 'Send us an email →'}</span>
          </a>
        )}
      </div>
    </div>
  );
}
