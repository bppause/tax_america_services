// Shared credential library. Imported by the service editor (pick-list tiers)
// and by CertBadge (click-to-definition popup).
export const CERT_LIBRARY = [
  // ── ITIN ─────────────────────────────────────────────────────────────────
  {
    label: 'CAA – Certified Acceptance Agent (IRS)',
    slugs: ['itin'],
    categories: ['one_off'],
    note: 'Lets you verify passports in-office — clients never mail originals to the IRS.',
  },
  {
    label: 'IRS Authorized e-File Provider (EFIN)',
    slugs: ['itin', 'individual-tax', 'business-tax'],
    categories: ['tax_prep'],
    note: 'Required to submit returns electronically on behalf of clients.',
  },
  // ── Tax preparation ──────────────────────────────────────────────────────
  {
    label: 'IRS Enrolled Agent (EA)',
    slugs: ['individual-tax', 'business-tax', 'itin'],
    categories: ['tax_prep'],
    note: 'Highest IRS credential — unlimited practice rights before the IRS.',
  },
  {
    label: 'CPA – Certified Public Accountant',
    slugs: ['individual-tax', 'business-tax', 'bookkeeping', 'sales-tax', 'workers-comp-audit'],
    categories: ['tax_prep', 'recurring'],
    note: 'State-licensed accounting credential with audit and attest rights.',
  },
  {
    label: 'IRS Annual Filing Season Program (AFSP)',
    slugs: ['individual-tax', 'business-tax'],
    categories: ['tax_prep'],
    note: 'Voluntary IRS program — limited representation rights and directory listing.',
  },
  {
    label: 'IRS PTIN – Registered Tax Preparer',
    slugs: ['individual-tax', 'business-tax'],
    categories: ['tax_prep'],
    note: 'Required for all paid preparers who sign federal returns.',
  },
  // ── Bookkeeping / accounting ─────────────────────────────────────────────
  {
    label: 'QuickBooks ProAdvisor – Certified',
    slugs: ['bookkeeping', 'payroll'],
    categories: ['recurring'],
    note: 'Intuit-certified QuickBooks expertise listed in the ProAdvisor directory.',
  },
  {
    label: 'Xero Advisor Certified',
    slugs: ['bookkeeping'],
    categories: ['recurring'],
    note: 'Xero-certified advisor listed in the Xero advisor directory.',
  },
  {
    label: 'Certified Bookkeeper (CB) – AIPB',
    slugs: ['bookkeeping'],
    categories: ['recurring'],
    note: 'American Institute of Professional Bookkeepers national credential.',
  },
  // ── Payroll ──────────────────────────────────────────────────────────────
  {
    label: 'CPP – Certified Payroll Professional',
    slugs: ['payroll'],
    categories: ['recurring'],
    note: 'American Payroll Association top-tier payroll credential.',
  },
  {
    label: 'FPC – Fundamental Payroll Certification',
    slugs: ['payroll'],
    categories: ['recurring'],
    note: 'American Payroll Association entry-level credential.',
  },
  // ── Sales tax / compliance ───────────────────────────────────────────────
  {
    label: 'CMI – Certified Member of the Institute (IPT)',
    slugs: ['sales-tax'],
    categories: ['recurring'],
    note: 'Institute for Professionals in Taxation — sales & use tax specialty.',
  },
  // ── Workers comp audit ───────────────────────────────────────────────────
  {
    label: "CWCA – Certified Workers' Compensation Advisor",
    slugs: ['workers-comp-audit'],
    categories: ['one_off'],
    note: "Specialist designation for workers' compensation advisory work.",
  },
  // ── Business formation ───────────────────────────────────────────────────
  {
    label: 'Notary Public',
    slugs: ['business-formation', 'notary', 'itin'],
    categories: ['one_off'],
    note: 'State-commissioned to witness signatures and certify documents.',
  },
  {
    label: 'USCIS Accredited Representative',
    slugs: ['itin', 'business-formation'],
    categories: ['one_off'],
    note: 'DOJ-accredited to represent clients before USCIS and immigration courts.',
  },
  // ── Translation ──────────────────────────────────────────────────────────
  {
    label: 'ATA Certified Translator',
    slugs: ['translation'],
    categories: ['one_off'],
    note: 'American Translators Association certification — accepted by USCIS and courts.',
  },
];

// Build a label → note lookup for O(1) access in CertBadge.
export const CERT_NOTES = Object.fromEntries(CERT_LIBRARY.map(c => [c.label, c.note]));
