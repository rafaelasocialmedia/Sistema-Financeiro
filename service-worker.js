// Incrementa a versão sempre que quiser forçar atualização
const CACHE_NAME = 'finpro-v3';

// Ao instalar, limpa caches antigos e não cacheia nada
self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Sempre busca da rede — nunca serve do cache
self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});
