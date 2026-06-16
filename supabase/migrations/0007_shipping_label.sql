-- ============================================================
-- Shipping labels (Shippo integration).
-- The `buy-shipping-label` edge function buys a USPS label via
-- Shippo and writes the results back here. ship_speed (set at
-- order time: 'standard' | 'rush') drives which rate is bought:
-- standard -> cheapest; rush -> cheapest Priority/Express tier.
-- ============================================================

alter table public.orders
  add column if not exists carrier         text,          -- e.g. 'USPS'
  add column if not exists service_level   text,          -- e.g. 'Ground Advantage', 'Priority Mail'
  add column if not exists tracking_number text,
  add column if not exists tracking_url    text,
  add column if not exists label_url        text,         -- printable label PDF
  add column if not exists shipping_cost    numeric(10,2),-- postage actually paid
  add column if not exists shipped_at       timestamptz,
  add column if not exists shippo_object_id text;         -- Shippo transaction id (de-dup / refunds)

-- Fast lookup by tracking number (support / customer questions).
create index if not exists orders_tracking_number_idx
  on public.orders (tracking_number)
  where tracking_number is not null;
