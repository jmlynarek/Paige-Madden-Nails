-- ============================================================
-- Gift-card SHIPMENT orders.
--
-- A physical "Send a gift card" purchase is something Paige has to MAIL, so
-- when she issues one (admin "Issue & send"), the app also creates a normal
-- orders row — fulfillment='shipping', $0 value (already paid) — so it lands
-- in her order queue and flows through the existing ship pipeline (buy label
-- → tracking → completed). Email-delivery gifts create no order.
--
-- This column links that shipment order back to the gift_cards row. It is
-- DISTINCT from orders.gift_card_id (which marks an order that REDEEMED a
-- card). design_tier can't be the marker — it's CHECK-constrained to
-- classic/custom — hence a dedicated link column.
-- ============================================================
alter table public.orders
  add column if not exists gift_shipment_id uuid references public.gift_cards(id) on delete set null;
