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
         signInWithPopup, signOut, deleteUser,
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
export const signInWithGoogle = ()      => signInWithPopup(auth, provider);
export const signOutUser      = ()      => signOut(auth);
export const onAuth           = (cb)    => onAuthStateChanged(auth, cb);

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
      await signInWithPopup(auth, provider);
      await deleteUser(auth.currentUser);
    } else {
      throw e;
    }
  }
}
