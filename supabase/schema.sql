-- Supabase schema for Tax America Services.
--
-- History note: the v80 multi-community foundation originally also hosted
-- Propietarios Airbnb KAI in the same database. The Airbnb tables
-- (listings, incidents, notifications, listing_audit_events) and their
-- supporting app_config rows / RLS toggles were removed when the two
-- products were split into separate repositories. The companion repo
-- (kai-airbnb-owners-app) carries those tables now.
--
-- Kept tables: communities, community_memberships, community_config,
-- app_config, app_users, audit_logs, email_templates, email_delivery_logs,
-- plus every tax_* table.
--
-- Run this in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to run on an existing database — all statements use
-- IF NOT EXISTS / ON CONFLICT DO NOTHING. No demo/test data is inserted.

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMUNITIES (v80)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.communities (
  id text primary key,                     -- slug, e.g. 'tax-america-services'
  name text not null,                      -- display name
  name_en text not null default '',
  tower text not null default '',          -- building identifier (e.g. 'KAI')
  city text not null default '',
  state text not null default '',
  country text not null default 'Colombia',
  logo_url text not null default '',
  background_url text not null default '/morros-kai-bg.jpg',
  description text not null default '',
  description_en text not null default '',
  is_active boolean not null default true,
  created_by_uid text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- v83: state field for filtering communities by state/province
alter table public.communities add column if not exists state text not null default '';

-- Minimal early seed for the default community so the FK-defaulted
-- community_id columns on audit_logs / email_delivery_logs always
-- resolve. The TAX MODULE section further down upserts the rich brand
-- + address fields onto this same row (on conflict (id) do nothing
-- there is intentional — re-running the schema does not clobber
-- owner-edited values).
insert into public.communities (id, name, name_en)
values ('tax-america-services', 'Tax America Services', 'Tax America Services')
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMUNITY MEMBERSHIPS (v80)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.community_memberships (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  user_uid text not null,
  user_email text not null default '',
  role text not null default 'member' check (role in ('member', 'community_admin')),
  invited_by_uid text not null default '',
  joined_at timestamptz not null default now(),
  unique (community_id, user_uid)
);

-- Phase 5: per-community-admin permission flags (v81)
alter table public.community_memberships add column if not exists permissions jsonb not null default '{"canApproveRegistrations":true,"canResolveIncidents":true,"canManageListings":false}'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- COMMUNITY CONFIG (v80)
-- Per-community overrides for app_config keys; server falls back to app_config
-- for any missing community_config keys.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.community_config (
  community_id text not null references public.communities(id) on delete cascade,
  key text not null,
  value text not null default '',
  updated_at timestamptz not null default now(),
  primary key (community_id, key)
);

-- No initial rows needed; server falls back to app_config for missing community_config keys.

-- ─────────────────────────────────────────────────────────────────────────────
-- APP CONFIG
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

-- Airbnb-only seed rows (sla_hours, sla_policies, escalation_cc_emails,
-- mission_*, analytics_enabled, standard_menu_permissions,
-- default_delegate_permissions, ui_labels_*, nav_config,
-- mission_sections_es, email_notification_config) were removed when the
-- Airbnb owners app split out into its own repository. The tax module
-- reads its own keys lazily via getAppConfig and tolerates missing rows.

-- ─────────────────────────────────────────────────────────────────────────────
-- APP USERS
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_users (
  uid text primary key,
  email text not null unique,
  name text not null default '',
  role text not null default 'user' check (role in ('user','delegate_admin','global_admin')),
  permissions jsonb not null default '{}'::jsonb,
  language_preference text not null default 'es-CO' check (language_preference in ('es-CO','en')),
  whatsapp text not null default '',
  country text not null default 'Colombia',
  notification_email text not null default '',
  updated_at timestamptz not null default now()
);

-- Backfill columns for existing databases
alter table public.app_users add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.app_users add column if not exists language_preference text not null default 'es-CO';
alter table public.app_users add column if not exists whatsapp text not null default '';
alter table public.app_users add column if not exists country text not null default 'Colombia';
alter table public.app_users add column if not exists notification_email text not null default '';

-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT LOGS (v27 unified audit log for all mutable entities)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.audit_logs (
  id text primary key,
  community_id text not null default 'tax-america-services' references public.communities(id),
  entity text not null,
  entity_id text not null default '',
  action text not null,
  actor_uid text not null default '',
  actor_email text not null default '',
  actor_name text not null default '',
  reason text not null default '',
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs add column if not exists community_id text not null default 'tax-america-services' references public.communities(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL TEMPLATES
-- v80: community_id added as sentinel-value column (not FK; '__global__' = applies to all communities).
--      PK is now (community_id, key, language).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.email_templates (
  community_id text not null default '__global__',
  key text not null,
  label text not null default '',
  subject text not null default '',
  text text not null default '',
  html text not null default '',
  updated_at timestamptz not null default now(),
  updated_by_email text not null default '',
  language text not null default 'es-CO' check (language in ('es-CO','en')),
  primary key (community_id, key, language)
);

-- Backfill community_id column and migrate PK for existing databases
alter table public.email_templates add column if not exists community_id text not null default '__global__';
alter table public.email_templates add column if not exists language text not null default 'es-CO';
-- Drop old PKs and recreate with community_id included
alter table public.email_templates drop constraint if exists email_templates_pkey;
alter table public.email_templates add constraint email_templates_pkey primary key (community_id, key, language);

-- ─────────────────────────────────────────────────────────────────────────────
-- EMAIL DELIVERY LOGS (v34)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.email_delivery_logs (
  id text primary key,
  community_id text not null default 'tax-america-services' references public.communities(id),
  event_type text not null default '',
  recipients text[] not null default '{}',
  subject text not null default '',
  status text not null default '',
  error_message text not null default '',
  related_entity text not null default '',
  related_id text not null default '',
  created_at timestamptz not null default now()
);

alter table public.email_delivery_logs add column if not exists community_id text not null default 'tax-america-services' references public.communities(id);

-- Re-apply the column defaults on existing databases. `add column if not
-- exists` is a no-op when the column already exists, even if the default
-- has since changed (e.g. from 'kai' before the Airbnb split). `set default`
-- updates the catalog so future inserts pick up the new value.
alter table public.audit_logs           alter column community_id set default 'tax-america-services';
alter table public.email_delivery_logs  alter column community_id set default 'tax-america-services';

-- Phase 4n: open / click tracking via Resend webhook. resend_id is the message
-- id returned by `resend.emails.send`; the webhook receiver matches on it and
-- stamps the corresponding event column. open_count / click_count tally repeat
-- events (Resend fires `email.opened` each time the pixel loads).
alter table public.email_delivery_logs add column if not exists resend_id text;
alter table public.email_delivery_logs add column if not exists delivered_at timestamptz;
alter table public.email_delivery_logs add column if not exists opened_at timestamptz;
alter table public.email_delivery_logs add column if not exists clicked_at timestamptz;
alter table public.email_delivery_logs add column if not exists bounced_at timestamptz;
alter table public.email_delivery_logs add column if not exists complained_at timestamptz;
alter table public.email_delivery_logs add column if not exists open_count int not null default 0;
alter table public.email_delivery_logs add column if not exists click_count int not null default 0;
alter table public.email_delivery_logs add column if not exists customer_id text;
-- Phase 4n.27: capture the SMTP Message-ID of outbound mail so the inbound
-- webhook can match `In-Reply-To` headers back to the originating outbound
-- row (and thus the customer + optional thread). thread_id is stamped when
-- the outbound email is itself a thread reply.
alter table public.email_delivery_logs add column if not exists outbound_message_id text;
alter table public.email_delivery_logs add column if not exists thread_id text;
create index if not exists idx_email_delivery_logs_resend_id on public.email_delivery_logs(resend_id) where resend_id is not null;
create index if not exists idx_email_delivery_logs_customer_event on public.email_delivery_logs(customer_id, event_type, created_at desc) where customer_id is not null;
create index if not exists idx_email_delivery_logs_msgid on public.email_delivery_logs(outbound_message_id) where outbound_message_id is not null;

-- Phase 4n.3: owner-created filing schedules. Adds 'weekly' to the cadence
-- check constraint so we can support `weekly_following` anchor rules. The
-- new check uses the modern name; drop the old one first if it lingers.
alter table public.tax_filing_schedules drop constraint if exists tax_filing_schedules_cadence_check;
alter table public.tax_filing_schedules
  add constraint tax_filing_schedules_cadence_check
  check (cadence in ('weekly','monthly','quarterly','annual','custom'));

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists idx_audit_logs_entity on public.audit_logs(entity, entity_id, created_at desc);
create index if not exists idx_audit_logs_actor on public.audit_logs(actor_email, created_at desc);

create index if not exists idx_email_delivery_logs_created_at on public.email_delivery_logs(created_at desc);
create index if not exists idx_email_delivery_logs_status on public.email_delivery_logs(status);

-- v80: community membership indexes
create index if not exists idx_community_memberships_user on public.community_memberships(user_uid);
create index if not exists idx_community_memberships_community on public.community_memberships(community_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY — disabled (server uses service role key)
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.app_config disable row level security;
alter table public.app_users disable row level security;
alter table public.audit_logs disable row level security;
alter table public.email_templates disable row level security;
alter table public.email_delivery_logs disable row level security;
alter table public.communities disable row level security;
alter table public.community_memberships disable row level security;
alter table public.community_config disable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- TAX MODULE (v85, Phase 1) — landing + leads + product catalog
-- New vertical reusing the existing `communities` table as the multi-tenant
-- boundary. A tax practice is `business_type='tax'`. Branches (same brand,
-- different address) use `parent_community_id` to inherit branding.
-- ─────────────────────────────────────────────────────────────────────────────

-- v85a: vertical + branch hierarchy + service-business contact fields on communities
alter table public.communities add column if not exists business_type text not null default 'tax';
do $$ begin
  alter table public.communities add constraint communities_business_type_chk
    check (business_type in ('tax'));
exception when duplicate_object then null; end $$;

alter table public.communities add column if not exists parent_community_id text references public.communities(id) on delete set null;
alter table public.communities add column if not exists address_line1 text not null default '';
alter table public.communities add column if not exists address_line2 text not null default '';
alter table public.communities add column if not exists postal_code text not null default '';
alter table public.communities add column if not exists phone text not null default '';
alter table public.communities add column if not exists contact_email text not null default '';
alter table public.communities add column if not exists tagline text not null default '';
alter table public.communities add column if not exists tagline_en text not null default '';
alter table public.communities add column if not exists brand_primary_color text not null default '';
alter table public.communities add column if not exists brand_secondary_color text not null default '';
alter table public.communities add column if not exists default_locale text not null default 'es';
-- Phase 4n.13: community-level WhatsApp for click-to-chat from the public
-- landing page. Same E.164 format expected by normalizeWhatsapp().
alter table public.communities add column if not exists whatsapp text not null default '';
do $$ begin
  alter table public.communities add constraint communities_default_locale_chk
    check (default_locale in ('en','es'));
exception when duplicate_object then null; end $$;

-- v85-2a: per-community toggle controlling whether customers can change their
-- own reminder-channel preference inside the portal. Default: false (locked).
-- Owner flips to true to allow customer self-service. Existing subscription
-- reminder_channels are not affected when this flag changes.
alter table public.communities add column if not exists tax_allow_customer_notif_pref_change boolean not null default false;

create index if not exists idx_communities_business_type on public.communities(business_type);
create index if not exists idx_communities_parent on public.communities(parent_community_id);

-- Seed Tax America Services (single org + single community at launch).
-- Owner can edit any of these fields later via the admin UI in Phase 4b.
insert into public.communities (
  id, name, name_en, business_type,
  city, state, country,
  address_line1, postal_code,
  contact_email,
  tagline, tagline_en,
  brand_primary_color, brand_secondary_color,
  logo_url,
  description, description_en
) values (
  'tax-america-services',
  'Tax America Services',
  'Tax America Services',
  'tax',
  'Hamden', 'CT', 'USA',
  '1310 Dixwell Ave, Unit 1', '06514',
  'info@taxamericaservices.com',
  'Su éxito financiero en buenas manos',
  'Your financial success in good hands',
  '#1d3a6d',
  '#d62027',
  '/tax/tax-america-services-logo.png',
  'Servicios profesionales de impuestos, contabilidad y formación de empresas para individuos y negocios.',
  'Professional tax preparation, bookkeeping, and business formation services for individuals and businesses.'
) on conflict (id) do nothing;

-- Re-applies the canonical brand defaults for tax-america-services so
-- re-running this schema after a brand update overwrites the older values.
-- Owner can change again via SQL today; via admin UI in Phase 4b.
update public.communities set
  brand_primary_color   = '#1d3a6d',
  brand_secondary_color = '#d62027',
  logo_url              = '/tax/tax-america-services-logo.png',
  default_locale        = 'es'
where id = 'tax-america-services';

-- v85b: tax_products — service catalog cloned per tax community.
-- workflow / sla_hours / required_documents / notification_rules are JSONB and
-- start empty; Phase 2+ populates them. Owner can enable/disable and edit
-- name/description in Phase 4b. Custom products are explicitly out of v1.
create table if not exists public.tax_products (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  slug text not null,
  category text not null default 'tax_prep',
  enabled boolean not null default true,
  display_order int not null default 0,
  name_i18n jsonb not null default '{}'::jsonb,
  description_i18n jsonb not null default '{}'::jsonb,
  icon text not null default '',
  workflow jsonb not null default '[]'::jsonb,
  sla_hours jsonb not null default '{}'::jsonb,
  required_documents jsonb not null default '[]'::jsonb,
  notification_rules jsonb not null default '[]'::jsonb,
  pricing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, slug)
);
create index if not exists idx_tax_products_community on public.tax_products(community_id, enabled, display_order);

-- Seed defaults for Tax America Services (10 services from taxamericaservices.com).
insert into public.tax_products (id, community_id, slug, category, display_order, name_i18n, description_i18n, icon) values
  ('tax-america-services:individual-tax', 'tax-america-services', 'individual-tax', 'tax_prep', 10,
    '{"en":"Individual Income Tax","es":"Impuestos Personales"}'::jsonb,
    '{"en":"Federal and state income tax preparation for individuals and families.","es":"Preparación de impuestos federales y estatales para individuos y familias."}'::jsonb,
    'receipt'),
  ('tax-america-services:business-tax', 'tax-america-services', 'business-tax', 'tax_prep', 20,
    '{"en":"Business Tax Preparation","es":"Impuestos de Negocios"}'::jsonb,
    '{"en":"Tax filings for LLCs, S-Corps, C-Corps, and partnerships.","es":"Declaraciones de impuestos para LLCs, S-Corps, C-Corps y sociedades."}'::jsonb,
    'briefcase'),
  ('tax-america-services:itin', 'tax-america-services', 'itin', 'one_off', 30,
    '{"en":"ITIN Application","es":"Solicitud de ITIN"}'::jsonb,
    '{"en":"Apply for an Individual Taxpayer Identification Number.","es":"Solicitud del Número de Identificación Personal del Contribuyente (ITIN)."}'::jsonb,
    'id-card'),
  ('tax-america-services:bookkeeping', 'tax-america-services', 'bookkeeping', 'recurring', 40,
    '{"en":"Bookkeeping","es":"Contabilidad"}'::jsonb,
    '{"en":"Monthly bookkeeping and financial reporting for small businesses.","es":"Contabilidad mensual y reportes financieros para pequeños negocios."}'::jsonb,
    'book'),
  ('tax-america-services:payroll', 'tax-america-services', 'payroll', 'recurring', 50,
    '{"en":"Payroll Services","es":"Nómina"}'::jsonb,
    '{"en":"Payroll processing, tax withholdings, and quarterly filings.","es":"Procesamiento de nómina, retenciones fiscales y declaraciones trimestrales."}'::jsonb,
    'wallet'),
  ('tax-america-services:business-formation', 'tax-america-services', 'business-formation', 'one_off', 60,
    '{"en":"Business Formation","es":"Formación de Empresas"}'::jsonb,
    '{"en":"LLC, Corporation, and partnership formation and EIN registration.","es":"Constitución de LLC, Corporaciones y sociedades, y registro de EIN."}'::jsonb,
    'building'),
  ('tax-america-services:notary', 'tax-america-services', 'notary', 'one_off', 70,
    '{"en":"Notary Services","es":"Servicios Notariales"}'::jsonb,
    '{"en":"Notarization of legal and financial documents.","es":"Notarización de documentos legales y financieros."}'::jsonb,
    'stamp'),
  ('tax-america-services:translation', 'tax-america-services', 'translation', 'one_off', 80,
    '{"en":"Translation Services","es":"Traducciones"}'::jsonb,
    '{"en":"Certified document translation between English and Spanish.","es":"Traducción certificada de documentos entre inglés y español."}'::jsonb,
    'globe'),
  ('tax-america-services:irs-representation', 'tax-america-services', 'irs-representation', 'one_off', 90,
    '{"en":"IRS Representation","es":"Representación ante el IRS"}'::jsonb,
    '{"en":"Audit defense and IRS correspondence on your behalf.","es":"Defensa en auditorías y correspondencia con el IRS en su nombre."}'::jsonb,
    'scales'),
  ('tax-america-services:sales-tax', 'tax-america-services', 'sales-tax', 'recurring', 100,
    '{"en":"Sales Tax Filing","es":"Impuestos sobre Ventas"}'::jsonb,
    '{"en":"State and local sales tax registration, collection, and filing.","es":"Registro, recolección y declaración de impuestos sobre ventas estatales y locales."}'::jsonb,
    'calculator')
on conflict (id) do nothing;

-- Phase 4n.34: rich industry-based long descriptions for each default
-- service. These render in the "Learn more" detail modal on the public
-- landing page. We only fill rows where the owner hasn't already
-- customized the long copy, so re-running the seed is safe.
update public.tax_products set long_description_i18n =
  '{"en":"Filing a personal U.S. tax return today usually involves more than a single W-2. We prepare federal Form 1040 plus the matching state return and handle W-2 and 1099 wages, self-employment income on Schedule C, capital gains, rental income on Schedule E, retirement distributions, and the credits most households qualify for — Earned Income, Child Tax, education, and the new energy and EV credits.\n\nWe walk through life events that change a return: a move between states, marriage, a new child, a home sale, or a side business started during the year. Carryforwards from prior years (capital losses, NOLs, foreign tax credits) are pulled forward so they aren''t lost.\n\nEvery return is prepared by one team member and signed off by a second before e-filing. You receive a copy of the signed return for your records, plus a follow-up note early in the next year reminding you of the documents to keep for the upcoming cycle.","es":"Presentar una declaración de impuestos personal en EE. UU. hoy en día suele ir más allá de un solo W-2. Preparamos el Formulario federal 1040 y la declaración estatal correspondiente, e incluimos salarios W-2 y 1099, ingresos por trabajo propio (Anexo C), ganancias de capital, ingresos por alquiler (Anexo E), distribuciones de jubilación y los créditos más comunes — Crédito por Ingreso del Trabajo, por Hijos, educativos y los nuevos créditos energéticos y de vehículos eléctricos.\n\nRepasamos los cambios de vida que afectan la declaración: mudanzas entre estados, matrimonio, nuevo hijo, venta de vivienda o un negocio propio iniciado durante el año. Los arrastres de años anteriores (pérdidas de capital, NOLs, créditos por impuestos extranjeros) se trasladan para no perderlos.\n\nCada declaración la prepara un miembro del equipo y la revisa un segundo antes de presentarla electrónicamente. Recibirá una copia firmada para sus registros y una nota de seguimiento a principios del año siguiente recordándole qué documentos guardar."}'::jsonb
  where id = 'tax-america-services:individual-tax' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"We prepare federal returns for LLCs (Form 1065 partnership, single-member Schedule C, or with an S-Corp election), C-Corporations (Form 1120), S-Corporations (Form 1120-S), and partnerships, along with the matching state and city filings.\n\nSchedule K-1s for each owner or partner are generated and reconciled to the books. Reasonable-compensation analysis is performed for S-Corp shareholders, and depreciation schedules (Section 179, bonus, MACRS) are maintained year over year so we don''t double-count an asset when it''s disposed.\n\nMost businesses we serve are owner-operated with one to fifty employees. If the books need clean-up before we can file, we''ll quote that work separately rather than try to back-fit reconstructed data into the return.","es":"Preparamos declaraciones federales para LLCs (Formulario 1065 de sociedad, Anexo C de miembro único o con elección S-Corp), Corporaciones C (Formulario 1120), Corporaciones S (Formulario 1120-S) y sociedades, junto con las declaraciones estatales y municipales correspondientes.\n\nLos Anexos K-1 de cada propietario o socio se generan y conciliamos con la contabilidad. Realizamos análisis de compensación razonable para accionistas de S-Corp y mantenemos las tablas de depreciación (Sección 179, bonus, MACRS) año tras año para no contar dos veces un activo al darlo de baja.\n\nLa mayoría de nuestros clientes son negocios operados por sus dueños con uno a cincuenta empleados. Si la contabilidad necesita limpieza antes de presentar, cotizamos ese trabajo por separado en lugar de forzar datos reconstruidos en la declaración."}'::jsonb
  where id = 'tax-america-services:business-tax' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"An Individual Taxpayer Identification Number (ITIN) is a nine-digit number issued by the IRS for filers who can''t get a Social Security Number — typically resident and nonresident aliens, spouses and dependents of U.S. taxpayers, or foreign nationals with a U.S. tax filing requirement.\n\nWe are a Certified Acceptance Agent, which means we authenticate your passport and supporting identity documents directly in our office. You do not have to mail your original passport to the IRS. We complete Form W-7 alongside the tax return that establishes the filing requirement, since the IRS will not issue an ITIN without one.\n\nProcessing takes 7 to 11 weeks during peak season. We keep the file open until the IRS notice arrives, confirm the ITIN, and forward you a copy for future filings, bank-account openings, and state-level applications that require it.","es":"El Número de Identificación Personal del Contribuyente (ITIN) es un número de nueve dígitos emitido por el IRS para quienes no pueden obtener un Número de Seguro Social — generalmente residentes y no residentes extranjeros, cónyuges y dependientes de contribuyentes estadounidenses o extranjeros con una obligación tributaria en EE. UU.\n\nSomos Agente Aceptador Certificado, lo que significa que autenticamos su pasaporte y documentos de identidad directamente en nuestra oficina. No tiene que enviar su pasaporte original al IRS. Completamos el Formulario W-7 junto con la declaración de impuestos que establece la obligación de presentar, ya que el IRS no emite un ITIN sin ella.\n\nEl trámite toma de 7 a 11 semanas en temporada alta. Mantenemos el caso abierto hasta que llega la carta del IRS, confirmamos el ITIN y le enviamos una copia para futuras declaraciones, apertura de cuentas bancarias y trámites estatales que lo requieran."}'::jsonb
  where id = 'tax-america-services:itin' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Monthly bookkeeping in QuickBooks Online or Xero, configured for how you actually operate — chart of accounts mapped to your tax filings, bank and credit-card feeds reconciled every month, sales-tax liability tracked by jurisdiction, owner draws and contributions kept separate from operating expenses.\n\nYou receive a Profit & Loss and Balance Sheet by the 15th of each month with a short note on what stood out: a customer behind on payments, a vendor whose pricing jumped, an account drifting from budget. At year-end the books hand off cleanly to whoever files the return, whether that''s us or an existing CPA.\n\nCatch-up engagements — back months or full prior years — are quoted separately based on transaction volume and the state of the source data.","es":"Contabilidad mensual en QuickBooks Online o Xero, configurada según su operación real — plan de cuentas alineado con sus declaraciones de impuestos, conciliación mensual de cuentas bancarias y tarjetas de crédito, seguimiento del impuesto sobre ventas por jurisdicción, y separación entre retiros del dueño y gastos operativos.\n\nRecibe un Estado de Resultados y Balance General antes del día 15 de cada mes con una breve nota sobre lo destacable: un cliente atrasado en pagos, un proveedor que subió precios, una cuenta que se aleja del presupuesto. A fin de año la contabilidad se entrega lista para quien presente la declaración, sea nuestro equipo u otro contador.\n\nLos trabajos de puesta al día — meses atrasados o años fiscales completos — se cotizan por separado según el volumen de transacciones y el estado de la información fuente."}'::jsonb
  where id = 'tax-america-services:bookkeeping' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Bi-weekly or semi-monthly payroll processing including direct deposit, federal and state income-tax withholding, FICA, FUTA and SUTA, and any local taxes that apply — Connecticut, New York, and New Jersey each handle this differently and the rules change every January.\n\nQuarterly federal Form 941 and the state equivalents (CT-941, NJ-927, NYS-45) are filed on time. Year-end W-2s for employees and 1099-NECs for contractors are prepared, e-filed with the IRS and SSA, and delivered to recipients by the January 31 deadline.\n\nNew-hire reporting, EFTPS tax deposits, workers'' comp audit responses, and benefit-deduction reconciliations are handled by us so you don''t open a state notice for a missed deadline.","es":"Procesamiento de nómina quincenal o bimensual con depósito directo, retención federal y estatal del impuesto sobre la renta, FICA, FUTA y SUTA, y los impuestos locales que apliquen — Connecticut, Nueva York y Nueva Jersey lo manejan de forma distinta y las reglas cambian cada enero.\n\nPresentamos a tiempo los formularios federales 941 trimestrales y sus equivalentes estatales (CT-941, NJ-927, NYS-45). Al cierre del año preparamos los W-2 de los empleados y los 1099-NEC de los contratistas, los presentamos electrónicamente ante el IRS y la SSA y los entregamos a los destinatarios antes del 31 de enero.\n\nNosotros gestionamos los reportes de nuevos empleados, los depósitos EFTPS, las auditorías de compensación laboral y la conciliación de deducciones de beneficios para que no llegue una notificación estatal por un plazo vencido."}'::jsonb
  where id = 'tax-america-services:payroll' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Choosing the right legal structure matters more than most owners realize. An LLC offers flexibility but pays self-employment tax on owner draws. An S-Corp can reduce that tax but requires running payroll for the owner, holding annual meetings, and keeping minutes. A C-Corp makes sense when you plan outside investment, multi-class ownership, or foreign shareholders.\n\nWe talk through your situation, file the articles of organization or incorporation with the Secretary of State, obtain your EIN from the IRS, draft an operating agreement or bylaws, and submit the S-Corp election on Form 2553 if that''s the right call.\n\nYou leave with a complete filing kit: state filing acknowledgement, EIN letter, operating agreement, and a calendar of the recurring filings that come with the structure you chose — annual report, BOI report under the Corporate Transparency Act, franchise tax, and the first year''s tax return.","es":"Elegir la estructura legal correcta importa más de lo que la mayoría de los dueños imagina. Una LLC ofrece flexibilidad pero paga el impuesto de trabajo por cuenta propia sobre los retiros del dueño. Una S-Corp puede reducir ese impuesto, pero exige correr nómina al dueño, celebrar reuniones anuales y llevar actas. Una C-Corp tiene sentido cuando se planea capital externo, múltiples clases de acciones o accionistas extranjeros.\n\nAnalizamos su caso, presentamos los artículos de organización o incorporación ante la Secretaría de Estado, obtenemos su EIN ante el IRS, redactamos un acuerdo operativo o estatutos, y presentamos la elección S-Corp en el Formulario 2553 si corresponde.\n\nUsted recibe un paquete completo: confirmación estatal de la presentación, carta del EIN, acuerdo operativo y un calendario de las presentaciones recurrentes que corresponden a su estructura — reporte anual, reporte BOI bajo la Ley de Transparencia Corporativa, impuesto de franquicia y la primera declaración anual."}'::jsonb
  where id = 'tax-america-services:business-formation' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Notarization of legal and financial documents in English or Spanish — affidavits, power of attorney, real-estate closings, vehicle titles, school authorizations, and corporate resolutions. Walk-ins welcome during regular hours; appointments are preferred for closings that need multiple signers or documents prepared in advance.\n\nMobile notary visits are available within the local area for hospitals, nursing homes, and clients with limited mobility — call ahead so we can confirm the travel window and the documents involved.\n\nWe verify identity with current government-issued photo ID, witness the signature, and apply the notary seal and journal entry. We are not attorneys and do not give legal advice on the contents of the document being signed, but we will pause the signing if anything looks off so you can consult counsel.","es":"Notarización de documentos legales y financieros en inglés o español — declaraciones juradas, poderes notariales, cierres de bienes raíces, títulos de vehículos, autorizaciones escolares y resoluciones corporativas. Atendemos sin cita en horario regular; se prefiere cita para cierres con varios firmantes o documentos preparados con anticipación.\n\nOfrecemos servicio móvil de notaría en el área local para hospitales, hogares de ancianos y clientes con movilidad reducida — llame con anticipación para confirmar el horario y los documentos.\n\nVerificamos la identidad con identificación oficial con fotografía vigente, presenciamos la firma y aplicamos el sello notarial y la entrada en el libro registro. No somos abogados y no damos asesoría legal sobre el contenido del documento, pero pausamos la firma si algo no parece correcto para que pueda consultar a su abogado."}'::jsonb
  where id = 'tax-america-services:notary' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Certified document translation between English and Spanish for filings headed to USCIS, the IRS, state DMVs, university admissions offices, and the courts — birth and marriage certificates, divorce decrees, school transcripts, diplomas, police reports, bank statements, and medical records.\n\nEvery translation includes a signed certificate of accuracy that meets the format USCIS and other federal agencies require. The original-language document and the English (or Spanish) version are delivered together so the receiving office can match them.\n\nRush turnaround is available when a filing deadline is close. For long or technical documents we send a sample page back for your review before committing the full translation, so terminology choices (especially names of institutions and degrees) can be confirmed.","es":"Traducción certificada de documentos entre inglés y español para trámites ante USCIS, el IRS, las oficinas estatales de vehículos motorizados, oficinas de admisión universitaria y los tribunales — actas de nacimiento y matrimonio, sentencias de divorcio, expedientes académicos, diplomas, reportes policiales, estados de cuenta bancarios e historiales médicos.\n\nCada traducción incluye un certificado firmado de exactitud con el formato que USCIS y otras agencias federales requieren. Entregamos juntos el documento original y la versión traducida para que la oficina receptora pueda compararlos.\n\nOfrecemos plazos urgentes cuando hay una fecha límite cercana. Para documentos largos o técnicos enviamos una página de muestra para su revisión antes de completar la traducción, de modo que se confirmen las decisiones de terminología (sobre todo nombres de instituciones y títulos académicos)."}'::jsonb
  where id = 'tax-america-services:translation' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"If you''ve received an IRS notice, owe back taxes, or are facing an audit, we step in under Power of Attorney (Form 2848) and communicate with the IRS directly so you don''t have to. Common engagements include audit defense (correspondence, office, or field), CP2000 underreporter notices, payroll-tax assessments, installment agreements, currently-not-collectible status, and offers in compromise.\n\nThe first step is always pulling your IRS account transcripts — wage and income, account, and return — so we know exactly what the IRS sees before recommending a strategy. Many notices turn out to be matching errors that resolve with a single response letter and supporting documents.\n\nFor collections cases we look at the full financial picture (Form 433-A or 433-B) and run the allowable-living-expense math the IRS uses, so the resolution we propose is one the IRS is actually likely to accept.","es":"Si recibió una notificación del IRS, debe impuestos atrasados o enfrenta una auditoría, nos hacemos cargo bajo Poder Legal (Formulario 2848) y nos comunicamos con el IRS directamente para que usted no tenga que hacerlo. Los casos más comunes son defensa en auditorías (por correspondencia, oficina o campo), notificaciones CP2000 por ingresos no reportados, evaluaciones de impuestos sobre nómina, planes de pago, estado de incobrable y ofertas de compromiso.\n\nEl primer paso siempre es obtener sus transcripciones del IRS — ingresos y salarios, cuenta y declaración — para saber exactamente lo que el IRS ve antes de recomendar una estrategia. Muchas notificaciones resultan ser errores de coincidencia que se resuelven con una sola carta de respuesta y documentos de respaldo.\n\nPara casos de cobranza revisamos el panorama financiero completo (Formulario 433-A o 433-B) y aplicamos los gastos de manutención permitidos que el IRS utiliza, de modo que la solución que propongamos sea una que el IRS realmente vaya a aceptar."}'::jsonb
  where id = 'tax-america-services:irs-representation' and long_description_i18n = '{}'::jsonb;

update public.tax_products set long_description_i18n =
  '{"en":"Sales-tax obligations no longer end at your home state. Economic-nexus thresholds under the Wayfair decision mean an online seller can owe sales tax in twenty states without ever setting foot in them. We register your business in each state where you have nexus, set up the right filing frequency (monthly, quarterly, or annual), and file the returns by the due dates.\n\nFor brick-and-mortar businesses we reconcile point-of-sale reports against the bank deposits before filing, so the gross-sales line on the return matches what the bookkeeping shows. Marketplace facilitator collections (Amazon, Etsy, eBay) are separated out so you''re not paying twice on the same revenue.\n\nFiling-frequency changes from the state are tracked and we''ll let you know in advance when your volume will require bumping up from quarterly to monthly. Notices about underpayments or missed filings are answered by us under the same engagement.","es":"Las obligaciones del impuesto sobre ventas ya no terminan en su estado. Los umbrales de nexo económico bajo la decisión Wayfair significan que un vendedor en línea puede deber impuesto sobre ventas en veinte estados sin haber estado físicamente en ninguno. Registramos su negocio en cada estado donde tenga nexo, configuramos la frecuencia adecuada (mensual, trimestral o anual) y presentamos las declaraciones en las fechas correspondientes.\n\nPara negocios físicos conciliamos los reportes del punto de venta con los depósitos bancarios antes de presentar, para que la línea de ventas brutas coincida con lo que muestra la contabilidad. Separamos las recaudaciones de plataformas facilitadoras (Amazon, Etsy, eBay) para que no pague dos veces por el mismo ingreso.\n\nMonitoreamos los cambios de frecuencia que el estado solicite y le avisamos con anticipación cuando su volumen requiera pasar de trimestral a mensual. Las notificaciones por pagos insuficientes o declaraciones faltantes las respondemos nosotros dentro del mismo contrato."}'::jsonb
  where id = 'tax-america-services:sales-tax' and long_description_i18n = '{}'::jsonb;

-- v85c: tax_leads — public landing page contact form submissions.
create table if not exists public.tax_leads (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  name text not null,
  email text not null,
  phone text not null default '',
  product_slug text not null default '',
  message text not null default '',
  preferred_locale text not null default 'en' check (preferred_locale in ('en','es')),
  status text not null default 'new' check (status in ('new','contacted','converted','closed')),
  source text not null default 'landing',
  user_agent text not null default '',
  ip text not null default '',
  contacted_at timestamptz,
  contacted_by_uid text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tax_leads_community on public.tax_leads(community_id, created_at desc);
create index if not exists idx_tax_leads_status on public.tax_leads(community_id, status);
create index if not exists idx_tax_leads_email on public.tax_leads(email);

-- Phase 4n.12: multi-service leads. The landing page lets a prospect pick
-- one or more services they're interested in. product_slug stays for
-- backwards-compat (and convenience — populated with the first slug)
-- but product_slugs is the source of truth from now on.
alter table public.tax_leads
  add column if not exists product_slugs text[] not null default '{}'::text[];

alter table public.tax_products disable row level security;
alter table public.tax_leads disable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- TAX MODULE — Phase 1.5: Compliance Reminders
-- Subscriptions, recurring schedules, filing periods, magic-link responses,
-- in-app notifications. See server/modules/tax/ for the cron + dispatcher.
-- ─────────────────────────────────────────────────────────────────────────────

-- Customers known to the tax module. No Firebase auth yet in Phase 1.5 —
-- magic-link tokens identify them. Phase 2 adds firebase_uid + portal accounts.
create table if not exists public.tax_customers (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  email text not null,
  name text not null default '',
  phone text not null default '',
  locale text not null default 'es' check (locale in ('en','es')),
  status text not null default 'active' check (status in ('active','paused','archived')),
  notes text not null default '',
  firebase_uid text not null default '',  -- Phase 2 populates this on first portal login
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, email)
);
create index if not exists idx_tax_customers_community on public.tax_customers(community_id, status);

-- v85-2e: customer-editable profile fields. WhatsApp stored E.164 normalized
-- (server validates `^\+[1-9]\d{6,14}$`). Address is structured JSON so we
-- can evolve fields without a schema migration; v1 keys are
--   { line1, line2, city, state, postal_code, country }
-- preferred_communication_email overrides the login email for outbound mail
-- when non-empty (login email remains the Firebase auth identity).
alter table public.tax_customers add column if not exists whatsapp text not null default '';
alter table public.tax_customers add column if not exists address jsonb not null default '{}'::jsonb;
alter table public.tax_customers add column if not exists preferred_communication_email text not null default '';

-- Phase 4n.17: last-sign-in stamps. Updated each time the canonical
-- /portal/me (customer) or /employee/me (employee) endpoints return
-- successfully, so admins can see "has this person actually logged in
-- lately?" on the detail pages. Stamps are throttled in the handlers
-- (≥5min between writes) so we don't churn the row on every poll.
alter table public.tax_customers add column if not exists last_sign_in_at timestamptz;
alter table public.tax_employees add column if not exists last_sign_in_at timestamptz;

-- Schedule definitions — one row per recurring filing under a product.
-- A product like "Payroll Services" has multiple schedules (941 quarterly,
-- W-2 January). When a customer subscribes to the product, periods are
-- generated from all `enabled=true` schedules unless the subscription opts
-- some out via `active_schedule_slugs`.
create table if not exists public.tax_filing_schedules (
  id text primary key,                                   -- e.g. 'fed-941-quarterly'
  community_id text not null references public.communities(id) on delete cascade,
  product_id text not null references public.tax_products(id) on delete cascade,
  slug text not null,
  jurisdiction text not null default 'federal',          -- 'federal' | 'state:CT' | 'state:NY' | ...
  cadence text not null check (cadence in ('monthly','quarterly','annual','custom')),
  -- anchor_rule describes when the filing recurs. Shapes:
  --   { type:'fixed_quarterly', dates:['04-15','06-15','09-15','01-15'] }
  --   { type:'monthly_following', day:20 }   -- 20th of month FOLLOWING the period
  --   { type:'annual', date:'01-31' }
  anchor_rule jsonb not null default '{}'::jsonb,
  -- info_checklist: array of { key, label_i18n, type ('number'|'text'|'currency'), required }
  info_checklist jsonb not null default '[]'::jsonb,
  name_i18n jsonb not null default '{}'::jsonb,
  description_i18n jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  display_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, slug)
);
create index if not exists idx_tax_filing_schedules_product on public.tax_filing_schedules(product_id, enabled);

-- Customer × product enrollment. One row per recurring service per customer.
create table if not exists public.tax_subscriptions (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  customer_id text not null references public.tax_customers(id) on delete cascade,
  product_id text not null references public.tax_products(id) on delete cascade,
  status text not null default 'active' check (status in ('active','paused','ended')),
  start_date date not null default current_date,
  end_date date,
  -- null = all enabled schedules of this product; explicit list = only those slugs
  active_schedule_slugs text[],
  -- default both channels; owner can set ['email'] or ['in_app'] per subscription
  reminder_channels text[] not null default '{email,in_app}',
  -- default offsets relative to due date; negative = days before
  reminder_offsets_days int[] not null default '{-14,-7,-3}',
  custom_info_checklist jsonb,                            -- per-customer override; null = use schedule defaults
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, product_id)
);
create index if not exists idx_tax_subs_community on public.tax_subscriptions(community_id, status);
create index if not exists idx_tax_subs_customer on public.tax_subscriptions(customer_id);

-- Instance of an upcoming/past filing for a specific customer.
create table if not exists public.tax_filing_periods (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  subscription_id text not null references public.tax_subscriptions(id) on delete cascade,
  schedule_id text not null references public.tax_filing_schedules(id) on delete cascade,
  customer_id text not null references public.tax_customers(id) on delete cascade,
  period_label text not null default '',                  -- 'Q1 2026' | 'Jan 2026' | 'Tax Year 2025'
  period_start date,
  period_end date,
  due_date date not null,
  status text not null default 'pending' check (status in ('pending','info_requested','info_received','in_prep','filed','skipped')),
  info_received_at timestamptz,
  filed_at timestamptz,
  assigned_employee_uid text not null default '',         -- Phase 3 wires this
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, schedule_id, due_date)
);
create index if not exists idx_tax_periods_due on public.tax_filing_periods(community_id, status, due_date);
create index if not exists idx_tax_periods_customer on public.tax_filing_periods(customer_id, due_date desc);

-- Phase 4n.6: relationship-driven period generation. Periods now reference
-- the workflow rule directly (so the cron can read cadence / anchor_rule /
-- info_checklist without joining tax_filing_schedules). subscription_id +
-- schedule_id become optional — periods can exist for customers who have a
-- relationship but no active subscription.
alter table public.tax_filing_periods
  add column if not exists workflow_rule_id text,
  add column if not exists relationship_type_id text;
alter table public.tax_filing_periods alter column subscription_id drop not null;
alter table public.tax_filing_periods alter column schedule_id drop not null;
-- Idempotent FK creates. `add column if not exists ... references ...` SKIPS
-- the FK when the column already exists from a prior run — Postgres treats
-- the whole clause as a no-op. So we attach the constraint with a separate
-- DO block that checks pg_constraint first. PGRST200 (no relationship found)
-- means PostgREST never saw this; reload the cache after running this file
-- with NOTIFY pgrst, 'reload schema'; (or the Supabase dashboard button).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tax_filing_periods_workflow_rule_id_fkey'
  ) then
    alter table public.tax_filing_periods
      add constraint tax_filing_periods_workflow_rule_id_fkey
      foreign key (workflow_rule_id) references public.tax_relationship_workflow_rules(id)
      on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'tax_filing_periods_relationship_type_id_fkey'
  ) then
    alter table public.tax_filing_periods
      add constraint tax_filing_periods_relationship_type_id_fkey
      foreign key (relationship_type_id) references public.tax_relationship_types(id)
      on delete set null;
  end if;
end $$;
create index if not exists idx_tax_periods_workflow_rule
  on public.tax_filing_periods(customer_id, workflow_rule_id, due_date);
create index if not exists idx_tax_periods_relationship
  on public.tax_filing_periods(customer_id, relationship_type_id, due_date desc);

-- Magic-link tokens for customer info submissions. Token stored hashed
-- (sha-256 hex). Single-use OR until the period reaches info_received.
create table if not exists public.tax_response_tokens (
  id text primary key,
  period_id text not null references public.tax_filing_periods(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_tax_tokens_period on public.tax_response_tokens(period_id);

-- Captured customer responses for a filing period.
create table if not exists public.tax_filing_responses (
  id text primary key,
  period_id text not null references public.tax_filing_periods(id) on delete cascade,
  customer_id text not null references public.tax_customers(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,                -- { checklistKey: value, ... }
  notes text not null default '',
  submitted_at timestamptz not null default now(),
  ip text not null default '',
  user_agent text not null default ''
);
create index if not exists idx_tax_responses_period on public.tax_filing_responses(period_id, submitted_at desc);

-- In-app notification rows. Phase 1.5 writes when channel includes 'in_app';
-- Phase 2 customer portal renders unread rows for the customer.
create table if not exists public.tax_notifications (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  customer_id text not null references public.tax_customers(id) on delete cascade,
  type text not null,                                     -- 'reminder' | 'response_received' | ...
  title_i18n jsonb not null default '{}'::jsonb,
  body_i18n jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,             -- { periodId, scheduleSlug, magicUrl, ... }
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_tax_notifs_customer on public.tax_notifications(customer_id, created_at desc);

-- Audit reminder dispatch (separate from audit_logs to keep it queryable + cheap).
create table if not exists public.tax_reminder_log (
  id text primary key,
  period_id text not null references public.tax_filing_periods(id) on delete cascade,
  channel text not null check (channel in ('email','in_app')),
  offset_days int not null,
  status text not null check (status in ('sent','failed','skipped')),
  reason text not null default '',
  sent_at timestamptz not null default now()
);
create index if not exists idx_tax_reminder_log_period on public.tax_reminder_log(period_id, sent_at desc);
create unique index if not exists ux_tax_reminder_once on public.tax_reminder_log(period_id, channel, offset_days) where status = 'sent';

alter table public.tax_customers           disable row level security;
alter table public.tax_subscriptions       disable row level security;
alter table public.tax_filing_schedules    disable row level security;
alter table public.tax_filing_periods      disable row level security;
alter table public.tax_response_tokens     disable row level security;
alter table public.tax_filing_responses    disable row level security;
alter table public.tax_notifications       disable row level security;
alter table public.tax_reminder_log        disable row level security;

-- ── SEED: filing schedules for Tax America Services ─────────────────────────
-- Federal (every state): Q1–Q4 estimated tax, Form 941 quarterly, W-2/1099 January.
-- Connecticut: Sales & Use Tax monthly, Sales & Use Tax quarterly,
-- CT Estimated Income Tax quarterly.
-- Per owner feedback: federal payroll tax deposits + CT-941 are NOT customer-
-- facing (owner handles directly), so they are omitted from this seed.

insert into public.tax_filing_schedules (id, community_id, product_id, slug, jurisdiction, cadence, anchor_rule, info_checklist, name_i18n, description_i18n, display_order) values

-- ── Federal estimated income tax (attached to Individual + Business products) ─
('tax-america-services:fed-1040es', 'tax-america-services', 'tax-america-services:individual-tax', 'fed-1040es',
  'federal', 'quarterly',
  '{"type":"fixed_quarterly","dates":["04-15","06-15","09-15","01-15"]}'::jsonb,
  '[
    {"key":"income_estimate","type":"currency","required":true,"label_i18n":{"es":"Ingreso estimado del trimestre (USD)","en":"Estimated income for the quarter (USD)"}},
    {"key":"deductions_estimate","type":"currency","required":false,"label_i18n":{"es":"Deducciones estimadas (USD)","en":"Estimated deductions (USD)"}},
    {"key":"prior_year_paid","type":"currency","required":false,"label_i18n":{"es":"Pagos estimados previos del año (USD)","en":"Prior estimated payments this year (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas o cambios de situación","en":"Notes or changes in situation"}}
  ]'::jsonb,
  '{"es":"Impuesto Estimado Federal (1040-ES)","en":"Federal Estimated Income Tax (1040-ES)"}'::jsonb,
  '{"es":"Pago trimestral de impuesto estimado para individuos.","en":"Quarterly estimated income tax for individuals."}'::jsonb,
  10),

('tax-america-services:fed-1120w', 'tax-america-services', 'tax-america-services:business-tax', 'fed-1120w',
  'federal', 'quarterly',
  '{"type":"fixed_quarterly","dates":["04-15","06-15","09-15","12-15"]}'::jsonb,
  '[
    {"key":"taxable_income_estimate","type":"currency","required":true,"label_i18n":{"es":"Ingreso gravable estimado del trimestre (USD)","en":"Estimated taxable income for the quarter (USD)"}},
    {"key":"prior_year_paid","type":"currency","required":false,"label_i18n":{"es":"Pagos estimados previos del año (USD)","en":"Prior estimated payments this year (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas o cambios","en":"Notes or changes"}}
  ]'::jsonb,
  '{"es":"Impuesto Estimado Federal Corporativo (1120-W)","en":"Federal Corporate Estimated Tax (1120-W)"}'::jsonb,
  '{"es":"Pago trimestral de impuesto estimado para corporaciones.","en":"Quarterly estimated income tax for corporations."}'::jsonb,
  20),

-- ── Federal Form 941 quarterly (attached to Payroll product) ────────────────
('tax-america-services:fed-941', 'tax-america-services', 'tax-america-services:payroll', 'fed-941',
  'federal', 'quarterly',
  '{"type":"fixed_quarterly","dates":["04-30","07-31","10-31","01-31"]}'::jsonb,
  '[
    {"key":"total_wages","type":"currency","required":true,"label_i18n":{"es":"Salarios totales pagados en el trimestre (USD)","en":"Total wages paid in the quarter (USD)"}},
    {"key":"federal_withheld","type":"currency","required":true,"label_i18n":{"es":"Impuesto federal retenido (USD)","en":"Federal income tax withheld (USD)"}},
    {"key":"social_security_wages","type":"currency","required":true,"label_i18n":{"es":"Salarios sujetos a Seguro Social (USD)","en":"Social Security wages (USD)"}},
    {"key":"medicare_wages","type":"currency","required":true,"label_i18n":{"es":"Salarios sujetos a Medicare (USD)","en":"Medicare wages (USD)"}},
    {"key":"num_employees","type":"number","required":true,"label_i18n":{"es":"Número de empleados","en":"Number of employees"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Declaración Trimestral del Empleador (Form 941)","en":"Employer''s Quarterly Federal Tax Return (Form 941)"}'::jsonb,
  '{"es":"Reporte trimestral de impuestos retenidos, Seguro Social y Medicare.","en":"Quarterly report of withheld income tax, Social Security, and Medicare taxes."}'::jsonb,
  30),

-- ── Federal W-2 / 1099 January (attached to Payroll product) ────────────────
('tax-america-services:fed-w2-1099', 'tax-america-services', 'tax-america-services:payroll', 'fed-w2-1099',
  'federal', 'annual',
  '{"type":"annual","date":"01-31"}'::jsonb,
  '[
    {"key":"num_w2","type":"number","required":true,"label_i18n":{"es":"Número de W-2 a emitir","en":"Number of W-2s to issue"}},
    {"key":"num_1099","type":"number","required":true,"label_i18n":{"es":"Número de 1099 a emitir","en":"Number of 1099s to issue"}},
    {"key":"contractor_list_notes","type":"text","required":false,"label_i18n":{"es":"Notas sobre contratistas o empleados nuevos","en":"Notes on new contractors or employees"}}
  ]'::jsonb,
  '{"es":"Emisión Anual de W-2 / 1099","en":"Annual W-2 / 1099 Filing"}'::jsonb,
  '{"es":"Emisión anual de formularios W-2 y 1099 al 31 de enero.","en":"Annual issuance of W-2 and 1099 forms by January 31."}'::jsonb,
  40),

-- ── Connecticut Sales & Use Tax — monthly ────────────────────────────────────
-- CT requires monthly filing for higher-volume sellers; quarterly otherwise.
-- Subscription `active_schedule_slugs` picks which one applies per customer.
('tax-america-services:ct-sut-monthly', 'tax-america-services', 'tax-america-services:sales-tax', 'ct-sut-monthly',
  'state:CT', 'monthly',
  '{"type":"monthly_following","day":20}'::jsonb,
  '[
    {"key":"gross_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas brutas del mes (USD)","en":"Gross sales for the month (USD)"}},
    {"key":"taxable_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas gravables (USD)","en":"Taxable sales (USD)"}},
    {"key":"exempt_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas exentas (USD)","en":"Exempt sales (USD)"}},
    {"key":"tax_collected","type":"currency","required":true,"label_i18n":{"es":"Impuesto sobre ventas recaudado (USD)","en":"Sales tax collected (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Impuesto sobre Ventas y Uso de CT — Mensual","en":"CT Sales & Use Tax — Monthly"}'::jsonb,
  '{"es":"Declaración mensual de impuesto sobre ventas (vence el día 20 del mes siguiente).","en":"Monthly sales tax return (due the 20th of the following month)."}'::jsonb,
  50),

-- ── Connecticut Sales & Use Tax — quarterly ─────────────────────────────────
('tax-america-services:ct-sut-quarterly', 'tax-america-services', 'tax-america-services:sales-tax', 'ct-sut-quarterly',
  'state:CT', 'quarterly',
  '{"type":"fixed_quarterly","dates":["04-30","07-31","10-31","01-31"]}'::jsonb,
  '[
    {"key":"gross_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas brutas del trimestre (USD)","en":"Gross sales for the quarter (USD)"}},
    {"key":"taxable_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas gravables (USD)","en":"Taxable sales (USD)"}},
    {"key":"exempt_sales","type":"currency","required":true,"label_i18n":{"es":"Ventas exentas (USD)","en":"Exempt sales (USD)"}},
    {"key":"tax_collected","type":"currency","required":true,"label_i18n":{"es":"Impuesto sobre ventas recaudado (USD)","en":"Sales tax collected (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Impuesto sobre Ventas y Uso de CT — Trimestral","en":"CT Sales & Use Tax — Quarterly"}'::jsonb,
  '{"es":"Declaración trimestral de impuesto sobre ventas.","en":"Quarterly sales tax return."}'::jsonb,
  60),

-- ── Connecticut Estimated Income Tax quarterly ──────────────────────────────
('tax-america-services:ct-estimated', 'tax-america-services', 'tax-america-services:individual-tax', 'ct-estimated',
  'state:CT', 'quarterly',
  '{"type":"fixed_quarterly","dates":["04-15","06-15","09-15","01-15"]}'::jsonb,
  '[
    {"key":"income_estimate","type":"currency","required":true,"label_i18n":{"es":"Ingreso estimado del trimestre (USD)","en":"Estimated income for the quarter (USD)"}},
    {"key":"prior_year_paid","type":"currency","required":false,"label_i18n":{"es":"Pagos estimados previos del año (USD)","en":"Prior estimated payments this year (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Impuesto Estimado de Connecticut","en":"CT Estimated Income Tax"}'::jsonb,
  '{"es":"Pago trimestral del impuesto estimado de Connecticut.","en":"Quarterly Connecticut estimated income tax payment."}'::jsonb,
  70)

on conflict (id) do nothing;

-- ── SEED: test customer (Martha Pause) + sample subscriptions ───────────────
insert into public.tax_customers (id, community_id, email, name, locale)
values ('cust_martha_pause', 'tax-america-services', 'inversur1310@gmail.com', 'Martha Pause', 'es')
on conflict (community_id, email) do nothing;

-- Subscribe Martha to Sales Tax (CT monthly only, opting out of quarterly)
-- and Payroll. Reminders go via email + in-app by default.
insert into public.tax_subscriptions (id, community_id, customer_id, product_id, active_schedule_slugs) values
  ('sub_martha_sales',   'tax-america-services', 'cust_martha_pause', 'tax-america-services:sales-tax', ARRAY['ct-sut-monthly']),
  ('sub_martha_payroll', 'tax-america-services', 'cust_martha_pause', 'tax-america-services:payroll',   null)
on conflict (customer_id, product_id) do nothing;

-- Deprecated old registration tables are intentionally not used by the app anymore.
-- Keep them as historical backups unless you have verified the migration and want to drop them manually.

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-2b: Customer relationships + FAQs
--
-- A customer can have many "relationships" with the business (a small catalog
-- of service tags across categories: business / individual / general / audit).
-- Each relationship type carries default FAQs sourced from public-domain
-- references (IRS, SBA, state DORs). Each community can override or hide the
-- defaults via tax_relationship_faqs.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Catalog of relationship types. Seeded by the platform; communities do not
-- create new types in v1 (keeps the FAQ default-set globally curated). If a
-- community needs a custom service tag, that's a future enhancement.
create table if not exists public.tax_relationship_types (
  id            text primary key,                   -- 'business.llc', 'individual.itin', etc.
  category      text not null,                      -- 'business' | 'individual' | 'general' | 'audit'
  slug          text not null,                      -- 'llc', 'itin', etc.
  name_i18n     jsonb not null default '{}'::jsonb, -- {en, es}
  description_i18n jsonb not null default '{}'::jsonb,
  display_order int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
do $$ begin
  alter table public.tax_relationship_types add constraint tax_relationship_types_category_chk
    check (category in ('business','individual','general','audit'));
exception when duplicate_object then null; end $$;
create index if not exists tax_relationship_types_category_idx
  on public.tax_relationship_types(category, display_order);

-- Default FAQs, seeded from public-domain sources. Keyed by relationship type;
-- evergreen content only (no specific dollar thresholds that change yearly).
-- Each row carries a `source_note` for owner-visible attribution.
create table if not exists public.tax_relationship_default_faqs (
  id                   text primary key,
  relationship_type_id text not null references public.tax_relationship_types(id) on delete cascade,
  display_order        int not null default 0,
  question_i18n        jsonb not null default '{}'::jsonb,
  answer_i18n          jsonb not null default '{}'::jsonb,
  source_note          text,
  created_at           timestamptz not null default now()
);
create index if not exists tax_relationship_default_faqs_type_idx
  on public.tax_relationship_default_faqs(relationship_type_id, display_order);

-- Per-community FAQ overrides. Three flavors:
--   (a) override of a default — `default_faq_id` set, question/answer replaced
--   (b) hide a default       — `default_faq_id` set, visible = false
--   (c) custom FAQ           — `default_faq_id` null, owner-authored
create table if not exists public.tax_relationship_faqs (
  id                   text primary key,
  community_id         text not null references public.communities(id) on delete cascade,
  relationship_type_id text not null references public.tax_relationship_types(id) on delete cascade,
  default_faq_id       text references public.tax_relationship_default_faqs(id) on delete set null,
  display_order        int not null default 0,
  question_i18n        jsonb not null default '{}'::jsonb,
  answer_i18n          jsonb not null default '{}'::jsonb,
  visible              boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (community_id, relationship_type_id, default_faq_id)
);
create index if not exists tax_relationship_faqs_community_type_idx
  on public.tax_relationship_faqs(community_id, relationship_type_id, display_order);

-- Customer ↔ relationship mapping (1-to-many).
create table if not exists public.tax_customer_relationships (
  id                   text primary key,
  customer_id          text not null references public.tax_customers(id) on delete cascade,
  relationship_type_id text not null references public.tax_relationship_types(id) on delete restrict,
  notes                text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by_email     text,
  unique (customer_id, relationship_type_id)
);
create index if not exists tax_customer_relationships_customer_idx
  on public.tax_customer_relationships(customer_id) where active;
create index if not exists tax_customer_relationships_type_idx
  on public.tax_customer_relationships(relationship_type_id) where active;

-- ── SEED: 13 relationship types across 4 categories ──────────────────────────
insert into public.tax_relationship_types (id, category, slug, name_i18n, description_i18n, display_order) values
  ('business.llc',                'business',   'llc',                '{"en":"LLC","es":"LLC (Sociedad de Responsabilidad Limitada)"}'::jsonb,                  '{"en":"Limited Liability Company filings and ongoing obligations.","es":"Declaraciones y obligaciones continuas de una LLC."}'::jsonb, 10),
  ('business.s_corp',             'business',   's_corp',             '{"en":"S-Corp","es":"S-Corp (Corporación S)"}'::jsonb,                                   '{"en":"S corporation election, Form 1120-S, and shareholder distributions.","es":"Elección S-Corp, Formulario 1120-S y distribuciones a accionistas."}'::jsonb, 20),
  ('business.partnership_1065',   'business',   'partnership_1065',   '{"en":"Partnership (1065)","es":"Sociedad (1065)"}'::jsonb,                              '{"en":"Multi-member partnerships filing Form 1065 and issuing K-1s.","es":"Sociedades de varios miembros que presentan el Formulario 1065 y emiten K-1."}'::jsonb, 30),
  ('business.sales_tax_filing',   'business',   'sales_tax_filing',   '{"en":"Sales Tax Filing","es":"Declaración de Impuesto sobre las Ventas"}'::jsonb,       '{"en":"Periodic state sales and use tax returns.","es":"Declaraciones periódicas estatales de impuesto sobre ventas y uso."}'::jsonb, 40),
  ('business.business_formation', 'business',   'business_formation', '{"en":"Business Formation","es":"Formación de Empresas"}'::jsonb,                        '{"en":"Forming an LLC, corporation, or partnership and registering with state and federal agencies.","es":"Constituir una LLC, corporación o sociedad y registrarla ante las agencias estatales y federales."}'::jsonb, 50),
  ('business.payroll',            'business',   'payroll',            '{"en":"Payroll","es":"Nómina"}'::jsonb,                                                  '{"en":"Payroll processing, tax deposits, and quarterly Form 941 filings.","es":"Procesamiento de nómina, depósitos de impuestos y declaraciones trimestrales del Formulario 941."}'::jsonb, 60),
  ('business.bookkeeping',        'business',   'bookkeeping',        '{"en":"Bookkeeping","es":"Contabilidad"}'::jsonb,                                        '{"en":"Ongoing recording, categorization, and reconciliation of business transactions.","es":"Registro, categorización y conciliación continuos de las transacciones del negocio."}'::jsonb, 70),
  ('individual.taxes',            'individual', 'taxes',              '{"en":"Individual Taxes (1040)","es":"Impuestos Personales (1040)"}'::jsonb,             '{"en":"Personal federal and state income tax returns.","es":"Declaraciones de impuestos federales y estatales personales."}'::jsonb, 100),
  ('individual.itin',             'individual', 'itin',               '{"en":"ITIN Application","es":"Solicitud de ITIN"}'::jsonb,                              '{"en":"Individual Taxpayer Identification Number applications and renewals (Form W-7).","es":"Solicitudes y renovaciones del Número de Identificación Personal del Contribuyente (Formulario W-7)."}'::jsonb, 110),
  ('general.notary',              'general',    'notary',             '{"en":"Notary","es":"Notario"}'::jsonb,                                                  '{"en":"Notarization of documents by a commissioned notary public.","es":"Notarización de documentos por un notario público comisionado."}'::jsonb, 200),
  ('general.translation',         'general',    'translation',        '{"en":"Translation","es":"Traducción"}'::jsonb,                                          '{"en":"Document translation between English and Spanish.","es":"Traducción de documentos entre inglés y español."}'::jsonb, 210),
  ('audit.irs',                   'audit',      'irs',                '{"en":"IRS Audit","es":"Auditoría del IRS"}'::jsonb,                                     '{"en":"Representation and response support during an IRS examination.","es":"Representación y apoyo de respuesta durante una auditoría del IRS."}'::jsonb, 300),
  ('audit.drs',                   'audit',      'drs',                '{"en":"State Tax Audit (DRS)","es":"Auditoría Estatal (DRS)"}'::jsonb,                   '{"en":"Representation during a state Department of Revenue Services audit.","es":"Representación durante una auditoría del Departamento Estatal de Servicios de Rentas."}'::jsonb, 310)
on conflict (id) do nothing;

-- ── SEED: default FAQs ────────────────────────────────────────────────────────
-- Evergreen content from public-domain sources. Owners can override per
-- community via tax_relationship_faqs. Source notes are owner-visible.
insert into public.tax_relationship_default_faqs (id, relationship_type_id, display_order, question_i18n, answer_i18n, source_note) values
  -- LLC
  ('business.llc.q1', 'business.llc', 10,
    '{"en":"What is an LLC?","es":"¿Qué es una LLC?"}'::jsonb,
    '{"en":"A Limited Liability Company is a U.S. business structure that limits its owners'' personal liability for business debts and offers flexibility in how it is taxed. Most LLCs are governed by state statute and an operating agreement.","es":"Una Sociedad de Responsabilidad Limitada (LLC) es una estructura de negocios estadounidense que limita la responsabilidad personal de sus dueños por las deudas del negocio y ofrece flexibilidad en cómo tributa. La mayoría de las LLC se rigen por la ley estatal y por un acuerdo operativo."}'::jsonb,
    'IRS.gov — Limited Liability Company (LLC); SBA.gov — Choose a business structure'),
  ('business.llc.q2', 'business.llc', 20,
    '{"en":"How is an LLC taxed by default?","es":"¿Cómo tributa una LLC por defecto?"}'::jsonb,
    '{"en":"By default, a single-member LLC is treated as a disregarded entity and reported on the owner''s Form 1040 (Schedule C), and a multi-member LLC is taxed as a partnership filing Form 1065. An LLC can elect to be taxed as a C corporation or S corporation by filing Form 8832 or Form 2553.","es":"Por defecto, una LLC de un solo miembro se trata como entidad ignorada y se reporta en el Formulario 1040 (Anexo C) del dueño, y una LLC de varios miembros tributa como sociedad presentando el Formulario 1065. Una LLC puede elegir tributar como corporación C o S presentando el Formulario 8832 o el Formulario 2553."}'::jsonb,
    'IRS Forms 8832 and 2553; IRS Pub 3402'),
  ('business.llc.q3', 'business.llc', 30,
    '{"en":"What documents should I keep for my LLC?","es":"¿Qué documentos debo guardar de mi LLC?"}'::jsonb,
    '{"en":"Maintain your articles of organization, operating agreement, EIN confirmation, annual state filings, separate business bank statements, invoices, receipts for deductible expenses, and copies of all federal and state returns. The IRS generally recommends keeping tax records for at least three years.","es":"Mantenga su acta constitutiva, acuerdo operativo, confirmación del EIN, declaraciones anuales estatales, estados de cuenta bancarios separados del negocio, facturas, recibos de gastos deducibles y copias de todas las declaraciones federales y estatales. El IRS generalmente recomienda conservar los registros fiscales por al menos tres años."}'::jsonb,
    'IRS Pub 583; IRS — How long should I keep records?'),

  -- S-Corp
  ('business.s_corp.q1', 'business.s_corp', 10,
    '{"en":"What is an S corporation?","es":"¿Qué es una corporación S?"}'::jsonb,
    '{"en":"An S corporation is a corporation that has elected to pass corporate income, losses, deductions, and credits through to its shareholders for federal tax purposes. Shareholders report this on their personal returns and are taxed at individual rates, avoiding double taxation on most income.","es":"Una corporación S es una corporación que ha elegido transferir los ingresos, pérdidas, deducciones y créditos corporativos a sus accionistas para fines fiscales federales. Los accionistas lo reportan en sus declaraciones personales y tributan a las tasas individuales, evitando la doble tributación sobre la mayoría de los ingresos."}'::jsonb,
    'IRS.gov — S Corporations'),
  ('business.s_corp.q2', 'business.s_corp', 20,
    '{"en":"How do I become an S corporation?","es":"¿Cómo me convierto en corporación S?"}'::jsonb,
    '{"en":"File Form 2553 (Election by a Small Business Corporation) with the IRS, signed by all shareholders. The election must generally be made no later than two months and 15 days after the start of the tax year in which it is to take effect.","es":"Presente el Formulario 2553 (Elección por una Pequeña Corporación) ante el IRS, firmado por todos los accionistas. La elección generalmente debe hacerse a más tardar dos meses y 15 días después del comienzo del año fiscal en que entrará en vigor."}'::jsonb,
    'IRS Form 2553 instructions'),
  ('business.s_corp.q3', 'business.s_corp', 30,
    '{"en":"Do S-Corp shareholder-employees need to take a salary?","es":"¿Los empleados-accionistas de una S-Corp deben recibir salario?"}'::jsonb,
    '{"en":"Yes. The IRS requires that shareholders who perform services for an S corporation be paid reasonable compensation as W-2 wages before any non-wage distributions are made. ''Reasonable'' generally means what a similar business would pay for similar services.","es":"Sí. El IRS requiere que los accionistas que prestan servicios a una corporación S reciban una compensación razonable como salarios W-2 antes de cualquier distribución que no sea salario. ''Razonable'' generalmente significa lo que un negocio similar pagaría por servicios similares."}'::jsonb,
    'IRS — S Corporation Compensation and Medical Insurance Issues'),

  -- Partnership (1065)
  ('business.partnership_1065.q1', 'business.partnership_1065', 10,
    '{"en":"Who must file Form 1065?","es":"¿Quién debe presentar el Formulario 1065?"}'::jsonb,
    '{"en":"Every domestic partnership must file Form 1065 to report its income, deductions, gains, losses, and credits. The partnership itself does not pay income tax; instead each partner receives a Schedule K-1 reporting their share, which they include on their personal returns.","es":"Toda sociedad nacional debe presentar el Formulario 1065 para reportar sus ingresos, deducciones, ganancias, pérdidas y créditos. La sociedad misma no paga impuesto sobre la renta; en su lugar, cada socio recibe un Anexo K-1 que reporta su parte, el cual incluyen en sus declaraciones personales."}'::jsonb,
    'IRS — About Form 1065'),
  ('business.partnership_1065.q2', 'business.partnership_1065', 20,
    '{"en":"When is Form 1065 due?","es":"¿Cuándo vence el Formulario 1065?"}'::jsonb,
    '{"en":"For a calendar-year partnership, Form 1065 is due March 15 of the following year. A six-month extension may be requested with Form 7004.","es":"Para una sociedad de año calendario, el Formulario 1065 vence el 15 de marzo del año siguiente. Se puede solicitar una prórroga de seis meses con el Formulario 7004."}'::jsonb,
    'IRS Form 1065 instructions; IRS Form 7004'),

  -- Sales Tax Filing
  ('business.sales_tax_filing.q1', 'business.sales_tax_filing', 10,
    '{"en":"How often do I file Connecticut sales and use tax?","es":"¿Con qué frecuencia presento el impuesto sobre ventas y uso de Connecticut?"}'::jsonb,
    '{"en":"The Connecticut Department of Revenue Services (DRS) assigns a filing frequency — monthly, quarterly, or annual — based on the size of your tax liability. DRS may change your frequency over time and will notify you in writing.","es":"El Departamento de Servicios de Rentas de Connecticut (DRS) asigna una frecuencia de presentación — mensual, trimestral o anual — según el tamaño de su obligación tributaria. El DRS puede cambiar su frecuencia con el tiempo y se lo notificará por escrito."}'::jsonb,
    'CT DRS — Sales and Use Tax'),
  ('business.sales_tax_filing.q2', 'business.sales_tax_filing', 20,
    '{"en":"Which sales are taxable in Connecticut?","es":"¿Qué ventas están sujetas a impuesto en Connecticut?"}'::jsonb,
    '{"en":"Most retail sales of tangible personal property and many enumerated services are taxable. Specific exemptions exist for items such as most grocery food, prescription drugs, and certain clothing. The CT DRS publishes the full list of taxable services and exemptions.","es":"La mayoría de las ventas al por menor de bienes personales tangibles y muchos servicios enumerados están sujetos a impuesto. Existen exenciones específicas para artículos como la mayoría de los alimentos de supermercado, medicamentos recetados y cierta ropa. El CT DRS publica la lista completa de servicios sujetos a impuesto y exenciones."}'::jsonb,
    'CT DRS — Sales and Use Tax Information; PS 2019(2)'),
  ('business.sales_tax_filing.q3', 'business.sales_tax_filing', 30,
    '{"en":"What records do I need to keep for sales tax?","es":"¿Qué registros debo mantener para el impuesto sobre las ventas?"}'::jsonb,
    '{"en":"Keep complete records of all sales (taxable and exempt), purchases, resale and exemption certificates, and copies of returns filed. Connecticut requires sales tax records to be kept for at least six years.","es":"Mantenga registros completos de todas las ventas (sujetas y exentas), compras, certificados de reventa y exención, y copias de las declaraciones presentadas. Connecticut requiere que los registros de impuesto sobre las ventas se conserven por al menos seis años."}'::jsonb,
    'CT DRS Reg. § 12-2-12; IRS Pub 583'),

  -- Business Formation
  ('business.business_formation.q1', 'business.business_formation', 10,
    '{"en":"What are the main steps to form an LLC or corporation?","es":"¿Cuáles son los pasos principales para formar una LLC o corporación?"}'::jsonb,
    '{"en":"Typical steps: choose a business name and check availability with the state, file formation documents (articles of organization or incorporation), draft an operating agreement or bylaws, obtain an Employer Identification Number (EIN) from the IRS, register for any required state tax accounts (sales, withholding), and open a business bank account.","es":"Pasos típicos: elegir un nombre comercial y verificar la disponibilidad ante el estado, presentar los documentos de formación (acta constitutiva), redactar un acuerdo operativo o estatutos, obtener un Número de Identificación del Empleador (EIN) del IRS, registrarse para las cuentas tributarias estatales requeridas (ventas, retención) y abrir una cuenta bancaria de negocio."}'::jsonb,
    'SBA.gov — 10 Steps to Start Your Business; IRS — Apply for an Employer Identification Number'),
  ('business.business_formation.q2', 'business.business_formation', 20,
    '{"en":"Do I need an EIN even if I have no employees?","es":"¿Necesito un EIN incluso si no tengo empleados?"}'::jsonb,
    '{"en":"Most businesses need an EIN. The IRS requires one if you operate as a corporation or partnership, have any employees, file employment or excise tax returns, or open a business bank account at most institutions. Single-member LLCs without employees may not be required, but most banks still ask for one.","es":"La mayoría de los negocios necesitan un EIN. El IRS lo exige si opera como corporación o sociedad, tiene empleados, presenta declaraciones de impuestos sobre el empleo o consumo, o abre una cuenta bancaria de negocio en la mayoría de las instituciones. Las LLC de un solo miembro sin empleados pueden no requerirlo, pero la mayoría de los bancos lo solicitan."}'::jsonb,
    'IRS — Do You Need an EIN?'),

  -- Payroll
  ('business.payroll.q1', 'business.payroll', 10,
    '{"en":"What payroll tax returns must my business file?","es":"¿Qué declaraciones de impuestos de nómina debe presentar mi negocio?"}'::jsonb,
    '{"en":"Most employers file Form 941 quarterly for federal income tax withholding and FICA (Social Security and Medicare). Annual filings typically include Form 940 (federal unemployment), Form W-2 for each employee, and corresponding state withholding and unemployment returns.","es":"La mayoría de los empleadores presentan el Formulario 941 trimestralmente para la retención del impuesto federal sobre la renta y FICA (Seguro Social y Medicare). Las presentaciones anuales generalmente incluyen el Formulario 940 (desempleo federal), el Formulario W-2 para cada empleado y las declaraciones correspondientes de retención y desempleo estatales."}'::jsonb,
    'IRS — Employment Taxes; IRS Forms 941, 940, W-2'),
  ('business.payroll.q2', 'business.payroll', 20,
    '{"en":"How often must I deposit federal payroll taxes?","es":"¿Con qué frecuencia debo depositar los impuestos federales de nómina?"}'::jsonb,
    '{"en":"The IRS assigns each employer a deposit schedule — monthly or semi-weekly — based on the total tax liability reported during a four-quarter lookback period. New employers typically start as monthly depositors. Deposits are made electronically through EFTPS.","es":"El IRS asigna a cada empleador un calendario de depósitos — mensual o quincenal — según la obligación tributaria total reportada durante un período de revisión de cuatro trimestres. Los empleadores nuevos generalmente comienzan como depositantes mensuales. Los depósitos se hacen electrónicamente a través de EFTPS."}'::jsonb,
    'IRS Pub 15 (Circular E)'),

  -- Bookkeeping
  ('business.bookkeeping.q1', 'business.bookkeeping', 10,
    '{"en":"Why is monthly bookkeeping important?","es":"¿Por qué es importante la contabilidad mensual?"}'::jsonb,
    '{"en":"Recording transactions monthly keeps your financial picture current, makes tax preparation faster and cheaper, supports loan and grant applications, and helps you catch errors or fraud early. The IRS expects businesses to maintain books that accurately reflect income and expenses.","es":"Registrar las transacciones mensualmente mantiene actualizada su imagen financiera, hace que la preparación de impuestos sea más rápida y económica, apoya las solicitudes de préstamos y subvenciones, y ayuda a detectar errores o fraude temprano. El IRS espera que los negocios mantengan libros que reflejen con precisión los ingresos y gastos."}'::jsonb,
    'IRS Pub 583 — Starting a Business and Keeping Records'),
  ('business.bookkeeping.q2', 'business.bookkeeping', 20,
    '{"en":"Should I separate business and personal accounts?","es":"¿Debo separar las cuentas comerciales y personales?"}'::jsonb,
    '{"en":"Yes. Using a dedicated business bank account and credit card protects the liability shield of an LLC or corporation, simplifies tax preparation, and creates a clean audit trail. Mixing accounts is one of the most common bookkeeping problems we help fix.","es":"Sí. Usar una cuenta bancaria y tarjeta de crédito dedicadas al negocio protege el escudo de responsabilidad de una LLC o corporación, simplifica la preparación de impuestos y crea un rastro de auditoría limpio. Mezclar cuentas es uno de los problemas de contabilidad más comunes que ayudamos a resolver."}'::jsonb,
    'SBA.gov — Manage your finances'),

  -- Individual Taxes
  ('individual.taxes.q1', 'individual.taxes', 10,
    '{"en":"When is my federal tax return due?","es":"¿Cuándo vence mi declaración federal?"}'::jsonb,
    '{"en":"Form 1040 is generally due April 15. If that date falls on a weekend or holiday, the due date moves to the next business day. You can request an automatic six-month extension to file (but not to pay) using Form 4868.","es":"El Formulario 1040 generalmente vence el 15 de abril. Si esa fecha cae en fin de semana o feriado, la fecha de vencimiento se traslada al siguiente día hábil. Puede solicitar una prórroga automática de seis meses para presentar (pero no para pagar) usando el Formulario 4868."}'::jsonb,
    'IRS — About Form 1040 / Form 4868'),
  ('individual.taxes.q2', 'individual.taxes', 20,
    '{"en":"What documents should I gather before my tax appointment?","es":"¿Qué documentos debo reunir antes de mi cita de impuestos?"}'::jsonb,
    '{"en":"Bring: photo ID, Social Security cards or ITINs for everyone on the return, last year''s return, all W-2s and 1099s, mortgage interest (1098) and property tax statements, records of charitable contributions, medical expenses, education-related forms (1098-T), child care provider information, and any letters received from the IRS or state.","es":"Traiga: identificación con foto, tarjetas de Seguro Social o ITIN de todas las personas en la declaración, la declaración del año anterior, todos los W-2 y 1099, estados de interés hipotecario (1098) y de impuesto a la propiedad, registros de donaciones caritativas, gastos médicos, formularios relacionados con educación (1098-T), información del proveedor de cuidado infantil y cualquier carta recibida del IRS o del estado."}'::jsonb,
    'IRS — What to bring to your tax appointment'),

  -- ITIN
  ('individual.itin.q1', 'individual.itin', 10,
    '{"en":"Who needs an ITIN?","es":"¿Quién necesita un ITIN?"}'::jsonb,
    '{"en":"An Individual Taxpayer Identification Number is issued by the IRS to people who must file or be reported on a U.S. tax return but who are not eligible for a Social Security Number. This typically includes non-resident aliens with U.S. tax obligations and certain dependents and spouses of U.S. residents.","es":"El Número de Identificación Personal del Contribuyente lo emite el IRS a personas que deben presentar o aparecer en una declaración fiscal de EE.UU. pero que no son elegibles para un Número de Seguro Social. Esto generalmente incluye extranjeros no residentes con obligaciones fiscales en EE.UU. y ciertos dependientes y cónyuges de residentes estadounidenses."}'::jsonb,
    'IRS — Individual Taxpayer Identification Number (ITIN)'),
  ('individual.itin.q2', 'individual.itin', 20,
    '{"en":"How do I apply for an ITIN?","es":"¿Cómo solicito un ITIN?"}'::jsonb,
    '{"en":"Submit Form W-7 along with your federal tax return and original (or certified copies of) identification documents such as a passport. You can apply through a Certified Acceptance Agent — many tax practices, including ours, are authorized to verify documents so you do not have to mail your originals to the IRS.","es":"Presente el Formulario W-7 junto con su declaración federal y documentos de identificación originales (o copias certificadas) como un pasaporte. Puede solicitarlo a través de un Agente de Aceptación Certificado — muchas oficinas de impuestos, incluyendo la nuestra, están autorizadas a verificar los documentos para que no tenga que enviar los originales al IRS."}'::jsonb,
    'IRS Form W-7 instructions; IRS — Certified Acceptance Agents'),
  ('individual.itin.q3', 'individual.itin', 30,
    '{"en":"How long is an ITIN valid?","es":"¿Por cuánto tiempo es válido un ITIN?"}'::jsonb,
    '{"en":"An ITIN that is not used on a federal tax return for three consecutive years will expire. ITINs with certain middle digits also expire on a published schedule. Expired ITINs must be renewed using Form W-7 before they can be used on a return.","es":"Un ITIN que no se use en una declaración federal por tres años consecutivos vencerá. Los ITIN con ciertos dígitos del medio también vencen según un calendario publicado. Los ITIN vencidos deben renovarse usando el Formulario W-7 antes de poder usarse en una declaración."}'::jsonb,
    'IRS — ITIN expiration'),

  -- Notary
  ('general.notary.q1', 'general.notary', 10,
    '{"en":"What does a notary public do?","es":"¿Qué hace un notario público?"}'::jsonb,
    '{"en":"A notary public is a public officer commissioned by the state to witness the signing of documents, verify signer identity, administer oaths, and deter fraud. A U.S. notary does not provide legal advice or draft documents — that is different from a ''notario público'' in many Latin American countries.","es":"Un notario público es un funcionario público comisionado por el estado para presenciar la firma de documentos, verificar la identidad del firmante, administrar juramentos y prevenir el fraude. Un notario en EE.UU. no brinda asesoría legal ni redacta documentos — eso es diferente al ''notario público'' en muchos países latinoamericanos."}'::jsonb,
    'National Notary Association; CT Secretary of the State — Notary information'),
  ('general.notary.q2', 'general.notary', 20,
    '{"en":"What should I bring to a notary appointment?","es":"¿Qué debo traer a una cita con el notario?"}'::jsonb,
    '{"en":"Bring the original, unsigned document and a current government-issued photo ID (driver''s license, passport, or state ID). Do not sign the document beforehand — the notary must witness the signature.","es":"Traiga el documento original sin firmar y una identificación oficial vigente con foto (licencia de conducir, pasaporte o identificación estatal). No firme el documento antes — el notario debe presenciar la firma."}'::jsonb,
    'National Notary Association'),

  -- Translation
  ('general.translation.q1', 'general.translation', 10,
    '{"en":"What is a certified translation?","es":"¿Qué es una traducción certificada?"}'::jsonb,
    '{"en":"A certified translation is accompanied by a signed statement from the translator attesting that the translation is complete and accurate. Many U.S. agencies — including USCIS and the IRS — require certified translations for foreign-language documents.","es":"Una traducción certificada va acompañada de una declaración firmada del traductor que certifica que la traducción es completa y precisa. Muchas agencias estadounidenses — incluyendo USCIS e IRS — exigen traducciones certificadas para documentos en idioma extranjero."}'::jsonb,
    'USCIS Policy Manual — Translations; American Translators Association'),

  -- IRS Audit
  ('audit.irs.q1', 'audit.irs', 10,
    '{"en":"I received an IRS notice. What should I do first?","es":"Recibí una notificación del IRS. ¿Qué debo hacer primero?"}'::jsonb,
    '{"en":"Do not ignore it and do not panic. Read the notice carefully to identify the tax year, the issue, and the deadline to respond. Bring the notice to your tax practice as soon as possible — most IRS notices have strict response windows, and a timely, well-documented reply often resolves the matter without a full audit.","es":"No la ignore ni se asuste. Lea la notificación con cuidado para identificar el año fiscal, el problema y la fecha límite para responder. Lleve la notificación a su oficina de impuestos lo antes posible — la mayoría de las notificaciones del IRS tienen plazos estrictos, y una respuesta oportuna y bien documentada a menudo resuelve el asunto sin una auditoría completa."}'::jsonb,
    'IRS — Understanding Your IRS Notice or Letter'),
  ('audit.irs.q2', 'audit.irs', 20,
    '{"en":"What rights do I have during an IRS audit?","es":"¿Qué derechos tengo durante una auditoría del IRS?"}'::jsonb,
    '{"en":"The Taxpayer Bill of Rights includes: the right to be informed, to quality service, to pay no more than the correct amount of tax, to challenge the IRS''s position, to appeal an IRS decision in an independent forum, to finality, to privacy, to confidentiality, to retain representation, and to a fair and just tax system.","es":"La Declaración de Derechos del Contribuyente incluye: el derecho a ser informado, a un servicio de calidad, a pagar no más del impuesto correcto, a impugnar la posición del IRS, a apelar una decisión del IRS en un foro independiente, a la finalidad, a la privacidad, a la confidencialidad, a tener representación, y a un sistema fiscal justo y equitativo."}'::jsonb,
    'IRS Pub 1 — Your Rights as a Taxpayer'),

  -- DRS Audit
  ('audit.drs.q1', 'audit.drs', 10,
    '{"en":"What can trigger a Connecticut DRS audit?","es":"¿Qué puede desencadenar una auditoría del DRS de Connecticut?"}'::jsonb,
    '{"en":"Common triggers include large discrepancies between your state return and federal return or 1099s, a sharp change in reported revenue, sales tax returns that don''t match your bank deposits, and selection through DRS''s random or industry-targeted audit programs.","es":"Los desencadenantes comunes incluyen grandes discrepancias entre su declaración estatal y su declaración federal o 1099, un cambio brusco en los ingresos reportados, declaraciones de impuesto sobre ventas que no coinciden con sus depósitos bancarios, y la selección a través de los programas de auditoría aleatorios o por industria del DRS."}'::jsonb,
    'CT DRS — Audit Information'),
  ('audit.drs.q2', 'audit.drs', 20,
    '{"en":"How far back can a DRS audit go?","es":"¿Hasta cuándo puede revisar el DRS en una auditoría?"}'::jsonb,
    '{"en":"Connecticut generally has three years from the date a return was filed to assess additional tax. The period is extended to six years if 25% or more of tax was omitted, and there is no time limit if a return was fraudulent or never filed.","es":"Connecticut generalmente tiene tres años desde la fecha en que se presentó una declaración para evaluar impuestos adicionales. El período se extiende a seis años si se omitió el 25% o más del impuesto, y no hay límite de tiempo si la declaración fue fraudulenta o nunca se presentó."}'::jsonb,
    'CGS § 12-415; CT DRS — Statute of limitations')
on conflict (id) do nothing;

-- ── SEED: tag Martha as Business: Sales Tax Filing + Business: Payroll ───────
-- (matches her existing tax_subscriptions so the portal FAQ filtering works
-- immediately on first deploy)
insert into public.tax_customer_relationships (id, customer_id, relationship_type_id, created_by_email) values
  ('crel_martha_sales',   'cust_martha_pause', 'business.sales_tax_filing', 'system@platform'),
  ('crel_martha_payroll', 'cust_martha_pause', 'business.payroll',          'system@platform')
on conflict (customer_id, relationship_type_id) do nothing;

-- ── SEED: bppause test customer (added Phase 2d test wave) ───────────────────
-- Deliberately a different profile from Martha so the per-customer tailoring
-- of FAQs, tips, and "Your services" chips is visibly distinct between the
-- two test accounts:
--   Martha (es)  → Business: Sales Tax Filing, Payroll
--   BP Pause (en) → Business: LLC, Individual: Taxes, Individual: ITIN,
--                   Audit: IRS Audit
-- Sign in to /tax/tax-america-services/portal with Google or by setting an
-- email/password for bppause@gmail.com. First-login UID linkage happens
-- automatically via Phase 2a's /auth/link.
insert into public.tax_customers (id, community_id, email, name, locale)
values ('cust_bppause', 'tax-america-services', 'bppause@gmail.com', 'BP Pause', 'en')
on conflict (community_id, email) do nothing;

-- One subscription so the dashboard's upcoming-filings list has content.
-- Individual taxes (1040) is annual / April-anchored, so this won't fire any
-- noisy reminders during normal off-season testing.
insert into public.tax_subscriptions (id, community_id, customer_id, product_id, active_schedule_slugs) values
  ('sub_bppause_indtax', 'tax-america-services', 'cust_bppause', 'tax-america-services:individual-tax', null)
on conflict (customer_id, product_id) do nothing;

insert into public.tax_customer_relationships (id, customer_id, relationship_type_id, created_by_email) values
  ('crel_bppause_llc',    'cust_bppause', 'business.llc',       'system@platform'),
  ('crel_bppause_indtax', 'cust_bppause', 'individual.taxes',   'system@platform'),
  ('crel_bppause_itin',   'cust_bppause', 'individual.itin',    'system@platform'),
  ('crel_bppause_irs',    'cust_bppause', 'audit.irs',          'system@platform')
on conflict (customer_id, relationship_type_id) do nothing;

-- ── SEED: additional test customers ──────────────────────────────────────────
-- Two more test customer rows so the CSV-import flow can be exercised against
-- pre-existing emails (both "skip" and "update" modes). marthajpause is a
-- second customer record for Martha (her original record under
-- inversur1310@gmail.com remains untouched). morroskaitest is a generic test
-- mailbox useful for both portal-login + import-update testing.
insert into public.tax_customers (id, community_id, email, name, locale) values
  ('cust_marthajpause',  'tax-america-services', 'marthajpause@gmail.com', 'Martha J Pause',    'es'),
  ('cust_morroskaitest', 'tax-america-services', 'morroskaitest@gmail.com', 'Morros Kai (test)', 'en')
on conflict (community_id, email) do nothing;

insert into public.tax_customer_relationships (id, customer_id, relationship_type_id, created_by_email) values
  ('crel_marthajpause_indtax', 'cust_marthajpause',  'individual.taxes', 'system@platform'),
  ('crel_marthajpause_itin',   'cust_marthajpause',  'individual.itin',  'system@platform'),
  ('crel_morroskai_llc',       'cust_morroskaitest', 'business.llc',         'system@platform'),
  ('crel_morroskai_book',      'cust_morroskaitest', 'business.bookkeeping', 'system@platform')
on conflict (customer_id, relationship_type_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-2c: Relationship-aware reminder tips
--
-- Short, practical tips tied to a relationship type. Two contexts:
--   filing_reminder  → injected into reminder emails + in-app notifications
--   general          → shown on the portal dashboard, not in reminders
--
-- v1 ships defaults only; per-community overrides are a future enhancement
-- (owners can still customize the wrapping reminder copy via email_templates
-- when those rows are introduced in Phase 4b).
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_relationship_default_tips (
  id                   text primary key,
  relationship_type_id text not null references public.tax_relationship_types(id) on delete cascade,
  context              text not null default 'filing_reminder',
  display_order        int not null default 0,
  tip_i18n             jsonb not null default '{}'::jsonb,
  source_note          text,
  created_at           timestamptz not null default now()
);
do $$ begin
  alter table public.tax_relationship_default_tips add constraint tax_relationship_default_tips_context_chk
    check (context in ('filing_reminder','general'));
exception when duplicate_object then null; end $$;
create index if not exists tax_relationship_default_tips_type_ctx_idx
  on public.tax_relationship_default_tips(relationship_type_id, context, display_order);

insert into public.tax_relationship_default_tips (id, relationship_type_id, context, display_order, tip_i18n, source_note) values
  -- Business: LLC
  ('tip.llc.fr1', 'business.llc', 'filing_reminder', 10,
    '{"en":"Member contributions, distributions, and (if you elected S-corp status) reasonable salary each have different tax treatments. Keep a clean record of each transaction throughout the year.","es":"Las aportaciones de los miembros, distribuciones y (si eligió el estatus de S-Corp) un salario razonable reciben distintos tratamientos fiscales. Mantenga un registro claro de cada transacción durante el año."}'::jsonb,
    'Practical guidance; see IRS Pub 541 (Partnerships) / IRS Pub 542 (Corporations)'),
  ('tip.llc.g1', 'business.llc', 'general', 20,
    '{"en":"Document key LLC decisions in writing — even for a single-member LLC. Annual meeting minutes and written consents strengthen the liability shield if your LLC is ever challenged.","es":"Documente por escrito las decisiones importantes de su LLC — incluso si es de un solo miembro. Las actas anuales y consentimientos por escrito refuerzan el escudo de responsabilidad si la LLC es cuestionada alguna vez."}'::jsonb,
    'SBA.gov — Maintain your business'),

  -- Business: S-Corp
  ('tip.scorp.fr1', 'business.s_corp', 'filing_reminder', 10,
    '{"en":"S-corp shareholder-employees must take reasonable W-2 wages before any non-wage distributions. Distributions taken instead of wages are a top IRS audit trigger and can be reclassified with penalties and back payroll taxes.","es":"Los empleados-accionistas de S-Corp deben recibir salarios W-2 razonables antes de cualquier distribución no salarial. Tomar distribuciones en lugar de salarios es uno de los principales desencadenantes de auditoría del IRS y puede reclasificarse con multas e impuestos atrasados de nómina."}'::jsonb,
    'IRS — S Corporation Compensation and Medical Insurance Issues'),

  -- Business: Partnership (1065)
  ('tip.p1065.fr1', 'business.partnership_1065', 'filing_reminder', 10,
    '{"en":"K-1s must be furnished to every partner by the partnership filing deadline (March 15 for calendar-year partnerships). Late K-1s expose the partnership to per-partner, per-month penalties — these add up quickly.","es":"Los K-1 deben entregarse a cada socio antes de la fecha de presentación de la sociedad (15 de marzo para sociedades de año calendario). Los K-1 tardíos exponen a la sociedad a multas por socio y por mes — se acumulan rápido."}'::jsonb,
    'IRS Form 1065 instructions; IRC §6698'),

  -- Business: Sales Tax Filing
  ('tip.salestax.fr1', 'business.sales_tax_filing', 'filing_reminder', 10,
    '{"en":"Your reported gross sales should reconcile to your bank deposits and any 1099-K from payment processors. CT DRS cross-checks these — large unexplained gaps are a common audit trigger.","es":"Sus ventas brutas reportadas deben conciliar con sus depósitos bancarios y cualquier 1099-K de procesadores de pago. El CT DRS verifica esto — las brechas grandes sin explicación son un desencadenante común de auditoría."}'::jsonb,
    'CT DRS — Sales and Use Tax audits'),
  ('tip.salestax.fr2', 'business.sales_tax_filing', 'filing_reminder', 20,
    '{"en":"Keep resale and exemption certificates for every non-taxable sale. Without a valid certificate on file, DRS will treat the sale as taxable during an audit — even if the customer was actually exempt.","es":"Mantenga certificados de reventa y exención para cada venta no gravable. Sin un certificado válido archivado, el DRS tratará la venta como gravable durante una auditoría — incluso si el cliente realmente estaba exento."}'::jsonb,
    'CT DRS — Sales and Use Tax'),

  -- Business: Business Formation
  ('tip.busform.g1', 'business.business_formation', 'general', 10,
    '{"en":"Register for state tax accounts (sales, withholding) BEFORE your first sale or first hire. Backdating registrations triggers penalty assessments — registering early is free and prevents costly cleanup later.","es":"Regístrese para las cuentas tributarias estatales (ventas, retención) ANTES de su primera venta o primera contratación. Retroactivar registros genera multas — registrarse temprano es gratis y evita correcciones costosas más adelante."}'::jsonb,
    'CT DRS — Register your business'),

  -- Business: Payroll
  ('tip.payroll.fr1', 'business.payroll', 'filing_reminder', 10,
    '{"en":"Household help, contractors paid $600 or more, and S-corp owner wages all create filing obligations — even if your business has no traditional employees. Tell us about every person who receives money from your business.","es":"La ayuda doméstica, los contratistas que reciben $600 o más, y los salarios de los dueños de S-Corp generan obligaciones de declaración — incluso si su negocio no tiene empleados tradicionales. Cuéntenos sobre cada persona que recibe dinero de su negocio."}'::jsonb,
    'IRS — Independent contractor vs. employee; IRS Form 1099-NEC'),
  ('tip.payroll.fr2', 'business.payroll', 'filing_reminder', 20,
    '{"en":"Payroll-tax deposit penalties stack fast: 2% (1–5 days late), 5% (6–15 days), 10% (>15 days), and 15% if you wait until the IRS demands payment. If you''re unsure about a deposit, contact us before the deadline.","es":"Las multas por depósitos de impuestos de nómina se acumulan rápido: 2% (1–5 días tarde), 5% (6–15 días), 10% (más de 15 días) y 15% si espera a que el IRS exija el pago. Si tiene dudas sobre un depósito, contáctenos antes del vencimiento."}'::jsonb,
    'IRC §6656; IRS Pub 15 (Circular E)'),

  -- Business: Bookkeeping
  ('tip.book.fr1', 'business.bookkeeping', 'filing_reminder', 10,
    '{"en":"Reconcile your business bank and credit card statements every month. Unreconciled balances are the #1 cause of last-minute scrambling at tax time and inflate the cost of preparing your return.","es":"Concilie sus estados de cuenta bancarios y de tarjeta de crédito del negocio cada mes. Los saldos sin conciliar son la causa #1 de prisas de última hora en temporada de impuestos e inflan el costo de preparar su declaración."}'::jsonb,
    'Practical guidance; IRS Pub 583'),

  -- Individual Taxes
  ('tip.indtax.fr1', 'individual.taxes', 'filing_reminder', 10,
    '{"en":"If you received any IRS or state notices since your last filing — even ones you ignored — please bring them to your appointment. Issues compound when ignored, and many notices have strict response windows.","es":"Si recibió notificaciones del IRS o estatales desde su última declaración — incluso las que ignoró — por favor tráigalas a su cita. Los problemas se acumulan al ignorarlos, y muchas notificaciones tienen plazos estrictos de respuesta."}'::jsonb,
    'IRS Pub 5181 — Understanding Your IRS Notice'),
  ('tip.indtax.g1', 'individual.taxes', 'general', 20,
    '{"en":"Keep a single tax folder (paper or digital) year-round. Drop in W-2s, 1099s, donation receipts, and IRS letters as they arrive. Future-you will thank present-you in April.","es":"Mantenga una sola carpeta de impuestos (papel o digital) durante todo el año. Agregue W-2s, 1099s, recibos de donaciones y cartas del IRS conforme lleguen. Su yo futuro se lo agradecerá a su yo presente en abril."}'::jsonb,
    'Practical guidance'),

  -- ITIN
  ('tip.itin.g1', 'individual.itin', 'general', 10,
    '{"en":"ITIN renewals can take 7+ weeks during peak season (January–April). If yours expires before next April, start the renewal now so it doesn''t delay your refund.","es":"Las renovaciones de ITIN pueden tardar más de 7 semanas en temporada alta (enero–abril). Si el suyo vence antes del próximo abril, comience la renovación ahora para que no retrase su reembolso."}'::jsonb,
    'IRS — ITIN expiration and renewal'),

  -- Notary
  ('tip.notary.g1', 'general.notary', 'general', 10,
    '{"en":"Bring valid government-issued photo ID and the UNSIGNED document. The notary must witness your signature in person — pre-signed documents cannot be notarized.","es":"Traiga una identificación oficial vigente con foto y el documento SIN FIRMAR. El notario debe presenciar su firma en persona — los documentos firmados previamente no pueden notarizarse."}'::jsonb,
    'National Notary Association'),

  -- Translation
  ('tip.translation.g1', 'general.translation', 'general', 10,
    '{"en":"USCIS and the IRS both require certified translations for foreign-language documents. Plan ahead — longer documents can take 3–5 business days.","es":"Tanto USCIS como el IRS requieren traducciones certificadas para documentos en idioma extranjero. Planifique con anticipación — los documentos más largos pueden tomar 3–5 días hábiles."}'::jsonb,
    'USCIS Policy Manual — Translations'),

  -- IRS Audit
  ('tip.audit_irs.g1', 'audit.irs', 'general', 10,
    '{"en":"If you receive an IRS notice, save the envelope. The postmark date can matter for response deadlines, and the notice number printed on the letter tells us exactly which IRS division is involved.","es":"Si recibe una notificación del IRS, guarde el sobre. La fecha del matasellos puede importar para los plazos de respuesta, y el número de notificación impreso en la carta nos dice exactamente qué división del IRS está involucrada."}'::jsonb,
    'IRS — Understanding Your IRS Notice or Letter'),

  -- DRS Audit
  ('tip.audit_drs.g1', 'audit.drs', 'general', 10,
    '{"en":"CT DRS audits often start as a desk audit (requests by mail). Responding fully and on time often prevents escalation to a field audit — partial or late responses almost always make the audit broader.","es":"Las auditorías del CT DRS a menudo comienzan como auditorías de escritorio (solicitudes por correo). Responder de forma completa y a tiempo a menudo evita la escalada a una auditoría de campo — las respuestas parciales o tardías casi siempre amplían la auditoría."}'::jsonb,
    'CT DRS — Audit Information')
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-2d: Customer documents
--
-- Files uploaded by the customer (statements, prior returns, ID for ITIN) or
-- by the practice (completed returns, K-1s, payment confirmations). Storage
-- lives in the private `tax-documents` bucket below; this table is the
-- metadata index and audit trail.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Create the private storage bucket. Idempotent: only inserts if missing.
-- IMPORTANT: if your Supabase project does not have the Storage extension
-- enabled, this line will be skipped silently (the do-block catches the
-- missing-table error). In that case, create the bucket via the Supabase
-- Dashboard → Storage → New bucket → "tax-documents" (private).
do $$ begin
  insert into storage.buckets (id, name, public)
  values ('tax-documents', 'tax-documents', false)
  on conflict (id) do nothing;
exception when undefined_table then
  raise notice 'storage.buckets table not available — create the tax-documents bucket via Supabase Dashboard';
end $$;

create table if not exists public.tax_documents (
  id                text primary key,
  community_id      text not null references public.communities(id) on delete cascade,
  customer_id       text not null references public.tax_customers(id) on delete cascade,
  period_id         text references public.tax_filing_periods(id) on delete set null,

  -- Source: who put this here. 'customer' = customer-uploaded, 'practice' =
  -- owner-uploaded for the customer to pick up (e.g., completed return).
  source            text not null,

  -- Owner-facing classification. Free-text for v1; Phase 4a may add a
  -- managed enum. Defaults map to common workflow buckets.
  kind              text default 'general',

  -- File metadata. Original file name is preserved for owner convenience;
  -- storage path is opaque (uses doc id, not the file name).
  file_name         text not null,
  mime_type         text not null,
  size_bytes        bigint not null,
  storage_path      text not null,

  -- Lifecycle. status = 'draft' until the upload PUT succeeds; the
  -- /finalize call flips it to 'uploaded'. Failed/abandoned drafts can be
  -- swept by a future cleanup job (defer in v1).
  status            text not null default 'draft',
  uploaded_by_role  text not null,            -- 'customer' | 'practice'
  uploaded_by_email text,
  uploaded_at       timestamptz,

  -- Soft delete keeps the audit trail intact. The storage object is removed
  -- from the bucket on hard delete (admin action only).
  deleted_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
do $$ begin
  alter table public.tax_documents add constraint tax_documents_source_chk
    check (source in ('customer','practice'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_documents add constraint tax_documents_status_chk
    check (status in ('draft','uploaded','failed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_documents add constraint tax_documents_role_chk
    check (uploaded_by_role in ('customer','practice'));
exception when duplicate_object then null; end $$;

create index if not exists tax_documents_customer_idx
  on public.tax_documents(customer_id, status, created_at desc)
  where deleted_at is null;
create index if not exists tax_documents_community_idx
  on public.tax_documents(community_id, status, created_at desc)
  where deleted_at is null;
create index if not exists tax_documents_period_idx
  on public.tax_documents(period_id) where period_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-2f: Customer ↔ practice messaging
--
-- Thread-per-conversation between a customer and the practice. The practice
-- side is multi-user in concept (Phase 3 introduces employees), but for v1
-- every practice-side message is attributed to the owner (global admin).
--
-- Denormalized last_message_* + *_unread columns keep the thread-list query
-- to a single round trip with no per-message join.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.tax_message_threads (
  id                   text primary key,
  community_id         text not null references public.communities(id) on delete cascade,
  customer_id          text not null references public.tax_customers(id) on delete cascade,
  subject              text not null default '',
  related_period_id    text references public.tax_filing_periods(id) on delete set null,
  related_document_id  text references public.tax_documents(id) on delete set null,
  status               text not null default 'open',
  created_by_role      text not null,
  created_by_email     text,

  -- Denormalized fields refreshed on every message insert. last_message_preview
  -- is the first ~200 chars of the body; UI truncates further if needed.
  last_message_at      timestamptz,
  last_message_preview text not null default '',
  last_message_by_role text,

  -- Unread booleans flip true for the OTHER party on insert, and false on
  -- POST /threads/:id/read by that party.
  customer_unread      boolean not null default false,
  practice_unread      boolean not null default false,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
do $$ begin
  alter table public.tax_message_threads add constraint tax_message_threads_status_chk
    check (status in ('open','closed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_message_threads add constraint tax_message_threads_role_chk
    check (created_by_role in ('customer','practice'));
exception when duplicate_object then null; end $$;
create index if not exists tax_message_threads_customer_idx
  on public.tax_message_threads(customer_id, last_message_at desc nulls last);
create index if not exists tax_message_threads_community_idx
  on public.tax_message_threads(community_id, last_message_at desc nulls last);
create index if not exists tax_message_threads_practice_unread_idx
  on public.tax_message_threads(community_id) where practice_unread;

create table if not exists public.tax_messages (
  id            text primary key,
  thread_id     text not null references public.tax_message_threads(id) on delete cascade,
  community_id  text not null references public.communities(id) on delete cascade,
  customer_id   text not null references public.tax_customers(id) on delete cascade,
  author_role   text not null,
  author_email  text,
  author_name   text not null default '',
  body          text not null,

  -- Attachments are stored as a JSON array of { document_id, file_name }
  -- pointers into tax_documents. The column exists in v1 even though the
  -- UI does not yet expose an attachment picker (Phase 4a).
  attachments   jsonb not null default '[]'::jsonb,

  created_at    timestamptz not null default now()
);
do $$ begin
  alter table public.tax_messages add constraint tax_messages_role_chk
    check (author_role in ('customer','practice'));
exception when duplicate_object then null; end $$;
create index if not exists tax_messages_thread_idx
  on public.tax_messages(thread_id, created_at asc);
create index if not exists tax_messages_customer_idx
  on public.tax_messages(customer_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-3: Employee portal
--
-- Practice-side users (separate from tax_customers). Authenticate via the
-- same Firebase project as customers — the URL of the portal entry point
-- determines which side renders (/portal vs /employee). An email may exist
-- in both tax_customers AND tax_employees independently (different rows,
-- same Google UID once both /auth/link endpoints fire).
--
-- v1 scope: team-wide thread visibility, no per-customer assignment.
-- Phase 3b will introduce tax_employee_customer_assignments.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_employees (
  id                              text primary key,
  community_id                    text not null references public.communities(id) on delete cascade,
  email                           text not null,
  name                            text not null default '',
  phone                           text not null default '',
  whatsapp                        text not null default '',
  address                         jsonb not null default '{}'::jsonb,
  preferred_communication_email   text not null default '',
  locale                          text not null default 'en',
  -- Notification channel preferences for THIS employee. Defaults to portal-
  -- only ([in_app]); employees may include 'email' through the profile page.
  -- Phase 4n.11: superseded by per-type `notification_prefs` below — kept as
  -- the migration-compatible default when no per-type pref is set.
  notification_channels           text[] not null default array['in_app']::text[],
  -- Phase 4n.11: per-notification-type channel map. Shape:
  --   { "<type>": { "in_app": bool, "email": bool }, ... }
  -- Missing keys fall back to notification_channels above (legacy global
  -- toggle). The 'welcome' type is implicit and always email-only — sent
  -- once on employee creation; not stored here.
  notification_prefs              jsonb not null default '{}'::jsonb,
  role                            text not null default 'staff',
  status                          text not null default 'active',
  firebase_uid                    text not null default '',
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (community_id, email)
);
do $$ begin
  alter table public.tax_employees add constraint tax_employees_locale_chk
    check (locale in ('en','es'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_employees add constraint tax_employees_role_chk
    check (role in ('staff','admin'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_employees add constraint tax_employees_status_chk
    check (status in ('active','paused','archived'));
exception when duplicate_object then null; end $$;
create index if not exists tax_employees_community_idx
  on public.tax_employees(community_id, status);

-- Phase 4n.11: per-type notification preference. Idempotent for existing
-- tenants whose tax_employees was created before this column landed.
alter table public.tax_employees
  add column if not exists notification_prefs jsonb not null default '{}'::jsonb;

-- Phase 4n.35: employee permission delegation. Owners can opt-out an
-- employee from specific powers — by default every key is treated as
-- granted (so new employees start with the same access as the owner).
-- Shape: { "<perm_key>": false } means revoked. Keys absent or set to
-- true mean granted. See server/modules/tax/permissions.js for the
-- registry and effective-permission resolver.
alter table public.tax_employees
  add column if not exists permissions jsonb not null default '{}'::jsonb;

-- Phase 4n.24: e-signature requests. Owner creates a request → customer
-- sees it in the portal → customer reviews and signs by typing their
-- legal name + clicking "I agree". The consent text + typed name + IP +
-- timestamp constitute the e-signature record (US ESIGN Act §101(g)).
-- signature_data is a JSONB envelope so future variants (drawn signature
-- dataURL, hardware-token signatures) can layer in without a migration.
create table if not exists public.tax_signature_requests (
  id                  text primary key,
  community_id        text not null references public.communities(id) on delete cascade,
  customer_id         text not null references public.tax_customers(id) on delete cascade,
  requested_by_email  text not null default '',
  requested_by_name   text not null default '',
  title               text not null,
  description         text not null default '',
  document_id         text references public.tax_documents(id) on delete set null,
  status              text not null default 'pending'
                      check (status in ('pending','signed','declined','cancelled','expired')),
  consent_text        text not null default '',
  expires_at          timestamptz,
  signed_at           timestamptz,
  signer_name         text not null default '',
  signer_email        text not null default '',
  signer_ip           text not null default '',
  signature_data      jsonb,
  cancelled_at        timestamptz,
  cancelled_by_email  text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_tax_signature_requests_customer
  on public.tax_signature_requests(customer_id, created_at desc);
create index if not exists idx_tax_signature_requests_status
  on public.tax_signature_requests(community_id, status, created_at desc);
alter table public.tax_signature_requests disable row level security;

-- Phase 4n.21: threaded customer notes. The existing tax_customers.notes
-- is a single overwritable text blob — fine for "this customer prefers
-- WhatsApp" stuck-on-the-row context, but no good for a multi-entry
-- timeline. This table is the timeline.
create table if not exists public.tax_customer_notes (
  id            text primary key,
  community_id  text not null references public.communities(id) on delete cascade,
  customer_id   text not null references public.tax_customers(id) on delete cascade,
  body          text not null default '',
  author_email  text not null default '',
  author_name   text not null default '',
  author_role   text not null default 'staff',   -- 'admin' | 'staff'
  created_at    timestamptz not null default now()
);
create index if not exists idx_tax_customer_notes_customer
  on public.tax_customer_notes(customer_id, created_at desc);
alter table public.tax_customer_notes disable row level security;

-- Employee in-portal notifications. Kept separate from tax_notifications
-- (customer-scoped) because the access patterns differ — employees query
-- their own inbox in aggregate, customers see their own bell only.
create table if not exists public.tax_employee_notifications (
  id            text primary key,
  community_id  text not null references public.communities(id) on delete cascade,
  employee_id   text not null references public.tax_employees(id) on delete cascade,
  type          text not null,
  title_i18n    jsonb not null default '{}'::jsonb,
  body_i18n     jsonb not null default '{}'::jsonb,
  payload       jsonb not null default '{}'::jsonb,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists tax_employee_notifications_inbox_idx
  on public.tax_employee_notifications(employee_id, created_at desc) where read_at is null;
create index if not exists tax_employee_notifications_all_idx
  on public.tax_employee_notifications(employee_id, created_at desc);

-- Seed: bppause@gmail.com as an EMPLOYEE for the same community where they
-- already exist as a customer. Same Google login; the portal URL determines
-- which experience renders. role='admin' so they can test owner-equivalent
-- flows when Phase 4a introduces real role-gated UI.
insert into public.tax_employees (id, community_id, email, name, locale, role)
values ('emp_bppause', 'tax-america-services', 'bppause@gmail.com', 'BP Pause (staff)', 'en', 'admin')
on conflict (community_id, email) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-3b: Employee ↔ customer assignments
--
-- Many-to-many mapping between tax_employees and tax_customers. Used by the
-- Phase 3 employee portal to scope a `staff`-role employee's visibility to
-- their assigned customers only. `admin`-role employees ignore this table
-- and see every customer in their community.
--
-- Soft delete (active=false) keeps the audit trail intact across re-assigns.
-- is_primary flags one staffer as the "lead" for a customer (purely an
-- informational hint for UI sorting; no enforced uniqueness in v1).
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_employee_customer_assignments (
  id                text primary key,
  community_id      text not null references public.communities(id) on delete cascade,
  employee_id       text not null references public.tax_employees(id) on delete cascade,
  customer_id       text not null references public.tax_customers(id) on delete cascade,
  is_primary        boolean not null default false,
  assigned_by_email text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, customer_id)
);
create index if not exists tax_emp_cust_assign_employee_idx
  on public.tax_employee_customer_assignments(employee_id) where active;
create index if not exists tax_emp_cust_assign_customer_idx
  on public.tax_employee_customer_assignments(customer_id) where active;
create index if not exists tax_emp_cust_assign_community_idx
  on public.tax_employee_customer_assignments(community_id) where active;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-4c: Help system
--
-- Platform-curated help articles. Two audiences:
--   audience='customer'  → /portal/help, filtered to articles where
--                          relationship_type_id IS NULL (general) OR matches
--                          one of the customer's active relationships.
--   audience='employee'  → /employee/help, general portal-usage articles.
--
-- v1 ships defaults only; per-community overrides are a future enhancement
-- mirroring the FAQ override design from Phase 2b.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_help_articles (
  id                   text primary key,
  audience             text not null,
  relationship_type_id text references public.tax_relationship_types(id) on delete cascade,
  category             text not null default 'general',
  display_order        int not null default 0,
  title_i18n           jsonb not null default '{}'::jsonb,
  body_i18n            jsonb not null default '{}'::jsonb,
  source_note          text,
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);
do $$ begin
  alter table public.tax_help_articles add constraint tax_help_articles_audience_chk
    check (audience in ('customer','employee'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_help_articles add constraint tax_help_articles_category_chk
    check (category in (
      'getting_started','documents','messages','filings','profile','notifications','service','admin'
    ));
exception when duplicate_object then null; end $$;
create index if not exists tax_help_articles_customer_idx
  on public.tax_help_articles(audience, relationship_type_id, display_order) where active;
create index if not exists tax_help_articles_employee_idx
  on public.tax_help_articles(audience, category, display_order) where active and audience='employee';

-- ── Customer general articles (audience='customer', no relationship tag) ─────
insert into public.tax_help_articles (id, audience, relationship_type_id, category, display_order, title_i18n, body_i18n) values
  ('help.cust.gs.signin', 'customer', null, 'getting_started', 10,
    '{"en":"Signing in to your portal","es":"Cómo iniciar sesión en su portal"}'::jsonb,
    '{"en":"Use the Google account or email/password that matches the email on file with your tax practice. If you do not have a password yet, click ''First time? Create a password'' on the sign-in page and follow the prompts.\n\nIf your sign-in email differs from the one your tax practice has on record, contact your practice and ask them to update it before you sign in. Sign-in email cannot be changed from inside the portal.","es":"Use la cuenta de Google o el correo y contraseña que coincidan con el correo registrado en su oficina de impuestos. Si aún no tiene contraseña, haga clic en ''¿Primera vez? Crear contraseña'' en la página de inicio de sesión y siga las indicaciones.\n\nSi su correo de inicio de sesión difiere del que tiene su oficina, contáctelos y pídales que lo actualicen antes de iniciar sesión. El correo de inicio de sesión no se puede cambiar desde el portal."}'::jsonb),
  ('help.cust.docs.upload', 'customer', null, 'documents', 20,
    '{"en":"Uploading documents securely","es":"Cómo subir documentos de forma segura"}'::jsonb,
    '{"en":"Open the Documents tab in your portal and click ''Upload a file''. Supported types: PDF, JPEG/PNG/HEIC images, Word, Excel, CSV, and plain text. Each file must be 25 MB or smaller.\n\nFiles you upload are stored in encrypted cloud storage and are only visible to you and your tax practice. You can delete files you uploaded yourself at any time. Files your tax practice uploads for you can only be removed by them.","es":"Abra la pestaña Documentos en su portal y haga clic en ''Subir un archivo''. Tipos compatibles: PDF, imágenes JPEG/PNG/HEIC, Word, Excel, CSV y texto. Cada archivo debe ser de 25 MB o menos.\n\nLos archivos que sube se almacenan cifrados en la nube y solo son visibles para usted y su oficina de impuestos. Puede eliminar los archivos que subió en cualquier momento. Los archivos que su oficina sube para usted solo pueden ser eliminados por ellos."}'::jsonb),
  ('help.cust.docs.download', 'customer', null, 'documents', 30,
    '{"en":"Downloading documents your tax practice has shared","es":"Cómo descargar documentos que su oficina compartió"}'::jsonb,
    '{"en":"When your tax practice uploads a document for you — for example, a completed return or signed engagement letter — you receive both an in-portal notification and an email. The email links back to the portal; the file itself is not attached.\n\nFrom the Documents tab, click Download on any row labeled ''From your tax practice'' to retrieve the file. Download links are valid for five minutes once generated.","es":"Cuando su oficina de impuestos sube un documento para usted — por ejemplo, una declaración completada o una carta firmada — recibirá una notificación en el portal y un correo. El correo enlaza al portal; el archivo en sí no se adjunta.\n\nDesde la pestaña Documentos, haga clic en Descargar en cualquier fila marcada ''De su oficina de impuestos'' para obtener el archivo. Los enlaces de descarga son válidos por cinco minutos una vez generados."}'::jsonb),
  ('help.cust.filings.respond', 'customer', null, 'filings', 40,
    '{"en":"Responding to a filing information request","es":"Cómo responder a una solicitud de información para una declaración"}'::jsonb,
    '{"en":"When a filing is approaching its due date, your tax practice will send a reminder asking for the information they need. You can respond two ways:\n\n• Click the link in the email (one-time, secure)\n• Sign in to your portal and open the filing from the Dashboard\n\nFill out each required field, attach any supporting notes, and submit. Your practice will be notified immediately.","es":"Cuando una declaración se acerca a su fecha de vencimiento, su oficina enviará un recordatorio solicitando la información necesaria. Puede responder de dos formas:\n\n• Haga clic en el enlace del correo (uso único, seguro)\n• Inicie sesión en su portal y abra la declaración desde el Panel\n\nComplete cada campo requerido, agregue notas de apoyo y envíe. Su oficina será notificada de inmediato."}'::jsonb),
  ('help.cust.messages', 'customer', null, 'messages', 50,
    '{"en":"Messaging your tax practice","es":"Cómo enviar mensajes a su oficina de impuestos"}'::jsonb,
    '{"en":"Use the Messages tab to start a conversation directly with your tax practice. Click ''Start a new conversation'', add an optional subject, write your question, and send. Your practice receives an email alert and your message lands in their inbox.\n\nReplies from your practice come back as in-portal notifications and email, depending on your preferences. Each conversation stays threaded so you can scroll back to earlier messages.","es":"Use la pestaña Mensajes para iniciar una conversación directa con su oficina. Haga clic en ''Iniciar conversación'', agregue un asunto opcional, escriba su pregunta y envíe. Su oficina recibe una alerta por correo y su mensaje aparece en su bandeja.\n\nLas respuestas de su oficina llegan como notificaciones en el portal y por correo, según sus preferencias. Cada conversación queda agrupada para que pueda revisar mensajes anteriores."}'::jsonb),
  ('help.cust.profile', 'customer', null, 'profile', 60,
    '{"en":"Updating your contact info","es":"Cómo actualizar su información de contacto"}'::jsonb,
    '{"en":"From the Profile tab you can update your phone, WhatsApp number, mailing address, and a preferred communication email. If you set a preferred email, all outbound messages from your tax practice — reminders, document alerts, message replies — go there instead of your sign-in email.\n\nWhatsApp uses international format: + then country code then number, with no spaces. The portal will normalize what you type and show a clickable preview link.","es":"Desde la pestaña Perfil puede actualizar su teléfono, número de WhatsApp, dirección postal y un correo preferido de comunicación. Si establece un correo preferido, todos los mensajes salientes de su oficina — recordatorios, alertas de documentos, respuestas a mensajes — irán allí en lugar de a su correo de inicio de sesión.\n\nWhatsApp usa formato internacional: + seguido del código de país y el número, sin espacios. El portal normalizará lo que escriba y mostrará un enlace de vista previa."}'::jsonb),
  ('help.cust.notifications', 'customer', null, 'notifications', 70,
    '{"en":"How email and in-portal notifications work","es":"Cómo funcionan las notificaciones por correo y en el portal"}'::jsonb,
    '{"en":"You receive two kinds of alerts: in-portal notifications (the bell or unread badges you see in the nav) and email notifications.\n\nBy default, both are active. If your tax practice has enabled customer-managed preferences, you can switch between email-only, in-portal-only, or both from your Profile. Otherwise the channels are set by your practice.","es":"Recibe dos tipos de alertas: notificaciones en el portal (la campana o los indicadores de no leído en la navegación) y notificaciones por correo.\n\nDe forma predeterminada, ambas están activas. Si su oficina ha habilitado las preferencias gestionadas por el cliente, puede alternar entre solo correo, solo portal o ambos desde su Perfil. De lo contrario, los canales los establece su oficina."}'::jsonb)
on conflict (id) do nothing;

-- ── Customer service-tailored articles (relationship_type_id set) ───────────
insert into public.tax_help_articles (id, audience, relationship_type_id, category, display_order, title_i18n, body_i18n) values
  ('help.svc.llc', 'customer', 'business.llc', 'service', 100,
    '{"en":"Year-end checklist for LLC owners","es":"Lista de fin de año para propietarios de LLC"}'::jsonb,
    '{"en":"As an LLC owner, gather these items each year before your tax appointment:\n\n• Year-end business bank and credit card statements (all accounts)\n• Profit-and-loss summary from your bookkeeping software\n• 1099-NECs received and 1099-NECs you''ll issue to contractors paid $600+\n• Mileage and home-office logs if you''re deducting either\n• Capital contributions and distributions records\n• Loan statements for business debt\n\nUpload these to the Documents tab in your portal; we''ll let you know if anything else is needed.","es":"Como propietario de una LLC, reúna estos elementos cada año antes de su cita fiscal:\n\n• Estados de cuenta bancarios y de tarjeta de crédito de fin de año (todas las cuentas)\n• Resumen de pérdidas y ganancias de su programa de contabilidad\n• 1099-NEC recibidos y los que emitirá a contratistas que pagó $600 o más\n• Registros de kilometraje y oficina en casa si los está deduciendo\n• Registros de aportaciones y distribuciones de capital\n• Estados de cuenta de préstamos por deudas comerciales\n\nSúbalos a la pestaña Documentos en su portal; le avisaremos si necesitamos algo más."}'::jsonb),
  ('help.svc.scorp', 'customer', 'business.s_corp', 'service', 110,
    '{"en":"S-Corp annual filing: what we need","es":"Declaración anual de S-Corp: lo que necesitamos"}'::jsonb,
    '{"en":"Before we prepare your Form 1120-S, please confirm the following for the year:\n\n• Total wages paid to each shareholder-employee (W-2 totals)\n• Distributions taken by each shareholder (not wages)\n• Health insurance premiums paid by the company for >2% shareholders\n• Retirement plan contributions, if any\n• Year-end balance sheet (assets, liabilities, equity)\n\nIf you haven''t taken reasonable W-2 wages this year before any distributions, mention that in your portal message — we may need to discuss adjustments before filing.","es":"Antes de preparar su Formulario 1120-S, confirme lo siguiente para el año:\n\n• Salarios totales pagados a cada accionista-empleado (totales W-2)\n• Distribuciones tomadas por cada accionista (no salarios)\n• Primas de seguro médico pagadas por la empresa para accionistas con más del 2%\n• Aportaciones a planes de jubilación, si las hay\n• Balance general de fin de año (activos, pasivos, patrimonio)\n\nSi este año no ha tomado salarios W-2 razonables antes de cualquier distribución, menciónelo en un mensaje desde su portal — puede que tengamos que discutir ajustes antes de presentar."}'::jsonb),
  ('help.svc.p1065', 'customer', 'business.partnership_1065', 'service', 120,
    '{"en":"Partnership filing and your K-1","es":"Declaración de sociedad y su K-1"}'::jsonb,
    '{"en":"Form 1065 is due March 15 for calendar-year partnerships. We aim to issue K-1s to every partner at least a week before, so partners can incorporate their share into their personal returns.\n\nIf any partner''s percentage changed mid-year, or if there were buy-ins or buy-outs, please upload the supporting agreements to the Documents tab as early as possible — these can take time to reflect in the books.","es":"El Formulario 1065 vence el 15 de marzo para sociedades de año calendario. Procuramos emitir los K-1 a cada socio al menos una semana antes, para que cada uno pueda incorporar su parte en su declaración personal.\n\nSi el porcentaje de algún socio cambió a mitad de año, o si hubo entradas o salidas de socios, suba los acuerdos correspondientes a la pestaña Documentos lo antes posible — estos pueden tardar en reflejarse en los libros."}'::jsonb),
  ('help.svc.sut', 'customer', 'business.sales_tax_filing', 'service', 130,
    '{"en":"Monthly sales tax filing: what we need from you","es":"Declaración mensual de impuesto sobre las ventas: lo que necesitamos"}'::jsonb,
    '{"en":"Each month before your filing deadline, please provide:\n\n• Total gross sales (taxable + exempt) for the period\n• Breakdown of any exempt sales by reason (resale, services, etc.)\n• Bank deposit totals for the period (we''ll reconcile against gross sales)\n• Copies of any resale or exemption certificates accepted that month\n\nIf your point-of-sale system can export a sales-tax summary, upload it directly. We''ll reach out via portal message if anything looks off before we file.","es":"Cada mes antes de su fecha límite de presentación, proporcione:\n\n• Ventas brutas totales (gravables + exentas) del período\n• Detalle de las ventas exentas por motivo (reventa, servicios, etc.)\n• Totales de depósitos bancarios del período (lo conciliaremos con las ventas brutas)\n• Copias de los certificados de reventa o exención aceptados ese mes\n\nSi su sistema de punto de venta puede exportar un resumen de impuesto sobre ventas, súbalo directamente. Le contactaremos por el portal si algo no coincide antes de presentar."}'::jsonb),
  ('help.svc.busform', 'customer', 'business.business_formation', 'service', 140,
    '{"en":"After you form your business — first steps","es":"Después de formar su negocio — primeros pasos"}'::jsonb,
    '{"en":"Once your formation is filed, plan to take care of the following within the first 30 days:\n\n1. Apply for an EIN if you haven''t already (we can do this for you)\n2. Open a business bank account using your EIN and formation documents\n3. Register for state tax accounts BEFORE your first sale or first hire — backdated registrations carry penalties\n4. Sign your operating agreement / bylaws / partnership agreement\n5. Adopt a fiscal year and a basic accounting policy (cash vs. accrual)\n\nUpload signed copies of your formation docs to the Documents tab so we have them on file.","es":"Una vez presentada su formación, planifique completar lo siguiente dentro de los primeros 30 días:\n\n1. Solicite un EIN si aún no lo tiene (podemos hacerlo por usted)\n2. Abra una cuenta bancaria comercial con su EIN y documentos de formación\n3. Regístrese para las cuentas tributarias estatales ANTES de su primera venta o contratación — los registros retroactivos conllevan multas\n4. Firme su acuerdo operativo / estatutos / acuerdo de sociedad\n5. Adopte un año fiscal y una política contable básica (efectivo vs. devengado)\n\nSuba copias firmadas de sus documentos de formación a la pestaña Documentos para que las tengamos en archivo."}'::jsonb),
  ('help.svc.payroll', 'customer', 'business.payroll', 'service', 150,
    '{"en":"Adding a new employee: information we need","es":"Agregar un empleado nuevo: información que necesitamos"}'::jsonb,
    '{"en":"Before we process the first paycheck for a new hire, please send us:\n\n• Form W-4 signed by the employee (federal withholding)\n• State withholding form for your state\n• Form I-9 with supporting documents reviewed\n• Direct deposit form with voided check (if applicable)\n• Pay rate, frequency (weekly/biweekly/semimonthly), and start date\n\nUpload these to the Documents tab. We''ll set up the employee in your payroll system and confirm before the first run.","es":"Antes de procesar el primer pago de un nuevo empleado, envíenos:\n\n• Formulario W-4 firmado por el empleado (retención federal)\n• Formulario estatal de retención de su estado\n• Formulario I-9 con los documentos de respaldo revisados\n• Formulario de depósito directo con un cheque anulado (si corresponde)\n• Tarifa de pago, frecuencia (semanal/quincenal/bimensual) y fecha de inicio\n\nSúbalos a la pestaña Documentos. Configuraremos al empleado en su sistema de nómina y confirmaremos antes del primer pago."}'::jsonb),
  ('help.svc.book', 'customer', 'business.bookkeeping', 'service', 160,
    '{"en":"Monthly bookkeeping: how we work together","es":"Contabilidad mensual: cómo trabajamos juntos"}'::jsonb,
    '{"en":"Each month around the 5th, we''ll request:\n\n• Bank statements (PDF) for the previous month, all accounts\n• Credit card statements (PDF) for all business cards\n• Receipts or notes for any unusual transactions you''d like categorized correctly\n\nWe''ll reconcile, categorize, and deliver a profit-and-loss + balance sheet by the 15th. Questions about any transaction go in a portal message so we have a paper trail.","es":"Cada mes, alrededor del día 5, solicitaremos:\n\n• Estados de cuenta bancarios (PDF) del mes anterior, de todas las cuentas\n• Estados de cuenta de tarjetas de crédito (PDF) de todas las tarjetas comerciales\n• Recibos o notas de transacciones inusuales que desee categorizar correctamente\n\nConciliamos, categorizamos y entregamos un estado de pérdidas y ganancias + balance general antes del día 15. Las preguntas sobre cualquier transacción van por mensaje en el portal para tener un registro."}'::jsonb),
  ('help.svc.indtax', 'customer', 'individual.taxes', 'service', 170,
    '{"en":"Tax season checklist","es":"Lista de temporada de impuestos"}'::jsonb,
    '{"en":"Gather these for your annual filing:\n\n• Photo ID, plus SSNs or ITINs for everyone on the return\n• W-2s and 1099s (employment, contract, interest, dividends, retirement)\n• Mortgage 1098 + property tax bills if itemizing\n• Tuition 1098-T and student loan 1098-E\n• Records of charitable contributions\n• Medical expenses if itemizing\n• Daycare provider info if claiming the credit\n• Any IRS or state notices received since last year\n\nMost of these can be uploaded throughout the year as they arrive — your future self will thank you.","es":"Reúna lo siguiente para su declaración anual:\n\n• Identificación con foto, además del SSN o ITIN de todas las personas en la declaración\n• W-2 y 1099 (empleo, contrato, intereses, dividendos, jubilación)\n• Hipoteca 1098 + facturas del impuesto a la propiedad si detalla deducciones\n• 1098-T de matrícula y 1098-E de préstamos estudiantiles\n• Registros de donaciones caritativas\n• Gastos médicos si detalla deducciones\n• Información del proveedor de cuidado infantil si reclama el crédito\n• Cualquier notificación del IRS o estatal recibida desde el año pasado\n\nLa mayoría se pueden subir durante el año conforme llegan — su yo futuro se lo agradecerá."}'::jsonb),
  ('help.svc.itin', 'customer', 'individual.itin', 'service', 180,
    '{"en":"Preparing for your ITIN application","es":"Cómo prepararse para su solicitud de ITIN"}'::jsonb,
    '{"en":"For an ITIN application (Form W-7) you''ll need:\n\n• Original passport (or a certified copy from the issuing agency) — preferred\n• Or two other documents from the IRS-approved list (e.g., national ID + foreign driver''s license)\n• Your federal tax return for the year — we prepare and attach this\n• Form W-7 itself — we complete this with you in person or remotely\n\nAs a Certified Acceptance Agent, we can verify your documents in our office so you don''t have to mail your originals to the IRS. Bring originals to your appointment.","es":"Para una solicitud de ITIN (Formulario W-7) necesitará:\n\n• Pasaporte original (o una copia certificada de la agencia emisora) — preferido\n• O dos documentos adicionales de la lista aprobada por el IRS (ej. identificación nacional + licencia de conducir extranjera)\n• Su declaración federal del año — nosotros la preparamos y adjuntamos\n• El propio Formulario W-7 — lo completamos con usted en persona o de forma remota\n\nComo Agente de Aceptación Certificado, podemos verificar sus documentos en nuestra oficina para que no tenga que enviar los originales al IRS. Lleve los originales a su cita."}'::jsonb),
  ('help.svc.notary', 'customer', 'general.notary', 'service', 190,
    '{"en":"What to bring to your notary appointment","es":"Qué traer a su cita con el notario"}'::jsonb,
    '{"en":"For any notarization, please bring:\n\n• Your unsigned document (do not sign in advance — the notary must witness)\n• A current government-issued photo ID (driver''s license, passport, or state ID)\n• Any witnesses required by the document, if applicable\n\nA U.S. notary public is not a lawyer and cannot give legal advice or draft documents. If you have questions about whether a document is appropriate for what you''re trying to accomplish, consult an attorney before your appointment.","es":"Para cualquier notarización, traiga:\n\n• Su documento sin firmar (no firme con anticipación — el notario debe presenciar la firma)\n• Una identificación oficial vigente con foto (licencia de conducir, pasaporte o ID estatal)\n• Cualquier testigo que requiera el documento, si corresponde\n\nUn notario público en EE.UU. no es abogado y no puede dar asesoría legal ni redactar documentos. Si tiene preguntas sobre si un documento es adecuado para lo que intenta lograr, consulte a un abogado antes de su cita."}'::jsonb),
  ('help.svc.translation', 'customer', 'general.translation', 'service', 200,
    '{"en":"Information we need for translation projects","es":"Información que necesitamos para proyectos de traducción"}'::jsonb,
    '{"en":"Before we translate a document, please upload it to the Documents tab and tell us via portal message:\n\n• The target language (we work between English and Spanish)\n• Whether you need a certified translation (required by USCIS, IRS, court filings) or a standard one\n• The deadline and what the translation is for (so we use the right register and terminology)\n\nCertified translations include a signed translator''s declaration attesting to completeness and accuracy. Longer documents may take 3–5 business days.","es":"Antes de traducir un documento, súbalo a la pestaña Documentos y díganos por mensaje:\n\n• El idioma de destino (trabajamos entre inglés y español)\n• Si necesita una traducción certificada (requerida por USCIS, IRS, tribunales) o estándar\n• La fecha límite y el propósito de la traducción (para usar el registro y terminología correctos)\n\nLas traducciones certificadas incluyen una declaración firmada del traductor que certifica integridad y precisión. Los documentos más largos pueden tomar 3–5 días hábiles."}'::jsonb),
  ('help.svc.audit_irs', 'customer', 'audit.irs', 'service', 210,
    '{"en":"What to expect during an IRS audit","es":"Qué esperar durante una auditoría del IRS"}'::jsonb,
    '{"en":"If we''re representing you in an IRS examination, here''s how it typically goes:\n\n1. We respond on your behalf — you do not contact the IRS directly. Forward every IRS letter to us through the Documents tab the day you receive it.\n2. We gather the requested records, organize them, and submit a packaged response by the deadline.\n3. The examiner may request follow-ups; we handle those.\n4. We negotiate any proposed adjustments with you in the loop.\n\nDo not throw away any envelope from the IRS — postmark dates matter for some deadlines.","es":"Si lo representamos en una auditoría del IRS, así suele desarrollarse:\n\n1. Respondemos en su nombre — usted no contacta directamente al IRS. Reenvíenos cada carta del IRS por la pestaña Documentos el mismo día que la reciba.\n2. Reunimos los registros solicitados, los organizamos y entregamos una respuesta integrada antes de la fecha límite.\n3. El examinador puede pedir seguimientos; nosotros los gestionamos.\n4. Negociamos cualquier ajuste propuesto con usted al tanto.\n\nNo deseche ningún sobre del IRS — la fecha del matasellos importa para algunos plazos."}'::jsonb),
  ('help.svc.audit_drs', 'customer', 'audit.drs', 'service', 220,
    '{"en":"What to expect during a Connecticut DRS audit","es":"Qué esperar durante una auditoría del DRS de Connecticut"}'::jsonb,
    '{"en":"Most DRS audits start as desk audits — written requests by mail asking for specific records (commonly sales-tax reconciliations or contractor 1099 backup).\n\nForward every DRS letter to us the same day. We''ll prepare and submit a complete response by the deadline. Full, on-time responses very often prevent escalation to a field audit. Partial responses or missed deadlines almost always make the audit broader.","es":"La mayoría de las auditorías del DRS comienzan como auditorías de escritorio — solicitudes escritas por correo pidiendo registros específicos (comúnmente conciliaciones de impuesto sobre las ventas o respaldo de 1099 a contratistas).\n\nReenvíenos cada carta del DRS el mismo día. Prepararemos y enviaremos una respuesta completa antes de la fecha límite. Las respuestas completas y a tiempo a menudo evitan la escalada a una auditoría de campo. Las respuestas parciales o tardías casi siempre amplían la auditoría."}'::jsonb)
on conflict (id) do nothing;

-- ── Employee help (audience='employee', no relationship_type_id) ────────────
insert into public.tax_help_articles (id, audience, relationship_type_id, category, display_order, title_i18n, body_i18n) values
  ('help.emp.gs.inbox', 'employee', null, 'getting_started', 10,
    '{"en":"Your inbox and the unread badge","es":"Su bandeja y el indicador de no leído"}'::jsonb,
    '{"en":"The Inbox tab shows every conversation thread you can see based on your role. Admins see every customer in the community; staff see only customers assigned to them.\n\nThe red number next to ''Inbox'' in the header counts threads with unread customer messages. Opening a thread clears its unread state automatically. Use the All / Unread filter pills to focus on what needs your attention.","es":"La pestaña Bandeja muestra cada conversación que puede ver según su rol. Los administradores ven a todos los clientes de la oficina; el personal solo ve a los clientes que tiene asignados.\n\nEl número rojo junto a ''Bandeja'' en el encabezado cuenta los hilos con mensajes no leídos del cliente. Abrir un hilo limpia su estado automáticamente. Use los filtros Todos / Sin leer para enfocarse en lo que necesita atención."}'::jsonb),
  ('help.emp.messages', 'employee', null, 'messages', 20,
    '{"en":"Replying to customer threads","es":"Cómo responder a hilos de clientes"}'::jsonb,
    '{"en":"When you reply on a thread, the message is attributed to you specifically (not generic ''practice''). The customer sees your name in their portal and on the email notification they receive.\n\nAt the top of each thread, the customer context strip shows their preferred email, phone, and WhatsApp link so you can verify identity or jump to a side channel if needed.","es":"Cuando responde en un hilo, el mensaje se le atribuye específicamente (no a una ''oficina'' genérica). El cliente ve su nombre en su portal y en el correo de notificación que recibe.\n\nEn la parte superior de cada hilo, la franja de contexto del cliente muestra su correo preferido, teléfono y enlace de WhatsApp para que pueda verificar identidad o saltar a un canal alterno si es necesario."}'::jsonb),
  ('help.emp.profile.notifications', 'employee', null, 'notifications', 30,
    '{"en":"Choosing portal-only vs. portal + email","es":"Elegir solo portal vs. portal + correo"}'::jsonb,
    '{"en":"Open Profile → Notification preferences. By default new staff get portal-only notifications (the in-app inbox + badge). If you want an email too whenever a customer posts on a thread you can see, check the Email box and save.\n\nEmails route to your sign-in email by default, or to your Preferred communication email if you''ve set one. You can change this at any time.","es":"Abra Perfil → Preferencias de notificación. De forma predeterminada el personal nuevo recibe solo notificaciones del portal (la bandeja y el indicador en la app). Si desea también un correo cuando un cliente publique en un hilo que puede ver, marque la casilla Correo y guarde.\n\nLos correos van a su correo de inicio de sesión por defecto, o al correo preferido de comunicación si lo ha configurado. Puede cambiarlo en cualquier momento."}'::jsonb),
  ('help.emp.profile.contact', 'employee', null, 'profile', 40,
    '{"en":"Adding WhatsApp and a preferred email","es":"Agregar WhatsApp y un correo preferido"}'::jsonb,
    '{"en":"From your Profile you can add a WhatsApp number (international format, +country-code-then-number) and a preferred communication email that overrides your sign-in email for outbound notifications.\n\nThe WhatsApp number you save here shows on customer-context strips so your colleagues know how to reach you. It is not exposed to customers in v1.","es":"Desde su Perfil puede agregar un número de WhatsApp (formato internacional, +código de país y número) y un correo preferido de comunicación que reemplaza su correo de inicio de sesión para notificaciones salientes.\n\nEl número de WhatsApp que guarde aquí aparece en las franjas de contexto del cliente para que sus colegas sepan cómo contactarle. No se expone a los clientes en v1."}'::jsonb),
  ('help.emp.assignments', 'employee', null, 'getting_started', 50,
    '{"en":"How customer assignments work","es":"Cómo funcionan las asignaciones de clientes"}'::jsonb,
    '{"en":"If your role is ''staff'', your inbox is filtered to customers your administrator has assigned to you. Your profile shows ''Your assigned customers'' as a read-only roster.\n\nIf your role is ''admin'', you see every customer in the community automatically — no assignments needed. When an admin replies to a thread, the system still attributes the message to the admin''s name and email.","es":"Si su rol es ''personal'', su bandeja se filtra a los clientes que su administrador le asignó. Su perfil muestra ''Sus clientes asignados'' como una lista de solo lectura.\n\nSi su rol es ''administrador'', ve a todos los clientes de la oficina automáticamente — no necesita asignaciones. Cuando un administrador responde en un hilo, el sistema atribuye el mensaje a su nombre y correo."}'::jsonb),
  ('help.emp.admin', 'employee', null, 'admin', 60,
    '{"en":"Admin tools: customers, leads, staff, settings","es":"Herramientas de administrador: clientes, prospectos, personal, configuración"}'::jsonb,
    '{"en":"Admin-role staff have four extra nav tabs beyond Inbox/Profile:\n\n• Customers — add new customers, manage relationships and documents per customer\n• Leads — incoming requests from your landing page, with status tracking and convert-to-customer\n• Staff — add new staff members and manage per-staff customer assignments\n• Settings — community-wide options like whether customers can change their notification channels\n\nIf you don''t see these tabs, your role is ''staff''. Ask another admin to change it via Staff → your row if needed.","es":"El personal con rol de administrador tiene cuatro pestañas extra además de Bandeja/Perfil:\n\n• Clientes — agregue clientes nuevos, gestione relaciones y documentos por cliente\n• Prospectos — solicitudes entrantes desde su página de aterrizaje, con seguimiento de estado y conversión a cliente\n• Personal — agregue miembros del equipo y gestione asignaciones de clientes por persona\n• Configuración — opciones para toda la oficina como si los clientes pueden cambiar sus canales de notificación\n\nSi no ve estas pestañas, su rol es ''personal''. Pida a otro administrador que lo cambie en Personal → su fila si es necesario."}'::jsonb),
  ('help.emp.impersonate', 'employee', null, 'admin', 70,
    '{"en":"Impersonating customers and staff (troubleshooting)","es":"Suplantar clientes y personal (resolución de problemas)"}'::jsonb,
    '{"en":"From a customer or staff detail page, click ''Impersonate'' to view the portal exactly as that user sees it. A red banner pinned at the top of every page makes it impossible to forget you''re impersonating.\n\nUse this to reproduce a bug a customer is reporting, verify a layout change before announcing it, or check what a staff member''s assignment scope looks like. Sessions last one hour and are tab-scoped — closing the tab ends impersonation. Every action you take during impersonation is audit-logged with both your real identity and the impersonated user.","es":"Desde la página de detalle de un cliente o miembro del personal, haga clic en ''Suplantar'' para ver el portal exactamente como ese usuario lo ve. Un banner rojo fijado en la parte superior de cada página hace imposible olvidar que está suplantando.\n\nUse esto para reproducir un error que un cliente reporta, verificar un cambio de diseño antes de anunciarlo, o comprobar cómo se ve el alcance de asignaciones de un miembro del personal. Las sesiones duran una hora y son específicas de la pestaña — cerrar la pestaña termina la suplantación. Cada acción que realice durante la suplantación se registra en auditoría con su identidad real y el usuario suplantado."}'::jsonb),

  -- ── Owner / admin operational help (display_order 80+) ─────────────────────
  -- These are bilingual, admin-only articles covering the daily ops surface
  -- the owner uses but staff doesn't (Customers/Staff/Settings/Articles/
  -- FAQs/Audit/Leads tabs). The /employee/help endpoint filters
  -- category='admin' articles out for role='staff' viewers so junior staff
  -- aren't presented with docs for features they can't reach.

  ('help.admin.customers', 'employee', null, 'admin', 80,
    '{"en":"Customers — add, edit, and bulk-import","es":"Clientes — agregar, editar e importar en bloque"}'::jsonb,
    '{"en":"The Customers tab is where every customer in the practice lives. Three ways to add them:\n\n• Add a customer (one at a time) — click ''Add a customer'' for a quick form. Email is the only required field.\n• Import from CSV (bulk) — for moving an existing roster from a spreadsheet. Click ''Import from CSV'' for a downloadable template + paste/upload area. The template URL also works without sign-in (handy to email to an owner who is just being onboarded).\n• Lead conversion — when a lead from the landing page is ready, open the Leads tab, mark them ''converted'', and add them as a customer.\n\nImport modes: Skip existing (default — duplicate emails are left alone, safe to re-upload) or Update existing (field-level merge — blank cells preserve current values; non-blank cells overwrite; relationships are additively merged, never removed).\n\nEditing one customer: open their detail page from the Customers list, click ''Edit profile''. The customer can edit most of these same fields themselves from their portal profile.","es":"La pestaña Clientes es donde vive cada cliente de la oficina. Tres formas de agregarlos:\n\n• Agregar un cliente (uno por uno) — haga clic en ''Agregar un cliente'' para un formulario rápido. El correo es el único campo obligatorio.\n• Importar desde CSV (en bloque) — para mover una lista existente desde una hoja de cálculo. Haga clic en ''Importar desde CSV'' para una plantilla descargable y un área para pegar/subir. La URL de la plantilla también funciona sin iniciar sesión (útil para enviarla por correo a un dueño que recién se está incorporando).\n• Conversión de prospectos — cuando un prospecto de la página de aterrizaje está listo, abra la pestaña Prospectos, márquelo como ''convertido'' y agréguelo como cliente.\n\nModos de importación: Omitir existentes (predeterminado — los correos duplicados se dejan tal cual, seguro reejecutar) o Actualizar existentes (fusión por campo — las celdas en blanco conservan los valores actuales; las no vacías reemplazan; las relaciones se fusionan aditivamente, nunca se eliminan).\n\nEditar un cliente: abra su página de detalle desde la lista de Clientes y haga clic en ''Editar perfil''. El cliente puede editar la mayoría de estos mismos campos desde el perfil de su portal."}'::jsonb),

  ('help.admin.relationships', 'employee', null, 'admin', 90,
    '{"en":"Service relationships — tagging customers by service","es":"Relaciones de servicio — etiquetar clientes por servicio"}'::jsonb,
    '{"en":"A ''relationship'' tags what services you provide a customer. Tagging matters because three customer-facing surfaces filter by it:\n\n• The FAQ tab on each customer''s portal only shows FAQs for their tagged services\n• Reminder emails include 2–3 ''Helpful reminders'' tailored to the customer''s services\n• The Help center surfaces service-specific articles\n\nThirteen relationships are seeded: Business (LLC, S-Corp, Partnership/1065, Sales Tax Filing, Business Formation, Payroll, Bookkeeping), Individual (Taxes, ITIN), General (Notary, Translation), and Audit (IRS, DRS).\n\nTo add or remove a relationship: open the customer''s detail page, scroll to ''Service relationships'', click ''Add a service'' or the × on an existing chip. To bulk-tag many customers at once, use the CSV import — the relationships column accepts a comma-separated list of the relationship-type ids.","es":"Una ''relación'' etiqueta los servicios que usted brinda a un cliente. Etiquetar importa porque tres áreas del cliente filtran por esto:\n\n• La pestaña Preguntas frecuentes en el portal solo muestra preguntas para sus servicios etiquetados\n• Los correos de recordatorio incluyen 2–3 ''Recordatorios útiles'' adaptados a los servicios del cliente\n• El Centro de ayuda muestra artículos específicos del servicio\n\nSe semillan trece relaciones: Negocio (LLC, S-Corp, Sociedad/1065, Impuesto sobre Ventas, Formación de Empresas, Nómina, Contabilidad), Personal (Impuestos, ITIN), General (Notario, Traducción) y Auditoría (IRS, DRS).\n\nPara agregar o quitar una relación: abra la página de detalle del cliente, vaya a ''Relaciones de servicio'', haga clic en ''Agregar servicio'' o en la × de una etiqueta existente. Para etiquetar a muchos clientes a la vez, use la importación CSV — la columna ''relationships'' acepta una lista separada por comas de los ids de tipo de relación."}'::jsonb),

  ('help.admin.subscriptions', 'employee', null, 'admin', 100,
    '{"en":"Subscriptions, reminders, and filing periods","es":"Suscripciones, recordatorios y períodos de declaración"}'::jsonb,
    '{"en":"A subscription connects a customer to a tax service (sales tax, payroll, individual 1040, etc.) and drives the reminder cadence.\n\nWhen you add a subscription to a customer (from their detail page), the reminder cron starts generating ''filing periods'' for the next 12 months on the schedule(s) you''ve activated. Each filing period fires reminders to the customer at the configured offsets — default is 14, 7, and 3 days before the due date, on both email and the in-portal inbox.\n\nYou can change defaults per subscription from the Edit panel: status (Active / Paused / Cancelled), active schedules (e.g., only monthly sales tax, skip quarterly), reminder days, channels, and the info-request checklist that the customer fills in when they respond.\n\nFiling periods auto-advance through statuses (pending → info_requested → info_received) as reminders fire and customers respond. The Filings section on the customer detail page lets you manually flip a status — for example, mark a period ''skipped'' if the business was closed that month, or ''filed'' after you''ve submitted through an agency portal outside the platform.","es":"Una suscripción conecta a un cliente con un servicio de impuestos (impuesto sobre ventas, nómina, 1040 personal, etc.) y dirige la cadencia de recordatorios.\n\nCuando agrega una suscripción a un cliente (desde su página de detalle), el cron de recordatorios comienza a generar ''períodos de declaración'' para los próximos 12 meses en los calendarios que activó. Cada período dispara recordatorios al cliente en los desplazamientos configurados — el valor predeterminado es 14, 7 y 3 días antes del vencimiento, por correo y la bandeja del portal.\n\nPuede cambiar los valores predeterminados por suscripción desde el panel de Edición: estado (Activa / Pausada / Cancelada), calendarios activos (ej. solo impuesto mensual, omitir trimestral), días de recordatorio, canales y la lista de información que el cliente completa al responder.\n\nLos períodos avanzan automáticamente a través de estados (pendiente → información solicitada → información recibida) mientras los recordatorios se disparan y los clientes responden. La sección Declaraciones en el detalle del cliente permite cambiar manualmente un estado — por ejemplo, marcar un período como ''omitido'' si el negocio cerró ese mes, o ''presentado'' después de que envió por el portal de la agencia fuera de la plataforma."}'::jsonb),

  ('help.admin.staff', 'employee', null, 'admin', 110,
    '{"en":"Staff — adding team members and assigning customers","es":"Personal — agregar miembros del equipo y asignar clientes"}'::jsonb,
    '{"en":"From the Staff tab, click ''Add a staff member''. Required: name + email. Choose a role:\n\n• Staff — sees only customers assigned to them. No admin tabs in their nav. Replies on threads attribute to them by name.\n• Admin — sees every customer in the practice automatically. All admin tabs visible. Acts like an owner.\n\nAfter creation, share the staff portal URL — /tax/{your-slug}/employee — and the email you used. They sign in with Google or email/password, and the first sign-in links their Firebase identity to the seeded row. Until they sign in, their row shows ''has not signed in yet''.\n\nAssigning customers to a Staff-role employee: open their detail page, ''Assign a customer'' picks from the customer list. Toggle ''Mark as lead'' to flag them as the primary contact (informational only — doesn''t affect access). Customers can be assigned to multiple staff members; you can unassign anytime.\n\nWhen a customer messages the practice, both the practice contact email and each assigned staff member receive the notification — admins always receive it regardless of assignment.","es":"Desde la pestaña Personal, haga clic en ''Agregar miembro del personal''. Requeridos: nombre + correo. Elija un rol:\n\n• Personal — ve solo los clientes que tiene asignados. Sin pestañas de administrador en su navegación. Las respuestas en los hilos se atribuyen a esa persona por nombre.\n• Administrador — ve a todos los clientes de la oficina automáticamente. Todas las pestañas de administrador visibles. Actúa como dueño.\n\nDespués de crearlo, comparta la URL del portal del personal — /tax/{su-slug}/employee — y el correo que usó. Inician sesión con Google o correo y contraseña, y el primer inicio enlaza su identidad de Firebase con la fila precargada. Hasta que inicien sesión, su fila muestra ''aún no ha iniciado sesión''.\n\nAsignar clientes a un empleado de rol Personal: abra su página de detalle, ''Asignar un cliente'' elige de la lista de clientes. Active ''Marcar como principal'' para señalarlo como contacto principal (solo informativo — no afecta el acceso). Los clientes pueden asignarse a varios miembros; puede quitar asignaciones en cualquier momento.\n\nCuando un cliente envía un mensaje a la oficina, tanto el correo de contacto de la oficina como cada empleado asignado reciben la notificación — los administradores siempre la reciben sin importar la asignación."}'::jsonb),

  ('help.admin.content', 'employee', null, 'admin', 120,
    '{"en":"Customizing FAQs, Articles, and reminder tips","es":"Personalizar Preguntas frecuentes, Artículos y consejos"}'::jsonb,
    '{"en":"The platform ships with platform-curated content (FAQs per relationship type, help articles for customer + staff use, reminder tips). Three tabs let you override that content per community without affecting other practices on the same platform:\n\n• Articles — customer-facing help articles + staff help articles. Override the text of a default, hide a default that doesn''t apply, or write a brand-new article tagged to a service relationship.\n• FAQs — same override/hide/custom pattern, scoped to the customer-facing FAQ tab per relationship type.\n\nAll content is bilingual. Both English and Spanish go in the same editor side-by-side; at least one language must be filled.\n\n''Reset to default'' on an override-row deletes your override and reveals the platform default again. Hidden defaults can be ''Show again'' anytime. Custom articles you authored show ''Delete'' instead — there''s no underlying default to fall back to.\n\nReminder tips (the 2–3 short sentences appended to reminder emails based on the customer''s relationships) are platform-curated for v1. If you need per-practice overrides for tip wording, request it — the schema mirrors the FAQ override pattern and adding it is small.","es":"La plataforma viene con contenido seleccionado por la plataforma (preguntas frecuentes por tipo de relación, artículos de ayuda para clientes y personal, consejos de recordatorio). Tres pestañas le permiten reemplazar ese contenido por oficina sin afectar a otras oficinas en la misma plataforma:\n\n• Artículos — artículos de ayuda para clientes y para personal. Reemplace el texto de un valor predeterminado, oculte uno que no aplique, o escriba un artículo nuevo etiquetado a una relación de servicio.\n• Preguntas frecuentes — el mismo patrón de reemplazar/ocultar/personalizado, limitado a la pestaña de Preguntas frecuentes del cliente por tipo de relación.\n\nTodo el contenido es bilingüe. Inglés y español van en el mismo editor lado a lado; al menos un idioma debe estar lleno.\n\n''Restaurar predeterminado'' en una fila reemplazada elimina su reemplazo y vuelve a mostrar el valor predeterminado. Los valores ocultos pueden ''Mostrar de nuevo'' en cualquier momento. Los artículos personalizados muestran ''Eliminar'' en su lugar — no hay valor predeterminado al cual volver.\n\nLos consejos de recordatorio (las 2–3 oraciones cortas que se agregan a los correos de recordatorio según las relaciones del cliente) están seleccionados por la plataforma en v1. Si necesita reemplazos por oficina para el texto de los consejos, solicítelo — el esquema refleja el patrón de reemplazo de Preguntas frecuentes y agregarlo es pequeño."}'::jsonb),

  ('help.admin.settings', 'employee', null, 'admin', 130,
    '{"en":"Community settings — notification lock + profile","es":"Configuración — bloqueo de notificaciones y perfil"}'::jsonb,
    '{"en":"The Settings tab is small in v1 but the notification-preference lock is consequential.\n\nCustomers receive reminders and document alerts on both email and the in-portal inbox by default. The lock controls whether each customer can change that for themselves from their portal profile:\n\n• Locked (recommended) — customers cannot change their channels. Both channels stay active. You retain control over how your customers are reached.\n• Customer-managed — customers can switch between email-only, in-portal-only, or both from their profile.\n\nFlipping the lock takes effect immediately. Existing customer-set preferences are preserved when going from customer-managed back to locked, so you can experiment with opening it up without losing customer choices on revert.\n\nCommunity profile (name, contact email, phone, default language) is shown read-only for now. To edit, ask the platform admin or update directly via the database. A community-edit form lives on the Phase 5b backlog.","es":"La pestaña Configuración es pequeña en v1 pero el bloqueo de preferencias de notificación es importante.\n\nLos clientes reciben recordatorios y alertas de documentos por correo y en la bandeja del portal de forma predeterminada. El bloqueo controla si cada cliente puede cambiar eso desde el perfil de su portal:\n\n• Bloqueado (recomendado) — los clientes no pueden cambiar sus canales. Ambos canales permanecen activos. Usted mantiene el control sobre cómo se contacta a sus clientes.\n• Gestionado por el cliente — los clientes pueden alternar entre solo correo, solo portal o ambos desde su perfil.\n\nCambiar el bloqueo entra en vigor de inmediato. Las preferencias existentes del cliente se conservan al volver de ''gestionado por el cliente'' a ''bloqueado'', así que puede experimentar abriéndolo sin perder las elecciones del cliente al revertir.\n\nEl perfil de la oficina (nombre, correo de contacto, teléfono, idioma predeterminado) se muestra solo lectura por ahora. Para editarlo, pida al administrador de la plataforma o actualice directamente en la base de datos. Un formulario de edición está en la lista de pendientes de la fase 5b."}'::jsonb),

  ('help.admin.leads', 'employee', null, 'admin', 140,
    '{"en":"Leads inbox — converting prospects into customers","es":"Bandeja de prospectos — convertir prospectos en clientes"}'::jsonb,
    '{"en":"The Leads tab lists every submission from your practice''s public landing page (/tax/{your-slug}). Each lead carries the name, email, phone, requested service, and message the prospect wrote.\n\nLead lifecycle:\n\n• New — just arrived. You haven''t responded yet. Default filter on the inbox.\n• Contacted — you''ve reached out (email, phone, WhatsApp). Stamps contacted_at automatically the first time you mark this.\n• Converted — they''ve been added as a customer. Use the ''Convert to customer →'' link on the lead to jump to the customer creation form, then mark this status afterward to close the loop.\n• Closed — won''t-be-customer (too far away, not a fit, ghosted). Stays in the All filter but out of the Open default.\n\nInternal notes on each lead are owner/staff-only — never visible to the prospect. Use them to capture context that helps the next person follow up.\n\nLead notifications go to the community contact email when a submission arrives. Configure that email in Settings (or via the platform admin during community provisioning).","es":"La pestaña Prospectos lista cada envío desde la página de aterrizaje pública de la oficina (/tax/{su-slug}). Cada prospecto incluye el nombre, correo, teléfono, servicio solicitado y el mensaje que escribió.\n\nCiclo de vida de un prospecto:\n\n• Nuevo — recién llegó. Aún no ha respondido. Filtro predeterminado en la bandeja.\n• Contactado — ya lo contactó (correo, teléfono, WhatsApp). Marca contacted_at automáticamente la primera vez que cambia a este estado.\n• Convertido — fue agregado como cliente. Use el enlace ''Convertir en cliente →'' del prospecto para saltar al formulario de creación de cliente, luego marque este estado para cerrar el ciclo.\n• Cerrado — no será cliente (demasiado lejos, no es buen ajuste, sin respuesta). Permanece en el filtro Todos pero fuera del filtro Abiertos predeterminado.\n\nLas notas internas en cada prospecto son solo para el dueño y el personal — nunca visibles para el prospecto. Úselas para capturar contexto que ayude al siguiente seguimiento.\n\nLas notificaciones de prospectos van al correo de contacto de la oficina cuando llega un envío. Configure ese correo en Configuración (o vía el administrador de la plataforma durante la creación de la oficina)."}'::jsonb),

  ('help.admin.audit', 'employee', null, 'admin', 150,
    '{"en":"Audit log — investigating disputes and changes","es":"Registro de auditoría — investigar disputas y cambios"}'::jsonb,
    '{"en":"Every state-changing action in the tax module writes a row to the audit log. The Audit tab is a filterable view of those rows.\n\nWhat gets logged: lead arrivals, customer creates / profile updates / CSV imports, document uploads + deletes, message thread creates, relationship add/remove, employee creates + Firebase linkage, assignment changes, and impersonation start/end.\n\nFilters: entity (e.g., tax.customer, tax.impersonation), action (text ILIKE), actor email (text ILIKE), date range. Defaults to the latest 50.\n\nEach row in the table shows when, who, what entity, what action. Click ''Show'' in the Details column to expand a side-by-side before/after JSON of what changed. The actor column shows the real human even during impersonation — so an admin impersonating a customer who deletes their own document shows the admin''s email as actor with the customer as entity.\n\nUse cases: a customer disputes whether they uploaded a file last month → search by their email + date range. A document went missing → filter entity=tax.document action=delete. Reconstructing what happened in an impersonation session → filter entity=tax.impersonation by the admin''s email to find the start/end stamps, then expand to see the targetEmail in the after_data.","es":"Cada acción que cambia estado en el módulo fiscal escribe una fila en el registro de auditoría. La pestaña Auditoría es una vista filtrable de esas filas.\n\nLo que se registra: llegadas de prospectos, creaciones/actualizaciones/importaciones de clientes, cargas y eliminaciones de documentos, creación de hilos de mensajes, alta/baja de relaciones, creación de empleados + enlace Firebase, cambios de asignación, e inicio/fin de suplantación.\n\nFiltros: entidad (ej. tax.customer, tax.impersonation), acción (texto ILIKE), correo del actor (texto ILIKE), rango de fechas. Predeterminado: las 50 últimas.\n\nCada fila en la tabla muestra cuándo, quién, qué entidad, qué acción. Haga clic en ''Ver'' en la columna Detalles para expandir un JSON antes/después lado a lado de lo que cambió. La columna actor muestra al humano real incluso durante la suplantación — entonces si un administrador suplanta a un cliente y elimina su propio documento, aparece el correo del administrador como actor con el cliente como entidad.\n\nCasos de uso: un cliente disputa si subió un archivo el mes pasado → busque por su correo + rango de fechas. Un documento desapareció → filtre entidad=tax.document acción=delete. Reconstruir lo que ocurrió en una sesión de suplantación → filtre entidad=tax.impersonation por el correo del administrador para encontrar los sellos de inicio/fin, luego expanda para ver el targetEmail en after_data."}'::jsonb)
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-imp: Admin impersonation
--
-- DB-backed impersonation sessions. An admin employee (role='admin') creates
-- a session targeting either a customer or another employee in the same
-- community. The frontend stores the returned token in sessionStorage
-- (tab-scoped) and sends it as x-impersonation-token on every request; the
-- auth middlewares treat the target as the authenticated identity while
-- logging every action with both the real admin and the target.
--
-- TTL: 1 hour. Sessions can be ended explicitly via DELETE; expired or ended
-- sessions are rejected by the middleware (revocable in real time).
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_impersonation_sessions (
  id                   text primary key,             -- the opaque session token
  community_id         text not null references public.communities(id) on delete cascade,
  admin_employee_id    text not null references public.tax_employees(id) on delete cascade,
  admin_email          text not null,                -- snapshot for audit
  target_type          text not null,                -- 'customer' | 'employee'
  target_id            text not null,                -- FK enforced at app level
  target_email         text not null,                -- snapshot to attribute
  target_name          text not null default '',
  expires_at           timestamptz not null,
  ended_at             timestamptz,
  created_at           timestamptz not null default now()
);
do $$ begin
  alter table public.tax_impersonation_sessions add constraint tax_impersonation_target_chk
    check (target_type in ('customer','employee'));
exception when duplicate_object then null; end $$;
create index if not exists tax_impersonation_active_idx
  on public.tax_impersonation_sessions(community_id, expires_at) where ended_at is null;
create index if not exists tax_impersonation_admin_idx
  on public.tax_impersonation_sessions(admin_employee_id, created_at desc);

-- Seed: taxamericaservices@gmail.com as a second admin employee (the
-- practice owner mailbox). The owner of the practice is also fundamentally
-- an employee — they wear both hats — so we seed them as both an employee
-- (role='admin') and a customer (so they can self-test the customer
-- experience end-to-end from their own login).
--
-- Migration note: an earlier seed used the misspelling 'taxamericaserives'
-- (missing 'c'). The do-block below renames any row with that earlier
-- email to the correct one, idempotent and safe to re-run.
do $$ begin
  update public.tax_employees
    set email = 'taxamericaservices@gmail.com', name = 'Tax America Services (owner)', updated_at = now()
    where community_id = 'tax-america-services'
    and email = 'taxamericaserives@gmail.com'
    and not exists (
      select 1 from public.tax_employees e2
      where e2.community_id = 'tax-america-services'
      and e2.email = 'taxamericaservices@gmail.com'
    );
end $$;

insert into public.tax_employees (id, community_id, email, name, locale, role)
values ('emp_taxamericaservices', 'tax-america-services', 'taxamericaservices@gmail.com', 'Tax America Services (owner)', 'en', 'admin')
on conflict (community_id, email) do nothing;

-- The owner also exists as a customer row so they can sign into /portal
-- and verify the customer experience. No subscription seeded; relationships
-- left empty by default — the owner can self-assign relationships once
-- signed in via the admin UI.
insert into public.tax_customers (id, community_id, email, name, locale)
values ('cust_taxamericaservices', 'tax-america-services', 'taxamericaservices@gmail.com', 'Tax America Services (test customer)', 'en')
on conflict (community_id, email) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- v85-4e: Owner-managed help articles
--
-- Mirrors the FAQ override pattern from Phase 2b. Platform defaults live
-- in tax_help_articles (untouched); per-community overrides + custom
-- articles live in this new table.
--
-- Three flavors of community row:
--   override (replace default text)  → default_help_article_id set, visible=true,  title/body filled
--   hide (suppress the default)      → default_help_article_id set, visible=false
--   custom (community-authored)       → default_help_article_id NULL,   title/body filled,
--                                       audience/category/relationship_type_id set explicitly
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_community_help_articles (
  id                       text primary key,
  community_id             text not null references public.communities(id) on delete cascade,
  default_help_article_id  text references public.tax_help_articles(id) on delete cascade,
  audience                 text not null,
  relationship_type_id     text references public.tax_relationship_types(id) on delete set null,
  category                 text not null default 'general',
  display_order            int not null default 0,
  title_i18n               jsonb not null default '{}'::jsonb,
  body_i18n                jsonb not null default '{}'::jsonb,
  visible                  boolean not null default true,
  source_note              text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- One override per (community, default). NULL default_help_article_id
  -- bypasses this constraint, so customs can be unlimited.
  unique (community_id, default_help_article_id)
);
do $$ begin
  alter table public.tax_community_help_articles add constraint tax_community_help_articles_audience_chk
    check (audience in ('customer','employee'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_community_help_articles add constraint tax_community_help_articles_category_chk
    check (category in (
      'getting_started','documents','messages','filings','profile','notifications','service','admin','general'
    ));
exception when duplicate_object then null; end $$;
create index if not exists tax_community_help_articles_audience_idx
  on public.tax_community_help_articles(community_id, audience, display_order);

-- ─── Tax email template overrides (Phase 4i) ──────────────────────────────────
-- Owners can override the subject + body of each transactional email the tax
-- module sends. When no row exists (or enabled=false), the sender falls back
-- to the bilingual hardcoded defaults in server/modules/tax/email-senders.js.
--
-- An override row replaces the ENTIRE subject / body — bullets, CTAs, and
-- footers included. Placeholders use {{var}} syntax; available variables
-- depend on the template (see senders for the rendering context). Empty
-- subject / body_text / body_html fields keep the default for that part
-- (so owners can override just the subject while keeping the body).
create table if not exists public.tax_email_templates (
  id                  text primary key,
  community_id        text not null references public.communities(id) on delete cascade,
  template_key        text not null,
  lang                text not null,
  subject             text not null default '',
  body_text           text not null default '',  -- plain-text body (full)
  body_html           text not null default '',  -- HTML body (full)
  enabled             boolean not null default true,
  updated_at          timestamptz not null default now(),
  unique (community_id, template_key, lang)
);
do $$ begin
  alter table public.tax_email_templates add constraint tax_email_templates_lang_chk
    check (lang in ('en','es'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.tax_email_templates add constraint tax_email_templates_key_chk
    check (template_key in (
      'welcome_customer','welcome_staff','reminder','document',
      'message_to_customer','message_to_practice','message_to_employee','lead'
    ));
exception when duplicate_object then null; end $$;
create index if not exists tax_email_templates_lookup_idx
  on public.tax_email_templates(community_id, template_key, lang);

-- ─── Per-relationship workflow rules (Phase 4j) ───────────────────────────────
-- For (relationship_type, filing_schedule) pair, owner can configure:
--   • reminder_offsets_days — int[] in DAYS BEFORE due-date (positive ints,
--     e.g. [14, 7, 2]); stored as positive ints, the reminder cron negates
--     them at use time. Empty array / null → falls through to subscription
--     override → system default [14, 7, 3].
--   • required_documents — jsonb array of {key, label_i18n, type, required}
--     matching the schedule.info_checklist shape; appended ON TOP of the
--     schedule defaults so the relationship adds extra required docs
--     without removing the base list. Empty array / null → just use schedule
--     default + any subscription-level custom_info_checklist.
--
-- Effective resolution (cron applies in this order, first hit wins):
--   1. tax_subscriptions.reminder_offsets_days / custom_info_checklist
--   2. tax_relationship_workflow_rules (joined via customer's active rels)
--   3. tax_filing_schedules.info_checklist + system default offsets
create table if not exists public.tax_relationship_workflow_rules (
  id                    text primary key,
  community_id          text not null references public.communities(id) on delete cascade,
  relationship_type_id  text not null references public.tax_relationship_types(id) on delete cascade,
  filing_schedule_slug  text not null,
  reminder_offsets_days int[],
  required_documents    jsonb,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (community_id, relationship_type_id, filing_schedule_slug)
);
create index if not exists tax_relationship_workflow_rules_lookup_idx
  on public.tax_relationship_workflow_rules(community_id, relationship_type_id, filing_schedule_slug, active);
create index if not exists tax_relationship_workflow_rules_schedule_idx
  on public.tax_relationship_workflow_rules(community_id, filing_schedule_slug, active);

-- Phase 4n.5 / 4n.6: promote a rule into a self-contained workflow row.
-- After Phase 2 of the migration these columns will be the source of truth
-- for period generation (cron walks rules instead of schedules). For now
-- they're populated when new workflows are created via POST
-- /admin/filing-schedules so we don't have to join through schedules.
alter table public.tax_relationship_workflow_rules
  add column if not exists name_i18n        jsonb not null default '{}'::jsonb,
  add column if not exists description_i18n jsonb not null default '{}'::jsonb,
  add column if not exists cadence          text,
  add column if not exists anchor_rule      jsonb,
  add column if not exists info_checklist   jsonb not null default '[]'::jsonb;

-- One-shot backfill from the linked schedule. Idempotent — only fills NULL
-- or empty values, so re-running won't clobber owner-edited workflow text.
-- Safe to skip when there's no test data; included here so re-runs on a
-- fresh tenant land in a consistent state.
update public.tax_relationship_workflow_rules r
   set name_i18n        = case when r.name_i18n = '{}'::jsonb then coalesce(s.name_i18n, '{}'::jsonb) else r.name_i18n end,
       description_i18n = case when r.description_i18n = '{}'::jsonb then coalesce(s.description_i18n, '{}'::jsonb) else r.description_i18n end,
       cadence          = coalesce(r.cadence, s.cadence),
       anchor_rule      = coalesce(r.anchor_rule, s.anchor_rule),
       info_checklist   = case when r.info_checklist = '[]'::jsonb then coalesce(s.info_checklist, '[]'::jsonb) else r.info_checklist end
  from public.tax_filing_schedules s
 where r.community_id = s.community_id
   and r.filing_schedule_slug = s.slug;

-- Phase 4n.8: per-(customer, workflow) overrides. Highest priority in the
-- reminder + checklist resolution chain. Used for one-off adjustments —
-- "Maria's company also needs to send their new vendor contract this year"
-- — without forking the workflow rule for everyone else in that
-- relationship.
create table if not exists public.tax_customer_workflow_overrides (
  id text primary key,
  community_id text not null references public.communities(id) on delete cascade,
  customer_id  text not null references public.tax_customers(id) on delete cascade,
  workflow_rule_id text not null references public.tax_relationship_workflow_rules(id) on delete cascade,
  custom_info_checklist  jsonb,
  reminder_offsets_days  int[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, workflow_rule_id)
);
create index if not exists idx_tax_cust_wf_overrides_lookup
  on public.tax_customer_workflow_overrides(customer_id, workflow_rule_id, active);
alter table public.tax_customer_workflow_overrides disable row level security;

-- Also denormalize workflow_rule_id onto email_delivery_logs so the
-- engagement panel (Phase 4b) can aggregate without a 2-table join.
alter table public.email_delivery_logs
  add column if not exists workflow_rule_id text;
create index if not exists idx_email_delivery_logs_workflow_rule
  on public.email_delivery_logs(workflow_rule_id, event_type, created_at desc)
  where workflow_rule_id is not null;

-- ─── Per-community relationship types (Phase 4k) ──────────────────────────────
-- Existing rows in tax_relationship_types (the 13 seeded "platform default"
-- services) have community_id = NULL and are visible to every community.
-- Owner-added types carry their community's id and are only visible to that
-- community. Listing queries use: WHERE community_id IS NULL OR community_id = $1.
alter table public.tax_relationship_types
  add column if not exists community_id text references public.communities(id) on delete cascade;
create index if not exists tax_relationship_types_community_idx
  on public.tax_relationship_types(community_id, active, display_order);

-- ─── Structured person names (first / optional middle / last) ─────────────────
-- All person tables (customers, employees, leads) gain three columns. The
-- legacy `name` column remains as the canonical display value and is
-- recomposed by the server whenever parts change. A one-time backfill runs
-- at server boot for rows where parts are blank and `name` is not.
alter table public.tax_customers
  add column if not exists first_name  text not null default '',
  add column if not exists middle_name text not null default '',
  add column if not exists last_name   text not null default '';

alter table public.tax_employees
  add column if not exists first_name  text not null default '',
  add column if not exists middle_name text not null default '',
  add column if not exists last_name   text not null default '';

alter table public.tax_leads
  add column if not exists first_name  text not null default '',
  add column if not exists middle_name text not null default '',
  add column if not exists last_name   text not null default '',
  add column if not exists converted_customer_id text references public.tax_customers(id) on delete set null;
create index if not exists idx_tax_leads_converted_customer
  on public.tax_leads(converted_customer_id) where converted_customer_id is not null;

-- ─── Long-form service descriptions ───────────────────────────────────────────
-- Surfaced in the service-detail modal when present. `description_i18n`
-- stays as the short one-liner; this is the optional richer copy.
alter table public.tax_products
  add column if not exists long_description_i18n jsonb not null default '{}'::jsonb;

-- ─── Customer document upload — disabled by default ────────────────────────────
-- Per-community switch. When false (the new default), the customer portal
-- hides the Documents page and rejects upload calls server-side. Owner-side
-- access to existing documents stays available — the toggle only gates
-- *new* customer uploads. Owner can flip in Settings.
alter table public.communities
  add column if not exists tax_customer_documents_enabled boolean not null default false;

-- ─── Customer portal — disabled by default ────────────────────────────────────
-- Per-community switch. When false (the new default), the customer-facing
-- portal is closed:
--   • /tax/{slug} routes that require customer auth bounce to the landing
--     page with a "portal closed" notice
--   • Outgoing emails (reminders, welcome, document, signature, message)
--     swap their portal links for the landing-page URL so customers don't
--     hit a dead login screen
-- Owner-side employee portal stays available either way. Owner can flip
-- in Settings → Customer portal.
alter table public.communities
  add column if not exists tax_customer_portal_enabled boolean not null default false;

-- ─── Task tracker (replaces the spreadsheet workflow) ──────────────────────────
-- Per-community task list. Each task is optionally tied to a customer and a
-- service (tax_products) so the page can group/filter the way the owner's
-- spreadsheet did. Status values are editable per community via
-- tax_task_status_options below — `status_key` references one of those keys.

create table if not exists public.tax_task_status_options (
  id            text primary key,
  community_id  text not null references public.communities(id) on delete cascade,
  key           text not null,
  label_i18n    jsonb not null default '{}'::jsonb,
  color         text not null default '',     -- optional hex/css for the badge
  display_order int not null default 0,
  is_terminal   boolean not null default false, -- true for "Completed"-style states
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (community_id, key)
);
alter table public.tax_task_status_options disable row level security;
create index if not exists tax_task_status_options_community_idx
  on public.tax_task_status_options(community_id, display_order);

create table if not exists public.tax_tasks (
  id                       text primary key,
  community_id             text not null references public.communities(id) on delete cascade,
  customer_id              text references public.tax_customers(id) on delete cascade,
  product_id               text references public.tax_products(id) on delete set null,
  title                    text not null,
  status_key               text not null default 'not_started',
  priority                 text not null default 'normal'
                             check (priority in ('urgent','high','normal','low')),
  assigned_employee_id     text references public.tax_employees(id) on delete set null,
  created_by_employee_id   text references public.tax_employees(id) on delete set null,
  due_date                 date,
  notes                    text not null default '',
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table public.tax_tasks disable row level security;
create index if not exists tax_tasks_community_idx
  on public.tax_tasks(community_id, status_key, due_date);
create index if not exists tax_tasks_customer_idx
  on public.tax_tasks(customer_id, created_at desc) where customer_id is not null;
create index if not exists tax_tasks_assignee_idx
  on public.tax_tasks(assigned_employee_id, status_key, due_date) where assigned_employee_id is not null;
create index if not exists tax_tasks_product_idx
  on public.tax_tasks(product_id, status_key) where product_id is not null;

-- Phase 4n.36: tasks linked to a (customer, relationship_type) get
-- auto-generated when the relationship is added, and archived when
-- it's removed. `source` distinguishes auto-generated rows from
-- owner-authored tasks so the UI can label them and the cascade
-- archive only touches generator output. `archived_at` is the
-- soft-delete stamp — archived rows are excluded from list queries
-- but kept for audit history.
alter table public.tax_tasks
  add column if not exists relationship_type_id text
    references public.tax_relationship_types(id) on delete set null;
alter table public.tax_tasks
  add column if not exists schedule_id text
    references public.tax_filing_schedules(id) on delete set null;
alter table public.tax_tasks
  add column if not exists source text not null default 'manual'
    check (source in ('manual','relationship_schedule'));
alter table public.tax_tasks
  add column if not exists archived_at timestamptz;
alter table public.tax_tasks
  add column if not exists period_key text;
create index if not exists tax_tasks_relationship_idx
  on public.tax_tasks(relationship_type_id, archived_at)
  where relationship_type_id is not null;
-- Per-customer / per-schedule uniqueness on the period_key keeps the
-- task generator idempotent. A period_key is something like
-- "{schedule_slug}:{period_start}" so re-running the generator never
-- creates duplicate rows for the same upcoming period.
create unique index if not exists tax_tasks_period_unique
  on public.tax_tasks(customer_id, schedule_id, period_key)
  where period_key is not null and archived_at is null;

-- Phase 4n.36: per-community switch for the existing customer-facing
-- reminder cron. Defaults to FALSE because the practice now manages
-- recurring work through internal tasks instead of customer emails.
-- Owners can flip back to true in Settings if they want emails to
-- keep flowing.
alter table public.communities
  add column if not exists tax_customer_reminders_enabled boolean
    not null default false;

-- Phase 4n.37: owner-attachable video URLs across the public-facing
-- catalog. Each row may carry a single video link (YouTube, Vimeo,
-- direct MP4) that the landing page embeds inside the service detail
-- modal, the FAQ accordion entry, or the article body. Empty string
-- means "no video" — the embed is skipped at render time.
alter table public.tax_products
  add column if not exists video_url text not null default '';
alter table public.tax_help_articles
  add column if not exists video_url text not null default '';
alter table public.tax_community_help_articles
  add column if not exists video_url text not null default '';
alter table public.tax_relationship_default_faqs
  add column if not exists video_url text not null default '';
alter table public.tax_relationship_faqs
  add column if not exists video_url text not null default '';

-- Phase 4n.38: services own their task schedule directly. The old
-- "workflow rule + filing schedule" indirection retires — each
-- tax_products row carries its cadence and anchor_rule, and each
-- tax_relationship_types row points at a default product so the
-- task generator can resolve "this customer is tagged with X →
-- create tasks on Y cadence" in one hop.
alter table public.tax_products
  add column if not exists cadence_kind text not null default 'none'
    check (cadence_kind in ('none','weekly','monthly','quarterly','annual'));
alter table public.tax_products
  add column if not exists anchor_rule jsonb not null default '{}'::jsonb;
alter table public.tax_products
  add column if not exists employee_notes_i18n jsonb not null default '{}'::jsonb;
alter table public.tax_relationship_types
  add column if not exists product_id text
    references public.tax_products(id) on delete set null;
create index if not exists tax_relationship_types_product_idx
  on public.tax_relationship_types(product_id) where product_id is not null;

-- Second partial unique index so product-cadence rows (schedule_id is
-- null, since they're not anchored to a tax_filing_schedules row) get
-- their own idempotency key on (customer, product, period). The
-- existing (customer_id, schedule_id, period_key) index covers
-- legacy workflow-rule-driven rows.
create unique index if not exists tax_tasks_product_period_unique
  on public.tax_tasks(customer_id, product_id, period_key)
  where period_key is not null and archived_at is null and schedule_id is null;

-- Phase 4n.39: per-community task look-ahead window. The task
-- generator creates one task per upcoming period out to this many
-- months ahead. A daily cron re-runs the generator across every
-- active customer relationship to keep the window rolling so the
-- Tasks page never runs dry. Owner can stretch (12, 18) or shorten
-- (3) via Settings.
alter table public.communities
  add column if not exists tax_task_lookahead_months smallint not null default 6
    check (tax_task_lookahead_months between 1 and 24);

-- Phase 4n.40: optional public profile for each employee. When an
-- owner enables `show_on_homepage`, the employee's name + photo +
-- short bio surface on the landing page in a Meet-the-team section.
-- Default OFF so existing employees don't leak onto the public site
-- on schema-apply. bio_i18n is { en, es } so the section can render
-- in either locale.
alter table public.tax_employees
  add column if not exists show_on_homepage boolean not null default false;
alter table public.tax_employees
  add column if not exists photo_url text not null default '';
alter table public.tax_employees
  add column if not exists title_i18n jsonb not null default '{}'::jsonb;
alter table public.tax_employees
  add column if not exists bio_i18n jsonb not null default '{}'::jsonb;
alter table public.tax_employees
  add column if not exists homepage_display_order int not null default 100;
create index if not exists tax_employees_homepage_idx
  on public.tax_employees(community_id, homepage_display_order)
  where show_on_homepage = true and status = 'active';

-- Seed the three default status options for tax-america-services. New
-- communities provisioned via the platform endpoint should mirror this
-- (handled in server code on community create).
insert into public.tax_task_status_options
  (id, community_id, key, label_i18n, color, display_order, is_terminal) values
  ('tas:tax-america-services:not_started', 'tax-america-services', 'not_started',
   '{"en":"Not started","es":"No iniciado"}'::jsonb, '#9ca3af', 10, false),
  ('tas:tax-america-services:in_progress', 'tax-america-services', 'in_progress',
   '{"en":"In progress","es":"En progreso"}'::jsonb, '#f59e0b', 20, false),
  ('tas:tax-america-services:completed',   'tax-america-services', 'completed',
   '{"en":"Completed","es":"Completado"}'::jsonb,   '#10b981', 30, true)
on conflict (id) do nothing;

-- ─── Industry best-practice default schedules ─────────────────────────────────
-- Extends the original seed in this file with the schedules most tax
-- practices need out of the box. Idempotent — `on conflict (id) do nothing`
-- means re-running the file leaves existing rows alone.
insert into public.tax_filing_schedules
  (id, community_id, product_id, slug, jurisdiction, cadence, anchor_rule,
   info_checklist, name_i18n, description_i18n, display_order) values

-- Annual federal 1040 (individual) — calendar-year deadline April 15.
('tax-america-services:fed-1040', 'tax-america-services', 'tax-america-services:individual-tax', 'fed-1040',
  'federal', 'annual',
  '{"type":"annual","date":"04-15"}'::jsonb,
  '[
    {"key":"w2_form","type":"file","required":true,"label_i18n":{"es":"Formulario(s) W-2","en":"W-2 form(s)"}},
    {"key":"ten99_forms","type":"file","required":false,"label_i18n":{"es":"Formularios 1099 (si aplica)","en":"1099 forms (if any)"}},
    {"key":"mortgage_interest","type":"currency","required":false,"label_i18n":{"es":"Interés hipotecario pagado (USD)","en":"Mortgage interest paid (USD)"}},
    {"key":"charitable_giving","type":"currency","required":false,"label_i18n":{"es":"Donaciones caritativas (USD)","en":"Charitable contributions (USD)"}},
    {"key":"medical_expenses","type":"currency","required":false,"label_i18n":{"es":"Gastos médicos (USD)","en":"Medical expenses (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Algo más que debamos saber","en":"Anything else we should know"}}
  ]'::jsonb,
  '{"es":"Declaración Federal Anual 1040","en":"Federal 1040 — Annual Individual Return"}'::jsonb,
  '{"es":"Declaración federal anual de impuesto sobre la renta. Vence el 15 de abril.","en":"Annual federal income tax return. Due April 15."}'::jsonb,
  80),

-- Annual federal 1120 (C-Corp) — April 15.
('tax-america-services:fed-1120', 'tax-america-services', 'tax-america-services:business-tax', 'fed-1120',
  'federal', 'annual',
  '{"type":"annual","date":"04-15"}'::jsonb,
  '[
    {"key":"financial_statements","type":"file","required":true,"label_i18n":{"es":"Estados financieros de fin de año (P&G, balance)","en":"Year-end financial statements (P&L, balance sheet)"}},
    {"key":"general_ledger","type":"file","required":false,"label_i18n":{"es":"Libro mayor / balance de prueba","en":"General ledger / trial balance"}},
    {"key":"asset_acquisitions","type":"text","required":false,"label_i18n":{"es":"Compras o ventas de activos","en":"New asset purchases or dispositions"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Declaración Anual Corporativa (1120)","en":"Federal 1120 — C-Corp Annual Return"}'::jsonb,
  '{"es":"Declaración anual de impuesto sobre la renta para corporaciones C. Vence el 15 de abril.","en":"Annual income tax return for C-corporations. Due April 15."}'::jsonb,
  90),

-- Annual federal 1120-S (S-Corp) — March 15.
('tax-america-services:fed-1120s', 'tax-america-services', 'tax-america-services:business-tax', 'fed-1120s',
  'federal', 'annual',
  '{"type":"annual","date":"03-15"}'::jsonb,
  '[
    {"key":"financial_statements","type":"file","required":true,"label_i18n":{"es":"Estados financieros de fin de año","en":"Year-end financial statements"}},
    {"key":"shareholder_list","type":"text","required":true,"label_i18n":{"es":"Lista de accionistas con porcentaje de participación","en":"Shareholder list with ownership percentages"}},
    {"key":"shareholder_distributions","type":"currency","required":false,"label_i18n":{"es":"Distribuciones totales a accionistas (USD)","en":"Total distributions to shareholders (USD)"}},
    {"key":"reasonable_comp_paid","type":"currency","required":false,"label_i18n":{"es":"Compensación razonable pagada a propietarios-empleados (USD)","en":"Reasonable compensation paid to owner-employees (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Declaración Anual S-Corp (1120-S)","en":"Federal 1120-S — S-Corp Annual Return"}'::jsonb,
  '{"es":"Declaración anual de impuesto sobre la renta para corporaciones S. Vence el 15 de marzo. Se emiten K-1 a los accionistas.","en":"Annual income tax return for S-corporations. Due March 15. K-1s issued to shareholders."}'::jsonb,
  100),

-- Annual federal 1065 (Partnership / multi-member LLC) — March 15.
('tax-america-services:fed-1065', 'tax-america-services', 'tax-america-services:business-tax', 'fed-1065',
  'federal', 'annual',
  '{"type":"annual","date":"03-15"}'::jsonb,
  '[
    {"key":"financial_statements","type":"file","required":true,"label_i18n":{"es":"Estados financieros de fin de año","en":"Year-end financial statements"}},
    {"key":"partner_list","type":"text","required":true,"label_i18n":{"es":"Lista de socios con porcentaje de propiedad","en":"Partner list with ownership / profit-share percentages"}},
    {"key":"partner_distributions","type":"currency","required":false,"label_i18n":{"es":"Distribuciones totales a socios (USD)","en":"Total distributions to partners (USD)"}},
    {"key":"guaranteed_payments","type":"currency","required":false,"label_i18n":{"es":"Pagos garantizados a socios (USD)","en":"Guaranteed payments to partners (USD)"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Notas","en":"Notes"}}
  ]'::jsonb,
  '{"es":"Declaración Anual de Sociedad (1065)","en":"Federal 1065 — Partnership Annual Return"}'::jsonb,
  '{"es":"Declaración anual para sociedades y LLCs multi-miembro. Vence el 15 de marzo. Se emiten K-1 a los socios.","en":"Annual return for partnerships and multi-member LLCs. Due March 15. K-1s issued to partners."}'::jsonb,
  110),

-- Monthly bookkeeping close — internal practice cadence, due 15th of next month.
('tax-america-services:bookkeeping-monthly', 'tax-america-services', 'tax-america-services:bookkeeping', 'bookkeeping-monthly',
  'firm', 'monthly',
  '{"type":"monthly_following","day":15}'::jsonb,
  '[
    {"key":"bank_statements","type":"file","required":true,"label_i18n":{"es":"Estado(s) de cuenta bancarios del mes (PDF)","en":"Bank statement(s) for the month (PDF)"}},
    {"key":"credit_card_statements","type":"file","required":false,"label_i18n":{"es":"Estado(s) de tarjeta de crédito (PDF)","en":"Credit card statement(s) (PDF)"}},
    {"key":"expense_receipts","type":"file","required":false,"label_i18n":{"es":"Recibos de gastos significativos","en":"Significant expense receipts"}},
    {"key":"large_transactions","type":"text","required":false,"label_i18n":{"es":"Notas sobre transacciones grandes o inusuales","en":"Notes on large or unusual transactions"}}
  ]'::jsonb,
  '{"es":"Cierre Mensual de Contabilidad","en":"Monthly Bookkeeping Close"}'::jsonb,
  '{"es":"Cierre mensual del período anterior. Entrega de estados financieros el día 15 del mes siguiente.","en":"Monthly close of the prior period. Financials delivered by the 15th."}'::jsonb,
  120),

-- IRS notice response — episodic, 30-day window.
('tax-america-services:irs-notice', 'tax-america-services', 'tax-america-services:irs-representation', 'irs-notice',
  'federal', 'annual',
  '{"type":"annual","date":"12-31"}'::jsonb,
  '[
    {"key":"notice_copy","type":"file","required":true,"label_i18n":{"es":"Copia del aviso del IRS (todas las páginas)","en":"Copy of the IRS notice (all pages)"}},
    {"key":"notice_number","type":"text","required":true,"label_i18n":{"es":"Número del aviso (ej., CP2000, LT11)","en":"Notice number (e.g., CP2000, LT11)"}},
    {"key":"tax_year","type":"text","required":true,"label_i18n":{"es":"Año fiscal referenciado en el aviso","en":"Tax year referenced in the notice"}},
    {"key":"response_deadline","type":"date","required":true,"label_i18n":{"es":"Fecha límite impresa en el aviso","en":"Response deadline printed on the notice"}},
    {"key":"authorization_2848","type":"file","required":false,"label_i18n":{"es":"Formulario 2848 firmado si no lo tenemos","en":"Signed Form 2848 if not already on file"}},
    {"key":"notes","type":"text","required":false,"label_i18n":{"es":"Contexto — qué estaba ocurriendo ese año","en":"Context — what was happening that year"}}
  ]'::jsonb,
  '{"es":"Respuesta a Aviso del IRS","en":"IRS Notice Response"}'::jsonb,
  '{"es":"Respuesta al aviso del IRS. Ventana estatutaria de 30 días — ajuste según la fecha impresa.","en":"IRS notice response. Statutory 30-day window — adjust to the printed deadline."}'::jsonb,
  130)

on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.42 — refresh employee help center for the task-first model
--
-- The legacy articles described Inbox / Subscriptions / Workflows /
-- customer-facing reminders. Those surfaces retired in PRs #109–112.
-- We hide the dead ones, rewrite the still-relevant ones with current
-- copy, and add new articles for Tasks + Progress, the unified
-- Services editor, employee permission delegation, and the public
-- team section.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Hide articles whose subject no longer exists in the product.
update public.tax_help_articles set active = false
 where id in (
   'help.emp.gs.inbox',         -- Inbox tab removed from sidebar
   'help.emp.messages',         -- replies-on-threads UX deprecated
   'help.admin.subscriptions'   -- subscriptions + reminder cron retired
 );

-- Rewrite articles that still apply but describe the new flow.
update public.tax_help_articles set
  title_i18n = '{"en":"How customer assignments scope your work","es":"Cómo las asignaciones de clientes limitan su trabajo"}'::jsonb,
  body_i18n  = '{"en":"If your role is staff, every list in the portal — Tasks, Customers, Reminders, Progress — is filtered to customers your owner has assigned to you. Your profile page lists them.\n\nIf your role is admin, you see every customer in the practice automatically; no assignments needed. Owners can revoke specific admin powers per employee — see ''Editing employee permissions'' below.\n\nAssignments are managed by an owner on Employee portal → Staff → your row. Multiple people can be assigned to the same customer; the system marks one as the lead.","es":"Si su rol es personal, cada lista del portal — Tareas, Clientes, Recordatorios, Progreso — se filtra a los clientes que su dueño le asignó. Su perfil los muestra.\n\nSi su rol es administrador, ve a todos los clientes de la oficina automáticamente; no hace falta asignaciones. El dueño puede revocar permisos específicos por empleado — vea ''Editar permisos del empleado'' abajo.\n\nLas asignaciones se manejan en Portal del personal → Personal → su fila. Varias personas pueden estar asignadas al mismo cliente; el sistema marca a una como principal."}'::jsonb
  where id = 'help.emp.assignments';

update public.tax_help_articles set
  title_i18n = '{"en":"The owner sidebar at a glance","es":"La barra lateral del propietario de un vistazo"}'::jsonb,
  body_i18n  = '{"en":"The sidebar splits into two groups so it''s obvious which surface each page configures:\n\n🏠 Homepage (public site) — Services, Articles, FAQs. Anything edited here goes live on your /tax/{slug} landing page.\n\n🛠 Employee portal — Email templates, Staff, Settings, Audit. Anything edited here only affects how your team works inside this app.\n\nDay-to-day work surfaces live above those: Progress (service rollup), Tasks, Customers, and (admin-only) Leads. Old surfaces — Inbox, Reminders to customers, Workflows, Setup — were retired; their links are no longer in the sidebar but the pages still load via direct URL for anything bookmarked.","es":"La barra lateral se divide en dos grupos para que quede claro qué pantalla configura cada página:\n\n🏠 Página pública — Servicios, Artículos, Preguntas frecuentes. Lo que edite aquí se publica en /tax/{slug}.\n\n🛠 Portal del personal — Plantillas de correo, Personal, Configuración, Auditoría. Lo que edite aquí solo afecta cómo trabaja su equipo dentro de la app.\n\nLas pantallas operativas viven arriba: Progreso (resumen por servicio), Tareas, Clientes y (solo admin) Prospectos. Las pantallas retiradas — Bandeja, Recordatorios al cliente, Flujos, Configuración inicial — ya no están en la barra; las páginas siguen cargando vía URL directa para enlaces guardados."}'::jsonb
  where id = 'help.emp.admin';

update public.tax_help_articles set
  title_i18n = '{"en":"Customers — add, edit, search, import","es":"Clientes — agregar, editar, buscar, importar"}'::jsonb,
  body_i18n  = '{"en":"Three ways into a customer:\n\n• Add a customer — quick form. Email + first name required.\n• Inline from a task — when assigning a customer to a new task, the picker is a typeahead that searches name / email / phone. If nothing matches, an admin sees a ''+ New customer'' option that creates the customer on the spot.\n• CSV import — for moving a roster from a spreadsheet. ''Skip existing'' or ''Update existing'' modes.\n\nA customer record now centers on five sections: Profile, Relationships, Tasks, Notes, Documents, then Assignments + Activity at the bottom. The relationship a customer is tagged with determines which services drive their tasks. When you pick a customer for a new task, the service field auto-fills from their first relationship — owner can override per task.","es":"Tres formas de crear un cliente:\n\n• Agregar un cliente — formulario rápido. Correo y nombre obligatorios.\n• Desde una tarea — al asignar un cliente a una tarea, el selector busca por nombre / correo / teléfono. Si no hay coincidencia, un administrador ve un ''+ Nuevo cliente'' que crea el cliente en el momento.\n• Importación CSV — para mover una lista desde una hoja de cálculo. Modos ''Omitir existentes'' o ''Actualizar existentes''.\n\nUn cliente se compone ahora de cinco secciones: Perfil, Relaciones, Tareas, Notas, Documentos, y al final Asignaciones + Actividad. La relación con la que se etiqueta a un cliente determina qué servicios generan sus tareas. Al elegir un cliente para una tarea, el servicio se prellena desde su primera relación — el dueño puede sobrescribirlo por tarea."}'::jsonb
  where id = 'help.admin.customers';

update public.tax_help_articles set
  title_i18n = '{"en":"Relationships drive task generation","es":"Las relaciones generan tareas automáticamente"}'::jsonb,
  body_i18n  = '{"en":"A relationship is a tag that links a customer to a service. The new model is direct:\n\n  customer → relationship type → linked service → tasks\n\nOn the Services page (🏠 Homepage → Services) the Internal section of each service lets you point a relationship tag at it and set the cadence (weekly / monthly / quarterly / annual + day specifier). When a customer is tagged with that relationship, the system creates one task per period for the next 6 months, with due dates derived from the cadence. A daily cron extends the window automatically; owners can change the look-ahead in Employee portal → Settings.\n\nRemoving a relationship hard-deletes the untouched generator tasks (no completion, no assignee, no notes). Tasks an employee has already started are preserved.","es":"Una relación es una etiqueta que liga al cliente con un servicio. El modelo nuevo es directo:\n\n  cliente → tipo de relación → servicio vinculado → tareas\n\nEn la página Servicios (🏠 Página pública → Servicios), la sección Interna de cada servicio permite apuntar una etiqueta de relación al servicio y fijar la cadencia (semanal / mensual / trimestral / anual + día). Al etiquetar a un cliente con esa relación, el sistema crea una tarea por período durante los próximos 6 meses, con fechas derivadas de la cadencia. Un cron diario amplía la ventana automáticamente; el dueño puede cambiar el rango en Portal del personal → Configuración.\n\nQuitar una relación borra las tareas generadas que no se hayan tocado (sin completar, sin asignar, sin notas). Las tareas en las que el equipo ya trabaja se conservan."}'::jsonb
  where id = 'help.admin.relationships';

update public.tax_help_articles set
  title_i18n = '{"en":"Staff: invite, assign customers, edit permissions","es":"Personal: invitar, asignar clientes, editar permisos"}'::jsonb,
  body_i18n  = '{"en":"From Employee portal → Staff, Add a staff member creates a row by email. Two roles:\n\n• Staff — sees only customers assigned to them. No admin pages by default.\n• Admin — sees every customer.\n\nClick a row to open the detail page. Three cards live there:\n\n• Public profile — turn on Show on homepage to publish this employee in the Meet-the-team section of your public site, with photo URL, optional title, and bilingual bio.\n• Permissions — by default every employee has the same permissions as the owner (the requested ''default = same as owner'' behavior). Toggle off any of the nine keys (manage_customers, manage_services, manage_settings, manage_employees, view_audit_logs, etc.) to revoke. The server re-checks every request, so revoked actions return 403 even from a stale tab.\n• Assignments — pick which customers this staff member can see and message.\n\nThe owner is blocked from revoking manage_employees from themselves so they can''t lock themselves out of this screen.","es":"En Portal del personal → Personal, Agregar miembro del personal crea una fila por correo. Dos roles:\n\n• Personal — solo ve los clientes que tiene asignados. Sin pantallas de administrador por defecto.\n• Administrador — ve a todos los clientes.\n\nHaga clic en una fila para abrir el detalle. Tres tarjetas allí:\n\n• Perfil público — active Mostrar en página pública para publicar al empleado en la sección Conoce al equipo del sitio público, con URL de la foto, cargo opcional y biografía bilingüe.\n• Permisos — por defecto todo empleado tiene los mismos permisos que el dueño (comportamiento ''por defecto = mismo del dueño''). Desmarque cualquiera de las nueve claves (manage_customers, manage_services, manage_settings, manage_employees, view_audit_logs, etc.) para revocar. El servidor verifica cada solicitud; las acciones revocadas devuelven 403 aún desde una pestaña antigua.\n• Asignaciones — elija qué clientes ve y puede contactar este miembro del personal.\n\nEl dueño no puede revocarse a sí mismo manage_employees para no quedar fuera de esta pantalla."}'::jsonb
  where id = 'help.admin.staff';

update public.tax_help_articles set
  title_i18n = '{"en":"FAQs, Articles, and videos","es":"Preguntas frecuentes, Artículos y videos"}'::jsonb,
  body_i18n  = '{"en":"FAQs and articles ship with platform defaults that you can override or extend per community:\n\n• FAQs (🏠 Homepage → FAQs) — override the answer, hide a default, or write a new one. Each FAQ is tagged to a relationship type and shows on /tax/{slug}/faqs.\n• Articles (🏠 Homepage → Articles) — same override/hide/custom pattern for help articles. Customer-audience articles appear on /tax/{slug}/articles; staff-audience articles are visible here in Help.\n\nVideos — every service, FAQ, and article now has an optional Video URL field. Paste a YouTube watch URL, a Vimeo link, or a direct .mp4 / .webm URL; the page embeds the right player automatically. Unknown URLs fall back to a plain link.","es":"Las preguntas frecuentes y los artículos vienen con valores predeterminados de la plataforma que puede reemplazar o ampliar por oficina:\n\n• Preguntas frecuentes (🏠 Página pública → Preguntas frecuentes) — reemplace la respuesta, oculte un valor predeterminado o escriba uno nuevo. Cada pregunta se etiqueta a un tipo de relación y aparece en /tax/{slug}/faqs.\n• Artículos (🏠 Página pública → Artículos) — mismo patrón de reemplazar/ocultar/personalizado para los artículos de ayuda. Los artículos para clientes aparecen en /tax/{slug}/articles; los artículos para personal son visibles aquí en Ayuda.\n\nVideos — cada servicio, pregunta y artículo tiene ahora un campo URL del video opcional. Pegue una URL de YouTube, un enlace de Vimeo o una URL directa .mp4 / .webm; la página inserta el reproductor automáticamente. Las URLs desconocidas caen en un enlace simple."}'::jsonb
  where id = 'help.admin.content';

update public.tax_help_articles set
  title_i18n = '{"en":"Practice settings: toggles you''ll actually use","es":"Configuración: interruptores realmente importantes"}'::jsonb,
  body_i18n  = '{"en":"Settings is small but consequential. Four toggles + one number:\n\n• Customer portal — Off by default. When off, customers can''t sign in, signature requests don''t render, and email links point to the public landing page instead of /portal. Turn on if you want a self-service portal experience.\n• Customer reminder emails — Off by default. When off, the reminder cron never emails customers. Tasks still auto-generate from cadences; the team manages everything internally.\n• Customer documents — Off by default. When off, customers can''t upload files; the owner side still works as a per-customer file store.\n• Notification-preference lock — controls whether each customer can change their reminder channels in their portal profile. Has no effect when reminders are off.\n\nTask look-ahead — number input (1–24 months, default 6). How far ahead the task generator queues up periods. A daily cron rolls the window forward; Refresh tasks now re-runs the generator on demand.","es":"Configuración es pequeña pero importante. Cuatro interruptores y un número:\n\n• Portal del cliente — Desactivado por defecto. Cuando está apagado, los clientes no pueden iniciar sesión, no se muestran solicitudes de firma y los enlaces de los correos apuntan al sitio público en vez de /portal. Actívelo si quiere una experiencia de autoservicio.\n• Correos de recordatorio al cliente — Desactivado por defecto. Apagado, el cron nunca envía correos a clientes. Las tareas siguen generándose por cadencia; el equipo lo maneja todo internamente.\n• Documentos del cliente — Desactivado por defecto. Apagado, el cliente no puede subir archivos; el lado del dueño sigue siendo un almacén de archivos por cliente.\n• Bloqueo de preferencias de notificación — controla si cada cliente puede cambiar sus canales desde el perfil del portal. Sin efecto cuando los recordatorios están apagados.\n\nVentana de tareas — número (1–24 meses, predeterminado 6). Cuánto se adelanta el generador. Un cron diario avanza la ventana; Actualizar tareas ahora reejecuta a demanda."}'::jsonb
  where id = 'help.admin.settings';

-- New articles for surfaces that didn't exist when the original seeds
-- were authored. Display orders fit between the existing 100s.
insert into public.tax_help_articles
  (id, audience, relationship_type_id, category, display_order, title_i18n, body_i18n)
values
  ('help.admin.tasks_progress', 'employee', null, 'admin', 95,
   '{"en":"Tasks and the Progress dashboard","es":"Tareas y el panel de Progreso"}'::jsonb,
   '{"en":"Tasks is the daily work surface. Add task opens a modal with a customer typeahead (with inline ''+ New customer'' for admins), a service field that auto-fills from the customer''s first relationship, owner, priority, due date, and a notes box. Edit reopens the same modal in edit mode. Status changes inline via the chip dropdown.\n\nAuto-generated tasks come from relationship cadences and show the service name + period label. They behave the same as manual tasks; the owner assigns them, the team works them.\n\nProgress is the cross-service rollup at /employee/progress. KPI cards on top (Done / In progress / Open / Overdue), then per-service cards that expand to a per-customer table with a progress bar. Two filters at the top: Task owner and Customer. Filters apply at the SQL layer so the KPIs and rollups recompute against the filtered set automatically.","es":"Tareas es la pantalla operativa diaria. Agregar tarea abre un modal con un selector de cliente (con ''+ Nuevo cliente'' inline para administradores), un servicio que se prellena desde la primera relación del cliente, responsable, prioridad, fecha de vencimiento y notas. Editar reabre el mismo modal en modo edición. El estado se cambia inline con el menú de chip.\n\nLas tareas generadas automáticamente provienen de las cadencias de las relaciones y muestran el nombre del servicio y la etiqueta del período. Se comportan igual que las tareas manuales; el dueño las asigna, el equipo las trabaja.\n\nProgreso es el panel cruzado por servicio en /employee/progress. Tarjetas KPI arriba (Listas / En curso / Sin iniciar / Vencidas), luego tarjetas por servicio que se expanden a una tabla por cliente con barra de progreso. Dos filtros arriba: Responsable y Cliente. Los filtros se aplican en SQL, así que los KPIs y los resúmenes se recalculan automáticamente."}'::jsonb),

  ('help.admin.services_unified', 'employee', null, 'admin', 96,
   '{"en":"Services — one row, two sections (Homepage + Internal)","es":"Servicios — una fila, dos secciones (Pública + Interna)"}'::jsonb,
   '{"en":"The Services page (🏠 Homepage → Services) is now the only place to configure a service. Each row expands to an editor with two clearly-marked sections:\n\n🏠 Homepage — name, short description, full description, required documents, video URL, display order. Edits go live on the public landing page as soon as you save. Visitors see the short description on the card, and the full description + video on the detail modal.\n\n🛠 Internal (employee portal only) — relationship tag (which relationship type identifies a customer using this service), task cadence (none / weekly / monthly / quarterly / annual + the day-of-month or weekday), and bilingual employee-only notes that only show inside the staff portal.\n\nDelete a service: open the row, click Delete. If active customer subscriptions exist the server refuses with a 409 and lists the counts; a second confirm with force-delete actually removes them. Customers'' historical leads keep their product_slug intact (text column, not a FK) so old lead history isn''t lost.","es":"La página Servicios (🏠 Página pública → Servicios) es ahora el único lugar para configurar un servicio. Cada fila se expande a un editor con dos secciones claramente marcadas:\n\n🏠 Página pública — nombre, descripción breve, descripción completa, documentos requeridos, URL del video, orden. Los cambios se publican en la página pública al guardar. Los visitantes ven la descripción breve en la tarjeta, y la completa + video en el modal de detalle.\n\n🛠 Interno (solo portal del personal) — etiqueta de relación (qué tipo de relación identifica a un cliente que usa este servicio), cadencia (ninguna / semanal / mensual / trimestral / anual + día del mes o de la semana), y notas bilingües para el personal que solo se muestran dentro del portal.\n\nEliminar un servicio: abra la fila, clic Eliminar. Si hay suscripciones activas el servidor responde 409 con los conteos; un segundo aviso con force las elimina. El historial de prospectos del cliente conserva product_slug (columna de texto, no FK), así que no se pierde."}'::jsonb),

  ('help.admin.permissions', 'employee', null, 'admin', 97,
   '{"en":"Editing employee permissions","es":"Editar permisos del empleado"}'::jsonb,
   '{"en":"Every employee starts with the same permissions as the owner (default = granted for all nine keys). To change that, open Employee portal → Staff → click the employee → Permissions card.\n\nThe nine keys map to write surfaces that an owner might want to keep to themselves:\n\n• manage_customers — create/edit/import customers, send welcome + signature emails\n• manage_leads — work the leads pipeline\n• manage_services — edit the service catalog + relationship types\n• manage_workflows — legacy; kept for old tenants on the workflow-rule path\n• manage_email_templates — edit outgoing email templates\n• manage_settings — practice-wide toggles\n• manage_employees — invite/archive other employees + edit their permissions\n• send_reminders — manually fire the Send-reminder-now button\n• view_audit_logs — read the audit log\n\nToggle a key off → it turns into a Revoked chip in red and the corresponding sidebar links disappear for that employee. The server re-checks every request, so revoked actions return 403 even from a stale browser tab.\n\nThe server blocks you from revoking manage_employees from yourself — that one safeguard is hard-coded so you can''t lock yourself out of this screen.","es":"Cada empleado empieza con los mismos permisos que el dueño (predeterminado = concedido para las nueve claves). Para cambiar esto, abra Portal del personal → Personal → haga clic en el empleado → tarjeta Permisos.\n\nLas nueve claves cubren las superficies que un dueño podría querer guardarse:\n\n• manage_customers — crear/editar/importar clientes, enviar correos de bienvenida y firma\n• manage_leads — trabajar la cartera de prospectos\n• manage_services — editar el catálogo de servicios y los tipos de relación\n• manage_workflows — legado; se mantiene para inquilinos antiguos en la ruta de reglas de flujo\n• manage_email_templates — editar plantillas de correo saliente\n• manage_settings — interruptores de toda la oficina\n• manage_employees — invitar/archivar empleados y editar sus permisos\n• send_reminders — disparar manualmente el botón Enviar recordatorio ahora\n• view_audit_logs — leer el registro de auditoría\n\nDesmarque una clave → cambia a una etiqueta Revocado en rojo y los enlaces correspondientes desaparecen de la barra lateral del empleado. El servidor verifica cada solicitud, así que las acciones revocadas devuelven 403 aún desde una pestaña antigua.\n\nEl servidor bloquea que se revoque manage_employees de uno mismo — esa salvaguarda está codificada para que no se quede sin acceso a esta pantalla."}'::jsonb),

  ('help.admin.team_on_homepage', 'employee', null, 'admin', 98,
   '{"en":"Publishing employees on the homepage","es":"Publicar empleados en la página pública"}'::jsonb,
   '{"en":"Each staff member can be published on the Meet-the-team section of your public landing page. Open Employee portal → Staff → click the employee → Public profile card.\n\nFlip Show on homepage on and fill the fields:\n\n• Photo URL — paste a direct image link (LinkedIn headshot, a CDN, or a Google Drive direct-link). Square images render best in the circle. No photo → an initials-circle fallback.\n• Title — short role like ''Senior Tax Preparer'' (bilingual).\n• Bio — one short paragraph (bilingual). Years in the business, specialties, languages, certifications.\n• Sort order — controls the order of cards in the section.\n\nThe section hides entirely when no employee is opted in, so it''s safe to leave off until at least one profile is ready.","es":"Cada miembro del personal puede publicarse en la sección Conoce al equipo de la página pública. Abra Portal del personal → Personal → haga clic en el empleado → tarjeta Perfil público.\n\nActive Mostrar en página pública y complete los campos:\n\n• URL de la foto — un enlace directo a la imagen (foto de LinkedIn, un CDN o un enlace directo de Google Drive). Las imágenes cuadradas se ven mejor en el círculo. Sin foto → un círculo con iniciales como respaldo.\n• Cargo — rol breve como ''Preparadora de Impuestos Senior'' (bilingüe).\n• Biografía — un párrafo corto (bilingüe). Años en el negocio, especialidades, idiomas, certificaciones.\n• Orden — controla el orden de las tarjetas en la sección.\n\nLa sección se oculta cuando ningún empleado está publicado, así que es seguro dejarla apagada hasta tener al menos un perfil listo."}'::jsonb)
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.43 — business name on customers
--
-- Business customers (LLCs, S-Corps, etc.) need a business name distinct
-- from the contact person's name. tax_customers stores it alongside the
-- existing first/middle/last. The display layer prefers business_name
-- when set; search treats it like another name column.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tax_customers
  add column if not exists business_name text not null default '';
create index if not exists tax_customers_business_name_idx
  on public.tax_customers(community_id, business_name)
  where business_name <> '';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.45 — task urgency thresholds
--
-- Three smallints per community drive the color treatment shared across
-- the Tasks list, Calendar, and Kanban views:
--   urgent_days   — due within N days → red-orange
--   soon_days     — due within N days → amber
--   upcoming_days — due within N days → blue (otherwise neutral/grey)
-- Anything past today is always "overdue" regardless of thresholds.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.communities
  add column if not exists tax_task_urgent_days smallint not null default 3
    check (tax_task_urgent_days between 0 and 60);
alter table public.communities
  add column if not exists tax_task_soon_days smallint not null default 7
    check (tax_task_soon_days between 0 and 90);
alter table public.communities
  add column if not exists tax_task_upcoming_days smallint not null default 30
    check (tax_task_upcoming_days between 0 and 365);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.46 — services own a list of auto-tasks
--
-- Real services have multiple recurring deliverables on different
-- cadences (a Bookkeeping engagement = monthly reconciliations +
-- quarterly P&L reviews + annual close, not a single "monthly
-- bookkeeping task"). Move the cadence off the product row and onto
-- a per-product list of auto-tasks.
--
-- Legacy product.cadence_kind / anchor_rule columns stay; the task
-- generator falls back to them when a product has no auto-tasks yet.
-- The backfill block below seeds one auto-task per product that
-- already had a non-none cadence, so existing tenants upgrade
-- silently.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_service_auto_tasks (
  id                text primary key,
  community_id      text not null references public.communities(id) on delete cascade,
  product_id        text not null references public.tax_products(id) on delete cascade,
  title_i18n        jsonb not null default '{}'::jsonb,
  description_i18n  jsonb not null default '{}'::jsonb,
  cadence_kind      text not null default 'monthly'
                      check (cadence_kind in ('none','weekly','monthly','quarterly','annual')),
  anchor_rule       jsonb not null default '{}'::jsonb,
  default_priority  text not null default 'normal'
                      check (default_priority in ('urgent','high','normal','low')),
  display_order     int  not null default 100,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.tax_service_auto_tasks disable row level security;
create index if not exists tax_service_auto_tasks_product_idx
  on public.tax_service_auto_tasks(product_id, display_order) where active = true;
create index if not exists tax_service_auto_tasks_community_idx
  on public.tax_service_auto_tasks(community_id);

-- FK on tax_tasks tying each generated task to the auto-task that
-- minted it. Used for idempotency on the new path; ON DELETE SET
-- NULL so removing an auto-task doesn't cascade-delete already-
-- completed work.
alter table public.tax_tasks
  add column if not exists service_auto_task_id text
    references public.tax_service_auto_tasks(id) on delete set null;
create unique index if not exists tax_tasks_auto_task_period_unique
  on public.tax_tasks(customer_id, service_auto_task_id, period_key)
  where period_key is not null and archived_at is null and service_auto_task_id is not null;

-- Backfill: one auto-task per existing product with a non-none
-- cadence. Idempotent — skips products that already have at least
-- one auto-task row.
insert into public.tax_service_auto_tasks
  (id, community_id, product_id, title_i18n, description_i18n,
   cadence_kind, anchor_rule, default_priority, display_order, active)
select
  'sat_legacy_' || substring(p.id, 1, 28),
  p.community_id,
  p.id,
  p.name_i18n,
  coalesce(p.employee_notes_i18n, '{}'::jsonb),
  p.cadence_kind,
  coalesce(p.anchor_rule, '{}'::jsonb),
  'normal',
  10,
  true
from public.tax_products p
where p.cadence_kind is not null
  and p.cadence_kind <> 'none'
  and not exists (
    select 1 from public.tax_service_auto_tasks sat
    where sat.product_id = p.id
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.47 — urgency model simplified to two thresholds
--
-- Drop the "upcoming" / blue band. New defaults map to "no color
-- by default, orange 7 days before, red 2 days before or past
-- due". The `tax_task_upcoming_days` column stays on the table for
-- back-compat but the UI no longer reads or writes it.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.communities
  alter column tax_task_urgent_days set default 2;

-- Migrate existing tenants who haven't customized: bring them to
-- the new defaults silently. Owners who set their own values are
-- left alone (the WHERE keeps the migration narrow).
update public.communities
   set tax_task_urgent_days = 2
 where tax_task_urgent_days = 3
   and tax_task_soon_days   = 7
   and tax_task_upcoming_days = 30
   and business_type = 'tax';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.48 — customer-to-service direct tagging
--
-- The old model required the owner to set up a relationship type,
-- link the relationship to a service, then tag the customer with the
-- relationship. Two layers for what's really a one-step flow:
-- "this customer is signed up for these services".
--
-- New join: tax_customer_services. Customer ←→ service directly.
-- The relationship_types table stays (FAQs + articles still
-- categorize by it), but customer-side tagging happens here.
--
-- Backfill below seeds the new join from existing
-- tax_customer_relationships → tax_relationship_types.product_id
-- so existing tenants upgrade silently.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.tax_customer_services (
  id                text primary key,
  community_id      text not null references public.communities(id) on delete cascade,
  customer_id       text not null references public.tax_customers(id) on delete cascade,
  product_id        text not null references public.tax_products(id) on delete cascade,
  notes             text not null default '',
  created_by_email  text not null default '',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (customer_id, product_id)
);
alter table public.tax_customer_services disable row level security;
create index if not exists tax_customer_services_customer_idx
  on public.tax_customer_services(customer_id) where active = true;
create index if not exists tax_customer_services_product_idx
  on public.tax_customer_services(product_id) where active = true;

-- Backfill — one row per (customer, product) reachable through the
-- existing relationship chain. Idempotent: unique constraint
-- swallows duplicates if the migration is rerun.
insert into public.tax_customer_services (id, community_id, customer_id, product_id, active, created_at, created_by_email)
select
  'ccs_' || substring(cr.id, 6),                       -- crel_xxxx → ccs_xxxx
  c.community_id,
  cr.customer_id,
  rt.product_id,
  cr.active,
  cr.created_at,
  coalesce(cr.created_by_email, 'migration')
from public.tax_customer_relationships cr
join public.tax_customers          c  on c.id = cr.customer_id
join public.tax_relationship_types rt on rt.id = cr.relationship_type_id
where rt.product_id is not null
on conflict (customer_id, product_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.49 — per-community color overrides for priorities + urgency
--
-- Status colors are already configurable per-row in
-- tax_task_status_options. Priority and urgency colors were
-- hard-coded in the client. These two JSONB columns let an owner
-- override either map with their own hex values. Shape:
--   tax_task_priority_colors  = { urgent, high, normal, low }
--   tax_task_urgency_colors   = { overdue, urgent, soon, later }
-- Each value is a single hex string the client uses as the accent;
-- the chip background is derived as a light tint. Missing keys
-- fall back to platform defaults.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.communities
  add column if not exists tax_task_priority_colors jsonb not null default '{}'::jsonb;
alter table public.communities
  add column if not exists tax_task_urgency_colors  jsonb not null default '{}'::jsonb;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.50 — retire legacy per-customer relationship tags
--
-- Customer-side tagging now lives in tax_customer_services (Phase
-- 4n.48). The tax_customer_relationships table stayed around as
-- backwards-compat for the daily cron, but the customer detail UI
-- no longer authors it and the new generator path (services →
-- auto-tasks) covers the same ground. Clear the rows so the
-- "ghost tags" don't keep surfacing in any old report. The
-- relationship_types catalog itself stays — FAQs and articles
-- still categorize by it.
-- ═══════════════════════════════════════════════════════════════════════════════
delete from public.tax_customer_relationships;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 4n.51 — default assignee on service auto-tasks
--
-- At ~300 customers per practice the generator floods the Tasks
-- page with unassigned recurring work that the owner then has to
-- triage one by one. Letting an auto-task carry a default employee
-- (the bookkeeper for monthly recons, the senior preparer for the
-- annual return) means new periods land already-routed.
--
-- Column is nullable — a value of NULL keeps the existing
-- "unassigned at creation" behavior. FK is ON DELETE SET NULL so
-- removing the employee from the practice doesn't cascade-delete
-- the auto-task; new periods just generate unassigned until the
-- owner re-picks.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.tax_service_auto_tasks
  add column if not exists default_assignee_employee_id text
    references public.tax_employees(id) on delete set null;
create index if not exists tax_service_auto_tasks_default_assignee_idx
  on public.tax_service_auto_tasks(default_assignee_employee_id)
  where default_assignee_employee_id is not null;
