// Disposable path-stripping proxy for compiled-client tests. No HA connection,
// credentials, normal deployment configuration or production backend is used.
import { createServer, request as proxyRequest } from 'node:http';
import { preview } from 'vite';

const host = '127.0.0.1';
const prefixes = ['/', '/api/hassio_ingress/synthetic_A-123/', '/another/Ingress_token_456/', '/unsafe%2Fprefix/', '/unsafe%22%3E%3Cscript%3E/'];
let prefix = '/';
let redirect: 'none' | 'ha' | 'external' = 'none';
let outside: string[] = [];
let externalHits = 0;
let requests: { method: string; path: string }[] = [];
const upstream = await preview({ mode: 'fixture', preview: { host, port: 4177, strictPort: true } });
const external = createServer((_request, response) => {
  externalHits++;
  response.writeHead(418).end('Synthetic untrusted origin: must not be contacted');
});
external.listen(4178, host);
const proxy = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:4176`);
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__proxy/ready') { response.end('synthetic-prefix-proxy'); return; }
  if (url.pathname === '/__proxy/state' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const state = JSON.parse(body) as { prefix?: string; redirect?: typeof redirect; reset?: boolean };
    if (state.prefix !== undefined) {
      if (!prefixes.includes(state.prefix)) { response.writeHead(422).end(); return; }
      prefix = state.prefix;
    }
    redirect = state.redirect ?? 'none';
    if (state.reset) { requests = []; outside = []; externalHits = 0; }
    response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
  }
  if (url.pathname === '/__proxy/log') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ prefix, requests, outside, externalHits })); return;
  }
  requests.push({ method: request.method ?? 'GET', path: url.pathname + url.search });
  if (prefix !== '/' && url.pathname === prefix.slice(0, -1)) {
    response.writeHead(308, { Location: prefix + url.search }).end(); return;
  }
  if (!url.pathname.startsWith(prefix) || url.pathname === '/api/ha-sentinel') {
    outside.push(url.pathname);
    response.writeHead(418).end('Synthetic HA route: app requests must stay inside the mount'); return;
  }
  const path = '/' + url.pathname.slice(prefix.length) + url.search;
  if (redirect !== 'none' && path === '/api/v1/music/resolve') {
    response.writeHead(302, { Location: redirect === 'ha' ? '/api/ha-sentinel' : `http://${host}:4178/forbidden` }).end(); return;
  }
  const forwarded = proxyRequest({ host, port: 4177, method: request.method, path, headers: { ...request.headers, host: `${host}:4177` } }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      let body = Buffer.concat(chunks);
      // Synthetic artwork belongs to this fixture, so give it the current mount.
      // Real Spotify artwork keeps its already allowlisted external provider URL.
      if (incoming.headers['content-type']?.includes('application/json')) {
        body = Buffer.from(body.toString().replaceAll('"/fixture-artwork.svg"', JSON.stringify(`${prefix}fixture-artwork.svg`)));
      }
      const headers = { ...incoming.headers };
      delete headers['content-length']; delete headers['transfer-encoding'];
      response.writeHead(incoming.statusCode ?? 502, headers); response.end(body);
    });
  });
  forwarded.on('error', () => { response.writeHead(502).end('Synthetic fixture unavailable'); });
  request.pipe(forwarded);
});
proxy.listen(4176, host);
function close() {
  proxy.close(); external.close(); upstream.httpServer.close();
}
process.on('SIGTERM', close); process.on('SIGINT', close);
