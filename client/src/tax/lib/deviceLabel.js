// Rough, no-dependency user-agent → "Chrome · Mac" label. Good enough for
// "is this the device I think it is" at a glance on the Staff page's
// sessions panel and login-history log; not meant to be exhaustive UA
// parsing.
export function deviceLabel(ua, t) {
  const s = String(ua || '');
  if (!s) return t('owner.staff.sessions.unknownDevice');
  let browser = 'Browser';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let os = '';
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'Mac';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Linux/.test(s)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}
