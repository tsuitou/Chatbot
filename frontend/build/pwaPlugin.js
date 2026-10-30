import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Emits the web app manifest and a precaching service worker for the
// browser-only build. Hand-rolled instead of vite-plugin-pwa to keep the
// workbox dependency tree out of the install.

const MANIFEST = {
  name: 'Chatbot',
  short_name: 'Chatbot',
  description: 'A chat client for Gemini, Claude and OpenAI-compatible models.',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#4f46e5',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: 'icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}

// Cache-first for the app shell; every other request (all provider API calls
// are cross-origin) goes straight to the network. A new build changes the
// cache name, the page offers a reload, and the old cache is dropped once the
// new worker takes over.
const serviceWorker = (
  cacheName,
  assets
) => `const CACHE = ${JSON.stringify(cacheName)}
const ASSETS = ${JSON.stringify(assets)}
const INDEX = new URL('index.html', self.location).href
const ROOT = new URL('./', self.location).href

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('chatbot-') && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return
  // DevTools re-requests the page this way on reload; fetch() rejects it.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return
  }
  const lookup =
    request.mode === 'navigate' || request.url === ROOT ? INDEX : request
  event.respondWith(
    caches
      .match(lookup)
      // A failed request (offline, aborted by a reload) stays a plain
      // network error instead of an uncaught rejection in the worker.
      .then((cached) => cached || fetch(request).catch(() => Response.error()))
  )
})
`

function listFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

export function pwaPlugin() {
  let publicDir = ''
  let base = '/'
  return {
    name: 'chatbot-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir
      base = config.base
    },
    transformIndexHtml() {
      return [
        {
          tag: 'link',
          attrs: { rel: 'manifest', href: `${base}manifest.webmanifest` },
          injectTo: 'head',
        },
        {
          tag: 'link',
          attrs: { rel: 'apple-touch-icon', href: `${base}icons/icon-192.png` },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: MANIFEST.theme_color },
          injectTo: 'head',
        },
      ]
    },
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(MANIFEST, null, 2),
      })
      const publicFiles = listFiles(publicDir).map((path) =>
        relative(publicDir, path).split('\\').join('/')
      )
      const assets = [
        ...new Set([
          ...Object.keys(bundle),
          ...publicFiles,
          'manifest.webmanifest',
        ]),
      ]
        .filter((name) => !name.endsWith('.map'))
        .sort()
      const hash = createHash('sha256')
      for (const name of assets) {
        hash.update(name)
        const item = bundle[name]
        if (item?.type === 'asset') hash.update(item.source)
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorker(
          `chatbot-${hash.digest('hex').slice(0, 12)}`,
          assets
        ),
      })
    },
  }
}
