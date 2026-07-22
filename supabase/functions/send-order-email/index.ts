// ============================================================
// send-order-email
// Sends ONE customer notification email (order status update),
// genuinely FROM paigemaddennails@gmail.com via Gmail's SMTP.
// Called from admin.html's notifyCustomer() on a status change — the
// branded HTML is rendered client-side and passed in, so this function
// is a thin send step.
//
// Auth: admin-only (jeremy@idealtraits.com), same gate as buy-shipping-label.
//
// Secrets (set with `supabase secrets set ...`):
//   GMAIL_APP_PASSWORD  16-char Google App Password (requires 2FA on the
//                       account). Generate at myaccount.google.com → Security
//                       → 2-Step Verification → App passwords.
//   GMAIL_USER          optional, defaults to paigemaddennails@gmail.com
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const ADMIN_EMAIL = "jeremy@idealtraits.com";
const FROM_NAME = "Paige Madden Nails";

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

// Plain-text fallback for clients that don't render HTML.
function toText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || "Your Paige Madden Nails order update.";
}

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

  const GMAIL_USER = env("GMAIL_USER") || "paigemaddennails@gmail.com";
  const GMAIL_APP_PASSWORD = env("GMAIL_APP_PASSWORD");
  if (!GMAIL_APP_PASSWORD) {
    return json({ error: "Email is not configured yet (missing GMAIL_APP_PASSWORD)." }, 500);
  }

  // ---- read the message ----
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const to = (payload.to ?? "").trim();
  const subject = (payload.subject ?? "").trim();
  const html = payload.html ?? "";
  if (!to || !subject || !html) {
    return json({ error: "Missing recipient, subject, or body." }, 400);
  }

  // ---- send via Gmail SMTP ----
  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
    },
  });

  try {
    await client.send({
      from: `${FROM_NAME} <${GMAIL_USER}>`,
      to,
      subject,
      content: toText(html),
      html,
    });
    await client.close();
    return json({ ok: true });
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    const msg = (e && (e as any).message) ? (e as any).message : String(e);
    return json({ error: "Could not send the email: " + msg }, 502);
  }
});
