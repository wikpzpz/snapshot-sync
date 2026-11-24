/**
 * Serve the API on your own domain (e.g. secs.se/api/...).
 *
 * The API itself runs on Freebuff Sites; this Worker only forwards requests, so
 * there is no database, no key and no scraping here.
 *
 * Cloudflare setup (one minute):
 *   1. Dashboard → Workers & Pages → Create → Worker → give it a name
 *      (e.g. `the API-proxy`) → Edit code → paste this whole file → Deploy.
 *   2. That Worker → Settings → Triggers → Add route:
 *        Route:  secs.se/api/*      (pick your zone)
 *      Save. Requests to https://secs.se/api/... now hit this Worker.
 *
 * Then from your site: fetch('/api/country/Sweden')
 */
const ORIGIN = 'https://cs2api-461yz8-preview.freebuff.site';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    // Same path and query, different host: /api/country/Sweden → ORIGIN/api/country/Sweden
    const upstream = await fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });

    const headers = new Headers(upstream.headers);
    headers.set('access-control-allow-origin', '*');
    headers.set('x-robots-tag', 'noindex, nofollow, noarchive');

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
