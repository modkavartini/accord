# Chrome Web Store submission — Accord for Google Forms

Everything you need to paste into the Developer Dashboard when publishing. The
packaged upload is built by `pack.sh` (produces `dist/accord-extension-<version>.zip`).

## Listing

**Name:** Accord for Google Forms

**Summary (≤132 chars):**
Auto-fill any Google Form with your verified Google identity through Accord.

**Category:** Productivity

**Language:** English

**Detailed description:**

> Open a Google Form and Accord adds a small “Auto-fill with Accord” button in
> the corner. Click it and the form reopens with your details already in place —
> name, email, college, and anything else you've saved to your Accord profile —
> each filled question marked with a soft highlight so you can see what changed.
>
> Because the button reads the form from your own signed-in browser, it works
> even for forms Accord's server can't open on its own, such as forms restricted
> to an organisation that only a member can view. The first time anyone opens
> such a form through Accord, its questions are remembered so the next visitor —
> on any device, with or without the extension — gets auto-fill too.
>
> Set your details up once at accord-ingly.netlify.app. No accounts to create in
> the extension, no tracking, and it only ever runs on Google Forms pages.
>
> Accord is open source: github.com/modkavartini/accord

**Homepage URL:** https://accord-ingly.netlify.app
**Privacy policy URL:** https://accord-ingly.netlify.app/extension-privacy
**Support:** https://github.com/modkavartini/accord/issues

## Privacy tab answers

**Single purpose:**
> Adds an auto-fill button to Google Forms that prefills the form with the
> details the user has saved in their Accord profile.

**Permission justifications:**

- **Content script on `https://docs.google.com/forms/*`** — the extension's only
  host access. It needs to run on Google Forms pages to inject the button, read
  the form's public question definition, and highlight the questions Accord
  prefilled. It requests no other hosts and no `<all_urls>` access.
- No `tabs`, `storage`, `cookies`, `scripting`, `webRequest`, or history
  permissions are declared. The new tab that opens the Accord gate is created
  with `chrome.tabs.create`, which does **not** require the `tabs` permission.

**Data usage disclosures (check these):**
- The extension does **not** collect or transmit personally identifiable
  information, health, financial, authentication, personal communications,
  location, web history, or user activity.
- It reads a form's public question structure (labels/types/options) and passes
  it to the Accord web app via the new tab's **URL fragment** (never sent over
  the network). No analytics or remote logging.
- Certify: not sold to third parties; not used/transferred for purposes
  unrelated to the single purpose; not used for creditworthiness/lending.

## Assets to upload (not in the zip)

- Store icon: `icons/icon256.png` (256×256; the store also accepts/derives 128).
- At least one 1280×800 (or 640×400) screenshot — suggest: a Google Form with the
  “Auto-fill with Accord” pill, and one showing the highlighted prefilled fields.

## Pre-submit checklist

- [ ] `pack.sh` run; upload `dist/accord-extension-<version>.zip`
- [ ] `extension-privacy.html` deployed and reachable at the privacy URL above
- [ ] Version in `manifest.json` bumped from the previously published version
- [ ] Screenshots + store icon uploaded in the dashboard
