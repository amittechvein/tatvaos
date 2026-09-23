# apps/website — the public site at tatvaos.com

Static HTML, served by Caddy straight from this folder. No build, no runtime,
no dependency on `web` or `api`: if every product container is down, this page
still answers.

| | |
|---|---|
| Served at | `https://tatvaos.com` (`www.` redirects here, 308) |
| Served by | `infra/docker/caddy/conf.d/website.caddy`, `file_server` on `/srv/website` |
| Mounted by | `docker-compose.base.yml`, caddy service, `../../apps/website/public:/srv/website:ro` — **only `public/`**; `file_server` serves every file under its root, which is why this README lives beside it and not in it |
| Variable | `WEBSITE_DOMAIN=tatvaos.com` — in the caddy env list **and** in the server's `.env` before this deploys |

## Editing

`public/index.html` is **generated**. The source is the review copy the founder
and CTO see (an artifact page with no `<html>`/`<head>`/`<body>` of its own);
a small script wraps it into a full document with the `<head>` metadata and
copies `shots/` and `brand/` alongside. Edit the source, run the script, commit
the result. Editing this file directly means the next build overwrites it.

`shots/` are real product screens, captured from a local build against demo
data on 23 September 2026 at 1440×900, 2× — see the review notes that travel
with the source for the recipe and the demo-data tags.

## Before this goes live

- Remove the review strip (`#reviewStrip`, the first block in `<body>`).
- The plans section and every customer-facing sentence go past the CTO first
  (house rule 7). Nothing here is reviewed until that has happened.
- The apex and `www` DNS records exist (A → the production box, added 23 Sept).
