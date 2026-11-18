import { handleFeedback } from './feedback.mjs';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; manifest-src 'self'";
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const embeddedAssets = typeof __GUIDE_ASSETS__ === 'undefined' ? {} : __GUIDE_ASSETS__;
function finish(response, method) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
}
function plain(status, text, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

/** The build embeds only web/ assets; dev passes the same asset map from local files. */
export function createGuide(assets = embeddedAssets) {
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === '/api/feedback') return finish(await handleFeedback(request, env), request.method);
      const name = path === '/' ? '/index.html' : path;
      if (!Object.hasOwn(assets, name)) return finish(plain(404, 'Not found'), request.method);
      if (!['GET', 'HEAD'].includes(request.method)) return finish(plain(405, 'Method not allowed', { allow: 'GET, HEAD' }), request.method);
      const asset = assets[name];
      const headers = {
        'content-type': asset.type,
        'cache-control': name.endsWith('.html') ? 'no-cache' : 'public, max-age=0, must-revalidate',
        'etag': asset.etag,
      };
      if (request.headers.get('if-none-match')?.split(',').some(value => value.trim().replace(/^W\//, '') === asset.etag || value.trim() === '*')) {
        return finish(new Response(null, { status: 304, headers }), request.method);
      }
      headers['content-length'] = String(asset.size);
      const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.base64), character => character.charCodeAt(0));
      return finish(new Response(bytes, { headers }), request.method);
    },
  };
}

export default createGuide();
