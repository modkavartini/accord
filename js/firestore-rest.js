// Minimal Firestore REST client for the gate page. The Firestore JS SDK is
// ~370KB and opens a WebChannel session before the first query answers —
// on a phone that's 0.5-1.5s of the gate's load. Plain HTTPS calls need
// neither, and every request the gate makes can be started from an inline
// <script> in gate.html before any module has even downloaded.
//
// Only what the gate needs lives here: a couple of reads (public accords,
// form schemas, the visitor's profile) and a few fire-and-forget writes
// (profile seeding, schema caching, counters).

import { firebaseConfig } from './firebase-core.js';

export const REST_BASE =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
const KEY = `key=${encodeURIComponent(firebaseConfig.apiKey)}`;

export const docUrl   = (collection, id) => `${REST_BASE}/${collection}/${encodeURIComponent(id)}?${KEY}`;
export const queryUrl = () => `${REST_BASE}:runQuery?${KEY}`;
export const docName  = (collection, id) => `${REST_BASE.replace(/^https:\/\/firestore\.googleapis\.com\/v1\//, '')}/${collection}/${id}`;

/** Body for a single-field equality query — mirrored by gate.html's inline prefetch. */
export function equalityQueryBody(collection, field, value, limit = 5) {
  return JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } },
      limit,
    },
  });
}

// ─── Value codec ──────────────────────────────────────────────────────────
export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}
export function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = encodeValue(v);
  }
  return out;
}

export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('nullValue'      in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue'       in v) return decodeFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue'  in v) return v.geoPointValue;
  return null;
}
export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
/** REST document → { id, ...fields } */
export function decodeDoc(d) {
  if (!d?.name) return null;
  return { id: d.name.slice(d.name.lastIndexOf('/') + 1), ...decodeFields(d.fields) };
}

// ─── Transport ────────────────────────────────────────────────────────────
function headers(idToken, json = false) {
  const h = {};
  if (idToken) h['Authorization'] = `Bearer ${idToken}`;
  if (json)    h['Content-Type']  = 'application/json';
  return h;
}

/**
 * Turn a fetch Response (or a Promise of one) for a document GET into the
 * decoded doc, or null on 404. Accepts a promise so callers can hand over a
 * request that gate.html's inline prefetch started before this module loaded.
 */
export async function readDocResponse(resOrPromise) {
  const res = await resOrPromise;
  if (res.status === 404) return null;
  // 403 = security rules deny the read (e.g. a collection whose rules
  // haven't been deployed yet). Treat as "nothing there" so the gate keeps
  // working, but say so once — it's a config problem worth noticing.
  if (res.status === 403) {
    console.warn('[accord/firestore] read denied by rules:', res.url.replace(/\?.*$/, ''));
    return null;
  }
  if (!res.ok) throw new Error(`Firestore GET failed (${res.status})`);
  // clone(): the response may be a prefetch shared with a retry path.
  return decodeDoc(await res.clone().json());
}

/** Same for a :runQuery response → array of decoded docs. */
export async function readQueryResponse(resOrPromise) {
  const res = await resOrPromise;
  if (!res.ok) throw new Error(`Firestore query failed (${res.status})`);
  const rows = await res.clone().json();
  return (Array.isArray(rows) ? rows : []).map(r => r.document).filter(Boolean).map(decodeDoc);
}

export function getDocRest(collection, id, idToken) {
  return readDocResponse(fetch(docUrl(collection, id), { headers: headers(idToken) }));
}

export function queryEqualRest(collection, field, value, idToken) {
  return readQueryResponse(fetch(queryUrl(), {
    method: 'POST',
    headers: headers(idToken, true),
    body: equalityQueryBody(collection, field, value),
  }));
}

/** setDoc without merge: PATCH with no update mask replaces the document. */
export async function setDocRest(collection, id, data, idToken) {
  const res = await fetch(docUrl(collection, id), {
    method: 'PATCH',
    headers: headers(idToken, true),
    body: JSON.stringify({ fields: encodeFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore PATCH failed (${res.status})`);
}

/**
 * setDoc(…, {merge:true}) with increments: a single commit whose write has
 * an empty update mask (creates the doc if missing, touches nothing else)
 * plus field transforms.
 */
export async function incrementRest(collection, id, counterField, timestampField, idToken) {
  const res = await fetch(`${REST_BASE}:commit?${KEY}`, {
    method: 'POST',
    headers: headers(idToken, true),
    body: JSON.stringify({
      writes: [{
        update: { name: docName(collection, id), fields: {} },
        updateMask: { fieldPaths: [] },
        updateTransforms: [
          { fieldPath: counterField,   increment: { integerValue: '1' } },
          { fieldPath: timestampField, setToServerValue: 'REQUEST_TIME' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Firestore commit failed (${res.status})`);
}
