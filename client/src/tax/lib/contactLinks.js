// Quick-contact link builders — mailto:/wa.me: hrefs with a pre-filled,
// localized draft. Mirrors the inline version on the Leads inbox
// (OwnerLeads.jsx ConvertLeadModal/LeadRow quick-contact buttons);
// pulled out here so the same buttons can appear on a task's hover
// summary and its edit modal without duplicating the encoding logic.

export function mailtoHref(email, { subject = '', body = '' } = {}) {
  if (!email) return null;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function whatsappHref(phoneOrWhatsapp, text = '') {
  const digits = String(phoneOrWhatsapp || '').replace(/^\+/, '').replace(/\D+/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// Builds the subject/body (email) and message (WhatsApp) for a task
// follow-up, in the viewer's locale. firstName falls back to a generic
// greeting when the customer has no name on file yet.
export function taskContactMessage({ locale, firstName, communityName, taskTitle }) {
  const name = firstName || (locale === 'es' ? 'Hola' : 'Hi');
  const who = communityName || (locale === 'es' ? 'nuestro equipo' : 'our team');
  if (locale === 'es') {
    return {
      subject: `Sobre: ${taskTitle}`,
      body: `Hola ${name},\n\nTe escribo de ${who} sobre: ${taskTitle}.\n\n`,
      whatsapp: `Hola ${name}, soy de ${who}. Te escribo sobre: ${taskTitle}.`,
    };
  }
  return {
    subject: `Regarding: ${taskTitle}`,
    body: `Hi ${name},\n\nThis is ${who}, reaching out about: ${taskTitle}.\n\n`,
    whatsapp: `Hi ${name}, this is ${who}. I'm reaching out about: ${taskTitle}.`,
  };
}
