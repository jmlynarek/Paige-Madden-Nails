-- ============================================================
-- Returning customers, part 1: per-order reorder token.
--
-- Every order gets an unguessable, PERMANENT token (public_token).
-- A link built from it — /reorder?t=<token> — opens a tiny page that
-- pre-fills a NEW order with the customer's saved sizes / shape /
-- contact / address (design left blank; her clients pick a fresh
-- style each time). No customer login: the random token IS the key,
-- exactly like the order_id capability that send-order-confirmation
-- already relies on.
--
-- RLS is unchanged and still insert-only for anon — the public site
-- STILL cannot read the orders table. The only read path is the
-- narrow SECURITY DEFINER RPC below, scoped to a single order by its
-- token and returning only the fields needed to re-fill the wizard.
-- ============================================================

-- ---------- Columns ----------
alter table public.orders
  add column if not exists public_token uuid not null default gen_random_uuid(),
  add column if not exists completed_at timestamptz;   -- when the set was finished/handed off (anchors the 30-day nudge; set by trigger in 0010)

-- Unguessable lookups by token (also enforces uniqueness).
create unique index if not exists orders_public_token_key on public.orders (public_token);

-- ---------- Token-scoped read (no login, no RLS change) ----------
-- Returns ONLY the reusable fields for ONE order, found by its token.
-- SECURITY DEFINER so it bypasses the insert-only RLS, but it can never
-- leak more than the single row addressed by an unguessable UUID.
create or replace function public.get_order_by_token(p_token uuid)
returns table (
  order_no      bigint,
  status        text,
  customer_name text,
  email         text,
  phone         text,
  nail_shape    text,
  sizes         jsonb,
  fulfillment   text,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text
)
language sql
security definer
set search_path = public
as $$
  select
    o.order_no, o.status, o.customer_name, o.email, o.phone,
    o.nail_shape, o.sizes, o.fulfillment,
    o.address_line1, o.address_line2, o.city, o.region, o.postal_code
  from public.orders o
  where o.public_token = p_token
  limit 1;
$$;

revoke all on function public.get_order_by_token(uuid) from public;
grant execute on function public.get_order_by_token(uuid) to anon, authenticated;

-- ---------- Return the token from create_order ----------
-- Same whitelisted intake as 0005; only the RETURN shape grows by one
-- column (public_token) so the thank-you screen + confirmation email
-- can build the reorder link. Drop first because the return type changes.
drop function if exists public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text
);

create function public.create_order(
  p_customer_name text,
  p_email         text,
  p_phone         text,
  p_nail_shape    text,
  p_design_tier   text,
  p_tier_price    numeric,
  p_sizes         jsonb,
  p_notes         text,
  p_fulfillment   text,
  p_ship_speed    text,
  p_ship_to_name  text,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_region        text,
  p_postal_code   text,
  p_country       text
) returns table (id uuid, order_no bigint, public_token uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into public.orders (
    customer_name, email, phone, nail_shape, design_tier, tier_price,
    sizes, notes, fulfillment, ship_speed, ship_to_name,
    address_line1, address_line2, city, region, postal_code, country
  ) values (
    nullif(trim(p_customer_name), ''),
    nullif(trim(p_email), ''),
    nullif(trim(p_phone), ''),
    nullif(p_nail_shape, ''),
    coalesce(nullif(p_design_tier, ''), 'classic'),
    p_tier_price,
    coalesce(p_sizes, '{}'::jsonb),
    nullif(trim(p_notes), ''),
    coalesce(nullif(p_fulfillment, ''), 'pickup'),
    nullif(p_ship_speed, ''),
    nullif(trim(p_ship_to_name), ''),
    nullif(trim(p_address_line1), ''),
    nullif(trim(p_address_line2), ''),
    nullif(trim(p_city), ''),
    nullif(trim(p_region), ''),
    nullif(trim(p_postal_code), ''),
    coalesce(nullif(p_country, ''), 'US')
  )
  returning orders.id, orders.order_no, orders.public_token;
end;
$$;

revoke all on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text
) from public;

grant execute on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text
) to anon, authenticated;
