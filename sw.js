'use strict';

// The web build replaces this development marker with a hash of every asset.
// New releases wait for the editor to finish saving before SKIP_WAITING.
const APP_VERSION = 'dev-v5';
const CACHE_PREFIX = 'quiet-rhythm-mobile:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const FILES = [
  './', './index.html', './styles.css', './app.js', './core.js',
  './sample-tabs.js', './playback.js', './export.js', './storage.js',
  './manifest.webmanifest', './app-icon.svg', './icon-192.png',
  './icon-512.png', './apple-touch-icon.png'
];
const ASSETS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(FILES.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
    // v1-v4 cannot request activation. Migrate their cache once without forcing
    // open editors to navigate: the next normal refresh serves the new app.
    const names = await caches.keys();
    if (names.some(name => name.startsWith(CACHE_PREFIX) && /^v[1-4]$/.test(name.slice(CACHE_PREFIX.length)))) {
      await self.skipWaiting();
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'SKIP_WAITING' || !event.source?.url) return;
  const source = new URL(event.source.url);
  const scope = new URL(self.registration.scope);
  if (source.origin === scope.origin && source.pathname.startsWith(scope.pathname)) {
    event.waitUntil(self.skipWaiting());
  }
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
