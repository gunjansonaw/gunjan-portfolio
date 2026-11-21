# Gunjan Sonawane — Portfolio

A responsive personal portfolio for Gunjan Sonawane: a static site plus one serverless function, hosted on Vercel.

Open `index.html` locally to preview. The public site does not include the downloadable résumé PDF.

## Contact form

The form in the contact section posts to `api/contact.js`, a Vercel Function that emails each message to me through [Resend](https://resend.com).

To prevent spam and abuse, every message is sent along with the sender's IP address and approximate location (city, region and country, taken from Vercel's request headers, never GPS or coordinates). The function also:

- limits each IP to 5 attempts per 10 minutes (best effort: each warm function instance keeps its own count),
- quietly drops submissions that fill a hidden honeypot field,
- rejects forms sent less than 3 seconds after the page loaded,
- caps message length and the number of links,
- only accepts JSON, so other sites can't post to it from a visitor's browser,
- refuses IPs listed in `BLOCKED_IPS`.

Visitors are told about this before they send: a notice and a required checkbox sit above the Send button, and `privacy.html` has the full details. If you change what the function collects or how long you keep it, update both.

### Setup

Add these in Vercel → Project → Settings → Environment Variables, then redeploy:

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | Yes | API key from [resend.com/api-keys](https://resend.com/api-keys). |
| `CONTACT_TO` | No | Inbox for messages. Defaults to gunjansonawane462@gmail.com. With Resend's test sender (`onboarding@resend.dev`), this must be the email your Resend account uses. |
| `CONTACT_FROM` | No | Sender address, once you verify your own domain in Resend. |
| `BLOCKED_IPS` | No | Comma-separated IPs that may not use the form. |

Each email ends with a "Delete by" date, 90 days after it arrived, to match the retention period in the privacy notice.

The form only works on the Vercel deployment. GitHub Pages can't run the function, so there the form tells visitors to email instead.

### Tests

```sh
node --test
```
