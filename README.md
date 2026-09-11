# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord-ingly.netlify.app/go/RqSQeNQN1FLKhKof9

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

## Chrome extension

Load `chrome-extension/` unpacked (see its README). It adds an **Auto-fill with Accord** button to every Google Form. Forms that require Google sign-in (file uploads, restricted access) can't be read by Accord's server — the extension reads them from your signed-in browser instead and Accord remembers the form for everyone after that.

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
