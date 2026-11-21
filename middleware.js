// Logs each page visit (IP address, approximate location, device details) to
// the abuse-prevention log, as the notice at the top of every page says. The
// write happens after the page is sent, so visitors never wait for it, and a
// logging failure never blocks the page.

import { next } from "@vercel/functions";
import { logEvent, redisConfig } from "./api/_lib/log.js";
import { describeVisitor } from "./api/_lib/visitor.js";

export const config = {
  matcher: ["/", "/index.html", "/privacy.html"],
};

export default function middleware(request, context) {
  if (request.method === "GET" && redisConfig()) {
    const visit = { path: new URL(request.url).pathname, ...describeVisitor(request.headers) };
    const write = logEvent("visit", visit).catch((error) =>
      console.error(JSON.stringify({ event: "visit_log_failed", error: error.message })),
    );
    context?.waitUntil?.(write);
  }
  return next();
}
