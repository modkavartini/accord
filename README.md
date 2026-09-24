# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord.modka.is-a.dev/go/RqSQeNQN1FLKhKof9

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

## Onboarding (`/onboarding`)

Step-by-step profile setup: one question per screen (name, email, phone, college, branch, year, roll number, IEEE membership). Each answer becomes a rule in the user's profile — the same rules `/profile` edits by hand — so nothing else changes. Brand-new accounts (only the seeded Name + Email, never offered the questions) are sent straight there from the dashboard; everyone else sees a dismissible "Set up your profile in a minute" banner until they finish it. Completion/dismissal is stored as `onboardingStatus: 'done' | 'skipped'` on the profile doc, so it follows the user across devices and the Android app (which loads the same pages) needs no update.

## Android release builds

The canonical release asset lives on GitHub: `https://github.com/modkavartini/accord/releases/latest/download/Accord.apk` (always named `Accord.apk`, so that link never changes). The **site** does not link there directly, though: at deploy time Netlify fetches that APK into `download/Accord.apk` and serves it from our own origin as `/download/Accord.apk` (`application/octet-stream`; see `netlify.toml`, `_headers`). This avoids GitHub's short-lived cross-origin signed redirect, which leaves some Android download managers (Nothing OS among them) stuck at 100%. If the build-time fetch ever fails, `_redirects` falls back to a GitHub redirect. The home page's Download buttons and `app-release.json`'s `apkUrl` both point at `/download/Accord.apk`.

To publish a new build: bump the version, `assembleRelease`, then create a release tagged `vX.Y` with `app-release.apk` uploaded as `Accord.apk`.

Release builds are signed with the key in `android/keystore.properties` (git-ignored; see `keystore.properties.example`). The keystore lives outside the repo at `~/.android/accord-release.jks` — **back it up**; without it no update can ever be shipped to the same app. Its SHA-1 must be registered in Firebase → Project settings → Android app (then re-download `google-services.json`) or Google Sign-In fails in release builds.

```
cd android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ./gradlew assembleRelease bundleRelease
# → app/build/outputs/apk/release/app-release.apk   (sideload)
# → app/build/outputs/bundle/release/app-release.aab (Play Console)
```

Bump `versionCode`/`versionName` in `app/build.gradle` for every upload. A release-signed build won't install over the old debug-signed one — uninstall first.

### In-app updates (OTA)

From v1.3 the app updates itself instead of making users hunt down the APK. On
launch (throttled to once every 6h) and from **Settings → Check for updates**, it
reads `app-release.json` at the site root and, if that `versionCode` is higher
than the installed build, offers to download the release APK and hand it to the
system installer (`AppUpdater.kt` / `UpdateUi.kt`). Android still shows its own
install prompt — a sideloaded app can't install silently — and the download must
be **signed with the same release key**, so this only updates release builds over
release builds. `apkUrl` points at `/download/Accord.apk` (the same-origin file
Netlify fetches at deploy time), so it never changes between versions.

**Every release must bump two things together:** `versionCode`/`versionName` in
`app/build.gradle` *and* `app-release.json` (`versionCode`, `versionName`,
`notes`). Publish the GitHub release first (so `Accord.apk` exists at the URL for
the deploy's build step to fetch), then deploy the site with the matching
`app-release.json`. Because only v1.3+
carries the updater, users still on ≤ v1.2 upgrade to v1.3 manually once; every
release after that is picked up in-app.

## Reader (forms that require Google sign-in)

Forms with file-upload questions, verified email collection or "limit to 1 response" only show their questions to a signed-in Google account, so an anonymous server fetch gets a 401. Accord reads these through the **reader**: a persistent, logged-in Chromium running on a Raspberry Pi. When `parse-form` hits a sign-in wall it hands the form to the reader (`lib/reader-remote.js`), which opens it in a real browser and returns the rendered HTML. Any signed-in Google account can view such forms unless the owner restricted them to their organisation, so this covers nearly everything; the Chrome extension remains the fallback for org-restricted forms.

Why a real browser and not copied cookies: Google only lets the browser that created a session rotate its short-lived gating token, so a cookie header copied into the cloud dies within a couple of hours. A browser that stays running rotates its own session and just keeps working.

### On the Pi

- `~/accord-reader/server.js` — Node + `playwright-core` driving the system Chromium (`/usr/bin/chromium`) with a persistent profile under `~/accord-reader/profile`. Serves `POST /read {url}` and `GET /health`, both requiring `Authorization: Bearer $READER_TOKEN`, bound to `127.0.0.1:8787`. Only `docs.google.com` / `forms.gle` URLs are allowed (no general fetch proxy).
- systemd unit `accord-reader.service` runs it headed under Xvfb (`xvfb-run`), `Restart=always`, enabled on boot.
- Exposed to Netlify via **Tailscale Funnel**: `https://mypi.tail2bd02e.ts.net` → `127.0.0.1:8787` (funnel config persists across reboots).
- Config in `~/accord-reader/reader.env` (chmod 600): `READER_TOKEN`, `PROFILE_DIR`, `CHROMIUM_PATH`, `PORT`.

### Netlify env

- `READER_ENDPOINT` = `https://mypi.tail2bd02e.ts.net`
- `READER_TOKEN` = the shared bearer token (matches the Pi's `reader.env`)

Check `https://accord.modka.is-a.dev/.netlify/functions/reader-status` → `{"configured":true,"signedIn":true}`.

### One-time / occasional login

The reader account must be signed into the service's profile. The Pi is headless, so sign in over a temporary noVNC view:

1. From a terminal (real TTY for the SSH password): `ssh pi@mypi "~/accord-reader/accord-login-remote"`. It prints a `http://<tailscale-ip>:6080/vnc.html…` URL (bound to the Tailscale IP only).
2. Open that URL on any device on your tailnet, sign in as the reader account until a Google Forms page shows.
3. Run `ssh pi@mypi "~/accord-reader/accord-login-done"` to tear the view down and restart the service.

If `reader-status` ever shows `signedIn:false`, repeat those steps. `readViaPi` never logs the token; it is only sent to the reader endpoint.

### Caching

Every successful parse is cached per-form in a Netlify Blob (`lib/schema-cache.js`, 7-day TTL) and at Netlify's edge (`s-maxage`), keyed by form ID. The first visitor to a form pays the parse cost (and, for walled forms, the Pi round-trip); everyone after — on any device — gets it in a fraction of a second, and the reader isn't hit again for that form. The gate's `form_schemas` write is a third, cross-user layer on top.

The 403 the gate receives carries `reader: "none" | "expired" | "denied"` so it can tell the visitor whether the fix is on the owner's side (reader not set up / offline) or theirs (org-restricted → use the extension).
## Chrome extension

Live on the Chrome Web Store: **[Accord for Google Forms](https://chromewebstore.google.com/detail/accord-for-google-forms/eglgdegnihkgchpkhjolnfacjakmopmo)** (or load `chrome-extension/` unpacked for development — see its README). It adds an **Auto-fill with Accord** button to every Google Form and reads the questions straight from your signed-in browser — the fallback for forms that even the reader account can't view (restricted to an organisation). Accord remembers the form for everyone after that.

## Profile rules

Each rule matches a question by its label (`contains` / `starts with` / `ends with` / `equals`) and fills a value. For **multiple-choice, dropdown and checkbox** questions Accord picks the option that literally equals or contains the value or one of the rule's *aliases* (`choicePatterns`) — nothing is inferred, so "College of Engineering Trivandrum" never selects "CET" unless the user added "CET" as an alias. Explicit modes (`contains` / `starts with` / …) apply the aliases as operators instead. Short-answer questions always get the value verbatim.

## Routes

- `/` — landing page
- `/dashboard` — your saved Accords
- `/profile` — edit the field rules used to auto-fill forms
- `/fill` — paste any Google Forms link (or a `bit.ly` / `forms.gle` shortener) to get a one-tap prefill URL
- `/go/<slug>` — saved Accord
- `/go/<formId>` — any Google Form by ID
- `/go/<forms.gle-code>` — any Google Form by short code

## Stack

- Vanilla HTML / CSS / JS, no build step
- Firebase Auth + Firestore (the gate page talks to Firestore over REST — no SDK download on the hot path)
- Netlify (static hosting + Functions)
- Android companion app under `android/` that intercepts `forms.gle` links

## Firestore collections

| Collection | Purpose | Rules |
|---|---|---|
| `accords` | Saved accords (slug → form + fields) | read: public · write: owner |
| `profiles/{uid}` | Per-user fill rules | owner only |
| `user_stats/{uid}`, `form_visits/{formId}` | Counters | signed-in write |
| `form_schemas/{formId}` | Cached question list per form (server-parsed or extension-read) | read: public · write: any signed-in user |

```
match /form_schemas/{formId} {
  allow read: if true;
  allow write: if request.auth != null
               && request.resource.data.formId == formId
               && request.resource.data.fields is list;
}
```
