import {
  onAuth, signOutUser,
  getProfile, saveProfile,
  ensureProfileSeeded,
  purgeAccount,
  nanoid
} from './firebase.js';

// ─── State ────────────────────────────────────────────────────────────────
let currentUser    = null;
let profile        = { fields: [] };
let editingFieldId = null;

// ─── Popular presets (custom fields) ──────────────────────────────────────
const PRESETS = [
  { label: 'Phone Number',    match: 'contains', patterns: ['Phone', 'Number', 'Contact'] },
  { label: 'IEEE Membership ID', match: 'contains', patterns: ['IEEE', 'Membership ID']      },
  { label: 'College',         match: 'contains', patterns: ['College', 'Institution', 'University'] },
  { label: 'Year of Study',   match: 'contains', patterns: ['Year', 'Batch', 'Semester']  },
  { label: 'Branch',          match: 'contains', patterns: ['Branch', 'Department', 'Stream'] },
  { label: 'Roll Number',     match: 'contains', patterns: ['Roll', 'Reg', 'Admission']   },
];

// ─── Recommended starter rules for new users ──────────────────────────────
const STARTERS = [
  { id: '__name',  label: 'Name',         match: 'contains', patterns: ['Name', 'Full Name'],  source: 'value', value: '' },
  { id: '__email', label: 'Email',        match: 'contains', patterns: ['Email'], source: 'value', value: '' },
  { id: '__phone', label: 'Phone Number', match: 'contains', patterns: ['Phone', 'Number', 'Contact'], source: 'value', value: '' },
];

const $ = id => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function getReturnTo() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('returnTo');
  if (r && /^\/[^\s]*$/.test(r)) return r;
  return '/dashboard';
}
function applyBackLinks() {
  const r = getReturnTo();
  $('back-link').setAttribute('href', r);
  $('cancel-link').setAttribute('href', r);
}

// ─── Auth guard ───────────────────────────────────────────────────────────
onAuth(user => {
  if (!user) { window.location.href = '/'; return; }
  currentUser = user;
  renderUserPill(user);
  applyBackLinks();
  loadProfile().then(() => hidePreloader());
});

function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
}

function renderUserPill(user) {
  const av = $('user-avatar');
  if (user.photoURL) av.innerHTML = `<img src="${user.photoURL}" alt="" />`;
  else av.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
  $('user-name').textContent = user.displayName || user.email;
  $('menu-display-name').textContent = user.displayName || '';
  $('menu-email').textContent = user.email || '';
}

$('user-pill').addEventListener('click', e => {
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

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Load profile (seeds Name + Email for new accounts) ──────────────────
async function loadProfile() {
  try {
    profile = await ensureProfileSeeded(currentUser);
  } catch {
    profile = { fields: [] };
  }
  renderFields();
  renderPresets();
  renderRecommendations();
}

// ─── Render the unified field list ───────────────────────────────────────
function renderFields() {
  const list = $('profile-fields-list');
  if (!profile.fields.length) {
    list.innerHTML = '<p class="profile-empty">No fields yet — add one below or pick a recommendation</p>';
    return;
  }
  list.innerHTML = profile.fields.map(f => {
    const enabled = f.enabled !== false;
    const valueDescr = describeValue(f);
    return `
      <div class="profile-field-card${enabled ? '' : ' is-disabled'}" data-id="${escHtml(f.id)}">
        <label class="toggle" title="${enabled ? 'Disable' : 'Enable'} this rule">
          <input type="checkbox" data-toggle="${escHtml(f.id)}" ${enabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
        <div class="pf-info">
          <p class="pf-label">${escHtml(f.label || '(unlabeled)')}</p>
          <p class="pf-detail">
            <code>${escHtml(f.match)}</code> ${(f.patterns || []).map(p => escHtml(`"${p}"`)).join(', ')}
            <span class="pf-value-tag">→ ${valueDescr}</span>
          </p>
        </div>
        <button class="btn btn-ghost btn-sm" data-edit="${escHtml(f.id)}">Edit</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = profile.fields.find(x => x.id === btn.dataset.edit);
      if (f) openFieldEdit(f);
    });
  });
  list.querySelectorAll('[data-toggle]').forEach(box => {
    box.addEventListener('change', () => toggleField(box.dataset.toggle, box.checked));
  });
}

function describeValue(f) {
  if (f.source === 'auth-name')  return '<em>your Google name</em>';
  if (f.source === 'auth-email') return '<em>your Google email</em>';
  return f.value ? `"${escHtml(f.value)}"` : '<em>(no value set)</em>';
}

async function toggleField(id, enabled) {
  profile.fields = profile.fields.map(f => f.id === id ? { ...f, enabled } : f);
  await saveProfile(currentUser.uid, profile);
  renderFields();
  renderRecommendations();
  toast(enabled ? 'Rule enabled' : 'Rule disabled');
}

// ─── Presets ─────────────────────────────────────────────────────────────
function renderPresets() {
  const list = $('presets-list');
  list.innerHTML = PRESETS.map((p, i) => {
    const taken = profile.fields.some(f => (f.label || '').toLowerCase() === p.label.toLowerCase());
    return `<button class="preset-btn" data-idx="${i}" ${taken ? 'disabled' : ''}>+ ${escHtml(p.label)}</button>`;
  }).join('');
  list.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = PRESETS[parseInt(btn.dataset.idx)];
      openFieldEdit({ label: p.label, match: p.match, patterns: p.patterns, value: '', source: 'value' });
    });
  });
}

// ─── Recommendation card (shows starter rules not yet added) ─────────────
function renderRecommendations() {
  const card = $('recommend-card');
  const actions = $('recommend-actions');
  const missing = STARTERS.filter(s =>
    !profile.fields.some(f => (f.label || '').toLowerCase() === s.label.toLowerCase())
  );
  if (!missing.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  actions.innerHTML = missing.map(s => `
    <button class="recommend-btn ${s.id === '__phone' ? 'recommend-btn-primary' : ''}" data-rec="${escHtml(s.id)}">
      + Add ${escHtml(s.label)}
    </button>
  `).join('');

  actions.querySelectorAll('[data-rec]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = STARTERS.find(x => x.id === btn.dataset.rec);
      if (!s) return;
      // All starters open the editor so the user can type the value they
      // actually want filled in — including Name/Email (don't auto-pull
      // from the Google account; the user might want a nickname / alt email).
      openFieldEdit({ label: s.label, match: s.match, patterns: s.patterns, value: '', source: 'value' });
    });
  });
}

async function addRule(rule) {
  profile.fields.push(rule);
  await saveProfile(currentUser.uid, profile);
  renderFields();
  renderPresets();
  renderRecommendations();
  toast(`${rule.label} added`);
}

// ─── Field-edit modal ────────────────────────────────────────────────────
function openFieldEdit(field) {
  editingFieldId = field.id || null;
  $('field-edit-title').textContent = field.id ? 'Edit field' : 'Add field';
  $('f-label').value    = field.label || '';
  $('f-match').value    = field.match || 'contains';
  $('f-patterns').value = (field.patterns || []).join(', ');
  $('f-value').value    = field.value || '';
  $('f-source').value   = field.source || 'value';
  // Default ON for new fields and any legacy field that predates this flag.
  $('f-first-only').checked = field.firstOnly !== false;
  $('f-delete').style.display = field.id ? '' : 'none';
  applySourceUI();
  $('field-edit-modal').classList.remove('hidden');
  setTimeout(() => $('f-label').focus(), 50);
}

function applySourceUI() {
  const src = $('f-source').value;
  const isAuth = src === 'auth-name' || src === 'auth-email';
  $('f-value-row').classList.toggle('hidden', isAuth);
  $('f-source-hint').textContent =
    src === 'auth-name'  ? 'Accord uses your Google account name from this device.' :
    src === 'auth-email' ? 'Accord uses your Google account email from this device.' :
                            'Accord types your saved value into the field.';
}
$('f-source').addEventListener('change', applySourceUI);

async function saveField() {
  const label    = $('f-label').value.trim();
  const match    = $('f-match').value;
  const patterns = $('f-patterns').value.split(',').map(s => s.trim()).filter(Boolean);
  const source   = $('f-source').value;
  const value    = source === 'value' ? $('f-value').value : '';

  if (!label)            { toast('Add a label');              return; }
  if (!patterns.length)  { toast('Add at least one pattern'); return; }

  // Preserve existing enabled state when editing; new rules default to enabled
  const existing = editingFieldId ? profile.fields.find(x => x.id === editingFieldId) : null;
  const enabled  = existing ? existing.enabled !== false : true;

  const firstOnly = $('f-first-only').checked;

  const f = { id: editingFieldId || nanoid(8), label, match, patterns, value, source, enabled, firstOnly };
  if (editingFieldId) {
    profile.fields = profile.fields.map(x => x.id === editingFieldId ? f : x);
  } else {
    profile.fields.push(f);
  }

  $('f-save').textContent = 'Saving…';
  $('f-save').disabled = true;
  try {
    await saveProfile(currentUser.uid, profile);
    $('field-edit-modal').classList.add('hidden');
    renderFields();
    renderPresets();
    renderRecommendations();
    toast('Field saved');
  } catch (e) {
    console.error(e);
    toast('Failed to save');
  }
  $('f-save').textContent = 'Save';
  $('f-save').disabled = false;
}

async function deleteField() {
  if (!editingFieldId) return;
  if (!confirm('Delete this field?')) return;
  profile.fields = profile.fields.filter(x => x.id !== editingFieldId);
  try {
    await saveProfile(currentUser.uid, profile);
    $('field-edit-modal').classList.add('hidden');
    renderFields();
    renderPresets();
    renderRecommendations();
    toast('Field deleted');
  } catch {
    toast('Failed to delete');
  }
}

$('add-field-btn').addEventListener('click', () => openFieldEdit({}));
$('field-edit-close').addEventListener('click', () => $('field-edit-modal').classList.add('hidden'));
$('f-cancel').addEventListener('click', () => $('field-edit-modal').classList.add('hidden'));
$('f-save').addEventListener('click', saveField);
$('f-delete').addEventListener('click', deleteField);
$('field-edit-modal').addEventListener('click', e => {
  if (e.target === $('field-edit-modal')) $('field-edit-modal').classList.add('hidden');
});
