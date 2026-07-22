// ============================================================
// send-order-email
// Sends ONE customer notification email (order status update) via
// Resend. Called from admin.html's notifyCustomer() on a status change
// — the branded HTML is rendered client-side and passed in, so this
// function is a thin, provider-specific send step.
//
// Sender identity: "Paige Madden Nails <orders@paigemadden.app>" with
// reply-to set to the Gmail, so customers see the brand and replies land
// in paigemaddennails@gmail.com.
//
// Auth: admin-only (jeremy@idealtraits.com), same gate as buy-shipping-label.
//
// Secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY   re_...  (from https://resend.com)
//   MAIL_FROM        e.g. "Paige Madden Nails <orders@paigemadden.app>"
//                    (requires the domain verified in Resend). Defaults to
//                    Resend's onboarding sender for immediate testing, which
//                    only delivers to the Resend account owner's own email.
//   MAIL_REPLY_TO    defaults to paigemaddennails@gmail.com
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "jeremy@idealtraits.com";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ---- verify the caller is the admin ----
  const asUser = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user || (user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
    return json({ error: "Not authorized." }, 403);
  }

  const RESEND_API_KEY = env("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    return json({ error: "Email is not configured yet (missing RESEND_API_KEY)." }, 500);
  }
  const from = env("MAIL_FROM") || "Paige Madden Nails <onboarding@resend.dev>";
  const replyTo = env("MAIL_REPLY_TO") || "paigemaddennails@gmail.com";

  // ---- read the message ----
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const to = (payload.to ?? "").trim();
  const subject = (payload.subject ?? "").trim();
  const html = payload.html ?? "";
  if (!to || !subject || !html) {
    return json({ error: "Missing recipient, subject, or body." }, 400);
  }

  // ---- send via Resend ----
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: (data?.message || "The email provider rejected the message."), detail: data }, 502);
  }

  return json({ ok: true, id: data?.id ?? null });
});
