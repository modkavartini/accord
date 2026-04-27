import {
  onAuth, signOutUser,
  getUserAccords, updateAccord, deleteAccord, slugExists,
  ensureProfileSeeded,
  getUserFills,
  extractFormId,
  purgeAccount,
} from './firebase.js';

// ─── State ────────────────────────────────────────────────────────────────
let currentUser  = null;
let accords      = [];
let editingId    = null;
let profile      = { fields: [] };
let editFields   = [];

// ─── DOM helper ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─── Toast ────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Preloader ────────────────────────────────────────────────────────────
function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
}

// ─── Auth guard ───────────────────────────────────────────────────────────
onAuth(user => {
  if (!user) { window.location.href = '/'; return; }
  currentUser = user;
  renderUserPill(user);
  Promise.all([loadAccords(), loadProfile(), loadFills()]).then(() => hidePreloader());
});

function renderUserPill(user) {
  const av = $('user-avatar');
  if (user.photoURL) {
    av.innerHTML = `<img src="${user.photoURL}" alt="" />`;
  } else {
    av.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
  }
  $('user-name').textContent = user.displayName || user.email;
  $('menu-display-name').textContent = user.displayName || '';
  $('menu-email').textContent = user.email || '';
}

// ─── User menu toggle ─────────────────────────────────────────────────────
$('user-pill').addEventListener('click', (e) => {
  e.stopPropagation();
  $('user-menu').classList.toggle('hidden');
});
document.addEventListener('click', () => $('user-menu').classList.add('hidden'));
$('sign-out-btn').addEventListener('click', async () => {
  await signOutUser();
  window.location.href = '/';
});

// ─── Delete-account flow ─────────────────────────────────────────────────
$('delete-account-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('user-menu').classList.add('hidden');
  $('delete-account-modal').classList.remove('hidden');
});
$('delete-account-close').addEventListener('click', () =>
  $('delete-account-modal').classList.add('hidden'));
$('delete-account-cancel').addEventListener('click', () =>
  $('delete-account-modal').classList.add('hidden'));
$('delete-account-modal').addEventListener('click', e => {
  if (e.target === $('delete-account-modal')) $('delete-account-modal').classList.add('hidden');
});
$('delete-account-confirm').addEventListener('click', async () => {
  if (!currentUser) return;
  const btn = $('delete-account-confirm');
  btn.textContent = 'Deleting…';
  btn.disabled = true;
  try {
    await purgeAccount(currentUser);
    window.location.href = '/';
  } catch (e) {
    console.error(e);
    toast('Failed to delete — try again');
    btn.textContent = 'Delete forever';
    btn.disabled = false;
  }
});

// ─── Profile (load only — editing happens on /profile) ──────────────────
async function loadProfile() {
  try {
    profile = await ensureProfileSeeded(currentUser);
  } catch {
    profile = { fields: [] };
  }
  // Show "finish setting up" cues if the user hasn't gone beyond the seeded
  // Name + Email rules — i.e. they still need to add Phone, College, etc.
  const needsMore = (profile.fields || []).length < 3;
  $('profile-dot').classList.toggle('hidden', !needsMore);
  $('setup-banner').classList.toggle('hidden', !needsMore);
}

// ─── Lifetime auto-fill counter ───────────────────────────────────────────
async function loadFills() {
  let count = 0;
  try { count = await getUserFills(currentUser.uid); } catch {}
  $('fills-stat-num').textContent = count < 10 ? `0${count}` : count.toLocaleString('en-IN');
}

// ─── Load & render accords ────────────────────────────────────────────────
async function loadAccords() {
  const list = $('accords-list');
  accords = await getUserAccords(currentUser.uid);
  accords.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  $('accord-count').textContent =
    accords.length === 0 ? 'No accords yet' : `${accords.length} accord${accords.length !== 1 ? 's' : ''}`;

  if (accords.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">No saved Accords yet</p>
        <p class="empty-sub">You don't need to save anything to use Accord — visit any form via <code>/go/&lt;form-id&gt;</code> and it auto-fills. Save a form here to give it a friendly alias.</p>
        <a class="btn btn-primary" href="/create-accord">Save your first Accord</a>
      </div>`;
    return;
  }

  list.innerHTML = accords.map((a, i) => renderCard(a, i)).join('');

  accords.forEach(a => {
    $(`edit-${a.id}`)?.addEventListener('click', () => openEdit(a));
    $(`delete-${a.id}`)?.addEventListener('click', () => handleDelete(a));
  });
  list.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(`https://${btn.dataset.copy}`);
      toast('Link copied to clipboard');
    });
  });
}

function renderCard(accord, i) {
  const formId       = accord.formId || extractFormId(accord.formUrl) || '';
  const canonicalLink = formId ? `accord-ingly.netlify.app/go/${formId}` : '';
  const aliasLink     = accord.slug ? `accord-ingly.netlify.app/go/${accord.slug}` : '';
  const date = accord.createdAt?.toDate
    ? accord.createdAt.toDate().toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' })
    : '—';

  return `
    <div class="accord-card glass" style="animation-delay:${i * 0.07}s;">
      <div class="card-top">
        <div>
          <p class="card-title">${escHtml(accord.name)}</p>
          <p class="card-date">Saved ${date}</p>
        </div>
        <div class="card-actions">
          <button class="btn btn-ghost btn-sm" id="edit-${accord.id}">Edit</button>
          <button class="btn btn-danger btn-sm" id="delete-${accord.id}">Delete</button>
        </div>
      </div>
      <div class="divider"></div>
      ${canonicalLink ? `
        <div class="link-row">
          <div class="link-display">${escHtml(canonicalLink)}</div>
          <button class="btn btn-ghost btn-sm" data-copy="${escHtml(canonicalLink)}" id="copy-${accord.id}">Copy link</button>
        </div>` : ''}
      ${aliasLink ? `
        <div class="link-row link-row-alias">
          <div class="link-display link-display-alias"><span class="alias-tag">ALIAS</span>${escHtml(aliasLink)}</div>
          <button class="btn btn-ghost btn-sm" data-copy="${escHtml(aliasLink)}" id="copy-alias-${accord.id}">Copy</button>
        </div>` : ''}
    </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Delete ───────────────────────────────────────────────────────────────
async function handleDelete(accord) {
  if (!confirm(`Delete "${accord.name}"? This cannot be undone.`)) return;
  await deleteAccord(accord.id);
  toast('Accord deleted');
  loadAccords();
}

// ─── EDIT MODAL ───────────────────────────────────────────────────────────
function openEdit(accord) {
  editingId = accord.id;

  if (Array.isArray(accord.fields) && accord.fields.length) {
    editFields = [...accord.fields];
  } else {
    editFields = [];
    if (accord.nameParam)  editFields.push({ entryId: accord.nameParam,  dummyValue: 'Name'  });
    if (accord.emailParam) editFields.push({ entryId: accord.emailParam, dummyValue: 'Email' });
  }

  $('e-name').value     = accord.name || '';
  $('e-slug').value     = accord.slug || '';
  $('e-form-url').value = accord.formUrl || '';
  $('e-slug-error').classList.add('hidden');
  $('e-form-status').classList.add('hidden');
  $('e-form-status').textContent = '';
  lastParsedUrl.e = accord.formUrl || '';

  renderDetectedFromFields('e', editFields);

  $('edit-modal').classList.remove('hidden');
  setTimeout(() => $('e-name').focus(), 50);
}

$('e-slug').addEventListener('input', () => {
  $('e-slug').value = $('e-slug').value.replace(/[^a-zA-Z0-9-]/g, '');
  $('e-slug-error').classList.add('hidden');
});

$('edit-close').addEventListener('click', () => $('edit-modal').classList.add('hidden'));
$('edit-cancel').addEventListener('click', () => $('edit-modal').classList.add('hidden'));

$('edit-save').addEventListener('click', async () => {
  const slug = $('e-slug').value.trim();
  if (slug) {
    if (slug.length < 3) { showError('e-slug-error', 'Alias must be at least 3 characters'); return; }
    if (!/^[a-zA-Z0-9-]+$/.test(slug)) { showError('e-slug-error', 'Only letters, numbers, and hyphens'); return; }
  }

  $('edit-save').textContent = 'Saving…';
  $('edit-save').disabled = true;

  if (slug) {
    const taken = await slugExists(slug, editingId);
    if (taken) {
      showError('e-slug-error', 'This alias is already taken');
      $('edit-save').textContent = 'Save Changes';
      $('edit-save').disabled = false;
      return;
    }
  }

  const formUrl = $('e-form-url').value.trim();
  try {
    await updateAccord(editingId, {
      name:    $('e-name').value.trim(),
      slug:    slug || null,
      formUrl,
      formId:  extractFormId(formUrl),
      fields:  [...(editFields || [])],
    });
    $('edit-modal').classList.add('hidden');
    toast('Accord updated');
    loadAccords();
  } catch {
    toast('Failed to save');
  }

  $('edit-save').textContent = 'Save Changes';
  $('edit-save').disabled = false;
});

// ─── Rule matcher (for creator's preview only) ────────────────────────────
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

// ─── Auto-parse Google Forms URL (edit modal) ─────────────────────────────
const lastParsedUrl = { e: '' };

async function parseFormUrl() {
  const urlInput = $('e-form-url');
  const raw = urlInput.value.trim();
  if (!raw || lastParsedUrl.e === raw) return;

  let url;
  try { url = new URL(raw); } catch { return; }
  if (url.hostname !== 'docs.google.com' && url.hostname !== 'forms.gle') return;

  lastParsedUrl.e = raw;
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

  editFields = payload.fields.map(f => ({ entryId: f.entryId, dummyValue: f.label }));
  if (payload.formUrl) {
    urlInput.value = payload.formUrl;
    lastParsedUrl.e = payload.formUrl;
  }
  renderDetectedFromFields('e', editFields);
  setFieldStatus('ok', `Detected ${editFields.length} field${editFields.length !== 1 ? 's' : ''} from your form`);
}

function setFieldStatus(kind, msg) {
  const el = $('e-form-status');
  el.classList.remove('hidden', 'is-error', 'is-ok');
  if (kind === 'error') el.classList.add('is-error');
  if (kind === 'ok')    el.classList.add('is-ok');
  el.innerHTML = kind === 'loading'
    ? `<span class="spinner"></span><span>${escHtml(msg)}</span>`
    : escHtml(msg);
}

function renderDetectedFromFields(prefix, fields) {
  const host = $(`${prefix}-detected`);
  if (!host) return;
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

const eUrlInput = $('e-form-url');
eUrlInput.addEventListener('paste', () => setTimeout(parseFormUrl, 0));
eUrlInput.addEventListener('blur',  parseFormUrl);

// ─── Close edit modal on backdrop click ──────────────────────────────────
$('edit-modal').addEventListener('click', e => {
  if (e.target === $('edit-modal')) $('edit-modal').classList.add('hidden');
});

// ─── Helper ───────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
