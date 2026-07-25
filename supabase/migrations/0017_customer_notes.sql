-- ============================================================
-- Customer notes for the admin's Customers tab (lightweight CRM).
--
-- Customers are DERIVED, not stored: admin.html groups orders client-side by a
-- normalized identity key (buildCustomers()/custKey()). This table holds the
-- one piece of customer data that can't be derived from orders — Paige's own
-- free-text note on a person ("prefers almond, pays Venmo, sister of Sarah").
--
-- key mirrors admin.html custKey() exactly:
--   'e:<lowercased trimmed email>'  (preferred)
--   'p:<phone digits, leading 1 stripped>'  (legacy rows without email)
--   'n:<lowercased trimmed name>'   (last resort)
-- A note survives the customer ordering again (same key), and is simply
-- orphaned-but-harmless if a legacy identity later merges under a new key.
-- ============================================================

create table if not exists public.customer_notes (
  key        text primary key,
  notes      text not null default '',
  updated_at timestamptz not null default now()
);

-- ---------- RLS: admin-only; anon never touches it ----------
alter table public.customer_notes enable row level security;
drop policy if exists "admin manage customer notes" on public.customer_notes;
create policy "admin manage customer notes" on public.customer_notes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
