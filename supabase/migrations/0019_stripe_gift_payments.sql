-- ============================================================
-- Stripe card payments for gift purchases (conservative version).
--
-- Extends 0018's order checkout to the "Send a gift" flow: the gift
-- confirmation screen gets the same "Pay by card" tile, priced
-- server-side (face value + $7 ship_fee for physical) by
-- create-checkout-session's gift branch. When Stripe's webhook lands,
-- the purchase is marked PAID (paid_at / paid_via='stripe') but the
-- card deliberately STAYS status='pending': Paige still clicks
-- "Issue & send" in admin, which is what releases the code, emails the
-- recipient/buyer, and (physical) spawns the shipment order. The
-- webhook only removes the "did the money land?" verification step.
--
-- Purely additive: no changes to create_gift_purchase or existing rows.
-- ============================================================

alter table public.gift_cards
  add column if not exists paid_at           timestamptz,  -- when the money verifiably arrived (card payments)
  add column if not exists paid_via          text,         -- 'stripe'; null = offline/manual (Venmo etc.)
  add column if not exists stripe_session_id text;
