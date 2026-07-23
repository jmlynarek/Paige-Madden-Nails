-- ============================================================
-- Gift purchases — the customer-initiated "Send a gift" flow.
--
-- Extends 0011's gift_cards (the booth flow) with an ONLINE purchase path
-- that bypasses the whole nail-order wizard. From the welcome screen a
-- customer picks an amount + how to deliver the gift, then pays OFFLINE
-- (Venmo/Zelle) referencing a PMG-### code — exactly like a normal order.
--
-- The redeemable code is minted now but the card is held 'pending' and the
-- code is NEVER returned to the site: no live, redeemable card can exist
-- before the money lands (there is no payment gateway to enforce this).
-- Paige confirms payment in admin and taps "Issue & send", which flips the
-- card to 'active' and reveals/sends the code.
--
--   • delivery_method 'email' → recipient is emailed the code (+ message);
--     no shipping fee. The buyer gets a receipt (no code).
--   • delivery_method 'card'  → Paige mails a physical gift; a flat $7
--     ship_fee applies. The buyer pays face value + $7; the redeemable
--     CREDIT stays the face value (amount), never amount + shipping.
--
-- Patterns mirror 0011 (code mint + collision retry, SECURITY DEFINER RPC,
-- editable templates, realtime). check_gift_card / create_order already gate
-- on status='active', so a 'pending' card cannot be previewed or redeemed
-- until issued — no change needed to either.
-- ============================================================

-- ---------- Allow the 'pending' status ----------
-- No existing rows are 'pending', so a plain drop-then-add is safe (unlike
-- the orders status migration, no mid-flight rows violate the new set).
alter table public.gift_cards drop constraint if exists gift_cards_status_check;
alter table public.gift_cards add constraint gift_cards_status_check
  check (status in ('active','redeemed','void','pending'));

-- ---------- New columns for the online purchase ----------
alter table public.gift_cards
  add column if not exists recipient_name  text,
  add column if not exists recipient_email text,
  add column if not exists gift_message    text,
  add column if not exists delivery_method text
                            check (delivery_method in ('email','card')),
  add column if not exists purchase_ref    text unique,   -- PMG-### payment reference (NOT the redeemable code)
  add column if not exists issued_at       timestamptz,   -- when Paige confirmed payment + released it
  add column if not exists ship_fee        numeric(10,2) not null default 0,  -- $7 for physical, $0 for email
  add column if not exists ship_line1      text,
  add column if not exists ship_line2      text,
  add column if not exists ship_city       text,
  add column if not exists ship_region     text,
  add column if not exists ship_postal     text;

-- Human-friendly payment reference, mirroring PM-### orders (order_no_seq).
create sequence if not exists public.gift_no_seq start 100;

-- ============================================================
-- Public: create a pending gift purchase. Anon-safe (SECURITY DEFINER, NO
-- is_admin() gate — unlike admin_generate_gift_card). It mints the hidden
-- redeemable code AND a PMG-### purchase_ref, computes ship_fee from the
-- delivery method server-side, inserts a 'pending' row, and returns ONLY
-- { gift_ref, amount, ship_fee } — the redeemable code is never exposed to
-- the site; Paige reveals/sends it at issue time.
-- ============================================================
create or replace function public.create_gift_purchase(
  p_amount          numeric,
  p_delivery_method text,
  p_buyer_name      text,
  p_buyer_email     text,
  p_recipient_name  text,
  p_recipient_email text,
  p_gift_message    text,
  p_ship_line1      text,
  p_ship_line2      text,
  p_ship_city       text,
  p_ship_region     text,
  p_ship_postal     text
) returns table (gift_ref text, amount numeric, ship_fee numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- no 0/O/1/I/L
  v_code     text;
  v_ref      text;
  v_method   text;
  v_fee      numeric;
  v_try      int := 0;
  i          int;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  v_method := lower(coalesce(nullif(trim(p_delivery_method), ''), 'email'));
  if v_method not in ('email','card') then
    raise exception 'invalid delivery method';
  end if;

  -- $7 flat shipping on a mailed physical gift; email delivery ships nothing.
  -- Mirrors SHIP_FEE (7) in index.html — keep the two in sync.
  v_fee := case when v_method = 'card' then 7 else 0 end;

  -- One ref per purchase, drawn before the retry loop so a code collision
  -- doesn't consume another sequence value.
  v_ref := 'PMG-' || nextval('public.gift_no_seq');

  loop
    v_try := v_try + 1;
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    begin
      insert into public.gift_cards (
        code, amount, status, delivery_method, purchase_ref, ship_fee,
        buyer_email, buyer_name,
        recipient_name, recipient_email, gift_message,
        ship_line1, ship_line2, ship_city, ship_region, ship_postal
      ) values (
        v_code, p_amount, 'pending', v_method, v_ref, v_fee,
        nullif(trim(p_buyer_email), ''), nullif(trim(p_buyer_name), ''),
        nullif(trim(p_recipient_name), ''), nullif(trim(p_recipient_email), ''),
        nullif(trim(p_gift_message), ''),
        nullif(trim(p_ship_line1), ''), nullif(trim(p_ship_line2), ''),
        nullif(trim(p_ship_city), ''), nullif(trim(p_ship_region), ''),
        nullif(trim(p_ship_postal), '')
      );
      exit;   -- success
    exception when unique_violation then
      -- purchase_ref comes from a sequence (unique), so a collision here is
      -- the 6-char code; regenerate and retry.
      if v_try >= 10 then raise; end if;
    end;
  end loop;

  gift_ref := v_ref; amount := p_amount; ship_fee := v_fee;
  return next;
end;
$$;

revoke all on function public.create_gift_purchase(
  numeric, text, text, text, text, text, text, text, text, text, text, text
) from public;
grant execute on function public.create_gift_purchase(
  numeric, text, text, text, text, text, text, text, text, text, text, text
) to anon, authenticated;

-- ---------- Editable email copy for the issue step ----------
-- Non-status keys (like 're_engagement' / 'gift_card') so they never surface
-- as an Orders tab; admin's Gift Cards tab renders their editors. Both are
-- sent from admin (Paige is authenticated) via the send-order-email fn AFTER
-- payment is confirmed.
--
-- gift_recipient — the e-gift, the ONLY gift email that carries {{code}}
-- (a deliberate departure from the physical-card "code never emailed" rule,
-- scoped to email delivery). Also substitutes {{from}}, {{amount}}, {{message}}.
-- gift_buyer_receipt — buyer confirmation: {{amount}} + {{recipient}}, NO code.
insert into public.notification_templates (status, subject, heading, body, enabled, sort) values
  ('gift_recipient',
   'You''ve been gifted Paige Madden Nails 🎁',
   'A gift, just for you!',
   '{{from}} sent you a Paige Madden Nails gift for {{amount}}!' || chr(10) || chr(10) ||
   '{{message}}' || chr(10) || chr(10) ||
   'Your gift code is {{code}} — enter it at checkout on paigemadden.app to redeem it for a custom set. Gift cards never expire. Enjoy! With love, Paige.',
   true, 9),
  ('gift_buyer_receipt',
   'Your Paige Madden Nails gift is on its way 💝',
   'Thank you for your gift!',
   'Thank you so much! This confirms your Paige Madden Nails gift for {{amount}}, sent to {{recipient}}. They''ll be able to redeem it at paigemadden.app for a custom set. Gift cards never expire. With love, Paige.',
   true, 10)
on conflict (status) do nothing;
