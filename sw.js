'use strict';

// Bump the version whenever any app-shell asset changes. A new version waits
// until every old app window closes, keeping open editors on a consistent build.
const CACHE_PREFIX = 'quiet-rhythm-mobile:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + 'v4';
const FILES = [
  './', './index.html', './styles.css', './app.js', './core.js',
  './sample-tabs.js', './playback.js', './export.js', './storage.js',
  './manifest.webmanifest', './app-icon.svg', './icon-192.png',
  './icon-512.png', './apple-touch-icon.png'
];
const ASSETS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
    FILES.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const canonical = url.origin + url.pathname;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(new URL('./index.html', scope).href) || fetch(request);
    })());
  } else if (ASSETS.has(canonical)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(canonical) || fetch(request);
    })());
  }
});
