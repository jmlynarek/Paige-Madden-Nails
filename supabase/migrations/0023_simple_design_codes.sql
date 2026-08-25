-- 0023_simple_design_codes.sql
--
-- Design codes drop the "PMS-" prefix: plain sequence digits ("102"), shown
-- in the UI as "#102". Simpler to say at a booth, simpler to write on a tag.
-- The UI renders the # prefix; the DB stores digits only.

alter table public.inventory_sets
  alter column code set default (nextval('public.inventory_no_seq'))::text;

update public.inventory_sets set code = replace(code, 'PMS-', '') where code like 'PMS-%';
update public.orders set inventory_set_code = replace(inventory_set_code, 'PMS-', '')
  where inventory_set_code like 'PMS-%';
