// In-memory stand-ins for Upstash Redis (REST pipeline API) and Resend,
// installed by replacing global fetch. Not a test file itself.

export const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  googlebot:
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  curl: "curl/8.7.1",
};

export function installFakes() {
  const store = new Map();
  const emails = [];
  const realFetch = globalThis.fetch;
  let resendStatus = 200;
  let redisDown = false;

  const entry = (key) => store.get(key) ?? store.set(key, {}).get(key);
  const run = ([command, key, ...args]) => {
    switch (command) {
      case "RPUSH": {
        const item = entry(key);
        item.value = [...(item.value ?? []), ...args];
        return item.value.length;
      }
      case "LLEN":
        return store.get(key)?.value?.length ?? 0;
      case "LRANGE": {
        const list = store.get(key)?.value ?? [];
        const start = Math.max(Number(args[0]) < 0 ? list.length + Number(args[0]) : Number(args[0]), 0);
        const stop = Number(args[1]) < 0 ? list.length + Number(args[1]) : Number(args[1]);
        return list.slice(start, stop + 1);
      }
      case "EXPIREAT":
        entry(key).expireAt = Number(args[0]);
        return 1;
      case "EXPIRE":
        entry(key).ttl = Number(args[0]);
        return 1;
      case "INCR": {
        const item = entry(key);
        item.value = Number(item.value ?? 0) + 1;
        return item.value;
      }
      case "GET":
        return store.get(key)?.value === undefined ? null : String(store.get(key).value);
      default:
        throw new Error(`fake Redis doesn't support ${command}`);
    }
  };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === "https://redis.test/pipeline") {
      if (redisDown) return new Response("unavailable", { status: 503 });
      assertEqual(init.headers.Authorization, "Bearer redis-test-token");
      return Response.json(JSON.parse(init.body).map((command) => ({ result: run(command) })));
    }
    if (href === "https://api.resend.com/emails") {
      emails.push({ headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ id: "email_123" }, { status: resendStatus });
    }
    throw new Error(`Unexpected fetch to ${href}`);
  };
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "redis-test-token";

  return {
    store,
    emails,
    setResendStatus: (status) => (resendStatus = status),
    setRedisDown: (down) => (redisDown = down),
    disconnectRedis: () => {
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    },
    events: (kind) =>
      [...store.entries()].filter(([key]) => key.startsWith(`log:${kind}:`)).flatMap(([, item]) => item.value.map((raw) => JSON.parse(raw))),
    restore: () => {
      globalThis.fetch = realFetch;
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
    },
  };
}

function assertEqual(actual, expected) {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}
