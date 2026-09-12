import {
  auth, onAuth, signInWithGoogle,
  isFormIdShape, extractFormId, seedProfile,
} from './firebase-core.js';
import {
  getDocRest, queryEqualRest, setDocRest, incrementRest,
  readDocResponse, readQueryResponse,
} from './firestore-rest.js';
import {
  normalizeFields, fieldDisplayLabel, resolveField,
  OTHER_SENTINEL, otherResponseKey,
} from './match.js';

const $ = id => document.getElementById(id);

// ─── State ────────────────────────────────────────────────────────────────
let resolved        = null;   // { source, formId, formUrl, name, fields, signInForm }
let resolveError    = null;   // 'not-found' | 'unreadable'
let resolveErrorMsg = null;   // human-readable error from parse-form (if any)
let fallbackUrl     = null;   // best-known form URL to offer when fields can't be read
let requiresSignIn  = false;  // true if parse-form told us the form is sign-in-walled
let readerState     = null;   // why the reader account couldn't help: 'none' | 'expired' | 'denied'
let authUser        = null;
let authSettled     = false;  // first onAuth callback has fired
let visitorProfile  = { fields: [] };
let profileLoaded   = false;  // visitorProfile reflects Firestore (not the empty default)
let initDone        = false;
// Schema we should persist to form_schemas once we have an ID token:
// either handed to us by the extension or freshly parsed by the server.
let pendingSchemaWrite = null; // { formId, doc }
// Per-session opt-outs: entryIds the user toggled off in the preview.
const skippedEntryIds = new Set();

// Requests gate.html's inline <script> already started (see there). Each
// getter falls back to issuing the request itself so gate.js also works
// when served without that script (e.g. a stale cached HTML).
const PF = window.__accordPrefetch || {};
const prefetched = (key, start) => PF[key] || (PF[key] = start());

// Cached server-parsed schemas go stale when a form is edited (new
// questions get new entry IDs). Re-parse after this long; extension-read
// schemas never expire because there's no other source for them.
const SCHEMA_TTL_MS = 7 * 24 * 3600 * 1000;

// ─── Show/hide states ─────────────────────────────────────────────────────
const states = ['loading','not-found','redirecting','gate'];
function show(state) {
  states.forEach(s => $(`state-${s}`).classList.toggle('hidden', s !== state));
}

// Surface an error state with a "Proceed to form" escape hatch whenever we
// know a candidate URL — lets the visitor fill the form themselves when
// Accord can't read it.
function renderNotFound(message) {
  $('not-found-text').textContent = message;
  const openBtn = $('not-found-open-btn');
  if (fallbackUrl) {
    openBtn.href = fallbackUrl;
    openBtn.classList.remove('hidden');
  } else {
    openBtn.classList.add('hidden');
  }
  const wall = requiresSignIn && fallbackUrl;
  $('signin-wall').classList.toggle('hidden', !wall);
  if (wall) {
    $('signin-wall-why').textContent = SIGNIN_WALL_WHY[readerState] || SIGNIN_WALL_WHY.none;
  }
  show('not-found');
}

// First paragraph of the sign-in wall, keyed by parse-form's `reader` field.
// Accord normally reads sign-in-walled forms through its own Google account
// ("reader"); when that fails the visitor's extension is the fallback.
const SIGNIN_WALL_WHY = {
  none:    "Forms with file uploads or restricted access only show their questions to a signed-in Google account, and this Accord deployment doesn't have its reader account set up yet.",
  expired: "Accord normally reads these through its own Google account, but that session has expired — the site owner needs to sign it in again.",
  denied:  "This form is restricted to a specific organisation, so even Accord's own Google account can't view it. Only a member's browser can.",
};

// ─── Preloader ────────────────────────────────────────────────────────────
function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 200);
}

// ─── Path parsing ─────────────────────────────────────────────────────────
// Three shapes get routed here via _redirects:
//   /go/<slug-or-formId>
//   /https:/...   (browser collapses // → /, we re-add it)
//   /http:/...
// Returns { kind: 'slug'|'formId'|'url', value }
function parsePath() {
  const path = window.location.pathname;

  const goMatch = path.match(/^\/go\/([^/]+)/);
  if (goMatch) {
    const seg = decodeURIComponent(goMatch[1]);
    return isFormIdShape(seg)
      ? { kind: 'formId', value: seg }
      : { kind: 'slug',   value: seg };
  }

  const urlMatch = path.match(/^\/(https?):\/+(.+)/);
  if (urlMatch) {
    const scheme = urlMatch[1];
    const rest   = urlMatch[2];
    const full   = `${scheme}://${rest}${window.location.search}`;
    return { kind: 'url', value: full };
  }

  return null;
}

// ─── Schema handed over by the browser extension ──────────────────────────
// The extension runs inside the visitor's signed-in Google session, so it
// can read forms Accord's server can't (sign-in-walled ones). It packs the
// field list into the URL hash as base64url JSON. We consume it, scrub the
// hash so reloads/bookmarks don't carry a stale copy, and cache it server-
// side once the visitor is signed in.
function readHashSchema() {
  const h = window.location.hash || '';
  if (!h.startsWith('#schema=')) return null;
  try {
    const b64 = h.slice('#schema='.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(Array.from(atob(b64), c =>
      '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    const s = JSON.parse(json);
    if (!s || !isFormIdShape(s.formId) || !Array.isArray(s.fields)) return null;
    const fields = normalizeFields(s.fields);
    if (!fields.length) return null;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return {
      formId:  s.formId,
      formUrl: s.formUrl && extractFormId(s.formUrl) === s.formId
        ? s.formUrl
        : `https://docs.google.com/forms/d/e/${s.formId}/viewform`,
      title:   (s.title || '').toString().trim(),
      fields,
    };
  } catch (e) {
    console.warn('[accord/gate] bad #schema payload', e);
    return null;
  }
}

// ─── Form schema cache (form_schemas/{formId}) ────────────────────────────
function schemaIsFresh(doc) {
  if (!doc) return false;
  if (doc.source === 'extension') return true;
  const t = doc.updatedAt instanceof Date ? doc.updatedAt.getTime() : 0;
  return Date.now() - t < SCHEMA_TTL_MS;
}

function useSchemaDoc(doc, source) {
  resolved = {
    source,
    formId:  doc.formId,
    formUrl: doc.formUrl || `https://docs.google.com/forms/d/e/${doc.formId}/viewform`,
    name:    resolved?.name || doc.title || 'this form',
    fields:  normalizeFields(doc.fields),
    // Google will ask the visitor to sign in when the form opens — warn them.
    signInForm: doc.requiresSignIn === true,
  };
  fallbackUrl = resolved.formUrl;
  resolveError = null; resolveErrorMsg = null; requiresSignIn = false;
}

function queueSchemaWrite(formId, formUrl, title, fields, source, extra = {}) {
  pendingSchemaWrite = {
    formId,
    doc: { formId, formUrl, title: title || '', fields, source, updatedAt: new Date(), ...extra },
  };
  flushSchemaWrite();
}

// Writes need an ID token (rules: any signed-in user may write). Called
// again from the auth listener, so a schema resolved before sign-in still
// gets cached once the visitor authenticates.
async function flushSchemaWrite() {
  if (!pendingSchemaWrite || !authUser) return;
  const w = pendingSchemaWrite;
  pendingSchemaWrite = null;
  try {
    const token = await authUser.getIdToken();
    await setDocRest('form_schemas', w.formId, w.doc, token);
    console.log('[accord/gate] cached schema for', w.formId, `(${w.doc.source})`);
  } catch (e) {
    console.warn('[accord/gate] schema cache write failed', e);
  }
}

// ─── Resolve the form (fields + canonical URL + name) ─────────────────────
async function resolveForm() {
  const route = parsePath();
  if (!route) { resolveError = 'not-found'; return; }

  // Extension-supplied schema wins outright — no network needed.
  const hashSchema = readHashSchema();
  if (hashSchema) {
    useSchemaDoc({ ...hashSchema, source: 'extension' }, route.kind);
    queueSchemaWrite(hashSchema.formId, hashSchema.formUrl, hashSchema.title, hashSchema.fields, 'extension');
    // In the background, find out whether the server can read this form
    // too. If it can, cache the server's copy (it expires + refreshes on
    // its own); if it's sign-in-walled, remember that so the gate can tell
    // future visitors where the schema came from.
    fetchParsed(hashSchema.formId).then(parsed => {
      if (parsed.ok) {
        queueSchemaWrite(parsed.formId || hashSchema.formId, parsed.formUrl, parsed.title, parsed.fields, 'server',
                         parsed.requiresSignIn ? { requiresSignIn: true } : {});
      } else if (parsed.requiresSignIn) {
        queueSchemaWrite(hashSchema.formId, hashSchema.formUrl, hashSchema.title, hashSchema.fields, 'extension', { requiresSignIn: true });
      }
    });
    return;
  }

  if (route.kind === 'slug') {
    let accords = [];
    try {
      accords = await readQueryResponse(prefetched('accordBySlug', () =>
        queryEqualRest('accords', 'slug', route.value)));
    } catch (e) { console.warn('[accord/gate] slug lookup failed', e); }
    const accord = accords[0];
    if (accord) {
      const formId = accord.formId || extractFormId(accord.formUrl);
      resolved = {
        source: 'slug',
        formId,
        formUrl: accord.formUrl,
        name: accord.name,
        fields: Array.isArray(accord.fields) && accord.fields.length ? normalizeFields(accord.fields) : null,
        contributed: !!accord.contributed,
      };
      fallbackUrl = resolved.formUrl || null;
      if (!resolved.fields) await resolveByFormId(formId, accord.formUrl || formId, { skipAccordLookup: true });
      return;
    }
    // Slug miss — if it looks like a forms.gle short code (alphanumeric, no
    // hyphens, shorter than a full form ID), resolve via the short link.
    if (/^[A-Za-z0-9]{8,19}$/.test(route.value)) {
      const shortUrl = `https://forms.gle/${route.value}`;
      fallbackUrl = shortUrl;
      resolved = { source: 'short', formId: null, formUrl: null, name: null, fields: null };
      const parsed = await fetchParsed(shortUrl);
      if (parsed.ok) { useParsed(parsed); return; }
      // Even when parse-form fails (sign-in-walled forms) it returns the
      // canonical URL, which gives us a formId to check the cache with.
      const discoveredId = extractFormId(fallbackUrl);
      if (discoveredId) await resolveByFormId(discoveredId, null, { parsedAlready: parsed });
      return;
    }
    resolveError = 'not-found';
    return;
  }

  if (route.kind === 'formId') {
    fallbackUrl = `https://docs.google.com/forms/d/e/${route.value}/viewform`;
    resolved = { source: 'formId', formId: route.value, formUrl: fallbackUrl, name: null, fields: null };
    await resolveByFormId(route.value, route.value);
    return;
  }

  // url route
  fallbackUrl = route.value;
  const formId = extractFormId(route.value);
  resolved = { source: 'url', formId, formUrl: route.value, name: null, fields: null };
  if (formId) await resolveByFormId(formId, route.value);
  else {
    const parsed = await fetchParsed(route.value);
    if (parsed.ok) useParsed(parsed);
  }
}

/**
 * Shared resolution once we know a formId. Order of preference:
 *   1. fresh form_schemas/{formId} cache
 *   2. a saved accord's fields (older contributed docs, creator-set fields)
 *   3. server parse (parse-form) — result is cached for next time
 *   4. stale cache, if the parse failed
 * The cache/accord lookups and the parse run concurrently (started by
 * gate.html's inline script), so this costs one round trip, not three.
 */
async function resolveByFormId(formId, parseInput, { skipAccordLookup = false, parsedAlready = null } = {}) {
  if (!formId) {
    const parsed = parsedAlready || (parseInput ? await fetchParsed(parseInput) : { ok: false });
    if (parsed.ok) useParsed(parsed);
    else { resolveError = 'unreadable'; resolveErrorMsg = parsed.error || null; }
    return;
  }
  const schemaP = readDocResponse(prefetched('schema', () => getDocRest('form_schemas', formId)))
    .catch(e => { console.warn('[accord/gate] schema lookup failed', e); return null; });
  const accordP = skipAccordLookup ? Promise.resolve([]) :
    readQueryResponse(prefetched('accordByFormId', () => queryEqualRest('accords', 'formId', formId)))
      .catch(e => { console.warn('[accord/gate] accord lookup failed', e); return []; });
  const parsedP = parsedAlready ? Promise.resolve(parsedAlready)
    : parseInput ? fetchParsed(parseInput) : Promise.resolve({ ok: false });

  const [schema, accords] = await Promise.all([schemaP, accordP]);

  // A saved accord contributes its name (and, if the schema cache is empty,
  // its fields) even when we resolve by formId.
  const accord = accords.find(a => Array.isArray(a.fields) && a.fields.length) || accords[0] || null;
  if (accord?.name && resolved && !resolved.name) resolved.name = accord.name;
  if (accord?.formUrl) fallbackUrl = accord.formUrl;

  if (schema && schemaIsFresh(schema) && Array.isArray(schema.fields) && schema.fields.length) {
    useSchemaDoc(schema, resolved?.source || 'formId');
    return;
  }
  if (accord && Array.isArray(accord.fields) && accord.fields.length) {
    resolved = {
      source: resolved?.source || 'formId',
      formId,
      formUrl: accord.formUrl || fallbackUrl,
      name: accord.name,
      fields: normalizeFields(accord.fields),
      signInForm: !!accord.contributed,
    };
    resolveError = null;
    return;
  }

  const parsed = await parsedP;
  if (parsed.ok) { useParsed(parsed); return; }

  // Stale cache beats no fields at all.
  if (schema && Array.isArray(schema.fields) && schema.fields.length) {
    useSchemaDoc(schema, resolved?.source || 'formId');
    return;
  }
  resolveError = 'unreadable';
  resolveErrorMsg = parsed.error || null;
}

// Fetch (or reuse the prefetched) parse-form response. Never throws.
async function fetchParsed(inputUrl) {
  let res, payload = {};
  try {
    // Reuse the inline prefetch only if it was for this exact input.
    if (!PF.parseForm || PF.parseFormInput !== inputUrl) {
      PF.parseFormInput = inputUrl;
      PF.parseForm = fetch(`/.netlify/functions/parse-form?url=${encodeURIComponent(inputUrl)}`);
    }
    res = await PF.parseForm;
    payload = await res.clone().json().catch(() => ({}));
  } catch {
    return { ok: false, error: 'Network error — please try again' };
  }
  // parse-form returns the canonical Forms URL even on error paths (401,
  // 422, etc.) so we can hand the visitor a working link to the form.
  if (payload?.formUrl) fallbackUrl = payload.formUrl;
  if (payload?.requiresSignIn) requiresSignIn = true;
  if (payload?.reader) readerState = payload.reader;
  if (!res.ok || !Array.isArray(payload.fields)) {
    return { ok: false, error: payload?.error || null, formUrl: payload?.formUrl || null,
             requiresSignIn: !!payload?.requiresSignIn };
  }
  return {
    ok: true,
    formId:  payload.formId,
    formUrl: payload.formUrl,
    title:   payload.formTitle || '',
    fields:  normalizeFields(payload.fields),
    // Read through Accord's reader account: the form itself still needs
    // the visitor to be signed in to Google.
    requiresSignIn: !!payload.requiresSignIn,
  };
}

function useParsed(parsed) {
  resolved = {
    source:  resolved?.source || 'formId',
    formId:  parsed.formId || resolved?.formId || extractFormId(parsed.formUrl),
    formUrl: parsed.formUrl || resolved?.formUrl,
    name:    resolved?.name || parsed.title || 'this form',
    fields:  parsed.fields,
    signInForm: !!parsed.requiresSignIn,
  };
  fallbackUrl = resolved.formUrl;
  resolveError = null; resolveErrorMsg = null; requiresSignIn = false;
  if (resolved.formId) {
    queueSchemaWrite(resolved.formId, resolved.formUrl, parsed.title, parsed.fields, 'server',
                     parsed.requiresSignIn ? { requiresSignIn: true } : {});
  }
}

// ─── Build prefill URL ────────────────────────────────────────────────────
// Walk the form's fields, resolve each through the visitor's profile rules
// and return the list of what will be sent. Shared by the preview and the
// redirect so they can never disagree.
function planFill(user) {
  const usedRuleIds = new Set();
  const plan = [];
  for (const f of ensureEmailAddressField(resolved?.fields)) {
    // The synthetic emailAddress field is a no-op on forms without
    // "Collect email addresses" enabled — Google silently drops the param.
    // It must NOT consume the Email rule's firstOnly budget, or the form's
    // real entry-based Email question gets skipped and lands empty.
    const synthetic = f.entryId === 'emailAddress';
    const r = resolveField(visitorProfile, f, user, synthetic ? null : usedRuleIds);
    if (!r) continue;
    if (r.rule?.id && !synthetic) usedRuleIds.add(r.rule.id);
    plan.push({ field: f, synthetic, ...r });
  }
  return plan;
}

function buildPrefillUrl(formUrl, user) {
  if (!formUrl) return formUrl;

  // Normalize the form URL so we land on the canonical /forms/d/e/<id>/
  // viewform path, regardless of any account-disambiguator the URL got
  // stamped with. Google rewrites form URLs to /forms/u/<N>/d/e/<id>/
  // when the request session has multiple Google accounts; if the
  // visitor's Nth account doesn't have access, Google shows an error page.
  const cleanUrl = stripAuthuserSegment(formUrl);

  const params = new URLSearchParams();

  // Hint Google with the email of the account the visitor actually picked
  // in the Accord gate — overrides the session-order guesswork Google does
  // when no account is specified.
  if (user?.email) params.set('authuser', user.email);

  for (const p of planFill(user)) {
    if (skippedEntryIds.has(p.field.entryId)) continue;
    if (p.unmatched) continue;
    if (p.other) {
      // Choice question with an "Other…" row and no matching option: pick
      // Other and type the raw value into its text box.
      params.append(p.field.entryId, OTHER_SENTINEL);
      params.set(otherResponseKey(p.field.entryId), p.other);
      continue;
    }
    // Checkboxes accept repeated keys; everything else is a single value.
    for (const v of p.values) params.append(p.field.entryId, v);
  }

  const qs = params.toString();
  if (!qs) return cleanUrl;
  return `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}${qs}`;
}

// Strip `/u/<N>/` or `/u/<email>/` from a /forms/ URL's path.
function stripAuthuserSegment(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/^\/forms\/u\/[^/]+\//, '/forms/');
    return u.toString();
  } catch {
    return url;
  }
}

// Guarantee a synthetic `emailAddress` field exists. Forms with the "Collect
// email addresses" toggle use that key instead of entry.<number>, and older
// cached field lists predate this support.
function ensureEmailAddressField(fields) {
  const synth = { entryId: 'emailAddress', label: 'Email' };
  if (!Array.isArray(fields)) return [synth];
  if (fields.some(f => f.entryId === 'emailAddress')) return fields;
  return [synth, ...fields];
}

// ─── Gate UI ──────────────────────────────────────────────────────────────
function renderConfirm(user) {
  const av = $('confirm-avatar');
  if (user.photoURL) {
    av.innerHTML = `<img src="${user.photoURL}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
  } else {
    av.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
  }
  $('confirm-name').textContent  = user.displayName || '';
  $('confirm-email').textContent = user.email || '';
  const firstName = (user.displayName || 'you').split(' ')[0];
  $('gate-proceed-btn').textContent = `Continue as ${firstName} →`;

  const badge = $('profile-new-badge');
  const empty = profileLoaded && !(visitorProfile.fields || []).length;
  badge.classList.toggle('hidden', !empty);
}

function setAuthPanel(which) {
  $('gate-auth-pending').classList.toggle('hidden', which !== 'pending');
  $('gate-signin').classList.toggle('hidden',       which !== 'signin');
  $('gate-confirm').classList.toggle('hidden',      which !== 'confirm');
}

function showConfirm(user) {
  setAuthPanel('confirm');
  renderConfirm(user);
  renderPreview();
}

function showSignIn() {
  setAuthPanel('signin');
  $('gate-preview')?.classList.add('hidden');
}

// Build the per-field preview the user sees next to the gate card. Rows are
// shown for fields Accord can fill (with an opt-out toggle) and for choice
// questions where a rule matched but none of the options fit — so the user
// knows to add a choice pattern in their profile.
function renderPreview() {
  const wrap = $('gate-preview');
  if (!wrap) return;
  if (!authUser || !profileLoaded || !resolved?.fields?.length) {
    wrap.classList.add('hidden');
    return;
  }

  const list = $('gate-preview-list');
  list.innerHTML = '';

  const plan = planFill(authUser);
  // Real form questions first, synthetic emailAddress last — and hide the
  // synthetic row when a real Email question already claimed the same rule,
  // otherwise the preview shows "Email" twice.
  const real  = plan.filter(p => !p.synthetic);
  const synth = plan.find(p => p.synthetic);
  const claimedRuleIds = new Set(real.map(p => p.rule?.id).filter(Boolean));
  const rows = synth && !claimedRuleIds.has(synth.rule?.id) ? [...real, synth] : real;

  let fillableCount = 0;
  for (const p of rows) {
    const label = fieldDisplayLabel(p.field);
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'preview-row-text';
    const labelEl = document.createElement('div');
    labelEl.className = 'preview-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'preview-value';
    text.appendChild(labelEl);
    text.appendChild(valueEl);
    li.appendChild(text);

    if (p.unmatched) {
      li.className = 'preview-row is-unmatched';
      valueEl.textContent = `No option matches “${p.value}”`;
      const hint = document.createElement('div');
      hint.className = 'preview-hint';
      hint.textContent = 'Add a choice pattern to this rule in your profile';
      text.appendChild(hint);
      list.appendChild(li);
      continue;
    }

    li.className = 'preview-row is-filled';
    valueEl.textContent = p.other ? `Other: ${p.other}` : p.values.join(', ');
    fillableCount++;

    const toggle = document.createElement('label');
    toggle.className = 'preview-toggle';
    toggle.title = 'Auto-fill this field';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !skippedEntryIds.has(p.field.entryId);
    cb.addEventListener('change', () => {
      if (cb.checked) skippedEntryIds.delete(p.field.entryId);
      else            skippedEntryIds.add(p.field.entryId);
      li.classList.toggle('is-skipped', !cb.checked);
    });
    const knob = document.createElement('span');
    knob.className = 'preview-toggle-knob';
    toggle.appendChild(cb);
    toggle.appendChild(knob);
    if (skippedEntryIds.has(p.field.entryId)) li.classList.add('is-skipped');
    li.appendChild(toggle);
    list.appendChild(li);
  }

  const realTotal = resolved.fields.filter(f => f.entryId !== 'emailAddress').length;
  const total = realTotal + (rows.includes(synth) ? 1 : 0);
  $('gate-preview-summary').textContent =
    `${fillableCount} of ${total} field${total === 1 ? '' : 's'} will auto-fill`;

  if (!rows.length) {
    wrap.classList.add('hidden');
    syncPreviewHeight();
    return;
  }
  wrap.classList.remove('hidden');
  syncPreviewHeight();
}

function renderAuthUI() {
  if (!authSettled) { setAuthPanel('pending'); return; }
  if (authUser) showConfirm(authUser);
  else          showSignIn();
}

// Persist a marker so that if the visitor hits Back from the Google Form and
// lands here again, we send them home instead of re-running the gate.
const RETURN_FLAG = 'accord:redirected';

async function doRedirect(user) {
  show('redirecting');
  const url = buildPrefillUrl(resolved.formUrl, user);
  try { sessionStorage.setItem(RETURN_FLAG, window.location.pathname); } catch {}

  // Fire-and-forget counters + any pending schema cache — never block the redirect.
  flushSchemaWrite();
  user.getIdToken().then(token => Promise.allSettled([
    incrementRest('user_stats', user.uid, 'fills', 'lastFillAt', token),
    resolved.formId ? incrementRest('form_visits', resolved.formId, 'count', 'lastVisitAt', token) : null,
  ])).catch(() => {});

  // Native app: record this fill in on-device history before we hand off.
  try {
    window.AccordBridge?.recordFill?.(resolved.name || '', resolved.formId || '', url);
  } catch {}

  // Just long enough for the "Redirecting to form…" spinner to register.
  setTimeout(() => { window.location.href = url; }, 350);
}

function doSkipRedirect() {
  if (!resolved?.formUrl) return;
  show('redirecting');
  try { sessionStorage.setItem(RETURN_FLAG, window.location.pathname); } catch {}
  setTimeout(() => { window.location.href = resolved.formUrl; }, 300);
}

// ─── Init ─────────────────────────────────────────────────────────────────
async function init() {
  // If returning from the Google Form (Back button), skip re-running the gate.
  try {
    if (sessionStorage.getItem(RETURN_FLAG) === window.location.pathname) {
      sessionStorage.removeItem(RETURN_FLAG);
      window.location.replace('/');
      return;
    }
  } catch {}

  await resolveForm();

  if (resolveError === 'not-found' || !resolved) {
    renderNotFound('Accord not found');
    hidePreloader();
    return;
  }
  if (resolveError === 'unreadable' || !resolved.fields) {
    const msg = resolveErrorMsg
      || "Couldn't read this form — make sure the link is public.";
    renderNotFound(msg);
    hidePreloader();
    return;
  }

  $('gate-accord-name').textContent = resolved.name || 'this form';
  $('gate-invited-label').textContent =
    resolved.source === 'slug' ? "YOU'VE BEEN INVITED TO" : "AUTO-FILLING";
  document.title = `${resolved.name || 'Accord'} — Accord`;
  $('gate-signin-note').classList.toggle('hidden', !resolved.signInForm);

  show('gate');
  hidePreloader();
  initDone = true;
  renderAuthUI();
  startPreviewHeightSync();
}

// ─── Preview height sync (desktop row layout) ─────────────────────────────
// On desktop the gate card and preview card sit side by side. The gate card
// dictates the row's height; this pins the preview card's outer height to
// match so the list inside it scrolls instead of pushing the page down.
const DESKTOP_MIN = 920;
function syncPreviewHeight() {
  const gateCard = document.querySelector('#state-gate .gate-card');
  const preview  = $('gate-preview');
  if (!gateCard || !preview) return;
  if (window.innerWidth < DESKTOP_MIN || preview.classList.contains('hidden')) {
    preview.style.height = '';
    return;
  }
  preview.style.height = `${gateCard.offsetHeight}px`;
}

function startPreviewHeightSync() {
  const gateCard = document.querySelector('#state-gate .gate-card');
  if (!gateCard) return;
  if (window.ResizeObserver) {
    new ResizeObserver(syncPreviewHeight).observe(gateCard);
  }
  window.addEventListener('resize', syncPreviewHeight);
  syncPreviewHeight();
}

// ─── Profile (REST) ───────────────────────────────────────────────────────
async function loadProfile(user) {
  const token = await user.getIdToken();
  const doc = await getDocRest('profiles', user.uid, token);
  const { profile, seeded } = seedProfile(doc || { fields: [] }, user);
  delete profile.id;
  if (seeded) {
    setDocRest('profiles', user.uid, { ...profile, updatedAt: new Date() }, token)
      .catch(e => console.error('[accord/gate] profile seed write failed', e));
  }
  return profile;
}

// Auth listener
onAuth(async user => {
  authUser = user;
  authSettled = true;
  if (user) {
    // Show the confirm card immediately with whatever profile we have, then
    // re-render once the real one lands — feels instant on repeat visits.
    if (initDone) renderAuthUI();
    try { visitorProfile = await loadProfile(user); }
    catch (e) { console.warn('[accord/gate] profile load failed', e); visitorProfile = { fields: [] }; }
    profileLoaded = true;
    flushSchemaWrite();
  } else {
    visitorProfile = { fields: [] };
    profileLoaded = false;
  }
  if (initDone) renderAuthUI();
});

init();

// ─── Handlers ─────────────────────────────────────────────────────────────
$('gate-login-btn')?.addEventListener('click', async () => {
  const btn = $('gate-login-btn');
  const originalHtml = btn.innerHTML;
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  try {
    const result = await signInWithGoogle();
    authUser = result.user;
    try { visitorProfile = await loadProfile(result.user); profileLoaded = true; } catch {}
    await doRedirect(result.user);
  } catch (e) {
    console.error(e);
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
});

$('gate-skip-btn')?.addEventListener('click', () => doSkipRedirect());
$('gate-confirm-skip-btn')?.addEventListener('click', () => doSkipRedirect());

$('gate-proceed-btn')?.addEventListener('click', () => {
  if (authUser && resolved) doRedirect(authUser);
});

$('gate-switch-btn')?.addEventListener('click', async () => {
  const btn = $('gate-switch-btn');
  btn.textContent = 'Switching…';
  btn.disabled = true;
  try {
    const result = await signInWithGoogle();
    authUser = result.user;
    try { visitorProfile = await loadProfile(result.user); profileLoaded = true; } catch {}
    await doRedirect(result.user);
  } catch (e) {
    console.error(e);
    btn.textContent = 'Switch account';
    btn.disabled = false;
  }
});

$('gate-edit-profile-btn')?.addEventListener('click', () => {
  const returnTo = window.location.pathname;
  window.location.href = `/profile?returnTo=${encodeURIComponent(returnTo)}`;
});

$('gate-preview-toggle')?.addEventListener('click', () => {
  $('gate-preview').classList.toggle('collapsed');
});

// Keep `auth` referenced for debugging from the console.
window.__accordAuth_ = auth;
