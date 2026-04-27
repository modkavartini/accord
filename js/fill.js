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
function showResult(formId) {
  const link = `accord-ingly.netlify.app/go/${formId}`;
  const href = `https://${link}`;
  $('fill-result-link').textContent = link;
  $('fill-open-btn').href = href;
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
