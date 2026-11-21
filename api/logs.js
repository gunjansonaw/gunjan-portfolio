// Password-protected view of the abuse-prevention log: GET /api/logs?days=7
//
// Your browser asks for a username and password. The username can be
// anything; the password is the ADMIN_PASSWORD environment variable (at least
// 12 characters). Without it, this page doesn't exist. After 10 wrong
// passwords from one IP in an hour, that IP is locked out for the rest of the hour.

import { createHash, timingSafeEqual } from "node:crypto";
import { RETENTION_DAYS, countHit, readEvents, redisConfig } from "./_lib/log.js";
import { describeVisitor, formatDevice, formatLocation } from "./_lib/visitor.js";

const MAX_FAILURES_PER_HOUR = 10;
const MAX_ROWS = 1000;
const RANGES = [1, 7, 30, RETENTION_DAYS];
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function GET(request) {
  const password = process.env.ADMIN_PASSWORD || "";
  if (password.length < 12) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });

  const { ip } = describeVisitor(request.headers);
  const failureKey = `authfail:logs:${ip}`;
  const failures = await countHit(failureKey, 3600, { increment: false }).catch(() => null);
  if (failures !== null && failures >= MAX_FAILURES_PER_HOUR) {
    return new Response("Too many wrong passwords. Try again in an hour.", { status: 429, headers: SECURITY_HEADERS });
  }

  const authorization = request.headers.get("authorization");
  if (!isAuthorized(authorization, password)) {
    if (authorization) {
      await countHit(failureKey, 3600).catch(() => null);
      console.log(JSON.stringify({ event: "logs_login_failed", ip }));
    }
    return new Response("Password required", {
      status: 401,
      headers: { ...SECURITY_HEADERS, "WWW-Authenticate": 'Basic realm="Portfolio logs", charset="UTF-8"' },
    });
  }

  if (!redisConfig()) {
    return page(
      "Logs",
      "<p>Logging isn’t connected yet. In Vercel, open Storage, create an Upstash for Redis database and connect it to this project, then redeploy.</p>",
    );
  }

  const requested = Number.parseInt(new URL(request.url).searchParams.get("days"), 10);
  const days = Math.min(Math.max(Number.isFinite(requested) ? requested : 7, 1), RETENTION_DAYS);
  const perDay = Math.min(500, Math.max(20, Math.floor(3000 / days)));
  const [visits, forms] = await Promise.all([readEvents("visit", days, perDay), readEvents("form", days, perDay)]);

  const rows = [
    ...visits.events.map((event) => ({ ...event, kind: "visit" })),
    ...forms.events.map((event) => ({ ...event, kind: "form" })),
  ]
    .sort((a, b) => String(b.t).localeCompare(String(a.t)))
    .slice(0, MAX_ROWS);

  return page("Visitor and form log", [
    `<nav>${RANGES.map((n) => (n === days ? `<b>${label(n)}</b>` : `<a href="?days=${n}">${label(n)}</a>`)).join(" · ")}</nav>`,
    `<p class="totals">Last ${label(days)}: ${plural(visits.total, "visit")} from ${plural(uniqueCount(visits.events), "IP")} · ${plural(forms.total, "form attempt")} (${countSent(forms.events)} sent)</p>`,
    topIpsTable(visits.events),
    eventsTable(rows),
    `<p class="note">Times are IST. Entries delete themselves ${RETENTION_DAYS} days after the day they were logged. To stop an IP using the form, add it to BLOCKED_IPS in Vercel.</p>`,
  ].join("\n"));
}

function isAuthorized(header, password) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header || "");
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const supplied = createHash("sha256").update(decoded.slice(separator + 1)).digest();
  const expected = createHash("sha256").update(password).digest();
  return timingSafeEqual(supplied, expected);
}

function topIpsTable(visits) {
  const byIp = new Map();
  for (const visit of visits) {
    const entry = byIp.get(visit.ip) ?? { count: 0, visit };
    entry.count += 1;
    if (String(visit.t) > String(entry.visit.t)) entry.visit = visit;
    byIp.set(visit.ip, entry);
  }
  const top = [...byIp.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  if (!top.length) return "";
  return `<h2>Most active IPs</h2><table><thead><tr><th>Visits</th><th>IP</th><th>Location</th><th>Device</th></tr></thead><tbody>${top
    .map(
      ({ count, visit }) =>
        `<tr>${cell("Visits", count)}${cell("IP", escape(visit.ip))}${cell("Location", escape(formatLocation(visit)))}${cell("Device", escape(formatDevice(visit)))}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function eventsTable(rows) {
  if (!rows.length) return "<p>Nothing logged in this period yet.</p>";
  return `<h2>Latest entries</h2><table><thead><tr><th>Time</th><th>What</th><th>IP</th><th>Location</th><th>Device</th></tr></thead><tbody>${rows
    .map((row) => {
      const what =
        row.kind === "visit"
          ? `Visit ${escape(row.path || "")}`
          : `Form: <b>${escape(row.outcome || "")}</b>${row.name || row.email ? `<br><small>${escape(row.name || "")} ${escape(row.email || "")}</small>` : ""}`;
      return `<tr class="${row.kind}">${cell("Time", escape(timeIst(row.t)))}${cell("What", what)}${cell("IP", escape(row.ip || ""))}${cell("Location", escape(formatLocation(row)))}${cell(
        "Device",
        `${escape(formatDevice(row))}<br><small>${escape(row.ua || "")}</small>`,
      )}</tr>`;
    })
    .join("")}</tbody></table>`;
}

function cell(label, html) {
  return `<td data-label="${label}"><div>${html}</div></td>`;
}

function page(title, body) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>
body{margin:0;padding:24px 16px;background:#10110f;color:#f1f0e9;font:14px/1.5 system-ui,sans-serif}h1{font-size:22px;margin:0 0 12px}h2{font-size:16px;margin:28px 0 8px}
a{color:#c5f36a}nav,.note{color:#a1a69b;font-size:13px}.totals{font-size:15px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid #343830}th{color:#a1a69b;font-weight:500}small{color:#a1a69b;word-break:break-all}tr.form td:first-child{border-left:3px solid #c5f36a}
@media(max-width:700px){thead{display:none}table,tbody,tr,td{display:block}tr{border:1px solid #343830;border-radius:6px;margin:0 0 10px;padding:6px 10px}tr.form{border-left:3px solid #c5f36a}tr.form td:first-child{border-left:0}
td{border:0;padding:3px 0;display:grid;grid-template-columns:76px 1fr;gap:8px}td::before{content:attr(data-label);color:#a1a69b;font-size:12px}}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function timeIst(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "medium" });
}

function label(days) {
  return days === 1 ? "1 day" : `${days} days`;
}

function plural(count, word) {
  return `<b>${count}</b> ${word}${count === 1 ? "" : "s"}`;
}

function uniqueCount(events) {
  return new Set(events.map((event) => event.ip)).size;
}

function countSent(events) {
  return events.filter((event) => event.outcome === "sent").length;
}
