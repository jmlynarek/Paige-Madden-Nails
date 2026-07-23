// ============================================================
// send-reengagement
// The daily "30-day nudge" sender. Finds scheduled_sends that are due,
// emails each customer a soft "want a new set? we saved your sizes"
// message (with a /reorder link + unsubscribe link), and stamps the
// queue row sent/failed.
//
// NOT user-callable. It's meant to be hit once a day by pg_cron via
// pg_net (set up in the Supabase dashboard). Because there's no admin
// JWT in a cron call, it's gated by a shared secret header instead:
//   x-reengage-secret: <REENGAGE_CRON_SECRET>
// It FAILS CLOSED — if REENGAGE_CRON_SECRET is unset, every call is
// rejected. Deploy with verify_jwt = false so the header gate applies.
//
// Safe by construction: recipients come only from each order's own
// on-file email (never caller-supplied), opted-out emails are skipped,
// and it respects the template on/off + the app_settings master switch.
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-reengage-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const env = (k: string) => Deno.env.get(k) ?? "";
const SITE_URL = "https://paigemadden.app";

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// Constant-time string compare (same idea as forward-inbound-email).
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a), bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

// Branded shell (port of admin.html renderEmailHtml) with a reorder CTA
// and an unsubscribe footer link. {{reorder_link}} in the body is stripped
// — the CTA button carries the link.
function renderEmailHtml(
  tpl: { heading?: string; body?: string },
  order: { order_no?: number | null; customer_name?: string | null; public_token?: string | null },
): string {
  const heading = esc(tpl.heading || "");
  const bodyHtml = esc((tpl.body || "").replace(/\{\{\s*reorder_link\s*\}\}/g, "").trim())
    .replace(/\n/g, "<br>");
  const orderNo = order.order_no != null ? "Order PM-" + order.order_no : "";
  const name = esc(order.customer_name || "there");
  const reorderUrl = SITE_URL + "/reorder?t=" + esc(order.public_token || "");
  const unsubUrl = SITE_URL + "/unsubscribe?t=" + esc(order.public_token || "");
  const cta =
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr><td>' +
      '<a href="' + reorderUrl + '" style="display:inline-block;background:#B46869;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:999px;font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif">Start a new order</a>' +
    '</td></tr></table>';
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link href="https://fonts.googleapis.com/css2?family=Pinyon+Script&family=Cormorant+Garamond:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;padding:0;}</style></head>' +
    '<body style="margin:0;padding:0;background:#EBE2D9;background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%);font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif;color:#5F463F;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(160deg,#F2ECE6 0%,#E7DDD4 100%)"><tr><td align="center" style="padding:34px 16px">' +
      '<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="width:520px;max-width:520px;background:#FFFDFB;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(95,70,63,0.16)">' +
        '<tr><td align="center" style="background:#B46869;padding:30px 24px 26px">' +
          '<div style="font-family:\'Pinyon Script\',cursive;color:#FFF;font-size:40px;line-height:1">Paige Madden</div>' +
          '<div style="font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif;color:rgba(255,255,255,0.86);font-size:12px;letter-spacing:4px;text-transform:uppercase;margin-top:2px">Nails</div>' +
        '</td></tr>' +
        '<tr><td style="padding:34px 38px 16px">' +
          (orderNo ? '<div style="display:inline-block;background:#FBF1F0;color:#B46869;font-size:12px;font-weight:600;letter-spacing:.4px;padding:5px 12px;border-radius:999px;font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif">' + orderNo + '</div>' : "") +
          '<h1 style="font-family:\'Cormorant Garamond\',Georgia,serif;font-weight:700;color:#5F463F;font-size:30px;line-height:1.2;margin:16px 0 4px">' + heading + '</h1>' +
          '<p style="font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif;color:#8C6A60;font-size:15.5px;line-height:1.65;margin:10px 0 0">Hi ' + name + ',</p>' +
          '<p style="font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif;color:#8C6A60;font-size:15.5px;line-height:1.65;margin:8px 0 0">' + bodyHtml + '</p>' +
          cta +
        '</td></tr>' +
        '<tr><td style="padding:14px 38px 30px">' +
          '<p style="font-family:\'Cormorant Garamond\',Georgia,serif;color:#B46869;font-size:21px;margin:8px 0 0">With love, Paige 💕</p>' +
          '<hr style="border:none;border-top:1px solid #EEE3DA;margin:22px 0 14px">' +
          '<p style="font-family:\'Hanken Grotesk\',Helvetica,Arial,sans-serif;color:#B8A79E;font-size:11.5px;line-height:1.55;margin:0">You\'re receiving this because you ordered with Paige Madden Nails. ' +
            '<a href="' + unsubUrl + '" style="color:#B8A79E;text-decoration:underline">Unsubscribe from reminders</a>.</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>' +
    "</body></html>";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ---- Shared-secret gate (fail closed) ----
  const secret = env("REENGAGE_CRON_SECRET");
  if (!secret) return json({ error: "Not configured (missing REENGAGE_CRON_SECRET)." }, 503);
  const provided = req.headers.get("x-reengage-secret") ?? "";
  if (!safeEqual(provided, secret)) return json({ error: "Forbidden." }, 403);

  const admin = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  // Master switch.
  const { data: setting } = await admin
    .from("app_settings").select("value").eq("key", "reengage_enabled").maybeSingle();
  if (setting && String(setting.value).toLowerCase() === "false") {
    return json({ ok: true, skipped: "disabled", sent: 0 });
  }

  // Template (respect the on/off toggle).
  const { data: tpl } = await admin
    .from("notification_templates")
    .select("subject, heading, body, enabled")
    .eq("status", "re_engagement").maybeSingle();
  if (!tpl || tpl.enabled === false) return json({ ok: true, skipped: "template-off", sent: 0 });

  // Due sends + their order rows.
  const today = new Date().toISOString().slice(0, 10);
  const { data: due, error: dueErr } = await admin
    .from("scheduled_sends")
    .select("id, order_id, orders(order_no, customer_name, email, public_token)")
    .eq("kind", "reengage_30d")
    .eq("status", "scheduled")
    .lte("scheduled_for", today)
    .limit(200);
  if (dueErr) return json({ error: "Could not load the send queue.", detail: dueErr }, 500);
  if (!due || !due.length) return json({ ok: true, sent: 0 });

  // Opt-out set.
  const { data: optRows } = await admin.from("email_optouts").select("email");
  const optedOut = new Set((optRows || []).map((r: any) => String(r.email || "").toLowerCase()));

  const RESEND_API_KEY = env("RESEND_API_KEY");
  if (!RESEND_API_KEY) return json({ error: "Email not configured (missing RESEND_API_KEY)." }, 500);
  const from = env("MAIL_FROM") || "Paige Madden Nails <onboarding@resend.dev>";
  const replyTo = env("MAIL_REPLY_TO") || "paigemaddennails@gmail.com";

  let sent = 0, skipped = 0, failed = 0;
  for (const row of due as any[]) {
    const order = row.orders || {};
    const email = String(order.email || "").trim();
    if (!email) { // nothing to send to → close the row out so it doesn't linger
      await admin.from("scheduled_sends").update({ status: "cancelled" }).eq("id", row.id);
      skipped++; continue;
    }
    if (optedOut.has(email.toLowerCase())) {
      await admin.from("scheduled_sends").update({ status: "cancelled" }).eq("id", row.id);
      skipped++; continue;
    }
    const html = renderEmailHtml(tpl, order);
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [email], reply_to: replyTo, subject: tpl.subject, html }),
      });
      if (!res.ok) {
        await admin.from("scheduled_sends").update({ status: "failed" }).eq("id", row.id);
        failed++; continue;
      }
      await admin.from("scheduled_sends")
        .update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
      sent++;
    } catch (_e) {
      await admin.from("scheduled_sends").update({ status: "failed" }).eq("id", row.id);
      failed++;
    }
  }

  return json({ ok: true, sent, skipped, failed });
});
