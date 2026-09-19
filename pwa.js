// Registers the (network-only) service worker so the app can be added to the home screen.
// Lives in its own file because the page's Content-Security-Policy forbids inline scripts.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
