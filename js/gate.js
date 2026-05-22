import {
  onAuth, signInWithGoogle,
  getAccordBySlug, getAccordByFormId,
  ensureProfileSeeded,
  isFormIdShape, extractFormId,
  incrementUserFills, incrementFormVisits,
  createAccord, nanoid,
} from './firebase.js';

const $ = id => document.getElementById(id);

// ─── State ────────────────────────────────────────────────────────────────
let resolved       = null;   // { source, formId, formUrl, name, fields }
let resolveError   = null;
let resolveErrorMsg = null;  // human-readable error from parse-form (if any)
let fallbackUrl    = null;   // best-known form URL to offer when fields can't be read
let requiresSignIn = false;  // true if parse-form told us the form is sign-in-walled
let contributeRouteFormId = null; // formId derived from the route, used to validate pasted HTML
let resolvePromise = null;   // settles with { fields, formUrl } once parse-form returns
let authUser       = null;
let visitorProfile = { fields: [] };
let initDone       = false;
// Per-session opt-outs: entryIds the user toggled off in the preview. These
// fields will be skipped when building the prefill URL even though we have a
// value for them.
const skippedEntryIds = new Set();

// ─── Show/hide states ─────────────────────────────────────────────────────
const states = ['loading','not-found','redirecting','gate'];
function show(state) {
  states.forEach(s => $(`state-${s}`).classList.toggle('hidden', s !== state));
}

// Surface an error state with a "Proceed to form" escape hatch whenever we
// know a candidate URL — lets the visitor verify the link themselves when
// Accord can't read it (e.g. a sign-in-walled form).
function renderNotFound(message) {
  $('not-found-text').textContent = message;
  const openBtn = $('not-found-open-btn');
  if (fallbackUrl) {
    openBtn.href = fallbackUrl;
    openBtn.classList.remove('hidden');
  } else {
    openBtn.classList.add('hidden');
  }
  renderContributeCard();
  show('not-found');
}

// ─── Contribute (paste form source) ───────────────────────────────────────
// Sign-in-walled forms (file-upload questions, restricted audiences, etc.)
// can't be parsed server-side. The visitor's own browser CAN see them
// because they're already signed in to Google. This flow lets them paste
// the raw form HTML so Accord can cache the field list under the form's
// real formId — every future visitor then gets auto-fill without anyone
// needing to repeat the dance.
function renderContributeCard() {
  const card = $('contribute-card');
  if (!card) return;
  // Only offer this for forms that are sign-in-walled AND for routes where
  // we know the candidate form URL — without a URL there's no way to open
  // the source viewer, and without a sign-in-wall the user shouldn't have
  // to touch this flow at all.
  if (!requiresSignIn || !fallbackUrl) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  // Sign-in note visible only when not yet authed.
  $('contribute-signin-note').classList.toggle('hidden', !!authUser);
}

// Open the form in a new tab so the user can perform the pre-fill dance.
// Plain `window.open` so the user keeps this gate tab around — closing it
// would lose their place in the contribute flow.
function handleOpenForm() {
  if (!fallbackUrl) return;
  window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
}

function setContributeStatus(kind, msg) {
  const el = $('contribute-status');
  el.classList.remove('hidden', 'is-error', 'is-ok', 'is-loading');
  if (kind === 'error')   el.classList.add('is-error');
  if (kind === 'ok')      el.classList.add('is-ok');
  if (kind === 'loading') el.classList.add('is-loading');
  el.innerHTML = kind === 'loading'
    ? `<span class="spinner spinner-sm"></span><span>${msg}</span>`
    : msg;
}

// A Google Forms pre-fill URL looks like:
//   https://docs.google.com/forms/d/e/<formId>/viewform?usp=pp_url&entry.123=Name&entry.456=Email
// The user types each question's *label* into the question itself, then
// copies the pre-fill link Google generates — so each `entry.XXX=Label`
// pair tells us "the question labelled Label has entry ID entry.XXX". That's
// exactly the field schema Accord needs to auto-fill the form later.
function parsePrefillUrl(raw) {
  let url;
  try { url = new URL(raw); }
  catch { return { error: "That doesn't look like a valid link — make sure you copied the whole pre-filled URL." }; }

  if (url.hostname !== 'docs.google.com' || !/\/forms\//.test(url.pathname)) {
    return { error: 'That link isn\'t a Google Forms URL — copy the pre-filled link from the form\'s ⋮ menu.' };
  }

  const idMatch = url.pathname.match(/\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/);
  const formId = idMatch ? idMatch[1] : null;
  if (!formId) return { error: "Couldn't read a form ID from that link." };

  const fields = [];
  const seen = new Set();
  for (const [key, value] of url.searchParams.entries()) {
    if (key !== 'emailAddress' && !/^entry\.\d+$/.test(key)) continue;
    if (seen.has(key)) continue; // skip duplicate entries (multi-select)
    seen.add(key);
    const label = (value || '').trim();
    if (!label) continue;
    fields.push({ entryId: key, dummyValue: label });
  }
  if (!fields.length) {
    return { error: "That link has no pre-filled answers — fill in each question (using the question's own name as the answer) before generating the pre-fill link." };
  }
  // Same email-collection safety net as the server parser: forms with the
  // "Collect email addresses" toggle use `emailAddress` instead of an entry
  // ID, and Google silently drops the param on forms without it.
  if (!fields.some(f => f.entryId === 'emailAddress')) {
    fields.unshift({ entryId: 'emailAddress', dummyValue: 'Email' });
  }

  return { formId, fields };
}

async function handleContributeSubmit() {
  const btn   = $('contribute-submit');
  const ta    = $('contribute-textarea');
  const titleInput = $('contribute-title');
  const raw   = (ta.value || '').trim();
  const title = (titleInput?.value || '').trim();
  if (!title) { setContributeStatus('error', 'Enter the form title first.'); return; }
  if (!raw)   { setContributeStatus('error', 'Paste the pre-filled link too.'); return; }

  setContributeStatus('loading', 'Reading the link…');
  btn.disabled = true;

  const parsed = parsePrefillUrl(raw);
  console.log('[accord/contribute] parsed pre-fill URL', { raw, parsed });
  if (parsed.error) {
    setContributeStatus('error', parsed.error);
    btn.disabled = false;
    return;
  }

  // The pre-fill URL's formId is the source of truth — we save the accord
  // keyed by THAT, not by the route's formId. A mismatch most likely means
  // the user pasted the wrong form's link, so we warn but don't block —
  // the worst case is a "Contributed form" entry on their dashboard for the
  // wrong form, which they can delete. (Anti-poisoning isn't actually at
  // stake here: the saved accord is keyed by parsed.formId, so it won't
  // surface for visitors of any *other* form's gate URL.)
  const expectedFormId = contributeRouteFormId || extractFormId(fallbackUrl) || null;
  const finalFormId    = parsed.formId;
  console.log('[accord/contribute] formId check', { expectedFormId, parsedFormId: finalFormId });
  if (expectedFormId && finalFormId !== expectedFormId) {
    console.warn('[accord/contribute] formId mismatch — saving under the pre-fill URL\'s formId anyway');
    setContributeStatus('loading',
      `Heads up: that link's form ID (${shortId(finalFormId)}) doesn't match this page's (${shortId(expectedFormId)}). Saving anyway under the pasted link's form…`);
  }

  // Require sign-in so the contribution shows up on a real dashboard.
  if (!authUser) {
    setContributeStatus('loading', 'Signing you in…');
    try {
      const result = await signInWithGoogle();
      authUser = result.user;
      try { visitorProfile = await ensureProfileSeeded(result.user); } catch {}
    } catch (e) {
      console.error('[accord/contribute] sign-in failed', e);
      setContributeStatus('error', 'Sign-in cancelled. Try again to contribute.');
      btn.disabled = false;
      return;
    }
  }

  setContributeStatus('loading', `Saving ${parsed.fields.length} field${parsed.fields.length === 1 ? '' : 's'} to Accord…`);
  const formUrl = fallbackUrl && extractFormId(fallbackUrl) === finalFormId
    ? fallbackUrl
    : `https://docs.google.com/forms/d/e/${finalFormId}/viewform`;
  const accord = {
    id:          nanoid(),
    name:        title,
    slug:        null,
    formId:      finalFormId,
    formUrl,
    fields:      parsed.fields,
    ownerId:     authUser.uid,
    ownerEmail:  authUser.email || '',
    contributed: true,
  };
  console.log('[accord/contribute] saving accord', accord);
  try {
    await createAccord(accord);
  } catch (e) {
    console.error('[accord/contribute] save failed', e);
    const msg = e?.code ? `Save failed (${e.code}). Check console for details.` : 'Something went wrong saving — check console for details.';
    setContributeStatus('error', msg);
    btn.disabled = false;
    return;
  }

  setContributeStatus('ok', `Saved ${parsed.fields.length} field${parsed.fields.length === 1 ? '' : 's'}! Reloading…`);
  // Bounce them back through the same gate URL — now the cached fields exist,
  // so the gate will render the auto-fill confirmation instead of this error.
  setTimeout(() => window.location.reload(), 900);
}

// Truncate a long form ID for display in inline status text.
function shortId(id) {
  if (!id) return '?';
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

// ─── Preloader ────────────────────────────────────────────────────────────
function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
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

// ─── Rule matcher ─────────────────────────────────────────────────────────
function matchRule(rule, value) {
  const v = (value || '').trim().toLowerCase();
  return (rule.patterns || []).some(p => {
    const pp = (p || '').trim().toLowerCase();
    if (!pp) return false;
    switch (rule.match) {
      case 'equals':     return v === pp;
      case 'contains':   return v.includes(pp);
      case 'startsWith': return v.startsWith(pp);
      case 'endsWith':   return v.endsWith(pp);
      default:           return false;
    }
  });
}

function findMatchingRule(profile, label, usedRuleIds) {
  for (const rule of (profile.fields || [])) {
    if (!matchRule(rule, label)) continue;
    // `firstOnly` (default ON) means a rule fires for at most one form question
    // per visit — handy when a form repeats a question like "Confirm Email".
    if (usedRuleIds && rule.firstOnly !== false && usedRuleIds.has(rule.id)) continue;
    return rule;
  }
  return null;
}

function resolveRule(rule, user) {
  if (!rule) return null;
  if (rule.enabled === false) return null;
  if (rule.source === 'auth-name')  return user.displayName || null;
  if (rule.source === 'auth-email') return user.email       || null;
  return rule.value || null;
}

// ─── Build prefill URL ────────────────────────────────────────────────────
function buildPrefillUrl(formUrl, fields, user) {
  if (!formUrl) return formUrl;
  const params = new URLSearchParams();

  const usedRuleIds = new Set();
  for (const f of ensureEmailAddressField(fields)) {
    if (skippedEntryIds.has(f.entryId)) continue;
    // The synthetic emailAddress field is a no-op on forms without
    // "Collect email addresses" enabled — Google silently drops the param.
    // It must NOT consume the Email rule's firstOnly budget, or the form's
    // real entry-based Email question gets skipped and lands empty.
    const synthetic = f.entryId === 'emailAddress';
    const rule  = findMatchingRule(visitorProfile, f.dummyValue ?? f.label, synthetic ? null : usedRuleIds);
    const value = resolveRule(rule, user);
    if (!value) continue;
    params.set(f.entryId, value);
    if (rule?.id && !synthetic) usedRuleIds.add(rule.id);
  }

  const qs = params.toString();
  if (!qs) return formUrl;
  return `${formUrl}${formUrl.includes('?') ? '&' : '?'}${qs}`;
}

// Guarantee a synthetic `emailAddress` field exists. Forms with the "Collect
// email addresses" toggle use that key instead of entry.<number>, and older
// cached field lists predate this support.
function ensureEmailAddressField(fields) {
  if (!Array.isArray(fields)) return [{ entryId: 'emailAddress', dummyValue: 'Email' }];
  if (fields.some(f => f.entryId === 'emailAddress')) return fields;
  return [{ entryId: 'emailAddress', dummyValue: 'Email' }, ...fields];
}

// ─── Resolve the form (fields + canonical URL + name) ─────────────────────
async function resolveForm() {
  const route = parsePath();
  if (!route) { resolveError = 'not-found'; return; }

  if (route.kind === 'slug') {
    const accord = await getAccordBySlug(route.value);
    if (accord) {
      resolved = {
        source: 'slug',
        formId: accord.formId || extractFormId(accord.formUrl),
        formUrl: accord.formUrl,
        name: accord.name,
        fields: Array.isArray(accord.fields) ? accord.fields : null,
        contributed: !!accord.contributed,
      };
      fallbackUrl = resolved.formUrl || null;
      if (!resolved.fields) await fetchFieldsInto(resolved);
      return;
    }
    // Slug miss — if it looks like a forms.gle short code (alphanumeric, no
    // hyphens, shorter than a full form ID), resolve via forms.gle redirect.
    if (/^[A-Za-z0-9]{8,19}$/.test(route.value)) {
      const shortUrl = `https://forms.gle/${route.value}`;
      fallbackUrl = shortUrl;
      resolved = { source: 'short', formId: null, formUrl: null, name: null, fields: null };
      await fetchFieldsInto(resolved, shortUrl);
      // Even when parse-form fails (sign-in-walled forms), it returns the
      // canonical /forms/d/e/<id>/viewform URL in the error payload — which
      // we stash on fallbackUrl. That gives us a formId we can use to check
      // the contributed-accords cache. Without this, a contribution saved
      // under the real formId is invisible on the next visit to /go/<short>.
      if (resolveError === 'unreadable') {
        const discoveredId = extractFormId(fallbackUrl);
        if (discoveredId) {
          contributeRouteFormId = discoveredId;
          try {
            const existing = await getAccordByFormId(discoveredId);
            if (existing && Array.isArray(existing.fields) && existing.fields.length) {
              resolved = {
                source: 'short',
                formId: discoveredId,
                formUrl: existing.formUrl || fallbackUrl,
                name: existing.name,
                fields: existing.fields,
                contributed: !!existing.contributed,
              };
              resolveError = null;
              resolveErrorMsg = null;
              requiresSignIn = false;
            }
          } catch (e) { console.warn('[accord/gate] short-code cache lookup failed', e); }
        }
      }
      return;
    }
    resolveError = 'not-found';
    return;
  }

  // For formId / url paths: optionally pick up a saved Accord's name, then fetch fields.
  let savedName = null;
  let inputForFn = route.value;
  if (route.kind === 'formId') {
    contributeRouteFormId = route.value;
    fallbackUrl = `https://docs.google.com/forms/d/e/${route.value}/viewform`;
    try {
      const existing = await getAccordByFormId(route.value);
      if (existing) {
        savedName = existing.name;
        if (existing.formUrl) fallbackUrl = existing.formUrl;
        if (Array.isArray(existing.fields) && existing.fields.length) {
          resolved = {
            source: 'formId',
            formId: route.value,
            formUrl: existing.formUrl,
            name: existing.name,
            fields: existing.fields,
            contributed: !!existing.contributed,
          };
          return;
        }
      }
    } catch {}
  } else if (route.kind === 'url') {
    fallbackUrl = route.value;
    contributeRouteFormId = extractFormId(route.value);
    // Same cache check as the formId branch — without it, a successful
    // contribute via /https:/<form-url> still re-fetches on reload and
    // hits the same sign-in wall, never showing the cached fields.
    if (contributeRouteFormId) {
      try {
        const existing = await getAccordByFormId(contributeRouteFormId);
        if (existing) {
          savedName = existing.name;
          if (existing.formUrl) fallbackUrl = existing.formUrl;
          if (Array.isArray(existing.fields) && existing.fields.length) {
            resolved = {
              source: 'url',
              formId: contributeRouteFormId,
              formUrl: existing.formUrl || route.value,
              name: existing.name,
              fields: existing.fields,
              contributed: !!existing.contributed,
            };
            return;
          }
        }
      } catch {}
    }
  }

  resolved = { source: route.kind, formId: null, formUrl: null, name: savedName, fields: null };
  await fetchFieldsInto(resolved, inputForFn);
}

async function fetchFieldsInto(target, inputUrl) {
  const url = inputUrl || target.formUrl || target.formId;
  if (!url) { resolveError = 'unreadable'; return; }

  let res, payload = {};
  try {
    res = await fetch(`/.netlify/functions/parse-form?url=${encodeURIComponent(url)}`);
    payload = await res.json().catch(() => ({}));
  } catch {
    resolveError = 'unreadable';
    resolveErrorMsg = 'Network error — please try again';
    return;
  }
  // parse-form returns the canonical Forms URL even on error paths (401,
  // 422, etc.) so we can hand the visitor a working link to the form even
  // when we can't read its questions.
  if (payload?.formUrl) fallbackUrl = payload.formUrl;
  if (payload?.requiresSignIn) requiresSignIn = true;
  if (!res.ok || !Array.isArray(payload.fields)) {
    resolveError = 'unreadable';
    resolveErrorMsg = payload?.error || null;
    return;
  }

  target.formId  = target.formId  || payload.formId;
  target.formUrl = payload.formUrl || target.formUrl;
  target.name    = target.name    || payload.formTitle || 'this form';
  target.fields  = payload.fields.map(f => ({ entryId: f.entryId, dummyValue: f.label }));
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
  const empty = !(visitorProfile.fields || []).length;
  badge.classList.toggle('hidden', !empty);
}

function showConfirm(user) {
  $('gate-signin').classList.add('hidden');
  $('gate-confirm').classList.remove('hidden');
  renderConfirm(user);
  renderPreview();
}

function showSignIn() {
  $('gate-signin').classList.remove('hidden');
  $('gate-confirm').classList.add('hidden');
  $('gate-preview')?.classList.add('hidden');
}

// Build the per-field preview the user sees below the gate card. We only show
// rows for fields Accord can actually fill; un-mappable questions are still
// counted in the total but hidden to keep the list focused on what will
// happen. Each visible row carries a toggle so the visitor can opt out of
// individual fields before proceeding.
function renderPreview() {
  const wrap = $('gate-preview');
  if (!wrap) return;
  if (!authUser || !resolved?.fields?.length) {
    wrap.classList.add('hidden');
    return;
  }

  // Real form questions first, synthetic emailAddress last. The synthetic is
  // a URL-only bonus (Google's "Collect email addresses" key) and shouldn't
  // be displayed when a real entry-based Email question already covers it,
  // otherwise the preview shows "Email" twice.
  const allFields  = ensureEmailAddressField(resolved.fields);
  const realFields = allFields.filter(f => f.entryId !== 'emailAddress');
  const synthField = allFields.find(f => f.entryId === 'emailAddress') || null;
  const orderedFields = synthField ? [...realFields, synthField] : realFields;
  const list   = $('gate-preview-list');
  list.innerHTML = '';

  let fillableCount = 0;
  let syntheticShown = false;
  const usedRuleIds = new Set();
  for (const f of orderedFields) {
    const label = (f.dummyValue || '').trim() || 'Untitled question';
    const synthetic = f.entryId === 'emailAddress';
    const rule  = findMatchingRule(visitorProfile, label, synthetic ? null : usedRuleIds);
    const value = resolveRule(rule, authUser);
    if (!value) continue;
    // Don't double-display: if a real field already claimed this rule, the
    // synthetic emailAddress would just be a duplicate "Email" row.
    if (synthetic && rule && usedRuleIds.has(rule.id)) continue;
    if (rule?.id && !synthetic) usedRuleIds.add(rule.id);
    if (synthetic) syntheticShown = true;
    fillableCount++;

    const li = document.createElement('li');
    li.className = 'preview-row is-filled';

    const text = document.createElement('div');
    text.className = 'preview-row-text';

    const labelEl = document.createElement('div');
    labelEl.className = 'preview-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('div');
    valueEl.className = 'preview-value';
    valueEl.textContent = value;

    text.appendChild(labelEl);
    text.appendChild(valueEl);

    const toggle = document.createElement('label');
    toggle.className = 'preview-toggle';
    toggle.title = 'Auto-fill this field';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !skippedEntryIds.has(f.entryId);
    cb.addEventListener('change', () => {
      if (cb.checked) skippedEntryIds.delete(f.entryId);
      else            skippedEntryIds.add(f.entryId);
      li.classList.toggle('is-skipped', !cb.checked);
    });

    const knob = document.createElement('span');
    knob.className = 'preview-toggle-knob';
    toggle.appendChild(cb);
    toggle.appendChild(knob);

    if (skippedEntryIds.has(f.entryId)) li.classList.add('is-skipped');

    li.appendChild(text);
    li.appendChild(toggle);
    list.appendChild(li);
  }

  const total = realFields.length + (syntheticShown ? 1 : 0);
  $('gate-preview-summary').textContent =
    `${fillableCount} of ${total} field${total === 1 ? '' : 's'} will auto-fill`;

  if (!fillableCount) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
}

function renderAuthUI() {
  if (authUser) showConfirm(authUser);
  else          showSignIn();
}

// Persist a marker so that if the visitor hits Back from the Google Form and
// lands here again, we send them home instead of re-running the gate.
const RETURN_FLAG = 'accord:redirected';

async function doRedirect(user) {
  show('redirecting');
  const url = buildPrefillUrl(resolved.formUrl, resolved.fields, user);
  try { sessionStorage.setItem(RETURN_FLAG, window.location.pathname); } catch {}

  // Fire-and-forget counter increments — never block the redirect.
  Promise.allSettled([
    incrementUserFills(user.uid),
    incrementFormVisits(resolved.formId),
  ]);

  // Native app: record this fill in on-device history before we hand off.
  try {
    window.AccordBridge?.recordFill?.(
      resolved.name || '',
      resolved.formId || '',
      url,
    );
  } catch {}

  setTimeout(() => { window.location.href = url; }, 1100);
}

function doSkipRedirect() {
  if (!resolved?.formUrl) return;
  show('redirecting');
  try { sessionStorage.setItem(RETURN_FLAG, window.location.pathname); } catch {}
  setTimeout(() => { window.location.href = resolved.formUrl; }, 700);
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

  resolvePromise = resolveForm();
  await resolvePromise;

  if (resolveError === 'not-found' || !resolved) {
    renderNotFound("Accord not found");
    hidePreloader();
    return;
  }
  if (resolveError === 'unreadable') {
    $('gate-accord-name').textContent = resolved.name || 'this form';
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
  // Tell the visitor when the field schema came from another Accord user
  // rather than Accord's own server-side fetch — the form requires sign-in,
  // so a contributor walked through the pre-fill-link flow to teach us.
  $('gate-contributed-note').classList.toggle('hidden', !resolved.contributed);

  show('gate');
  hidePreloader();
  initDone = true;
  renderAuthUI();
}

// Auth listener
onAuth(async user => {
  authUser = user;
  if (user) {
    try { visitorProfile = await ensureProfileSeeded(user); }
    catch { visitorProfile = { fields: [] }; }
  } else {
    visitorProfile = { fields: [] };
  }
  if (initDone) {
    renderAuthUI();
    // The contribute card's "sign in to contribute" note depends on authUser,
    // so re-render it when auth state changes after the page has settled.
    if (resolveError === 'unreadable') renderContributeCard();
  }
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
    try { visitorProfile = await ensureProfileSeeded(result.user); } catch {}
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
    try { visitorProfile = await ensureProfileSeeded(result.user); } catch {}
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

// ─── Contribute handlers ─────────────────────────────────────────────────
$('contribute-toggle')?.addEventListener('click', () => {
  $('contribute-card').classList.toggle('collapsed');
});

function refreshContributeSubmitState() {
  const hasTitle = !!$('contribute-title')?.value.trim();
  const hasLink  = !!$('contribute-textarea')?.value.trim();
  $('contribute-submit').disabled = !(hasTitle && hasLink);
}
$('contribute-textarea')?.addEventListener('input', refreshContributeSubmitState);
$('contribute-title')?.addEventListener('input',    refreshContributeSubmitState);

$('contribute-source-btn')?.addEventListener('click', handleOpenForm);
$('contribute-submit')?.addEventListener('click', handleContributeSubmit);
