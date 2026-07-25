-- ============================================================
-- Admin users — the multi-admin allowlist.
--
-- Until now "who is an admin" was a single hardcoded email, checked in
-- is_admin() (this DB), admin.html, and two edge functions. This migration
-- replaces that literal with a table-driven allowlist so teammates can be
-- invited from the admin UI. Everyone in the table has the SAME, full access
-- (no roles/permissions) — the table only tracks WHO, not WHAT.
--
-- Lifecycle: an admin invites an email -> row is 'invited' (a Supabase Auth
-- invite email goes out from the invite-admin edge fn) -> the invitee sets a
-- password and signs in -> claim_admin_access() flips them to 'approved'.
-- Only 'approved' rows (plus the bootstrap owner literal) pass is_admin().
--
-- SAFETY: jeremy@idealtraits.com stays wired in as a permanent bootstrap
-- owner in is_admin() AND claim_admin_access(), so a bad/empty table can
-- never lock the owner out. Patterns mirror 0006/0010/0011 (admin RLS,
-- SECURITY DEFINER guards, realtime).
-- ============================================================

-- ---------- The allowlist table ----------
create table if not exists public.admin_users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,                    -- always stored lowercased
  name        text,
  status      text not null default 'invited'
              check (status in ('invited','approved')),
  invited_by  text,                                    -- email of the admin who invited them
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  updated_at  timestamptz not null default now()
);

alter table public.admin_users enable row level security;

-- Admin-only, one policy for read + write. There is NO anon policy. Note
-- is_admin() is SECURITY DEFINER (below), so it reads this table bypassing
-- RLS — no recursive policy evaluation.
drop policy if exists "admin manage admin_users" on public.admin_users;
create policy "admin manage admin_users" on public.admin_users
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- Seed the bootstrap owner as an approved row ----------
-- So the owner shows up in the Users list and the table is coherent from day one.
insert into public.admin_users (email, name, status, approved_at)
values ('jeremy@idealtraits.com', 'Jeremy', 'approved', now())
on conflict (email) do nothing;

-- ============================================================
-- is_admin() — now table-driven. Keeps the owner literal as a fail-safe AND
-- checks for an 'approved' row. Must be SECURITY DEFINER: it now reads
-- admin_users and is invoked inside other tables' RLS policies, so a definer
-- read (bypassing admin_users' own RLS) prevents recursion / lockout.
-- search_path stays '' with every reference fully-qualified.
-- ============================================================
create or replace function public.is_admin() returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() ->> 'email') = 'jeremy@idealtraits.com'
    or exists (
      select 1 from public.admin_users a
      where lower(a.email) = lower(auth.jwt() ->> 'email')
        and a.status = 'approved'
    ), false);
$$;

-- ============================================================
-- claim_admin_access() — called by admin.html on every sign-in. It both:
--   (a) flips the caller's OWN row invited -> approved (first accepted sign-in), and
--   (b) returns whether the caller is now an admin.
-- This resolves the chicken-and-egg: an 'invited' user isn't approved yet, so
-- plain RLS would block the very update that approves them — but this SECURITY
-- DEFINER function can flip + confirm them. It only ever touches the caller's
-- own email (auth.jwt()). Returns false for any authenticated user with no row,
-- so the client signs them out.
-- ============================================================
create or replace function public.claim_admin_access() returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_email is null or v_email = '' then
    return false;
  end if;

  -- Bootstrap owner is always an admin, table or not.
  if v_email = 'jeremy@idealtraits.com' then
    return true;
  end if;

  -- Auto-approve on first accepted sign-in.
  update public.admin_users
     set status = 'approved',
         approved_at = coalesce(approved_at, now()),
         updated_at = now()
   where lower(email) = v_email and status = 'invited';

  -- Are they an approved admin now?
  return exists (
    select 1 from public.admin_users
    where lower(email) = v_email and status = 'approved'
  );
end;
$$;

revoke all on function public.claim_admin_access() from public;
grant execute on function public.claim_admin_access() to authenticated;

-- ---------- Realtime: live Users Management tab ----------
do $$
begin
  begin
    alter publication supabase_realtime add table public.admin_users;
  exception when duplicate_object then null;
  end;
end $$;
