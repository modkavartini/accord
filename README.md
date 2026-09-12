# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord-ingly.netlify.app/go/RqSQeNQN1FLKhKof9

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

## Reader account (forms that require Google sign-in)

Forms with file-upload questions, verified email collection or "limit to 1 response" only show their questions to a signed-in Google account, so an anonymous server fetch gets a 401. Accord handles these with a **dedicated Google account** — the *reader* — whose browser session `parse-form` reuses whenever the anonymous fetch is walled. Any signed-in Google account can view such forms unless the owner restricted them to their organisation, so this covers nearly everything; the Chrome extension remains the fallback for org-restricted forms.

Setup (once, ~5 minutes):

1. Create a throwaway Google account (e.g. `accord.reader@gmail.com`). Don't use a personal one — the session cookies end up in a Netlify env var.
2. In a **separate Chrome profile** (not incognito, so the session isn't dropped), sign in as that account and open any Google Form, e.g. `https://docs.google.com/forms/u/0/`.
3. DevTools → **Network** → click the document request → **Request Headers** → copy the entire value of the `cookie:` header.
4. Store it as `ACCORD_GOOGLE_COOKIE` (scope: Functions) and redeploy:
   ```
   netlify env:set ACCORD_GOOGLE_COOKIE "<paste>"
   netlify deploy --prod --build
   ```
5. Check `https://accord-ingly.netlify.app/.netlify/functions/reader-status` → `{"configured":true,"signedIn":true}`.

Google keeps that session valid for a long time (typically until the account signs out or changes its password), so **leave that Chrome profile signed in and never press "Sign out"**. If `reader-status` ever reports `signedIn:false`, or the gate says *"Accord's reader account session has expired"*, repeat steps 2–4. `parse-form` never logs or echoes the cookie; it is only ever sent to `docs.google.com`, and only after an anonymous fetch has already been refused.

The 403 the gate receives carries `reader: "none" | "expired" | "denied"` so it can tell the visitor whether the fix is on your side (set up / refresh the reader) or theirs (org-restricted → use the extension).

## Chrome extension

Load `chrome-extension/` unpacked (see its README). It adds an **Auto-fill with Accord** button to every Google Form and reads the questions straight from your signed-in browser — the fallback for forms that even the reader account can't view (restricted to an organisation). Accord remembers the form for everyone after that.

## Profile rules

Each rule matches a question by its label (`contains` / `starts with` / `ends with` / `equals`) and fills a value. For **multiple-choice, dropdown and checkbox** questions Accord picks one of the form's own options: automatically (it understands abbreviations — a value of "Computer Science and Engineering" selects "CSE"), or via explicit *option patterns* on the rule, e.g. option `contains "Kidangoor"`. Short-answer questions always get the value verbatim.

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
