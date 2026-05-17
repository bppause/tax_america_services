// Tax module — default task title suggestions per service.
//
// Surfaces as autocomplete options in the Add Task UI so the owner doesn't
// retype the same common items. Free text is always allowed.
//
// Slugs match tax_products.slug for the seeded `tax-america-services`
// catalog. Unknown slugs (custom services the owner adds via Services
// admin) still get the COMMON_SUGGESTIONS bucket so even brand-new
// service types open with a healthy starter list instead of a blank.

'use strict';

const SUGGESTIONS_BY_SLUG = {
  'individual-tax': [
    { en: 'Send tax-prep link to customer',         es: 'Enviar enlace de preparación al cliente' },
    { en: 'Send organizer / questionnaire',         es: 'Enviar cuestionario al cliente' },
    { en: 'Collect W-2 / 1099 forms',               es: 'Recopilar formularios W-2 / 1099' },
    { en: 'Collect 1095 health-insurance forms',    es: 'Recopilar formularios 1095 de seguro médico' },
    { en: 'Collect mortgage / 1098 statements',     es: 'Recopilar estados hipotecarios / 1098' },
    { en: 'Collect dependent SSNs / ITINs',         es: 'Recopilar SSN / ITIN de dependientes' },
    { en: 'Verify driver\'s license / state ID',    es: 'Verificar licencia / identificación estatal' },
    { en: 'Review prior-year return',               es: 'Revisar declaración del año anterior' },
    { en: 'Itemize deductions (Schedule A)',        es: 'Detallar deducciones (Anexo A)' },
    { en: 'Prepare 1040 draft',                     es: 'Preparar borrador del 1040' },
    { en: 'Prepare state return draft',             es: 'Preparar borrador de declaración estatal' },
    { en: 'Send draft for client review',           es: 'Enviar borrador al cliente para revisión' },
    { en: 'Collect Form 8879 signature',            es: 'Recolectar firma del Formulario 8879' },
    { en: 'E-file federal return',                  es: 'Presentar electrónicamente la declaración federal' },
    { en: 'File state return',                      es: 'Presentar declaración estatal' },
    { en: 'Set up direct deposit / refund tracking',es: 'Configurar depósito directo / seguimiento de reembolso' },
    { en: 'File extension (Form 4868)',             es: 'Presentar extensión (Formulario 4868)' },
    { en: 'Send copy of filed return to client',    es: 'Enviar copia de la declaración presentada al cliente' },
  ],
  'business-tax': [
    { en: 'Send tax-prep link to customer',         es: 'Enviar enlace de preparación al cliente' },
    { en: 'Collect year-end financials (P&L, balance sheet)', es: 'Recopilar estados financieros de fin de año' },
    { en: 'Reconcile QuickBooks / accounting file', es: 'Conciliar QuickBooks / archivo contable' },
    { en: 'Verify EIN / entity classification',     es: 'Verificar EIN / clasificación de la entidad' },
    { en: 'Review prior-year business return',      es: 'Revisar declaración empresarial del año anterior' },
    { en: 'Prepare 1120 / 1120-S / 1065 draft',     es: 'Preparar borrador de 1120 / 1120-S / 1065' },
    { en: 'Prepare Schedule C (sole prop)',         es: 'Preparar Anexo C (propietario único)' },
    { en: 'Issue K-1s to shareholders / partners',  es: 'Emitir K-1 a accionistas / socios' },
    { en: 'Confirm reasonable compensation (S-Corp)', es: 'Confirmar compensación razonable (S-Corp)' },
    { en: 'File extension (Form 7004)',             es: 'Presentar extensión (Formulario 7004)' },
    { en: 'E-file business return',                 es: 'Presentar electrónicamente la declaración empresarial' },
    { en: 'File state franchise / annual report',   es: 'Presentar reporte estatal / franquicia anual' },
    { en: 'Print annual P&L',                       es: 'Imprimir P&L anual' },
    { en: 'Send copy of filed return to client',    es: 'Enviar copia de la declaración presentada al cliente' },
  ],
  'itin': [
    { en: 'Schedule CAA appointment',               es: 'Agendar cita CAA' },
    { en: 'Verify identification documents',        es: 'Verificar documentos de identificación' },
    { en: 'Verify passport / authentication',       es: 'Verificar pasaporte / autenticación' },
    { en: 'Prepare Form W-7',                       es: 'Preparar Formulario W-7' },
    { en: 'Attach supporting tax return',           es: 'Adjuntar declaración de respaldo' },
    { en: 'Mail application to IRS',                es: 'Enviar solicitud por correo al IRS' },
    { en: 'Follow up on ITIN status',               es: 'Dar seguimiento al estado del ITIN' },
    { en: 'Return original documents to client',    es: 'Devolver documentos originales al cliente' },
    { en: 'Renew expiring ITIN',                    es: 'Renovar ITIN próximo a expirar' },
    { en: 'Notify client of issued ITIN',           es: 'Notificar al cliente del ITIN emitido' },
  ],
  'bookkeeping': [
    { en: 'Request bank statements',                es: 'Solicitar estados de cuenta bancarios' },
    { en: 'Request credit-card statements',         es: 'Solicitar estados de tarjetas de crédito' },
    { en: 'Import transactions into accounting',    es: 'Importar transacciones a la contabilidad' },
    { en: 'Reconcile bank accounts',                es: 'Conciliar cuentas bancarias' },
    { en: 'Reconcile credit cards',                 es: 'Conciliar tarjetas de crédito' },
    { en: 'Categorize expenses',                    es: 'Categorizar gastos' },
    { en: 'Review uncategorized transactions',      es: 'Revisar transacciones sin categorizar' },
    { en: 'Reconcile loans / lines of credit',      es: 'Conciliar préstamos / líneas de crédito' },
    { en: 'Record owner draws / contributions',     es: 'Registrar aportes / retiros del propietario' },
    { en: 'Print monthly P&L',                      es: 'Imprimir P&L mensual' },
    { en: 'Print balance sheet',                    es: 'Imprimir balance general' },
    { en: 'Print cash-flow statement',              es: 'Imprimir estado de flujo de efectivo' },
    { en: 'Send month-end financials to client',    es: 'Enviar estados financieros de fin de mes al cliente' },
    { en: 'Year-end accounting close',              es: 'Cierre contable anual' },
  ],
  'payroll': [
    { en: 'Onboard new employee (W-4 / I-9)',       es: 'Registrar nuevo empleado (W-4 / I-9)' },
    { en: 'Collect timesheets',                     es: 'Recopilar hojas de horas' },
    { en: 'Run weekly payroll',                     es: 'Procesar nómina semanal' },
    { en: 'Run bi-weekly payroll',                  es: 'Procesar nómina quincenal' },
    { en: 'Send paystubs to employees',             es: 'Enviar comprobantes de pago a empleados' },
    { en: 'Make federal tax deposit',               es: 'Hacer depósito de impuesto federal' },
    { en: 'Make state tax deposit',                 es: 'Hacer depósito de impuesto estatal' },
    { en: 'File Form 941 (quarterly)',              es: 'Presentar Formulario 941 (trimestral)' },
    { en: 'File state unemployment return',         es: 'Presentar declaración estatal de desempleo' },
    { en: 'File Form 940 (annual FUTA)',            es: 'Presentar Formulario 940 (FUTA anual)' },
    { en: 'Issue W-2s to employees',                es: 'Emitir W-2 a empleados' },
    { en: 'Issue 1099-NEC to contractors',          es: 'Emitir 1099-NEC a contratistas' },
    { en: 'File W-3 / 1096 transmittals',           es: 'Presentar W-3 / 1096' },
    { en: 'Update workers\' comp audit info',       es: 'Actualizar información para auditoría de compensación laboral' },
  ],
  'business-formation': [
    { en: 'Name availability search',               es: 'Búsqueda de disponibilidad del nombre' },
    { en: 'File articles of organization / incorporation', es: 'Presentar acta constitutiva' },
    { en: 'Obtain EIN from IRS',                    es: 'Obtener EIN del IRS' },
    { en: 'Draft operating agreement / bylaws',     es: 'Redactar acuerdo operativo / estatutos' },
    { en: 'Register for state tax accounts',        es: 'Registrarse en cuentas tributarias estatales' },
    { en: 'Apply for local business license',       es: 'Solicitar licencia comercial local' },
    { en: 'Designate registered agent',             es: 'Designar agente registrado' },
    { en: 'Open business bank account',             es: 'Abrir cuenta bancaria empresarial' },
    { en: 'Order corporate kit / seal',             es: 'Pedir kit corporativo / sello' },
    { en: 'File annual report',                     es: 'Presentar reporte anual' },
    { en: 'File 2553 (S-Corp election)',            es: 'Presentar 2553 (elección S-Corp)' },
    { en: 'File 8832 (entity classification)',      es: 'Presentar 8832 (clasificación de entidad)' },
    { en: 'File BOI (Beneficial Ownership Info)',   es: 'Presentar BOI (Información del Beneficiario)' },
  ],
  'notary': [
    { en: 'Confirm appointment with client',        es: 'Confirmar cita con el cliente' },
    { en: 'Verify identification',                  es: 'Verificar identificación' },
    { en: 'Prepare notary journal entry',           es: 'Preparar entrada en el libro notarial' },
    { en: 'Complete notarization',                  es: 'Completar notarización' },
    { en: 'Apply notary seal and stamp',            es: 'Aplicar sello y estampa notarial' },
    { en: 'Send certified copy to client',          es: 'Enviar copia certificada al cliente' },
    { en: 'File / archive notarized document',      es: 'Archivar documento notarizado' },
  ],
  'translation': [
    { en: 'Receive source documents',               es: 'Recibir documentos originales' },
    { en: 'Quote / confirm scope with client',      es: 'Cotizar / confirmar alcance con el cliente' },
    { en: 'Complete translation',                   es: 'Completar traducción' },
    { en: 'Proofread and finalize',                 es: 'Corregir y finalizar' },
    { en: 'Notarize translator\'s certificate',     es: 'Notarizar certificado del traductor' },
    { en: 'Send certified translation',             es: 'Enviar traducción certificada' },
    { en: 'Archive source + translated documents',  es: 'Archivar documentos originales y traducción' },
  ],
  'irs-representation': [
    { en: 'Receive IRS / state notice from client', es: 'Recibir aviso del IRS / estatal del cliente' },
    { en: 'Obtain Form 2848 (Power of Attorney)',   es: 'Obtener Formulario 2848 (Poder Notarial)' },
    { en: 'Pull IRS account transcripts',           es: 'Obtener transcripciones de cuenta del IRS' },
    { en: 'Call IRS / state on behalf of client',   es: 'Llamar al IRS / estado en nombre del cliente' },
    { en: 'Draft response to notice',               es: 'Redactar respuesta al aviso' },
    { en: 'Send response to IRS',                   es: 'Enviar respuesta al IRS' },
    { en: 'Negotiate installment agreement',        es: 'Negociar acuerdo de pagos' },
    { en: 'Prepare offer in compromise',            es: 'Preparar oferta en compromiso' },
    { en: 'Request penalty abatement',              es: 'Solicitar reducción de multas' },
    { en: 'Schedule audit-monitoring follow-up',    es: 'Agendar seguimiento de monitoreo de auditoría' },
  ],
  'sales-tax': [
    { en: 'Confirm filing jurisdictions',           es: 'Confirmar jurisdicciones de presentación' },
    { en: 'Collect monthly sales totals',           es: 'Recopilar totales de ventas mensuales' },
    { en: 'Reconcile POS / e-commerce reports',     es: 'Conciliar reportes de POS / e-commerce' },
    { en: 'Calculate use-tax adjustments',          es: 'Calcular ajustes de impuesto de uso' },
    { en: 'File monthly sales tax return',          es: 'Presentar declaración mensual de impuesto sobre ventas' },
    { en: 'File quarterly sales tax return',        es: 'Presentar declaración trimestral de impuesto sobre ventas' },
    { en: 'File annual sales tax return',           es: 'Presentar declaración anual de impuesto sobre ventas' },
    { en: 'Make sales tax payment',                 es: 'Hacer pago de impuesto sobre ventas' },
    { en: 'Send sales-tax confirmation to client',  es: 'Enviar confirmación de impuesto sobre ventas al cliente' },
  ],
};

// Cross-service starter pack. Surfaces for every service (after the
// slug-specific list) plus as the only suggestions for custom services
// the owner adds. Designed to cover the front + back of any client
// engagement so a brand-new service still opens with a meaningful set.
const COMMON_SUGGESTIONS = [
  { en: 'Schedule kickoff call with client',        es: 'Agendar llamada inicial con el cliente' },
  { en: 'Confirm scope and timeline',               es: 'Confirmar alcance y cronograma' },
  { en: 'Request signed engagement letter',         es: 'Solicitar carta de compromiso firmada' },
  { en: 'Send onboarding checklist',                es: 'Enviar lista de inicio' },
  { en: 'Request supporting documents',             es: 'Solicitar documentos de respaldo' },
  { en: 'Send document via secure portal',          es: 'Enviar documento por portal seguro' },
  { en: 'Send signature link',                      es: 'Enviar enlace de firma' },
  { en: 'Schedule call with client',                es: 'Agendar llamada con cliente' },
  { en: 'Follow up with client',                    es: 'Dar seguimiento al cliente' },
  { en: 'Send progress update',                     es: 'Enviar actualización de avance' },
  { en: 'Internal review / QA',                     es: 'Revisión interna / QA' },
  { en: 'Send invoice',                             es: 'Enviar factura' },
  { en: 'Collect payment',                          es: 'Cobrar pago' },
  { en: 'Send receipt to client',                   es: 'Enviar recibo al cliente' },
  { en: 'Schedule next-period work',                es: 'Agendar trabajo del próximo periodo' },
  { en: 'Archive engagement file',                  es: 'Archivar expediente del trabajo' },
];

function suggestionsForSlug(slug) {
  const specific = SUGGESTIONS_BY_SLUG[String(slug || '').toLowerCase()] || [];
  return [...specific, ...COMMON_SUGGESTIONS];
}

module.exports = { suggestionsForSlug, COMMON_SUGGESTIONS };
