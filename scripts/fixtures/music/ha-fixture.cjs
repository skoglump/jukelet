// Synthetic SpotifyPlus fixtures. Never forward a request or contact upstream.
const http = require('node:http');
let attempts = 0;
const fields = { entity_id: {}, album_id: {} };
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/api/services') {
    response.end(JSON.stringify([{ domain: 'spotifyplus', services: { get_album: { fields, response: { optional: false } } } }]));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/services/spotifyplus/get_album?return_response') {
    response.writeHead(404); response.end('{}'); return;
  }
  let data = '';
  request.on('data', chunk => { data += chunk; if (data.length > 4096) request.destroy(); });
  request.on('end', () => {
    let input;
    try { input = JSON.parse(data); } catch { response.writeHead(400); response.end('{}'); return; }
    if (input.entity_id !== 'media_player.synthetic' || input.album_id !== '0123456789ABCDEFGHIJKL') {
      response.writeHead(400); response.end('{}'); return;
    }
    attempts++;
    if (attempts > 1) { response.writeHead(attempts === 2 ? 429 : 404); response.end('{}'); return; }
    response.end(JSON.stringify({ service_response: { result: {
      uri: 'spotify:album:0123456789ABCDEFGHIJKL', type: 'album', name: 'Synthetic album',
      artists: [{ name: 'Fixture artist' }], images: [{ url: 'https://i.scdn.co/image/synthetic' }],
    } } }));
  });
}).listen(process.env.PORT);
