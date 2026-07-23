-- ============================================================
-- Returning customers, part 2: the 30-day re-engagement nudge.
--
-- A soft, personal "hope you're loving your set — want a new one? we
-- saved your sizes" email, sent ~30 days after an order is finished.
-- It carries the /reorder?t=<token> link from 0009 and an unsubscribe
-- link. Paige watches/controls every scheduled send from a new admin
-- Marketing tab and can cancel a send or unsubscribe a person.
--
-- Moving parts:
--   scheduled_sends  — one row per order = the queue behind the tab.
--   email_optouts    — permanent per-person opt-out (customer or admin).
--   app_settings     — the delay + master on/off knobs Paige controls.
--   triggers         — stamp completed_at + move the queue row to
--                      'scheduled' when an order is finished.
--   unsubscribe_by_token — login-free opt-out for the email link.
-- The daily send itself is the `send-reengagement` edge function,
-- driven by pg_cron (set up separately in the dashboard).
-- ============================================================

-- ---------- The send queue (drives the Marketing tab) ----------
create table if not exists public.scheduled_sends (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  kind          text not null default 'reengage_30d',
  scheduled_for date,                                   -- null while 'pending'; set when the order is finished
  status        text not null default 'pending',        -- pending → scheduled → sent | cancelled | failed
  sent_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint scheduled_sends_status_chk
    check (status in ('pending','scheduled','sent','cancelled','failed'))
);
create index if not exists scheduled_sends_due_idx
  on public.scheduled_sends (scheduled_for)
  where status = 'scheduled';
create unique index if not exists scheduled_sends_order_kind_key
  on public.scheduled_sends (order_id, kind);

-- ---------- Permanent per-person opt-out ----------
create table if not exists public.email_optouts (
  email        text primary key,                        -- always stored lowercased
  opted_out_at timestamptz not null default now(),
  source       text                                     -- 'customer_link' | 'admin'
);

-- ---------- Owner-tunable knobs ----------
create table if not exists public.app_settings (
  key   text primary key,
  value text
);
insert into public.app_settings (key, value) values
  ('reengage_delay_days', '30'),
  ('reengage_enabled',    'true')
on conflict (key) do nothing;

-- ---------- RLS ----------
alter table public.scheduled_sends enable row level security;
alter table public.email_optouts   enable row level security;
alter table public.app_settings    enable row level security;

-- Admin (Paige) manages everything from the dashboard. The edge function
-- uses the service-role key, which bypasses RLS, so it needs no policy.
drop policy if exists "admin manage scheduled_sends" on public.scheduled_sends;
create policy "admin manage scheduled_sends" on public.scheduled_sends
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin manage optouts" on public.email_optouts;
create policy "admin manage optouts" on public.email_optouts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin read settings" on public.app_settings;
create policy "admin read settings" on public.app_settings
  for select to authenticated using (public.is_admin());
drop policy if exists "admin update settings" on public.app_settings;
create policy "admin update settings" on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Login-free unsubscribe (email link) ----------
-- Finds the order's email by its token and records a permanent opt-out.
-- SECURITY DEFINER so the anon caller never touches email_optouts directly.
create or replace function public.unsubscribe_by_token(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select lower(trim(email)) into v_email
  from public.orders where public_token = p_token and email is not null;
  if v_email is null or v_email = '' then
    return false;
  end if;
  insert into public.email_optouts (email, source)
  values (v_email, 'customer_link')
  on conflict (email) do nothing;
  return true;
end;
$$;
revoke all on function public.unsubscribe_by_token(uuid) from public;
grant execute on function public.unsubscribe_by_token(uuid) to anon, authenticated;

-- ============================================================
-- Triggers — keep the queue in sync with order lifecycle.
-- All SECURITY DEFINER so they bypass RLS cleanly regardless of who
-- inserts/updates the order (anon via create_order, or admin).
-- ============================================================

-- 1. Every new order enters the queue as 'pending' (so it shows up in the
--    Marketing tab immediately, before it's finished/scheduled).
create or replace function public.queue_reengagement() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.scheduled_sends (order_id, kind, status)
  values (new.id, 'reengage_30d', 'pending')
  on conflict (order_id, kind) do nothing;
  return new;
end;
$$;
drop trigger if exists orders_queue_reengagement on public.orders;
create trigger orders_queue_reengagement
  after insert on public.orders
  for each row execute function public.queue_reengagement();

-- 2. Stamp completed_at the first time an order reaches a "customer has
--    it" state (pickup → completed, shipping → ready_for_label).
create or replace function public.stamp_completed_at() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status in ('completed','ready_for_label') and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists orders_stamp_completed_at on public.orders;
create trigger orders_stamp_completed_at
  before update on public.orders
  for each row execute function public.stamp_completed_at();

-- 3. When completed_at is first set, schedule the pending nudge for
--    completed_at + delay (read live from app_settings).
create or replace function public.schedule_reengagement() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_delay int;
begin
  if new.completed_at is not null and old.completed_at is distinct from new.completed_at then
    select coalesce((select value from public.app_settings where key = 'reengage_delay_days'), '30')::int
      into v_delay;
    update public.scheduled_sends
      set status = 'scheduled',
          scheduled_for = (new.completed_at)::date + v_delay
      where order_id = new.id and kind = 'reengage_30d' and status = 'pending';
  end if;
  return new;
end;
$$;
drop trigger if exists orders_schedule_reengagement on public.orders;
create trigger orders_schedule_reengagement
  after update on public.orders
  for each row execute function public.schedule_reengagement();

-- ---------- Backfill: a pending queue row for existing orders ----------
-- (Visibility only. Old orders have no completed_at, so trigger #3 never
-- fired for them — they won't auto-send. Marketing can act on them by hand.)
insert into public.scheduled_sends (order_id, kind, status)
select o.id, 'reengage_30d', 'pending'
from public.orders o
where not exists (
  select 1 from public.scheduled_sends s
  where s.order_id = o.id and s.kind = 'reengage_30d'
)
on conflict (order_id, kind) do nothing;

-- ---------- Realtime: live Marketing-tab updates ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.scheduled_sends;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------- Re-engagement email template (editable in admin) ----------
-- Keyed 're_engagement' — deliberately NOT added to the order status set,
-- so it does not appear as an Orders tab. The admin Marketing tab renders
-- its editor card and reuses the generic saveTemplate/toggleTemplate code.
-- {{reorder_link}} is replaced by the edge function with /reorder?t=<token>.
insert into public.notification_templates (status, subject, heading, body, enabled, sort) values
  ('re_engagement',
   'Ready for a new set? 💕',
   'We saved your sizes',
   'Hi! I hope you''ve been loving your last set. Whenever you''re ready for a fresh look, I''ve saved your sizes and details — so you can skip straight to the fun part and just pick a new design. Tap below to start a new order anytime. {{reorder_link}}',
   true, 7)
on conflict (status) do nothing;
