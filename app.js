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
  if (typeof payload.v !== 'number' || !Array.isArray(payload.t)) {
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
