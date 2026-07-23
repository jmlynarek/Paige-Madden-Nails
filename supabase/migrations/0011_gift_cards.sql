-- ============================================================
-- Gift cards — the booth-to-online bridge.
--
-- Paige sells a gift card in person (cash/Venmo). In admin she enters
-- the buyer's email + amount and clicks "Generate code": a short,
-- unguessable code is minted, she WRITES IT ON A PHYSICAL CARD, and the
-- buyer gets a receipt email (thank-you + amount, NEVER the code — the
-- code lives only on the card). The recipient later redeems the code at
-- checkout: the credit comes off the whole order total; a fully-covered
-- order skips payment. A card is SINGLE-USE, BURNED SERVER-SIDE inside
-- create_order's transaction (double-spend is impossible), and may never
-- be redeemed at all (it just stays 'active' — no expiry).
--
-- Patterns mirror 0006 (payment_methods), 0009 (token-scoped SECURITY
-- DEFINER reads), 0010 (admin RLS + realtime + editable template).
-- ============================================================

-- ---------- The gift cards table ----------
create table if not exists public.gift_cards (
  id                uuid primary key default gen_random_uuid(),
  code              text unique not null,             -- 6-char, stored UPPERCASE; written on the card
  amount            numeric(10,2) not null check (amount > 0),
  status            text not null default 'active'
                    check (status in ('active','redeemed','void')),
  buyer_email       text,                             -- receipt recipient; also email capture
  buyer_name        text,
  note              text,                             -- optional freeform (Paige's memory)
  created_at        timestamptz not null default now(),
  redeemed_at       timestamptz,
  redeemed_order_id uuid references public.orders(id) on delete set null
);

alter table public.gift_cards enable row level security;

-- Admin-only. There is NO anon policy: the public site never touches this
-- table directly — it reaches gift cards only through the SECURITY DEFINER
-- RPCs below (check_gift_card to preview, create_order to burn).
drop policy if exists "admin manage gift cards" on public.gift_cards;
create policy "admin manage gift cards" on public.gift_cards
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Order ↔ gift-card link + the credit applied ----------
alter table public.orders
  add column if not exists gift_card_id uuid references public.gift_cards(id) on delete set null,
  add column if not exists gift_credit  numeric(10,2);   -- dollar credit applied at redemption

-- ============================================================
-- Admin: mint a code. SECURITY DEFINER + an explicit is_admin() gate in
-- the body (so only Paige can generate). Retries on the (astronomically
-- unlikely) code collision. Returns the code so the admin can show it big
-- for the physical write; the buyer receipt email is sent from admin JS.
-- ============================================================
create or replace function public.admin_generate_gift_card(
  p_amount      numeric,
  p_buyer_email text,
  p_buyer_name  text,
  p_note        text
) returns table (id uuid, code text, amount numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- no 0/O/1/I/L
  v_code     text;
  v_try      int := 0;
  i          int;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  loop
    v_try := v_try + 1;
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      return query
      insert into public.gift_cards (code, amount, buyer_email, buyer_name, note)
      values (
        v_code,
        p_amount,
        nullif(trim(p_buyer_email), ''),
        nullif(trim(p_buyer_name), ''),
        nullif(trim(p_note), '')
      )
      returning gift_cards.id, gift_cards.code, gift_cards.amount;
      return;   -- success: results are queued, exit the loop
    exception when unique_violation then
      if v_try >= 10 then raise; end if;   -- give up after 10 tries (never expected)
    end;
  end loop;
end;
$$;

revoke all on function public.admin_generate_gift_card(numeric, text, text, text) from public;
grant execute on function public.admin_generate_gift_card(numeric, text, text, text) to authenticated;  -- admin only

-- ============================================================
-- Public checkout preview (read, NO burn). Anon-safe: it can only reveal
-- whether ONE typed code is an active card and its amount — never lists or
-- leaks anything else. Always returns exactly one row (valid, amount).
-- The authoritative single-use burn happens in create_order.
-- ============================================================
create or replace function public.check_gift_card(p_code text)
returns table (valid boolean, amount numeric)
language sql
security definer
set search_path = public
as $$
  select
    exists(
      select 1 from public.gift_cards g
      where g.code = upper(trim(p_code)) and g.status = 'active'
    ),
    (select g.amount from public.gift_cards g
      where g.code = upper(trim(p_code)) and g.status = 'active' limit 1);
$$;

revoke all on function public.check_gift_card(text) from public;
grant execute on function public.check_gift_card(text) to anon, authenticated;

-- ============================================================
-- create_order — recreated to accept an optional gift code and burn it
-- atomically. Based on the LIVE definition (which does NOT compute fees —
-- ship_fee/rush_fee default to 0; the client owns the money math). The
-- ONLY additions vs. today are the p_gift_code param, the burn block, and
-- two extra return columns. Drop first because the return type changes.
-- ============================================================
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
  p_country       text,
  p_gift_code     text default null
) returns table (id uuid, order_no bigint, public_token uuid, gift_applied boolean, gift_credit numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_order_no bigint;
  v_token   uuid;
  v_card_id uuid;
  v_credit  numeric;
begin
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
  returning orders.id, orders.order_no, orders.public_token
  into v_id, v_order_no, v_token;

  -- Burn the gift card, if one was supplied. The `status = 'active'` guard
  -- means only the first redemption ever matches — concurrent double-spend
  -- is impossible. An invalid/already-used code simply applies no credit.
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
$$;

revoke all on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text, text
) from public;

grant execute on function public.create_order(
  text, text, text, text, text, numeric, jsonb, text, text, text,
  text, text, text, text, text, text, text, text
) to anon, authenticated;

-- ---------- Realtime: live Gift Cards tab ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.gift_cards;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------- Editable buyer-receipt email copy ----------
-- Keyed 'gift_card' — like 're_engagement' in 0010, it is deliberately NOT
-- in the order status set, so it never appears as an Orders tab. Admin's
-- Gift Cards tab renders its editor. Only {{amount}} is substituted — there
-- is intentionally no {{code}} placeholder (the code is never emailed).
insert into public.notification_templates (status, subject, heading, body, enabled, sort) values
  ('gift_card',
   'Your Paige Madden Nails gift card 💝',
   'Thank you for your gift!',
   'Thank you so much for your purchase! This confirms your Paige Madden Nails gift card for {{amount}}. The gift code is written on the card itself — whoever receives it can redeem it at paigemadden.app for a custom set. Gift cards never expire. With love, Paige.',
   true, 8)
on conflict (status) do nothing;
