const esc = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The <title> and <meta> tags for a decoded setlist payload, or '' for null
// (the caller then leaves index.html's own tags in place). Only fields the
// setlist itself carries can appear, and every value is HTML-escaped.
export function previewHead(payload, pageURL) {
  if (!payload || typeof payload !== 'object') return '';
  const title = text(payload.c) ?? 'A spin class setlist';
  const count = Array.isArray(payload.t) ? payload.t.length : 0;
  const parts = [
    `${count} ${count === 1 ? 'track' : 'tracks'}`,
    text(payload.i),
    text(payload.s),
    text(payload.d),
  ].filter(Boolean);
  const description = parts.join(' · ');
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(pageURL)}">`,
    `<meta property="og:type" content="website">`,
    `<meta name="twitter:card" content="summary">`,
  ].join('\n    ');
}
