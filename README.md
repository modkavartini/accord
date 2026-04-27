# Accord

A tool that lets you auto-fill any Google Form with your saved identity.

Accord is a static site that takes any Google Form link and prefills it with values from your profile — name, email, anything you've taught it. Open `/go/<form-id>`, sign in with Google, and the form opens with your details already filled in.

## Try it

Same form, both ways — open them side by side:

- Without Accord: https://forms.gle/RqSQeNQN1FLKhKof9
- With Accord: https://accord-ingly.netlify.app/go/RqSQeNQN1FLKhKof9

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

## Setup

1. Create a Firebase project, enable Google sign-in, and create a Firestore database.
2. Replace `firebaseConfig` in `js/firebase.js` with your project's config.
3. Paste the Firestore rules from below into Firebase Console → Firestore → Rules.
4. Add your Netlify domain (and `localhost`) under Authentication → Settings → Authorized domains.
5. Deploy to Netlify — `_redirects` and `netlify.toml` handle routing and functions automatically.

### Firestore rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /accords/{accordId} {
      allow read: if true;
      allow create: if request.auth != null
                    && request.resource.data.ownerId == request.auth.uid;
      allow update: if request.auth != null
                    && resource.data.ownerId == request.auth.uid
                    && request.resource.data.ownerId == request.auth.uid;
      allow delete: if request.auth != null
                    && resource.data.ownerId == request.auth.uid;
    }
    match /profiles/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /user_stats/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /form_visits/{formId} {
      allow read: if false;
      allow create, update: if request.auth != null;
    }
  }
}
```

## Android app

[**Download the latest APK**](https://github.com/modkavartini/accord/releases/latest) — once installed, tapping any `forms.gle` link on your phone opens it through Accord automatically, so you don't have to paste links into `/fill` or rewrite URLs by hand. Just flip the "Open by default" toggle on the app's setup card after install.

To build from source instead, from `android/`:

```
gradlew.bat assembleDebug
```

APK lands in `android/app/build/outputs/apk/debug/`.
