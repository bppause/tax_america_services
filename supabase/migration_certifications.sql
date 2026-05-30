-- Add certifications column to tax_products.
-- Run in Supabase SQL Editor.
ALTER TABLE public.tax_products
  ADD COLUMN IF NOT EXISTS certifications jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Seed the CAA certification for the ITIN service.
UPDATE public.tax_products
SET certifications = '["CAA – Certified Acceptance Agent (IRS)", "IRS Authorized – no need to mail original passport"]'::jsonb
WHERE slug = 'itin';
