# Tax America Services — User Stories

Standardized user stories grouped by persona. Stories use the form
**"As a *[persona]*, I want to *[action]* so that *[outcome]*."**
and map back to the implemented behavior — anything documented here
has shipping code today. Stories tagged **`PLANNED`** are referenced
from CLAUDE.md or the schema but aren't user-facing yet.

For the runtime / architecture context behind any story, see
[`CLAUDE.md`](../../../CLAUDE.md).

---

## Personas

| Persona | Where they sign in | What gates access |
|---|---|---|
| **Visitor / Prospect** | none (public) | n/a — `/tax/{slug}` |
| **Lead** | none | submits the public contact form; row in `tax_leads` |
| **Customer** | `/tax/{slug}/portal` | Firebase identity linked to a `tax_customers` row |
| **Staff** | `/tax/{slug}/employee` | `tax_employees.role = 'staff'` |
| **Owner / Admin** | `/tax/{slug}/employee` | `tax_employees.role = 'admin'` |
| **Platform Admin** | `/tax/_platform` | email listed in `GLOBAL_ADMIN_EMAILS` |

Two layers resolve server-side on every request: the **platform role**
(`global_admin` vs `user`) and the **tax-side role** within a community
(`admin` vs `staff`). See `server/core/roles.js` and the role
breakdown in [`CLAUDE.md`](../../../CLAUDE.md).

---

## 1. Visitor / Prospect (public landing page)

Goal: learn what the practice does, pick a service, take an action.

- As a visitor, I want to land on a branded community page at
  `/tax/{slug}` so I see who I'm dealing with and what services they
  offer.
- As a visitor, I want the page to switch between English and Spanish
  so I can read it in my own language; the choice should persist
  across visits via a saved preference.
- As a visitor, I want a sticky header nav (Services / Team / Schedule
  / FAQs / About / Contact) with a hamburger drawer on mobile so I
  can jump between sections without scrolling.
- As a visitor, I want to browse the practice's services as cards
  with short summaries so I can scan quickly, and open one to read
  the full description, required documents, and an optional video.
- As a visitor, I want to click "Request this service" on a service
  card to drop me into the contact form with that service already
  selected so I don't have to re-pick.
- As a visitor, I want to read the Meet-the-team section to see who
  works at the practice — name, photo, role chip, short bio, plus
  any Experience / Education / Highlights the owner has published.
- As a visitor, I want to skim FAQs and Articles published by the
  practice so my common questions are answered before I have to ask.
- As a visitor, I want a "Schedule a call" CTA in the Hero (when the
  practice has Calendly configured) and a parallel "Schedule" tab in
  the **Get started** section that pops the Calendly widget on
  click, so booking is one tap from anywhere on the page.
- As a visitor, I want a parallel "Send a message" form in the
  **Get started** section that captures first / middle (optional) /
  last name, email, **required phone**, optional WhatsApp, company,
  service chips, and a free-text message so I can express intent
  without booking a call.
- As a visitor, I want the Contact section to display address,
  phone, WhatsApp link, and an embedded Google Maps card so I can
  reach the practice however I prefer.
- As a visitor, I want the page hero, button labels, section
  headings, and Get-started copy to reflect whatever the owner
  customized in **Public Home Page copy** so each practice can put
  its own voice on the page.

## 2. Lead

A lead is a contact-form submission, owned by the practice.

- As a lead, my submission should produce a `tax_leads` row with
  status `new` and notify the practice via email (when team email
  for "New lead" is enabled).
- As a lead, I shouldn't see a separate confirmation screen — the
  form should swap to a success message ("we'll respond within one
  business day") in place.
- As a lead, my Spanish-locale submission should preserve language
  so the practice's reply uses Spanish.

## 3. Customer

Customers sign in to `/tax/{slug}/portal` to track work, share
documents, message the practice, and respond to magic-link
reminders. The portal is **gated by community setting** — when
disabled, every outbound email links to the public landing page
instead.

### Authentication

- As a customer, I want to sign in with Google or with email /
  password (Firebase) so I can use whichever credential I already
  have.
- As a customer landing here from a welcome email, I want the email
  field pre-populated (via `?email=`) and the right tab pre-selected
  (`?mode=create` for brand-new users) so I never type my email
  twice.
- As a customer landing on the staff portal by mistake (or vice
  versa), I want a "Go to the correct portal →" CTA in the sign-in
  error block so I'm not stuck.
- As a customer, I want a first-time hint card explaining that I
  can sign in with Google **or** set a password — both paths land
  me in the same account.

### Portal experience

- As a customer, I want a dashboard showing my filings, recent
  documents, recent messages, and any signature requests so I see
  the whole engagement in one place.
- As a customer, I want to view each filing's status (pending /
  in-progress / filed) and the dates that drive it.
- As a customer, I want to respond to a magic-link reminder
  (`/tax/respond/{token}`) without signing in — confirming I've
  sent the requested documents.
- As a customer, I want to **upload documents** (statements, IDs,
  prior returns) to the portal when the owner has the feature
  enabled, with a 25 MB / per-file cap and the standard image / PDF
  / Office MIME allowlist.
- As a customer, I want to **download documents** my practice
  shared with me via signed URLs that expire after 5 minutes.
- As a customer, I want to **message the practice** on threaded
  topics and see their replies show up here (with optional email
  notification when enabled).
- As a customer, I want to **sign a signature request** by typing
  my legal name + clicking "I agree", with my name, IP, and
  timestamp recorded for ESIGN-Act compliance.
- As a customer, I want to **manage my notification channels**
  (email, in-portal) when the owner allows it. When the owner has
  notification preferences locked, the option is hidden.
- As a customer, I want to **edit my profile** — name parts,
  phone, WhatsApp, business name, preferred email, locale — so the
  practice always has my current info.
- As a customer, I want to browse practice-specific **Help
  articles** and **FAQs** filtered to my services.

## 4. Staff (employee, non-admin)

Staff sign in to `/tax/{slug}/employee` and only see customers
explicitly assigned to them. The Customer-access scope is surfaced
on the Staff list as a pill ("N assigned") next to each row, with
a red "No customers assigned" warning when zero.

### Account & profile

- As a staff member, I want to receive a welcome email when an
  admin adds me with a one-click link to finish setup; the email
  pre-fills my address and gives me the Google vs password choice.
- As a staff member, I want a **Resend welcome email** affordance
  on my row (and on my detail page) so my admin can re-prod me
  without leaving the Staff page.
- As a staff member, I want to edit my own profile + notification
  channels, and optionally publish a public profile (photo, role
  chip, bio, highlights, education, experience) that surfaces on
  the public Meet-the-team section when the owner opts me in.
- As a staff member, I want a one-click profile photo upload that
  PUTs the image directly into a public Supabase Storage bucket
  (no bytes through Node), 5 MB max, JPG / PNG / WEBP / GIF.

### Work surface

- As a staff member, I want a **dashboard** with my urgent tasks,
  recent leads (if I have lead-management permission), and quick
  status of my assigned customers.
- As a staff member, I want a **Customers** list filtered to those
  I'm assigned to, sortable by last name (default) or first name,
  with alphabetic letter grouping that follows the sort key.
- As a staff member, I want to **see a customer's detail** — their
  service relationships, documents, tasks, messages, signature
  requests, audit trail — for any customer I'm assigned to.
- As a staff member, I want to **message a customer** on a thread,
  upload a document for them, request a signature, and view what
  they've responded.
- As a staff member, I want a **Tasks** workspace with four views
  — List, Periods, Calendar (month grid with today + day-1 month
  prefix), and Kanban Board — and the same hover popover on every
  surface (via the shared `TaskHover` component, portaled to
  `document.body` so column overflow never clips it).
- As a staff member, I want to filter tasks by status / priority /
  owner / service / customer / due date, save the filter state, and
  toggle "My tasks" to see only what's assigned to me.
- As a staff member, I want to **edit a task in place** (status
  dropdown on the row, drag to a new Kanban column) or open the
  full edit modal by clicking the row title (`?edit=<id>` jumps
  to it from any other page that links there).
- As a staff member, I want **a closing note prompted at the
  moment of completion** — server returns
  `notes_required_on_complete` if I forget; client preemptively
  prompts via `window.prompt` so the trip never has to fail.
- As a staff member, I want to receive an **email notification
  when a task is assigned to me** (when team-side toggle is on)
  with a deep link to the edit modal.
- As a staff member, **I cannot delete a task** — only admins can.
  The × / Delete button is hidden for me in the UI; the server
  refuses with `task_delete_admin_only`.

## 5. Owner / Admin (in addition to all Staff stories)

Admins (`tax_employees.role = 'admin'`) see every customer in the
community and run the practice's configuration. Granular powers
can be revoked per-admin via `tax_employees.permissions`.

### Inbox & lifecycle

- As an admin, I want a **Leads inbox** that filters to Open /
  Converted / Closed / All so I can triage incoming requests
  without scrolling.
- As an admin, when I receive a new-lead email I want to land on
  the inbox with the matching row pre-expanded and ringed
  (`?lead=<id>`) so the email doesn't dump me at the top of a list.
- As an admin, I want to **convert a lead to a customer** in one
  click — the lead's name parts, email, phone, WhatsApp, company,
  locale, and message all carry over to the new
  `tax_customers` row.
- As an admin, I want to **close a lead with a reason** from a
  preset list (not interested / no response / duplicate / out of
  scope / spam / other) plus an optional note so we have a record
  of why this lead didn't convert.
- As an admin, I want to **add a customer manually** or **import a
  batch via CSV** with name parts, email, phone, WhatsApp,
  business name, address, preferred email, locale, services, and
  notes — sending a welcome email by default (when customer
  welcome email is enabled).
- As an admin, I want to **archive a customer** (soft delete,
  keeps history) and restore them later.
- As an admin, I want to **promote a customer to staff** so a
  dual-role person can log in to both portals with one identity.

### Staff management

- As an admin, I want to **add a staff or admin member** with an
  optional welcome email; the email pre-fills their address +
  picks the right sign-in tab.
- As an admin, I want to **archive / restore a staff member** with
  archived staff appearing in a separate collapsible "Archived
  staff" card on the Staff page.
- As an admin, I want to **see customer-access scope at a glance**
  for every staff row — "Sees all customers" pill for admins,
  "N assigned" for staff, red "No customers assigned" when a staff
  row has zero — with a blue banner at the top of the page
  explaining the access model.
- As an admin, I want to **manage individual permissions** for
  each staff member from their detail page (revoke specific powers
  like manage_settings / manage_leads / send_reminders /
  manage_email_templates / view_audit_logs / manage_employees).
- As an admin, I want to **impersonate a customer or employee** to
  reproduce a support issue or verify a permission change. Active
  impersonation expires after 1 hour and is recorded in
  `tax_impersonation_sessions`.
- As an admin, I want to **manage staff customer assignments** as
  a unified roster with bulk-save (no per-row API call per click).

### Tasks at scale

- As an admin, I want to **bulk update** tasks (status, priority,
  owner) across many rows, with the bulk-complete path refused
  server-side so every closed task carries a meaningful note.
- As an admin, I want to **manually trigger** the task-generation
  cron (`/admin/tasks/refresh`) without waiting for the daily run.
- As an admin, **only I can delete a task.** Staff can complete or
  reassign; deletion is admin-only.
- As an admin, I want **stronger task cleanup when a relationship
  ends** — removing a service from a customer (or deleting an
  auto-task template from a service) drops every open task tied to
  the removed link. Completed tasks survive for history.

### Service catalog & workflows

- As an admin, I want to **manage services** (`tax_products`) —
  name, description, long description, required documents, video,
  icon, cadence — surfaced on the public landing page.
- As an admin, I want to **manage relationship types** (the
  service tags applied to a customer) — name, category (business
  / individual / general / audit), and order.
- As an admin, I want to **define auto-tasks per service** with
  cadence (none / weekly / monthly / quarterly / annual), anchor
  rule, default priority, and a default assignee. Adding a new
  auto-task fan-outs immediately to every customer tagged with the
  service (no waiting for the daily cron).
- As an admin, I want a **catalog of richer task title
  suggestions** per service in the Add Task UI so I don't retype
  the same common items.
- As an admin, I want to **manage filing schedules**
  (`tax_filing_schedules`) and the reminder cadence per workflow.

### Email + notification controls

- As an admin, I want a **single hub for every automatic email
  the practice sends**, grouped under Owner Settings → Email
  notifications.
- As an admin, I want **Customer email notifications** — per-type
  toggles (Welcome / Document uploaded / Message reply /
  Signature request) plus a master kill-switch. All default OFF
  so a fresh community doesn't surprise its first customers.
- As an admin, I want **Team email notifications** — per-type
  toggles (New lead / Task assigned / Customer messaged practice /
  Signature signed / Staff welcome) plus a master kill-switch.
  All default ON so existing tenants keep current behavior.
- As an admin, when I flip the master switch off, per-type rows
  should dim with a "Paused" badge so I see my saved config but
  can't accidentally toggle individual rows mid-pause.
- As an admin, I want **filing-reminder emails to customers** as
  a separate toggle (separate from the per-type customer
  notifications), default off, that gates the daily reminder cron.
- As an admin, I want to **edit email-template subject + intro**
  per (template_key, lang) so the practice's voice carries through
  to every outbound. Structural content (bullets, footers, CTAs)
  stays hardcoded.
- As an admin, I want to **preview an email template** with sample
  data before saving, and **reset** any override back to the
  platform default.
- As an admin, I want to **manually resend a welcome email** to
  any customer or staff member — that path always works regardless
  of the per-type toggles.

### Public site configuration

- As an admin, I want to **edit my community contact info**
  (phone, WhatsApp, contact email, address, default locale) and a
  **Calendly URL** — the public landing page + scheduler section
  update accordingly.
- As an admin, I want to **edit the Public Home Page copy** —
  Hero subtitle + button labels, section headings (Services /
  Team / Articles / FAQs), Get-started card titles + bodies +
  CTA label, About heading + body — in both English and Spanish,
  with every input pre-filled with the current text so I just
  tweak what I want.
- As an admin, I want a **"Reset to default"** button per row when
  my copy differs from the bundled default so I can revert without
  retyping.

### Tasks workflow tuning

- As an admin, I want to **configure the task lookahead window**
  (1–24 months) and **urgency thresholds** (urgent / soon days).
- As an admin, I want to **override priority and urgency colors**
  per community. Defaults are tuned so overdue (deep crimson) and
  urgent (bright red) are visually distinct — but I can pick my
  own.
- As an admin, I want to **manage task status options** — add,
  rename, recolor, reorder, mark terminal (auto-stamps
  `completed_at`).

### FAQs & help articles

- As an admin, I want to **publish help articles** (with optional
  video) per audience (customer / owner) — surfaced on the public
  landing page and inside the portal / staff portal.
- As an admin, I want to **manage FAQs grouped by relationship
  type** — each public landing page reads its effective FAQ set
  for the practice.

### Audit & operations

- As an admin (with `view_audit_logs` permission), I want to see
  the **audit log** for every action that touched a row — entity
  ID, actor, before/after, timestamp.
- As an admin, I want to **toggle the customer portal entirely on
  or off** — when off, all email links route to the public
  landing page instead.
- As an admin, I want to **toggle customer document uploads** so
  the Documents page in the portal is gated and uploads are
  refused server-side when off.

## 6. Platform Admin (cross-community)

Platform admins live above any single community — global emails
listed in `GLOBAL_ADMIN_EMAILS` (env precedes DB).

- As a platform admin, I want to sign in at `/tax/_platform` with
  Google and see a cross-community dashboard.
- As a platform admin, I want to **create a new community**
  (provision a new tax practice) with the starter seed (status
  options, sample articles/FAQs) applied automatically.
- As a platform admin, I want to **list all communities** with
  their key metrics (customer count, lead count, last activity).
- As a platform admin, I always retain **full admin access** to
  every community without being added as an employee.

---

## Cross-cutting story themes

These describe behavior that spans personas and isn't pinned to
one page.

- **Bilingual by default.** Every customer-facing surface is en/es,
  picked from saved preference → community `default_locale` →
  platform fallback (`es`). Owner-authored content (service names,
  taglines, FAQ bodies, articles) lives as `{en, es}` JSONB so
  switching language updates user-supplied copy too.
- **Soft-delete everywhere.** Archiving (customer, staff,
  relationship) preserves history; restore flips a status back.
  Real DELETE is reserved for `tax_tasks` (with the strict
  open-only cleanup rule) and admin-only task deletion.
- **Audit-logged writes.** Every meaningful mutation lands a row in
  `audit_logs` with entity, action, actor, and before/after diff.
- **Magic links over re-auth.** Customer "I sent the docs" responses
  go through `/tax/respond/{token}` so the customer doesn't have to
  sign in for a quick acknowledgment.
- **Email never blocks.** Every email send is best-effort behind a
  try/catch; a misconfigured Resend doesn't fail the underlying
  HTTP request.
- **Defaults that match intent.** Customer emails default OFF
  (don't surprise customers); team emails default ON (don't
  silently break existing tenants); portal/documents/reminders
  default OFF (owner opts in when ready).

---

## Story-to-code map (high-traffic entry points)

| Story area | Server entry | Client entry |
|---|---|---|
| Public landing | `GET /api/m/tax/community/:slug`, `…/team`, `…/articles`, `…/faqs` | `client/src/tax/pages/Landing.jsx` |
| Lead submission | `POST /api/m/tax/leads` | `client/src/tax/components/LeadForm.jsx` |
| Customer portal | `GET /api/m/tax/portal/me` + scoped resources | `client/src/tax/pages/Portal*.jsx` |
| Staff portal | `GET /api/m/tax/employee/me` + scoped resources | `client/src/tax/pages/Employee*.jsx` |
| Owner — customers | `/api/m/tax/admin/customers*` | `OwnerCustomers.jsx`, `OwnerCustomerDetail.jsx` |
| Owner — staff | `/api/m/tax/admin/employees*` | `OwnerStaff.jsx`, `OwnerStaffDetail.jsx` |
| Owner — leads | `/api/m/tax/admin/leads*` | `OwnerLeads.jsx` |
| Owner — tasks | `/api/m/tax/admin/tasks*` | `OwnerTasks.jsx` |
| Owner — settings | `/api/m/tax/admin/community-settings*` | `OwnerSettings.jsx` |
| Owner — site copy | `/api/m/tax/admin/community-settings/landing-copy` | `OwnerSettings.jsx → LandingCopySection` |
| Email | `server/modules/tax/email-senders.js` | n/a |
| Daily cron | `server/modules/tax/reminders.js` | n/a |

---

*This document mirrors features shipped on the
`claude/collapsible-employee-profiles-h23Aj` branch and merged to
`main`. When a new feature ships, add the story here so the doc
stays a living reference.*
