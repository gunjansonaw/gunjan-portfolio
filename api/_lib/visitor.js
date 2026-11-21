// Who made a request: IP address, approximate location and device details,
// read from headers that arrive with every request. Vercel sets the IP and
// location headers itself, so visitors can't spoof them; device details come
// from the user-agent the browser sends. The latitude/longitude headers are
// never read.

export function describeVisitor(headers) {
  return {
    ip: (headers.get("x-real-ip") || headers.get("x-forwarded-for")?.split(",")[0] || "").trim() || "unknown",
    city: decodeHeader(headers.get("x-vercel-ip-city")),
    region: (headers.get("x-vercel-ip-country-region") || "").slice(0, 10),
    country: (headers.get("x-vercel-ip-country") || "").slice(0, 2),
    ...describeDevice(headers),
  };
}

export function formatLocation({ city, region, country }) {
  return [city, region, countryLabel(country)].filter(Boolean).join(", ") || "unknown";
}

export function formatDevice({ browser, os, type }) {
  return [browser, os, type].filter(Boolean).join(" · ") || "unknown";
}

const AUTOMATED = /bot|crawl|spider|slurp|scrapy|preview|monitor|headless|lighthouse|curl|wget|python|httpclient|okhttp|java\/|go-http|axios|node-fetch|undici|postman/i;

const BROWSERS = [
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /(?:OPR|Opera)\/(\d+)/],
  ["Samsung Internet", /SamsungBrowser\/(\d+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
  ["Safari", /Version\/(\d+)[\d.]*.*Safari\//],
];

export function describeDevice(headers) {
  const ua = (headers.get("user-agent") || "").slice(0, 300);
  const platformHint = (headers.get("sec-ch-ua-platform") || "").replace(/"/g, "").slice(0, 20);
  const automated = AUTOMATED.test(ua);

  let type = "desktop";
  if (!ua) type = "unknown";
  else if (automated) type = "bot";
  else if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) type = "tablet";
  else if (headers.get("sec-ch-ua-mobile") === "?1" || /Mobi|iPhone|iPod/i.test(ua)) type = "mobile";

  return { browser: automated ? botName(ua) : browserName(ua), os: platformHint || osName(ua), type, ua };
}

function browserName(ua) {
  for (const [name, pattern] of BROWSERS) {
    const match = ua.match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return ua ? "other browser" : "unknown";
}

function botName(ua) {
  const named = ua.match(/([A-Za-z][\w-]*(?:bot|spider|crawler))\b/i) || ua.match(/^([\w.-]+)\//);
  return named ? named[1].slice(0, 40) : "automated client";
}

function osName(ua) {
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown OS";
}

function decodeHeader(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value).slice(0, 60); // Vercel percent-encodes non-ASCII city names.
  } catch {
    return value.slice(0, 60);
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
