import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDevice, describeVisitor, formatDevice, formatLocation } from "../api/_lib/visitor.js";
import { UA } from "./fakes.mjs";

const device = (ua, extra = {}) => describeDevice(new Headers({ "user-agent": ua, ...extra }));

test("recognises common browsers, systems and device types", () => {
  assert.deepEqual(pick(device(UA.androidChrome)), { browser: "Chrome 131", os: "Android", type: "mobile" });
  assert.deepEqual(pick(device(UA.iphoneSafari)), { browser: "Safari 17", os: "iOS", type: "mobile" });
  assert.deepEqual(pick(device(UA.windowsEdge)), { browser: "Edge 131", os: "Windows", type: "desktop" });
  assert.deepEqual(pick(device(UA.linuxFirefox)), { browser: "Firefox 133", os: "Linux", type: "desktop" });
  assert.equal(device("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36").type, "tablet");
});

test("labels bots and scripts", () => {
  assert.deepEqual(pick(device(UA.googlebot)), { browser: "Googlebot", os: "Android", type: "bot" });
  assert.deepEqual(pick(device(UA.curl)), { browser: "curl", os: "unknown OS", type: "bot" });
  assert.equal(device("").type, "unknown");
});

test("prefers the platform client hint when the browser sends one", () => {
  assert.equal(device(UA.androidChrome, { "sec-ch-ua-platform": '"Android"', "sec-ch-ua-mobile": "?1" }).os, "Android");
  assert.equal(device("Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36", { "sec-ch-ua-platform": '"Chrome OS"' }).os, "Chrome OS");
});

test("keeps the stored user-agent short", () => {
  assert.equal(device("x".repeat(1000)).ua.length, 300);
});

test("reads IP and approximate location from Vercel's headers, never coordinates", () => {
  const visitor = describeVisitor(
    new Headers({
      "x-real-ip": "203.0.113.7",
      "x-vercel-ip-city": "S%C3%A3o%20Paulo",
      "x-vercel-ip-country-region": "SP",
      "x-vercel-ip-country": "BR",
      "x-vercel-ip-latitude": "-23.55",
      "x-vercel-ip-longitude": "-46.63",
      "user-agent": UA.iphoneSafari,
    }),
  );
  assert.equal(visitor.ip, "203.0.113.7");
  assert.equal(formatLocation(visitor), "São Paulo, SP, Brazil (BR)");
  assert.equal(formatDevice(visitor), "Safari 17 · iOS · mobile");
  assert.doesNotMatch(JSON.stringify(visitor), /-23\.55|-46\.63/);
});

test("falls back gracefully when headers are missing", () => {
  const visitor = describeVisitor(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }));
  assert.equal(visitor.ip, "198.51.100.4");
  assert.equal(formatLocation(visitor), "unknown");
});

function pick({ browser, os, type }) {
  return { browser, os, type };
}
