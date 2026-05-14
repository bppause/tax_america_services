# Tax America Services

Web app that runs the practice at [taxamericaservices.com](https://taxamericaservices.com/). Production URL: <https://tax-america-services.onrender.com>.

The app covers the public landing site, the customer portal (filings, documents, messages, signatures), the employee portal (inbox + thread handling), and the practice-owner admin (customers, staff, leads, services, tasks, reminders, audit, settings).

## Stack

- **Backend** — Node 20 + Express, single process. Entry point is `server.js` (a 5-line shim into `server/index.js`); routers live under `server/modules/tax/` and `server/platform/meta/`. Shared helpers under `server/core/`.
- **Frontend** — React 18 + Vite. Entry point is `client/src/main.jsx` → `client/src/tax/TaxApp.jsx`. No router library — `TaxApp` parses `window.location.pathname` and renders one of the `pages/*` views.
- **Database** — Supabase (Postgres). Schema in `supabase/schema.sql`. The server fails requests if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing.
- **Auth** — Firebase Google Sign-In. Customer and employee portals each have their own `AuthProvider` and identity-link endpoint; both validate Firebase ID tokens server-side.
- **Email** — Resend HTTPS API. Outbound through `sendSpanishEmail`; per-event templates with bilingual hardcoded defaults overridable per community in `tax_email_templates`. Inbound webhook (`/api/m/tax/email/inbound`) and delivery webhook (`/api/m/tax/resend/webhook`) update threads + `email_delivery_logs`.
- **Deployment** — Render Blueprint via `render.yaml`. Build: `npm install && cd client && npm install && npm run build`. Start: `node server.js`.

## Repository layout

```
.
├── server.js                          shim → server/index.js
├── server/
│   ├── index.js                       mounts routers + starts tax reminder cron
│   ├── core/                          shared helpers (audit, config, email, roles, …)
│   ├── modules/tax/                   tax product API at /api/m/tax/*
│   └── platform/meta/                 /api/health, /api/version, /api/client-log, /api/branding
├── client/
│   ├── index.html
│   ├── package.json                   vite + react
│   └── src/
│       ├── main.jsx                   error boundary → TaxApp
│       └── tax/                       TaxApp + pages/ + components/ + auth/ + i18n/ + …
├── supabase/
│   └── schema.sql                     production schema (run manually in SQL Editor)
├── render.yaml                        Render Blueprint
├── package.json                       root scripts + server deps
├── CLAUDE.md                          architecture notes for Claude Code sessions
└── docs/                              platform-wide design + roadmap (cross-product)
```

## Local development

```bash
# install
npm install              # server deps
cd client && npm install # client deps
cd ..

# run
npm start                # backend on http://localhost:3001
cd client && npm run dev # vite dev server with HMR, proxies /api → :3001
```

Visit `http://localhost:5173/tax/tax-america-services/portal` to land on the customer portal sign-in.

## Production build

```bash
npm run build   # chains into client/: installs client deps, runs vite build
npm start       # server.js serves the built bundle from client/dist + the API
```

Health check after deploy:

```
GET /api/health
```

## Environment

Copy `.env.example` to `.env` (or configure as Render service env vars). Required for full functionality:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GLOBAL_ADMIN_EMAILS`
- `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `RESEND_INBOUND_SECRET`
- `PUBLIC_APP_URL`
- The six `VITE_FIREBASE_*` vars (compiled into the bundle at build time — redeploy required after changes)

See `.env.example` for the full list with comments.

## Repository history

This repo was forked from `bppause/kai-airbnb-owners-app` and stripped of the Airbnb owners-app surface (listings, incidents, notifications, the SLA cron, and the Airbnb admin UI) so it ships as the tax product only. The companion repo carries the Airbnb code now. Both services historically shared a single Supabase project; that DB is being phased out as the tax app moves to its own project. See `CLAUDE.md` for current architecture notes.
