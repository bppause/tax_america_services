-- Link bookkeeping reports to the task that triggered them
-- (Phase 4n.72). When a customer is tagged with the bookkeeping
-- service, the auto-task generator creates "Publish H1 / H2
-- Bookkeeping report" tasks. Clicking those tasks opens the report
-- editor with the period pre-filled, and publishing the report
-- auto-completes the task.
--
-- nullable so the existing "+ New report" off-cycle path still
-- works (those reports have no driving task).
alter table public.tax_financial_reports
  add column if not exists task_id text references public.tax_tasks(id) on delete set null;

create index if not exists idx_tax_financial_reports_task
  on public.tax_financial_reports(task_id) where task_id is not null;
