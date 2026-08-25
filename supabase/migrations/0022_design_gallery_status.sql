-- 0022_design_gallery_status.sql
--
-- Reframe the inventory feature (0021) from "ready-made shop" to "design
-- gallery": the ~100 photographed sets are DESIGNS Paige can remake in any
-- size, not stock on a shelf (the physical one may already be sold, so a shop
-- framing was deceiving). Nothing is ever "sold out": customers pick a design
-- as their inspo and Paige makes it fresh. So `status` becomes a simple
-- visibility flag (visible|hidden — Hide retires a design from the gallery)
-- and `sold_at` goes away. Table was empty at the time of this migration.

-- 1. Status: available|sold → visible|hidden
alter table public.inventory_sets drop constraint if exists inventory_sets_status_check;
update public.inventory_sets set status = case when status = 'sold' then 'hidden' else 'visible' end;
alter table public.inventory_sets alter column status set default 'visible';
alter table public.inventory_sets
  add constraint inventory_sets_status_check check (status in ('visible','hidden'));

-- 2. No sold concept
alter table public.inventory_sets drop column if exists sold_at;

-- 3. Anon sees visible designs only
drop policy if exists "anyone can read available sets" on public.inventory_sets;
create policy "anyone can read visible designs" on public.inventory_sets
  for select to anon
  using (status = 'visible');
