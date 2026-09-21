import { extractFormId, isFormIdShape } from './firebase.js';

const $ = id => document.getElementById(id);

// ─── Preloader ────────────────────────────────────────────────────────────
function hidePreloader() {
  const p = $('preloader');
  if (!p) return;
  p.classList.add('done');
  setTimeout(() => p.remove(), 400);
}
hidePreloader();

// ─── Cycling placeholder ──────────────────────────────────────────────────
// Rolls through the shapes of link that all work — full form URL, forms.gle,
// common shorteners, a bare form ID — so nobody wonders whether theirs will.
const PLACEHOLDERS = [
  'https://docs.google.com/forms/d/e/1FAIpQLSe…/viewform',
  'https://forms.gle/R6faU74qPRPAzchZ9',
  'https://bit.ly/ieee-art-challenge',
  'https://tinyurl.com/tech-fest-2026',
  '1FAIpQLSeOTqizH7yk-wtoI_LUe43gR5gqVzJCXR4ap4tBydpCpQZTkw',
  'https://t.co/k9x2Qf3Lm',
];
(function cyclePlaceholder() {
  const input = $('fill-form-url');
  const ph = $('fill-ph'), text = $('fill-ph-text');
  if (!input || !ph || !text) return;
  let i = 0;
  text.textContent = PLACEHOLDERS[0];
  const sync = () => ph.classList.toggle('hidden', input.value.length > 0);
  input.addEventListener('input', sync);
  sync();
  setInterval(() => {
    if (input.value) return;                 // nothing to show while they type
    if (document.hidden) return;             // don't churn in a background tab
    i = (i + 1) % PLACEHOLDERS.length;
    text.classList.add('is-out');
    setTimeout(() => {
      text.textContent = PLACEHOLDERS[i];
      text.classList.remove('is-out');
      text.classList.add('is-in');
      // Next frame: let the "in" start position paint, then release to 0.
      requestAnimationFrame(() => requestAnimationFrame(() => text.classList.remove('is-in')));
    }, 280);
  }, 2600);
})();

// ─── Toast ────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ─── Status helpers ───────────────────────────────────────────────────────
function setStatus(kind, msg) {
  const el = $('fill-status');
  el.classList.remove('hidden', 'is-error', 'is-ok');
  if (kind === 'error') el.classList.add('is-error');
  if (kind === 'ok')    el.classList.add('is-ok');
  el.innerHTML = kind === 'loading'
    ? `<span class="spinner"></span><span>${msg}</span>`
    : msg;
}
function clearStatus() {
  $('fill-status').classList.add('hidden');
  $('fill-status').textContent = '';
}

// ─── Result rendering ─────────────────────────────────────────────────────
function showResult(formId, { requiresSignIn = false } = {}) {
  const link = `accord-ingly.netlify.app/go/${formId}`;
  const href = `https://${link}`;
  $('fill-result-link').textContent = link;
  $('fill-open-btn').href = href;
  $('fill-contrib-note').classList.toggle('hidden', !requiresSignIn);
  $('fill-result').classList.remove('hidden');
}
function hideResult() {
  $('fill-result').classList.add('hidden');
}

// ─── Resolve a pasted URL → form ID ───────────────────────────────────────
let lastInput = '';
let inflight  = 0;

async function resolve(raw) {
  raw = raw.trim();
  // Invalidate any in-flight fetch when the input is cleared so its response
  // can't repopulate the result card after the user has emptied the field.
  if (!raw) { hideResult(); clearStatus(); lastInput = ''; inflight++; return; }
  if (raw === lastInput) return;
  lastInput = raw;
  // Increment AFTER the dedupe — otherwise paste+input duplicate firings
  // bump inflight without starting a fetch, and the only real fetch's
  // response gets thrown away as "stale", leaving the spinner forever.
  const id = ++inflight;

  // Direct shortcut: a bare form ID pasted in.
  if (isFormIdShape(raw)) {
    setStatus('ok', 'Link ready');
    showResult(raw);
    return;
  }

  // Try to parse it as a URL.
  let url;
  try { url = new URL(raw); }
  catch { setStatus('error', "That doesn't look like a URL"); hideResult(); return; }

  // docs.google.com → can extract the form ID locally without a network call.
  if (url.hostname === 'docs.google.com') {
    const direct = extractFormId(raw);
    if (direct) {
      setStatus('ok', 'Link ready');
      showResult(direct);
      return;
    }
    setStatus('error', "Couldn't find a form ID in that URL");
    hideResult();
    return;
  }

  // forms.gle or a URL shortener (bit.ly, tinyurl, etc.) — let the server
  // follow redirects and verify the destination is a Google Form.
  setStatus('loading', 'Resolving link…');
  let res, payload = {};
  try {
    res = await fetch(`/.netlify/functions/parse-form?url=${encodeURIComponent(raw)}`);
    payload = await res.json().catch(() => ({}));
  } catch {
    setStatus('error', 'Network error — please try again');
    hideResult();
    return;
  }
  if (id !== inflight) return; // stale response

  // Sign-in-walled forms (file uploads, restricted audiences, etc.) come
  // back as 403 with requiresSignIn=true + the canonical formUrl. The link
  // still works: the first visitor who opens the form through the Accord
  // browser extension teaches Accord its questions, and every visitor after
  // that gets auto-fill. Treat it as a soft-success with a note.
  if (payload.requiresSignIn && payload.formUrl) {
    const fid = extractFormId(payload.formUrl);
    if (fid) {
      setStatus('ok', 'Link ready — this form needs the browser extension once (see note below)');
      showResult(fid, { requiresSignIn: true });
      return;
    }
  }

  if (!res.ok || !payload.formId) {
    setStatus('error', payload.error || "Couldn't resolve that link");
    hideResult();
    return;
  }
  setStatus('ok', `Resolved — ${payload.formTitle || 'form ready'}`);
  showResult(payload.formId);
}

// ─── Wire up ──────────────────────────────────────────────────────────────
const input = $('fill-form-url');
input.addEventListener('paste',  () => setTimeout(() => resolve(input.value), 0));
input.addEventListener('input',  () => resolve(input.value));
input.addEventListener('blur',   () => resolve(input.value));

$('fill-copy-btn').addEventListener('click', async () => {
  const link = $('fill-result-link').textContent;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(`https://${link}`);
    toast('Link copied to clipboard');
  } catch {
    toast("Couldn't copy — select and copy manually");
  }
});
