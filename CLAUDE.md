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
| `supabase/functions/buy-shipping-label/` | Deno edge function — buys USPS labels via Shippo |
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
- **Admin identity:** `jeremy@idealtraits.com` (an Auth user + the `is_admin()` DB gate).

## Config in the HTML (these are the load-bearing constants)

Both HTML files hardcode the Supabase URL + **publishable** key (safe to expose —
RLS makes the public site insert-only; see below). Admin email is hardcoded too.

- `index.html`: `SUPABASE_URL`, `SUPABASE_KEY`, and `FORMSUBMIT_ENDPOINT` (order-notification email → `jeremy@idealtraits.com`).
- `admin.html`: `SUPABASE_URL`, `SUPABASE_KEY`, `ADMIN_EMAIL`.
- `supabase/functions/buy-shipping-label/index.ts`: `ADMIN_EMAIL` (only relevant if you deploy the edge function).

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
- **`PM-###`** order numbers come from sequence `order_no_seq` (starts at 488).
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
out of the repo: Supabase **service-role** key, the **Shippo** token, and edge-
function secrets (`SHIPPO_TOKEN`, `SHIP_FROM_*`) live in Supabase Edge Function
secrets. Set them with `supabase secrets set KEY=value`.

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

## Open items

- **Payment handles** are blank — set them in admin → Settings, or checkout shows no payment options.
- **Order emails**: `FORMSUBMIT_ENDPOINT` → `jeremy@idealtraits.com`; the first real UI order triggers a one-time FormSubmit activation email (click to enable). The raw address is exposed in the page; swap to FormSubmit's hashed endpoint when convenient.
- **Shipping labels**: the `buy-shipping-label` edge function is **not deployed** to this Supabase project yet, and no Shippo secrets are set — "buy label" won't work until that's done.
- A test order **PM-488** ("TEST ORDER (safe to delete)") is intentionally in the DB.
