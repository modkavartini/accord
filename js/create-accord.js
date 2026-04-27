import {
  onAuth,
  createAccord, slugExists, ensureProfileSeeded,
  extractFormId,
  nanoid,
} from './firebase.js';

const $ = id => document.getElementById(id);

let currentUser = null;
let profile     = { fields: [] };
let createFields = [];
let createFormId = null;
let lastParsedUrl = '';

// ─── Preloader ────────────────────────────────────────────────────────────
function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
}

// ─── Toast ────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Auth guard ───────────────────────────────────────────────────────────
onAuth(async user => {
  if (!user) { window.location.href = '/'; return; }
  currentUser = user;
  try { profile = await ensureProfileSeeded(user); } catch {}
  hidePreloader();
});

// ─── Helpers ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

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

// ─── URL parsing ──────────────────────────────────────────────────────────
async function parseFormUrl() {
  const urlInput = $('c-form-url');
  const raw = urlInput.value.trim();
  if (!raw || raw === lastParsedUrl) return;

  let url;
  try { url = new URL(raw); } catch { return; }
  if (url.hostname !== 'docs.google.com' && url.hostname !== 'forms.gle') return;

  lastParsedUrl = raw;
  setFieldStatus('loading', 'Visiting your form…');

  let res, payload = {};
  try {
    res = await fetch(`/.netlify/functions/parse-form?url=${encodeURIComponent(raw)}`);
    payload = await res.json().catch(() => ({}));
  } catch {
    setFieldStatus('error', 'Could not reach the detector — check your connection');
    return;
  }
  if (!res.ok || !Array.isArray(payload.fields)) {
    setFieldStatus('error', payload.error || 'Could not detect fields — make sure the form is public');
    return;
  }

  createFields = payload.fields.map(f => ({ entryId: f.entryId, dummyValue: f.label }));

  if (payload.formUrl) {
    urlInput.value = payload.formUrl;
    lastParsedUrl  = payload.formUrl;
  }

  renderDetected(createFields);
  setFieldStatus('ok', `Detected ${createFields.length} field${createFields.length !== 1 ? 's' : ''} from your form`);

  const formId = payload.formId || extractFormId(payload.formUrl || raw);
  if (formId) revealExtras(formId, payload.formTitle || '');
}

function revealExtras(formId, formTitle) {
  createFormId = formId;
  if (formTitle && !$('c-name').value.trim()) $('c-name').value = formTitle;
  $('c-default-link').textContent = `accord-ingly.netlify.app/go/${formId}`;
  $('c-after-fields').classList.remove('hidden');
  $('c-link-field').classList.remove('hidden');
  $('c-slug-field').classList.remove('hidden');
  $('create-submit').disabled = false;
}

function setFieldStatus(kind, msg) {
  const el = $('c-form-status');
  el.classList.remove('hidden', 'is-error', 'is-ok');
  if (kind === 'error') el.classList.add('is-error');
  if (kind === 'ok')    el.classList.add('is-ok');
  el.innerHTML = kind === 'loading'
    ? `<span class="spinner"></span><span>${escHtml(msg)}</span>`
    : escHtml(msg);
}

function renderDetected(fields) {
  const host = $('c-detected');
  if (!fields.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  host.classList.remove('hidden');
  host.innerHTML = `
    <p class="detected-list-title">DETECTED FIELDS — each visitor's profile resolves these</p>
    ${fields.map(f => {
      const dummy = f.dummyValue || '';
      let preview = '<span class="dr-tag dr-tag-dim">visitor must have a matching rule</span>';
      let rule = null;
      for (const r of (profile.fields || [])) {
        if (matchRule(r, dummy)) { rule = r; break; }
      }
      if (rule) {
        if (rule.source === 'auth-name') {
          preview = `<span class="dr-tag dr-tag-auth">visitor's Google name (via "${escHtml(rule.label)}")</span>`;
        } else if (rule.source === 'auth-email') {
          preview = `<span class="dr-tag dr-tag-auth">visitor's Google email (via "${escHtml(rule.label)}")</span>`;
        } else if (rule.value) {
          preview = `<span class="dr-tag dr-tag-match">your value: "${escHtml(rule.value)}"</span>`;
        } else {
          preview = `<span class="dr-tag dr-tag-dim">matches your "${escHtml(rule.label)}" rule</span>`;
        }
      }
      return `
        <div class="detected-row">
          <span class="dr-label">${escHtml(dummy || '(empty)')}</span>
          <span class="dr-entry">${escHtml(f.entryId)}</span>
          <span class="dr-value">${preview}</span>
        </div>`;
    }).join('')}
  `;
}

// ─── Wire up ──────────────────────────────────────────────────────────────
const urlInput = $('c-form-url');
urlInput.addEventListener('paste', () => setTimeout(parseFormUrl, 0));
urlInput.addEventListener('blur',  parseFormUrl);

$('c-slug').addEventListener('input', () => {
  $('c-slug').value = $('c-slug').value.replace(/[^a-zA-Z0-9-]/g, '');
  $('c-slug-error').classList.add('hidden');
});

$('create-submit').addEventListener('click', async () => {
  if (!createFormId) { toast('Paste a form URL first'); return; }
  const name = $('c-name').value.trim();
  if (!name) { toast('Please enter an Accord name'); return; }

  const slug = $('c-slug').value.trim();
  if (slug) {
    if (slug.length < 3) { showError('c-slug-error', 'Alias must be at least 3 characters'); return; }
    if (!/^[a-zA-Z0-9-]+$/.test(slug)) { showError('c-slug-error', 'Only letters, numbers, and hyphens'); return; }
  }

  const btn = $('create-submit');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  if (slug) {
    const taken = await slugExists(slug);
    if (taken) {
      showError('c-slug-error', 'This alias is already taken');
      btn.textContent = 'Save Accord ✦';
      btn.disabled = false;
      return;
    }
  }

  try {
    await createAccord({
      id:         nanoid(),
      name,
      slug:       slug || null,
      formId:     createFormId,
      formUrl:    urlInput.value.trim(),
      fields:     createFields,
      ownerId:    currentUser.uid,
      ownerEmail: currentUser.email || '',
    });
    window.location.href = '/dashboard';
  } catch (e) {
    console.error(e);
    toast('Something went wrong');
    btn.textContent = 'Save Accord ✦';
    btn.disabled = false;
  }
});
