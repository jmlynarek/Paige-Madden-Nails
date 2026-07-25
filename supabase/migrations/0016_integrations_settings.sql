-- ============================================================
-- Integrations: move the Shippo API key + return address out of
-- edge-function secrets and into admin-editable settings.
--
-- Until now the Shippo token (SHIPPO_TOKEN) and the ship-from address
-- (SHIP_FROM_*) lived ONLY as Supabase edge-function secrets, so swapping
-- the key (test -> live) or changing the return address meant editing
-- secrets in the dashboard. This seeds owner-tunable knobs into app_settings
-- (reuses the table + admin RLS from 0010) so the new admin "Integrations"
-- tab can edit them, and buy-shipping-label reads them at run time.
--
-- Rollout is zero-behavior-change: buy-shipping-label reads each value with a
-- per-field FALLBACK to the existing env secret, so a blank seed = "keep using
-- today's secret". Only the documented street address is pre-filled; the
-- from-name / phone / email stay blank on purpose (their exact secret values
-- can't be read here, so we don't guess — they keep using the env secret until
-- set in the UI). 'shippo_enabled' seeds true to preserve current behavior.
--
-- NOTE: app_settings has admin SELECT + UPDATE policies but NO INSERT policy,
-- so new keys must be seeded here; the UI only UPDATEs existing rows.
-- ============================================================

insert into public.app_settings (key, value) values
  ('shippo_enabled',    'true'),           -- Shipping integration on/off (the card toggle)
  ('shippo_api_key',    ''),               -- blank -> falls back to env SHIPPO_TOKEN
  ('ship_from_name',    ''),               -- blank -> falls back to env SHIP_FROM_NAME
  ('ship_from_street1', '540 Northshore Ct'),
  ('ship_from_street2', ''),
  ('ship_from_city',    'Lake Orion'),
  ('ship_from_state',   'MI'),
  ('ship_from_zip',     '48362'),
  ('ship_from_country', 'US'),
  ('ship_from_phone',   ''),               -- blank -> falls back to env SHIP_FROM_PHONE
  ('ship_from_email',   '')                -- blank -> falls back to env SHIP_FROM_EMAIL / admin
on conflict (key) do nothing;
