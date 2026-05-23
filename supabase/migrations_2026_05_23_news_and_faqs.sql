-- News articles + FAQ coverage (Phase 4n.66). Apply this in the Supabase
-- SQL Editor against an existing database — additive only (no DROP, all
-- statements are IF NOT EXISTS / ON CONFLICT).

-- ── Phase 4n.66: news articles ──────────────────────────────────────────────
--
-- Replaces the legacy "help articles surfacing on the landing page" model
-- with a dedicated news/articles table. Owners configure topics
-- (defaults: IRS news / Federal tax / Connecticut tax) and either:
--   a) hit "Refresh now" / let the daily cron call Claude (with web_search)
--      to produce up-to-date bilingual summaries grounded in real sources.
--   b) manually add their own articles with a video URL or an uploaded video.
--
-- Display limit defaults to 5 (a tight, scannable news strip) and is
-- owner-configurable 1-20.
create table if not exists public.tax_news_articles (
  id                  text primary key,
  community_id        text not null references public.communities(id) on delete cascade,
  source              text not null default 'manual'
                       check (source in ('manual','ai')),
  topic               text not null default '',
  topics              jsonb not null default '[]'::jsonb,
  title_i18n          jsonb not null default '{}'::jsonb,
  summary_i18n        jsonb not null default '{}'::jsonb,
  body_i18n           jsonb not null default '{}'::jsonb,
  source_url          text not null default '',
  source_name         text not null default '',
  published_at        timestamptz,
  video_url           text not null default '',
  video_storage_path  text not null default '',
  active              boolean not null default true,
  display_order       int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists tax_news_articles_community_idx
  on public.tax_news_articles(community_id, active, display_order, published_at desc);

-- Per-community news settings.
--   tax_news_topics: jsonb array of strings the LLM refresh uses as the
--     topic filter. Default seeds three: IRS news, federal updates, CT updates.
--   tax_news_display_limit: how many cards the public News section shows.
--   tax_news_auto_refresh: when true the daily cron asks Claude for fresh
--     items; when false only manual edits update the table.
alter table public.communities
  add column if not exists tax_news_topics jsonb not null default
    '["IRS news","Federal tax updates","Connecticut tax updates"]'::jsonb;
alter table public.communities
  add column if not exists tax_news_display_limit smallint not null default 5;
do $$ begin
  alter table public.communities add constraint tax_news_display_limit_chk
    check (tax_news_display_limit between 1 and 20);
exception when duplicate_object then null; end $$;
alter table public.communities
  add column if not exists tax_news_auto_refresh boolean not null default true;
alter table public.communities
  add column if not exists tax_news_last_refreshed_at timestamptz;

-- New relationship types covering services that lacked one (Phase 4n.66).
-- Existing ones (LLC, S-Corp, payroll, etc.) already have FAQs; these
-- three close the coverage gap for the public site's service grid.
insert into public.tax_relationship_types (id, category, slug, name_i18n, description_i18n, display_order) values
  ('business.property_tax',  'business', 'property_tax',  '{"en":"Property Tax","es":"Impuesto Predial"}'::jsonb,
    '{"en":"Real-estate property tax assessment review, appeals, and annual filings.","es":"Revisión de avalúos, apelaciones y declaraciones anuales del impuesto predial."}'::jsonb, 80),
  ('business.annual_report', 'business', 'annual_report', '{"en":"Annual Report","es":"Reporte Anual"}'::jsonb,
    '{"en":"Annual report filings with the Secretary of State to keep your entity in good standing.","es":"Presentación del reporte anual ante la Secretaría de Estado para mantener su entidad en regla."}'::jsonb, 90),
  ('business.workers_comp',  'business', 'workers_comp',  '{"en":"Workers'' Compensation Audit","es":"Auditoría de Compensación Laboral"}'::jsonb,
    '{"en":"Annual workers'' compensation premium audit support — payroll classification, audit packet preparation, and dispute response.","es":"Apoyo en la auditoría anual de compensación laboral — clasificación de nómina, preparación del paquete de auditoría y respuesta a disputas."}'::jsonb, 95)
on conflict (id) do nothing;

-- ── SEED: default FAQs for services missing coverage (Phase 4n.66) ──────────
insert into public.tax_relationship_default_faqs (id, relationship_type_id, display_order, question_i18n, answer_i18n, source_note) values
  -- Partnership 1065
  ('business.partnership_1065.q1', 'business.partnership_1065', 10,
    '{"en":"What is a partnership tax return (Form 1065)?","es":"¿Qué es una declaración de sociedad (Formulario 1065)?"}'::jsonb,
    '{"en":"Form 1065 is the U.S. Return of Partnership Income. It is an informational return — the partnership itself does not pay federal income tax. Instead, each partner receives a Schedule K-1 showing their share of income, deductions, and credits, which flows through to their personal return.","es":"El Formulario 1065 es la Declaración del Ingreso de Sociedades de EE. UU. Es una declaración informativa — la sociedad en sí no paga impuesto federal sobre la renta. Cada socio recibe un Anexo K-1 con su parte de los ingresos, deducciones y créditos, que se reporta en su declaración personal."}'::jsonb,
    'IRS.gov — About Form 1065'),
  ('business.partnership_1065.q2', 'business.partnership_1065', 20,
    '{"en":"When is Form 1065 due?","es":"¿Cuándo vence el Formulario 1065?"}'::jsonb,
    '{"en":"Form 1065 is due on the 15th day of the 3rd month after the partnership''s tax year ends — March 15 for calendar-year partnerships. A six-month extension to September 15 is available with Form 7004.","es":"El Formulario 1065 vence el día 15 del tercer mes después del cierre del año fiscal de la sociedad — el 15 de marzo para sociedades con año calendario. Una prórroga de seis meses hasta el 15 de septiembre se solicita con el Formulario 7004."}'::jsonb,
    'IRS.gov — Form 1065 instructions'),
  ('business.partnership_1065.q3', 'business.partnership_1065', 30,
    '{"en":"What is a Schedule K-1?","es":"¿Qué es el Anexo K-1?"}'::jsonb,
    '{"en":"Schedule K-1 (Form 1065) reports each partner''s share of the partnership''s income, deductions, credits, and other items. Partners use it to prepare their personal returns and must receive their K-1 by the partnership''s filing deadline.","es":"El Anexo K-1 (Formulario 1065) reporta la parte de cada socio en los ingresos, deducciones, créditos y otros conceptos de la sociedad. Los socios lo usan para preparar su declaración personal y deben recibirlo antes de la fecha límite de presentación de la sociedad."}'::jsonb,
    'IRS.gov — Schedule K-1 (Form 1065)'),

  -- Property tax
  ('business.property_tax.q1', 'business.property_tax', 10,
    '{"en":"What is property tax and who has to pay it?","es":"¿Qué es el impuesto predial y quién debe pagarlo?"}'::jsonb,
    '{"en":"Property tax is a recurring tax levied by local governments (city, town, or county) on the assessed value of real estate you own — residential, commercial, or vacant land. In Connecticut, municipalities set their own mill rate, and bills are issued annually or in two installments.","es":"El impuesto predial es un impuesto recurrente que cobran los gobiernos locales (ciudad, pueblo o condado) sobre el valor tasado de los bienes raíces que usted posee — residenciales, comerciales o terrenos sin construir. En Connecticut, cada municipio fija su propia tasa (mill rate) y las facturas se emiten anualmente o en dos cuotas."}'::jsonb,
    'CT.gov — Office of Policy and Management: Property Tax'),
  ('business.property_tax.q2', 'business.property_tax', 20,
    '{"en":"How do I appeal my property tax assessment?","es":"¿Cómo puedo apelar la valoración de mi propiedad?"}'::jsonb,
    '{"en":"After receiving your assessment notice you have a limited window — typically until February 20 in Connecticut — to file a written appeal with the local Board of Assessment Appeals. We help prepare comparable-sales evidence, attend the hearing, and pursue Superior Court appeal if the BAA result is unfavorable.","es":"Tras recibir el aviso de valoración tiene un plazo limitado — generalmente hasta el 20 de febrero en Connecticut — para presentar una apelación por escrito ante la Junta Local de Apelaciones de Valoración. Le ayudamos a preparar evidencia de ventas comparables, asistir a la audiencia y continuar con una apelación ante el Tribunal Superior si el resultado de la junta no le favorece."}'::jsonb,
    'CT.gov — Board of Assessment Appeals'),
  ('business.property_tax.q3', 'business.property_tax', 30,
    '{"en":"Is property tax deductible on my federal return?","es":"¿Es deducible el impuesto predial en mi declaración federal?"}'::jsonb,
    '{"en":"Property tax paid on real estate you own may be deductible as an itemized deduction on Schedule A, subject to the combined state and local tax (SALT) cap of $10,000 per return. Business-property taxes are deducted as a business expense on Schedule C, E, or the entity''s return.","es":"El impuesto predial pagado sobre bienes raíces que usted posee puede deducirse como deducción detallada en el Anexo A, sujeto al límite combinado de impuestos estatales y locales (SALT) de $10,000 por declaración. Los impuestos prediales de propiedades comerciales se deducen como gasto en el Anexo C, E o en la declaración de la entidad."}'::jsonb,
    'IRS.gov — Topic No. 503, Deductible Taxes'),

  -- Annual report
  ('business.annual_report.q1', 'business.annual_report', 10,
    '{"en":"What is an annual report?","es":"¿Qué es el reporte anual?"}'::jsonb,
    '{"en":"An annual report is a state-mandated filing that updates the Secretary of State on your entity''s basic information — address, registered agent, officers or members. Most states require it every year (Connecticut), every two years, or on the anniversary of formation. Missing the filing can lead to administrative dissolution.","es":"El reporte anual es una presentación obligatoria ante la Secretaría de Estado que actualiza la información básica de su entidad — dirección, agente registrado, funcionarios o miembros. La mayoría de los estados lo exigen cada año (Connecticut), cada dos años o en el aniversario de la constitución. No presentarlo puede llevar a la disolución administrativa."}'::jsonb,
    'CT.gov — Secretary of the State: Business Services'),
  ('business.annual_report.q2', 'business.annual_report', 20,
    '{"en":"When is the Connecticut annual report due?","es":"¿Cuándo vence el reporte anual de Connecticut?"}'::jsonb,
    '{"en":"For Connecticut LLCs, LPs, and LLPs the annual report is due between January 1 and March 31 each year, with a $80 filing fee. Corporations file on the anniversary month of their formation. Filing is done online at CT.gov; we track the deadline and file on your behalf.","es":"Para LLCs, LPs y LLPs de Connecticut el reporte anual vence entre el 1 de enero y el 31 de marzo de cada año, con una tarifa de $80. Las corporaciones presentan en el mes aniversario de su constitución. La presentación se hace en línea en CT.gov; nosotros monitoreamos el plazo y lo presentamos por usted."}'::jsonb,
    'CT.gov — Filing Annual Reports'),
  ('business.annual_report.q3', 'business.annual_report', 30,
    '{"en":"What happens if I miss the annual report deadline?","es":"¿Qué pasa si pierdo la fecha del reporte anual?"}'::jsonb,
    '{"en":"After the deadline your entity falls into not-in-good-standing status. If you remain delinquent for an extended period, the state can administratively dissolve the entity — losing your limited-liability protection. Reinstatement is possible but adds late fees and paperwork. We send reminders 60, 30, and 7 days before the due date.","es":"Tras el plazo, su entidad queda en estado no-en-regla. Si la mora se prolonga, el estado puede disolver administrativamente la entidad — perdiendo su protección de responsabilidad limitada. La reinstalación es posible pero implica multas y trámites adicionales. Enviamos recordatorios 60, 30 y 7 días antes del vencimiento."}'::jsonb,
    'CT.gov — Administrative Dissolution'),

  -- Workers comp audit
  ('business.workers_comp.q1', 'business.workers_comp', 10,
    '{"en":"What is a workers'' compensation audit?","es":"¿Qué es una auditoría de compensación laboral?"}'::jsonb,
    '{"en":"At the end of each policy year your workers'' compensation insurer audits the actual payroll for the period. They compare projected vs. actual wages by employee classification to compute the true premium owed. You may end up paying additional premium, receiving a refund, or owing nothing.","es":"Al cierre de cada año de póliza, su aseguradora de compensación laboral audita la nómina real del periodo. Comparan las nóminas proyectadas contra las reales por clasificación de empleados para calcular la prima realmente adeudada. Puede terminar pagando una prima adicional, recibir un reembolso o no deber nada."}'::jsonb,
    'NCCI — Premium Audit'),
  ('business.workers_comp.q2', 'business.workers_comp', 20,
    '{"en":"What documents are needed for the audit?","es":"¿Qué documentos se necesitan para la auditoría?"}'::jsonb,
    '{"en":"Typical requests include payroll registers and quarterly Form 941s, federal/state unemployment tax reports, 1099-NEC forms for contractors, certificates of insurance for subcontractors, and the general ledger if available. We compile a clean audit packet so the auditor isn''t reclassifying workers based on missing paperwork.","es":"Los documentos solicitados generalmente incluyen registros de nómina y Formularios 941 trimestrales, reportes federales y estatales de impuesto al desempleo, Formularios 1099-NEC de contratistas, certificados de seguro de subcontratistas y el libro mayor si está disponible. Preparamos un paquete de auditoría completo para que el auditor no reclasifique trabajadores por documentación faltante."}'::jsonb,
    'NCCI — Audit Documentation'),
  ('business.workers_comp.q3', 'business.workers_comp', 30,
    '{"en":"Can I dispute the audit findings?","es":"¿Puedo disputar los resultados de la auditoría?"}'::jsonb,
    '{"en":"Yes. If you disagree with the auditor''s classifications or payroll totals you can file a dispute within the time window your policy specifies (often 60 to 90 days). Common issues are subcontractor misclassification, overtime double-counted, and clerical worker premiums applied to office staff. We handle the rebuttal and supporting documentation.","es":"Sí. Si no está de acuerdo con las clasificaciones o totales de nómina del auditor puede presentar una disputa dentro del plazo que indique su póliza (a menudo 60 a 90 días). Los problemas comunes son la mala clasificación de subcontratistas, las horas extras contadas dos veces y la aplicación de primas de trabajador de oficina al personal administrativo. Nos encargamos de la refutación y la documentación de soporte."}'::jsonb,
    'NCCI — Disputing Audit Results')
on conflict (id) do nothing;
