-- Seed H1 / H2 bookkeeping report auto-tasks for the Bookkeeping
-- product (Phase 4n.71). Catalog entries in auto-task-templates.js are
-- suggestions only — nothing fires until rows exist in
-- tax_service_auto_tasks. This migration creates the two rows the
-- owner asked for (semi-annual P&L + Balance dispatch, July 31 and
-- January 31).
--
-- Idempotent: skips if a row with the same (product, title_i18n) is
-- already present. Active by default. Owner can deactivate or
-- customize via the standard service-auto-task admin.

-- For every community that has a 'bookkeeping' product (across all
-- tenants, future-proof), insert the H1 + H2 publish auto-tasks if
-- absent.
insert into public.tax_service_auto_tasks
  (id, community_id, product_id, title_i18n, description_i18n,
   cadence_kind, anchor_rule, default_priority, display_order, active)
select
  'sat_bk_h1_' || substring(p.id, 1, 26),
  p.community_id,
  p.id,
  '{"en":"Publish H1 Bookkeeping report (Jan–Jun)","es":"Publicar informe contable H1 (Ene–Jun)"}'::jsonb,
  '{"en":"Capture H1 P&L + Balance Sheet in the customer record, review the numbers, and email the dashboard. Due July 31.","es":"Capturar P&L + Balance del H1 en la ficha del cliente, revisar los números y enviar el panel al cliente. Vence 31 de julio."}'::jsonb,
  'annual',
  '{"type":"annual","month":7,"day":31}'::jsonb,
  'high',
  500,
  true
from public.tax_products p
where p.slug = 'bookkeeping'
  and not exists (
    select 1 from public.tax_service_auto_tasks sat
    where sat.product_id = p.id
      and sat.title_i18n->>'en' = 'Publish H1 Bookkeeping report (Jan–Jun)'
  );

insert into public.tax_service_auto_tasks
  (id, community_id, product_id, title_i18n, description_i18n,
   cadence_kind, anchor_rule, default_priority, display_order, active)
select
  'sat_bk_h2_' || substring(p.id, 1, 26),
  p.community_id,
  p.id,
  '{"en":"Publish H2 / annual Bookkeeping report (Jul–Dec)","es":"Publicar informe contable H2 / anual (Jul–Dic)"}'::jsonb,
  '{"en":"Capture H2 P&L + Balance Sheet in the customer record, review the numbers, and email the dashboard. Due January 31.","es":"Capturar P&L + Balance del H2 en la ficha del cliente, revisar los números y enviar el panel al cliente. Vence 31 de enero."}'::jsonb,
  'annual',
  '{"type":"annual","month":1,"day":31}'::jsonb,
  'high',
  510,
  true
from public.tax_products p
where p.slug = 'bookkeeping'
  and not exists (
    select 1 from public.tax_service_auto_tasks sat
    where sat.product_id = p.id
      and sat.title_i18n->>'en' = 'Publish H2 / annual Bookkeeping report (Jul–Dec)'
  );

-- Backfill: for every customer who already has the bookkeeping
-- service tagged (via either tax_customer_services or the legacy
-- tax_customer_relationships → tax_relationship_types path), the
-- next manual call to POST /api/m/tax/admin/tasks/refresh will
-- materialize the corresponding tax_tasks rows for the upcoming
-- July 31 / January 31 due dates. This SQL only creates the
-- templates; task generation runs in server JS.
