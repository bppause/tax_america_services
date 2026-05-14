// Email send infrastructure — generic Resend wrapper used by the tax module.
//
// Public exports (returned by the factory):
//   sendSpanishEmail — low-level Resend wrapper (the name is historical;
//                      it handles both es-CO and en via the lang param).
//
// The previous Airbnb-only template machinery (getEmailTemplates,
// sendTemplatedEmail, sendSplitEmail, DEFAULT_EMAIL_TEMPLATES*) was removed
// when the Airbnb owners app was split into its own repository. The tax
// module owns its own template loader and senders in
// server/modules/tax/email-senders.js.

'use strict';

const { v4: uuidv4 } = require('uuid');
const { normalizeRecipients, normalizeLanguage } = require('./utils');

module.exports = function createEmailHelpers({ resend, emailConfigured, EMAIL_FROM, getAppConfig }) {
  const getEffectiveEmailFrom = async (lang='es-CO') => {
    try {
      const cfg = await getAppConfig();
      const isEn = normalizeLanguage(lang) === 'en';
      const addr = ((isEn ? cfg.email_from_address_en : cfg.email_from_address) || '').trim();
      if (!addr) return EMAIL_FROM;
      const explicitName = ((isEn ? cfg.email_from_name_en : cfg.email_from_name) || '').trim();
      const communityName = ((isEn ? cfg.complex_name_en : cfg.complex_name_es) || '').trim();
      const name = explicitName || (communityName
        ? (isEn ? `${communityName} Community` : `Comunidad ${communityName}`)
        : '');
      return name ? `${name} <${addr}>` : addr;
    } catch(e) { /* fall through */ }
    return EMAIL_FROM;
  };

  const sendSpanishEmail = async ({ to, subject, text, html, lang='es-CO', replyTo, inReplyTo }) => {
    if (!emailConfigured) return { sent:false, skipped:true, reason:'Resend email is not configured. Add RESEND_API_KEY and EMAIL_FROM in Render.' };
    const recipients = normalizeRecipients(to);
    if (!recipients.length) return { sent:false, skipped:true, reason:'Recipient email is missing.' };
    const from = await getEffectiveEmailFrom(lang);

    // Stamp our own Message-ID so inbound replies can be matched back to
    // this outbound row. Domain is derived from the configured EMAIL_FROM
    // so RFC 5322 stays happy ("local@domain").
    const fromDomain = (() => {
      const m = String(from || '').match(/@([^>\s]+)/);
      return (m ? m[1] : 'kai.local').toLowerCase();
    })();
    const messageBareId = uuidv4();
    const messageIdHeader = `<${messageBareId}@${fromDomain}>`;
    const headers = { 'Message-ID': messageIdHeader };
    if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
    if (inReplyTo) headers['References'] = inReplyTo;
    const sendArgs = { from, to:recipients, subject, text, html, headers };
    if (replyTo) sendArgs.reply_to = replyTo;
    const { data, error: resendError } = await resend.emails.send(sendArgs);
    if (resendError) throw new Error(resendError.message || JSON.stringify(resendError));
    return {
      sent:true, skipped:false,
      id:data?.id || '',
      messageId: messageBareId,   // bare uuid — what gets stored in DB
      messageIdHeader,            // full <...@...> — what appears in headers
    };
  };

  return { sendSpanishEmail };
};
