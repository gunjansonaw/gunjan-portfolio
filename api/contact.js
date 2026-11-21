// Contact form endpoint: POST /api/contact
//
// Every attempt is logged with the sender's IP address, approximate location
// (city, region, country) and device details (browser, OS, device type) so
// spam and abuse can be spotted and blocked, and accepted messages are emailed
// to me through Resend with the same details attached. Visitors are told this
// before they press Send: the strip at the top of every page, the notice
// above the form in index.html, and privacy.html. If you change what's
// collected here, update those pages.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY  required  API key from https://resend.com/api-keys
//   CONTACT_TO      optional  Inbox that receives messages. With Resend's test
//                             sender this must be your Resend account's email.
//   CONTACT_FROM    optional  Sender address, once you verify a domain in Resend.
//   BLOCKED_IPS     optional  Comma-separated IPs that may not use the form.
//   KV_REST_API_URL, KV_REST_API_TOKEN  set by the Upstash Redis integration.
//                             Without them nothing is logged and the rate
//                             limit only counts per function instance.

import { RETENTION_DAYS, countHit, logEvent } from "./_lib/log.js";
import { describeVisitor, formatDevice, formatLocation } from "./_lib/visitor.js";

const DEFAULT_TO = "gunjansonawane462@gmail.com";
const DEFAULT_FROM = "Portfolio contact <onboarding@resend.dev>";
const OWNER_TIME_ZONE = "Asia/Kolkata";

const MAX_BODY_CHARS = 16_000;
const MIN_FILL_MS = 3_000; // A person needs more than 3 seconds; simple bots don't.
const MAX_LINKS = 3;
const RATE_LIMIT = { max: 5, windowSeconds: 10 * 60 }; // attempts per IP
const LIMITS = { name: 100, email: 254, messageMin: 10, messageMax: 5_000 };

const EMAIL_PATTERN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const LINK_PATTERN = /(?:https?:\/\/|\bwww\.)\S+/gi;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL_ME = "Please email me directly instead.";

export async function POST(request) {
  const visitor = describeVisitor(request.headers);
  let submitted = {};
  const log = async (outcome, details = {}) => {
    console.log(JSON.stringify({ event: "contact_form", outcome, ip: visitor.ip, country: visitor.country || "unknown", ...details }));
    try {
      await logEvent("form", { outcome, ...visitor, ...submitted });
    } catch (error) {
      console.error(JSON.stringify({ event: "form_log_failed", error: error.message }));
    }
  };

  if (blockedIps().has(visitor.ip)) {
    await log("blocked_ip");
    return fail(403, "Sorry, this form can’t accept your message.");
  }
  if (await isRateLimited(visitor.ip)) {
    await log("rate_limited");
    return fail(429, "Too many messages from your network. Please wait a few minutes and try again, or email me directly.");
  }

  // Requiring JSON means other websites can't post to this endpoint from a
  // visitor's browser without a CORS preflight, which this endpoint never grants.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await log("not_json");
    return fail(415, "Please use the form on the website.");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    await log("too_large");
    return fail(413, "That message is too long.");
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    await log("bad_request");
    return fail(400, "Something went wrong with the form. Please try again.");
  }

  const name = clean(body.name).replace(/\s+/g, " ");
  const email = clean(body.email);
  const message = clean(body.message).replace(/\r\n?/g, "\n");
  submitted = { name: name.slice(0, LIMITS.name), email: email.slice(0, LIMITS.email) };

  // Honeypot: the "website" field is hidden from people, so only bots fill it.
  // Pretend it worked so they don't learn to skip it.
  if (String(body.website ?? "").trim()) {
    await log("honeypot");
    return ok();
  }

  const fillMs = Number(body.fillMs);
  if (!Number.isFinite(fillMs) || fillMs < MIN_FILL_MS) {
    await log("too_fast", { fillMs: Number.isFinite(fillMs) ? fillMs : null });
    return fail(400, "That was quick! Please take a moment, then send it again.");
  }

  if (body.consent !== true) {
    await log("no_consent");
    return fail(400, "Please tick the box to confirm you’ve read the notice about what’s recorded.");
  }

  const problem = validate({ name, email, message });
  if (problem) {
    await log("invalid", { field: problem.field });
    return fail(400, problem.error);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    await log("not_configured");
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
        text: composeEmail({ name, email, message, visitor, receivedAt: new Date() }),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await log("send_failed", { status: response.status, detail: (await response.text()).slice(0, 300) });
      return fail(502, `Sorry, your message couldn’t be sent right now. ${EMAIL_ME}`);
    }
  } catch (error) {
    await log("send_failed", { error: error.name });
    return fail(502, `Sorry, your message couldn’t be sent right now. ${EMAIL_ME}`);
  }

  await log("sent");
  return ok();
}

function blockedIps() {
  return new Set((process.env.BLOCKED_IPS || "").split(",").map((ip) => ip.trim()).filter(Boolean));
}

// With Redis connected, the limit is exact across every function instance.
// Without it, each warm instance keeps its own count (best effort).
const attempts = new Map();

async function isRateLimited(ip) {
  try {
    const hits = await countHit(`ratelimit:form:${ip}`, RATE_LIMIT.windowSeconds);
    if (hits !== null) return hits > RATE_LIMIT.max;
  } catch (error) {
    console.error(JSON.stringify({ event: "rate_limit_check_failed", error: error.message }));
  }
  return isRateLimitedInMemory(ip);
}

function isRateLimitedInMemory(ip, now = Date.now()) {
  const windowMs = RATE_LIMIT.windowSeconds * 1000;
  const recent = (attempts.get(ip) ?? []).filter((time) => now - time < windowMs);
  const limited = recent.length >= RATE_LIMIT.max;
  if (!limited) recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10_000) {
    for (const [key, times] of attempts) {
      if (times.every((time) => now - time >= windowMs)) attempts.delete(key);
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

function composeEmail({ name, email, message, visitor, receivedAt }) {
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
    `IP address:            ${visitor.ip}`,
    `Approximate location:  ${formatLocation(visitor)}`,
    `Device:                ${formatDevice(visitor)}`,
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
