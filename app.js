// Decoding and link building for shared setlists.
//
// The payload arrives in the URL fragment, which the browser never sends to
// the server — so this page's host receives nothing. Nothing is stored.

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

/** Exact track page when we have catalog identity, search otherwise. */
function appleMusicURL(track) {
  if (track.m) {
    return 'https://music.apple.com/song/' + encodeUnreserved(String(track.m));
  }
  const terms = [track.n, track.a].filter(Boolean).join(' ');
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

/** Separated from render() on purpose: a future backend adds a second loader
 *  reading /r/<id> and nothing else about this page changes. */
async function loadPayload() {
  const fragment = window.location.hash.slice(1);
  if (!fragment) throw new Error('no payload');
  return decodePayload(fragment);
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

  const apple = document.createElement('a');
  apple.href = appleMusicURL(track);
  apple.target = '_blank';
  apple.rel = 'noopener';
  apple.textContent = 'Apple Music';
  links.append(apple);

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

function render(payload) {
  // textContent everywhere, never innerHTML: this data came out of a URL.
  document.getElementById('instructor').textContent = payload.i || 'A ride';

  const venue = [payload.s, payload.d].filter(Boolean).join(' · ');
  const handles = [payload.ih, payload.sh].filter(Boolean).map((h) => '@' + h).join(' ');
  document.getElementById('venue').textContent = [venue, handles].filter(Boolean).join(' — ');

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

loadPayload().then(render).catch(() => {
  // Fallback is visible by default, so a failure needs no action beyond
  // not showing the app. A blank screen would be indistinguishable from
  // the site being down (cf. SpinTracker-4qh).
});
