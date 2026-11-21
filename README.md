# Gunjan Sonawane — Portfolio

A responsive personal portfolio for Gunjan Sonawane: a static site plus a little server code (Routing Middleware and two Vercel Functions), hosted on Vercel.

Open `index.html` locally to preview. The public site does not include the downloadable résumé PDF.

## Abuse-prevention logging

To prevent abuse, page visits and contact form submissions are logged with the visitor's IP address, approximate location (city, region and country from Vercel's request headers, never GPS or coordinates) and device details (browser, OS and device type from the user-agent). Entries are kept for 120 days.

- `middleware.js` logs each visit to `/`, `/index.html` and `/privacy.html` after the page is sent, so it never slows the page down.
- `api/contact.js` logs every form attempt and what happened to it (sent, honeypot, too fast, rate limited, and so on). It doesn't log the message itself.
- `api/_lib/log.js` stores the log in Upstash Redis, in one list per kind per UTC day. Each list deletes itself 120 days after its day began.
- `api/logs.js` is a password-protected page at `/api/logs` for reading the log, with totals and the most active IPs.

Visitors are told before anything is collected about them. A notice strip sits at the top of every page, a notice and a required checkbox sit above the form's Send button, and `privacy.html` has the full details. If you change what's collected or how long it's kept, update all three, plus `RETENTION_DAYS` in `api/_lib/log.js`.

## Contact form

The form posts to `api/contact.js`, which emails each accepted message to me through [Resend](https://resend.com) with the sender's IP address, approximate location and device details attached. It also:

- limits each IP to 5 attempts per 10 minutes (exact when Redis is connected, per function instance otherwise),
- quietly drops submissions that fill a hidden honeypot field,
- rejects forms sent less than 3 seconds after the page loaded,
- caps message length and the number of links,
- only accepts JSON, so other sites can't post to it from a visitor's browser,
- refuses IPs listed in `BLOCKED_IPS`.

## Setup

1. In Vercel, open Storage, create an **Upstash for Redis** database (the Free plan is enough) and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. Add these in Vercel → Project → Settings → Environment Variables, then redeploy:

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | Yes | Sending-only API key from [resend.com/api-keys](https://resend.com/api-keys). |
| `ADMIN_PASSWORD` | For `/api/logs` | Password for the logs page, at least 12 characters. Without it, the page returns 404. |
| `CONTACT_TO` | No | Inbox for messages. Defaults to the address in `api/contact.js`. With Resend's test sender (`onboarding@resend.dev`), this must be the email your Resend account uses. |
| `CONTACT_FROM` | No | Sender address, once you verify your own domain in Resend. |
| `BLOCKED_IPS` | No | Comma-separated IPs that may not use the form. |

To read the log, open `/api/logs` and enter any username and your `ADMIN_PASSWORD`. Add `?days=30` to see further back. Ten wrong passwords from one IP lock that IP out for the rest of the hour.

The form and logging only work on the Vercel deployment. GitHub Pages can't run server code.

## Tests

```sh
npm install
npm test
```
