-- ============================================================
-- Pause new orders + a waitlist to capture leads while paused.
--
-- Paige flips one toggle in admin Settings when she's backlogged. While
-- paused, the public Welcome screen stops pitching a new order and instead
-- shows her message + an email capture ("get on the wait list — you'll be
-- first in line"). Flipping it back on leaves the waitlist as her ordered,
-- first-come queue to reach back out to.
--
-- Moving parts:
--   app_settings   — 4 owner-tunable knobs (reuses the table from 0010).
--   waitlist_leads — the captured leads (admin-managed; anon writes only
--                    through the SECURITY DEFINER RPC below).
--   get_order_status() — the single anon read the public site uses to decide
--                    the Welcome screen (anon has NO direct app_settings read).
--   join_waitlist()    — anon upsert-by-email; never leaks the table.
--
-- Deliberately NOT changed: create_order stays open (the gate is front-door
-- only — pausing swaps the Welcome CTA, it does not block submits), and the
-- reorder / re-engagement paths are untouched (reorders bypass the pause).
-- ============================================================

-- ---------- Owner-tunable knobs (table + RLS already exist from 0010) ----------
-- 'orders_paused' is the master flag. The rest is the copy shown while paused,
-- so Paige can edit the message + "N week delay" without a code change.
insert into public.app_settings (key, value) values
  ('orders_paused',          'false'),
  ('orders_paused_headline', 'Orders are paused right now'),
  ('orders_paused_message',  'Thanks to all my amazing customers — I''m heavily backlogged and not taking new orders at the moment. Drop your email and I''ll reach out the moment I reopen. You''ll be first in line. 💕'),
  ('orders_paused_wait',     '')   -- optional "N week delay"; shown only when filled in
on conflict (key) do nothing;

-- ---------- The captured leads ----------
create table if not exists public.waitlist_leads (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,            -- stored lowercased
  name        text,
  source      text default 'order_pause',
  notified_at timestamptz,              -- stamped when Paige reaches back out
  created_at  timestamptz not null default now()
);
-- One row per person; "first in line" = order by created_at asc.
create unique index if not exists waitlist_leads_email_key
  on public.waitlist_leads (lower(email));

-- ---------- RLS: admin manages; anon never touches it directly ----------
alter table public.waitlist_leads enable row level security;
drop policy if exists "admin manage waitlist" on public.waitlist_leads;
create policy "admin manage waitlist" on public.waitlist_leads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Anon read: is the shop paused, and with what copy? ----------
-- One narrow RPC so the public site never gets direct app_settings access.
create or replace function public.get_order_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'paused',   coalesce((select value from public.app_settings where key = 'orders_paused'), 'false') = 'true',
    'headline', coalesce((select value from public.app_settings where key = 'orders_paused_headline'), ''),
    'message',  coalesce((select value from public.app_settings where key = 'orders_paused_message'), ''),
    'wait',     coalesce((select value from public.app_settings where key = 'orders_paused_wait'), '')
  );
$$;
revoke all on function public.get_order_status() from public;
grant execute on function public.get_order_status() to anon, authenticated;

-- ---------- Anon write: join the waitlist (upsert by email) ----------
-- SECURITY DEFINER so the anon caller never touches waitlist_leads directly.
-- Loose email sanity check; dedupes on lower(email); keeps the earliest row
-- (and fills in a name if we didn't have one).
create or replace function public.join_waitlist(p_email text, p_name text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name  text := nullif(trim(coalesce(p_name, '')), '');
begin
  if v_email = '' or position('@' in v_email) = 0 or length(v_email) > 320 then
    return false;
  end if;
  insert into public.waitlist_leads (email, name, source)
  values (v_email, left(v_name, 200), 'order_pause')
  on conflict (lower(email)) do update
    set name = coalesce(excluded.name, public.waitlist_leads.name);
  return true;
end;
$$;
revoke all on function public.join_waitlist(text, text) from public;
grant execute on function public.join_waitlist(text, text) to anon, authenticated;

-- ---------- Realtime: live waitlist signups in the admin ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.waitlist_leads;
  exception when duplicate_object then null;
  end;
end $$;
