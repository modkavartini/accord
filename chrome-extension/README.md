# Accord for Google Forms — Chrome extension

When you open a Google Form, a small **"a. Auto-fill with Accord"** pill
appears in the top-right corner of the page. Clicking it opens the Accord
gate (`accord-ingly.netlify.app/go/<formId>`) in a new tab. The gate then
redirects that tab back to the form with your details prefilled, and every
auto-filled question gets a yellow wash + an "a." badge in the corner.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this `chrome-extension/` folder.
4. Open any Google Form (e.g. one of your `/go/<slug>` Accords' destinations) —
   you should see the toast and a new tab pop open.

## Files

- `manifest.json` — MV3 manifest, content script on `docs.google.com/forms/*`
- `background.js` — service worker; opens the gate tab on message
- `content.js` — toast + gate launch + post-prefill highlighting
- `styles.css` — toast + highlight + badge styles
- `icons/icon.png` — reuses `public/favicon.png` (256×256)

## How it decides what to do

- URL is `/forms/d/e/<id>/viewform` **without** any `entry.X` param →
  toast + launch the Accord gate in a new tab. (The original tab stays put.)
- URL is `/forms/d/e/<id>/viewform` **with** `entry.X` params →
  it's the post-gate prefilled form; just highlight the prefilled questions.
- URL is the form editor (`/forms/d/<id>/edit`) → ignored.

A `sessionStorage` flag keyed by pathname prevents re-launching the gate on
reload of the same form tab.
