-- Bookkeeping financial reports (Phase 4n.70).
--
-- Twice-a-year P&L + Balance Sheet that the owner publishes for a
-- bookkeeping customer. Customer never logs in: a per-customer access
-- token is emailed; visiting the URL requires the customer to confirm
-- their email address (Tier 2 magic-link). Reports are stored as
-- structured JSON so we can render a charted dashboard; the original
-- PDFs are attached for reference.
--
-- Safe to apply on any database — `if not exists` everywhere, additive
-- only.

create table if not exists public.tax_financial_reports (
  id              text primary key,
  community_id    text not null references public.communities(id) on delete cascade,
  customer_id     text not null references public.tax_customers(id) on delete cascade,
  period_label    text not null,                  -- "FY2025", "H1 2025", "H2 2024"
  period_start    date not null,
  period_end      date not null,
  cadence         text not null default 'semi_annual'
                  check (cadence in ('semi_annual','annual','quarterly','custom')),
  -- Structured P&L. Shape (loose, owner can extend):
  --   { revenue:{channel:amount,…}, cogs:number, expenses:{category:amount,…},
  --     sales_tax_collected:number, sales_tax_remitted:number, net_income:number }
  pl_data         jsonb not null default '{}'::jsonb,
  -- Structured balance sheet. Shape:
  --   { cash:{name:amount,…}, inventory:number, other_current_assets:number,
  --     fixed_assets:{name:amount,…}, accumulated_depreciation:number,
  --     other_assets:number, current_liabilities:{name:amount,…},
  --     long_term_liabilities:{name:amount,…}, retained_earnings:number,
  --     distributions:number }
  balance_data    jsonb not null default '{}'::jsonb,
  -- Supabase Storage paths to the source PDFs (for the customer to
  -- download from the dashboard). Set when the owner uploads.
  pl_pdf_path     text,
  balance_pdf_path text,
  -- Lifecycle:
  --   draft     — owner is editing, customer cannot see
  --   published — saved, owner has verified, but no email sent yet
  --   sent      — at least one send has fired
  status          text not null default 'draft'
                  check (status in ('draft','published','sent')),
  -- Bumps on every edit-save after the first send. Drives the
  -- "Actualizado el …" indicator on the customer dashboard.
  revision        int not null default 1,
  published_at    timestamptz,
  first_sent_at   timestamptz,
  last_sent_at    timestamptz,
  send_count      int not null default 0,
  prepared_by_email text,
  notes           text not null default '',       -- internal owner notes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tax_financial_reports_customer
  on public.tax_financial_reports(customer_id, period_end desc);
create index if not exists idx_tax_financial_reports_community
  on public.tax_financial_reports(community_id, period_end desc);

alter table public.tax_financial_reports disable row level security;

-- ── Access tokens ─────────────────────────────────────────────────────────
-- One token per customer (not per report) — same URL shows all the
-- customer's historical reports. Stored as sha256(raw) only; the raw
-- token only ever lives in the email body and the URL.
create table if not exists public.tax_report_access_tokens (
  id              text primary key,
  community_id    text not null references public.communities(id) on delete cascade,
  customer_id     text not null unique references public.tax_customers(id) on delete cascade,
  token_hash      text not null unique,
  -- Soft lockout state. When `failure_count` hits a threshold (default
  -- 5) we set `locked_until` and reject confirm attempts until it
  -- passes. Cleared on any successful confirm.
  failure_count   int not null default 0,
  locked_until    timestamptz,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_tax_report_access_tokens_community
  on public.tax_report_access_tokens(community_id);

alter table public.tax_report_access_tokens disable row level security;

-- Per-send delivery log (lightweight; the full Resend webhook events
-- still land in email_delivery_logs).
create table if not exists public.tax_financial_report_sends (
  id              text primary key,
  report_id       text not null references public.tax_financial_reports(id) on delete cascade,
  sent_by_email   text,
  recipient_email text not null,
  resend_id       text,
  -- 'send' for first send, 'resend' for subsequent fires
  kind            text not null default 'send' check (kind in ('send','resend')),
  created_at      timestamptz not null default now()
);

create index if not exists idx_tax_financial_report_sends_report
  on public.tax_financial_report_sends(report_id, created_at desc);

alter table public.tax_financial_report_sends disable row level security;

-- Supabase Storage bucket for the PDF originals. Private (RLS on
-- storage.objects governs). Owner uploads via signed-URL flow; customer
-- downloads via short-lived signed URLs minted by the server.
insert into storage.buckets (id, name, public)
  values ('tax-bookkeeping-pdfs', 'tax-bookkeeping-pdfs', false)
  on conflict (id) do nothing;
