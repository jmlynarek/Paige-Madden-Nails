// ============================================================
// forward-inbound-email
// Resend Inbound webhook receiver. When a customer replies to
// orders@paigemadden.app (which has no mailbox of its own), Resend
// receives it and POSTs an "email.received" event here; this function
// fetches the full message and re-sends it to the business Gmail, with
// Reply-To set to the original customer so Paige can just hit "reply".
//
// This closes the reply-to gap: some mail clients answer the From
// (orders@paigemadden.app) instead of the Reply-To (the Gmail), and
// those replies used to vanish because the apex had no MX / inbox.
//
// AUTH: this is a public webhook (no Supabase JWT), so it is deployed
// with verify_jwt=false and authenticates the caller itself by verifying
// the Svix signature Resend attaches. It FAILS CLOSED — if the signing
// secret is unset or the signature doesn't match, the request is rejected.
//
// Secrets (set by the user in the dashboard — Claude does not set these):
//   RESEND_API_KEY          re_...  (reused from the sending setup)
//   RESEND_INBOUND_SECRET   whsec_... (the webhook's signing secret,
//                           shown in Resend when you create the webhook)
//   MAIL_FROM               "Paige Madden Nails <orders@paigemadden.app>"
//   INBOUND_FORWARD_TO      optional; defaults to paigemaddennails@gmail.com
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const env = (k: string) => Deno.env.get(k) ?? "";

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// "Ada Lovelace <ada@x.com>" -> "ada@x.com"; passes a bare address through.
function bareEmail(s: string): string {
  const m = /<([^>]+)>/.exec(s || "");
  return (m ? m[1] : (s || "")).trim();
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

// Constant-time string compare so signature checks don't leak via timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verify a Svix-signed webhook (the scheme Resend uses). The signed content
// is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the secret (the bytes
// after the `whsec_` prefix, base64-decoded), compared against each v1 sig in
// the space-delimited svix-signature header.
async function verifySvix(
  secret: string,
  id: string,
  timestamp: string,
  sigHeader: string,
  rawBody: string,
): Promise<boolean> {
  if (!secret || !id || !timestamp || !sigHeader) return false;

  // Reject stale timestamps (>5 min skew) to blunt replay attacks.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const keyBytes = b64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = bytesToB64(new Uint8Array(mac));

  // Header looks like: "v1,<sig> v1,<sig2>"
  return sigHeader.split(" ").some((part) => {
    const sig = part.split(",")[1];
    return !!sig && timingSafeEqual(sig, expected);
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();

  // ---- authenticate the webhook (fail closed) ----
  const secret = env("RESEND_INBOUND_SECRET");
  if (!secret) {
    console.error("RESEND_INBOUND_SECRET is not set — rejecting webhook.");
    return new Response("Not configured", { status: 500 });
  }
  const ok = await verifySvix(
    secret,
    req.headers.get("svix-id") ?? "",
    req.headers.get("svix-timestamp") ?? "",
    req.headers.get("svix-signature") ?? "",
    rawBody,
  );
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let event: any = {};
  try { event = JSON.parse(rawBody); } catch { return new Response("Bad JSON", { status: 400 }); }
  // Ack anything that isn't an inbound message so Resend doesn't retry it.
  if (event?.type !== "email.received") return new Response("ok", { status: 200 });

  const emailId = event?.data?.email_id;
  if (!emailId) return new Response("ok", { status: 200 });

  const RESEND_API_KEY = env("RESEND_API_KEY");
  const from = env("MAIL_FROM") || "Paige Madden Nails <orders@paigemadden.app>";
  const forwardTo = env("INBOUND_FORWARD_TO") || "paigemaddennails@gmail.com";

  // ---- fetch the full message (the webhook only carries metadata) ----
  const getRes = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    { headers: { Authorization: `Bearer ${RESEND_API_KEY}` } },
  );
  if (!getRes.ok) {
    console.error("Could not fetch received email", emailId, await getRes.text().catch(() => ""));
    return new Response("Fetch failed", { status: 502 });
  }
  const mail: any = await getRes.json();

  const senderRaw = String(mail.from || "");
  const sender = bareEmail(senderRaw);
  const subject = mail.subject || "(no subject)";
  const origTo = Array.isArray(mail.to) ? mail.to.join(", ") : (mail.to || "");
  const atts = Array.isArray(mail.attachments) ? mail.attachments : [];

  // A small banner so Paige sees at a glance who this is from and that a plain
  // reply reaches the customer. Attachment CONTENT isn't forwarded in this v1
  // (the retrieve payload is metadata only) — we list the filenames and point
  // to the Resend dashboard for the originals.
  const banner =
    '<div style="font:14px/1.6 -apple-system,Segoe UI,Arial,sans-serif;background:#FBF1F0;color:#8C6A60;padding:12px 16px;border-radius:10px;margin:0 0 16px">' +
      "↩ <strong>Reply to this email to answer " + esc(senderRaw) + " directly.</strong><br>" +
      "Received at " + esc(origTo || "orders@paigemadden.app") +
      (atts.length
        ? "<br>📎 " + atts.length + " attachment" + (atts.length === 1 ? "" : "s") + " (" +
          esc(atts.map((a: any) => a.filename || "file").join(", ")) +
          ") — open the message in the Resend dashboard for the originals."
        : "") +
    "</div>";

  const bodyHtml = mail.html || (mail.text ? "<pre style=\"white-space:pre-wrap;font:14px/1.6 -apple-system,Segoe UI,Arial,sans-serif\">" + esc(mail.text) + "</pre>" : "<em>(empty message)</em>");
  const html = banner + bodyHtml;
  const text = "↩ Reply to this email to answer " + senderRaw + " directly.\n" +
    "Received at " + (origTo || "orders@paigemadden.app") + "\n\n" + (mail.text || "");

  // ---- re-send to the Gmail, Reply-To = the original customer ----
  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [forwardTo],
      reply_to: sender || undefined,
      subject: subject,
      html,
      text,
    }),
  });
  if (!sendRes.ok) {
    console.error("Forward send failed", await sendRes.text().catch(() => ""));
    return new Response("Send failed", { status: 502 });
  }

  return new Response("ok", { status: 200 });
});
