import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import middleware, { config } from "../middleware.js";
import { UA, installFakes } from "./fakes.mjs";

let fakes;
let tasks;
const context = { waitUntil: (promise) => tasks.push(promise) };
const realError = console.error;

beforeEach(() => {
  fakes = installFakes();
  tasks = [];
  console.error = () => {};
});
afterEach(() => {
  fakes.restore();
  console.error = realError;
});

function visit(path = "/", method = "GET") {
  return new Request(`https://gunjan-portfolio.vercel.app${path}`, {
    method,
    headers: {
      "x-real-ip": "203.0.113.7",
      "x-vercel-ip-city": "Pune",
      "x-vercel-ip-country-region": "MH",
      "x-vercel-ip-country": "IN",
      "user-agent": UA.androidChrome,
    },
  });
}

test("only runs on the site's pages", () => {
  assert.deepEqual(config.matcher, ["/", "/index.html", "/privacy.html"]);
});

test("logs a page visit after the response and lets the page through", async () => {
  const response = middleware(visit("/privacy.html"), context);
  assert.equal(response.headers.get("x-middleware-next"), "1");

  await Promise.all(tasks);
  const [event] = fakes.events("visit");
  assert.equal(event.path, "/privacy.html");
  assert.equal(event.ip, "203.0.113.7");
  assert.equal(event.city, "Pune");
  assert.equal(event.country, "IN");
  assert.equal(event.browser, "Chrome 131");
  assert.equal(event.type, "mobile");
});

test("skips non-GET requests", async () => {
  middleware(visit("/", "HEAD"), context);
  await Promise.all(tasks);
  assert.equal(fakes.events("visit").length, 0);
});

test("still serves the page when Redis isn't connected or is down", async () => {
  fakes.disconnectRedis();
  assert.equal(middleware(visit(), context).headers.get("x-middleware-next"), "1");
  assert.equal(tasks.length, 0);

  fakes.restore();
  fakes = installFakes();
  fakes.setRedisDown(true);
  assert.equal(middleware(visit(), context).headers.get("x-middleware-next"), "1");
  await assert.doesNotReject(Promise.all(tasks));
});
