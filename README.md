# Accord

**An API that reads any public Google Form — and a tool that auto-fills forms with your saved identity.**

Accord does two things:

- **`/api`** turns any public Google Form link into JSON: its title, every question, their types and options. No key, no OAuth, no ownership of the form.
- **The filler** takes a form link and prefills it from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already in it.

**[accord.modka.is-a.dev](https://accord.modka.is-a.dev)**

## The API

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

```
GET /api                    what the API offers
GET /api/form?url=<link>    the form's title and questions
```

`url` takes every shape the site takes: a full `docs.google.com` form URL, a `forms.gle` link, a common shortener, or a bare form ID.

`type` is one of `short answer`, `paragraph`, `multiple choice`, `dropdown`, `checkboxes`, `linear scale`, `grid`, `date`, `time`, `email`. `entryId` is the prefill key — `?entry.477113258=Alpha` on the form URL fills that box. `hasOther` says the choice question has an "Other…" box, so an answer outside `options` is allowed.

Errors carry the reason: `403` with `requiresSignIn` for a form only a signed-in account can see, `400` / `422` for a link that is not a readable form. CORS is open, so you can call it straight from a browser.

### Why this doesn't exist anywhere else

Google's own Forms API can't do this. `forms.googleapis.com` requires an OAuth token with Drive-level read access to the form's file — meaning you must **own or co-edit the form**. It also wants the form's editor ID, which a public `/viewform` link doesn't contain, so a form someone shared with you is unreadable through it by design. Being able to *respond* to a form grants no right to *read* it.

So if you want to know what a public form asks — before a person opens it, at scale, from code — there is no official way to ask. Accord is that missing endpoint: hand it any link a human could open, get back structured questions.

**What people build on it:** [arinjo.in](https://arinjo.in) reads registration forms through it to tell a public event from an intra-college one — a form that never asks which college you are from is a form for one campus.

A form's *responses* are never reachable here, only the questions anybody holding the link can already read.

## Try the filler

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord.modka.is-a.dev/go/RqSQeNQN1FLKhKof9

## How it works

1. You give Accord a form — a full link, a `forms.gle` code, or a bare form ID.
2. Accord reads the form's questions: their labels, types and options. (This is the same read `/api` exposes.)
3. Each question is matched against your profile rules, and the answers are turned into a prefilled form URL.
4. You land on the real Google Form with those boxes already filled, and submit it yourself.

Accord fills questions; it never submits anything and never sees your answers. Once a form has been read, its question list is cached, so everyone who opens it after the first visitor gets there instantly — and a form read through `/api` is already warm for the filler, and the other way round.

## Profile rules

Each rule matches a question by its label (`contains` / `starts with` / `ends with` / `equals`) and fills a value. For **multiple-choice, dropdown and checkbox** questions Accord picks the option that literally equals or contains the value or one of the rule's *aliases* — nothing is inferred, so "College of Engineering Trivandrum" never selects "CET" unless you added "CET" as an alias. Short-answer questions always get the value verbatim.

## Onboarding

`/onboarding` walks new accounts through profile setup, one question per screen (name, email, phone, college, branch, year, roll number, IEEE membership). Each answer becomes a profile rule — the same rules `/profile` edits by hand. Brand-new accounts go straight there; everyone else sees a dismissible banner until they finish. Progress is stored on your profile, so it follows you across devices and into the Android app.

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links or rewrite URLs by hand. Flip the "Open by default" toggle on the app's setup card after install.

From v1.3 the app updates itself: it checks for a newer release on launch and from **Settings → Check for updates**, then downloads it and hands it to the system installer. Android still shows its own install prompt — a sideloaded app can't install silently.

## Chrome extension

Live on the Chrome Web Store: **[Accord for Google Forms](https://chromewebstore.google.com/detail/accord-for-google-forms/eglgdegnihkgchpkhjolnfacjakmopmo)** — on desktop, this is the way to use Accord. It adds an **Auto-fill with Accord** button to every Google Form, so you never paste a link: open a form, click the button, come back filled in. It also reads the questions straight from your signed-in browser, which is what makes forms locked to one organisation work at all — and once it has read a form, Accord remembers it for everyone after that.

## Forms that require Google sign-in

Forms with file-upload questions, verified email collection or "limit to 1 response" show their questions only to a signed-in Google account, so they can't be read anonymously. Accord reads these through a persistent signed-in browser session it keeps running — a live browser rather than copied credentials, because Google only lets the browser that created a session keep it alive. Such forms are readable by any signed-in account unless the owner restricted them to their organisation, which covers nearly all of them; the Chrome extension is the fallback for the rest. `/api` reports these as `requiresSignIn`.

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
- Android companion app that intercepts `forms.gle` links

### Stored data

| Collection | Purpose | Visibility |
|---|---|---|
| `accords` | Saved accords (slug → form + fields) | public read · owner writes |
| `profiles/{uid}` | Your fill rules | owner only |
| `user_stats`, `form_visits` | Counters | signed-in write |
| `app_stats/global` | Total user count for the home-page stat | public read |
| `form_schemas/{formId}` | Cached question list per form | public read |

Your profile is readable only by you. Form questions are cached publicly because they're already public to anyone holding the link — your answers are never stored.
