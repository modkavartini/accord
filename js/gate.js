import {
  onAuth, signInWithGoogle,
  getAccordBySlug, getAccordByFormId,
  ensureProfileSeeded,
  isFormIdShape, extractFormId,
  incrementUserFills, incrementFormVisits,
} from './firebase.js';

const $ = id => document.getElementById(id);

// ─── State ────────────────────────────────────────────────────────────────
let resolved       = null;   // { source, formId, formUrl, name, fields }
let resolveError   = null;
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
    const rule  = findMatchingRule(visitorProfile, f.dummyValue ?? f.label, usedRuleIds);
    const value = resolveRule(rule, user);
    if (!value) continue;
    params.set(f.entryId, value);
    if (rule?.id) usedRuleIds.add(rule.id);
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
      };
      if (!resolved.fields) await fetchFieldsInto(resolved);
      return;
    }
    // Slug miss — if it looks like a forms.gle short code (alphanumeric, no
    // hyphens, shorter than a full form ID), resolve via forms.gle redirect.
    if (/^[A-Za-z0-9]{8,19}$/.test(route.value)) {
      resolved = { source: 'short', formId: null, formUrl: null, name: null, fields: null };
      await fetchFieldsInto(resolved, `https://forms.gle/${route.value}`);
      return;
    }
    resolveError = 'not-found';
    return;
  }

  // For formId / url paths: optionally pick up a saved Accord's name, then fetch fields.
  let savedName = null;
  let inputForFn = route.value;
  if (route.kind === 'formId') {
    try {
      const existing = await getAccordByFormId(route.value);
      if (existing) {
        savedName = existing.name;
        if (Array.isArray(existing.fields) && existing.fields.length) {
          resolved = {
            source: 'formId',
            formId: route.value,
            formUrl: existing.formUrl,
            name: existing.name,
            fields: existing.fields,
          };
          return;
        }
      }
    } catch {}
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
    return;
  }
  if (!res.ok || !Array.isArray(payload.fields)) {
    resolveError = 'unreadable';
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

  const fields = ensureEmailAddressField(resolved.fields);
  const list   = $('gate-preview-list');
  list.innerHTML = '';

  let fillableCount = 0;
  const usedRuleIds = new Set();
  for (const f of fields) {
    const label = (f.dummyValue || '').trim() || 'Untitled question';
    const rule  = findMatchingRule(visitorProfile, label, usedRuleIds);
    const value = resolveRule(rule, authUser);
    if (!value) continue;
    if (rule?.id) usedRuleIds.add(rule.id);
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

  const total = fields.length;
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
    show('not-found');
    hidePreloader();
    return;
  }
  if (resolveError === 'unreadable') {
    $('gate-accord-name').textContent = resolved.name || 'this form';
    show('not-found');
    $('state-not-found').querySelector('.not-found').textContent =
      "Couldn't read this form — make sure the link is public.";
    hidePreloader();
    return;
  }

  $('gate-accord-name').textContent = resolved.name || 'this form';
  $('gate-invited-label').textContent =
    resolved.source === 'slug' ? "YOU'VE BEEN INVITED TO" : "AUTO-FILLING";
  document.title = `${resolved.name || 'Accord'} — Accord`;

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
    try { visitorProfile = await ensureProfileSeeded(result.user); } catch {}
    await doRedirect(result.user);
  } catch (e) {
    console.error(e);
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
});

$('gate-skip-btn')?.addEventListener('click', () => doSkipRedirect());

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
