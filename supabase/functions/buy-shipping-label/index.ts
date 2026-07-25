// ============================================================
// buy-shipping-label
// Buys a USPS shipping label via Shippo for one order and writes
// the tracking number + label PDF back to the order row.
//
// Auth: caller must be an approved admin (see is_admin() / admin_users).
//       This function spends money, so it refuses everyone else and
//       refuses to buy a second label for an order that already has one.
//
// Rate choice: always the cheapest available rate (Standard shipping) for
// every order. Rush is a production-speed upgrade (Paige works on the set
// faster) — it does NOT change the shipping service.
//
// Config (admin-editable in the Integrations tab; stored in app_settings):
//   shippo_enabled, shippo_api_key, ship_from_name / ship_from_street1 /
//   ship_from_street2 / ship_from_city / ship_from_state / ship_from_zip /
//   ship_from_country / ship_from_phone / ship_from_email
// Each value FALLS BACK to the matching env secret below when it's blank, so
// the old secrets keep working until the key is set in the UI:
//   SHIPPO_TOKEN      shippo_test_... or shippo_live_...
//   SHIP_FROM_NAME / SHIP_FROM_STREET1 / SHIP_FROM_STREET2 /
//   SHIP_FROM_CITY / SHIP_FROM_STATE / SHIP_FROM_ZIP /
//   SHIP_FROM_COUNTRY / SHIP_FROM_PHONE / SHIP_FROM_EMAIL
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "jeremy@idealtraits.com";
const SHIPPO_BASE = "https://api.goshippo.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const env = (k: string) => Deno.env.get(k) ?? "";

// Build the ship-from address, preferring the admin-editable app_settings
// values and falling back to the env secret per field (blank = "use the
// secret"). `cfg` is the app_settings map; may be empty (then all env).
function buildShipFrom(cfg: Record<string, string>) {
  const val = (k: string, envKey: string) =>
    (cfg[k] ?? "").trim() || env(envKey);
  return {
    name: val("ship_from_name", "SHIP_FROM_NAME"),
    street1: val("ship_from_street1", "SHIP_FROM_STREET1"),
    street2: val("ship_from_street2", "SHIP_FROM_STREET2"),
    city: val("ship_from_city", "SHIP_FROM_CITY"),
    state: val("ship_from_state", "SHIP_FROM_STATE"),
    zip: val("ship_from_zip", "SHIP_FROM_ZIP"),
    country: val("ship_from_country", "SHIP_FROM_COUNTRY") || "US",
    phone: val("ship_from_phone", "SHIP_FROM_PHONE"),
    // Shippo requires a from-email to buy a label, but it is NOT printed on
    // the package. Falls back to the admin email when both DB + secret blank.
    email: val("ship_from_email", "SHIP_FROM_EMAIL") || ADMIN_EMAIL,
  };
}

async function shippo(path: string, body: unknown, token: string) {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = env("SUPABASE_URL");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  // ---- verify the caller is the admin ----
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  // Any approved admin (allowlist-driven, see is_admin() / admin_users), not
  // just a single hardcoded owner. is_admin() reads the caller's JWT.
  const { data: isAdmin } = await asUser.rpc("is_admin");
  if (!user || isAdmin !== true) {
    return json({ error: "Not authorized." }, 403);
  }

  // ---- load admin-editable config from app_settings (service role) ----
  // Defensive: any read failure leaves cfg empty, so every field falls back
  // to its env secret — i.e. a DB hiccup degrades to today's behavior.
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const cfg: Record<string, string> = {};
  try {
    const { data: rows } = await db.from("app_settings").select("key,value");
    (rows ?? []).forEach((r: any) => { cfg[r.key] = r.value ?? ""; });
  } catch { /* fall back to env for everything */ }

  // Strict "false" check: if the migration hasn't run, the key is undefined,
  // so shipping is NOT considered disabled and behavior is unchanged.
  if (cfg.shippo_enabled === "false") {
    return json({ error: "Shipping is turned off in Integrations." }, 400);
  }

  const token = (cfg.shippo_api_key ?? "").trim() || env("SHIPPO_TOKEN");
  const shipFrom = buildShipFrom(cfg);

  if (!token) {
    return json({ error: "Shipping is not configured yet — add your Shippo API key in Integrations." }, 500);
  }
  if (!shipFrom.street1 || !shipFrom.zip) {
    return json({ error: "Return address is not configured yet — set the ship-from address in Integrations." }, 500);
  }
  if (!shipFrom.phone) {
    return json({ error: "A return phone number is required to buy labels — set it in Integrations." }, 500);
  }

  // ---- read the request ----
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const orderId = payload.order_id;
  const parcel = payload.parcel ?? {};
  if (!orderId) return json({ error: "Missing order_id." }, 400);

  // ---- load the order with the service role (bypasses RLS) ----
  const { data: order, error: oErr } = await db
    .from("orders").select("*").eq("id", orderId).single();
  if (oErr || !order) return json({ error: "Order not found." }, 404);

  if (order.fulfillment !== "shipping") {
    return json({ error: "This is a local-pickup order, not a shipping order." }, 400);
  }
  if (order.label_url) {
    // Already bought — never double-charge. Hand back what we have.
    return json({
      already: true,
      carrier: order.carrier,
      service_level: order.service_level,
      tracking_number: order.tracking_number,
      tracking_url: order.tracking_url,
      label_url: order.label_url,
      shipping_cost: order.shipping_cost,
    });
  }
  if (!order.address_line1 || !order.city || !order.region || !order.postal_code) {
    return json({ error: "This order is missing a complete shipping address." }, 400);
  }

  const addressTo = {
    name: order.ship_to_name || order.customer_name,
    street1: order.address_line1,
    street2: order.address_line2 || "",
    city: order.city,
    state: order.region,
    zip: order.postal_code,
    country: order.country || "US",
    email: order.email || "",
    phone: order.phone || "",
  };

  const parcelPayload = {
    length: String(parcel.length ?? 6),
    width: String(parcel.width ?? 4),
    height: String(parcel.height ?? 1),
    distance_unit: "in",
    weight: String(parcel.weight ?? 3),
    mass_unit: "oz",
  };

  // ---- create the shipment + fetch rates ----
  const ship = await shippo("/shipments/", {
    address_from: shipFrom,
    address_to: addressTo,
    parcels: [parcelPayload],
    async: false,
  }, token);
  if (!ship.ok) {
    return json({ error: "Shippo rejected the shipment.", detail: ship.data }, 502);
  }
  const rates: any[] = ship.data?.rates ?? [];
  if (!rates.length) {
    const msgs = (ship.data?.messages ?? []).map((m: any) => m.text).join(" ");
    return json({ error: "No shipping rates were returned." + (msgs ? " " + msgs : "") }, 502);
  }

  // ---- pick the rate: always the cheapest (Standard) for everyone ----
  // Rush is a production-speed upgrade, not a shipping upgrade, so the label
  // is the cheapest available rate regardless of ship_speed.
  const cheapest = (list: any[]) =>
    list.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  const chosen = cheapest(rates);

  // ---- buy the label ----
  const tx = await shippo("/transactions/", {
    rate: chosen.object_id,
    label_file_type: "PDF_4x6",
    async: false,
  }, token);
  if (!tx.ok || tx.data?.status !== "SUCCESS") {
    const msgs = (tx.data?.messages ?? []).map((m: any) => m.text).join(" ");
    return json({ error: "Could not buy the label." + (msgs ? " " + msgs : ""), detail: tx.data }, 502);
  }

  const patch = {
    carrier: chosen.provider ?? null,
    service_level: chosen.servicelevel?.name ?? null,
    tracking_number: tx.data.tracking_number ?? null,
    tracking_url: tx.data.tracking_url_provider ?? null,
    label_url: tx.data.label_url ?? null,
    shipping_cost: Number(chosen.amount),
    shipped_at: new Date().toISOString(),
    shippo_object_id: tx.data.object_id ?? null,
  };
  const { error: uErr } = await db.from("orders").update(patch).eq("id", orderId);
  if (uErr) return json({ error: "Label bought but failed to save it: " + uErr.message, ...patch }, 500);

  return json(patch);
});
