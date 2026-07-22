# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

> **This is the real, live Paige Madden Nails app.** If you were looking for a
> Next.js/Stripe/Gemini codebase, that was an old, defunct prototype in a
> *different* folder (`~/Paige Nails` / `Paige-Nails-OLD-prototype`) — ignore it.
> A full technical handoff lives at `~/Downloads/HANDOFF.md`.

## What this is

A two-page **static site** (`index.html` + `admin.html`) on a **Supabase**
backend. **There is no build step, no framework, no `package.json`, no
`node_modules`.** All markup, CSS, and vanilla JS are inline in the two HTML
files. The only runtime dependency is `@supabase/supabase-js@2`, loaded from a
CDN `<script>` tag.

| File | What it is |
|---|---|
| `index.html` | Public customer order flow (multi-step wizard) |
| `admin.html` | Private orders dashboard (email+password login) |
| `vercel.json` | `cleanUrls: true` so `/admin` serves `admin.html` |
| `supabase/migrations/*.sql` | Schema history (8 files) |
| `supabase/functions/buy-shipping-label/` | Deno edge fn — buys the cheapest USPS label via Shippo |
| `supabase/functions/send-order-email/` | Deno edge fn — sends customer status emails via Resend (admin-only) |
| `supabase/functions/send-order-confirmation/` | Deno edge fn — sends the customer's "order received" email on order creation (anon-callable, locked to the `new` template) |
| `supabase/functions/forward-inbound-email/` | Deno edge fn — Resend Inbound webhook; forwards replies to `orders@paigemadden.app` → the Gmail (Svix-verified, `verify_jwt=false`) |
| `*.png`, `*.jpeg`, `favicon.*` | Static assets served from repo root |

## Run / build / deploy

```bash
# Run locally — no install, no build:
python3 -m http.server 4173
# then open http://localhost:4173/index.html  and  .../admin.html

# Deploy: just push to your fork's main. Vercel auto-deploys to paigemadden.app.
git push fork main
```

There is **no lint, no tests, no CI**. Verification is manual, in the browser.
Editing the edge function is separate from the Git/Vercel pipeline:
`supabase functions deploy buy-shipping-label`.

## Ownership / service map (Jeremy's stack, set up 2026-07-22)

```
edit here → git push (fork) → GitHub jmlynarek/Paige-Madden-Nails
                                   │ (Vercel auto-deploy)
                                   ▼
                              Vercel  team jeremy-7274's  →  paigemadden.app
                                   │  supabase-js + publishable key
                                   ▼
                         Supabase  ggvjyzragfxbnsthpvso  (org: idealtraits-jm's Org)
                              Postgres + Auth + Storage(inspiration) + Edge fn
```

- **GitHub:** `jmlynarek/Paige-Madden-Nails` — a fork of `paige-mlynarek/Paige-Madden-Nails` (Paige's original).
  - Local remotes: `origin` = Paige's upstream, `fork` = your own (`jmlynarek`). Push app changes to **`fork main`**.
- **Vercel:** project `paige-madden-nails`, team `jeremy-7274's` (`team_AEihaVaZryzClF14ragMaaAS`). Domain **paigemadden.app** (apex serves; `www` too). Auto-deploys from `fork`'s `main`.
- **Supabase:** project `ggvjyzragfxbnsthpvso`, org `tudcvjaedqloylyxcixo` ("idealtraits-jm's Org"), URL `https://ggvjyzragfxbnsthpvso.supabase.co`.
- **Admin identity:** `jeremy@idealtraits.com` (an Auth user + the `is_admin()` DB gate). This is the login only — it is deliberately *separate* from the customer-facing business identity below.

## Business identity & integrations (set up 2026-07-22)

The customer-facing business runs off a dedicated free Gmail — **`paigemaddennails@gmail.com`** (no hyphens). It owns every external integration. Admin *login* stays `jeremy@idealtraits.com`; everything customers touch is the Gmail / the domain.

- **Order alerts (customer → business):** `index.html` posts each new order to **FormSubmit**, activated and using its **hashed endpoint** (`formsubmit.co/0e620942…`) so the Gmail isn't exposed in page source. Alerts land in `paigemaddennails@gmail.com`.
- **Customer emails (business → customer):** `admin.html` `notifyCustomer()` → the `send-order-email` edge fn → **Resend**. Sends from **`Paige Madden Nails <orders@paigemadden.app>`** with **reply-to `paigemaddennails@gmail.com`**. The `paigemadden.app` domain is **verified in Resend** (DKIM/SPF/MX auto-added to Vercel DNS). Resend account is under the Gmail.
- **Shipping (Shippo):** account under the Gmail. `buy-shipping-label` edge fn is **deployed** and working; currently on a **TEST key** (labels print "SAMPLE – DO NOT MAIL"). Always buys the **cheapest (Standard/Ground Advantage) USPS rate** for every order — rush is a *production*-speed upsell, not a shipping upgrade. Return address = 540 Northshore Ct, Lake Orion, MI 48362.
- **Edge functions live on Supabase** (deploy separately from Git): `buy-shipping-label`, `send-order-email`, `send-order-confirmation`. Deploy via the Supabase MCP `deploy_edge_function` or `supabase functions deploy <name>`. The `ADMIN_EMAIL` gate applies to `buy-shipping-label` + `send-order-email` (`jeremy@idealtraits.com`); `send-order-confirmation` is intentionally **anon-callable** but locked to sending only the `new` template to a given order's own on-file email.

## Config in the HTML (these are the load-bearing constants)

Both HTML files hardcode the Supabase URL + **publishable** key (safe to expose —
RLS makes the public site insert-only; see below). Admin email is hardcoded too.

- `index.html`: `SUPABASE_URL`, `SUPABASE_KEY`, `FORMSUBMIT_ENDPOINT` (hashed → order alerts to the business Gmail), and the pricing constants `SHIP_FEE` (7) / `RUSH_FEE` (10) — **these must match the fee amounts hardcoded in the `create_order` DB function**.
- `admin.html`: `SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_EMAIL`.
- `supabase/functions/*/index.ts`: `ADMIN_EMAIL` gate in both edge functions.

**The admin email is hardcoded in THREE places** — `is_admin()` in the DB,
`ADMIN_EMAIL` in `admin.html`, and `ADMIN_EMAIL` in the edge function. Changing
who can administer means changing all three.

## Database

Tables (all RLS-enabled): `orders`, `order_photos`, `design_tiers`,
`nail_shapes`, `payment_methods`, `notification_templates`.

- **RLS:** `anon` may only INSERT orders/photos and SELECT active reference data;
  it **cannot read orders back**. Admin (`authenticated` + `is_admin()`) reads/manages everything.
- **`public.create_order(...)`** is a `SECURITY DEFINER` RPC — the public site
  calls it to insert an order and get back the `id` + `order_no` (RLS is
  insert-only, so a plain insert can't return the generated number).
- **`PM-###`** order numbers come from sequence `order_no_seq` (was 488; live orders now ~495+ after testing).
- **Pricing / full payment:** checkout collects the **full amount** (not a deposit) = set price **+ `$7` flat shipping** (any ship-to-me order) **+ `$10` rush**, as separate line items. `orders.ship_fee` / `orders.rush_fee` columns store them; `create_order` computes them server-side from fulfillment/speed (migration `add_order_fee_line_items`). Admin `orderValue()` = set price + ship_fee + rush_fee. **Fee amounts ($7/$10) are duplicated in `index.html` and the `create_order` function — keep them in sync** (future: move to an admin Settings table).
- **`is_admin()`** = `auth.jwt()->>'email' = 'jeremy@idealtraits.com'` (pinned `search_path`).
- **Storage:** private bucket `inspiration` (customer photos at `{order_id}/{n}.jpg`),
  with an `anon` INSERT policy and an admin SELECT policy.
- **Realtime:** `public.orders` is in the `supabase_realtime` publication; `admin.html`
  subscribes for live new-order toasts.
- This DB's schema was built by applying the repo's 8 migrations as two Supabase
  migrations (`full_schema_paige_madden`, `storage_inspiration_bucket`).

**Managing the DB:** use the Supabase MCP (`apply_migration` for DDL,
`execute_sql` for reads/one-offs) against project `ggvjyzragfxbnsthpvso`.
**Confirm with the user before any schema change** — it's the live production DB
and there is no staging. NOTE: in some Claude sessions the safety classifier
blocks Supabase **project create/pause/delete** — those must be done by the user
in the dashboard; `apply_migration`/`execute_sql` on an existing project work.

## Secrets (never commit)

The publishable/anon key in the HTML is safe by design. Everything else stays
out of the repo and lives in **Supabase Edge Function secrets** (dashboard →
Edge Functions → Secrets, or `supabase secrets set KEY=value`). Claude does not
set these — the user does. Currently set:

- **Shippo:** `SHIPPO_TOKEN` (test key), `SHIP_FROM_NAME/STREET1/CITY/STATE/ZIP/PHONE/COUNTRY/EMAIL`.
- **Resend:** `RESEND_API_KEY`, `MAIL_FROM` (`Paige Madden Nails <orders@paigemadden.app>`); `MAIL_REPLY_TO` defaults to the Gmail. For inbound forwarding: `RESEND_INBOUND_SECRET` (the webhook's `whsec_…` signing secret; `forward-inbound-email` rejects everything until it's set) and optional `INBOUND_FORWARD_TO` (defaults to the Gmail).
- The Supabase **service-role** key is auto-injected into edge fns (`SUPABASE_SERVICE_ROLE_KEY`) — do not hardcode it.

Note: there is **no Supabase MCP tool for secrets**, and the `supabase` CLI is **not installed** locally — secrets can only be set via the dashboard/CLI by the user. Likewise, **storage objects can only be deleted with the service-role key** (Postgres blocks direct SQL deletes; anon/publishable is denied) — delete via the Supabase Storage dashboard.

## Git / working style

- Push app changes to **`fork main`** → auto-deploys to `paigemadden.app`
  (there is no preview-then-promote; a bad push is live in ~1 min — Vercel
  instant-rollback is the safety net).
- Goal is to **build this out and then teach Paige**. Favor small, legible,
  well-described changes / PRs that double as a teaching surface.
- **Contributing back to Paige's upstream:** her `paige-mlynarek` repo points at
  *her* Supabase. Do NOT include the `SUPABASE_URL`/`SUPABASE_KEY`/`ADMIN_EMAIL`
  changes (this fork's config) in any PR to upstream, or you'd point her live
  site at this database. (Cleaner long-term fix: move that config to Vercel
  environment variables so the codebases can converge.)

## Roadmap

The build plan lives in **`docs/`** (gitignored): the 07/22 meeting transcript,
an LLM-council-ordered sequence (`council-report-*.html` / `council-transcript-*.md`),
and a published to-do artifact. Priority tiers: **P0** make the live checkout
safe → **P1** admin status model (`new→pending`, confirm `completed`) → **P2**
public UX polish (split shape/size, S/M/L size steppers, validation, photo-or-preset)
→ **P3** hardening → **P4** big features (multi-admin, gift cards, AI classic-vs-custom
pricing, booth gallery). Confirmed S/M/L default nail sizes are recorded in Claude memory.

## Status & open items (as of 2026-07-22)

**Working / done this session:**
- Order alerts → business Gmail via activated FormSubmit (hashed endpoint).
- Shipping labels working end-to-end (Shippo edge fn deployed; cheapest/Standard label for all).
- Full-payment pricing with `$7` shipping + `$10` rush line items.
- Customer status emails send via Resend from `orders@paigemadden.app` (domain verified).
- Auto "order received" email to the customer on order creation (new `send-order-confirmation`
  edge fn; `index.html` fires it fire-and-forget after the DB save).
- Reply-to forwarding **live & verified**: replies to `orders@paigemadden.app` now route via
  Resend Inbound → `forward-inbound-email` → the Gmail, Reply-To = the customer. Resend
  Receiving enabled (apex MX `inbound-smtp.us-east-1.amazonaws.com`), webhook on `email.received`,
  `RESEND_INBOUND_SECRET` set. Tested end-to-end (webhook 200, mail delivered).
- Payment handles (Venmo/Zelle/Cash App/Apple Pay) set in admin → Settings.

**Bugs / gaps:**
- **Inbound forwarding v1 doesn't re-attach files:** `forward-inbound-email` forwards the
  message body + Reply-To, but attachment *content* isn't re-attached (the retrieve payload is
  metadata only) — the forward lists filenames and points to the Resend dashboard for originals.
  If customers routinely attach photos to replies, build attachment pass-through (fetch each via
  the Attachments API, base64, include in the send).
- **Deleting an order orphans its inspiration photos** — no storage cleanup / cascade;
  and there's no admin "delete photo" capability (needs a bucket delete policy).
- **Shippo is on a TEST key** — swap to a live key (dashboard) before real shipments.
- **Cash App handle** is still the placeholder `$cashtag`.
- **Admin email hardcoded in 3 places** (`is_admin()`, `admin.html`, edge fns) — blocks multi-admin (P4).
- Anon has over-broad table grants (gated by RLS but worth tightening); Auth leaked-password protection is off.
