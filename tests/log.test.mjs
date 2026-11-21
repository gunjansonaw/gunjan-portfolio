import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { RETENTION_DAYS, countHit, logEvent, readEvents } from "../api/_lib/log.js";
import { installFakes } from "./fakes.mjs";

let fakes;
beforeEach(() => (fakes = installFakes()));
afterEach(() => fakes.restore());

test("stores each event in that day's list, which expires 120 days after the day began", async () => {
  const now = new Date("2026-11-21T05:50:03Z");
  await logEvent("visit", { ip: "203.0.113.7", path: "/" }, now);

  const item = fakes.store.get("log:visit:2026-11-21");
  assert.deepEqual(JSON.parse(item.value[0]), { t: "2026-11-21T05:50:03.000Z", ip: "203.0.113.7", path: "/" });
  assert.equal(RETENTION_DAYS, 120);
  assert.equal(item.expireAt, Date.UTC(2027, 2, 21) / 1000); // 21 Nov 2026 + 120 days
});

test("reads the newest entries of each day and the true total", async () => {
  for (let i = 0; i < 5; i++) await logEvent("visit", { n: i }, new Date(`2026-11-20T10:0${i}:00Z`));
  for (let i = 0; i < 3; i++) await logEvent("visit", { n: 10 + i }, new Date(`2026-11-21T10:0${i}:00Z`));

  const { total, events } = await readEvents("visit", 2, 2, new Date("2026-11-21T12:00:00Z"));
  assert.equal(total, 8);
  assert.deepEqual(events.map((event) => event.n).sort((a, b) => a - b), [3, 4, 11, 12]);
});

test("counts hits in a fixed window and can peek without counting", async () => {
  const now = Date.UTC(2026, 10, 21, 6, 0, 0);
  assert.equal(await countHit("demo", 600, { now }), 1);
  assert.equal(await countHit("demo", 600, { now: now + 1000 }), 2);
  assert.equal(await countHit("demo", 600, { increment: false, now }), 2);
  assert.equal(await countHit("demo", 600, { now: now + 600_000 }), 1); // next window
});

test("does nothing when Redis isn't connected", async () => {
  fakes.disconnectRedis();
  assert.equal(await logEvent("visit", { ip: "203.0.113.7" }), null);
  assert.equal(await readEvents("visit", 7, 10), null);
  assert.equal(await countHit("demo", 600), null);
  assert.equal(fakes.store.size, 0);
});
