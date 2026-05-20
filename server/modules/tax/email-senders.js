// Per-module email senders for the tax module.
//
// Recipient-language contract: every sender picks `lang` from the
// language preference of whoever RECEIVES the email, never from a
// third party in the metadata. Concretely:
//
//   • customer-facing senders (welcome, reminder, document, message,
//     signature request) read cust.locale
//   • staff-facing senders (welcome, task assigned, message-from-
//     customer, signature signed, daily digest) read employee.locale
//   • practice-level senders that go to community.contact_email
//     (lead notification, message-fallback-when-no-staff) read
//     community.default_locale — the address is owned by the
//     practice operator, not the lead/customer who triggered it.
//
// Anything that ends up undefined falls back to the platform default
// ('es') via the `=== 'en' ? 'en' : 'es'` shorthand each sender uses.
// Owner-editable subject + intro overrides via loadTaxEmailTemplate
// flow through the same lang value, so the override row is looked up
// in the recipient's language too.

'use strict';

const { escapeHtml } = require('../../core/utils');
const { firstNameOf, displayNameOf } = require('./names');

module.exports = function createTaxSenders(deps) {
  const { sendSpanishEmail, emailConfigured, loadTaxEmailTemplate, logTaxEmailDelivery, publicAppUrl } = deps;

  // Resolve the deployed app's base URL for clickable links in emails.
  // Falls through to empty string in tests so the helper never throws —
  // a missing publicAppUrl just produces a relative-looking link, which
  // is benign in HTML.
  const appBase = () => {
    try { return typeof publicAppUrl === 'function' ? publicAppUrl() : ''; }
    catch { return ''; }
  };

  // Phase 4i: owner-editable subject + intro paragraph per (template_key, lang).
  // Senders compute their defaults as before; if an override row exists and
  // is enabled, the subject / intro_text / intro_html are replaced with the
  // overridden values, after {{var}} substitution. Structural content
  // (bullets, CTAs, footers) stays hardcoded.
  async function loadOverride(communityId, key, lang) {
    if (typeof loadTaxEmailTemplate !== 'function' || !communityId) return null;
    try { return await loadTaxEmailTemplate(communityId, key, lang); }
    catch (_e) { return null; }
  }
  function interpolate(tpl, vars) {
    if (typeof tpl !== 'string' || !tpl) return tpl;
    return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => {
      const v = vars && Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : '';
      return v == null ? '' : String(v);
    });
  }
  // Apply per-field override: if the override field is non-empty after trim,
  // use it (interpolated); otherwise keep the default. Lets owners override
  // just the subject and leave the body as the system default, etc.
  async function applyOverride({ communityId, key, lang, vars, defaults }) {
    const ov = await loadOverride(communityId, key, lang);
    if (!ov) return defaults;
    const pick = (oField, dField) => {
      const s = (typeof ov[oField] === 'string' ? ov[oField] : '').trim();
      return s ? interpolate(ov[oField], vars || {}) : defaults[dField];
    };
    return {
      subject: pick('subject', 'subject'),
      text:    pick('body_text', 'text'),
      html:    pick('body_html', 'html'),
    };
  }

  const sendTaxLeadEmail = async ({ community, lead }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'Email not configured.' };
    const to = String(community?.contact_email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'Community has no contact_email.' };

    // Phase 4n.12: render the full set of services the lead picked. Prefer
    // product_slugs[] (new) and fall back to product_slug for legacy rows.
    const services = (Array.isArray(lead.product_slugs) && lead.product_slugs.length)
      ? lead.product_slugs
      : (lead.product_slug ? [lead.product_slug] : []);
    const servicesLabel = services.length ? services.join(', ') : '—';

    // Deep-link the inbox row so the recipient lands on the lead instead
    // of scrolling. OwnerLeads honors the `?lead=<id>` query param —
    // auto-expands the matching row and scrolls to it.
    const leadInboxUrl = `${appBase()}/tax/${encodeURIComponent(community.id)}/employee/leads?lead=${encodeURIComponent(lead.id)}`;

    const lines = [
      `New lead via ${community.name} landing page:`,
      '',
      `Name:    ${lead.name}`,
      `Email:   ${lead.email}`,
      `Phone:   ${lead.phone || '—'}`,
      `Services: ${servicesLabel}`,
      `Locale:  ${lead.preferred_locale}`,
      '',
      'Message:',
      lead.message || '(none)',
      '',
      `Open in app: ${leadInboxUrl}`,
      '',
      `Lead ID: ${lead.id}`,
      `Submitted: ${lead.created_at}`,
    ];
    const text = lines.join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px">
        <h2 style="margin-top:0">New lead — ${escapeHtml(community.name)}</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 8px;color:#555">Name</td><td style="padding:6px 8px"><strong>${escapeHtml(lead.name)}</strong></td></tr>
          <tr><td style="padding:6px 8px;color:#555">Email</td><td style="padding:6px 8px"><a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a></td></tr>
          <tr><td style="padding:6px 8px;color:#555">Phone</td><td style="padding:6px 8px">${escapeHtml(lead.phone || '—')}</td></tr>
          <tr><td style="padding:6px 8px;color:#555">Services</td><td style="padding:6px 8px">${escapeHtml(servicesLabel)}</td></tr>
          <tr><td style="padding:6px 8px;color:#555">Locale</td><td style="padding:6px 8px">${escapeHtml(lead.preferred_locale)}</td></tr>
        </table>
        <h3>Message</h3>
        <div style="white-space:pre-wrap;background:#f7f7f7;padding:12px;border-radius:8px">${escapeHtml(lead.message || '(none)')}</div>
        <p style="margin:20px 0">
          <a href="${escapeHtml(leadInboxUrl)}"
             style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1d3a6d;color:#fff;text-decoration:none;font-weight:600">
            Open this lead →
          </a>
        </p>
        <p style="color:#888;font-size:12px;margin-top:24px">Lead ID: ${escapeHtml(lead.id)}<br/>Submitted: ${escapeHtml(lead.created_at)}</p>
      </div>
    `;

    const defaults = {
      subject: `[${community.name}] New lead from ${lead.name}`,
      text, html,
    };
    const vars = {
      practice_name: community.name,
      lead_name: displayNameOf(lead) || lead.name || '',
      lead_first_name: firstNameOf(lead),
      lead_email: lead.email, lead_phone: lead.phone || '',
      lead_service: servicesLabel,             // backwards-compat alias
      lead_services: servicesLabel,            // new — preferred placeholder
      lead_locale: lead.preferred_locale,
      lead_message: lead.message || '', lead_id: lead.id, lead_submitted: lead.created_at,
    };
    // Recipient is the practice's contact_email, not the lead. Pick
    // the owner's own preferred language (community.default_locale)
    // so the subject + body arrive in the language the practice
    // reads — the lead's own language stays visible in the body as
    // metadata so the owner knows what language to reply in.
    const recipientLang = community?.default_locale === 'en' ? 'en' : 'es';
    const finalCopy = await applyOverride({
      communityId: community.id, key: 'lead',
      lang: recipientLang,
      vars, defaults,
    });
    return sendSpanishEmail({
      to,
      subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html,
      lang: recipientLang === 'en' ? 'en' : 'es-CO',
    });
  };

  // ── Reminder email (Phase 1.5) ───────────────────────────────────────────
  // Formal bilingual reminder asking the customer for the info needed to
  // complete a filing. Tone consciously formal per owner preference. Lang
  // chosen from cust.locale ('en' or 'es'); falls back to 'es'.
  //
  // Phase 4n: the default-building logic is factored into buildReminderEmail
  // so the admin preview route can render the same output without sending.
  function buildReminderEmail({ row, cust, sch, sub, magicUrl, offsetDays, tips, extraDocs, langOverride }) {
    const lang = langOverride === 'en' ? 'en'
      : langOverride === 'es' ? 'es'
      : (cust?.locale === 'en' ? 'en' : 'es');
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const filingName = pickName(sch.name_i18n, lang);
    const filingDesc = pickName(sch.description_i18n, lang);
    const checklist = effectiveChecklist(sub, sch, extraDocs);
    const formalGreeting = formalSalutation(cust.name, lang);
    const closing = (lang === 'en'
      ? 'Sincerely,\nTax America Services'
      : 'Atentamente,\nTax America Services');

    const daysWord = Math.abs(offsetDays) === 1
      ? (lang === 'en' ? 'day' : 'día')
      : (lang === 'en' ? 'days' : 'días');
    const subject = lang === 'en'
      ? `Reminder: ${filingName} due ${row.due_date} (${Math.abs(offsetDays)} ${daysWord} away)`
      : `Recordatorio: ${filingName} vence el ${row.due_date} (${Math.abs(offsetDays)} ${daysWord} restantes)`;

    const introLines = lang === 'en' ? [
      `${formalGreeting}`,
      ``,
      `This is a reminder that the filing "${filingName}" for the period ${row.period_label} is due on ${row.due_date}.`,
      filingDesc ? `${filingDesc}` : null,
      ``,
      `In order to prepare and submit this filing on your behalf, we will need the following information from you:`,
    ].filter(Boolean) : [
      `${formalGreeting}`,
      ``,
      `Le escribimos para recordarle que la declaración "${filingName}" correspondiente al período ${row.period_label} vence el ${row.due_date}.`,
      filingDesc ? `${filingDesc}` : null,
      ``,
      `Para poder preparar y presentar esta declaración en su nombre, necesitamos la siguiente información:`,
    ].filter(Boolean);

    const checklistTextLines = checklist.map(item =>
      `  • ${pickName(item.label_i18n, lang)}${item.required ? '' : (lang === 'en' ? ' (optional)' : ' (opcional)')}`);
    const checklistHtmlLines = checklist.map(item =>
      `<li>${escapeHtml(pickName(item.label_i18n, lang))}${item.required ? '' : `<span style="color:#666"> ${lang === 'en' ? '(optional)' : '(opcional)'}</span>`}</li>`);

    const ctaText = lang === 'en'
      ? `Please submit your information via the secure link below. The link is unique to this filing and will expire after the due date.`
      : `Por favor envíe su información usando el enlace seguro a continuación. El enlace es único para esta declaración y expirará después de la fecha de vencimiento.`;
    const ctaLabel = lang === 'en' ? 'Submit information' : 'Enviar información';

    // Phase 2c: relationship-aware tips, injected above the closing.
    const tipsArr = Array.isArray(tips) ? tips : [];
    const tipsHeading = lang === 'en' ? 'Helpful reminders for your services' : 'Recordatorios útiles para sus servicios';
    const tipsTextLines = tipsArr.map(t => `  • ${pickName(t.tip_i18n, lang)}`);
    const tipsHtml = tipsArr.length ? `
      <div style="margin:24px 0;padding:16px 18px;background:#f4f7fb;border-left:3px solid #1d3a6d;border-radius:6px">
        <div style="font-weight:600;margin-bottom:8px">${escapeHtml(tipsHeading)}</div>
        <ul style="margin:0;padding-left:20px">
          ${tipsArr.map(t => `<li style="margin:4px 0">${escapeHtml(pickName(t.tip_i18n, lang))}</li>`).join('')}
        </ul>
      </div>
    ` : '';

    const text = [
      ...introLines,
      ...checklistTextLines,
      ``,
      ctaText,
      magicUrl,
      ...(tipsTextLines.length ? [``, tipsHeading + ':', ...tipsTextLines] : []),
      ``,
      closing,
    ].join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${introLines.slice(2).filter(s => s !== '').map(escapeHtml).join('</p><p>')}</p>
        <ul>${checklistHtmlLines.join('')}</ul>
        <p>${escapeHtml(ctaText)}</p>
        <p style="margin:24px 0">
          <a href="${magicUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
        </p>
        <p style="color:#666;font-size:13px">${escapeHtml(magicUrl)}</p>
        ${tipsHtml}
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const defaults = { subject, text, html };
    const vars = {
      customer_name: displayNameOf(cust) || cust.name || '', customer_first_name: firstNameOf(cust), practice_name: 'Tax America Services',
      filing_name: filingName, filing_description: filingDesc || '',
      period_label: row.period_label, due_date: row.due_date,
      offset_days: Math.abs(offsetDays), magic_url: magicUrl,
    };
    return { lang, langTag, defaults, vars };
  }

  const sendTaxReminderEmail = async ({ row, cust, sch, sub, magicUrl, offsetDays, tips, extraDocs, workflowRuleId, skipLog }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    // Prefer the customer's chosen communication email (Phase 2e) when set;
    // otherwise fall back to the login email.
    const to = String(cust?.preferred_communication_email || cust?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'customer_email_missing' };

    const built = buildReminderEmail({ row, cust, sch, sub, magicUrl, offsetDays, tips, extraDocs });
    const finalCopy = await applyOverride({
      communityId: cust.community_id, key: 'reminder',
      lang: built.lang, vars: built.vars, defaults: built.defaults,
    });
    const result = await sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: built.langTag,
    });
    // Phase 4n: persist a row keyed by Resend's message id so the webhook
    // receiver can match incoming opened/clicked events back to a customer.
    // Phase 4n.8: also stamp workflow_rule_id so the per-workflow engagement
    // panel can aggregate without a 2-table join. `skipLog` is set by the
    // test-reminder route so dry-runs don't pollute the engagement numbers.
    if (result && result.sent && !skipLog && typeof logTaxEmailDelivery === 'function') {
      try {
        await logTaxEmailDelivery({
          resendId: result.id || '',
          outboundMessageId: result.messageId || '',
          communityId: cust.community_id || '',
          customerId: cust.id || '',
          workflowRuleId: workflowRuleId || row?.workflow_rule_id || '',
          eventType: 'reminder',
          recipients: [to],
          subject: finalCopy.subject,
          relatedEntity: 'tax.period',
          relatedId: row?.id || '',
        });
      } catch (_e) { /* logging must never break a send */ }
    }
    return result;
  };

  // Phase 4n.2: editable defaults for the Email Templates form. Returns the
  // raw template the owner edits — uses `{{var}}` placeholders instead of
  // substituted stub values, so the persisted text stays live (Maria García
  // doesn't get baked into every customer's email). Lives alongside
  // buildReminderEmail so the placeholder set stays in sync with the vars
  // map the sender builds at send time.
  //
  // Phase 4n.4: extended to every template key so the owner can preview /
  // edit ALL of them, not just `reminder`. The HTML kept intentionally
  // simple — these are starting points the owner edits; the sender's
  // hardcoded HTML still runs for fields the owner leaves empty.

  function wrapHtml(bodyHtml) {
    return `<div style="font-family:Arial,sans-serif;max-width:640px;color:#111">${bodyHtml}</div>`.trim();
  }
  function ctaButton(href, label) {
    return `<p style="margin:24px 0"><a href="${href}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${label}</a></p>`;
  }

  function buildReminderTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Dear {{customer_name}},' : 'Estimado/a {{customer_name}}:';
    const closing = useEn ? 'Sincerely,\n{{practice_name}}' : 'Atentamente,\n{{practice_name}}';
    const subject = useEn
      ? 'Reminder: {{filing_name}} due {{due_date}} ({{offset_days}} days away)'
      : 'Recordatorio: {{filing_name}} vence el {{due_date}} ({{offset_days}} días restantes)';
    const intro = useEn
      ? `This is a reminder that the filing "{{filing_name}}" for the period {{period_label}} is due on {{due_date}}.\n\n{{filing_description}}\n\nIn order to prepare and submit this filing on your behalf, we will need the information requested in your secure portal.`
      : `Le escribimos para recordarle que la declaración "{{filing_name}}" correspondiente al período {{period_label}} vence el {{due_date}}.\n\n{{filing_description}}\n\nPara poder preparar y presentar esta declaración en su nombre, necesitamos la información solicitada en su portal seguro.`;
    const ctaText = useEn
      ? 'Please submit your information via the secure link below. The link is unique to this filing and will expire after the due date.'
      : 'Por favor envíe su información usando el enlace seguro a continuación. El enlace es único para esta declaración y expirará después de la fecha de vencimiento.';
    const ctaLabel = useEn ? 'Submit information' : 'Enviar información';

    const text = [greeting, '', intro, '', ctaText, '{{magic_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      <p>${ctaText}</p>
      ${ctaButton('{{magic_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{magic_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildWelcomeCustomerTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Dear {{customer_name}},' : 'Estimado/a {{customer_name}}:';
    const closing = useEn ? 'Sincerely,\n{{practice_name}}' : 'Atentamente,\n{{practice_name}}';
    const subject = useEn
      ? 'Welcome to {{practice_name}}'
      : 'Bienvenido/a a {{practice_name}}';
    const intro = useEn
      ? `Welcome — your secure client portal at {{practice_name}} is ready. We've set up your account with the email {{customer_email}}.\n\nYour active services:\n{{relationships_list}}\n\nUse the portal to submit information, upload documents, message us, and download completed filings.`
      : `Bienvenido/a — su portal seguro en {{practice_name}} está listo. Hemos configurado su cuenta con el correo {{customer_email}}.\n\nServicios activos:\n{{relationships_list}}\n\nUse el portal para enviar información, subir documentos, escribirnos y descargar declaraciones finalizadas.`;
    const ctaLabel = useEn ? 'Open my portal' : 'Abrir mi portal';
    const text = [greeting, '', intro, '', '{{portal_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      ${ctaButton('{{portal_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{portal_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildWelcomeStaffTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Hi {{staff_name}},' : 'Hola {{staff_name}}:';
    const closing = useEn ? 'Thanks,\n{{practice_name}}' : 'Gracias,\n{{practice_name}}';
    const subject = useEn
      ? 'Your staff account at {{practice_name}}'
      : 'Su cuenta de personal en {{practice_name}}';
    const intro = useEn
      ? `You've been added to {{practice_name}} as {{role_label}}.\n\nSign in with {{staff_email}} to access the staff portal. If this is your first time, your Google or password login will be linked on first sign-in.`
      : `Le hemos agregado a {{practice_name}} como {{role_label}}.\n\nInicie sesión con {{staff_email}} para acceder al portal del personal. Si es su primera vez, su inicio de sesión con Google o contraseña se vinculará en el primer acceso.`;
    const ctaLabel = useEn ? 'Open staff portal' : 'Abrir portal del personal';
    const text = [greeting, '', intro, '', '{{employee_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      ${ctaButton('{{employee_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{employee_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildDocumentTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Dear {{customer_name}},' : 'Estimado/a {{customer_name}}:';
    const closing = useEn ? 'Sincerely,\n{{practice_name}}' : 'Atentamente,\n{{practice_name}}';
    const subject = useEn
      ? 'New document available in your portal — {{file_name}}'
      : 'Nuevo documento disponible en su portal — {{file_name}}';
    const intro = useEn
      ? `{{practice_name}} has uploaded a new document to your secure portal:\n\n  • {{file_name}}`
      : `{{practice_name}} ha cargado un documento nuevo en su portal seguro:\n\n  • {{file_name}}`;
    const ctaText = useEn
      ? `Please sign in to review and download it. If you have questions about this document, reply to this email or contact our office.`
      : `Por favor inicie sesión para revisarlo y descargarlo. Si tiene preguntas sobre este documento, responda a este correo o contacte a nuestra oficina.`;
    const ctaLabel = useEn ? 'Open my portal' : 'Abrir mi portal';
    const text = [greeting, '', intro, '', ctaText, '{{portal_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      <p>${ctaText}</p>
      ${ctaButton('{{portal_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{portal_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildMessageToCustomerTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Dear {{customer_name}},' : 'Estimado/a {{customer_name}}:';
    const closing = useEn ? 'Sincerely,\n{{practice_name}}' : 'Atentamente,\n{{practice_name}}';
    const subject = useEn
      ? 'New message from {{practice_name}}: {{thread_subject}}'
      : 'Nuevo mensaje de {{practice_name}}: {{thread_subject}}';
    const intro = useEn
      ? `{{author_name}} at {{practice_name}} has sent you a new message:\n\n{{message_preview}}`
      : `{{author_name}} de {{practice_name}} le ha enviado un nuevo mensaje:\n\n{{message_preview}}`;
    const ctaText = useEn
      ? 'Sign in to view the full thread and reply.'
      : 'Inicie sesión para ver la conversación completa y responder.';
    const ctaLabel = useEn ? 'Open my portal' : 'Abrir mi portal';
    const text = [greeting, '', intro, '', ctaText, '{{portal_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      <p>${ctaText}</p>
      ${ctaButton('{{portal_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{portal_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildMessageToPracticeTemplate(lang) {
    const useEn = lang === 'en';
    const subject = useEn
      ? 'New message from {{customer_name}}: {{thread_subject}}'
      : 'Nuevo mensaje de {{customer_name}}: {{thread_subject}}';
    const body = useEn
      ? `{{customer_name}} ({{customer_email}}) sent a new message on thread {{thread_id}}:\n\n{{message_preview}}\n\nReply through the staff portal — do not reply to this email directly.`
      : `{{customer_name}} ({{customer_email}}) envió un nuevo mensaje en la conversación {{thread_id}}:\n\n{{message_preview}}\n\nResponda a través del portal del personal — no responda directamente a este correo.`;
    const text = body;
    const html = wrapHtml(`<p style="white-space:pre-line">${body}</p>`);
    return { subject, text, html };
  }

  function buildMessageToEmployeeTemplate(lang) {
    const useEn = lang === 'en';
    const subject = useEn
      ? 'Customer message: {{customer_name}} — {{thread_subject}}'
      : 'Mensaje de cliente: {{customer_name}} — {{thread_subject}}';
    const body = useEn
      ? `Hi {{employee_name}},\n\n{{customer_name}} ({{customer_email}}) has posted a new message on the thread "{{thread_subject}}":\n\n{{message_preview}}\n\nReply through the staff portal — do not reply to this email directly.\n\n{{practice_name}}`
      : `Hola {{employee_name}}:\n\n{{customer_name}} ({{customer_email}}) publicó un nuevo mensaje en la conversación "{{thread_subject}}":\n\n{{message_preview}}\n\nResponda a través del portal del personal — no responda directamente a este correo.\n\n{{practice_name}}`;
    const html = wrapHtml(`<p style="white-space:pre-line">${body}</p>`);
    return { subject, text: body, html };
  }

  function buildLeadTemplate(lang) {
    const useEn = lang === 'en';
    const subject = useEn
      ? '[{{practice_name}}] New lead from {{lead_name}}'
      : '[{{practice_name}}] Nuevo prospecto de {{lead_name}}';
    const body = useEn
      ? `New lead via {{practice_name}} landing page:\n\nName:    {{lead_name}}\nEmail:   {{lead_email}}\nPhone:   {{lead_phone}}\nService: {{lead_service}}\nLocale:  {{lead_locale}}\n\nMessage:\n{{lead_message}}\n\nLead ID:   {{lead_id}}\nSubmitted: {{lead_submitted}}`
      : `Nuevo prospecto desde la página de {{practice_name}}:\n\nNombre:   {{lead_name}}\nCorreo:   {{lead_email}}\nTeléfono: {{lead_phone}}\nServicio: {{lead_service}}\nIdioma:   {{lead_locale}}\n\nMensaje:\n{{lead_message}}\n\nID:       {{lead_id}}\nEnviado:  {{lead_submitted}}`;
    const html = wrapHtml(`<p style="white-space:pre-line">${body}</p>`);
    return { subject, text: body, html };
  }

  // Returns the editable defaults for any known template_key. Each key has a
  // factored placeholder version so the Email Templates form prefills with
  // realistic starting text. `hasFactoredDefault` stays true for every known
  // key now that they're all wired.
  function buildSignatureRequestTemplate(lang) {
    const useEn = lang === 'en';
    const greeting = useEn ? 'Dear {{customer_name}},' : 'Estimado/a {{customer_name}}:';
    const closing = useEn ? 'Sincerely,\n{{practice_name}}' : 'Atentamente,\n{{practice_name}}';
    const subject = useEn
      ? 'Please review and sign: {{title}}'
      : 'Por favor revise y firme: {{title}}';
    const intro = useEn
      ? `{{practice_name}} has sent you a document to review and sign:\n\n  • {{title}}\n\n{{description}}`
      : `{{practice_name}} le ha enviado un documento para revisar y firmar:\n\n  • {{title}}\n\n{{description}}`;
    const ctaText = useEn
      ? 'Click the secure link below to review the details and sign by typing your legal name. The signature is captured with a timestamp and your IP for our records.'
      : 'Haga clic en el enlace seguro abajo para revisar los detalles y firmar escribiendo su nombre legal. La firma se registra con fecha y su dirección IP para nuestros archivos.';
    const ctaLabel = useEn ? 'Review and sign' : 'Revisar y firmar';
    const text = [greeting, '', intro, '', ctaText, '{{sign_url}}', '', closing].join('\n');
    const html = wrapHtml(`
      <p>${greeting}</p>
      <p style="white-space:pre-line">${intro}</p>
      <p>${ctaText}</p>
      ${ctaButton('{{sign_url}}', ctaLabel)}
      <p style="color:#666;font-size:13px">{{sign_url}}</p>
      <p style="white-space:pre-line">${closing}</p>
    `);
    return { subject, text, html };
  }

  function buildSignatureSignedTemplate(lang) {
    const useEn = lang === 'en';
    const subject = useEn
      ? '{{customer_name}} signed: {{title}}'
      : '{{customer_name}} firmó: {{title}}';
    const body = useEn
      ? `Hi {{employee_name}},\n\n{{customer_name}} ({{customer_email}}) just signed "{{title}}". The signature, timestamp, and IP have been captured in the audit trail.\n\nOpen the customer's record:\n{{customer_url}}\n\n{{practice_name}}`
      : `Hola {{employee_name}}:\n\n{{customer_name}} ({{customer_email}}) acaba de firmar "{{title}}". La firma, fecha y IP quedaron registradas en la pista de auditoría.\n\nAbrir el registro del cliente:\n{{customer_url}}\n\n{{practice_name}}`;
    const html = wrapHtml(`<p style="white-space:pre-line">${body}</p>`);
    return { subject, text: body, html };
  }

  const TEMPLATE_BUILDERS = {
    welcome_customer:    buildWelcomeCustomerTemplate,
    welcome_staff:       buildWelcomeStaffTemplate,
    reminder:            buildReminderTemplate,
    document:            buildDocumentTemplate,
    message_to_customer: buildMessageToCustomerTemplate,
    message_to_practice: buildMessageToPracticeTemplate,
    message_to_employee: buildMessageToEmployeeTemplate,
    lead:                buildLeadTemplate,
    signature_request:   buildSignatureRequestTemplate,
    signature_signed:    buildSignatureSignedTemplate,
  };
  function getTemplateDefaults({ key, lang }) {
    const useLang = lang === 'en' ? 'en' : 'es';
    const builder = TEMPLATE_BUILDERS[key];
    if (!builder) return { subject: '', text: '', html: '' };
    return builder(useLang);
  }

  // Phase 4n: pure helper for the admin preview route. Accepts an optional
  // unsaved override (subject/body_text/body_html) so the owner can preview
  // exactly what they're about to save. When `override` is null, the route
  // falls through to whatever's persisted in tax_email_templates.
  // Phase 4n.4: stub variable values for previewing every template key. The
  // owner sees realistic substituted text so {{customer_name}} etc. resolve
  // to plausible values in the modal, even though the stored template keeps
  // the placeholders intact.
  function previewStubVars(key, lang) {
    const useEn = lang === 'en';
    const customerName = useEn ? 'Maria García' : 'María García';
    const base = {
      customer_name: customerName,
      practice_name: 'Tax America Services',
      customer_email: 'maria@example.com',
      portal_url: 'https://example.com/tax/portal',
      employee_url: 'https://example.com/tax/employee',
      magic_url: 'https://example.com/tax/r/preview-magic-link',
    };
    const perKey = {
      welcome_customer: {
        relationships_list: useEn ? '  • Individual Tax\n  • Payroll' : '  • Impuestos Personales\n  • Nómina',
      },
      welcome_staff: {
        staff_name: useEn ? 'Carlos Mendoza' : 'Carlos Mendoza',
        staff_email: 'carlos@example.com',
        role: 'staff',
        role_label: useEn ? 'Staff' : 'Personal',
      },
      reminder: {
        filing_name: useEn ? 'Federal Estimated Income Tax (1040-ES)' : 'Impuesto Federal Estimado (1040-ES)',
        filing_description: useEn ? 'Quarterly estimated payment for the IRS.' : 'Pago estimado trimestral para el IRS.',
        period_label: useEn ? 'Q2 2026' : 'T2 2026',
        due_date: '2026-06-15',
        offset_days: 14,
      },
      document: {
        file_name: 'Tax_Return_2025.pdf',
      },
      message_to_customer: {
        thread_subject: useEn ? 'Question about your filing' : 'Pregunta sobre su declaración',
        author_name: useEn ? 'Carlos Mendoza' : 'Carlos Mendoza',
        message_preview: useEn ? 'Hi Maria — we noticed an item on your filing that needs clarification…' : 'Hola María — vimos un detalle en su declaración que requiere aclaración…',
      },
      message_to_practice: {
        thread_id: 'thr_abc12345',
        thread_subject: useEn ? 'Question about my W-2' : 'Pregunta sobre mi W-2',
        message_preview: useEn ? 'Hi — I just received my W-2 and have a question about box 12…' : 'Hola — acabo de recibir mi W-2 y tengo una pregunta sobre el cuadro 12…',
      },
      message_to_employee: {
        employee_name: useEn ? 'Carlos Mendoza' : 'Carlos Mendoza',
        thread_subject: useEn ? 'Question about my W-2' : 'Pregunta sobre mi W-2',
        message_preview: useEn ? 'Hi — I just received my W-2 and have a question about box 12…' : 'Hola — acabo de recibir mi W-2 y tengo una pregunta sobre el cuadro 12…',
      },
      lead: {
        lead_name: useEn ? 'David Park' : 'David Park',
        lead_email: 'david@example.com',
        lead_phone: '+1 555 0123',
        lead_service: 'individual-tax',
        lead_locale: lang,
        lead_message: useEn ? 'I just moved to Cartagena and need help with my US return.' : 'Acabo de mudarme a Cartagena y necesito ayuda con mi declaración de EE. UU.',
        lead_id: 'lead_preview123',
        lead_submitted: '2026-05-11T14:30:00Z',
      },
      signature_request: {
        title: useEn ? '2026 Engagement Letter' : 'Carta de compromiso 2026',
        description: useEn
          ? 'Standard engagement terms for the 2026 tax season.'
          : 'Términos estándar de compromiso para la temporada 2026.',
        sign_url: 'https://example.com/tax/portal/sign/sig_preview',
      },
      signature_signed: {
        employee_name: useEn ? 'Carlos Mendoza' : 'Carlos Mendoza',
        title: useEn ? '2026 Engagement Letter' : 'Carta de compromiso 2026',
        customer_url: 'https://example.com/tax/employee/customers/cust_preview',
      },
    };
    return { ...base, ...(perKey[key] || {}) };
  }

  async function previewTaxEmail({ key, lang, override, stub }) {
    // For every key except reminder we render the placeholder template +
    // override through interpolate(). For reminder we use the live builder
    // because its defaults are substituted rather than placeholders.
    if (key !== 'reminder') {
      const useLang = lang === 'en' ? 'en' : 'es';
      const defaults = getTemplateDefaults({ key, lang: useLang });
      const vars = previewStubVars(key, useLang);
      const pick = (oField, dField) => {
        const raw = override && typeof override[oField] === 'string' && override[oField].trim()
          ? override[oField]
          : defaults[dField];
        return interpolate(raw || '', vars);
      };
      return {
        key, lang: useLang,
        subject: pick('subject', 'subject'),
        text: pick('body_text', 'text'),
        html: pick('body_html', 'html'),
        partial: false,
      };
    }
    const built = buildReminderEmail({ ...(stub || {}), langOverride: lang });
    if (override) {
      const pick = (oField, dField) => {
        const s = (typeof override[oField] === 'string' ? override[oField] : '').trim();
        return s ? interpolate(override[oField], built.vars) : built.defaults[dField];
      };
      return {
        key, lang: built.lang,
        subject: pick('subject', 'subject'),
        text: pick('body_text', 'text'),
        html: pick('body_html', 'html'),
        partial: false,
      };
    }
    // Loaded persisted row from DB.
    const persistedCopy = await applyOverride({
      communityId: stub && stub.communityId, key: 'reminder',
      lang: built.lang, vars: built.vars, defaults: built.defaults,
    });
    return { key, lang: built.lang, ...persistedCopy, partial: false };
  }

  function pickName(obj, lang) {
    if (obj && typeof obj === 'object') {
      const v = obj[lang];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof obj.en === 'string') return obj.en;
    }
    return '';
  }

  function effectiveChecklist(sub, sch, extraDocs) {
    // Per-subscription override completely replaces the schedule default.
    const base = (Array.isArray(sub?.custom_info_checklist) && sub.custom_info_checklist.length)
      ? sub.custom_info_checklist
      : (Array.isArray(sch?.info_checklist) ? sch.info_checklist : []);
    // Relationship-driven extras append on top, deduped by `key`.
    if (!Array.isArray(extraDocs) || !extraDocs.length) return base;
    const seen = new Set(base.map(i => i?.key).filter(Boolean));
    const merged = base.slice();
    for (const x of extraDocs) {
      if (!x || (x.key && seen.has(x.key))) continue;
      merged.push(x);
      if (x.key) seen.add(x.key);
    }
    return merged;
  }

  function formalSalutation(name, lang) {
    const n = String(name || '').trim();
    if (lang === 'en') return n ? `Dear ${n},` : 'Dear customer,';
    return n ? `Estimado/a ${n}:` : 'Estimado/a cliente:';
  }

  // ── Document-available email (Phase 2d) ──────────────────────────────────
  // Sent when the practice uploads a document to the customer's portal —
  // typically a completed return, K-1, or signed engagement letter. Tone
  // matches the formal reminder email; CTA is the portal home.
  const sendTaxDocumentEmail = async ({ cust, community, doc, portalUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    // Prefer the customer's chosen communication email (Phase 2e) when set;
    // otherwise fall back to the login email.
    const to = String(cust?.preferred_communication_email || cust?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'customer_email_missing' };

    const lang = cust.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const formalGreeting = formalSalutation(cust.name, lang);
    const closing = lang === 'en'
      ? `Sincerely,\n${practiceName}`
      : `Atentamente,\n${practiceName}`;

    const subject = lang === 'en'
      ? `New document available in your portal — ${doc.file_name}`
      : `Nuevo documento disponible en su portal — ${doc.file_name}`;

    const intro = lang === 'en'
      ? `${practiceName} has uploaded a new document to your secure portal:`
      : `${practiceName} ha cargado un documento nuevo en su portal seguro:`;
    const ctaText = lang === 'en'
      ? `Please sign in to review and download it. If you have questions about this document, reply to this email or contact our office.`
      : `Por favor inicie sesión para revisarlo y descargarlo. Si tiene preguntas sobre este documento, responda a este correo o contacte a nuestra oficina.`;
    const ctaLabel = lang === 'en' ? 'Open my portal' : 'Abrir mi portal';

    const text = [
      formalGreeting,
      '',
      intro,
      `  • ${doc.file_name}`,
      '',
      ctaText,
      portalUrl || '',
      '',
      closing,
    ].join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${escapeHtml(intro)}</p>
        <p style="background:#f4f7fb;border-left:3px solid #1d3a6d;padding:10px 14px;border-radius:6px;margin:16px 0">
          <strong>${escapeHtml(doc.file_name)}</strong>
        </p>
        <p>${escapeHtml(ctaText)}</p>
        ${portalUrl ? `
          <p style="margin:24px 0">
            <a href="${portalUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
          </p>
          <p style="color:#666;font-size:13px">${escapeHtml(portalUrl)}</p>
        ` : ''}
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const defaults = { subject, text, html };
    const vars = {
      customer_name: displayNameOf(cust) || cust.name || '', customer_first_name: firstNameOf(cust), practice_name: practiceName,
      file_name: doc.file_name || '', portal_url: portalUrl || '',
    };
    const finalCopy = await applyOverride({
      communityId: cust.community_id, key: 'document', lang, vars, defaults,
    });
    const result = await sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: langTag,
    });
    if (result && result.sent && typeof logTaxEmailDelivery === 'function') {
      try {
        await logTaxEmailDelivery({
          resendId: result.id || '',
          outboundMessageId: result.messageId || '',
          communityId: cust.community_id || '',
          customerId: cust.id || '',
          eventType: 'document',
          recipients: [to],
          subject: finalCopy.subject,
          relatedEntity: 'tax.document',
          relatedId: doc?.id || '',
        });
      } catch (_e) {}
    }
    return result;
  };

  // ── Phase 4n.25: signature-request emails ────────────────────────────────
  // Customer-facing nudge when an owner creates a signature request.
  // Lives at template key 'signature_request'. Sign URL points at the
  // customer portal's sign page.
  const sendTaxSignatureRequestEmail = async ({ cust, community, request, signUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(cust?.preferred_communication_email || cust?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'customer_email_missing' };

    const lang = cust.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const formalGreeting = formalSalutation(cust.name, lang);
    const closing = lang === 'en'
      ? `Sincerely,\n${practiceName}` : `Atentamente,\n${practiceName}`;

    const subject = lang === 'en'
      ? `Please review and sign: ${request.title}`
      : `Por favor revise y firme: ${request.title}`;
    const intro = lang === 'en'
      ? `${practiceName} has sent you a document to review and sign:`
      : `${practiceName} le ha enviado un documento para revisar y firmar:`;
    const ctaText = lang === 'en'
      ? `Click the secure link below to review the details and sign by typing your legal name. The signature is captured with a timestamp and your IP for our records.`
      : `Haga clic en el enlace seguro abajo para revisar los detalles y firmar escribiendo su nombre legal. La firma se registra con fecha y su dirección IP para nuestros archivos.`;
    const ctaLabel = lang === 'en' ? 'Review and sign' : 'Revisar y firmar';

    const text = [
      formalGreeting, '', intro, `  • ${request.title}`,
      request.description ? '' : null,
      request.description ? request.description : null,
      '', ctaText, signUrl || '', '', closing,
    ].filter(s => s !== null).join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${escapeHtml(intro)}</p>
        <p style="background:#f4f7fb;border-left:3px solid #1d3a6d;padding:10px 14px;border-radius:6px;margin:16px 0">
          <strong>${escapeHtml(request.title)}</strong>
        </p>
        ${request.description ? `
          <p style="white-space:pre-line;color:#444">${escapeHtml(request.description)}</p>
        ` : ''}
        <p>${escapeHtml(ctaText)}</p>
        ${signUrl ? `
          <p style="margin:24px 0">
            <a href="${signUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
          </p>
          <p style="color:#666;font-size:13px">${escapeHtml(signUrl)}</p>
        ` : ''}
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const defaults = { subject, text, html };
    const vars = {
      customer_name: displayNameOf(cust) || cust.name || '', customer_first_name: firstNameOf(cust), practice_name: practiceName,
      title: request.title || '', description: request.description || '',
      sign_url: signUrl || '',
    };
    const finalCopy = await applyOverride({
      communityId: cust.community_id, key: 'signature_request', lang, vars, defaults,
    });
    const result = await sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: langTag,
    });
    if (result && result.sent && typeof logTaxEmailDelivery === 'function') {
      try {
        await logTaxEmailDelivery({
          resendId: result.id || '',
          outboundMessageId: result.messageId || '',
          communityId: cust.community_id || '',
          customerId: cust.id || '',
          eventType: 'signature_request',
          recipients: [to],
          subject: finalCopy.subject,
          relatedEntity: 'tax.signature_request',
          relatedId: request?.id || '',
        });
      } catch (_e) {}
    }
    return result;
  };

  // Practice-facing notification when a customer signs. Sent to one
  // employee at a time so the fan-out caller can dedupe + honor each
  // employee's per-type notification preference.
  const sendTaxSignatureSignedEmail = async ({ emp, customer, community, request, customerUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(emp?.preferred_communication_email || emp?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'employee_email_missing' };

    const lang = emp.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const custName = customer?.name || customer?.email || 'Customer';

    const subject = lang === 'en'
      ? `${custName} signed: ${request.title}`
      : `${custName} firmó: ${request.title}`;
    const body = lang === 'en'
      ? `Hi ${emp.name || ''},\n\n${custName} just signed "${request.title}". The signature, timestamp, and IP have been captured in the audit trail.\n\nOpen the customer's record:\n${customerUrl || ''}\n\n${practiceName}`
      : `Hola ${emp.name || ''},\n\n${custName} acaba de firmar "${request.title}". La firma, fecha y IP quedaron registradas en la pista de auditoría.\n\nAbrir el registro del cliente:\n${customerUrl || ''}\n\n${practiceName}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(lang === 'en' ? 'Hi' : 'Hola')} ${escapeHtml(emp.name || '')},</p>
        <p>${escapeHtml(lang === 'en'
          ? `${custName} just signed "${request.title}".`
          : `${custName} acaba de firmar "${request.title}".`)}</p>
        <p style="color:#444;font-size:14px">${escapeHtml(lang === 'en'
          ? 'The signature, timestamp, and IP have been captured in the audit trail.'
          : 'La firma, fecha y IP quedaron registradas en la pista de auditoría.')}</p>
        ${customerUrl ? `
          <p style="margin:24px 0">
            <a href="${customerUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(lang === 'en' ? 'Open customer' : 'Abrir cliente')}</a>
          </p>
        ` : ''}
        <p style="white-space:pre-line">${escapeHtml(practiceName)}</p>
      </div>
    `;

    const defaults = { subject, text: body, html };
    const vars = {
      employee_name: displayNameOf(emp) || emp.name || '', employee_first_name: firstNameOf(emp), practice_name: practiceName,
      customer_name: custName, customer_email: customer?.email || '',
      title: request.title || '', customer_url: customerUrl || '',
    };
    const finalCopy = await applyOverride({
      communityId: community?.id, key: 'signature_signed', lang, vars, defaults,
    });
    return sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: langTag,
    });
  };

  // ── Customer message email (Phase 2f) ────────────────────────────────────
  // Sent when the practice posts a reply to a thread. Includes a short
  // preview of the message body and a CTA back to the customer's portal.
  // Routes to cust.preferred_communication_email when set (Phase 2e).
  const sendTaxMessageEmail = async ({ cust, community, thread, message, portalUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(cust?.preferred_communication_email || cust?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'customer_email_missing' };

    const lang = cust.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const subject = lang === 'en'
      ? `New message from ${practiceName}${thread?.subject ? `: ${thread.subject}` : ''}`
      : `Nuevo mensaje de ${practiceName}${thread?.subject ? `: ${thread.subject}` : ''}`;

    const formalGreeting = formalSalutation(cust.name, lang);
    const intro = lang === 'en'
      ? `${practiceName} has sent you a new message through your portal:`
      : `${practiceName} le ha enviado un nuevo mensaje a través de su portal:`;
    const ctaText = lang === 'en'
      ? `Sign in to view the full thread and reply.`
      : `Inicie sesión para ver la conversación completa y responder.`;
    const ctaLabel = lang === 'en' ? 'Open my portal' : 'Abrir mi portal';
    const closing = lang === 'en'
      ? `Sincerely,\n${practiceName}`
      : `Atentamente,\n${practiceName}`;

    // Truncate preview for emails — full body lives in the portal.
    const preview = String(message?.body || '').slice(0, 500);
    const truncated = (message?.body || '').length > 500;
    const previewLine = preview + (truncated ? '…' : '');

    const text = [
      formalGreeting, '', intro,
      thread?.subject ? `\n${lang === 'en' ? 'Subject' : 'Asunto'}: ${thread.subject}` : '',
      '',
      previewLine,
      '',
      ctaText,
      portalUrl || '',
      '',
      closing,
    ].filter(Boolean).join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${escapeHtml(intro)}</p>
        ${thread?.subject ? `<p style="color:#444"><strong>${lang === 'en' ? 'Subject' : 'Asunto'}:</strong> ${escapeHtml(thread.subject)}</p>` : ''}
        <blockquote style="margin:16px 0;padding:12px 16px;background:#f4f7fb;border-left:3px solid #1d3a6d;border-radius:6px;white-space:pre-wrap">${escapeHtml(previewLine)}</blockquote>
        <p>${escapeHtml(ctaText)}</p>
        ${portalUrl ? `
          <p style="margin:24px 0">
            <a href="${portalUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
          </p>
          <p style="color:#666;font-size:13px">${escapeHtml(portalUrl)}</p>
        ` : ''}
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const msgDefaults = { subject, text, html };
    const msgVars = {
      customer_name: displayNameOf(cust) || cust.name || '', customer_first_name: firstNameOf(cust), practice_name: practiceName,
      thread_subject: thread?.subject || '', portal_url: portalUrl || '',
      author_name: message?.author_name || practiceName,
      message_preview: message?.body || '',
    };
    const msgFinal = await applyOverride({
      communityId: cust.community_id, key: 'message_to_customer', lang, vars: msgVars, defaults: msgDefaults,
    });
    const msgResult = await sendSpanishEmail({
      to, subject: msgFinal.subject, text: msgFinal.text, html: msgFinal.html, lang: langTag,
    });
    if (msgResult && msgResult.sent && typeof logTaxEmailDelivery === 'function') {
      try {
        await logTaxEmailDelivery({
          resendId: msgResult.id || '',
          outboundMessageId: msgResult.messageId || '',
          communityId: cust.community_id || '',
          customerId: cust.id || '',
          eventType: 'message_to_customer',
          recipients: [to],
          subject: msgFinal.subject,
          relatedEntity: 'tax.thread',
          relatedId: thread?.id || '',
          threadId: thread?.id || '',
        });
      } catch (_e) {}
    }
    return msgResult;
  };

  // ── Practice notification email (Phase 2f) ───────────────────────────────
  // Sent to the community's contact_email when a CUSTOMER posts a message
  // and no staff member is assigned to that customer. Localized to the
  // owner's preference via community.default_locale — the recipient is
  // the practice operator, not the customer, so the customer's locale
  // doesn't apply.
  const sendTaxMessagePracticeEmail = async ({ community, customer, thread, message }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(community?.contact_email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'community_contact_email_missing' };

    const lang = community?.default_locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const customerLabel = customer?.name || customer?.email || (lang === 'en' ? 'a customer' : 'un cliente');
    const subject = lang === 'en'
      ? `[${practiceName}] New customer message from ${customerLabel}`
      : `[${practiceName}] Nuevo mensaje de cliente de ${customerLabel}`;
    const preview = String(message?.body || '').slice(0, 500);
    const truncated = (message?.body || '').length > 500;
    const previewLine = preview + (truncated ? '…' : '');

    const labels = lang === 'en'
      ? { intro: `New customer message via ${practiceName} portal:`,
          from: 'From', subj: 'Subject', threadId: 'Thread', posted: 'Posted',
          message: 'Message', heading: `New customer message — ${practiceName}` }
      : { intro: `Nuevo mensaje de cliente vía el portal de ${practiceName}:`,
          from: 'De', subj: 'Asunto', threadId: 'Hilo', posted: 'Publicado',
          message: 'Mensaje', heading: `Nuevo mensaje de cliente — ${practiceName}` };

    const lines = [
      labels.intro,
      '',
      `${labels.from}:     ${customer?.name || ''} <${customer?.email || ''}>`,
      thread?.subject ? `${labels.subj}:  ${thread.subject}` : '',
      `${labels.threadId}:   ${thread?.id || ''}`,
      `${labels.posted}:   ${message?.created_at || ''}`,
      '',
      `${labels.message}:`,
      previewLine,
    ].filter(Boolean);
    const text = lines.join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <h3 style="margin:0 0 12px">${escapeHtml(labels.heading)}</h3>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 8px;color:#555">${escapeHtml(labels.from)}</td><td style="padding:6px 8px"><strong>${escapeHtml(customer?.name || '')}</strong> &lt;${escapeHtml(customer?.email || '')}&gt;</td></tr>
          ${thread?.subject ? `<tr><td style="padding:6px 8px;color:#555">${escapeHtml(labels.subj)}</td><td style="padding:6px 8px">${escapeHtml(thread.subject)}</td></tr>` : ''}
          <tr><td style="padding:6px 8px;color:#555">${escapeHtml(labels.threadId)}</td><td style="padding:6px 8px;color:#666;font-family:monospace;font-size:12px">${escapeHtml(thread?.id || '')}</td></tr>
        </table>
        <h4>${escapeHtml(labels.message)}</h4>
        <blockquote style="margin:8px 0;padding:12px 16px;background:#f7f7f7;border-radius:8px;white-space:pre-wrap">${escapeHtml(previewLine)}</blockquote>
      </div>
    `;

    const pDefaults = { subject, text, html };
    const pVars = {
      customer_name: customer?.name || '', customer_email: customer?.email || '',
      practice_name: practiceName, thread_subject: thread?.subject || '',
      thread_id: thread?.id || '', message_preview: previewLine,
    };
    const pFinal = await applyOverride({
      communityId: community?.id, key: 'message_to_practice', lang, vars: pVars, defaults: pDefaults,
    });
    return sendSpanishEmail({
      to, subject: pFinal.subject, text: pFinal.text, html: pFinal.html, lang: langTag,
    });
  };

  // ── Employee message email (Phase 3) ─────────────────────────────────────
  // Sent to an individual employee when a customer posts on a thread, IF
  // that employee has 'email' in their notification_channels. Routes to
  // employee.preferred_communication_email when set, falls back to
  // employee.email. Locale follows employee.locale.
  const sendTaxMessageEmployeeEmail = async ({ community, customer, employee, thread, message }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(employee?.preferred_communication_email || employee?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'employee_email_missing' };

    // Default to ES when employee.locale is missing so this sender
    // matches every other employee-facing one (sendTaxStaffWelcomeEmail,
    // sendTaxTaskAssignedEmail, sendTaxDailyDigestEmail,
    // sendTaxSignatureSignedEmail) and the platform's DEFAULT_LOCALE.
    const lang = employee?.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Your tax practice';
    const subject = lang === 'en'
      ? `[${practiceName}] New message from ${customer?.name || customer?.email || 'customer'}${thread?.subject ? ` — ${thread.subject}` : ''}`
      : `[${practiceName}] Nuevo mensaje de ${customer?.name || customer?.email || 'cliente'}${thread?.subject ? ` — ${thread.subject}` : ''}`;

    const greeting = employee?.name
      ? (lang === 'en' ? `Hi ${employee.name},` : `Hola ${employee.name},`)
      : (lang === 'en' ? 'Hello,' : 'Hola,');
    const intro = lang === 'en'
      ? `A customer just posted a message on a thread you can see in the staff portal:`
      : `Un cliente acaba de publicar un mensaje en un hilo visible en el portal del personal:`;
    const ctaText = lang === 'en'
      ? `Sign in to the staff portal to view the full thread and reply.`
      : `Inicie sesión en el portal del personal para ver el hilo completo y responder.`;

    const preview = String(message?.body || '').slice(0, 500);
    const truncated = (message?.body || '').length > 500;
    const previewLine = preview + (truncated ? '…' : '');

    const text = [
      greeting, '', intro,
      `From:    ${customer?.name || ''} <${customer?.email || ''}>`,
      thread?.subject ? `Subject: ${thread.subject}` : '',
      '',
      previewLine,
      '',
      ctaText,
    ].filter(Boolean).join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(greeting)}</p>
        <p>${escapeHtml(intro)}</p>
        <table style="border-collapse:collapse;margin:8px 0">
          <tr><td style="padding:4px 8px;color:#555">From</td><td style="padding:4px 8px"><strong>${escapeHtml(customer?.name || '')}</strong> &lt;${escapeHtml(customer?.email || '')}&gt;</td></tr>
          ${thread?.subject ? `<tr><td style="padding:4px 8px;color:#555">Subject</td><td style="padding:4px 8px">${escapeHtml(thread.subject)}</td></tr>` : ''}
        </table>
        <blockquote style="margin:12px 0;padding:12px 16px;background:#f4f7fb;border-left:3px solid #1d3a6d;border-radius:6px;white-space:pre-wrap">${escapeHtml(previewLine)}</blockquote>
        <p style="color:#555">${escapeHtml(ctaText)}</p>
      </div>
    `;

    const eDefaults = { subject, text, html };
    const eVars = {
      customer_name: customer?.name || '', customer_email: customer?.email || '',
      employee_name: employee?.name || '', practice_name: community?.name || '',
      thread_subject: thread?.subject || '', message_preview: previewLine,
    };
    const eFinal = await applyOverride({
      communityId: community?.id, key: 'message_to_employee', lang, vars: eVars, defaults: eDefaults,
    });
    return sendSpanishEmail({
      to, subject: eFinal.subject, text: eFinal.text, html: eFinal.html, lang: langTag,
    });
  };

  // ── Welcome / portal-invite email ────────────────────────────────────────
  // Sent when an owner manually creates a customer + opts in to a welcome
  // email (default behavior on the Add form). Locale picked from
  // cust.locale; relationships list rendered in the same language. Goes to
  // cust.email (the sign-in identity) — preferred_communication_email is
  // not used here because at first-sign-in time the two are the same and
  // the welcome IS the invitation to use this email to sign in.
  const sendTaxWelcomeEmail = async ({ cust, community, relationships = [], portalUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(cust?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'customer_email_missing' };

    const lang = cust?.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const formalGreeting = formalSalutation(cust.name, lang);
    const closing = (lang === 'en'
      ? `Sincerely,\n${practiceName}`
      : `Atentamente,\n${practiceName}`);

    const subject = lang === 'en'
      ? `Welcome to your portal at ${practiceName}`
      : `Bienvenido/a a su portal en ${practiceName}`;

    const introLines = lang === 'en' ? [
      formalGreeting,
      '',
      `${practiceName} has set up a secure online portal for you to manage your tax services with us. From the portal you can:`,
      '',
      '  • Receive filing reminders and upload the documents we need',
      '  • View completed returns and other documents we share with you',
      '  • Message us directly with questions',
    ] : [
      formalGreeting,
      '',
      `${practiceName} ha configurado un portal seguro en línea para que administre sus servicios de impuestos con nosotros. Desde el portal puede:`,
      '',
      '  • Recibir recordatorios de declaración y subir los documentos que necesitamos',
      '  • Ver declaraciones completadas y otros documentos que compartimos con usted',
      '  • Enviarnos mensajes directamente con preguntas',
    ];

    // Relationship list. relationships is the array of joined rows from
    // tax_customer_relationships → tax_relationship_types. We use the
    // localized name_i18n for each. Skipped entirely if empty.
    const relNames = (relationships || [])
      .map(r => pickName(r.type?.name_i18n, lang))
      .filter(Boolean);
    const relHeader = lang === 'en'
      ? 'We have you set up for the following services:'
      : 'Lo tenemos configurado para los siguientes servicios:';
    const relSection = relNames.length
      ? ['', relHeader, '', ...relNames.map(n => `  • ${n}`)]
      : [];

    const signInLines = lang === 'en' ? [
      '',
      'To sign in for the first time, visit:',
      '',
      `  ${portalUrl}`,
      '',
      `You can sign in with Google or create a password using this email address (${to}).`,
      '',
      'If you have any questions about getting started, simply reply to this email.',
    ] : [
      '',
      'Para iniciar sesión por primera vez, visite:',
      '',
      `  ${portalUrl}`,
      '',
      `Puede iniciar sesión con Google o crear una contraseña usando este correo (${to}).`,
      '',
      'Si tiene alguna pregunta sobre cómo comenzar, simplemente responda a este correo.',
    ];

    const text = [...introLines, ...relSection, ...signInLines, '', closing].join('\n');

    const relHtml = relNames.length
      ? `
        <p style="margin:16px 0 6px">${escapeHtml(relHeader)}</p>
        <ul style="margin:0 0 16px">
          ${relNames.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
        </ul>` : '';
    const ctaLabel = lang === 'en' ? 'Open my portal' : 'Abrir mi portal';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${escapeHtml(introLines[2])}</p>
        <ul>
          <li>${escapeHtml(introLines[4].replace(/^\s*•\s*/, ''))}</li>
          <li>${escapeHtml(introLines[5].replace(/^\s*•\s*/, ''))}</li>
          <li>${escapeHtml(introLines[6].replace(/^\s*•\s*/, ''))}</li>
        </ul>
        ${relHtml}
        <p style="margin:24px 0">
          <a href="${portalUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
        </p>
        <p style="color:#666;font-size:13px">${escapeHtml(portalUrl)}</p>
        <p style="color:#444;font-size:14px">
          ${escapeHtml(lang === 'en'
            ? `You can sign in with Google or create a password using this email address (${to}).`
            : `Puede iniciar sesión con Google o crear una contraseña usando este correo (${to}).`)}
        </p>
        <p style="color:#444;font-size:14px">
          ${escapeHtml(lang === 'en'
            ? 'If you have any questions about getting started, simply reply to this email.'
            : 'Si tiene alguna pregunta sobre cómo comenzar, simplemente responda a este correo.')}
        </p>
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const wDefaults = { subject, text, html };
    const wVars = {
      customer_name: displayNameOf(cust) || cust.name || '', customer_first_name: firstNameOf(cust), practice_name: practiceName,
      customer_email: to, portal_url: portalUrl || '',
      relationships_list: relNames.join(', '),
    };
    const wFinal = await applyOverride({
      communityId: cust.community_id, key: 'welcome_customer', lang, vars: wVars, defaults: wDefaults,
    });
    const wResult = await sendSpanishEmail({
      to, subject: wFinal.subject, text: wFinal.text, html: wFinal.html, lang: langTag,
    });
    if (wResult && wResult.sent && typeof logTaxEmailDelivery === 'function') {
      try {
        await logTaxEmailDelivery({
          resendId: wResult.id || '',
          outboundMessageId: wResult.messageId || '',
          communityId: cust.community_id || '',
          customerId: cust.id || '',
          eventType: 'welcome_customer',
          recipients: [to],
          subject: wFinal.subject,
          relatedEntity: 'tax.customer',
          relatedId: cust.id || '',
        });
      } catch (_e) {}
    }
    return wResult;
  };

  // Staff onboarding email — sent when an owner adds an employee row.
  // Mirrors sendTaxWelcomeEmail but points at the /employee URL and uses
  // role-aware copy (admin vs staff). Locale follows emp.locale.
  // Phase 4n.16: when the employee's email already has an account on the
  // platform (either a tax_customers row, or just a Firebase sign-in from
  // any other role), `existingAccount` is true and the sign-in instructions
  // become "use your existing credentials" instead of "sign in for the
  // first time / create a password". Caller (sendWelcomeForEmployee) does
  // the lookup; promote-to-staff hard-codes it to true.
  const sendTaxStaffWelcomeEmail = async ({ emp, community, employeeUrl, existingAccount = false }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(emp?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'employee_email_missing' };

    const lang = emp?.locale === 'en' ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const isAdmin = emp?.role === 'admin';
    const formalGreeting = formalSalutation(emp.name, lang);
    const closing = (lang === 'en'
      ? `Sincerely,\n${practiceName}`
      : `Atentamente,\n${practiceName}`);

    const roleLabel = lang === 'en'
      ? (isAdmin ? 'an administrator' : 'a staff member')
      : (isAdmin ? 'administrador/a' : 'miembro del personal');

    const subject = lang === 'en'
      ? `You've been added as ${roleLabel} at ${practiceName}`
      : `Le hemos agregado como ${roleLabel} en ${practiceName}`;

    const adminBullets = lang === 'en' ? [
      '  • Manage customers, staff, leads, and community settings',
      '  • Send filing reminders, share documents, and reply to customer messages',
      '  • Edit FAQs and help articles, and view the audit log',
    ] : [
      '  • Administrar clientes, personal, prospectos y configuración de la comunidad',
      '  • Enviar recordatorios de declaración, compartir documentos y responder mensajes de clientes',
      '  • Editar FAQs y artículos de ayuda, y ver el registro de auditoría',
    ];
    const staffBullets = lang === 'en' ? [
      '  • See the customers assigned to you',
      '  • Respond to customer messages and share documents',
      '  • Update your profile and notification preferences',
    ] : [
      '  • Ver los clientes asignados a usted',
      '  • Responder mensajes de clientes y compartir documentos',
      '  • Actualizar su perfil y preferencias de notificación',
    ];
    const bullets = isAdmin ? adminBullets : staffBullets;

    const introLines = lang === 'en' ? [
      formalGreeting,
      '',
      `${practiceName} has added you to the staff portal as ${roleLabel}. From the portal you can:`,
      '',
      ...bullets,
    ] : [
      formalGreeting,
      '',
      `${practiceName} le ha agregado al portal del personal como ${roleLabel}. Desde el portal puede:`,
      '',
      ...bullets,
    ];

    // Sign-in copy branches on whether the user already has an identity on
    // the platform. New users have to bootstrap (Google or first-time
    // password); existing users just visit the staff URL.
    const signInLines = existingAccount
      ? (lang === 'en' ? [
          '',
          `You already have an account on this platform with ${to}. Sign in to the staff portal at:`,
          '',
          `  ${employeeUrl}`,
          '',
          'Use the same Google or email/password sign-in you already use — your existing identity will unlock the staff portal automatically.',
          '',
          'If you have any questions, simply reply to this email.',
        ] : [
          '',
          `Ya tiene una cuenta en esta plataforma con ${to}. Inicie sesión en el portal del personal en:`,
          '',
          `  ${employeeUrl}`,
          '',
          'Use el mismo inicio de sesión (Google o correo/contraseña) que ya utiliza — su identidad actual desbloqueará el portal del personal automáticamente.',
          '',
          'Si tiene alguna pregunta, simplemente responda a este correo.',
        ])
      : (lang === 'en' ? [
          '',
          'To finish setting up, click the link below — your email is already filled in:',
          '',
          `  ${employeeUrl}`,
          '',
          `You'll have two ways to register, both using this email (${to}):`,
          '  • If you already have a Google account on this email, tap "Sign in with Google".',
          '  • Otherwise, tap "First time? Create an account" and pick a password.',
          '',
          'Either way, your first sign-in links your account to this staff profile — nothing to install.',
          '',
          'If you have any questions about getting started, simply reply to this email.',
        ] : [
          '',
          'Para terminar de configurar, abra el enlace de abajo — su correo ya estará rellenado:',
          '',
          `  ${employeeUrl}`,
          '',
          `Tendrá dos formas de registrarse, ambas con este correo (${to}):`,
          '  • Si ya tiene una cuenta de Google con este correo, toque "Iniciar sesión con Google".',
          '  • Si no, toque "¿Primera vez? Crear una cuenta" y elija una contraseña.',
          '',
          'En cualquier caso, su primer inicio de sesión vincula su cuenta con este perfil del personal — no hay nada que instalar.',
          '',
          'Si tiene alguna pregunta sobre cómo comenzar, simplemente responda a este correo.',
        ]);

    const text = [...introLines, ...signInLines, '', closing].join('\n');
    const ctaLabel = lang === 'en' ? 'Open staff portal' : 'Abrir portal del personal';

    const htmlSignInBlurb = existingAccount
      ? (lang === 'en'
          ? `You already have an account with ${to}. Use the same Google or email/password sign-in you already use — your existing identity will unlock the staff portal automatically.`
          : `Ya tiene una cuenta con ${to}. Use el mismo inicio de sesión (Google o correo/contraseña) que ya utiliza — su identidad actual desbloqueará el portal del personal automáticamente.`)
      : (lang === 'en'
          ? `You'll be asked to sign in with Google or create a password using this email address (${to}). The first sign-in links your account to this staff profile.`
          : `Le pedirá iniciar sesión con Google o crear una contraseña usando este correo (${to}). El primer inicio de sesión vincula su cuenta con este perfil del personal.`);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;color:#111">
        <p>${escapeHtml(formalGreeting)}</p>
        <p>${escapeHtml(introLines[2])}</p>
        <ul>
          ${bullets.map(b => `<li>${escapeHtml(b.replace(/^\s*•\s*/, ''))}</li>`).join('')}
        </ul>
        <p style="margin:24px 0">
          <a href="${employeeUrl}" style="background:#1d3a6d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(ctaLabel)}</a>
        </p>
        <p style="color:#666;font-size:13px">${escapeHtml(employeeUrl)}</p>
        <p style="color:#444;font-size:14px">${escapeHtml(htmlSignInBlurb)}</p>
        <p style="color:#444;font-size:14px">
          ${escapeHtml(lang === 'en'
            ? 'If you have any questions, simply reply to this email.'
            : 'Si tiene alguna pregunta, simplemente responda a este correo.')}
        </p>
        <p style="white-space:pre-line">${escapeHtml(closing)}</p>
      </div>
    `;

    const sDefaults = { subject, text, html };
    const sVars = {
      staff_name: displayNameOf(emp) || emp.name || '', staff_first_name: firstNameOf(emp), practice_name: practiceName,
      staff_email: to, role: emp.role || 'staff', role_label: roleLabel,
      employee_url: employeeUrl || '',
    };
    const sFinal = await applyOverride({
      communityId: emp.community_id, key: 'welcome_staff', lang, vars: sVars, defaults: sDefaults,
    });
    return sendSpanishEmail({
      to, subject: sFinal.subject, text: sFinal.text, html: sFinal.html, lang: langTag,
    });
  };

  // Notification to a task's assignee when someone assigns work to them.
  // Fires from POST /admin/tasks (initial assign) and PATCH /admin/tasks
  // (reassignment). Includes a deep link that opens the task in the
  // edit modal so the assignee can act on it without hunting through
  // the list. Localized to the employee's row locale; falls back to
  // Spanish (the platform default).
  const sendTaxTaskAssignedEmail = async ({ community, task, assignee, actor }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'Email not configured.' };
    const to = String(assignee?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'Assignee has no email.' };

    const lang = (assignee && assignee.locale === 'en') ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const taskUrl = `${appBase()}/tax/${encodeURIComponent(community.id)}/employee/tasks?edit=${encodeURIComponent(task.id)}`;
    const actorLabel = (actor && (actor.name || actor.email)) || '';
    const assigneeFirst = firstNameOf(assignee) || '';
    const customerLine = task.customer
      ? (task.customer.business_name || task.customer.name || task.customer.email || '')
      : '';

    const subjectDefault = lang === 'en'
      ? `New task assigned: ${task.title}`
      : `Nueva tarea asignada: ${task.title}`;
    const greeting = lang === 'en'
      ? (assigneeFirst ? `Hi ${assigneeFirst},` : 'Hi,')
      : (assigneeFirst ? `Hola ${assigneeFirst},` : 'Hola,');
    const intro = lang === 'en'
      ? (actorLabel
          ? `${actorLabel} assigned a task to you on ${community.name}.`
          : `A new task was assigned to you on ${community.name}.`)
      : (actorLabel
          ? `${actorLabel} te asignó una tarea en ${community.name}.`
          : `Se te asignó una nueva tarea en ${community.name}.`);
    const cta = lang === 'en' ? 'Open this task →' : 'Abrir esta tarea →';
    const dueLabel = lang === 'en' ? 'Due' : 'Vence';
    const customerLabel = lang === 'en' ? 'Customer' : 'Cliente';
    const priorityLabel = lang === 'en' ? 'Priority' : 'Prioridad';
    const priorityValue = task.priority || 'normal';

    const textLines = [
      greeting, '', intro, '',
      task.title,
      task.due_date ? `${dueLabel}: ${task.due_date}` : '',
      customerLine ? `${customerLabel}: ${customerLine}` : '',
      `${priorityLabel}: ${priorityValue}`,
      '', `${cta} ${taskUrl}`,
    ].filter(Boolean);
    const text = textLines.join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px">
        <p>${escapeHtml(greeting)}</p>
        <p>${escapeHtml(intro)}</p>
        <div style="background:#f7f7f7;padding:14px 16px;border-radius:8px;margin:14px 0">
          <div style="font-weight:700;font-size:16px;margin-bottom:6px">${escapeHtml(task.title)}</div>
          ${task.due_date ? `<div style="margin-top:4px;color:#555"><strong>${escapeHtml(dueLabel)}:</strong> ${escapeHtml(task.due_date)}</div>` : ''}
          ${customerLine ? `<div style="margin-top:4px;color:#555"><strong>${escapeHtml(customerLabel)}:</strong> ${escapeHtml(customerLine)}</div>` : ''}
          <div style="margin-top:4px;color:#555"><strong>${escapeHtml(priorityLabel)}:</strong> ${escapeHtml(priorityValue)}</div>
        </div>
        <p style="margin:20px 0">
          <a href="${escapeHtml(taskUrl)}"
             style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1d3a6d;color:#fff;text-decoration:none;font-weight:600">
            ${escapeHtml(cta)}
          </a>
        </p>
      </div>
    `;

    const vars = {
      practice_name: community.name,
      assignee_name: displayNameOf(assignee) || assignee.email || '',
      assignee_first_name: assigneeFirst,
      actor_name: actorLabel,
      task_title: task.title,
      task_due: task.due_date || '',
      task_priority: priorityValue,
      task_url: taskUrl,
      customer_name: customerLine,
    };
    const finalCopy = await applyOverride({
      communityId: community.id, key: 'task_assigned', lang, vars,
      defaults: { subject: subjectDefault, text, html },
    });
    return sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: langTag,
    });
  };

  // Daily digest for owners + staff. Composed by the digest cron from
  // counts + a list of priority items the employee should act on today.
  // Skipped at the caller level when there's nothing to report (no
  // open tasks, no new leads, no new messages) so the practice never
  // gets a "you have 0 things today" email.
  const sendTaxDailyDigestEmail = async ({ community, employee, digest, dashboardUrl, tasksUrl, leadsUrl }) => {
    if (!emailConfigured) return { sent: false, skipped: true, reason: 'email_not_configured' };
    const to = String(employee?.email || '').trim();
    if (!to) return { sent: false, skipped: true, reason: 'employee_email_missing' };

    const lang = (employee && employee.locale === 'en') ? 'en' : 'es';
    const langTag = lang === 'en' ? 'en' : 'es-CO';
    const practiceName = community?.name || 'Tax America Services';
    const greeting = lang === 'en'
      ? (firstNameOf(employee) ? `Hi ${firstNameOf(employee)},` : 'Hi,')
      : (firstNameOf(employee) ? `Hola ${firstNameOf(employee)},` : 'Hola,');
    const subject = lang === 'en'
      ? `Your day at ${practiceName} — ${digest.overdueCount} overdue · ${digest.dueTodayCount} due today`
      : `Tu día en ${practiceName} — ${digest.overdueCount} atrasada(s) · ${digest.dueTodayCount} hoy`;

    const labels = lang === 'en' ? {
      intro:   "Here's what's on your plate today.",
      overdue: 'Overdue', dueToday: 'Due today', upcoming: 'Coming up this week',
      newLeads: 'New leads (last 24h)', newMessages: 'New customer messages',
      openTasks: 'Open all my tasks →', openLeads: 'Open leads inbox →',
      openDash: 'Open my dashboard →',
      noPriority: 'Nothing urgent on the board — good day to chip away at the upcoming list.',
      andMore: (n) => `…and ${n} more.`,
    } : {
      intro:   'Esto es lo que tienes para hoy.',
      overdue: 'Atrasadas', dueToday: 'Vencen hoy', upcoming: 'Próximas (esta semana)',
      newLeads: 'Nuevos prospectos (últimas 24 h)', newMessages: 'Mensajes nuevos de clientes',
      openTasks: 'Abrir todas mis tareas →', openLeads: 'Abrir bandeja de prospectos →',
      openDash: 'Abrir mi panel →',
      noPriority: 'Nada urgente en el tablero — buen día para avanzar con lo que viene.',
      andMore: (n) => `…y ${n} más.`,
    };

    const renderTaskLineText = (t) => {
      const due = t.due_date ? ` (${t.due_date})` : '';
      const cust = t.customer ? ` — ${t.customer.business_name || t.customer.name || t.customer.email}` : '';
      return `  • ${t.title}${due}${cust}`;
    };
    const renderTaskRowHtml = (t) => {
      const due = t.due_date ? `<span style="color:#7f1d1d;font-weight:600">${escapeHtml(t.due_date)}</span>` : '';
      const cust = t.customer ? `<div style="color:#555;font-size:12px">${escapeHtml(t.customer.business_name || t.customer.name || t.customer.email || '')}</div>` : '';
      return `
        <div style="padding:8px 0;border-bottom:1px solid #eee">
          <div style="display:flex;justify-content:space-between;gap:8px"><div style="font-weight:600">${escapeHtml(t.title)}</div>${due}</div>
          ${cust}
        </div>`;
    };
    const renderLeadRowHtml = (l) => `
      <div style="padding:8px 0;border-bottom:1px solid #eee">
        <div style="font-weight:600">${escapeHtml(l.name || l.email)}${l.customer_type === 'business' ? ' <span style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:700">BUSINESS</span>' : ''}</div>
        <div style="color:#555;font-size:12px">${escapeHtml(l.email)}</div>
      </div>`;

    const sections = [];
    if (digest.overdue.length) sections.push({ label: labels.overdue, items: digest.overdue, kind: 'task' });
    if (digest.dueToday.length) sections.push({ label: labels.dueToday, items: digest.dueToday, kind: 'task' });
    if (digest.upcoming.length) sections.push({ label: labels.upcoming, items: digest.upcoming, kind: 'task' });
    if (employee.role === 'admin' && digest.newLeads.length) sections.push({ label: labels.newLeads, items: digest.newLeads, kind: 'lead' });

    // Text body
    const textLines = [greeting, '', labels.intro, ''];
    if (sections.length === 0) {
      textLines.push(labels.noPriority);
    } else {
      for (const s of sections) {
        textLines.push(`${s.label.toUpperCase()} (${s.items.length})`);
        const shown = s.items.slice(0, 5);
        for (const it of shown) textLines.push(s.kind === 'task' ? renderTaskLineText(it) : `  • ${it.name || it.email}`);
        if (s.items.length > 5) textLines.push(`  ${labels.andMore(s.items.length - 5)}`);
        textLines.push('');
      }
    }
    if (digest.newMessageCount > 0) {
      textLines.push(`${labels.newMessages}: ${digest.newMessageCount}`, '');
    }
    textLines.push(`${labels.openDash} ${dashboardUrl}`);
    textLines.push(`${labels.openTasks} ${tasksUrl}`);
    if (employee.role === 'admin') textLines.push(`${labels.openLeads} ${leadsUrl}`);
    const text = textLines.join('\n');

    // HTML body
    const statRow = `
      <div style="display:flex;gap:8px;margin:14px 0">
        ${[
          { label: labels.overdue, value: digest.overdueCount, color: '#7f1d1d' },
          { label: labels.dueToday, value: digest.dueTodayCount, color: '#dc2626' },
          { label: labels.upcoming, value: digest.upcomingCount, color: '#f59e0b' },
        ].map(s => `<div style="flex:1;background:#f7f7f7;border-radius:8px;padding:10px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:${s.color}">${s.value}</div>
          <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.6px">${escapeHtml(s.label)}</div>
        </div>`).join('')}
      </div>`;

    const sectionsHtml = sections.length === 0
      ? `<p style="color:#555">${escapeHtml(labels.noPriority)}</p>`
      : sections.map(s => `
          <h3 style="margin:18px 0 6px;font-size:14px;color:#333">${escapeHtml(s.label)} (${s.items.length})</h3>
          <div>${s.items.slice(0, 5).map(it => s.kind === 'task' ? renderTaskRowHtml(it) : renderLeadRowHtml(it)).join('')}</div>
          ${s.items.length > 5 ? `<div style="color:#555;font-size:12px;margin-top:4px">${escapeHtml(labels.andMore(s.items.length - 5))}</div>` : ''}
        `).join('');

    const msgsHtml = digest.newMessageCount > 0
      ? `<p style="margin:14px 0;color:#333"><strong>${escapeHtml(labels.newMessages)}:</strong> ${digest.newMessageCount}</p>`
      : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px">
        <p>${escapeHtml(greeting)}</p>
        <p>${escapeHtml(labels.intro)}</p>
        ${statRow}
        ${sectionsHtml}
        ${msgsHtml}
        <p style="margin:20px 0">
          <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#1d3a6d;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(labels.openDash)}</a>
        </p>
        <p style="color:#888;font-size:12px;margin-top:24px">
          <a href="${escapeHtml(tasksUrl)}" style="color:#1d3a6d">${escapeHtml(labels.openTasks)}</a>
          ${employee.role === 'admin' ? ` · <a href="${escapeHtml(leadsUrl)}" style="color:#1d3a6d">${escapeHtml(labels.openLeads)}</a>` : ''}
        </p>
      </div>
    `;

    const vars = {
      practice_name: practiceName,
      employee_name: displayNameOf(employee) || employee.email || '',
      employee_first_name: firstNameOf(employee),
      overdue_count: String(digest.overdueCount),
      due_today_count: String(digest.dueTodayCount),
      upcoming_count: String(digest.upcomingCount),
      new_leads_count: String(digest.newLeads.length),
      new_message_count: String(digest.newMessageCount),
      dashboard_url: dashboardUrl,
      tasks_url: tasksUrl,
      leads_url: leadsUrl,
    };
    const finalCopy = await applyOverride({
      communityId: community.id, key: 'daily_digest', lang, vars,
      defaults: { subject, text, html },
    });
    return sendSpanishEmail({
      to, subject: finalCopy.subject, text: finalCopy.text, html: finalCopy.html, lang: langTag,
    });
  };

  return {
    sendTaxLeadEmail,
    sendTaxTaskAssignedEmail,
    sendTaxDailyDigestEmail,
    sendTaxReminderEmail,
    sendTaxDocumentEmail,
    sendTaxMessageEmail,
    sendTaxMessagePracticeEmail,
    sendTaxMessageEmployeeEmail,
    sendTaxWelcomeEmail,
    sendTaxStaffWelcomeEmail,
    sendTaxSignatureRequestEmail,
    sendTaxSignatureSignedEmail,
    previewTaxEmail,
    getTemplateDefaults,
  };
};
