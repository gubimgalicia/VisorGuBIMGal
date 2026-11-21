// Replaces coi-serviceworker, which a visitor's browser may still have registered. The kernel is
// single-threaded and needs no cross-origin isolation, and the COEP header that worker added
// blocked map tiles. This removes itself and reloads the page once.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url))))
  );
});