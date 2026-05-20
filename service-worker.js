const CACHE_NAME = 'finpro-v1';
const ASSETS = [
  './Financeirofinal.html',
  './manifest.json'
];

// Instala e cacheia os arquivos principais
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Limpa caches antigos ao ativar
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// Network first, fallback para cache (garante dados frescos quando online)
self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Atualiza o cache com a versão mais recente
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
        return response;
      })
      .catch(function() {
        // Offline: serve do cache
        return caches.match(event.request);
      })
  );
});
