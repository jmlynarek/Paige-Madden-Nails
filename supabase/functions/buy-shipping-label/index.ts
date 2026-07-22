// ============================================================
// buy-shipping-label
// Buys a USPS shipping label via Shippo for one order and writes
// the tracking number + label PDF back to the order row.
//
// Auth: caller must be the signed-in admin (jeremy@idealtraits.com).
//       This function spends money, so it refuses everyone else and
//       refuses to buy a second label for an order that already has one.
//
// Rate choice keys off the order's ship_speed (set at order time):
//   standard -> cheapest rate
//   rush     -> cheapest Priority/Express-class rate (the upgrade the
//               customer paid extra for); falls back to cheapest if the
//               carrier returns no priority tier.
//
// Secrets (set with `supabase secrets set ...`):
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

const SHIP_FROM = {
  name: env("SHIP_FROM_NAME"),
  street1: env("SHIP_FROM_STREET1"),
  street2: env("SHIP_FROM_STREET2"),
  city: env("SHIP_FROM_CITY"),
  state: env("SHIP_FROM_STATE"),
  zip: env("SHIP_FROM_ZIP"),
  country: env("SHIP_FROM_COUNTRY") || "US",
  phone: env("SHIP_FROM_PHONE"),
  // Shippo requires a from-email to buy a label, but it is NOT printed on
  // the package. Falls back to the admin email when the secret is blank.
  email: env("SHIP_FROM_EMAIL") || ADMIN_EMAIL,
};

async function shippo(path: string, body: unknown) {
  const res = await fetch(`${SHIPPO_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${env("SHIPPO_TOKEN")}`,
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
  if (!user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
    return json({ error: "Not authorized." }, 403);
  }

  if (!env("SHIPPO_TOKEN")) {
    return json({ error: "Shipping is not configured yet (missing SHIPPO_TOKEN)." }, 500);
  }
  if (!SHIP_FROM.street1 || !SHIP_FROM.zip) {
    return json({ error: "Return address is not configured yet (set the SHIP_FROM_* secrets)." }, 500);
  }
  if (!SHIP_FROM.phone) {
    return json({ error: "A return phone number is required to buy labels (set the SHIP_FROM_PHONE secret)." }, 500);
  }

  // ---- read the request ----
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const orderId = payload.order_id;
  const parcel = payload.parcel ?? {};
  if (!orderId) return json({ error: "Missing order_id." }, 400);

  // ---- load the order with the service role (bypasses RLS) ----
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
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
    address_from: SHIP_FROM,
    address_to: addressTo,
    parcels: [parcelPayload],
    async: false,
  });
  if (!ship.ok) {
    return json({ error: "Shippo rejected the shipment.", detail: ship.data }, 502);
  }
  const rates: any[] = ship.data?.rates ?? [];
  if (!rates.length) {
    const msgs = (ship.data?.messages ?? []).map((m: any) => m.text).join(" ");
    return json({ error: "No shipping rates were returned." + (msgs ? " " + msgs : "") }, 502);
  }

  // ---- pick the rate based on ship_speed ----
  const cheapest = (list: any[]) =>
    list.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  const isFast = (r: any) =>
    /priority|express/i.test(`${r?.servicelevel?.token ?? ""} ${r?.servicelevel?.name ?? ""}`);

  const rush = order.ship_speed === "rush";
  const fast = rates.filter(isFast);
  const chosen = rush ? cheapest(fast.length ? fast : rates) : cheapest(rates);

  // ---- buy the label ----
  const tx = await shippo("/transactions/", {
    rate: chosen.object_id,
    label_file_type: "PDF_4x6",
    async: false,
  });
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
