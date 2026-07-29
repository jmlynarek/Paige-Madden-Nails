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
| `supabase/functions/create-checkout-session/` | Deno edge fn — creates a hosted Stripe Checkout session for one order (anon-callable; amount computed server-side from the order row) |
| `supabase/functions/stripe-webhook/` | Deno edge fn — Stripe webhook; marks the order payment_collected + sends the payment_verified email (Stripe-signature-verified, `verify_jwt=false`) |
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
- **Card payments (Stripe, added 2026-07-25):** hosted Stripe Checkout as an ADDITIVE option next to the P2P handles (which are untouched). Flow: the order-submitted screen shows a "Pay by card" tile (only when enabled) → `create-checkout-session` edge fn computes the amount due server-side (set + fees − gift credit; never trusts the client) and redirects to Stripe's hosted page (cards + Apple Pay + Cash App Pay) → Stripe calls the `stripe-webhook` edge fn (HMAC-verified, fails closed, idempotent) → `payment_collected=true / paid_at / paid_via='stripe'` + the `payment_verified` email server-side (third copy of the shared email shell — keep in sync with admin.html + send-order-confirmation). **Gift purchases too (2026-07-25):** the "Send a gift" confirmation gets the same tile; `create-checkout-session` takes `{ gift_ref }` (PMG-###) and prices face value + ship_fee, the webhook's `metadata.gift_id` branch stamps `gift_cards.paid_at / paid_via='stripe'` but the card **stays `pending`** (migration `0019_stripe_gift_payments`) — Paige's "Issue & send" remains the single action that releases the code/emails/shipment order; the pending-gift row + drawer show a green "Paid · card" state instead of the money-check homework. Config lives in **admin → Integrations → "Payments · Stripe"**: a guided 4-step "Set Up Stripe" card (account → `sk_` key → webhook URL + `whsec_` → toggle on + `4242…` test), steps check themselves off, badge shows test vs live. Keys in `app_settings` (`stripe_enabled`/`stripe_secret_key`/`stripe_webhook_secret`, migration `0018_stripe_checkout`) with env fallbacks `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`. The public site learns card checkout is on via the `payment_methods` row `id='card'` (anon-readable; `saveIntegrations()` syncs its `enabled` = toggle on AND key present). Card payers can skip the PM-### memo — matching is automatic via order-id metadata. **Status: LIVE in TEST mode, verified end to end 2026-07-25** (sandbox account under the Gmail; test order PM-523 paid with 4242 → webhook 200 → auto-collected + payment_verified email). **Before real money: repeat Integrations steps 2-3 with live values (`sk_live_` key + a live-mode webhook destination's `whsec_`).** Stripe return trip: `/?paid=1&code=PM-###` shows a "Payment received" screen (`lastOrder.paid` persists it); the redirect is cosmetic only — money is only ever marked by the webhook.
- **Shipping (Shippo):** account under the Gmail. `buy-shipping-label` edge fn is **deployed** and working; currently on a **TEST key** (labels print "SAMPLE – DO NOT MAIL"). Always buys the **cheapest (Standard/Ground Advantage) USPS rate** for every order — rush is a *production*-speed upsell, not a shipping upgrade. Return address = 540 Northshore Ct, Lake Orion, MI 48362. **The Shippo key + return address are now admin-editable in the `admin.html` → Integrations tab** (stored in `app_settings`; see below); the edge fn reads those and falls back to the env secrets when they're blank, so swapping test→live no longer needs the dashboard.
- **Edge functions live on Supabase** (deploy separately from Git): `buy-shipping-label`, `send-order-email`, `send-order-confirmation`. Deploy via the Supabase MCP `deploy_edge_function` or `supabase functions deploy <name>`. The `ADMIN_EMAIL` gate applies to `buy-shipping-label` + `send-order-email` (`jeremy@idealtraits.com`); `send-order-confirmation` is intentionally **anon-callable** but locked to sending only the `new` template to a given order's own on-file email.

## Config in the HTML (these are the load-bearing constants)

Both HTML files hardcode the Supabase URL + **publishable** key (safe to expose —
RLS makes the public site insert-only; see below). Admin email is hardcoded too.

- `index.html`: `SUPABASE_URL`, `SUPABASE_KEY`, `FORMSUBMIT_ENDPOINT` (hashed → order alerts to the business Gmail), and the pricing constants `SHIP_FEE` (7) / `RUSH_FEE` (10) — **these must match the fee amounts hardcoded in the `create_order` DB function**.
- `admin.html`: `SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_EMAIL`.
- `supabase/functions/*/index.ts`: `ADMIN_EMAIL` gate in both edge functions.

**Admin access is now a table-driven allowlist** (`public.admin_users`, migration
`0016_admin_users.sql`) — managed from admin's **Users Management** tab. Anyone in
the table has the *same*, full access (no roles). `is_admin()` passes for an
`approved` row **OR** the bootstrap owner literal `jeremy@idealtraits.com`, which
stays wired into `is_admin()` (DB) + `claim_admin_access()` (DB) + `ADMIN_EMAIL`
in `admin.html` (login seed + owner tag) as a permanent fail-safe so the owner can
never be locked out. The two gated edge functions (`send-order-email`,
`buy-shipping-label`) now call the `is_admin()` RPC instead of comparing to a
literal, so any approved admin can send emails / buy labels. Lifecycle:
invite → `invited` (Supabase invite email from the `invite-admin` edge fn) →
invitee sets a password → auto-flips to `approved` on first sign-in via
`claim_admin_access()`. **Invite email delivery uses Supabase Auth SMTP — point it
at Resend in the dashboard for reliability (the built-in sender is rate-limited).**

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
- **`is_admin()`** (migration `0016`) = owner literal `jeremy@idealtraits.com` **OR** an `approved` row in `public.admin_users`. Now `SECURITY DEFINER` (it reads `admin_users` and runs inside other tables' RLS, so a definer read avoids recursion/lockout); pinned `search_path=''`. Companion `claim_admin_access()` (definer) approves an invited caller on first sign-in and gates the client. See the Users Management note above.
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

- **Shippo:** `SHIPPO_TOKEN` (test key), `SHIP_FROM_NAME/STREET1/CITY/STATE/ZIP/PHONE/COUNTRY/EMAIL`. **These are now fallbacks:** the Integrations tab writes `shippo_api_key` / `shippo_enabled` / `ship_from_*` into `app_settings`, and `buy-shipping-label` prefers those per-field, using the env secret only when the DB value is blank (migration `0016_integrations_settings`). The key is stored as `app_settings.value` (readable by the authenticated admin via RLS) rather than a true secret — an accepted trade-off for in-UI editing.
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
into a **single-scroll page**. Flow: Welcome → one scrolling page with five in-place sections
(**Info → Shape → Sizes → Inspo → Delivery & payment**) → confirmation/payment. Completed sections
collapse to editable "receipt rows"; the active one is an editor card; not-yet-reached ones are
dashed placeholders. A fixed header carries the logo + a live **total pill**; a fixed footer CTA
runs a per-section state machine. **Pricing is deterministic — NO AI:** the "no nail art / 1–2
solid colors" toggle → Classic **$40**, otherwise Custom **$50** (a photo is required either way).
State lives in one `data` object with `active` (1–5) + completion flags; the screen re-renders on
section transitions and updates in place (footer/pill/summary) on same-section edits so typing
never loses focus. See [[receipt-builder-pricing]]. **The section count/numbers are hardcoded in
several coupled places — `nextIncomplete`, `buildSections`, `computeFooter`, `cardHead` ("N of 5"),
`paintPill` (total shows on the last section), the `receiptRow` kind→number map, and `reorder.html`'s
handoff blob + `STORAGE_KEY` — so adding/reordering a section means re-numbering all of them and
bumping `STORAGE_KEY` (currently `pmn-order-v3`) so stale carts don't mis-map.** See [[info-section-added]].

*Deliberately dropped from the design vs. the prior wizard (flag to Jeremy — easy to restore):*
(1) ~~**email field**~~ — **RESTORED. The email field was re-added and the "order received"
email works end-to-end** (`data.email` → `create_order` `p_email` → `send-order-confirmation`
reads it from the order row → Resend; the `new` template is enabled). As of **2026-07-25** contact
capture is its own **Info** step 1 (name/phone/email, required) — see [[info-section-added]]. *Do not
trust older claims that this email is broken.* (2) the **inspo-link** field — a photo is now required, not "photo OR link";
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

**Gift-code rescue (2026-07-29, LIVE, verified end to end):** a customer who submitted without
their gift code used to be stuck (no back navigation; "start over" would create a duplicate order,
since `create_order` fires on the section-5 CTA and redemption happened only inside it). Two-part fix:
(1) **Pre-submit "One last look" confirm modal** — the section-5 CTA now opens `confirmSubmitModal()`
(sibling of `confirmModal()`) showing the breakdown via the shared `sumHtml()` (extracted from
`paintSum()`; single source of truth for the rows) plus a "Have a gift code?" link that jumps to and
focuses the delivery card's gift field; only its go-button calls `submitOrder()`. (2) **Post-submit
"Forgot a gift code? Add it here"** on the unpaid order-submitted screen (`wireSubmittedGift()`) —
applies the code to the EXISTING order via the anon-callable `apply_gift_to_order(p_order_id,
p_gift_code)` RPC (migration `0020`): the order UUID is the bearer token, guards are one-gift-per-order
/ not paid / not completed-or-cancelled, and burn + stamp are atomic with the row locked. On success a
full `render()` reprices the P2P deep links and flips to the gift-covered state at $0 due; Stripe needs
nothing (create-checkout-session reprices from the row). Accepted artifact: the confirmation email +
FormSubmit alert that already went out keep the pre-gift amount — admin reads `gift_credit` off the row
and shows the correct due. The affordance renders only when unpaid, no gift applied yet, and
`lastOrder.id` exists.

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
- **Shippo is on a TEST key** — swap to a live key **in admin → Integrations** (or the dashboard) before real shipments.
- **Stripe is on TEST keys** (like Shippo) — working end to end, but cards aren't really charged. Swap to `sk_live_` + a live webhook secret in admin → Integrations before treating card payments as real. Stripe auto-enabled extra methods (Affirm/Klarna/Bank/Amazon Pay) on the hosted page; prune in the Stripe dashboard if unwanted. Refunds/disputes: handle in the Stripe dashboard (no in-app support).
- **Cash App handle** is still the placeholder `$cashtag`.
- **Multi-admin shipped** — `admin_users` allowlist + Users Management tab (migration `0016`, `invite-admin` edge fn). The owner email `jeremy@idealtraits.com` remains hardcoded as a bootstrap fail-safe in `is_admin()`/`claim_admin_access()`/`admin.html`. Open follow-ups: point Supabase Auth SMTP at Resend so invite emails deliver reliably; deleting a user leaves a dormant `auth.users` account (harmless — is_admin() denies them; hard-delete would need a service-role edge action).
- Anon has over-broad table grants (gated by RLS but worth tightening); Auth leaked-password protection is off.
