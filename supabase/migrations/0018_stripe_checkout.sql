-- ============================================================
-- Stripe Checkout: card payments that verify themselves.
--
-- Adds the admin-editable Stripe settings (Integrations tab card, same
-- app_settings + env-fallback pattern as Shippo in 0016), the order columns
-- the checkout session + webhook need, and a 'card' payment_methods row so
-- the PUBLIC site can tell card checkout is on (app_settings is admin-only;
-- payment_methods is already anon-readable and drives the payment tiles).
--
-- Flow: index.html invokes create-checkout-session (computes the amount due
-- server-side, creates a hosted Stripe Checkout session, stores its id) ->
-- customer pays on Stripe -> Stripe calls stripe-webhook (signature-checked)
-- -> payment_collected=true / paid_at / paid_via='stripe' + the
-- payment_verified email. Existing P2P methods are untouched.
--
-- NOTE: app_settings has admin SELECT + UPDATE policies but NO INSERT policy,
-- so new keys must be seeded here; the UI only UPDATEs existing rows.
-- Purely additive: no changes to create_order or existing rows.
-- ============================================================

insert into public.app_settings (key, value) values
  ('stripe_enabled',        'false'),  -- card checkout on/off (the Integrations card toggle)
  ('stripe_secret_key',     ''),       -- sk_test_... / sk_live_...; blank -> falls back to env STRIPE_SECRET_KEY
  ('stripe_webhook_secret', '')        -- whsec_...; blank -> falls back to env STRIPE_WEBHOOK_SECRET
on conflict (key) do nothing;

-- Which Stripe Checkout session an order is (or was) paying through, and how
-- the money actually arrived ('stripe' = card via webhook, 'manual' = Paige
-- matched a Venmo/Zelle/Cash App payment by hand; null = not collected).
alter table public.orders add column if not exists stripe_session_id text;
alter table public.orders add column if not exists paid_via text;

-- The public payment tile. handle must be non-blank to pass the anon RLS
-- filter ("enabled and handle set"); its value is never shown to customers.
-- sort 0 puts the card tile first, ahead of the P2P tiles (venmo=1 ... =4).
-- Starts disabled; saveIntegrations() flips it with the Stripe toggle.
insert into public.payment_methods (id, label, handle, enabled, sort) values
  ('card', 'Pay by card', 'stripe', false, 0)
on conflict (id) do nothing;
