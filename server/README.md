# Short setlist links server

A small dependency-free Node program (`server.js`) that serves this site's
static files and the short-link API (`/api/r`, `/r/<code>`, link previews,
`/healthz`). It replaces plain static hosting for the site.

## What runs where

- Host: the home server, `sleepy`, in `/opt/spintracker-web`.
- Container: `spintracker-web` (see `compose.yaml`). It publishes **no ports**;
  it only joins the Docker network `rts_default`.
- Public traffic reaches it through the Cloudflare tunnel, whose connector
  container is `rts-cloudflared` on that same network.
- The container is read-only and runs as the unprivileged `node` user. The
  only writable place is the `/data` volume.

## Redeploy

From the Mac:

```sh
rsync -a --delete --exclude .git ~/Desktop/setlist/ sleepy:/opt/spintracker-web/
ssh sleepy 'cd /opt/spintracker-web/server && docker compose up -d --build'
```

## Check it

- `docker ps` on sleepy: `spintracker-web` should be `Up ... (healthy)`.
- `https://<the site>/healthz` answers `ok`.
- The Uptime Kuma monitor watches the same endpoint.

## Data

Links live in a SQLite file, `/data/links.db`, in the Docker volume
`spintracker-links`. It is **not backed up, on purpose**: a link is a
convenience that expires, and the setlist itself is always in the rider's app.
Losing the volume loses only the short codes.

## Tests

```sh
cd server && node --test
```
