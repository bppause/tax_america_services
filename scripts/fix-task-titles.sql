-- ==========================================================================
-- fix-task-titles.sql
--
-- Paste into the Supabase SQL Editor.  Run STEP 1 first to preview, then
-- run STEP 2 to apply.  Both steps are safe to run multiple times.
--
-- What it fixes (tasks created before the June 2026 code fix):
--   • Language  — titles were in the customer's locale (often Spanish).
--                 Looks up name_i18n->>'en' from the source table and
--                 translates period labels (Año Fiscal → Tax Year, etc.).
--   • H1 year   — H1 bookkeeping tasks were labelled "Tax Year N-1"
--                 instead of "Tax Year N".  Also corrects the period_key
--                 so future idempotency checks stay consistent.
-- ==========================================================================


-- ─── SHARED CTE (used in both steps) ──────────────────────────────────────
--
-- Drop into a WITH clause in each step below.

-- ==========================================================================
-- STEP 1 — PREVIEW  (read-only, shows what will change)
-- ==========================================================================

WITH base AS (
  SELECT
    t.id,
    t.title                                          AS old_title,
    t.period_key                                     AS old_period_key,
    t.due_date,
    t.community_id,
    t.customer_id,
    t.service_auto_task_id,
    t.schedule_id,
    t.product_id,
    -- name part  (everything before the first ' — ')
    CASE WHEN t.title LIKE '% — %'
         THEN left(t.title, strpos(t.title, ' — ') - 1)
         ELSE t.title END                            AS raw_name,
    -- period part (everything after the first ' — ')
    CASE WHEN t.title LIKE '% — %'
         THEN substring(t.title FROM strpos(t.title, ' — ') + 4)
         ELSE '' END                                 AS raw_period
  FROM tax_tasks t
  WHERE t.source     = 'relationship_schedule'
    AND t.archived_at IS NULL
),
resolved AS (
  SELECT
    b.*,
    -- English schedule / auto-task name
    COALESCE(
      sat.title_i18n->>'en',
      fs.name_i18n->>'en',
      tp.name_i18n->>'en',
      b.raw_name          -- fallback: keep whatever is there
    ) AS en_name,
    -- Translate period label  (ES → EN)
    CASE
      -- "Año Fiscal YYYY"  →  "Tax Year YYYY"
      WHEN b.raw_period ~ '^Año Fiscal \d{4}$'
        THEN regexp_replace(b.raw_period, '^Año Fiscal (\d{4})$', 'Tax Year \1')
      -- "T1/T2/T3/T4 YYYY"  →  "Q1/Q2/Q3/Q4 YYYY"
      WHEN b.raw_period ~ '^T[1-4] \d{4}$'
        THEN regexp_replace(b.raw_period, '^T([1-4]) (\d{4})$', 'Q\1 \2')
      -- Monthly labels (capitalized Spanish month → English)
      WHEN b.raw_period ~ '^Enero \d{4}$'
        THEN 'January'    || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Febrero \d{4}$'
        THEN 'February'   || substring(b.raw_period FROM 8)
      WHEN b.raw_period ~ '^Marzo \d{4}$'
        THEN 'March'      || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Abril \d{4}$'
        THEN 'April'      || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Mayo \d{4}$'
        THEN 'May'        || substring(b.raw_period FROM 5)
      WHEN b.raw_period ~ '^Junio \d{4}$'
        THEN 'June'       || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Julio \d{4}$'
        THEN 'July'       || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Agosto \d{4}$'
        THEN 'August'     || substring(b.raw_period FROM 7)
      WHEN b.raw_period ~ '^Septiembre \d{4}$'
        THEN 'September'  || substring(b.raw_period FROM 11)
      WHEN b.raw_period ~ '^Octubre \d{4}$'
        THEN 'October'    || substring(b.raw_period FROM 8)
      WHEN b.raw_period ~ '^Noviembre \d{4}$'
        THEN 'November'   || substring(b.raw_period FROM 10)
      WHEN b.raw_period ~ '^Diciembre \d{4}$'
        THEN 'December'   || substring(b.raw_period FROM 10)
      -- "Semana del YYYY-MM-DD"  →  "Week of YYYY-MM-DD"
      WHEN b.raw_period LIKE 'Semana del %'
        THEN 'Week of '   || substring(b.raw_period FROM 11)
      ELSE b.raw_period   -- already English or unrecognised
    END                                              AS en_period
  FROM base b
  LEFT JOIN tax_service_auto_tasks sat
    ON sat.id = b.service_auto_task_id
  LEFT JOIN tax_filing_schedules fs
    ON fs.id = b.schedule_id
  LEFT JOIN tax_products tp
    ON  tp.id = b.product_id
    AND b.schedule_id IS NULL
    AND b.service_auto_task_id IS NULL
),
assembled AS (
  SELECT
    r.*,
    CASE WHEN r.raw_period = ''
         THEN r.en_name
         ELSE r.en_name || ' — ' || r.en_period
    END AS title_v1
  FROM resolved r
),
corrected AS (
  SELECT
    a.*,
    -- H1 year fix: label was "Tax Year N-1"; should be "Tax Year N"
    CASE
      WHEN a.title_v1 LIKE '%H1%'
        AND a.title_v1 LIKE '%Tax Year ' || (extract(year from a.due_date::date)::int - 1)::text || '%'
      THEN replace(
        a.title_v1,
        'Tax Year ' || (extract(year from a.due_date::date)::int - 1)::text,
        'Tax Year ' || extract(year from a.due_date::date)::text
      )
      ELSE a.title_v1
    END                                              AS new_title,
    -- H1 period_key fix
    CASE
      WHEN a.title_v1 LIKE '%H1%'
        AND a.old_period_key LIKE
            '%' || (extract(year from a.due_date::date)::int - 1)::text || '-01-01'
      THEN replace(
        a.old_period_key,
        (extract(year from a.due_date::date)::int - 1)::text || '-01-01',
        extract(year from a.due_date::date)::text   || '-01-01'
      )
      ELSE a.old_period_key
    END                                              AS new_period_key
  FROM assembled a
)
-- What will change?
SELECT
  id,
  due_date,
  old_title,
  new_title,
  CASE WHEN old_title <> new_title THEN '✓' END     AS title_fix,
  old_period_key,
  new_period_key,
  CASE WHEN old_period_key <> new_period_key
       THEN '✓' END                                  AS key_fix
FROM corrected
WHERE old_title <> new_title
   OR old_period_key <> new_period_key
ORDER BY due_date;


-- ==========================================================================
-- STEP 2 — APPLY
-- (run only after reviewing Step 1; safe to re-run — WHERE guards no-ops)
-- ==========================================================================

WITH base AS (
  SELECT
    t.id,
    t.title                                          AS old_title,
    t.period_key                                     AS old_period_key,
    t.due_date,
    t.community_id,
    t.customer_id,
    t.service_auto_task_id,
    t.schedule_id,
    t.product_id,
    CASE WHEN t.title LIKE '% — %'
         THEN left(t.title, strpos(t.title, ' — ') - 1)
         ELSE t.title END                            AS raw_name,
    CASE WHEN t.title LIKE '% — %'
         THEN substring(t.title FROM strpos(t.title, ' — ') + 4)
         ELSE '' END                                 AS raw_period
  FROM tax_tasks t
  WHERE t.source     = 'relationship_schedule'
    AND t.archived_at IS NULL
),
resolved AS (
  SELECT
    b.*,
    COALESCE(
      sat.title_i18n->>'en',
      fs.name_i18n->>'en',
      tp.name_i18n->>'en',
      b.raw_name
    ) AS en_name,
    CASE
      WHEN b.raw_period ~ '^Año Fiscal \d{4}$'
        THEN regexp_replace(b.raw_period, '^Año Fiscal (\d{4})$', 'Tax Year \1')
      WHEN b.raw_period ~ '^T[1-4] \d{4}$'
        THEN regexp_replace(b.raw_period, '^T([1-4]) (\d{4})$', 'Q\1 \2')
      WHEN b.raw_period ~ '^Enero \d{4}$'        THEN 'January'   || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Febrero \d{4}$'      THEN 'February'  || substring(b.raw_period FROM 8)
      WHEN b.raw_period ~ '^Marzo \d{4}$'        THEN 'March'     || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Abril \d{4}$'        THEN 'April'     || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Mayo \d{4}$'         THEN 'May'       || substring(b.raw_period FROM 5)
      WHEN b.raw_period ~ '^Junio \d{4}$'        THEN 'June'      || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Julio \d{4}$'        THEN 'July'      || substring(b.raw_period FROM 6)
      WHEN b.raw_period ~ '^Agosto \d{4}$'       THEN 'August'    || substring(b.raw_period FROM 7)
      WHEN b.raw_period ~ '^Septiembre \d{4}$'   THEN 'September' || substring(b.raw_period FROM 11)
      WHEN b.raw_period ~ '^Octubre \d{4}$'      THEN 'October'   || substring(b.raw_period FROM 8)
      WHEN b.raw_period ~ '^Noviembre \d{4}$'    THEN 'November'  || substring(b.raw_period FROM 10)
      WHEN b.raw_period ~ '^Diciembre \d{4}$'    THEN 'December'  || substring(b.raw_period FROM 10)
      WHEN b.raw_period LIKE 'Semana del %'       THEN 'Week of '  || substring(b.raw_period FROM 11)
      ELSE b.raw_period
    END                                              AS en_period
  FROM base b
  LEFT JOIN tax_service_auto_tasks sat ON sat.id = b.service_auto_task_id
  LEFT JOIN tax_filing_schedules fs   ON fs.id  = b.schedule_id
  LEFT JOIN tax_products tp
    ON  tp.id = b.product_id
    AND b.schedule_id IS NULL
    AND b.service_auto_task_id IS NULL
),
assembled AS (
  SELECT
    r.*,
    CASE WHEN r.raw_period = ''
         THEN r.en_name
         ELSE r.en_name || ' — ' || r.en_period
    END AS title_v1
  FROM resolved r
),
corrected AS (
  SELECT
    a.*,
    CASE
      WHEN a.title_v1 LIKE '%H1%'
        AND a.title_v1 LIKE
            '%Tax Year ' || (extract(year from a.due_date::date)::int - 1)::text || '%'
      THEN replace(
        a.title_v1,
        'Tax Year ' || (extract(year from a.due_date::date)::int - 1)::text,
        'Tax Year ' || extract(year from a.due_date::date)::text
      )
      ELSE a.title_v1
    END                                              AS new_title,
    CASE
      WHEN a.title_v1 LIKE '%H1%'
        AND a.old_period_key LIKE
            '%' || (extract(year from a.due_date::date)::int - 1)::text || '-01-01'
      THEN replace(
        a.old_period_key,
        (extract(year from a.due_date::date)::int - 1)::text || '-01-01',
        extract(year from a.due_date::date)::text   || '-01-01'
      )
      ELSE a.old_period_key
    END                                              AS new_period_key
  FROM assembled a
)
UPDATE tax_tasks t
SET
  title      = c.new_title,
  -- Only move the period_key if the target slot is vacant; if a correct
  -- task already exists there (created after the code fix) keep the old
  -- key so the UPDATE doesn't violate the unique index.  You can then
  -- delete this stale duplicate by hand — see the CONFLICTS query below.
  period_key = CASE
    WHEN c.new_period_key = t.period_key THEN t.period_key
    WHEN EXISTS (
      SELECT 1 FROM tax_tasks dup
      WHERE dup.community_id          = t.community_id
        AND dup.customer_id           = t.customer_id
        AND dup.period_key            = c.new_period_key
        AND dup.archived_at IS NULL
        AND dup.id                   <> t.id
    ) THEN t.period_key              -- leave as-is; needs manual cleanup
    ELSE c.new_period_key
  END
FROM corrected c
WHERE t.id = c.id
  AND (t.title <> c.new_title OR t.period_key <> c.new_period_key);


-- ==========================================================================
-- STEP 3 — CONFLICTS  (run after Step 2 to find stale duplicates)
--
-- If any H1 task's period_key could NOT be updated (because the corrected
-- key already existed), this query shows the old stale task next to its
-- newer duplicate.  Delete the stale row (the one with the wrong year in
-- the title).
-- ==========================================================================

SELECT
  old_t.id                          AS stale_task_id,
  old_t.title                       AS stale_title,
  old_t.period_key                  AS stale_period_key,
  old_t.due_date,
  new_t.id                          AS correct_task_id,
  new_t.title                       AS correct_title,
  new_t.period_key                  AS correct_period_key
FROM tax_tasks old_t
JOIN tax_tasks new_t
  ON  new_t.community_id  = old_t.community_id
  AND new_t.customer_id   = old_t.customer_id
  AND new_t.archived_at IS NULL
  AND new_t.id           <> old_t.id
  AND new_t.period_key    = replace(
        old_t.period_key,
        (extract(year from old_t.due_date::date)::int - 1)::text || '-01-01',
        extract(year from old_t.due_date::date)::text             || '-01-01'
      )
WHERE old_t.source        = 'relationship_schedule'
  AND old_t.archived_at  IS NULL
  AND old_t.title         LIKE '%H1%'
  AND old_t.period_key    LIKE
      '%' || (extract(year from old_t.due_date::date)::int - 1)::text || '-01-01'
ORDER BY old_t.due_date;

-- To delete the stale rows found above:
--   DELETE FROM tax_tasks WHERE id IN ('<stale_task_id>', ...);
