# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Install dependencies:**
```bash
npm install              # root (server)
cd client && npm install # frontend
```

**Run locally:**
```bash
# Backend (port 3001):
npm start

# Frontend dev server with HMR (proxies /api to localhost:3001):
cd client && npm run dev
```

**Production build:**
```bash
npm run build   # chains into client/: installs client deps and runs vite build
npm start       # serves built frontend + API from server.js
```

There is no test suite.

**Health check after deploy:**
```
GET /api/health
```

## Architecture

This repo serves a single product: the tax-compliance app at `tax-america-services.onrender.com`. An earlier Airbnb owners app shared this codebase; it was split out into the companion repo `kai-airbnb-owners-app` and removed from here.

**Backend — `server.js` is a 5-line shim** into `server/index.js`, which mounts a small set of routers and starts the tax reminder cron. Routes live in:

- `server/platform/meta/` — `/api/health`, `/api/version`, `/api/client-log`, `/api/branding`.
- `server/modules/tax/` — the entire tax product API mounted at `/api/m/tax/*`, plus `resend-webhook` and `resend-inbound` (raw-body receivers) and the daily `reminders` cron.

`server/core/` holds shared helpers: `audit.js` (auditLog), `config.js` (getAppConfig + community lookup), `email.js` (sendSpanishEmail Resend wrapper), `roles.js` (isGlobalAdmin, isEnvGlobalAdminEmail), `utils.js`, `http.js`. Several exports inside `core/roles.js` and `core/config.js` are leftovers from the Airbnb split — they're still exported but no live code path reaches them. Future cleanup is fine but not required.

`logger.js` is a thin wrapper: `log()` is suppressed in production unless `DEBUG=true`; `warn`/`error` always emit.

**Frontend — `client/src/main.jsx`** is a tiny entrypoint that wraps `client/src/tax/TaxApp.jsx` in a root error boundary that posts to `/api/client-log`. There is no router library; `TaxApp.jsx` parses `window.location.pathname` directly and renders one of its `pages/*` components. URL shapes:

- `/tax` — default community landing.
- `/tax/{community-slug}` — community-specific landing.
- `/tax/{slug}/portal/*` — signed-in customer portal (dashboard, filings, documents, messages, profile, help).
- `/tax/{slug}/employee/*` — practice-side employee portal (inbox, threads, profile, help).
- `/tax/{slug}/owner/*` — practice-owner admin (customers, staff, leads, tasks, settings, audit, …).
- `/tax/_platform/*` — global-admin platform tools (cross-community).
- `/tax/respond/{token}` — magic-link customer response (Phase 1.5).

All client code lives under `client/src/tax/`. The siblings `core/`, `modules/`, `platform/`, `components/`, `enhancers/`, `services/` that earlier carried the Airbnb app no longer exist.

**Database — Supabase only.** There is no local/demo data fallback. The server fails requests if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing. Key tables: `app_users`, `app_config`, `audit_logs`, `email_templates`, `email_delivery_logs`, `communities`, `community_memberships`, `community_config`, plus every `tax_*` table (`tax_customers`, `tax_employees`, `tax_products`, `tax_filing_schedules`, `tax_subscriptions`, `tax_filing_periods`, `tax_email_templates`, `tax_leads`, `tax_tasks`, `tax_relationship_types`, `tax_relationship_faqs`, `tax_help_articles`, `tax_threads`, `tax_thread_messages`, `tax_documents`, `tax_signature_requests`, `tax_employee_customer_assignments`, `tax_impersonation_sessions`, …). The full schema is in `supabase/schema.sql`.

**Auth — Firebase (Google Sign-In only).** Firebase config is injected at vite build time via `VITE_FIREBASE_*` env vars. After sign-in the frontend passes the Google UID and email to server endpoints; the server resolves roles independently. The customer portal and the employee portal use separate `AuthProvider`s in `client/src/tax/auth/` — both Firebase, but the server-side identity-link endpoints differ (`/portal/auth/link` vs `/employee/auth/link`).

## Role model

Two layers, resolved server-side:

- **Platform role** (global) — `getUserRole()` returns `global_admin` when the email matches `GLOBAL_ADMIN_EMAILS` (env precedes DB). All other users default to `user`. Global admins always have full access across communities.
- **Tax-side role** — every community membership exists in `tax_customers` and/or `tax_employees`. The `tax_employees.role` column distinguishes `admin` (practice owner) from `staff` (regular employee). Per-employee permission opt-outs live in `tax_employees.permissions` (JSONB) and are resolved by `server/modules/tax/permissions.js`.

Impersonation (admins acting as another customer or employee) is recorded in `tax_impersonation_sessions` with a 1-hour TTL.

## Key runtime patterns

- **`app_config` table** stores runtime settings loaded by `getAppConfig()` (cached, refreshed on writes). Per-community overrides for the same keys live in `community_config`. After the Airbnb split, most rows here are Airbnb-only and have been removed from `supabase/schema.sql`; the tax module reads its own keys lazily and tolerates missing rows.
- **Tax email templates** have hardcoded bilingual defaults in `server/modules/tax/email-senders.js`, overridable per community via the `tax_email_templates` table. The owner-facing editor lives at `/tax/{slug}/owner/email-templates`. Templates use `{{variable}}` placeholders; variable names ending in `Html` are trusted server-generated HTML and bypass escaping.
- **Resend webhooks** (`/api/m/tax/resend/webhook` and `/api/m/tax/email/inbound`) are mounted **before** `express.json()` so the raw body is available for HMAC signature verification. They live next to the tax router in `server/index.js`.
- **`/api/client-log`** receives frontend error payloads (window errors, unhandled rejections, root error boundary catches) and writes them to Render logs. Errors are also saved to `localStorage` as `kai_last_ui_error` (history-named key; not user-facing).
- **Crons.** The only auto-scheduled job is `server/modules/tax/reminders.js` — daily filing-reminder dispatch, 12h cadence, log-de-duplicated against the Airbnb mirror's copy of the same cron. The `refreshAllRelationshipTasks` task cron in `server/modules/tax/routes.js` is intentionally disabled in this repo; the Airbnb mirror still fires it until that repo is cleaned up. Manual `POST /api/m/tax/admin/tasks/refresh` works either way.

## Environment variables

`VITE_*` variables are compiled into the frontend bundle at build time — changing them requires a redeploy. All other vars are runtime (server-only).

Required for full functionality: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GLOBAL_ADMIN_EMAILS`, `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_APP_URL`, the six `VITE_FIREBASE_*` vars, and (for inbound + delivery tracking) `RESEND_WEBHOOK_SECRET` + `RESEND_INBOUND_SECRET`. See `.env.example` for the full list.

## Deployment

Deployed on Render via `render.yaml`. After a `git push`, use **Manual Deploy → Deploy latest commit** in the Render dashboard unless auto-deploy is on. The build command is `npm install && cd client && npm install && npm run build`; start command is `node server.js`.

Database migrations are run manually by executing `supabase/schema.sql` in the Supabase SQL Editor after pulling a major update. The shared Supabase project that historically backed both products is being phased out; until the tax app moves to its own project, **do not** apply `schema.sql` against the shared DB without coordinating with the Airbnb-mirror session — `schema.sql` describes the desired tax-only end state and has no DROP TABLE statements for the Airbnb tables that still exist in the shared DB.
