// The reader account's Google session, kept alive the way a browser would.
//
// ACCORD_GOOGLE_COOKIE (env) is only the *seed*: the cookie header copied
// from the reader's Chrome profile. Google rotates SIDCC / __Secure-*PSIDCC
// on nearly every response and stops honouring old values after a while, so
// a static header dies within days. Every reader fetch therefore runs its
// Set-Cookie headers through `absorb()` and the merged jar is persisted in a
// Netlify Blob; `reader-keepalive` pings Google on a schedule so the rotation
// keeps happening even when nobody opens a walled form.
//
// A new env value (the owner re-copied the cookie) always wins over the
// stored jar: the jar remembers which seed it grew from.

const { getStore, connectLambda } = require('@netlify/blobs');
const crypto = require('crypto');

const STORE = 'reader';
const KEY   = 'session';

const seed = () => (process.env.ACCORD_GOOGLE_COOKIE || '').trim();
const seedHash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function store() {
  return getStore({ name: STORE });
}

/**
 * Legacy (exports.handler) functions don't get the Blobs context injected
 * automatically — it rides along on the Lambda event. Call once per request.
 */
function connect(event) {
  if (!event) return;
  try { connectLambda(event); } catch (e) { console.warn('[reader-session] connectLambda:', e.message); }
}

/** { cookie, source: 'env' | 'blob' | 'none', updatedAt } — never logs the value. */
async function loadReaderSession(event) {
  connect(event);
  const env = seed();
  if (!env) return { cookie: '', source: 'none', updatedAt: null };
  try {
    const saved = await store().get(KEY, { type: 'json' });
    if (saved && saved.seedHash === seedHash(env) && saved.cookie) {
      return { cookie: saved.cookie, source: 'blob', updatedAt: saved.updatedAt || null };
    }
  } catch (e) {
    console.warn('[reader-session] blob read failed:', e.message);
  }
  return { cookie: env, source: 'env', updatedAt: null };
}

async function saveReaderSession(cookie) {
  const env = seed();
  if (!env || !cookie) return;
  try {
    await store().setJSON(KEY, { seedHash: seedHash(env), cookie, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.warn('[reader-session] blob write failed:', e.message);
  }
}

/** Parse a cookie header into an ordered name → value map. */
function parseJar(header) {
  const jar = new Map();
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}

const serializeJar = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/**
 * Apply a response's Set-Cookie headers to a cookie header string. Returns
 * the merged header (unchanged string if nothing relevant was set). Expired
 * / emptied cookies are dropped; attributes (Domain, Path, …) are ignored —
 * everything here is only ever sent to Google hosts.
 */
function mergeSetCookies(cookieHeader, setCookies) {
  if (!setCookies || !setCookies.length) return cookieHeader;
  const jar = parseJar(cookieHeader);
  let changed = false;
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const name  = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expires = attrs.map(a => a.trim()).find(a => /^expires=/i.test(a));
    const maxAge  = attrs.map(a => a.trim()).find(a => /^max-age=/i.test(a));
    const dead = !value
      || (maxAge && Number(maxAge.split('=')[1]) <= 0)
      || (expires && Date.parse(expires.slice(8)) < Date.now());
    if (dead) {
      if (jar.delete(name)) changed = true;
    } else if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  return changed ? serializeJar(jar) : cookieHeader;
}

/** Set-Cookie lines from a fetch Response, across Node versions. */
function setCookiesOf(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * Merge a Google response's cookies into the jar and persist when they
 * changed. Call with the jar that was actually sent on that request.
 */
async function absorb(res, sentCookie) {
  const merged = mergeSetCookies(sentCookie, setCookiesOf(res));
  if (merged !== sentCookie) await saveReaderSession(merged);
  return merged;
}

module.exports = { loadReaderSession, saveReaderSession, mergeSetCookies, absorb, setCookiesOf };
