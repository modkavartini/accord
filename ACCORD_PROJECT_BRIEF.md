# Accord — Project Brief

## What is Accord?
Accord is a web app that creates identity-verified Google Form links.

**Core flow:**
1. Admin (you) logs in with Google → creates an "Accord"
2. An Accord = a named bundle with a custom short slug + a Google Form URL + prefill field IDs
3. You share `accord-ingly.netlify.app/go/your-slug` with attendees
4. When they open the link → they're prompted to sign in with Google (if not already)
5. Their Google display name + email auto-prefill the form via URL params
6. They're redirected to the prefilled Google Form → submit it
7. You get form responses with verified Google account names you can cross-reference with Google Meet attendee lists

## Why it exists
You run robotics/STEM training sessions via Google Meet and need to issue certificates to verified attendees. The Meet export gives you Google account display names but not real names or emails. Accord bridges this gap by collecting real name + verified Google identity in one form submission.

---

## Tech Stack
- **Frontend:** Vanilla HTML + CSS + JavaScript (ES modules, no build step)
- **Auth:** Firebase Authentication (Google OAuth)
- **Database:** Firebase Firestore
- **Hosting:** Netlify (static site, with `_redirects` for SPA routing)
- **Base URL:** `accord-ingly.netlify.app`

---

## Pages / Routes
| Route | File | Description |
|---|---|---|
| `/` | `index.html` | Landing page — hero + "Sign in with Google" |
| `/dashboard` | `dashboard.html` | Logged-in user's Accord list + create/edit/delete |
| `/go/:slug` | `gate.html` | Magic redirect page — signs in visitor, prefills + redirects to form |

Since it's a static site with multiple HTML pages (not SPA), routing is handled by Netlify's `_redirects` only for the `/go/*` pattern pointing to `gate.html`.

---

## Design Language
- **Theme:** Black (#080808 bg), white text, glassmorphism cards
- **Fonts (Google Fonts):**
  - `Cormorant Garamond` — display/headings (italic for logo, light for hero)
  - `Urbanist` — body text, UI labels, buttons
  - `DM Mono` — slugs, code-like fields, metadata
- **Glass cards:** `background: rgba(255,255,255,0.04)`, `border: 1px solid rgba(255,255,255,0.08)`, `backdrop-filter: blur(20px)`
- **Buttons:**
  - Primary: white bg, black text, `font-family: Urbanist`, `font-weight: 600`
  - Ghost: transparent, white border, white text at 50% opacity
  - Danger: red-tinted bg, red text
- **Noise overlay:** SVG fractalNoise pseudo-element on body for texture
- **Ambient orbs:** fixed radial-gradient blurred circles for depth

---

## Firebase Data Model

### Collection: `accords`
```
{
  id: string,           // nanoid
  name: string,         // "Meet Attendance — Batch 2"
  slug: string,         // "batch-2-kalady" (unique, URL-safe)
  formUrl: string,      // full Google Form URL
  nameParam: string,    // "entry.123456789" — prefill field for account name
  emailParam: string,   // "entry.987654321" — prefill field for email
  ownerId: string,      // Firebase Auth UID
  ownerEmail: string,
  createdAt: Timestamp,
  visits: number
}
```

### Firestore Security Rules (to add in Firebase Console)
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /accords/{id} {
      allow read: if true;  // gate.html needs to read by slug without auth
      allow write: if request.auth != null && request.auth.uid == resource.data.ownerId;
      allow create: if request.auth != null;
    }
  }
}
```

---

## Firebase Config (you fill this in)
```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```
Get this from: Firebase Console → Project Settings → Your Apps → Web App

---

## File Structure
```
accord/
├── index.html          # Landing page
├── dashboard.html      # Dashboard (auth-gated)
├── gate.html           # /go/:slug redirect page
├── _redirects          # Netlify routing: /go/*  /gate.html  200
├── css/
│   └── style.css       # Shared styles (glassmorphism, fonts, buttons)
├── js/
│   ├── firebase.js     # Firebase init + Firestore helpers
│   ├── auth.js         # Google sign-in/out helpers
│   ├── landing.js      # Landing page logic
│   ├── dashboard.js    # Dashboard logic (CRUD accords)
│   └── gate.js         # Gate page logic (read slug, sign in, redirect)
└── public/
    └── (no assets needed, fonts from Google Fonts CDN)
```

---

## Google Form Prefill — How it works
Google Forms supports prefilled URLs like:
```
https://docs.google.com/forms/d/FORM_ID/viewform?entry.123456789=John+Doe&entry.987654321=john@gmail.com
```
To get entry IDs:
1. Open your Google Form
2. Click ⋮ (three dots) → "Get pre-filled link"
3. Fill in dummy values in each field you want to prefill
4. Click "Get Link" — copy the URL
5. The URL contains `entry.XXXXXXXXX=dummy` — extract those IDs

---

## Current Status
- ✅ Project designed and spec finalized
- ✅ Firebase data model designed
- ✅ Design language defined (glassmorphism B&W)
- ✅ All pages spec'd out
- 🔲 index.html — to build
- 🔲 dashboard.html — to build
- 🔲 gate.html — to build
- 🔲 css/style.css — to build
- 🔲 js/firebase.js — to build
- 🔲 js/dashboard.js — to build
- 🔲 js/gate.js — to build
- 🔲 _redirects — to create

---

## Prompt to continue in Claude (VSCode Terminal)
Paste this at the start of your next session:

> I'm building "Accord" — a vanilla HTML/CSS/JS web app (no build step, no frameworks) that creates identity-verified Google Form links. Firebase Auth (Google OAuth) + Firestore for backend. Hosted on Netlify at accord-ingly.netlify.app. The full project spec is in ACCORD_PROJECT_BRIEF.md. Please build all the files: index.html, dashboard.html, gate.html, css/style.css, and all js/ files. Design: glassmorphism, black background (#080808), white text, Cormorant Garamond for headings, Urbanist for body, DM Mono for mono. Firebase config placeholders should use YOUR_* values I'll replace.
