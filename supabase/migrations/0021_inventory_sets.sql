-- 0021_inventory_sets.sql
--
-- Ready-made set inventory + public gallery.
--
-- Paige brings ~100 pre-made sets to vendor events. Each set gets a row here
-- with a photo, a price (the number written on the paper in the photo), and an
-- auto-generated PMS-### code she writes on the physical tag. The public site
-- shows AVAILABLE sets in a gallery; customers pick one as their inspo and the
-- set's price replaces the $40/$50 tier price. Sets leave the gallery ONLY
-- when Paige marks them sold in admin (deliberate: no auto-reserve on online
-- orders — she confirms each sale by hand, same as sizes).
--
-- Also: a new PUBLIC storage bucket `inventory` for the set photos
-- (admin-writable, world-readable — unlike the private `inspiration` bucket),
-- two new orders columns linking an order to the set it bought, and a new
-- create_order signature with p_inventory_set_id (price is read server-side
-- from the set row; the client's p_tier_price is ignored when a set is
-- attached).

-- ============================================================
-- 1. Sequence + table
-- ============================================================

create sequence if not exists public.inventory_no_seq start 100;

create table if not exists public.inventory_sets (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null default ('PMS-' || nextval('public.inventory_no_seq')),
  name        text,
  description text,
  price       numeric(10,2) not null check (price > 0),
  photo_path  text not null,   -- object path inside the public `inventory` bucket
  status      text not null default 'available' check (status in ('available','sold')),
  sold_at     timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.inventory_sets enable row level security;

-- Anon sees only available sets (same shape as payment_methods' content-gated
-- anon policy). Admin manages everything.
create policy "anyone can read available sets" on public.inventory_sets
  for select to anon
  using (status = 'available');

create policy "admin manage inventory sets" on public.inventory_sets
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

grant select on public.inventory_sets to anon;
grant all on public.inventory_sets to authenticated;
-- the code default draws from the sequence as the inserting role
grant usage on sequence public.inventory_no_seq to authenticated;

-- ============================================================
-- 2. Orders linkage
-- ============================================================

-- inventory_set_code is denormalized so admin rows / alerts never need a join
-- and the code survives a set deletion.
alter table public.orders
  add column if not exists inventory_set_id uuid references public.inventory_sets(id) on delete set null,
  add column if not exists inventory_set_code text;

-- ============================================================
-- 3. create_order: new p_inventory_set_id param
-- ============================================================

-- Adding a defaulted param changes the signature, which would otherwise leave
-- two overloads behind. Drop the old signature first.
drop function if exists public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text, text
);

create or replace function public.create_order(
  p_customer_name text,
  p_email text,
  p_phone text,
  p_nail_shape text,
  p_design_tier text,
  p_tier_price numeric,
  p_sizes jsonb,
  p_notes text,
  p_fulfillment text,
  p_ship_speed text,
  p_ship_to_name text,
  p_address_line1 text,
  p_address_line2 text,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country text,
  p_gift_code text default null::text,
  p_inventory_set_id uuid default null::uuid
)
returns table(id uuid, order_no bigint, public_token uuid, gift_applied boolean, gift_credit numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id        uuid;
  v_order_no  bigint;
  v_token     uuid;
  v_card_id   uuid;
  v_credit    numeric;
  v_set_price numeric;
  v_set_code  text;
begin
  -- Ready-made set: price comes from the row, never from the client.
  -- Deliberately no status check — sets leave inventory only when Paige
  -- marks them sold, and a just-sold set may still be mid-checkout.
  if p_inventory_set_id is not null then
    select s.price, s.code into v_set_price, v_set_code
      from public.inventory_sets s where s.id = p_inventory_set_id;
    if not found then
      raise exception 'set_not_found';
    end if;
  end if;

  insert into public.orders (
    customer_name, email, phone, nail_shape, design_tier, tier_price,
    sizes, notes, fulfillment, ship_speed, ship_to_name,
    address_line1, address_line2, city, region, postal_code, country,
    ship_fee, rush_fee,
    inventory_set_id, inventory_set_code
  ) values (
    nullif(trim(p_customer_name), ''),
    nullif(trim(p_email), ''),
    nullif(trim(p_phone), ''),
    nullif(p_nail_shape, ''),
    coalesce(nullif(p_design_tier, ''), 'classic'),
    coalesce(v_set_price, p_tier_price),
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
    coalesce(nullif(p_country, ''), 'US'),
    -- fee line items (must match SHIP_FEE / RUSH_FEE in index.html)
    case when coalesce(nullif(p_fulfillment, ''), 'pickup') = 'shipping' then 7 else 0 end,
    case when p_ship_speed = 'rush' then 10 else 0 end,
    p_inventory_set_id,
    v_set_code
  )
  returning orders.id, orders.order_no, orders.public_token
  into v_id, v_order_no, v_token;

  if p_gift_code is not null and length(trim(p_gift_code)) > 0 then
    update public.gift_cards
       set status = 'redeemed',
           redeemed_at = now(),
           redeemed_order_id = v_id
     where code = upper(trim(p_gift_code)) and status = 'active'
     returning gift_cards.id, gift_cards.amount into v_card_id, v_credit;

    if found then
      update public.orders
         set gift_card_id = v_card_id, gift_credit = v_credit
       where orders.id = v_id;
    end if;
  end if;

  id := v_id; order_no := v_order_no; public_token := v_token;
  gift_applied := (v_credit is not null); gift_credit := v_credit;
  return next;
end;
$function$;

revoke all on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text, text, uuid
) from public;
grant execute on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text, text, uuid
) to anon, authenticated;

-- ============================================================
-- 4. Public storage bucket for set photos
-- ============================================================

insert into storage.buckets (id, name, public)
values ('inventory', 'inventory', true)
on conflict (id) do nothing;

-- World-readable (the bucket is public; this makes list/download consistent),
-- admin-only writes. DELETE included on purpose — the `inspiration` bucket's
-- missing delete policy is a known gap; don't repeat it here.
create policy "anyone can read inventory photos" on storage.objects
  for select
  using (bucket_id = 'inventory');

create policy "admin insert inventory photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'inventory' and public.is_admin());

create policy "admin update inventory photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'inventory' and public.is_admin())
  with check (bucket_id = 'inventory' and public.is_admin());

create policy "admin delete inventory photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'inventory' and public.is_admin());

-- ============================================================
-- 5. Realtime (admin grid live-updates across booth devices)
-- ============================================================

do $$ begin
  begin
    alter publication supabase_realtime add table public.inventory_sets;
  exception when duplicate_object then null;
  end;
end $$;
