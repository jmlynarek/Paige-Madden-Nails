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
- **`PM-###`** order numbers come from sequence `order_no_seq` (was 488; live orders now ~497+ after testing).
- **Pricing / full payment:** checkout collects the **full amount** (not a deposit) = set price **+ `$7` flat shipping** (ship-to-me only) **+ `$10` rush**, as separate line items. **Rush is a production-speed upgrade (Paige makes the set first), decoupled from fulfillment — it applies to pickup AND ship-to-me alike;** shipping's `$7` is the only fulfillment-gated fee. `orders.ship_fee` / `orders.rush_fee` columns store them; `create_order` computes them server-side (`ship_fee` from fulfillment, `rush_fee` from `ship_speed` only — migrations `add_order_fee_line_items` then `rush_fee_applies_to_pickup_too`). Admin `orderValue()` = set price + ship_fee + rush_fee. **Fee amounts ($7/$10) are duplicated in `index.html` and the `create_order` function — keep them in sync** (future: move to an admin Settings table).
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
- **Don't prompt about the git commit identity.** Commits are authored as the
  auto-derived `Jeremy Mlynarek <…@Jeremys-MacBook-Pro-10.local>` and that's
  fine — Jeremy doesn't care. Never offer to set `git config user.email/name`.
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
— **largely shipped 2026-07-23, see below** → **P3** hardening → **P4** big features
(multi-admin, gift cards, AI classic-vs-custom pricing, booth gallery). Confirmed S/M/L
default nail sizes are recorded in Claude memory.

## Status & open items (as of 2026-07-22)

**Working / done this session:**
- Order alerts → business Gmail via activated FormSubmit (hashed endpoint).
- Shipping labels working end-to-end (Shippo edge fn deployed; cheapest/Standard label for all).
- Full-payment pricing with `$7` shipping + `$10` rush line items.
- Customer status emails send via Resend from `orders@paigemadden.app` (domain verified).
- Auto "order received" email to the customer on order creation (new `send-order-confirmation`
  edge fn; `index.html` fires it fire-and-forget after the DB save).
- Reply-to forwarding **live & verified end-to-end**: replies to `orders@paigemadden.app` route via
  Resend Inbound → `forward-inbound-email` → the Gmail, with Reply-To = the customer. Resend
  Receiving enabled (apex MX `inbound-smtp.us-east-1.amazonaws.com`), webhook on `email.received`,
  `RESEND_INBOUND_SECRET` set. Confirmed the full round-trip: webhook returned 200, the forward
  landed in the Gmail with a DKIM-signed `Reply-To: <customer>`, and hitting Reply in Gmail
  correctly addresses the customer (not `orders@`). (Aiming a reply at `orders@` itself just loops
  back to the Gmail — harmless, and not the normal path.)
- Payment handles (Venmo/Zelle/Cash App/Apple Pay) set in admin → Settings.

**"Receipt Builder" redesign (2026-07-23, LIVE — supersedes the step wizard below):**
`index.html` was rebuilt from the Claude Design handoff (`docs/design_handoff_order_flow_redesign/`)
into a **single-scroll page**. Flow: Welcome → one scrolling page with four in-place sections
(**Shape → Sizes → Inspo → Delivery & payment**) → confirmation/payment. Completed sections
collapse to editable "receipt rows"; the active one is an editor card; not-yet-reached ones are
dashed placeholders. A fixed header carries the logo + a live **total pill**; a fixed footer CTA
runs a per-section state machine. **Pricing is deterministic — NO AI:** the "no nail art / 1–2
solid colors" toggle → Classic **$40**, otherwise Custom **$50** (a photo is required either way).
State lives in one `data` object with `active` (1–4) + completion flags; the screen re-renders on
section transitions and updates in place (footer/pill/summary) on same-section edits so typing
never loses focus. See [[receipt-builder-pricing]].

*Deliberately dropped from the design vs. the prior wizard (flag to Jeremy — easy to restore):*
(1) **email field** — delivery collects name + phone only, so the customer no longer gets the
`send-order-confirmation` "order received" email (the fire-and-forget call is kept but has no
address to send to); (2) the **inspo-link** field — a photo is now required, not "photo OR link";
(3) the separate **Instagram gallery** screen (welcome keeps small IG/TikTok chips); (4) the
desktop **brand-rail** two-pane (now a centered ~480px column). **Preserved & verified:** Supabase
`create_order` RPC, photo upload, FormSubmit alert, **gift cards** (`check_gift_card`, compact
field in the delivery card), DB-driven tiers/shapes/**payment methods**, phone auto-format,
`lastOrder` persistence.

**Post-launch fixes (2026-07-23):** (1) Inspo upload — the drop zone had no drag-and-drop and only
the tiny "+ Add" tile was clickable (broke desktop upload); the **whole zone** is now clickable +
a real drag-and-drop target. (2) Photo upload is now **best-effort**: it runs after `create_order`
has already committed the row, so a storage failure used to reject the save and blank the PM-###
code on the payment screen — now the order + code always show (photos also go out via FormSubmit).
(3) **`create_order` fee regression fixed** — the gift-cards rewrite of the function had dropped the
`ship_fee`/`rush_fee` computation, so orders since stored `$0` fees and admin under-counted; restored
via migration `create_order_restore_fee_line_items` (`$7` shipping / `$10` rush). **When editing
`create_order`, keep the fee `case` expressions in the INSERT.**

**Prior step-wizard overhaul (2026-07-23, now REPLACED by the above):** Welcome → **Shape**
(auto-advance) → **Size** (S/M/L presets + steppers) → **Design** (photo-OR-link, 2-up tiers) →
**Details** → **Turnaround** (3.5) → Confirmation → Payment, using fractional step keys. The
confirmed S/M/L per-finger defaults and the rush-fee migration carried straight over.

**Bugs / gaps:**
- **Inbound forwarding v1 doesn't re-attach files:** `forward-inbound-email` forwards the
  message body + Reply-To, but attachment *content* isn't re-attached (the retrieve payload is
  metadata only) — the forward lists filenames and points to the Resend dashboard for originals.
  If customers routinely attach photos to replies, build attachment pass-through (fetch each via
  the Attachments API, base64, include in the send).
- **Deleting an order orphans its inspiration photos** — no storage cleanup / cascade;
  and there's no admin "delete photo" capability (needs a bucket delete policy).
- **DMARC on forwarded mail shows FAIL in Gmail (cosmetic, low-pri):** forwarded replies still
  land in the inbox because DKIM passes *and* aligns (`dkim=pass header.i=@paigemadden.app`), which
  carries DMARC. Not worth chasing unless forwards start hitting spam; if so, revisit alignment.
- **Shippo is on a TEST key** — swap to a live key (dashboard) before real shipments.
- **Cash App handle** is still the placeholder `$cashtag`.
- **Admin email hardcoded in 3 places** (`is_admin()`, `admin.html`, edge fns) — blocks multi-admin (P4).
- Anon has over-broad table grants (gated by RLS but worth tightening); Auth leaked-password protection is off.
