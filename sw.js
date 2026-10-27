'use strict';

/* Jade! — service worker
   All paths are relative to this file, so the app works from a subfolder
   (e.g. https://username.github.io/repo-name/).
   Bump CACHE_VERSION when you change the list of shell files. */

const CACHE_VERSION = 'v5';
const SHELL_CACHE = `habits-shell-${CACHE_VERSION}`;
const FONT_CACHE = 'habits-fonts';

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './stats.js',
  './app.js',
  './manifest.json',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('habits-shell-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Font files never change for a given URL: cache-first
  if (url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // Google Fonts CSS
  if (url.origin === 'https://fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // App shell: serve from cache instantly, refresh in the background.
  // Updates therefore show up on the next launch.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE, request.mode === 'navigate'));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName, isNavigation = false) {
  const cache = await caches.open(cacheName);
  // Navigations may carry a query string (e.g. ?today=…); serve the shell anyway
  const cached = await cache.match(isNavigation ? './' : request, { ignoreSearch: isNavigation });

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(isNavigation ? './' : request, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached || network;
}
