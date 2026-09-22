# Accord for Google Forms — Chrome extension

When you open a Google Form, a small **"a. Auto-fill with Accord"** pill
appears in the top-right corner of the page. Clicking it reads the form's
questions straight from the page and opens the Accord gate
(`accord-ingly.netlify.app/go/<formId>#schema=…`) in a new tab. The gate then
redirects that tab back to the form with your details prefilled, and every
auto-filled question gets a yellow wash + an "a." badge in the corner.

Because the extension reads the form from **your** signed-in browser, it
works for forms Accord's server can't fetch. Accord's server normally reads
sign-in-walled forms (file uploads, verified email) through its own reader
Google account; the extension is the fallback for forms **restricted to an
organisation**, which only a member's browser can view. The first time
anyone opens such a form through the extension, Accord caches its
questions, so every later visitor (phone, no extension, whatever) gets
auto-fill at `/go/<formId>` too.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this `chrome-extension/` folder.
4. Open any Google Form (e.g. one of your `/go/<slug>` Accords' destinations) —
   you should see the toast and a new tab pop open.

## Files

- `manifest.json` — MV3 manifest, content script on `docs.google.com/forms/*`
- `background.js` — service worker; opens the gate tab on button click
- `content.js` — button injection, form-schema extraction, post-prefill highlighting
- `styles.css` — button + highlight + badge styles; bundles the brand fonts via
  `@font-face` (see below)
- `fonts/` — `urbanist-latin.woff2` (pill + toast text) and `cormorant-mark.woff2`
  (the italic "a." mark, subset to just those glyphs). Bundled because
  `docs.google.com`'s CSP blocks a content script from loading Google Fonts;
  declared as `web_accessible_resources` so the page may fetch them.
- `icons/icon{16,48,128}.png` — toolbar/store icons, from `public/favicon.png`.
  `icon256.png` is the store-listing icon (not shipped in the zip).

## Packaging for the Chrome Web Store

Run `bash pack.sh` → produces `dist/accord-extension-<version>.zip` containing only
the files the extension ships (no docs, no 256px icon). Upload that in the
Developer Dashboard. Listing copy, permission justifications and the privacy-tab
answers are in `STORE.md`; the hosted privacy policy is `extension-privacy.html`
at the repo root (served at `/extension-privacy`).

Set `DEBUG = true` at the top of `content.js` to re-enable console logging while
developing; it ships `false` so a normal form visit leaves the page console clean.

## How it decides what to do

- URL is `/forms/d/e/<id>/viewform` **without** any `entry.X` param,
  and the visitor didn't just come from the Accord gate →
  inject the "Auto-fill with Accord" button. On click, the question list
  (labels, entry IDs, types, choice options) is parsed from the page's
  inline `FB_PUBLIC_LOAD_DATA_` script — falling back to the rendered
  questions' `data-params` — and passed to the gate in the URL fragment.
  Fragments never leave the browser; the gate decides what to cache.
- URL is `/forms/d/e/<id>/viewform` **with** `entry.X` params →
  it's the post-gate prefilled form; show a confirmation toast and
  highlight the prefilled questions.
- URL has no entry params **but** `document.referrer` is `accord-ingly.netlify.app` →
  the gate sent the visitor here even though no fields matched; don't
  re-show the button (would invite a loop). Visitor can still fill manually.
- URL is the form editor (`/forms/d/<id>/edit`) → ignored.
