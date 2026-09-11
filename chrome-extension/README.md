# Accord for Google Forms — Chrome extension

When you open a Google Form, a small **"a. Auto-fill with Accord"** pill
appears in the top-right corner of the page. Clicking it reads the form's
questions straight from the page and opens the Accord gate
(`accord-ingly.netlify.app/go/<formId>#schema=…`) in a new tab. The gate then
redirects that tab back to the form with your details prefilled, and every
auto-filled question gets a yellow wash + an "a." badge in the corner.

Because the extension reads the form from **your** signed-in browser, it
works for forms Accord's server can't fetch — ones with file-upload
questions or restricted to an organisation. The first time anyone opens
such a form through the extension, Accord caches its questions, so every
later visitor (phone, no extension, whatever) gets auto-fill at
`/go/<formId>` too.

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
- `styles.css` — button + highlight + badge styles
- `icons/icon.png` — reuses `public/favicon.png` (256×256)

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
