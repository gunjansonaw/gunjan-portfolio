// Tests for api/contact.js. Run with: npm test
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../api/contact.js";
import { UA, installFakes } from "./fakes.mjs";

const realLog = console.log;
const realError = console.error;
let fakes;
let ipCounter = 0;

beforeEach(() => {
  fakes = installFakes();
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.CONTACT_TO = "inbox@example.com";
  delete process.env.BLOCKED_IPS;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  fakes.restore();
  console.log = realLog;
  console.error = realError;
});

const valid = {
  name: "Asha Rao",
  email: "asha@example.com",
  message: "Hi Gunjan, I enjoyed reading about MediLink. Are you open to backend roles?",
  website: "",
  consent: true,
  fillMs: 15_000,
};

// Each call gets a fresh IP unless one is given, so the rate limit doesn't leak between tests.
function contactRequest(body, { ip = `198.51.100.${++ipCounter}`, headers = {} } = {}) {
  return new Request("https://gunjan-portfolio.vercel.app/api/contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": ip,
      "x-vercel-ip-city": "Pune",
      "x-vercel-ip-country-region": "MH",
      "x-vercel-ip-country": "IN",
      "x-vercel-ip-latitude": "18.52",
      "x-vercel-ip-longitude": "73.85",
      "user-agent": UA.androidChrome,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("emails a valid message with the IP address, approximate location and device attached", async () => {
  const response = await POST(contactRequest(valid, { ip: "203.0.113.7" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fakes.emails.length, 1);
  assert.equal(fakes.emails[0].headers.Authorization, "Bearer re_test_key");

  const email = fakes.emails[0].body;
  assert.deepEqual(email.to, ["inbox@example.com"]);
  assert.equal(email.reply_to, "asha@example.com");
  assert.equal(email.subject, "Portfolio message from Asha Rao");
  assert.match(email.text, /I enjoyed reading about MediLink/);
  assert.match(email.text, /IP address:\s+203\.0\.113\.7/);
  assert.match(email.text, /Approximate location:\s+Pune, MH, India \(IN\)/);
  assert.match(email.text, /Device:\s+Chrome 131 · Android · mobile/);
  assert.match(email.text, /120-day limit/);
  assert.doesNotMatch(email.text, /18\.52|73\.85/);
});

test("logs every attempt with device details, name and email, but not the message", async () => {
  await POST(contactRequest(valid, { ip: "203.0.113.8" }));
  const [event] = fakes.events("form");
  assert.equal(event.outcome, "sent");
  assert.equal(event.ip, "203.0.113.8");
  assert.equal(event.city, "Pune");
  assert.equal(event.browser, "Chrome 131");
  assert.equal(event.os, "Android");
  assert.equal(event.type, "mobile");
  assert.equal(event.name, "Asha Rao");
  assert.equal(event.email, "asha@example.com");
  assert.doesNotMatch(JSON.stringify(event), /MediLink/);
});

test("falls back to the default inbox when CONTACT_TO isn't set", async () => {
  delete process.env.CONTACT_TO;
  await POST(contactRequest(valid));
  const [to] = fakes.emails[0].body.to;
  assert.match(to, /@/);
  assert.notEqual(to, "inbox@example.com");
});

test("pretends to accept honeypot submissions but drops and logs them", async () => {
  const response = await POST(contactRequest({ ...valid, website: "https://spam.example" }));
  assert.equal(response.status, 200);
  assert.equal(fakes.emails.length, 0);
  assert.equal(fakes.events("form")[0].outcome, "honeypot");
});

test("rejects forms sent faster than a person could fill them in", async () => {
  assert.equal((await POST(contactRequest({ ...valid, fillMs: 800 }))).status, 400);
  assert.equal((await POST(contactRequest({ ...valid, fillMs: undefined }))).status, 400);
  assert.equal(fakes.emails.length, 0);
  assert.deepEqual(fakes.events("form").map((event) => event.outcome), ["too_fast", "too_fast"]);
});

test("requires the acknowledgment checkbox", async () => {
  const response = await POST(contactRequest({ ...valid, consent: false }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /tick the box/);
  assert.equal(fakes.emails.length, 0);
});

test("validates name, email and message", async () => {
  const cases = [
    [{ name: "   " }, /your name/],
    [{ email: "not-an-email" }, /valid email/],
    [{ email: "a@b.com>, x@y.com" }, /valid email/],
    [{ message: "hi" }, /between 10 and 5,000/],
    [{ message: "x".repeat(5_001) }, /between 10 and 5,000/],
    [{ message: "see https://a.io https://b.io https://c.io www.d.io" }, /no more than 3 links/],
  ];
  for (const [change, error] of cases) {
    const response = await POST(contactRequest({ ...valid, ...change }));
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.match((await response.json()).error, error);
  }
  assert.equal(fakes.emails.length, 0);
});

test("keeps the name on one line so it can't break the email subject", async () => {
  await POST(contactRequest({ ...valid, name: "Asha\r\nBcc: someone@example.com" }));
  assert.equal(fakes.emails[0].body.subject, "Portfolio message from Asha Bcc: someone@example.com");
});

test("only accepts JSON bodies", async () => {
  const response = await POST(contactRequest(JSON.stringify(valid), { headers: { "content-type": "text/plain" } }));
  assert.equal(response.status, 415);
  assert.equal((await POST(contactRequest("{not json"))).status, 400);
  assert.equal(fakes.emails.length, 0);
});

test("limits each IP to 5 attempts per 10 minutes using Redis", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await POST(contactRequest(valid, { ip: "192.0.2.99" }))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(fakes.events("form").at(-1).outcome, "rate_limited");
  assert.equal((await POST(contactRequest(valid))).status, 200); // other senders are unaffected
});

test("falls back to a per-instance limit when Redis is down, and still sends", async () => {
  fakes.setRedisDown(true);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await POST(contactRequest(valid, { ip: "192.0.2.77" }))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(fakes.emails.length, 5);
});

test("refuses IPs listed in BLOCKED_IPS", async () => {
  process.env.BLOCKED_IPS = "192.0.2.1, 192.0.2.66";
  const response = await POST(contactRequest(valid, { ip: "192.0.2.66" }));
  assert.equal(response.status, 403);
  assert.equal(fakes.emails.length, 0);
  assert.equal(fakes.events("form")[0].outcome, "blocked_ip");
});

test("says so when the form isn't configured yet", async () => {
  delete process.env.RESEND_API_KEY;
  const response = await POST(contactRequest(valid));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /email me directly/);
});

test("reports delivery failures instead of claiming success", async () => {
  fakes.setResendStatus(403);
  const response = await POST(contactRequest(valid));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /couldn’t be sent/);
  assert.equal(fakes.events("form")[0].outcome, "send_failed");
});
