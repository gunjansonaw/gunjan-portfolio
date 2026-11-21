// Tests for api/contact.js. Run with: node --test tests/
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../api/contact.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
let sent;
let resendStatus;
let ipCounter = 0;

beforeEach(() => {
  sent = [];
  resendStatus = 200;
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.BLOCKED_IPS;
  delete process.env.CONTACT_TO;
  console.log = () => {};
  globalThis.fetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "email_123" }), { status: resendStatus });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
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
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("emails a valid message with the IP address and approximate location attached", async () => {
  const response = await POST(contactRequest(valid, { ip: "203.0.113.7" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].headers.Authorization, "Bearer re_test_key");

  const email = sent[0].body;
  assert.deepEqual(email.to, ["gunjansonawane462@gmail.com"]);
  assert.equal(email.reply_to, "asha@example.com");
  assert.equal(email.subject, "Portfolio message from Asha Rao");
  assert.match(email.text, /I enjoyed reading about MediLink/);
  assert.match(email.text, /IP address:\s+203\.0\.113\.7/);
  assert.match(email.text, /Approximate location:\s+Pune, MH, India \(IN\)/);
  assert.match(email.text, /Delete by:/);
  // Only city-level location is kept, never coordinates.
  assert.doesNotMatch(email.text, /18\.52|73\.85/);
});

test("decodes percent-encoded city names from Vercel", async () => {
  await POST(contactRequest(valid, { headers: { "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country-region": "SP", "x-vercel-ip-country": "BR" } }));
  assert.match(sent[0].body.text, /São Paulo, SP, Brazil \(BR\)/);
});

test("uses CONTACT_TO when it is set", async () => {
  process.env.CONTACT_TO = "inbox@example.com";
  await POST(contactRequest(valid));
  assert.deepEqual(sent[0].body.to, ["inbox@example.com"]);
});

test("pretends to accept honeypot submissions but drops them", async () => {
  const response = await POST(contactRequest({ ...valid, website: "https://spam.example" }));
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
});

test("rejects forms sent faster than a person could fill them in", async () => {
  const tooFast = await POST(contactRequest({ ...valid, fillMs: 800 }));
  assert.equal(tooFast.status, 400);
  const missing = await POST(contactRequest({ ...valid, fillMs: undefined }));
  assert.equal(missing.status, 400);
  assert.equal(sent.length, 0);
});

test("requires the acknowledgment checkbox", async () => {
  const response = await POST(contactRequest({ ...valid, consent: false }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /tick the box/);
  assert.equal(sent.length, 0);
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
  assert.equal(sent.length, 0);
});

test("keeps the name on one line so it can't break the email subject", async () => {
  await POST(contactRequest({ ...valid, name: "Asha\r\nBcc: someone@example.com" }));
  assert.equal(sent[0].body.subject, "Portfolio message from Asha Bcc: someone@example.com");
});

test("only accepts JSON bodies", async () => {
  const response = await POST(
    new Request("https://gunjan-portfolio.vercel.app/api/contact", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-real-ip": "192.0.2.50" },
      body: JSON.stringify(valid),
    }),
  );
  assert.equal(response.status, 415);
  const broken = await POST(contactRequest("{not json"));
  assert.equal(broken.status, 400);
  assert.equal(sent.length, 0);
});

test("limits each IP to 5 attempts per 10 minutes", async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await POST(contactRequest(valid, { ip: "192.0.2.99" }))).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  // Other senders are unaffected.
  assert.equal((await POST(contactRequest(valid))).status, 200);
});

test("refuses IPs listed in BLOCKED_IPS", async () => {
  process.env.BLOCKED_IPS = "192.0.2.1, 192.0.2.66";
  const response = await POST(contactRequest(valid, { ip: "192.0.2.66" }));
  assert.equal(response.status, 403);
  assert.equal(sent.length, 0);
});

test("says so when the form isn't configured yet", async () => {
  delete process.env.RESEND_API_KEY;
  const response = await POST(contactRequest(valid));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /email me directly/);
});

test("reports delivery failures instead of claiming success", async () => {
  resendStatus = 403;
  const response = await POST(contactRequest(valid));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /couldn’t be sent/);
});
