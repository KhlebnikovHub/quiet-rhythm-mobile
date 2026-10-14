import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const assets = new Set([
  'index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js',
  'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest',
  'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
]);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8'
};
const options = { host: '127.0.0.1', port: 8787, open: false };
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === '--host') options.host = process.argv[++i];
  else if (argument === '--port') options.port = Number(process.argv[++i]);
  else if (argument === '--open') options.open = true;
  else if (argument === '--help') {
    console.log('node scripts/serve.mjs [--host 127.0.0.1] [--port 8787] [--open]');
    process.exit(0);
  } else throw new Error('Неизвестный аргумент: ' + argument);
}
if (typeof options.host !== 'string' || !/^[\w.:-]+$/u.test(options.host)) throw new Error('Некорректный адрес --host.');
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Порт должен быть целым числом от 1 до 65535.');

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  // The browser must re-check the service worker and source files during development.
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.writeHead(405).end('Method not allowed');
    return;
  }
  try {
    const pathname = decodeURIComponent((request.url || '/').split('?')[0]);
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) {
      response.writeHead(400).end('Invalid path');
      return;
    }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!assets.has(name)) { response.writeHead(404).end('Not found'); return; }
    const filename = await realpath(path.join(root, name));
    if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end('Forbidden'); return; }
    const info = await stat(filename);
    if (!info.isFile()) { response.writeHead(404).end('Not found'); return; }
    const body = await readFile(filename);
    response.setHeader('Content-Type', types[path.extname(name)] || 'application/octet-stream');
    response.setHeader('Content-Length', body.byteLength);
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : error.code === 'ENOENT' ? 404 : 500).end('Unable to serve file');
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${options.port} занят. Укажите другой: --port 8788` : error.message);
  process.exitCode = 1;
});
server.listen(options.port, options.host, () => {
  const displayHost = ['0.0.0.0', '::'].includes(options.host) ? '127.0.0.1' : options.host;
  const address = displayHost.includes(':') ? '[' + displayHost + ']' : displayHost;
  const url = `http://${address}:${options.port}/`;
  console.log('Тихий ритм: ' + url);
  console.log('Остановить сервер: Ctrl+C.');
  if (options.host === '0.0.0.0' || options.host === '::') console.log('Сервер доступен в локальной сети. Для установки и офлайн-режима на телефоне нужен HTTPS.');
  if (options.open) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const browser = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log('Откройте адрес выше в браузере.'));
    browser.unref();
  }
});
