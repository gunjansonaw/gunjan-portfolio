import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../api/logs.js";
import { logEvent } from "../api/_lib/log.js";
import { UA, installFakes } from "./fakes.mjs";

const PASSWORD = "correct horse battery staple";
const realLog = console.log;
let fakes;

beforeEach(() => {
  fakes = installFakes();
  process.env.ADMIN_PASSWORD = PASSWORD;
  console.log = () => {};
});
afterEach(() => {
  fakes.restore();
  delete process.env.ADMIN_PASSWORD;
  console.log = realLog;
});

function open({ password, ip = "198.51.100.10", query = "" } = {}) {
  const headers = { "x-real-ip": ip };
  if (password !== undefined) headers.authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  return GET(new Request(`https://gunjan-portfolio.vercel.app/api/logs${query}`, { headers }));
}

test("doesn't exist unless ADMIN_PASSWORD is set to 12+ characters", async () => {
  delete process.env.ADMIN_PASSWORD;
  assert.equal((await open({ password: "" })).status, 404);
  process.env.ADMIN_PASSWORD = "short";
  assert.equal((await open({ password: "short" })).status, 404);
});

test("asks for a password, and rejects a wrong one", async () => {
  const prompt = await open();
  assert.equal(prompt.status, 401);
  assert.match(prompt.headers.get("www-authenticate"), /^Basic realm="Portfolio logs"/);

  assert.equal((await open({ password: "wrong password" })).status, 401);
});

test("locks an IP out after 10 wrong passwords, even if the 11th is right", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await open({ password: `guess ${i}`, ip: "192.0.2.5" })).status, 401);
  assert.equal((await open({ password: PASSWORD, ip: "192.0.2.5" })).status, 429);
  assert.equal((await open({ password: PASSWORD, ip: "192.0.2.6" })).status, 200); // other IPs unaffected
});

test("opening the page without a password doesn't count as a wrong guess", async () => {
  for (let i = 0; i < 12; i++) await open({ ip: "192.0.2.7" });
  assert.equal((await open({ password: PASSWORD, ip: "192.0.2.7" })).status, 200);
});

test("shows totals, the most active IPs and the latest entries", async () => {
  const visit = { ip: "203.0.113.7", city: "Pune", region: "MH", country: "IN", browser: "Chrome 131", os: "Android", type: "mobile", ua: UA.androidChrome };
  await logEvent("visit", { ...visit, path: "/" });
  await logEvent("visit", { ...visit, path: "/privacy.html" });
  await logEvent("visit", { ...visit, ip: "198.51.100.20", city: "Mumbai", path: "/" });
  await logEvent("form", { ...visit, outcome: "sent", name: "Asha Rao", email: "asha@example.com" });

  const response = await open({ password: PASSWORD });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<b>3<\/b> visits from <b>2<\/b> IPs · <b>1<\/b> form attempt \(1 sent\)/);
  assert.match(html, /Most active IPs[\s\S]*<td data-label="Visits"><div>2<\/div><\/td><td data-label="IP"><div>203\.0\.113\.7<\/div><\/td><td data-label="Location"><div>Pune, MH, India \(IN\)<\/div><\/td>/);
  assert.match(html, /Visit \/privacy\.html/);
  assert.match(html, /Form: <b>sent<\/b><br><small>Asha Rao asha@example\.com<\/small>/);
  assert.match(html, /Chrome 131 · Android · mobile/);
});

test("escapes everything visitors control", async () => {
  await logEvent("visit", { ip: "203.0.113.9", path: "/<img src=x onerror=alert(1)>", ua: "<script>alert(1)</script>", browser: "\"><b>", os: "x", type: "bot" });
  const html = await (await open({ password: PASSWORD })).text();
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.match(html, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/);
});

test("sends strict security headers", async () => {
  const response = await open({ password: PASSWORD });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
});

test("explains what to do when Redis isn't connected", async () => {
  fakes.disconnectRedis();
  const html = await (await open({ password: PASSWORD })).text();
  assert.match(html, /Logging isn’t connected yet/);
});

test("limits the range to the retention period", async () => {
  const html = await (await open({ password: PASSWORD, query: "?days=9999" })).text();
  assert.match(html, /Last 120 days/);
});
