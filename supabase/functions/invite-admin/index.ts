// ============================================================
// invite-admin
// Invites a teammate to the admin dashboard. Called from admin.html's
// Users Management tab. Steps (all need the service-role key):
//   1) auth.admin.generateLink — creates the auth user (if new) and returns
//      the invite/recovery action link WITHOUT sending Supabase's own email.
//   2) send that link ourselves via Resend — branded, from the same sender as
//      customer mail (orders@paigemadden.app), reply-to the business Gmail.
//   3) upsert an 'invited' row into public.admin_users (the access allowlist).
// The invitee sets a password (admin.html's set-password screen handles the
// link) and flips to 'approved' automatically on first sign-in
// (public.claim_admin_access, called by admin.html at boot).
//
// Sending via Resend (not Supabase SMTP) means invites are as reliable as the
// rest of the app's mail — nothing to configure in the Supabase dashboard
// except the redirect allow-list (so the link is allowed to land on /admin).
//
// Auth: caller must be an already-approved admin (is_admin() gate). Everyone
// on the allowlist has the same, full access — there are no roles.
//
// Secrets (all already set for the other mail flows):
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   RESEND_API_KEY, MAIL_FROM, MAIL_REPLY_TO
//   SITE_URL (optional, defaults to https://paigemadden.app) — invite links
//            land at <SITE_URL>/admin, which must be in Supabase Auth's
//            redirect allow-list.
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
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function inviteEmailHtml(link: string, name: string) {
  const hi = name ? `Hi ${esc(name)},` : "Hi there,";
  return `<!doctype html><html><body style="margin:0;background:#FBF7F1;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3A322E">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="text-align:center;margin-bottom:8px">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;color:#B46869">Paige Madden</div>
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#A79A90">Nails · Admin</div>
    </div>
    <div style="background:#fff;border:1px solid #EFE4D6;border-radius:16px;padding:28px 26px">
      <p style="margin:0 0 12px;font-size:16px">${hi}</p>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5">You've been invited to help manage orders in the Paige Madden Nails admin. Click below to set your password and sign in — you'll have full access.</p>
      <div style="text-align:center;margin:22px 0">
        <a href="${esc(link)}" style="display:inline-block;background:#B46869;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 28px;border-radius:12px">Accept invite &amp; set password</a>
      </div>
      <p style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:#8C8078">This link is single-use and expires soon, so set your password shortly. If the button doesn't work, copy and paste this URL into your browser:</p>
      <p style="margin:6px 0 0;font-size:12px;word-break:break-all;color:#B46869">${esc(link)}</p>
    </div>
    <p style="text-align:center;margin:18px 0 0;font-size:12px;color:#A79A90">If you weren't expecting this, you can ignore this email.</p>
  </div></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = env("SUPABASE_URL");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

  // ---- verify the caller is an approved admin ----
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await asUser.auth.getUser();
  const { data: isAdmin } = await asUser.rpc("is_admin");
  if (!user || isAdmin !== true) {
    return json({ error: "Not authorized." }, 403);
  }

  const RESEND_API_KEY = env("RESEND_API_KEY");
  if (!RESEND_API_KEY) {
    return json({ error: "Email is not configured yet (missing RESEND_API_KEY)." }, 500);
  }

  // ---- read + validate input ----
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  const email = String(payload.email ?? "").trim().toLowerCase();
  const name = String(payload.name ?? "").trim();
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "A valid email is required." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- don't demote an already-active admin ----
  const { data: existing } = await admin
    .from("admin_users")
    .select("id,status")
    .eq("email", email)
    .maybeSingle();
  if (existing && existing.status === "approved") {
    return json({ error: "That person is already an active admin." }, 409);
  }

  // ---- generate the action link (creates the auth user for a new invite) ----
  const redirectTo = (env("SITE_URL") || "https://paigemadden.app") + "/admin";
  let link = "";
  let gen = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo, data: name ? { full_name: name } : undefined },
  });
  if (gen.error) {
    // Most commonly: the auth account already exists. Fall back to a recovery
    // (set-password) link so they can still get in.
    const alreadyRegistered = /already|registered|exist/i.test(gen.error.message ?? "");
    if (!alreadyRegistered) {
      return json({ error: gen.error.message || "Couldn't create the invite link." }, 502);
    }
    gen = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });
    if (gen.error) {
      return json({ error: gen.error.message || "Couldn't create the invite link." }, 502);
    }
  }
  link = gen.data?.properties?.action_link ?? "";
  if (!link) {
    return json({ error: "Couldn't create the invite link." }, 502);
  }

  // ---- send the branded invite via Resend ----
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
      to: [email],
      reply_to: replyTo,
      subject: "You're invited to the Paige Madden Nails admin",
      html: inviteEmailHtml(link, name),
    }),
  });
  const mail = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: mail?.message || "The email provider rejected the invite." }, 502);
  }

  // ---- record the allowlist row (invited) ----
  const { error: rowErr } = await admin.from("admin_users").upsert({
    email,
    name: name || null,
    status: "invited",
    invited_by: user.email ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "email" });
  if (rowErr) {
    return json({ error: rowErr.message }, 500);
  }

  return json({ ok: true, id: mail?.id ?? null });
});
