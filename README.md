# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord-ingly.netlify.app/go/RqSQeNQN1FLKhKof9

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

## Onboarding (`/onboarding`)

Step-by-step profile setup: one question per screen (name, email, phone, college, branch, year, roll number, IEEE membership). Each answer becomes a rule in the user's profile — the same rules `/profile` edits by hand — so nothing else changes. Brand-new accounts (only the seeded Name + Email, never offered the questions) are sent straight there from the dashboard; everyone else sees a dismissible "Set up your profile in a minute" banner until they finish it. Completion/dismissal is stored as `onboardingStatus: 'done' | 'skipped'` on the profile doc, so it follows the user across devices and the Android app (which loads the same pages) needs no update.

## Android release builds

Users get the app from the GitHub release: `https://github.com/modkavartini/accord/releases/latest/download/Accord.apk` (the asset is always named `Accord.apk` so that link never changes; the home page's Download button points at it). To publish a new build: bump the version, `assembleRelease`, then create a release tagged `vX.Y` with `app-release.apk` uploaded as `Accord.apk`.

Release builds are signed with the key in `android/keystore.properties` (git-ignored; see `keystore.properties.example`). The keystore lives outside the repo at `~/.android/accord-release.jks` — **back it up**; without it no update can ever be shipped to the same app. Its SHA-1 must be registered in Firebase → Project settings → Android app (then re-download `google-services.json`) or Google Sign-In fails in release builds.

```
cd android
JAVA_HOME="C:/Program Files/Android/Android Studio/jbr" ./gradlew assembleRelease bundleRelease
# → app/build/outputs/apk/release/app-release.apk   (sideload)
# → app/build/outputs/bundle/release/app-release.aab (Play Console)
```

Bump `versionCode`/`versionName` in `app/build.gradle` for every upload. A release-signed build won't install over the old debug-signed one — uninstall first.

## Reader account (forms that require Google sign-in)

Forms with file-upload questions, verified email collection or "limit to 1 response" only show their questions to a signed-in Google account, so an anonymous server fetch gets a 401. Accord handles these with a **dedicated Google account** — the *reader* — whose browser session `parse-form` reuses whenever the anonymous fetch is walled. Any signed-in Google account can view such forms unless the owner restricted them to their organisation, so this covers nearly everything; the Chrome extension remains the fallback for org-restricted forms.

Setup (once, ~5 minutes):

1. Create a throwaway Google account (e.g. `accord.reader@gmail.com`). Don't use a personal one — the session cookies end up in a Netlify env var.
2. In a **new Chrome profile with only that account in it** (not incognito, so the session isn't dropped; not your normal profile — a profile's cookie header is one shared session for *every* account signed in to it), sign in and open any Google Form's `viewform` URL.
3. DevTools → **Network** → reload → click the top request (host `docs.google.com`) → **Request Headers** → copy the entire value of the `cookie:` header. It must contain `OSID` / `__Secure-OSID` (the docs.google.com session); a header copied from a `google.com` request won't, and `reader-status` will say so.
4. Store it as `ACCORD_GOOGLE_COOKIE` (scope: Functions) and redeploy:
   ```
   netlify env:set ACCORD_GOOGLE_COOKIE "<paste>"
   netlify deploy --prod --build
   ```
5. Check `https://accord-ingly.netlify.app/.netlify/functions/reader-status` → `{"configured":true,"signedIn":true}`.

Google rotates session cookies (`SIDCC`, `__Secure-*PSIDCC`, …) on nearly every response and stops honouring old ones after a few days, so the env var is only a *seed*: every reader fetch merges Google's `Set-Cookie` headers into a copy kept in Netlify Blobs (`lib/reader-session.js`), and the scheduled `reader-keepalive` function pings `docs.google.com` every 30 minutes so the session never idles out — the same thing an open browser tab does. Setting a new `ACCORD_GOOGLE_COOKIE` always supersedes the stored copy. **Leave that Chrome profile signed in and never press "Sign out"**. If `reader-status` reports `signedIn:false`, or the gate says *"Accord's reader account session has expired"*, repeat steps 2–4. `parse-form` never logs or echoes the cookie; it is only ever sent to `docs.google.com`, and only after an anonymous fetch has already been refused.

The 403 the gate receives carries `reader: "none" | "expired" | "denied"` so it can tell the visitor whether the fix is on your side (set up / refresh the reader) or theirs (org-restricted → use the extension).

## Chrome extension

Load `chrome-extension/` unpacked (see its README). It adds an **Auto-fill with Accord** button to every Google Form and reads the questions straight from your signed-in browser — the fallback for forms that even the reader account can't view (restricted to an organisation). Accord remembers the form for everyone after that.

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
