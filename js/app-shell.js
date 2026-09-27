/* Shared, dependency-free boot script for every page:
 *   1. Register the service worker (offline + instant repeat loads / warm app).
 *   2. Adapt web-only chrome when running inside the Accord Android app.
 *
 * Classic script (not a module) so it can be dropped on any page with a plain
 * <script defer>. The `.in-app` class is also set synchronously in the <head>
 * of pages that hide elements, to avoid a flash; the work here is the fallback
 * plus the logo-href rewrite.
 */
(function () {
  try {
    var inApp = !!window.AccordBridge || /;\s?wv\)/.test(navigator.userAgent || '');
    if (inApp) {
      document.documentElement.classList.add('in-app');
      // The app's home is native; the "a." logo must never reach the marketing
      // homepage. Point it at the dashboard. (The WebView also intercepts taps
      // on "/" as a backstop — see GateActivity.)
      var logos = document.querySelectorAll('a.logo');
      for (var i = 0; i < logos.length; i++) logos[i].setAttribute('href', '/dashboard');
    }
  } catch (e) { /* non-fatal */ }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* ignore */ });
    });
  }
})();
