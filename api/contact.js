// Contact form endpoint: POST /api/contact
//
// Every message is stored with the sender's IP address and approximate
// location (city, region, country) so spam and abuse can be spotted and
// blocked. Both come from headers Vercel adds to each request. Nothing is
// looked up from a third party, and the latitude/longitude headers are never
// read. Visitors see a notice about this before they press Send (above the
// form in index.html, in full in privacy.html). If you change what's
// collected here, update both pages.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  required  API key from https://resend.com/api-keys
//   CONTACT_TO      optional  Inbox that receives messages. With Resend's test
//                             sender this must be your Resend account's email.
//   CONTACT_FROM    optional  Sender address, once you verify a domain in Resend.
//   BLOCKED_IPS     optional  Comma-separated IPs that may not use the form.

const DEFAULT_TO = "gunjansonawane462@gmail.com";
const DEFAULT_FROM = "Portfolio contact <onboarding@resend.dev>";
const OWNER_TIME_ZONE = "Asia/Kolkata";
const RETENTION_DAYS = 90; // Promised in index.html and privacy.html.

const MAX_BODY_CHARS = 16_000;
const MIN_FILL_MS = 3_000; // A person needs more than 3 seconds; simple bots don't.
const MAX_LINKS = 3;
const RATE_LIMIT = { max: 5, windowMs: 10 * 60 * 1000 }; // attempts per IP
const LIMITS = { name: 100, email: 254, messageMin: 10, messageMax: 5_000 };

const EMAIL_PATTERN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const LINK_PATTERN = /(?:https?:\/\/|\bwww\.)\S+/gi;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL_ME = "Please email me directly instead.";

export async function POST(request) {
  const sender = identifySender(request.headers);
  const log = (outcome, details = {}) =>
    console.log(JSON.stringify({ event: "contact_form", outcome, ip: sender.ip, country: sender.country, ...details }));

  if (blockedIps().has(sender.ip)) {
    log("blocked_ip");
    return fail(403, "Sorry, this form can’t accept your message.");
  }
  if (isRateLimited(sender.ip)) {
    log("rate_limited");
    return fail(429, `Too many messages from your network. Please wait a few minutes and try again, or email me directly.`);
  }

  // Requiring JSON means other websites can't post to this endpoint from a
  // visitor's browser without a CORS preflight, which this endpoint never grants.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return fail(415, "Please use the form on the website.");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return fail(413, "That message is too long.");

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return fail(400, "Something went wrong with the form. Please try again.");

  // Honeypot: the "website" field is hidden from people, so only bots fill it.
  // Pretend it worked so they don't learn to skip it.
  if (String(body.website ?? "").trim()) {
    log("honeypot");
    return ok();
  }

  const fillMs = Number(body.fillMs);
  if (!Number.isFinite(fillMs) || fillMs < MIN_FILL_MS) {
    log("too_fast", { fillMs: Number.isFinite(fillMs) ? fillMs : null });
    return fail(400, "That was quick! Please take a moment, then send it again.");
  }

  if (body.consent !== true) {
    return fail(400, "Please tick the box to confirm you’ve read the notice about your IP address and location.");
  }

  const name = clean(body.name).replace(/\s+/g, " ");
  const email = clean(body.email);
  const message = clean(body.message).replace(/\r\n?/g, "\n");
  const problem = validate({ name, email, message });
  if (problem) {
    log("invalid", { field: problem.field });
    return fail(400, problem.error);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log("not_configured");
    return fail(503, `The form isn’t switched on yet. ${EMAIL_ME}`);
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM || DEFAULT_FROM,
        to: [process.env.CONTACT_TO || DEFAULT_TO],
        reply_to: email,
        subject: `Portfolio message from ${name}`,
        text: composeEmail({ name, email, message, sender, receivedAt: new Date() }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log("send_failed", { status: response.status, detail: (await response.text()).slice(0, 300) });
      return fail(502, `Sorry, your message couldn’t be sent right now. ${EMAIL_ME}`);
    }
  } catch (error) {
    log("send_failed", { error: error.name });
    return fail(502, `Sorry, your message couldn’t be sent right now. ${EMAIL_ME}`);
  }

  log("sent");
  return ok();
}

// Vercel replaces x-real-ip / x-forwarded-for with the address the request
// actually came from, so visitors can't spoof them.
function identifySender(headers) {
  const ip = (headers.get("x-real-ip") || headers.get("x-forwarded-for")?.split(",")[0] || "").trim() || "unknown";
  const countryCode = headers.get("x-vercel-ip-country") || "";
  const location = [
    decodeHeader(headers.get("x-vercel-ip-city")),
    headers.get("x-vercel-ip-country-region") || "",
    countryLabel(countryCode),
  ]
    .filter(Boolean)
    .join(", ");
  return { ip, country: countryCode || "unknown", location: location || "unknown" };
}

function decodeHeader(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value); // Vercel percent-encodes non-ASCII city names.
  } catch {
    return value;
  }
}

function countryLabel(code) {
  if (!code) return "";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

function blockedIps() {
  return new Set((process.env.BLOCKED_IPS || "").split(",").map((ip) => ip.trim()).filter(Boolean));
}

// Best-effort limit per IP. Vercel reuses warm function instances, so this
// stops bursts from one sender, but each instance keeps its own count and a
// cold start resets it. For a hard limit, add a Vercel Firewall rule too.
const attempts = new Map();

function isRateLimited(ip, now = Date.now()) {
  const recent = (attempts.get(ip) ?? []).filter((time) => now - time < RATE_LIMIT.windowMs);
  const limited = recent.length >= RATE_LIMIT.max;
  if (!limited) recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) {
      if (times.every((time) => now - time >= RATE_LIMIT.windowMs)) attempts.delete(key);
    }
  }
  return limited;
}

function clean(value) {
  return String(value ?? "").replace(CONTROL_CHARS, "").trim();
}

function validate({ name, email, message }) {
  if (!name || name.length > LIMITS.name) {
    return { field: "name", error: `Please enter your name (up to ${LIMITS.name} characters).` };
  }
  if (email.length > LIMITS.email || !EMAIL_PATTERN.test(email)) {
    return { field: "email", error: "Please enter a valid email address so I can reply." };
  }
  if (message.length < LIMITS.messageMin || message.length > LIMITS.messageMax) {
    return {
      field: "message",
      error: `Please write a message between ${LIMITS.messageMin} and ${LIMITS.messageMax.toLocaleString("en")} characters.`,
    };
  }
  if ((message.match(LINK_PATTERN) ?? []).length > MAX_LINKS) {
    return { field: "message", error: `Please include no more than ${MAX_LINKS} links.` };
  }
  return null;
}

function composeEmail({ name, email, message, sender, receivedAt }) {
  const deleteBy = new Date(receivedAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const when = (date, options) => date.toLocaleString("en-GB", { timeZone: OWNER_TIME_ZONE, ...options });
  return [
    "New message from your portfolio contact form.",
    "",
    `From: ${name} <${email}>`,
    "Reply to this email to answer them.",
    "",
    message,
    "",
    "--------------------------------------------------",
    "Abuse-prevention record (the sender was told about this before sending)",
    `IP address:            ${sender.ip}`,
    `Approximate location:  ${sender.location}`,
    `Received:              ${when(receivedAt, { dateStyle: "medium", timeStyle: "short" })} IST`,
    `Delete by:             ${when(deleteBy, { dateStyle: "medium" })} (${RETENTION_DAYS}-day limit in your privacy notice)`,
  ].join("\n");
}

function ok() {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

function fail(status, error) {
  return Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}
