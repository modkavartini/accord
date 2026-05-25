// Two modes share the same content script:
//   A) Fresh form visit (no entry.X params, didn't just come from the gate)
//      → inject an "Auto-fill with Accord" floating button. Clicking it opens
//      the Accord gate in a new tab, which then redirects back to this form
//      URL with entry.X prefill params.
//   B) Return from the gate (entry.X params present) → highlight every
//      question that Accord prefilled and stamp it with an "a." badge.

(() => {
  const ACCORD_HOST = 'accord-ingly.netlify.app';

  // Match both /forms/d/e/<id>/viewform and the multi-account
  // /forms/u/<N>/d/e/<id>/viewform variant. Skip /forms/d/<id>/edit — that's
  // the editor view and the user is the owner, not a fill-target.
  function extractFormId() {
    try {
      const u = new URL(window.location.href);
      if (u.hostname !== 'docs.google.com') return null;
      const m = u.pathname.match(/\/forms\/(?:u\/\d+\/)?d\/e\/([A-Za-z0-9_-]+)\/viewform/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // Any entry.<digits> param means we just arrived from Accord (or the user
  // pasted a prefill link by hand). Either way: skip the redirect, jump
  // straight to highlighting.
  function getPrefillEntries() {
    const sp = new URLSearchParams(window.location.search);
    const entries = [];
    for (const [k, v] of sp) {
      if (/^entry\.\d+$/.test(k) && v) entries.push(k);
    }
    return entries;
  }

  // The gate redirects via window.location.href = formUrl, which sets the
  // Referer to accord-ingly.netlify.app. We bail in this case so we don't
  // re-launch the gate even when no entry.X params landed — e.g., when the
  // visitor's profile rules didn't match any of the form's question labels,
  // or when they toggled every field off in the gate's preview. Without
  // this, the form → gate → form → gate loop kicks in.
  function cameFromGate() {
    try {
      const ref = document.referrer;
      if (!ref) return false;
      const u = new URL(ref);
      return u.hostname === ACCORD_HOST;
    } catch { return false; }
  }

  // ─── Toast ──────────────────────────────────────────────────────────────
  function showToast(message) {
    const t = document.createElement('div');
    t.className = 'accord-toast';
    t.innerHTML = `
      <div class="accord-toast-logo">a.</div>
      <div class="accord-toast-text"></div>
    `;
    t.querySelector('.accord-toast-text').textContent = message;
    document.body.appendChild(t);
    return t;
  }

  function dismissToast(toast, afterMs = 1800) {
    setTimeout(() => {
      toast.classList.add('accord-toast-leave');
      setTimeout(() => toast.remove(), 280);
    }, afterMs);
  }

  // ─── Mode A: inject the auto-fill button ───────────────────────────────
  function launchGate(formId) {
    chrome.runtime.sendMessage({ type: 'accord:open-gate', formId }, (res) => {
      if (!res?.ok) console.warn('[accord-ext] open-gate failed', res);
    });
  }

  function injectButton(formId) {
    if (document.getElementById('accord-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'accord-fab';
    btn.className = 'accord-fab';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Auto-fill with Accord');
    btn.innerHTML = `
      <span class="accord-fab-logo">a.</span>
      <span class="accord-fab-text">Auto-fill with Accord</span>
    `;
    btn.addEventListener('click', () => {
      btn.classList.add('is-loading');
      btn.disabled = true;
      const textEl = btn.querySelector('.accord-fab-text');
      textEl.textContent = 'Opening Accord ↗';
      launchGate(formId);
      // Re-enable after a beat so the visitor can re-click if they closed
      // the gate tab without finishing. The new tab keeps running independently.
      setTimeout(() => {
        btn.classList.remove('is-loading');
        btn.disabled = false;
        textEl.textContent = 'Auto-fill with Accord';
      }, 2500);
    });
    document.body.appendChild(btn);
  }

  function runLaunchMode(formId) {
    // If we just came back from the gate but no entry.X params landed (no
    // matching profile rules, all fields toggled off in the preview, etc.),
    // re-showing the button would invite the user into a loop. Skip.
    if (cameFromGate()) return;
    injectButton(formId);
  }

  // ─── Mode B: highlight prefilled fields ────────────────────────────────
  // Google Forms wraps each question in a div[role="listitem"]. Inputs carry
  // name="entry.<id>" (or name^="entry.<id>" for date sub-fields like
  // entry.X_year / entry.X_month / entry.X_day). We walk up from any input
  // matching one of the URL's entry params to its listitem, then stamp it.
  function highlight(entryIds) {
    let newlyMarked = 0;
    const seen = new Set();
    for (const entryId of entryIds) {
      const safeName = entryId.replace(/"/g, '\\"');
      // entry.<id> matches the input directly; entry.<id>_ catches date sub-inputs.
      const nodes = document.querySelectorAll(
        `[name="${safeName}"], [name^="${safeName}_"]`,
      );
      for (const node of nodes) {
        const container = node.closest('[role="listitem"]');
        if (!container || seen.has(container)) continue;
        seen.add(container);
        if (container.classList.contains('accord-filled')) continue;
        container.classList.add('accord-filled');
        const badge = document.createElement('div');
        badge.className = 'accord-badge';
        badge.title = 'Auto-filled by Accord';
        badge.textContent = 'a.';
        container.appendChild(badge);
        newlyMarked++;
      }
    }
    return newlyMarked;
  }

  function runHighlightMode(entryIds) {
    // Show a quieter toast confirming Accord did its thing.
    const toast = showToast(`Accord auto-filled ${entryIds.length} field${entryIds.length === 1 ? '' : 's'}`);
    dismissToast(toast, 2400);

    // Google Forms hydrates lazily — the listitems are sometimes not in the
    // DOM at document_idle. Highlight what we can now and keep watching for
    // 15s to catch late-mounted questions. Stop early once every entry id
    // has been claimed (no more work to do).
    const tagged = new Set();
    const tryRun = () => {
      const marked = highlight(entryIds);
      if (marked > 0) {
        // Re-query to update tagged set; cheap because the count is small.
        for (const id of entryIds) {
          const safe = id.replace(/"/g, '\\"');
          const found = document.querySelector(`[name="${safe}"], [name^="${safe}_"]`);
          if (found?.closest('[role="listitem"]')?.classList.contains('accord-filled')) {
            tagged.add(id);
          }
        }
      }
      return tagged.size === entryIds.length;
    };

    if (tryRun()) return;

    const obs = new MutationObserver(() => { if (tryRun()) obs.disconnect(); });
    obs.observe(document.body, { subtree: true, childList: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  // ─── Entry point ───────────────────────────────────────────────────────
  function init() {
    const formId = extractFormId();
    if (!formId) return;
    const prefill = getPrefillEntries();
    if (prefill.length) {
      runHighlightMode(prefill);
      return;
    }
    // Referrer-based loop break: the gate sent us here even though no
    // entry.X params survived (no matching profile rules, all toggled off,
    // etc.). Leave the form alone — re-opening the gate would just loop.
    if (cameFromGate()) return;
    runLaunchMode(formId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
