// ============================================================
// create-checkout-session
// Creates a hosted Stripe Checkout session so the customer can pay by
// card / Apple Pay / Cash App Pay. Two callers, both from index.html:
//   { order_id }: the "Pay by card" tile on the order-submitted screen
//   { gift_ref }: the same tile on the gift-purchase confirmation
//     (PMG-### purchase_ref; prices face value + ship_fee, and the card
//     stays 'pending' until Paige issues it; the webhook only marks
//     the money as arrived)
//
// ANON-callable but deliberately narrow (same philosophy as
// send-order-confirmation): the only inputs are ids/refs handed back
// solely to the person who created them, and every dollar amount is
// computed HERE from the row; the client can never choose what it pays.
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

// Stripe's API is form-encoded; a plain fetch keeps this dependency-free.
async function createStripeSession(key: string, form: URLSearchParams) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const session: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !!session?.url, session };
}

function baseForm(cents: number, label: string): URLSearchParams {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][product_data][name]", label);
  form.set("line_items[0][price_data][unit_amount]", String(cents));
  form.set("line_items[0][quantity]", "1");
  return form;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const orderId = (payload.order_id ?? "").toString().trim();
  const giftRef = (payload.gift_ref ?? "").toString().trim().toUpperCase();
  if (!orderId && !giftRef) return json({ error: "Missing order_id or gift_ref." }, 400);

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

  const base = returnBase(req);

  // ---- gift purchase branch (PMG-### ref from create_gift_purchase) ----
  // The redeemable code never travels here; paying does NOT issue the card.
  // The webhook stamps paid_at and Paige still issues from admin.
  if (giftRef) {
    const { data: gift, error: gErr } = await db
      .from("gift_cards")
      .select("id, purchase_ref, status, amount, ship_fee, paid_at, buyer_email")
      .eq("purchase_ref", giftRef)
      .maybeSingle();
    if (gErr) return json({ error: "Could not load the gift purchase." }, 500);
    if (!gift) return json({ error: "Gift purchase not found." }, 404);
    if (gift.paid_at) return json({ error: "This gift is already paid." }, 400);
    if (gift.status !== "pending") {
      return json({ error: "This gift purchase is no longer awaiting payment." }, 400);
    }

    const dueGift = Number(gift.amount || 0) + Number(gift.ship_fee || 0);
    if (dueGift < 0.5) return json({ error: "There is nothing to pay on this gift." }, 400);

    const form = baseForm(
      Math.round(dueGift * 100),
      `Gift card (${gift.purchase_ref})` + (Number(gift.ship_fee || 0) > 0 ? " + shipping" : ""),
    );
    form.set("metadata[gift_id]", gift.id);
    form.set("client_reference_id", gift.id);
    form.set("success_url", `${base}/?giftpaid=1&ref=${encodeURIComponent(gift.purchase_ref)}`);
    form.set("cancel_url", `${base}/?canceled=1`);
    if (gift.buyer_email) form.set("customer_email", gift.buyer_email);

    const { ok, session } = await createStripeSession(key, form);
    if (!ok) {
      console.error("Stripe gift session create failed", session?.error ?? session);
      return json({ error: "Could not start card checkout. Try another payment method." }, 502);
    }
    await db.from("gift_cards").update({ stripe_session_id: session.id }).eq("id", gift.id);
    return json({ url: session.url });
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
  const label = order.design_tier
    ? `${String(order.design_tier).charAt(0).toUpperCase()}${String(order.design_tier).slice(1)} press-on nail set`
    : "Press-on nail set";

  const form = baseForm(cents, ref ? `${label} (${ref})` : label);
  form.set("metadata[order_id]", order.id);
  form.set("client_reference_id", order.id);
  form.set("success_url", `${base}/?paid=1${ref ? `&code=${encodeURIComponent(ref)}` : ""}`);
  form.set("cancel_url", `${base}/?canceled=1`);
  if (order.email) form.set("customer_email", order.email);

  const { ok, session } = await createStripeSession(key, form);
  if (!ok) {
    console.error("Stripe session create failed", session?.error ?? session);
    return json({ error: "Could not start card checkout. Try another payment method." }, 502);
  }

  // Remember the session (latest wins if the customer starts checkout twice);
  // the webhook matches on the signed event's order_id and logs any mismatch.
  await db.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);

  return json({ url: session.url });
});
