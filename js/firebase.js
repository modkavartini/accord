// ─── Firebase config ───────────────────────────────────────────────────────
// Replace all YOUR_* values with your Firebase project credentials
// Get from: console.firebase.google.com → Project Settings → Your Apps → Web App
const firebaseConfig = {
  apiKey: "AIzaSyCr7MSs5ZgmsTuiJpk-tTPMOzRawnLF0r0",
  authDomain: "accord-ed7f5.firebaseapp.com",
  projectId: "accord-ed7f5",
  storageBucket: "accord-ed7f5.firebasestorage.app",
  messagingSenderId: "518918384327",
  appId: "1:518918384327:web:0f4e84df8faeb75619ace2"
};

// ─── Firebase SDK (CDN modules) ────────────────────────────────────────────
import { initializeApp }                              from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider,
         signInWithPopup, signInWithCredential, signOut, deleteUser,
         onAuthStateChanged }                         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc,
         setDoc, getDoc, getDocs, deleteDoc,
         query, where, Timestamp, increment }          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app      = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);

const provider = new GoogleAuthProvider();
// Always show the account picker — fixes "switch account" behavior so the user
// can actually pick a different Google account instead of being silently
// re-signed-in with the previous one.
provider.setCustomParameters({ prompt: 'select_account' });

// ─── Auth helpers ──────────────────────────────────────────────────────────
/** True when running inside the Accord Android WebView. */
export const inAccordApp = () =>
  typeof window !== 'undefined' && !!window.AccordBridge;

// The Android app injects `window.AccordBridge` into the WebView. Google blocks
// OAuth popups inside third-party WebViews ('disallowed_useragent'), so the
// app runs the picker natively, hands the ID token back through the bridge,
// and we exchange it for a Firebase credential here.
export const signInWithGoogle = () => {
  if (typeof window !== 'undefined' && window.AccordBridge?.requestIdToken) {
    return signInViaBridge('signin');
  }
  return signInWithPopup(auth, provider);
};
export const signOutUser = () => {
  // Mirror the sign-out on the native side so the next sign-in shows the
  // account picker instead of silently re-using the last account.
  try { window.AccordBridge?.signOut?.(); } catch {}
  return signOut(auth);
};
// ─── In-app bootstrap ─────────────────────────────────────────────────────
// When running inside the Accord Android WebView, the embedded Firebase JS
// SDK has no auth state of its own — the user signs in *natively*, and the
// app prefetches a fresh Google ID token before loadUrl. Read that token at
// init and sign in here so pages like /dashboard see a user instead of
// bouncing to /. Idempotent (memoised).
let _bootstrapPromise = null;
function bootstrapFromNative() {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    if (!inAccordApp() || !window.AccordBridge?.bootstrapIdToken) return;
    // If JS Firebase is already signed in as the same user (IndexedDB
    // persistence), don't burn a credential exchange.
    const nativeEmail = (() => {
      try { return window.AccordBridge.bootstrapEmail?.() || ''; } catch { return ''; }
    })();
    if (auth.currentUser && nativeEmail && auth.currentUser.email === nativeEmail) return;

    let idToken = '';
    try { idToken = window.AccordBridge.bootstrapIdToken() || ''; } catch {}
    if (!idToken) return;
    try {
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch (e) {
      // Bootstrap failure isn't fatal — the page can still offer manual sign-in
      // via the bridge. Surface it for debugging.
      console.warn('Accord auth bootstrap failed', e);
    }
  })();
  return _bootstrapPromise;
}
// Kick off so it's running while page scripts evaluate.
if (typeof window !== 'undefined') bootstrapFromNative();

// onAuth guard: pages like /dashboard, /profile, /create-accord redirect to /
// on the first `null` callback. Inside the app, defer that first null until
// bootstrap has had a chance to populate auth — otherwise we redirect *before*
// signInWithCredential resolves, lose IndexedDB persistence, and end up in
// the popup→redirect fallback that gets booted out to Chrome.
export const onAuth = (cb) => {
  let firstFired = false;
  return onAuthStateChanged(auth, async (user) => {
    if (!firstFired && !user && inAccordApp()) {
      firstFired = true;
      // Don't surface the null to the page yet. Two outcomes:
      //  - bootstrap signs us in → onAuthStateChanged will fire *again* with
      //    the user, hitting the else branch below → cb runs once with a user.
      //  - bootstrap fails (no native session) → no second firing, so we
      //    surface null here.
      await bootstrapFromNative();
      if (!auth.currentUser) cb(null);
      return;
    }
    firstFired = true;
    cb(user);
  });
};

// Bridge bookkeeping. Native code calls `window.__accordAuth(requestId, payloadJson)`
// when the picker resolves. payload = { idToken, error }.
function signInViaBridge(mode) {
  return new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (!window.__accordPendingAuth) {
      window.__accordPendingAuth = {};
      window.__accordAuth = (id, json) => {
        const pending = window.__accordPendingAuth[id];
        if (!pending) return;
        delete window.__accordPendingAuth[id];
        let payload;
        try { payload = JSON.parse(json); } catch { payload = { error: 'Bad bridge payload' }; }
        if (payload.error || !payload.idToken) {
          pending.reject(new Error(payload.error || 'Sign-in cancelled'));
          return;
        }
        signInWithCredential(auth, GoogleAuthProvider.credential(payload.idToken))
          .then(pending.resolve, pending.reject);
      };
    }
    window.__accordPendingAuth[requestId] = { resolve, reject };
    try {
      window.AccordBridge.requestIdToken(requestId, mode);
    } catch (e) {
      delete window.__accordPendingAuth[requestId];
      reject(e);
    }
  });
}

// ─── Nano ID (tiny, no dependency) ────────────────────────────────────────
export function nanoid(len = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('');
}

// ─── Slug generator ────────────────────────────────────────────────────────
export function makeSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 22);
  return base + '-' + nanoid(4).toLowerCase();
}

// ─── Form ID helpers ──────────────────────────────────────────────────────
// Google Forms IDs look like 1FAIpQLS… (44 chars). Anything ≥20 chars made of
// [A-Za-z0-9_-] is treated as a form ID for /go/<segment> routing.
const FORM_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
export const isFormIdShape = (s) => FORM_ID_RE.test(s || '');

/** Pull the form ID out of a viewform URL. Handles /forms/d/<id> and /forms/d/e/<id>. */
export function extractFormId(input) {
  if (!input) return null;
  if (isFormIdShape(input)) return input;
  try {
    const u = new URL(input);
    const m = u.pathname.match(/\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ─── Firestore CRUD ────────────────────────────────────────────────────────

/** Create a new accord */
export async function createAccord(accord) {
  const ref = doc(db, 'accords', accord.id);
  await setDoc(ref, { ...accord, createdAt: Timestamp.now(), visits: 0 });
}

/** Get all accords owned by a user */
export async function getUserAccords(userId) {
  const q    = query(collection(db, 'accords'), where('ownerId', '==', userId));
  const snap = await getDocs(q);
  return snap.docs.map(d => hydrateAccord(d));
}

/** Find an accord by its slug (public read). Backfills formId from formUrl. */
export async function getAccordBySlug(slug) {
  const q    = query(collection(db, 'accords'), where('slug', '==', slug));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return hydrateAccord(snap.docs[0]);
}

/** Find any accord saved for this form ID (used for showing a saved name on /go/<formId>). */
export async function getAccordByFormId(formId) {
  const q    = query(collection(db, 'accords'), where('formId', '==', formId));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  return hydrateAccord(snap.docs[0]);
}

function hydrateAccord(docSnap) {
  const data = docSnap.data();
  if (!data.formId && data.formUrl) {
    data.formId = extractFormId(data.formUrl);
  }
  return { id: docSnap.id, ...data };
}

/** Update fields on an accord */
export async function updateAccord(id, data) {
  await setDoc(doc(db, 'accords', id), data, { merge: true });
}

/** Delete an accord */
export async function deleteAccord(id) {
  await deleteDoc(doc(db, 'accords', id));
}

/** Check if a slug is already taken */
export async function slugExists(slug, excludeId = null) {
  const q    = query(collection(db, 'accords'), where('slug', '==', slug));
  const snap = await getDocs(q);
  if (snap.empty) return false;
  if (excludeId && snap.docs.length === 1 && snap.docs[0].id === excludeId) return false;
  return true;
}

// ─── Profile (per-user field rules) ───────────────────────────────────────
/** Get the profile doc for a user. Returns { fields: [] } if none yet. */
export async function getProfile(userId) {
  const snap = await getDoc(doc(db, 'profiles', userId));
  return snap.exists() ? snap.data() : { fields: [] };
}

/** Overwrite the profile doc for a user. */
export async function saveProfile(userId, profile) {
  await setDoc(doc(db, 'profiles', userId), { ...profile, updatedAt: Timestamp.now() });
}

/**
 * Load the profile and seed Name + Email rules if missing. New accounts get
 * both pre-filled from the Google account, but stored as `value` (static)
 * source so the user can edit them later. Also backfills source/enabled on
 * legacy fields. Returns the (possibly updated) profile.
 */
export async function ensureProfileSeeded(user) {
  const profile = await getProfile(user.uid);
  if (!profile.fields) profile.fields = [];

  // Normalize legacy fields written before source/enabled/firstOnly existed
  profile.fields = profile.fields.map(f => ({ source: 'value', enabled: true, firstOnly: true, ...f }));

  const hasLabel = label =>
    profile.fields.some(f => (f.label || '').toLowerCase() === label.toLowerCase());

  let seeded = false;
  if (!hasLabel('Name')) {
    profile.fields.push({
      id: nanoid(8), label: 'Name', match: 'contains', patterns: ['Name'],
      source: 'value', value: user.displayName || '', enabled: true, firstOnly: true,
    });
    seeded = true;
  }
  if (!hasLabel('Email')) {
    profile.fields.push({
      id: nanoid(8), label: 'Email', match: 'contains', patterns: ['Email'],
      source: 'value', value: user.email || '', enabled: true, firstOnly: true,
    });
    seeded = true;
  }
  if (seeded) {
    try { await saveProfile(user.uid, profile); } catch (e) { console.error(e); }
  }
  return profile;
}

// ─── Counters ─────────────────────────────────────────────────────────────
// Per-user "forms auto-filled" counter, shown on the dashboard.
export async function incrementUserFills(userId) {
  if (!userId) return;
  await setDoc(
    doc(db, 'user_stats', userId),
    { fills: increment(1), lastFillAt: Timestamp.now() },
    { merge: true },
  );
}

export async function getUserFills(userId) {
  if (!userId) return 0;
  const snap = await getDoc(doc(db, 'user_stats', userId));
  return snap.exists() ? (snap.data().fills || 0) : 0;
}

// Per-form visit counter, useful for ad-hoc forms (no saved Accord).
export async function incrementFormVisits(formId) {
  if (!formId) return;
  await setDoc(
    doc(db, 'form_visits', formId),
    { count: increment(1), lastVisitAt: Timestamp.now() },
    { merge: true },
  );
}

// ─── Account deletion ─────────────────────────────────────────────────────
/**
 * Permanently delete a user: every accord they own, their profile doc, and
 * their Firebase Auth account. If Auth deletion fails because the session is
 * stale, re-prompt for sign-in and retry once.
 */
export async function purgeAccount(user) {
  const accords = await getUserAccords(user.uid);
  await Promise.all(accords.map(a => deleteAccord(a.id)));
  await deleteDoc(doc(db, 'profiles',    user.uid));
  await deleteDoc(doc(db, 'user_stats',  user.uid));

  try {
    await deleteUser(user);
  } catch (e) {
    if (e && e.code === 'auth/requires-recent-login') {
      // Re-authenticate via the bridge in-app, otherwise the popup path.
      if (typeof window !== 'undefined' && window.AccordBridge?.requestIdToken) {
        await signInViaBridge('reauth');
      } else {
        await signInWithPopup(auth, provider);
      }
      await deleteUser(auth.currentUser);
    } else {
      throw e;
    }
  }
}
