// ============================================================
// stripe-webhook
// Stripe calls this when a Checkout session finishes paying. It is the
// ONLY thing that marks a card payment as collected, never the redirect
// back to the site (a redirect can be faked; a signed webhook cannot).
//
// On checkout.session.completed / checkout.session.async_payment_succeeded
// with payment_status='paid', keyed by the session's metadata:
//   metadata.order_id (an order): payment_collected = true, paid_at,
//     paid_via = 'stripe', then the "Payment verified" email: the same
//     email admin.html's setPaymentCollected() sends on a manual flip,
//     with the same guards (only a real not-collected -> collected flip,
//     and never once the order is completed/cancelled).
//   metadata.gift_id (a "Send a gift" purchase): stamps paid_at /
//     paid_via = 'stripe' on the gift_cards row but leaves it 'pending'.
//     Deliberately NO email and NO issue here: Paige's "Issue & send" in
//     admin stays the single action that releases the code, emails the
//     recipient/buyer, and spawns the physical card's shipment order.
//
// AUTH: public webhook (no Supabase JWT), so deploy with verify_jwt=false.
// It authenticates the caller itself by verifying Stripe's signature
// (HMAC-SHA256 over "t.rawBody", hex, from the Stripe-Signature header)
// and FAILS CLOSED: no signing secret configured -> every request rejected.
//
// Config: stripe_webhook_secret in app_settings (Integrations tab card,
// migration 0018), falling back to the env secret STRIPE_WEBHOOK_SECRET.
// Email secrets are the same as send-order-email/-confirmation
// (RESEND_API_KEY, MAIL_FROM, MAIL_REPLY_TO).
//
// Idempotent: Stripe retries webhooks, so an already-collected order is
// acked with 200 and nothing re-sends.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// Constant-time string compare so signature checks don't leak via timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verify a Stripe-signed webhook. Header: "t=<unix>,v1=<hexsig>[,v1=...]".
// Signed content is `${t}.${rawBody}`, HMAC-SHA256 with the whsec_ secret's
// LITERAL characters as the key (unlike Svix, no base64 decode), hex output.
async function verifyStripe(secret: string, sigHeader: string, rawBody: string): Promise<boolean> {
  if (!secret || !sigHeader) return false;
  const parts: Record<string, string[]> = {};
  sigHeader.split(",").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim();
    (parts[k] = parts[k] ?? []).push(v);
  });
  const t = parts["t"]?.[0];
  const sigs = parts["v1"] ?? [];
  if (!t || !sigs.length) return false;

  // Reject stale timestamps (>5 min skew) to blunt replay attacks.
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s.toLowerCase(), expected));
}

// ---- "Payment verified" email ----------------------------------------
// Port of admin.html's renderEmailHtml() for the payment_verified case,
// the third copy of the shared shell (admin.html + send-order-confirmation
// + here). Keep the three in visual sync if restyled. Green "verified"
// pill + "Total paid" where the confirmation email shows amber "pending".
const SITE_URL = "https://paigemadden.app";
const LOGO_URL = SITE_URL + "/logo.jpeg";
const SANS = "font-family:'Hanken Grotesk',Helvetica,Arial,sans-serif";
const SERIF = "font-family:'Cormorant Garamond',Georgia,serif";

function money(n: unknown): string {
  const v = Number(n || 0);
  return "$" + v.toLocaleString("en-US", {
    minimumFractionDigits: v % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function cap(s: unknown): string {
  const t = String(s || "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

type OrderRow = {
  order_no?: number | null;
  customer_name?: string | null;
  quoted_price?: number | null;
  tier_price?: number | null;
  ship_fee?: number | null;
  rush_fee?: number | null;
  gift_credit?: number | null;
  design_tier?: string | null;
  nail_shape?: string | null;
  fulfillment?: string | null;
};

function orderTotal(order: OrderRow): number {
  const setPrice = Number(order.quoted_price != null ? order.quoted_price : (order.tier_price ?? 0));
  return Math.max(0, setPrice + Number(order.ship_fee || 0) + Number(order.rush_fee || 0) - Number(order.gift_credit || 0));
}

function receiptHtml(order: OrderRow): string {
  const setPrice = Number(order.quoted_price != null ? order.quoted_price : (order.tier_price ?? 0));
  const ship = Number(order.ship_fee || 0);
  const rush = Number(order.rush_fee || 0);
  const gift = Number(order.gift_credit || 0);
  const item = (label: string, sub: string, value: string, valStyle = "") =>
    '<tr><td style="padding:8px 0;' + SANS + ';font-size:14px;font-weight:500;color:#5F463F">' + label +
    (sub ? '<div style="font-size:12.5px;font-weight:400;color:#8C6A60;margin-top:2px">' + sub + '</div>' : "") +
    '</td><td align="right" valign="top" style="padding:8px 0;' + SANS + ';font-size:14px;color:#5F463F;' + valStyle + '">' + value + '</td></tr>';
  let rows = item(
    esc(cap(order.design_tier)) + " press-on set",
    esc(order.nail_shape || ""),
    money(setPrice),
  );
  if (order.fulfillment === "shipping") rows += item("Shipping", "", money(ship));
  else rows += item("Pickup", "", "Free", "color:#8C6A60");
  if (rush > 0) rows += item("Rush production", "", money(rush));
  if (gift > 0) rows += item("Gift card", "", "−" + money(gift), "color:#B46869");
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border:1px solid rgba(95,70,63,0.14);border-radius:16px;background:#FAF6F2"><tr><td style="padding:18px 20px 16px">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="' + SANS + ';font-size:11px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:rgba(95,70,63,0.62)">Order summary</td>' +
        '<td align="right"><span style="display:inline-block;background:#E5F4EA;color:#2BA05A;' + SANS + ';font-size:11px;font-weight:600;line-height:1.4;padding:4px 11px;border-radius:12px">✓ Payment verified</span></td>' +
      '</tr></table>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">' + rows +
        '<tr><td style="padding:12px 0 2px;border-top:1px solid rgba(95,70,63,0.14);' + SANS + ';font-size:15px;font-weight:700;color:#5F463F">Total paid</td>' +
        '<td align="right" style="padding:12px 0 2px;border-top:1px solid rgba(95,70,63,0.14);' + SANS + ';font-size:18px;font-weight:700;color:#B46869">' + money(orderTotal(order)) + '</td></tr>' +
      '</table>' +
    '</td></tr></table>'
  );
}

function renderEmailHtml(
  tpl: { heading?: string; body?: string },
  order: OrderRow,
): string {
  const heading = esc(tpl.heading || "");
  const bodyRaw = (tpl.body || "")
    .replace(/\{\{\s*reorder_link\s*\}\}/g, "")
    .replace(/\{\{\s*total\s*\}\}/g, money(orderTotal(order)))
    .replace(/\{\{\s*order_no\s*\}\}/g, order.order_no != null ? "PM-" + order.order_no : "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bodyHtml = esc(bodyRaw).replace(/\n/g, "<br>");
  const orderNo = order.order_no != null ? "Order PM-" + order.order_no : "";
  const name = esc(order.customer_name || "there");
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;padding:0;}</style></head>' +
    '<body style="margin:0;padding:0;background:#EBE2D9;background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%);' + SANS + ';color:#5F463F;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%)"><tr><td align="center" style="padding:34px 16px">' +
      '<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(95,70,63,0.16)">' +
        '<tr><td align="center" style="background:#FBEBEB;background:linear-gradient(160deg,#FBEBEB 0%,#F8E4E3 100%);padding:28px 24px 24px;border-bottom:1px solid rgba(196,166,104,0.4)">' +
          '<img src="' + LOGO_URL + '" width="116" height="116" alt="Paige Madden Nails" style="display:block;width:116px;height:116px;border-radius:50%;background:#FFFFFF;padding:5px;border:1px solid rgba(196,166,104,0.9);box-shadow:0 10px 24px rgba(140,74,75,0.18)">' +
        '</td></tr>' +
        '<tr><td style="padding:32px 38px 16px">' +
          (orderNo ? '<div style="display:inline-block;background:#FBF1F0;color:#B46869;border:1px solid rgba(180,104,105,0.25);font-size:12px;font-weight:600;letter-spacing:.4px;padding:5px 12px;border-radius:999px;' + SANS + '">' + orderNo + '</div>' : "") +
          '<h1 style="' + SERIF + ';font-weight:700;color:#5F463F;font-size:30px;line-height:1.2;margin:16px 0 4px">' + heading + '</h1>' +
          '<p style="' + SANS + ';color:#8C6A60;font-size:15.5px;line-height:1.65;margin:10px 0 0">Hi ' + name + ',</p>' +
          '<p style="' + SANS + ';color:#8C6A60;font-size:15.5px;line-height:1.65;margin:8px 0 0">' + bodyHtml + '</p>' +
          receiptHtml(order) +
        '</td></tr>' +
        '<tr><td style="padding:14px 38px 30px">' +
          '<p style="' + SERIF + ';color:#B46869;font-size:21px;margin:8px 0 0">With love, Paige</p>' +
          '<hr style="border:none;border-top:1px solid #EEE3DA;margin:22px 0 14px">' +
          '<p style="' + SANS + ';color:#B8A79E;font-size:11.5px;line-height:1.55;margin:0">You\'re receiving this because you placed an order with Paige Madden Nails.</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>' +
    "</body></html>";
}

// -----------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();

  const db = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // ---- config: app_settings first, env fallback (fail closed) ----
  const cfg: Record<string, string> = {};
  try {
    const { data: rows } = await db.from("app_settings").select("key,value");
    (rows ?? []).forEach((r: any) => { cfg[r.key] = r.value ?? ""; });
  } catch { /* fall back to env */ }
  const secret = (cfg.stripe_webhook_secret ?? "").trim() || env("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    console.error("No Stripe webhook secret configured; rejecting webhook.");
    return new Response("Not configured", { status: 500 });
  }

  const ok = await verifyStripe(secret, req.headers.get("Stripe-Signature") ?? "", rawBody);
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let event: any = {};
  try { event = JSON.parse(rawBody); } catch { return new Response("Bad JSON", { status: 400 }); }

  // Only the two "checkout finished paying" events matter; ack the rest so
  // Stripe doesn't retry them. (async_payment_succeeded covers methods that
  // confirm after the redirect, e.g. some bank-based ones.)
  const type = event?.type ?? "";
  if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded") {
    return new Response("ok", { status: 200 });
  }
  const session: any = event?.data?.object ?? {};
  if (session.payment_status !== "paid") return new Response("ok", { status: 200 });

  // ---- gift purchase: mark the money as arrived, nothing else ----
  const giftId = session?.metadata?.gift_id;
  if (giftId) {
    const { data: gift, error: gLoadErr } = await db
      .from("gift_cards")
      .select("id, purchase_ref, status, paid_at")
      .eq("id", giftId)
      .maybeSingle();
    if (gLoadErr) return new Response("Gift lookup failed", { status: 500 }); // retryable
    if (!gift) {
      console.error("Stripe webhook for unknown gift", giftId, session.id);
      return new Response("ok", { status: 200 });
    }
    if (gift.paid_at) return new Response("ok", { status: 200 }); // retry no-op
    const { error: gUpdErr } = await db.from("gift_cards").update({
      paid_at: new Date().toISOString(),
      paid_via: "stripe",
      stripe_session_id: session.id ?? null,
    }).eq("id", gift.id);
    if (gUpdErr) {
      console.error("Failed to mark gift paid", gift.id, gUpdErr.message);
      return new Response("Update failed", { status: 500 }); // let Stripe retry
    }
    return new Response("ok", { status: 200 });
  }

  const orderId = session?.metadata?.order_id;
  if (!orderId) return new Response("ok", { status: 200 });

  const { data: order, error: oErr } = await db
    .from("orders")
    .select("id, order_no, customer_name, email, status, payment_collected, stripe_session_id, quoted_price, tier_price, ship_fee, rush_fee, gift_credit, design_tier, nail_shape, fulfillment")
    .eq("id", orderId)
    .maybeSingle();
  if (oErr) return new Response("Order lookup failed", { status: 500 }); // retryable
  if (!order) {
    console.error("Stripe webhook for unknown order", orderId, session.id);
    return new Response("ok", { status: 200 });
  }
  if (order.payment_collected === true) return new Response("ok", { status: 200 }); // retry no-op
  if (order.stripe_session_id && order.stripe_session_id !== session.id) {
    // Signed event + our own order_id metadata is authoritative; an older
    // session id on file just means the customer restarted checkout.
    console.warn("Session id mismatch (paying an older session?)", order.id, session.id);
  }

  const { error: uErr } = await db.from("orders").update({
    payment_collected: true,
    paid_at: new Date().toISOString(),
    paid_via: "stripe",
    stripe_session_id: session.id ?? order.stripe_session_id ?? null,
  }).eq("id", order.id);
  if (uErr) {
    console.error("Failed to mark order paid", order.id, uErr.message);
    return new Response("Update failed", { status: 500 }); // let Stripe retry
  }

  // ---- the "Payment verified" email (best-effort; money is already marked) ----
  // Same guards as admin.html setPaymentCollected(): never after completed/
  // cancelled, respect the template's on/off toggle, need an email on file.
  if (order.email && order.status !== "completed" && order.status !== "cancelled") {
    try {
      const { data: tpl } = await db
        .from("notification_templates")
        .select("subject, heading, body, enabled")
        .eq("status", "payment_verified")
        .maybeSingle();
      const RESEND_API_KEY = env("RESEND_API_KEY");
      if (tpl && tpl.enabled !== false && RESEND_API_KEY) {
        const from = env("MAIL_FROM") || "Paige Madden Nails <onboarding@resend.dev>";
        const replyTo = env("MAIL_REPLY_TO") || "paigemaddennails@gmail.com";
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [order.email],
            reply_to: replyTo,
            subject: tpl.subject,
            html: renderEmailHtml(tpl, order),
          }),
        });
        if (!res.ok) console.error("payment_verified email failed", await res.text().catch(() => ""));
      }
    } catch (e) {
      console.error("payment_verified email errored", String(e));
    }
  }

  return new Response("ok", { status: 200 });
});
