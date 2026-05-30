-- Run this once in the Supabase SQL Editor to enable AI chat transcript storage.
-- Safe to re-run (IF NOT EXISTS).
ALTER TABLE public.tax_leads
  ADD COLUMN IF NOT EXISTS ai_conversation jsonb;
