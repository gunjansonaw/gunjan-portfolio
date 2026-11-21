// Abuse-prevention log, stored in Upstash Redis (added through Vercel's
// Storage tab, which sets KV_REST_API_URL and KV_REST_API_TOKEN). Each kind of
// event ("visit" or "form") gets one Redis list per UTC day, and every list
// deletes itself 120 days after its day began, so nothing is kept longer than
// visitors are told. Without Redis configured, nothing is logged.

export const RETENTION_DAYS = 120; // Promised in index.html and privacy.html.
const DAY_MS = 24 * 60 * 60 * 1000;

export function redisConfig(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

// Runs several commands in one request. Returns null when Redis isn't set up.
export async function redis(commands) {
  const config = redisConfig();
  if (!config) return null;
  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Redis responded with ${response.status}`);
  return (await response.json()).map((item) => {
    if (item.error) throw new Error(item.error);
    return item.result;
  });
}

function dayKey(kind, time) {
  return `log:${kind}:${new Date(time).toISOString().slice(0, 10)}`;
}

export async function logEvent(kind, record, now = new Date()) {
  const key = dayKey(kind, now);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expireAt = Math.floor((dayStart + RETENTION_DAYS * DAY_MS) / 1000);
  return redis([
    ["RPUSH", key, JSON.stringify({ t: now.toISOString(), ...record })],
    ["EXPIREAT", key, String(expireAt)],
  ]);
}

// The newest `perDay` events of each of the last `days` days, plus the true total.
export async function readEvents(kind, days, perDay, now = new Date()) {
  const keys = Array.from({ length: days }, (_, i) => dayKey(kind, now.getTime() - i * DAY_MS));
  const results = await redis(keys.flatMap((key) => [["LLEN", key], ["LRANGE", key, String(-perDay), "-1"]]));
  if (!results) return null;
  let total = 0;
  const events = [];
  for (let i = 0; i < results.length; i += 2) {
    total += Number(results[i]) || 0;
    for (const raw of results[i + 1] ?? []) {
      try {
        events.push(JSON.parse(raw));
      } catch {
        // Skip anything that isn't a log entry.
      }
    }
  }
  return { total, events };
}

// Fixed-window counter. `increment` returns the hits so far in this window;
// `peek` reads it without counting. Both return null when Redis isn't set up.
export async function countHit(key, windowSeconds, { increment = true, now = Date.now() } = {}) {
  const windowKey = `${key}:${Math.floor(now / 1000 / windowSeconds)}`;
  const results = increment
    ? await redis([["INCR", windowKey], ["EXPIRE", windowKey, String(windowSeconds)]])
    : await redis([["GET", windowKey]]);
  return results ? Number(results[0]) || 0 : null;
}
