// Minimal service worker. BlueEdge needs live network data every time it runs, so this
// intentionally does not cache or serve anything offline — it exists only so Android/Chrome
// treats the app as installable (Add to Home Screen).
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => self.clients.claim());
self.addEventListener("fetch", () => {}); // no-op: always let requests go to the network
