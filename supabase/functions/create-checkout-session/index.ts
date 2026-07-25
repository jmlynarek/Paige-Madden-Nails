// ============================================================
// create-checkout-session
// Creates a hosted Stripe Checkout session for one order so the
// customer can pay by card / Apple Pay / Cash App Pay. Called from
// index.html's "Pay by card" tile on the order-submitted screen.
//
// ANON-callable but deliberately narrow (same philosophy as
// send-order-confirmation): the only input is an order_id, and every
// dollar amount is computed HERE from the order row; the client can
// never choose what it pays. Knowing a valid order_id (a UUID handed
// back only to the person who placed the order) is the key.
//
// Config (admin-editable in the Integrations tab; stored in app_settings,
// seeded by migration 0018): stripe_enabled, stripe_secret_key.
// stripe_secret_key falls back to the env secret STRIPE_SECRET_KEY when
// blank, mirroring the Shippo pattern in buy-shipping-label.
//
// The money is confirmed by the stripe-webhook function (never by the
// redirect back to the site). See supabase/functions/stripe-webhook.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE_URL = "https://paigemadden.app";

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

// Where Stripe sends the customer afterwards. Only the production site or
// localhost (testing): an anon caller must not be able to turn this into
// a redirect through our checkout to an arbitrary site.
function returnBase(req: Request): string {
  const origin = req.headers.get("Origin") ?? "";
  if (origin === SITE_URL || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return origin;
  }
  return SITE_URL;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const orderId = (payload.order_id ?? "").toString().trim();
  if (!orderId) return json({ error: "Missing order_id." }, 400);

  // Service-role client: RLS blocks anon from reading orders back, and the
  // amount must come straight from the row (never from the caller).
  const db = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // ---- admin-editable config, env fallback per field (Shippo pattern) ----
  const cfg: Record<string, string> = {};
  try {
    const { data: rows } = await db.from("app_settings").select("key,value");
    (rows ?? []).forEach((r: any) => { cfg[r.key] = r.value ?? ""; });
  } catch { /* fall back to env */ }

  // Card checkout is opt-in: it stays off until the Integrations toggle is
  // flipped (unlike Shippo, there is no pre-existing behavior to preserve).
  if (cfg.stripe_enabled !== "true") {
    return json({ error: "Card payments are turned off." }, 400);
  }
  const key = (cfg.stripe_secret_key ?? "").trim() || env("STRIPE_SECRET_KEY");
  if (!key) {
    return json({ error: "Card payments are not configured yet." }, 400);
  }

  const { data: order, error: oErr } = await db
    .from("orders")
    .select("id, order_no, email, status, payment_collected, quoted_price, tier_price, ship_fee, rush_fee, gift_credit, design_tier")
    .eq("id", orderId)
    .maybeSingle();
  if (oErr) return json({ error: "Could not load the order." }, 500);
  if (!order) return json({ error: "Order not found." }, 404);
  if (order.status === "cancelled") {
    return json({ error: "This order was cancelled." }, 400);
  }
  if (order.payment_collected === true) {
    return json({ error: "This order is already paid." }, 400);
  }

  // ---- the amount due, server-side only (same math as admin orderDue) ----
  const setPrice = Number(order.quoted_price != null ? order.quoted_price : (order.tier_price ?? 0));
  const due = Math.max(0,
    setPrice + Number(order.ship_fee || 0) + Number(order.rush_fee || 0) -
    Number(order.gift_credit || 0));
  if (due < 0.5) {
    // Gift-covered (or under Stripe's $0.50 minimum), so nothing to charge.
    return json({ error: "There is nothing to pay on this order." }, 400);
  }
  const cents = Math.round(due * 100);

  const ref = order.order_no != null ? `PM-${order.order_no}` : "";
  const base = returnBase(req);
  const label = order.design_tier
    ? `${String(order.design_tier).charAt(0).toUpperCase()}${String(order.design_tier).slice(1)} press-on nail set`
    : "Press-on nail set";

  // Stripe's API is form-encoded; a plain fetch keeps this dependency-free.
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][product_data][name]", ref ? `${label} (${ref})` : label);
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][quantity]", "1");
  form.set("metadata[order_id]", order.id);
  form.set("client_reference_id", order.id);
  form.set("success_url", `${base}/?paid=1${ref ? `&code=${encodeURIComponent(ref)}` : ""}`);
  form.set("cancel_url", `${base}/?canceled=1`);
  if (order.email) form.set("customer_email", order.email);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const session: any = await res.json().catch(() => ({}));
  if (!res.ok || !session?.url) {
    console.error("Stripe session create failed", session?.error ?? session);
    return json({ error: "Could not start card checkout. Try another payment method." }, 502);
  }

  // Remember the session (latest wins if the customer starts checkout twice);
  // the webhook matches on the signed event's order_id and logs any mismatch.
  await db.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

  return json({ url: session.url });
});
