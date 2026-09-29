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

Prerequisite: the external Docker network `rts_default` must already exist on
sleepy. It is the network the `rts-cloudflared` tunnel container is on.

One-time setup of the target directory:

```sh
ssh sleepy 'sudo mkdir -p /opt/spintracker-web && sudo chown "$USER" /opt/spintracker-web'
```

Then, from the Mac. The rsync source must be a checkout of this repo (the path
below is one example checkout):

```sh
rsync -a --delete --exclude .git --exclude .DS_Store ~/Desktop/setlist/ sleepy:/opt/spintracker-web/
ssh sleepy 'cd /opt/spintracker-web/server && docker compose up -d --build'
```

## Check it

- `docker ps` on sleepy: `spintracker-web` should be `Up ... (healthy)`.
- `https://spintracker.buoyantpass.com/healthz` answers `ok`.
- The Uptime Kuma monitor watches the same endpoint.

## Data

Links live in a SQLite file, `/data/links.db`, in the Docker volume
`spintracker-links`. It is **not backed up, on purpose**: a link is a
convenience that expires, and the setlist itself is always in the rider's app.
Losing the volume loses only the short codes.

## Before redesigning the site

The landing page and the shared-setlist page are the same `index.html` and
`app.js`. A redesign is fine, but these have to keep working:

1. **Long links at the root.** Every `https://spintracker.buoyantpass.com/#<payload>`
   shared since app 1.0 loads `/` and is decoded in JavaScript from the
   fragment. The root page has to keep running the setlist renderer, and must
   not redirect elsewhere: the server never sees a fragment, so it cannot
   forward one.
2. **`/r/<code>` keeps serving the setlist page**, and `index.html`'s `<head>`
   keeps the `<!--preview:start-->` and `<!--preview:end-->` markers. The server
   writes the link-preview tags between them.
3. **`/.well-known/apple-app-site-association`** is served byte-for-byte as
   `application/json`. If it breaks, shared links stop opening the app.
4. **Asset and link paths are root-absolute** (`/assets/...`, `/app.js`).
   Relative ones break when the page is served under `/r/`.
5. **`/#get` still reaches the download section**, if you keep that section.

Moving the marketing content to another site is fine, but
`spintracker.buoyantpass.com/` must still render setlists for links that carry
one.

## Tests

```sh
cd server && node --test
```

This needs Node 24 or newer (`node:sqlite`).
