// Friendly summary of an auto-task's cadence — "Monthly · day 15",
// "Annual · Jan 15", "Weekly · Monday". Mirrors the cadence summary
// rendered in the service editor so the same string the owner
// configured shows up on each task row.

const MONTH_SHORT = {
  en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
  es: ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'],
};

export function formatFrequency(cadenceKind, anchorRule, t, locale) {
  if (!cadenceKind || cadenceKind === 'none') return '';
  const a = anchorRule || {};
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (cadenceKind === 'weekly') {
    const dow = Number(a.weekday || a.dayOfWeek || 1);
    const weekdayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
    const idx = dow >= 1 && dow <= 7 ? dow % 7 : 1;
    return `${t('owner.services.cadence.weekly')} · ${t(`owner.services.weekday.${weekdayKeys[idx]}`)}`;
  }
  if (cadenceKind === 'monthly') {
    return `${t('owner.services.cadence.monthly')} · ${t('owner.tasks.frequency.day')} ${a.day ?? 15}`;
  }
  if (cadenceKind === 'quarterly') {
    return `${t('owner.services.cadence.quarterly')} · ${t('owner.tasks.frequency.day')} ${a.day ?? 15}`;
  }
  if (cadenceKind === 'annual') {
    const months = MONTH_SHORT[locale === 'en' ? 'en' : 'es'];
    const m = months[(Number(a.month) || 1) - 1] || '';
    return `${t('owner.services.cadence.annual')} · ${cap(m)} ${a.day ?? 15}`;
  }
  return '';
}
