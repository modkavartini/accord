// Full Firebase entry point (Auth + Firestore SDK) for the dashboard, profile,
// create-accord and fill pages. The gate page deliberately does NOT import
// this — it uses ./firebase-core.js + ./firestore-rest.js to skip the
// Firestore SDK download on the hot path.

export * from './firebase-core.js';
import {
  app, auth, provider,
  signInWithPopup, deleteUser, signInViaBridge,
  extractFormId, seedProfile,
} from './firebase-core.js';

import { getFirestore, collection, doc,
         setDoc, getDoc, getDocs, deleteDoc,
         query, where, Timestamp, increment }          from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const db = getFirestore(app);

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

/** Find any accord saved for this form ID (used for showing a saved name on /go/<formId>).
 *  When multiple exist, prefer the one that actually has parsed fields so the
 *  caller gets the richest payload it can. */
export async function getAccordByFormId(formId) {
  const q    = query(collection(db, 'accords'), where('formId', '==', formId));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docs = snap.docs.map(hydrateAccord);
  return docs.find(a => Array.isArray(a.fields) && a.fields.length) || docs[0];
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
 * Load the profile and seed Name + Email rules if missing (see seedProfile
 * in firebase-core.js). Returns the (possibly updated) profile.
 */
export async function ensureProfileSeeded(user) {
  const { profile, seeded } = seedProfile(await getProfile(user.uid), user);
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
