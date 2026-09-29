// Decoding and link building for shared setlists.
//
// A long link carries its payload in the URL fragment, which the browser never
// sends to the server, so the host receives nothing for those. A /r/<code>
// page instead fetches a setlist the server stores for up to 30 days.

/** RFC 3986 unreserved only, matching Swift's StreamingSearchLink exactly.
 *  encodeURIComponent leaves !'()* alone; Swift does not, so finish the job. */
function encodeUnreserved(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** base64url → bytes → raw DEFLATE → JSON.
 *  'deflate-raw' pairs with Swift's NSData.compressed(using: .zlib), which
 *  emits raw DEFLATE per RFC 1951. Do not change one without the other. */
async function decodePayload(fragment) {
  const base64 = fragment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));

  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const json = await new Response(stream).text();

  const payload = JSON.parse(json);
  // Pinned to the one shape this renderer understands: a future encoder
  // version must fail closed here, not hand render() a shape it wasn't
  // written for.
  if (payload.v !== 1 || !Array.isArray(payload.t)) {
    throw new Error('unrecognised payload');
  }
  return payload;
}

/** Exact track page when we have catalog identity, search otherwise. Returns
 *  null for a blank/whitespace-only track, same as spotifySearchURL, so a
 *  blank track hides both links rather than leaving a live Apple Music
 *  search for nothing. */
function appleMusicURL(track) {
  if (track.m) {
    return 'https://music.apple.com/song/' + encodeUnreserved(String(track.m));
  }
  const terms = [track.n, track.a]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!terms) return null;
  return 'https://music.apple.com/search?term=' + encodeUnreserved(terms);
}

/** Spotify's Web API is unreachable (Extended Quota needs 250k MAU), so every
 *  Spotify link is a search. open.spotify.com is universal-linked by the app. */
function spotifySearchURL(track) {
  const terms = [track.n, track.a]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!terms) return null;
  return 'https://open.spotify.com/search/' + encodeUnreserved(terms);
}

/** Thrown when the URL carries no fragment at all — someone typed the domain,
 *  or a share stripped the fragment. Its own type because that visitor gets
 *  the landing pitch, while a fragment that IS present and does not decode is
 *  a broken link and gets told so. Before this split both said "This link is
 *  incomplete", which made the front door of the site an error message. */
class NoPayload extends Error {}

/** A short link whose setlist is gone: past its 30 days, revoked, or never
 *  issued. The server answers all three the same way, so the page does too. */
class Expired extends Error {}

/** A short link that could not be read right now: the server errored or the
 *  network is down. Unlike Expired, trying again can work. */
class Unavailable extends Error {}

/** Separated from render() on purpose: each source of a payload is its own
 *  branch here and nothing else about this page changes. */
async function loadPayload() {
  const short = window.location.pathname.match(/^\/r\/([a-z0-9]{7})$/);
  if (short) {
    let res;
    try {
      res = await fetch('/api/r/' + short[1]);
    } catch {
      throw new Unavailable('network error');
    }
    if (res.status === 410 || res.status === 404) throw new Expired('gone');
    if (!res.ok) throw new Unavailable('status ' + res.status);
    return decodePayload(await res.text());
  }

  const fragment = window.location.hash.slice(1);
  if (!fragment) throw new NoPayload('no payload');
  // An anchor on the landing page itself (#get, the download footer) is a
  // place to scroll to, not a payload. Decoding it failed and showed a
  // visitor looking for the download "This link is incomplete".
  if (document.querySelector('#landing [id="' + CSS.escape(fragment) + '"]')) {
    throw new NoPayload('landing anchor');
  }
  return decodePayload(fragment);
}

/** The two services a class's own playlist may be linked on, and the label
 *  each gets beneath the button. */
const PLAYLIST_SERVICES = {
  'music.apple.com': 'Apple Music',
  'open.spotify.com': 'Spotify',
};

/** A payload value as a plain web link, or null.
 *
 *  The booking and playlist links are the only payload values this page turns
 *  into an href, and a fragment is something anyone can type. So a value draws
 *  nothing unless it parses as an absolute http or https URL with a host, and
 *  one carrying a username or password is refused too: in
 *  "https://cyclebar.com@evil.example" the part a reader sees is not where the
 *  link goes. */
function webURL(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url;
}

/** The class's playlist: only on Apple Music or Spotify, and only a playlist
 *  page — "/playlist/<id>", optionally after a two-letter storefront such as
 *  "/us/playlist/<id>". The same rule the app applies before it will store
 *  one, so a link the app would refuse draws no button here either. */
function playlistLink(value) {
  const url = webURL(value);
  if (!url) return null;
  const service = PLAYLIST_SERVICES[url.hostname];
  if (!service) return null;

  const segments = url.pathname.toLowerCase().split('/').filter(Boolean);
  const index = segments.indexOf('playlist');
  if (index < 0 || index === segments.length - 1) return null;
  if (index > 1 || (index === 1 && !/^[a-z]{2}$/.test(segments[0]))) return null;

  return { href: url.href, detail: service };
}

/** Where to book. The page cannot tell an instructor's link from a studio's,
 *  so the button says where it goes: the hostname, which for an international
 *  domain is its punycode form rather than a lookalike. */
function bookingLink(value) {
  const url = webURL(value);
  if (!url) return null;
  return { href: url.href, detail: url.hostname.replace(/^www\./, '') };
}

function renderAction(link, label) {
  const action = document.createElement('a');
  action.className = 'action';
  action.href = link.href;
  action.target = '_blank';
  action.rel = 'noopener';

  const title = document.createElement('span');
  title.className = 'action-label';
  title.textContent = label;
  const detail = document.createElement('span');
  detail.className = 'action-detail';
  detail.textContent = link.detail;

  action.append(title, detail);
  return action;
}

function renderTrack(track) {
  const item = document.createElement('li');
  item.className = 'track';

  const meta = document.createElement('div');
  meta.className = 'track-meta';
  const title = document.createElement('span');
  title.className = 'track-title';
  title.textContent = track.n;
  const artist = document.createElement('span');
  artist.className = 'track-artist';
  artist.textContent = track.a;
  meta.append(title, artist);

  const links = document.createElement('div');
  links.className = 'track-links';

  const appleHref = appleMusicURL(track);
  if (appleHref) {
    const apple = document.createElement('a');
    apple.href = appleHref;
    apple.target = '_blank';
    apple.rel = 'noopener';
    apple.textContent = 'Apple Music';
    links.append(apple);
  }

  const spotifyHref = spotifySearchURL(track);
  if (spotifyHref) {
    const spotify = document.createElement('a');
    spotify.href = spotifyHref;
    spotify.target = '_blank';
    spotify.rel = 'noopener';
    spotify.textContent = 'Spotify';
    links.append(spotify);
  }

  item.append(meta, links);
  return item;
}

const REPORT_ADDRESS = 'zbproductions22@gmail.com';

/** A mailto: for reporting this page. A short link names its code in the
 *  subject so the operator can find it; a long link's payload can be huge, so
 *  its subject stays generic. */
function reportHref() {
  const short = window.location.pathname.match(/^\/r\/([a-z0-9]{7})$/);
  const subject = short ? 'Report setlist ' + short[1] : 'Report shared setlist';
  const body = "What's wrong with this setlist?\n\n";
  return 'mailto:' + REPORT_ADDRESS + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

function render(payload) {
  document.getElementById('report').href = reportHref();
  // textContent everywhere, never innerHTML: this data came out of a URL.
  document.getElementById('instructor').textContent = payload.i || 'A ride';

  // The class's name leads when the ride has one: "Throwback Ride · CycleBar ·
  // 2026-09-04". Links from older versions carry no name and read as before.
  const venue = [payload.c, payload.s, payload.d].filter(Boolean).join(' · ');
  const handles = [payload.ih, payload.sh].filter(Boolean).map((h) => '@' + h).join(' ');
  document.getElementById('venue').textContent = [venue, handles].filter(Boolean).join(' — ');

  // Each button draws only when its link is present AND passes its check.
  const actions = document.getElementById('actions');
  const play = playlistLink(payload.p);
  if (play) actions.append(renderAction(play, 'Play the playlist'));
  const book = bookingLink(payload.b);
  if (book) actions.append(renderAction(book, 'Book a class'));
  actions.hidden = actions.childElementCount === 0;

  const list = document.getElementById('tracks');
  payload.t.forEach((track) => list.append(renderTrack(track)));

  if (payload.x) {
    const metrics = document.getElementById('metrics');
    const parts = [];
    if (payload.x.dur) parts.push(Math.round(payload.x.dur / 60) + ' min');
    if (payload.x.ahr) parts.push('avg ' + payload.x.ahr + ' bpm');
    if (payload.x.phr) parts.push('peak ' + payload.x.phr + ' bpm');
    if (payload.x.acd) parts.push('avg ' + payload.x.acd + ' rpm');
    if (payload.x.apw) parts.push('avg ' + payload.x.apw + ' W');
    if (parts.length) {
      metrics.textContent = parts.join(' · ');
      metrics.hidden = false;
    }
  }

  document.getElementById('fallback').hidden = true;
  document.getElementById('app').hidden = false;
}

function showLanding() {
  document.body.classList.add('is-landing');
  document.getElementById('fallback').hidden = true;
  document.getElementById('landing').hidden = false;
  // The landing was hidden when the browser tried to honour the fragment, so
  // it scrolled nowhere; do it now that the target is on screen.
  const anchor = window.location.hash.slice(1);
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
}

// The setlist's own CTA points at "/", which differs from "/#payload" only by
// the fragment — so the browser performs a SAME-DOCUMENT navigation, this
// script never re-runs, and the page sits there looking broken. Reloading on
// hashchange re-runs the decision below from scratch, which also avoids
// render() appending a second copy of the tracklist to the list it already
// filled.
window.addEventListener('hashchange', () => window.location.reload());

loadPayload().then(render).catch((error) => {
  // Fallback is visible by default, so a DAMAGED payload needs no action
  // beyond not showing the app. A blank screen would be indistinguishable
  // from the site being down — which is also why the landing is opt-in here
  // rather than the default: if this script never runs at all, a visitor
  // still sees something that explains itself.
  if (error instanceof NoPayload) showLanding();
  else if (error instanceof Expired) {
    showLanding();
    document.getElementById('expired-note').hidden = false;
  } else if (error instanceof Unavailable) {
    document.getElementById('fallback').hidden = true;
    document.getElementById('unavailable').hidden = false;
    document.getElementById('retry').href = window.location.href;
  }
});
