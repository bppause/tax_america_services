'use strict';

// Auto-task suggestion catalog (Phase 4n.62).
//
// Each entry is one pre-canned recurring task that a service "starts
// with as a suggestion." The owner enables what fits their practice
// and ignores the rest; nothing fires until they opt in.
//
// Keyed by product slug — the seed slugs in schema.sql match these
// keys, but the catalog also works for owner-created services with
// the same slug. Templates carry their own template_key so a copy
// in tax_service_auto_tasks can be traced back here.
//
// anchor_rule shapes mirror the same JSON the in-DB rows use:
//   { type: 'monthly_following',   day: 15 }
//   { type: 'quarterly_following', day: 15 }
//   { type: 'weekly_following',    weekday: 1 }   // 1=Mon
//   { type: 'annual',              month: 4, day: 15 }
//
// Add a new template by appending under the product slug; the GET
// endpoint picks it up automatically.

const TEMPLATES_BY_SLUG = {
  'individual-tax': [
    {
      key: 'doc-collection',
      title:       { en: 'Send tax document collection reminder',           es: 'Enviar recordatorio de recolección de documentos' },
      description: { en: 'Email the customer the year\'s W-2/1099 checklist and request uploads.',
                     es: 'Enviar al cliente la lista de documentos del año y solicitar las cargas.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 2, day: 1 },
      default_priority: 'normal',
    },
    {
      key: 'prepare-1040',
      title:       { en: 'Prepare 1040 return',                              es: 'Preparar declaración 1040' },
      description: { en: 'Start the return draft once docs are in; finish by Apr 1 to leave room for review.',
                     es: 'Iniciar el borrador en cuanto lleguen los documentos; terminar antes del 1 de abril para revisión.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 3, day: 1 },
      default_priority: 'high',
    },
    {
      key: 'efile-1040',
      title:       { en: 'E-file the 1040 (or extension if needed)',         es: 'Presentar electrónicamente la 1040 (o extensión si aplica)' },
      description: { en: 'File or submit Form 4868 for a six-month extension.',
                     es: 'Presentar o enviar Formulario 4868 para una extensión de seis meses.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 4, day: 15 },
      default_priority: 'urgent',
    },
    {
      key: 'q1-estimated',
      title:       { en: 'Q1 estimated tax reminder',                         es: 'Recordatorio impuesto estimado 1T' },
      description: { en: 'Confirm the Q1 estimated payment amount and remind the client to mail/EFTPS.',
                     es: 'Confirmar el monto del 1T y recordar al cliente enviar/EFTPS.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 4, day: 15 },
      default_priority: 'normal',
    },
    {
      key: 'q2-estimated',
      title:       { en: 'Q2 estimated tax reminder',                         es: 'Recordatorio impuesto estimado 2T' },
      description: { en: 'Confirm the Q2 estimated payment amount and remind the client to mail/EFTPS.',
                     es: 'Confirmar el monto del 2T y recordar al cliente enviar/EFTPS.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 6, day: 15 },
      default_priority: 'normal',
    },
    {
      key: 'q3-estimated',
      title:       { en: 'Q3 estimated tax reminder',                         es: 'Recordatorio impuesto estimado 3T' },
      description: { en: 'Confirm the Q3 estimated payment amount and remind the client to mail/EFTPS.',
                     es: 'Confirmar el monto del 3T y recordar al cliente enviar/EFTPS.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 9, day: 15 },
      default_priority: 'normal',
    },
    {
      key: 'q4-estimated',
      title:       { en: 'Q4 estimated tax reminder',                         es: 'Recordatorio impuesto estimado 4T' },
      description: { en: 'Confirm the Q4 estimated payment amount and remind the client to mail/EFTPS.',
                     es: 'Confirmar el monto del 4T y recordar al cliente enviar/EFTPS.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 15 },
      default_priority: 'normal',
    },
  ],

  'business-tax': [
    {
      key: 'year-end-review',
      title:       { en: 'Year-end planning meeting',                         es: 'Reunión de planeación de cierre' },
      description: { en: 'Discuss owner draws, retained earnings, capital purchases, and Section 179 before year-end.',
                     es: 'Discutir retiros, ganancias retenidas, compras de capital y Sección 179 antes del cierre.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 12, day: 1 },
      default_priority: 'high',
    },
    {
      key: 'prepare-business-return',
      title:       { en: 'Prepare business return',                           es: 'Preparar declaración del negocio' },
      description: { en: 'Draft 1120 / 1120-S / 1065 with K-1s and supporting schedules.',
                     es: 'Borrador 1120 / 1120-S / 1065 con K-1s y anexos.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 2, day: 15 },
      default_priority: 'high',
    },
    {
      key: 'efile-business-return',
      title:       { en: 'E-file business return (or 7004 extension)',         es: 'Presentar declaración (o extensión 7004)' },
      description: { en: 'S-Corps/Partnerships are due Mar 15; C-Corps follow the C-Corp deadline (Apr 15 for calendar-year).',
                     es: 'S-Corps/Partnerships vencen el 15 de marzo; C-Corps siguen su propia fecha (15 abril año calendario).' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 3, day: 15 },
      default_priority: 'urgent',
    },
    {
      key: 'q1-corp-estimated',
      title:       { en: 'Corporate Q1 estimated tax',                         es: 'Impuesto estimado corporativo 1T' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 4, day: 15 },
      default_priority: 'normal',
    },
  ],

  bookkeeping: [
    {
      key: 'monthly-recon',
      title:       { en: 'Monthly bank + credit-card reconciliation',          es: 'Conciliación mensual de banco y tarjetas' },
      description: { en: 'Reconcile every connected account against the statement; flag anomalies on the customer thread.',
                     es: 'Conciliar cada cuenta contra el estado; señalar anomalías en el hilo del cliente.' },
      cadence_kind: 'monthly',
      anchor_rule:  { type: 'monthly_following', day: 10 },
      default_priority: 'normal',
    },
    {
      key: 'monthly-pl',
      title:       { en: 'Send monthly P&L + Balance Sheet',                   es: 'Enviar Estado de Resultados y Balance mensual' },
      description: { en: 'Generate the close-of-month financials and email the customer a short summary.',
                     es: 'Generar los reportes de fin de mes y enviar al cliente un resumen breve.' },
      cadence_kind: 'monthly',
      anchor_rule:  { type: 'monthly_following', day: 15 },
      default_priority: 'normal',
    },
    {
      key: 'quarterly-review',
      title:       { en: 'Quarterly bookkeeping review with customer',         es: 'Revisión trimestral con el cliente' },
      description: { en: 'Walk through margins, AR aging, and big-ticket vendor spend before the next quarter starts.',
                     es: 'Revisar márgenes, AR, gastos relevantes con proveedores antes del siguiente trimestre.' },
      cadence_kind: 'quarterly',
      anchor_rule:  { type: 'quarterly_following', day: 20 },
      default_priority: 'normal',
    },
    {
      key: 'annual-close',
      title:       { en: 'Year-end books close',                               es: 'Cierre contable de fin de año' },
      description: { en: 'Final reconciliations + accruals + lock the period before handing off to tax prep.',
                     es: 'Conciliaciones finales + ajustes + bloquear el período antes de pasar a impuestos.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 31 },
      default_priority: 'high',
    },
    {
      key: 'semi-annual-h1-report',
      title:       { en: 'Publish H1 Bookkeeping report (Jan–Jun)',            es: 'Publicar informe contable H1 (Ene–Jun)' },
      description: { en: 'Capture H1 P&L + Balance Sheet in the customer record, review the numbers, and email the dashboard. Due July 31.',
                     es: 'Capturar P&L + Balance del H1 en la ficha del cliente, revisar los números y enviar el panel al cliente. Vence 31 de julio.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 7, day: 31, taxYearOffset: 0, periodLabelPrefix: 'H1' },
      default_priority: 'high',
    },
    {
      key: 'semi-annual-h2-report',
      title:       { en: 'Publish H2 / annual Bookkeeping report (Jul–Dec)',   es: 'Publicar informe contable H2 / anual (Jul–Dic)' },
      description: { en: 'Capture H2 P&L + Balance Sheet in the customer record, review the numbers, and email the dashboard. Due January 31.',
                     es: 'Capturar P&L + Balance del H2 en la ficha del cliente, revisar los números y enviar el panel al cliente. Vence 31 de enero.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 31, periodLabelPrefix: 'H2' },
      default_priority: 'high',
    },
  ],

  payroll: [
    {
      key: 'weekly-payroll',
      title:       { en: 'Run weekly payroll',                                 es: 'Procesar nómina semanal' },
      description: { en: 'Pull hours, run payroll, verify direct deposits cleared.',
                     es: 'Importar horas, procesar nómina, verificar depósitos directos.' },
      cadence_kind: 'weekly',
      anchor_rule:  { type: 'weekly_following', weekday: 1 },
      default_priority: 'high',
    },
    {
      key: 'q1-941',
      title:       { en: 'File quarterly Form 941',                            es: 'Presentar Formulario 941 trimestral' },
      cadence_kind: 'quarterly',
      anchor_rule:  { type: 'quarterly_following', day: 30 },
      default_priority: 'high',
    },
    {
      key: 'w2-1099-prep',
      title:       { en: 'Prepare W-2s + 1099-NECs',                            es: 'Preparar W-2 y 1099-NEC' },
      description: { en: 'Generate forms, deliver to recipients, e-file with IRS/SSA by Jan 31.',
                     es: 'Generar formularios, entregar a destinatarios, presentar al IRS/SSA antes del 31 de enero.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 31 },
      default_priority: 'urgent',
    },
  ],

  'sales-tax': [
    {
      key: 'monthly-sales-tax',
      title:       { en: 'Monthly sales tax return',                            es: 'Declaración mensual de impuestos sobre ventas' },
      cadence_kind: 'monthly',
      anchor_rule:  { type: 'monthly_following', day: 20 },
      default_priority: 'high',
    },
    {
      key: 'quarterly-sales-tax',
      title:       { en: 'Quarterly sales tax return',                          es: 'Declaración trimestral de impuestos sobre ventas' },
      cadence_kind: 'quarterly',
      anchor_rule:  { type: 'quarterly_following', day: 20 },
      default_priority: 'high',
    },
  ],

  'property-tax': [
    {
      key: 'assessment-review',
      title:       { en: 'Review annual assessment notice',                     es: 'Revisar el aviso anual de avalúo' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 7, day: 1 },
      default_priority: 'normal',
    },
    {
      key: 'appeal-deadline',
      title:       { en: 'File property tax appeal (if warranted)',              es: 'Presentar apelación del impuesto predial (si procede)' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 8, day: 15 },
      default_priority: 'high',
    },
  ],

  'annual-report': [
    {
      key: 'file-annual-report',
      title:       { en: 'File state annual report',                            es: 'Presentar reporte anual estatal' },
      description: { en: 'Default to Mar 1; override per state in the editor.',
                     es: 'Por defecto 1 de marzo; ajustar por estado en el editor.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 3, day: 1 },
      default_priority: 'high',
    },
    {
      key: 'boi-report',
      title:       { en: 'File BOI report (Corporate Transparency Act)',         es: 'Presentar reporte BOI (Ley de Transparencia Corporativa)' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 1 },
      default_priority: 'high',
    },
  ],

  'workers-comp-audit': [
    {
      key: 'audit-packet-prep',
      title:       { en: 'Prepare workers comp audit packet',                  es: 'Preparar paquete de auditoría de compensación laboral' },
      description: { en: 'Reconcile payroll registers to 941s; separate overtime premium; document subcontractors.',
                     es: 'Conciliar registros de nómina con 941s; separar prima de horas extras; documentar subcontratistas.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 7, day: 1 },
      default_priority: 'high',
    },
  ],

  itin: [
    {
      key: 'itin-renewal-check',
      title:       { en: 'Check ITIN renewal status',                           es: 'Verificar estado de renovación de ITIN' },
      description: { en: 'ITINs not used on a return for three consecutive years deactivate; flag renewals before the 1040 deadline.',
                     es: 'Los ITIN no usados en tres años se desactivan; marcar renovaciones antes del 1040.' },
      cadence_kind: 'annual',
      anchor_rule:  { type: 'annual', month: 1, day: 31 },
      default_priority: 'normal',
    },
  ],
};

module.exports = { TEMPLATES_BY_SLUG };
