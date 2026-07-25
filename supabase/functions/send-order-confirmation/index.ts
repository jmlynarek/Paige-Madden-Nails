// ============================================================
// send-order-confirmation
// Sends the customer their "order received" confirmation the moment a
// new order comes in. Called from index.html right after the order is
// saved (see submitOrder → saveOrderToSupabase).
//
// Why a separate function from send-order-email?
//   send-order-email is ADMIN-ONLY and takes an arbitrary to/subject/html
//   — fine for the dashboard, unsafe for the public site. This function is
//   ANON-callable but deliberately narrow: the only input is an order_id.
//   The recipient is forced to that order's own email and the content is
//   forced to the "new" notification template, so an anonymous caller can
//   never send arbitrary mail to arbitrary people. Knowing a valid order_id
//   (a UUID handed back only to the person who placed the order) is the key.
//
// Sender identity + secrets: identical to send-order-email
//   (RESEND_API_KEY, MAIL_FROM, MAIL_REPLY_TO). The service-role key is
//   auto-injected as SUPABASE_SERVICE_ROLE_KEY.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// Port of admin.html's renderEmailHtml() for the confirmation ("new") case.
// The shell mirrors the order flow's design system (index.html :root vars):
// blush header with the circular gold-ringed logo, --ink/--ink-2 text, --rose
// accents — so the email reads as part of the same product the customer just
// used. Keep the two shells (this + admin.html) in visual sync if restyled.
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
  public_token?: string | null;
  quoted_price?: number | null;
  tier_price?: number | null;
  ship_fee?: number | null;
  rush_fee?: number | null;
  gift_credit?: number | null;
  design_tier?: string | null;
  nail_shape?: string | null;
  fulfillment?: string | null;
  ship_speed?: string | null;
};

function orderTotal(order: OrderRow): number {
  const setPrice = Number(order.quoted_price != null ? order.quoted_price : (order.tier_price ?? 0));
  return Math.max(0, setPrice + Number(order.ship_fee || 0) + Number(order.rush_fee || 0) - Number(order.gift_credit || 0));
}

// The styled order-summary receipt: line items + a status pill. Doubles as
// the customer's receipt; the amber pill flags that payment isn't matched yet.
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
        '<td align="right"><span style="display:inline-block;background:#FBF0E4;color:#C77A3B;' + SANS + ';font-size:11px;font-weight:600;line-height:1.4;padding:4px 11px;border-radius:12px">Pending payment verification</span></td>' +
      '</tr></table>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">' + rows +
        '<tr><td style="padding:12px 0 2px;border-top:1px solid rgba(95,70,63,0.14);' + SANS + ';font-size:15px;font-weight:700;color:#5F463F">Total due</td>' +
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
  // Placeholder substitution — mirror of admin.html renderEmailHtml() so the
  // Notifications-tab live preview and the real send agree. {{total}} = set
  // price + shipping + rush, net of any gift credit (same math as orderValue).
  const bodyRaw = (tpl.body || "")
    .replace(/\{\{\s*reorder_link\s*\}\}/g, "")
    .replace(/\{\{\s*total\s*\}\}/g, money(orderTotal(order)))
    .replace(/\{\{\s*order_no\s*\}\}/g, order.order_no != null ? "PM-" + order.order_no : "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bodyHtml = esc(bodyRaw).replace(/\n/g, "<br>");
  const orderNo = order.order_no != null ? "Order PM-" + order.order_no : "";
  const name = esc(order.customer_name || "there");
  // A permanent, login-free link to view this order and start a new one
  // later with saved sizes/details pre-filled (design blank).
  const reorderBtn = order.public_token
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td>' +
        '<a href="' + SITE_URL + '/reorder?t=' + esc(order.public_token) + '" style="display:inline-block;background:#B46869;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px;' + SANS + '">Save this link — reorder anytime</a>' +
      '</td></tr>' +
      '<tr><td style="padding:8px 0 0;color:#8C6A60;font-size:12.5px;' + SANS + '">Keep this link — you can reorder anytime and we\'ll remember your sizes.</td></tr></table>'
    : "";
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;padding:0;}</style></head>' +
    '<body style="margin:0;padding:0;background:#EBE2D9;background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%);' + SANS + ';color:#5F463F;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%)"><tr><td align="center" style="padding:34px 16px">' +
      '<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:520px;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(95,70,63,0.16)">' +
        // Header: blush band + the circular gold-ringed logo, matching the
        // order flow's welcome screen (index.html .rb-welcome__logo).
        '<tr><td align="center" style="background:#FBEBEB;background:linear-gradient(160deg,#FBEBEB 0%,#F8E4E3 100%);padding:28px 24px 24px;border-bottom:1px solid rgba(196,166,104,0.4)">' +
          '<img src="' + LOGO_URL + '" width="116" height="116" alt="Paige Madden Nails" style="display:block;width:116px;height:116px;border-radius:50%;background:#FFFFFF;padding:5px;border:1px solid rgba(196,166,104,0.9);box-shadow:0 10px 24px rgba(140,74,75,0.18)">' +
        '</td></tr>' +
        '<tr><td style="padding:32px 38px 16px">' +
          (orderNo ? '<div style="display:inline-block;background:#FBF1F0;color:#B46869;border:1px solid rgba(180,104,105,0.25);font-size:12px;font-weight:600;letter-spacing:.4px;padding:5px 12px;border-radius:999px;' + SANS + '">' + orderNo + '</div>' : "") +
          '<h1 style="' + SERIF + ';font-weight:700;color:#5F463F;font-size:30px;line-height:1.2;margin:16px 0 4px">' + heading + '</h1>' +
          '<p style="' + SANS + ';color:#8C6A60;font-size:15.5px;line-height:1.65;margin:10px 0 0">Hi ' + name + ',</p>' +
          '<p style="' + SANS + ';color:#8C6A60;font-size:15.5px;line-height:1.65;margin:8px 0 0">' + bodyHtml + '</p>' +
          receiptHtml(order) +
          reorderBtn +
        '</td></tr>' +
        '<tr><td style="padding:14px 38px 30px">' +
          '<p style="' + SERIF + ';color:#B46869;font-size:21px;margin:8px 0 0">With love, Paige 💕</p>' +
          '<hr style="border:none;border-top:1px solid #EEE3DA;margin:22px 0 14px">' +
          '<p style="' + SANS + ';color:#B8A79E;font-size:11.5px;line-height:1.55;margin:0">You\'re receiving this because you placed an order with Paige Madden Nails.</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>' +
    "</body></html>";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const orderId = (payload.order_id ?? "").toString().trim();
  if (!orderId) return json({ error: "Missing order_id." }, 400);

  // Service-role client: RLS blocks anon from reading orders back, and we
  // want the on-file email + order_no straight from the row (never trusting
  // caller-supplied recipient/content).
  const admin = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .select("id, order_no, customer_name, email, public_token, quoted_price, tier_price, ship_fee, rush_fee, gift_credit, design_tier, nail_shape, fulfillment, ship_speed")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return json({ error: "Could not load the order." }, 500);
  if (!order) return json({ error: "Order not found." }, 404);
  if (!order.email) return json({ ok: true, skipped: "no-email" });

  const { data: tpl } = await admin
    .from("notification_templates")
    .select("subject, heading, body, enabled")
    .eq("status", "new")
    .maybeSingle();
  // Respect the admin's on/off toggle — same semantics as notifyCustomer().
  if (!tpl || tpl.enabled === false) return json({ ok: true, skipped: "template-off" });

  const RESEND_API_KEY = env("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    return json({ error: "Email is not configured yet (missing RESEND_API_KEY)." }, 500);
  }
  const from = env("MAIL_FROM") || "Paige Madden Nails <onboarding@resend.dev>";
  const replyTo = env("MAIL_REPLY_TO") || "paigemaddennails@gmail.com";
  const html = renderEmailHtml(tpl, order);

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
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: (data?.message || "The email provider rejected the message."), detail: data }, 502);
  }

  return json({ ok: true, id: data?.id ?? null });
});
