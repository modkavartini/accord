# Accord

Accord auto-fills Google Forms with details you've saved once — name, email, phone, college, whatever you've taught it. You open a form, it's already filled in, and you submit it yourself.

Site: [accord.modka.is-a.dev](https://accord.modka.is-a.dev)

## Get it

**On desktop — [Chrome extension](https://chromewebstore.google.com/detail/accord-for-google-forms/eglgdegnihkgchpkhjolnfacjakmopmo)**

Adds an **Auto-fill with Accord** button to every Google Form. Open a form, click it, come back with your details in place — no pasting links. The extension reads the questions from your own signed-in browser, so forms locked to a single organisation work too.

**On Android — [download the APK](https://github.com/modkavartini/accord/releases/latest)**

Tapping any `forms.gle` link opens it through Accord automatically; flip the "Open by default" toggle on the setup card after installing. From v1.3 the app updates itself — on launch, or from **Settings → Check for updates** — then hands the download to the system installer. Android shows its own install prompt, as it does for any sideloaded app.

**Anywhere else**, paste a link into [`/fill`](https://accord.modka.is-a.dev/fill), or open `/go/<form-id>` directly.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord.modka.is-a.dev/go/RqSQeNQN1FLKhKof9

## How it works

1. You give Accord a form — a full link, a `forms.gle` code, or a bare form ID.
2. Accord reads the form's questions: their labels, types and options.
3. Each question is matched against your profile rules, and the answers are turned into a prefilled form URL.
4. You land on the real Google Form with those boxes already filled.

Accord fills questions. It never submits anything, and never sees your answers. Once a form has been read its question list is cached, so everyone who opens it after the first visitor gets there instantly.

## Your profile

Sign in once and `/onboarding` walks you through setup, one question per screen: name, email, phone, college, branch, year, roll number, IEEE membership. Each answer becomes a rule, and `/profile` edits those rules by hand later. Everything is stored against your account, so it follows you across devices and into the Android app.

A rule matches a question by its label (`contains` / `starts with` / `ends with` / `equals`) and fills a value. For **multiple-choice, dropdown and checkbox** questions Accord picks the option that literally equals or contains your value or one of its *aliases* — nothing is guessed, so "College of Engineering Trivandrum" never selects "CET" unless you add "CET" as an alias. Short-answer questions get the value verbatim.

## Forms that require Google sign-in

Forms with file-upload questions, verified email collection or "limit to 1 response" show their questions only to a signed-in Google account, so they can't be read anonymously. Accord reads those through a persistent signed-in browser session it keeps running — a live browser rather than copied credentials, because Google only lets the browser that created a session keep it alive. Any signed-in account can view such forms unless the owner restricted them to their organisation, which covers nearly all of them; for the rest, use the Chrome extension.

## Routes

- `/` — landing page
- `/dashboard` — your saved Accords
- `/profile` — edit the field rules used to auto-fill forms
- `/fill` — paste any Google Forms link (or a `bit.ly` / `forms.gle` shortener) to get a one-tap prefill URL
- `/go/<slug>` — saved Accord
- `/go/<formId>` — any Google Form by ID
- `/go/<forms.gle-code>` — any Google Form by short code

## API

The same form reader is exposed as read-only JSON, for anything that needs to know what a form asks before a person opens it.

```
GET /api                    what the API offers
GET /api/form?url=<link>    the form's title and questions
```

```bash
curl "https://accord.modka.is-a.dev/api/form?url=https://forms.gle/RqSQeNQN1FLKhKof9"
```

```json
{
  "formId": "1FAIpQLSf…",
  "formUrl": "https://docs.google.com/forms/d/e/1FAIpQLSf…/viewform",
  "title": "SHOCKWAVE — Registration",
  "requiresSignIn": false,
  "questions": [
    { "entryId": "emailAddress", "label": "Email", "type": "email" },
    { "entryId": "entry.477113258", "label": "Team Name", "type": "short answer", "required": true },
    { "entryId": "entry.1303817865", "label": "Department / Branch", "type": "dropdown",
      "required": true, "options": ["ECE", "CSE", "Other"], "hasOther": true }
  ]
}
```

`url` takes every shape `/fill` takes: a full `docs.google.com` URL, a `forms.gle` link, a common shortener, or a bare form ID. `type` is one of `short answer`, `paragraph`, `multiple choice`, `dropdown`, `checkboxes`, `linear scale`, `grid`, `date`, `time`, `email`. `entryId` is the prefill key — `?entry.477113258=Alpha` on the form URL fills that box. `hasOther` means the question has an "Other…" box, so an answer outside `options` is allowed.

Errors carry the reason: `403` with `requiresSignIn` for a form only a signed-in account can see, `400` / `422` for a link that isn't a readable form. CORS is open. Responses are never reachable here — only the questions anyone holding the link can already read.

Google's own Forms API can't stand in for this: it needs an OAuth token with Drive read access to the form's file, so it only reads forms you own or co-edit, and it takes the editor ID that a public `/viewform` link doesn't carry. [arinjo.in](https://arinjo.in) uses this endpoint to tell a public event from an intra-college one — a registration form that never asks which college you're from is a form for one campus.

## Stack

- Vanilla HTML / CSS / JS, no build step
- Firebase Auth + Firestore (the gate page talks to Firestore over REST — no SDK download on the hot path)
- Netlify (static hosting + Functions)
- Android companion app that intercepts `forms.gle` links

### Stored data

| Collection | Purpose | Visibility |
|---|---|---|
| `accords` | Saved accords (slug → form + fields) | public read · owner writes |
| `profiles/{uid}` | Your fill rules | owner only |
| `user_stats`, `form_visits` | Counters | signed-in write |
| `app_stats/global` | Total user count for the home-page stat | public read |
| `form_schemas/{formId}` | Cached question list per form | public read |

Your profile is readable only by you. Form questions are cached publicly because they're already public to anyone holding the link. Your answers are never stored.
