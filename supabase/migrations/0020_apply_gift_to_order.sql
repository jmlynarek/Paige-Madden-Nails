-- ============================================================
-- 0020 — apply_gift_to_order: the "forgot my gift code" rescue.
--
-- Gift redemption normally happens inside create_order, so a customer
-- who submits without their code used to have no way to attach it —
-- the order-submitted screen now offers a post-submit "add a gift code"
-- field that calls this function.
--
-- Anon-safe by design: anon cannot read orders, so the order UUID acts
-- as a bearer token (only the customer's own browser holds it, in
-- lastOrder / localStorage). On any failure the function returns only a
-- machine key — it never reveals order details. The gift burn reuses the
-- same `status = 'active'` guard as create_order, so concurrent
-- double-spend is impossible, and the order row is locked (for update)
-- so two tabs can't race two codes onto one order.
-- ============================================================

create or replace function public.apply_gift_to_order(p_order_id uuid, p_gift_code text)
returns table (applied boolean, credit numeric, message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order   public.orders%rowtype;
  v_card_id uuid;
  v_credit  numeric;
begin
  if p_order_id is null or coalesce(length(trim(p_gift_code)), 0) = 0 then
    return query select false, null::numeric, 'invalid_code'::text; return;
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    return query select false, null::numeric, 'order_not_found'::text; return;
  end if;
  if v_order.gift_card_id is not null or coalesce(v_order.gift_credit, 0) > 0 then
    return query select false, null::numeric, 'already_has_gift'::text; return;
  end if;
  if v_order.payment_collected is true then
    return query select false, null::numeric, 'already_paid'::text; return;
  end if;
  if v_order.status in ('completed', 'cancelled') then
    return query select false, null::numeric, 'order_closed'::text; return;
  end if;

  -- Burn the card. Same guard as create_order: only the first redemption
  -- ever matches. An invalid/spent code updates nothing.
  update public.gift_cards
     set status = 'redeemed',
         redeemed_at = now(),
         redeemed_order_id = p_order_id
   where code = upper(trim(p_gift_code)) and status = 'active'
   returning gift_cards.id, gift_cards.amount into v_card_id, v_credit;

  if v_card_id is null then
    return query select false, null::numeric, 'invalid_code'::text; return;
  end if;

  update public.orders
     set gift_card_id = v_card_id, gift_credit = v_credit
   where orders.id = p_order_id;

  return query select true, v_credit, 'applied'::text;
end;
$$;

revoke all on function public.apply_gift_to_order(uuid, text) from public;
grant execute on function public.apply_gift_to_order(uuid, text) to anon, authenticated;
