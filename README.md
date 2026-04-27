# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord-ingly.netlify.app/go/RqSQeNQN1FLKhKof9

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

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
- Firebase Auth + Firestore
- Netlify (static hosting + Functions)
- Android companion app under `android/` that intercepts `forms.gle` links
