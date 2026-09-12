// Step-by-step profile setup. One question per screen; every answer becomes
// (or updates) a rule in the visitor's profile — the same rules /profile
// edits by hand — so the gate can fill that field on every form afterwards.
//
// Reached from the dashboard (auto for brand-new accounts, a banner for
// everyone else) and from the gate's "Edit my Accord profile" link when the
// profile only has the seeded Name + Email. Finishing or skipping stamps
// `onboardingStatus` on the profile doc so we stop nagging.
import {
  onAuth,
  ensureProfileSeeded, saveProfile,
  nanoid,
} from './firebase.js';

const $ = id => document.getElementById(id);

// ─── Questions ────────────────────────────────────────────────────────────
// `label` doubles as the rule's label, so an answer updates an existing rule
// with the same label (Name/Email seeded at sign-up, presets on /profile)
// instead of adding a duplicate.
const STEPS = [
  {
    key: 'name', label: 'Name', required: true,
    question: "What's your name?",
    hint: "Exactly as you'd write it on a form — Accord types this wherever a form asks for your name.",
    patterns: ['Name'], autocomplete: 'name', placeholder: 'Your full name',
    prefill: (user, rule) => ruleValue(rule, user) || user.displayName || '',
  },
  {
    key: 'email', label: 'Email',
    question: 'Which email should forms get?',
    hint: "Usually your Google email. Change it if you'd rather forms reach you somewhere else.",
    patterns: ['Email', 'E-mail'], type: 'email', autocomplete: 'email', placeholder: 'you@example.com',
    prefill: (user, rule) => ruleValue(rule, user) || user.email || '',
  },
  {
    key: 'phone', label: 'Phone Number',
    question: "What's your phone number?",
    hint: "Include the country code if you register for events outside India. Skip if you'd rather type it each time.",
    patterns: ['Phone', 'Mobile', 'Contact', 'WhatsApp'], type: 'tel', autocomplete: 'tel', placeholder: '+91 98765 43210',
  },
  {
    key: 'org', label: 'College',
    question: 'What organisation, college or institution are you part of?',
    hint: 'Write the full name. In dropdowns Accord also understands abbreviations, so "College of Engineering Trivandrum" still picks "CET".',
    patterns: ['College', 'Institution', 'University', 'Organisation', 'Organization', 'Institute', 'School'],
    autocomplete: 'organization', placeholder: 'e.g. College of Engineering Trivandrum',
  },
  {
    key: 'branch', label: 'Branch',
    question: 'Which branch or department are you in?',
    hint: "Skip this if it doesn't apply to you.",
    patterns: ['Branch', 'Department', 'Stream', 'Discipline'], placeholder: 'e.g. Computer Science',
  },
  {
    key: 'year', label: 'Year of Study',
    question: 'Which year are you in?',
    hint: 'Pick one or type your own — "S5", "2024 batch", "Final year" all work.',
    patterns: ['Year', 'Batch', 'Semester'], placeholder: 'e.g. 3rd year',
    chips: ['1st year', '2nd year', '3rd year', '4th year'],
  },
  {
    key: 'roll', label: 'Roll Number',
    question: "What's your roll or register number?",
    hint: 'Whatever your institution puts on ID cards and attendance sheets.',
    patterns: ['Roll', 'Reg', 'Admission'], placeholder: 'e.g. TVE22CS042',
  },
  {
    key: 'ieee', label: 'IEEE Membership ID',
    question: 'Are you an IEEE member?',
    hint: 'Lots of college events run on IEEE forms that ask this. Accord answers the yes/no question and fills your ID.',
    patterns: ['IEEE', 'Membership ID'], placeholder: 'e.g. 98765432',
    yesNo: { label: 'IEEE Member', patterns: ['Are you an IEEE member', 'IEEE member?'], subLabel: 'Your IEEE membership ID' },
  },
];

function ruleValue(rule, user) {
  if (!rule) return '';
  if (rule.source === 'auth-name')  return user.displayName || '';
  if (rule.source === 'auth-email') return user.email || '';
  return rule.value || '';
}

// ─── State ────────────────────────────────────────────────────────────────
let currentUser = null;
let profile     = { fields: [] };
let stepIndex   = 0;
let answers     = {};   // key → string (yesNo steps: { choice, value })
let saving      = false;

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function getReturnTo() {
  const r = new URLSearchParams(window.location.search).get('returnTo');
  return r && /^\/[^\s]*$/.test(r) ? r : '/dashboard';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const findRule = label =>
  (profile.fields || []).find(f => (f.label || '').toLowerCase() === label.toLowerCase());

// ─── Boot ─────────────────────────────────────────────────────────────────
onAuth(async user => {
  if (!user) { window.location.href = '/'; return; }
  currentUser = user;
  try { profile = await ensureProfileSeeded(user); }
  catch (e) { console.error('[accord/onboarding] profile load failed', e); profile = { fields: [] }; }

  for (const s of STEPS) {
    const rule = findRule(s.label);
    if (s.yesNo) {
      const yn = findRule(s.yesNo.label);
      answers[s.key] = { choice: yn?.value || '', value: rule?.value || '' };
    } else {
      answers[s.key] = s.prefill ? s.prefill(user, rule) : (rule?.value || '');
    }
  }
  renderStep();
  const p = $('preloader');
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
});

// ─── Rendering ────────────────────────────────────────────────────────────
function renderProgress() {
  const total = STEPS.length;
  const n = Math.min(stepIndex, total);
  $('ob-progress-fill').style.width = `${(n / total) * 100}%`;
  $('ob-progress-count').textContent = stepIndex < total ? `${stepIndex + 1} / ${total}` : 'done';
}

function renderStep() {
  renderProgress();
  const form = $('ob-step');
  if (stepIndex >= STEPS.length) { renderDone(form); return; }

  const s = STEPS[stepIndex];
  const a = answers[s.key];
  const isLast = stepIndex === STEPS.length - 1;
  const optional = !s.required;

  const fills = `Fills questions containing ${s.patterns.map(p => `<code>${escHtml(p)}</code>`).join(' ')}`;

  let body;
  if (s.yesNo) {
    const choice = a.choice;
    body = `
      <div class="ob-chips" role="radiogroup" aria-label="${escHtml(s.question)}">
        <button type="button" class="ob-chip${choice === 'Yes' ? ' is-active' : ''}" data-choice="Yes">Yes</button>
        <button type="button" class="ob-chip${choice === 'No'  ? ' is-active' : ''}" data-choice="No">No</button>
      </div>
      <div class="ob-sub${choice === 'Yes' ? '' : ' hidden'}" id="ob-sub">
        <p class="ob-sub-label">${escHtml(s.yesNo.subLabel)}</p>
        <input class="input ob-input" id="ob-input" inputmode="numeric" autocomplete="off"
               placeholder="${escHtml(s.placeholder || '')}" value="${escHtml(a.value)}" />
      </div>
      <p class="ob-fills-note">${fills}</p>`;
  } else {
    const chips = s.chips ? `
      <div class="ob-chips">
        ${s.chips.map(c => `<button type="button" class="ob-chip${a === c ? ' is-active' : ''}" data-chip="${escHtml(c)}">${escHtml(c)}</button>`).join('')}
      </div>` : '';
    body = `
      <input class="input ob-input" id="ob-input" type="text" inputmode="${s.type || 'text'}"
             autocomplete="${s.autocomplete || 'off'}" autocapitalize="${s.type ? 'off' : 'words'}"
             placeholder="${escHtml(s.placeholder || '')}" value="${escHtml(a)}" ${s.required ? 'required' : ''} />
      ${chips}
      <p class="ob-fills-note">${fills}</p>`;
  }

  form.innerHTML = `
    <p class="ob-eyebrow">${optional ? 'Optional' : 'Required'} · ${escHtml(s.label)}</p>
    <h1 class="ob-question">${escHtml(s.question)}</h1>
    <p class="ob-hint">${escHtml(s.hint)}</p>
    ${body}
    <div class="ob-actions">
      <button type="button" class="ob-back" id="ob-back" ${stepIndex === 0 ? 'hidden' : ''}>← Back</button>
      ${optional ? `<button type="button" class="btn btn-ghost" id="ob-skip">Skip</button>` : ''}
      <button type="submit" class="btn btn-primary" id="ob-next">${isLast ? 'Finish' : 'Continue'} →</button>
    </div>`;

  form.querySelectorAll('[data-chip]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('ob-input').value = btn.dataset.chip;
      form.querySelectorAll('[data-chip]').forEach(b => b.classList.toggle('is-active', b === btn));
      $('ob-input').focus();
    });
  });
  form.querySelectorAll('[data-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      answers[s.key].choice = btn.dataset.choice;
      form.querySelectorAll('[data-choice]').forEach(b => b.classList.toggle('is-active', b === btn));
      $('ob-sub').classList.toggle('hidden', btn.dataset.choice !== 'Yes');
      if (btn.dataset.choice === 'Yes') $('ob-input').focus();
    });
  });
  const input = $('ob-input');
  if (input && s.chips) {
    input.addEventListener('input', () => {
      form.querySelectorAll('[data-chip]').forEach(b => b.classList.toggle('is-active', b.dataset.chip === input.value.trim()));
    });
  }

  $('ob-back')?.addEventListener('click', () => go(-1));
  $('ob-skip')?.addEventListener('click', () => go(+1));
  form.onsubmit = e => { e.preventDefault(); commitStep(); };

  // Text steps: open the keyboard straight away, caret after the prefill.
  if (input && !s.yesNo) setTimeout(() => {
    input.focus({ preventScroll: true });
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch {}
  }, 60);
}

function renderDone(form) {
  const rows = STEPS.map(s => {
    const a = answers[s.key];
    if (s.yesNo) {
      if (!a.choice) return null;
      return { k: s.label, v: a.choice === 'Yes' && a.value ? `Yes · ${a.value}` : a.choice };
    }
    return a ? { k: s.label, v: a } : null;
  }).filter(Boolean);

  const returnTo = getReturnTo();
  const goingToForm = returnTo.startsWith('/go/');
  form.innerHTML = `
    <div class="ob-done-mark">a.</div>
    <h1 class="ob-question">You're set.</h1>
    <p class="ob-hint">Accord now fills ${rows.length} field${rows.length === 1 ? '' : 's'} on every form you open through it. Tweak any of these later from your profile.</p>
    <div class="ob-summary">
      ${rows.map(r => `<div class="ob-summary-row"><span class="k">${escHtml(r.k)}</span><span class="v">${escHtml(r.v)}</span></div>`).join('')}
    </div>
    <div class="ob-actions">
      <a class="btn btn-ghost" href="${returnTo === '/profile' ? '/profile' : `/profile?returnTo=${encodeURIComponent(returnTo)}`}">Fine-tune in profile</a>
      <a class="btn btn-primary" id="ob-finish" href="${escHtml(returnTo)}">${goingToForm ? 'Back to the form →' : 'Go to dashboard →'}</a>
    </div>`;
  $('ob-skip-all').hidden = true;
  form.onsubmit = e => e.preventDefault();
}

// ─── Navigation & saving ──────────────────────────────────────────────────
function go(delta) {
  const form = $('ob-step');
  form.classList.add('is-leaving');
  setTimeout(() => {
    form.classList.remove('is-leaving');
    stepIndex = Math.max(0, stepIndex + delta);
    renderStep();
    window.scrollTo({ top: 0 });
  }, 170);
}

async function commitStep() {
  if (saving) return;
  const s = STEPS[stepIndex];
  const input = $('ob-input');
  const value = (input?.value || '').trim();

  if (s.yesNo) {
    const a = answers[s.key];
    if (!a.choice) { toast('Pick Yes or No, or skip'); return; }
    if (a.choice === 'Yes') a.value = value;
    upsertRule(s.yesNo.label, s.yesNo.patterns, a.choice);
    if (a.choice === 'Yes' && value) upsertRule(s.label, s.patterns, value);
  } else {
    if (s.required && !value) { toast('This one we need'); input?.focus(); return; }
    if (s.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { toast('That email looks off'); input?.focus(); return; }
    answers[s.key] = value;
    if (value) upsertRule(s.label, s.patterns, value);
  }

  if (stepIndex === STEPS.length - 1) {
    profile.onboardingStatus = 'done';
    profile.onboardingAt = new Date().toISOString();
  }

  saving = true;
  const btn = $('ob-next');
  btn.disabled = true;
  try {
    await saveProfile(currentUser.uid, profile);
  } catch (e) {
    console.error('[accord/onboarding] save failed', e);
    toast("Couldn't save — check your connection");
    btn.disabled = false;
    saving = false;
    return;
  }
  saving = false;
  go(+1);
}

// Update the rule with this label, or add one. New rules go in *before* the
// seeded Name rule: Name matches "contains Name", so "College Name" must
// reach the College rule first (rules fire in profile order).
function upsertRule(label, patterns, value) {
  const existing = findRule(label);
  if (existing) {
    existing.value = value;
    existing.source = 'value';
    existing.enabled = true;
    return;
  }
  const rule = { id: nanoid(8), label, match: 'contains', patterns, source: 'value', value, enabled: true, firstOnly: true };
  const nameIdx = label === 'Name' ? -1
    : profile.fields.findIndex(f => (f.label || '').toLowerCase() === 'name');
  if (nameIdx >= 0) profile.fields.splice(nameIdx, 0, rule);
  else profile.fields.push(rule);
}

$('ob-skip-all').addEventListener('click', async () => {
  if (profile.onboardingStatus !== 'done') {
    profile.onboardingStatus = 'skipped';
    profile.onboardingAt = new Date().toISOString();
    try { await saveProfile(currentUser.uid, profile); } catch (e) { console.error(e); }
  }
  window.location.href = getReturnTo();
});
