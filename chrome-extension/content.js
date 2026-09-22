// Two modes share the same content script:
//   A) Fresh form visit (no entry.X params, didn't just come from the gate)
//      → inject an "Auto-fill with Accord" floating button. Clicking it reads
//      the form's question schema straight out of this page (we're running
//      in the visitor's signed-in Google session, so this works even for
//      forms Accord's server can't fetch — file uploads, restricted
//      audiences) and opens the Accord gate in a new tab with that schema
//      in the URL hash. The gate then redirects back to this form URL with
//      entry.X prefill params, and caches the schema so every later visitor
//      (any device, no extension) gets auto-fill too.
//   B) Return from the gate (entry.X params present) → highlight every
//      question that Accord prefilled and stamp it with an "a." badge.

(() => {
  // Flip to true when debugging; ships false so a normal Google Form visit
  // doesn't spam the page console. All internal logging goes through log()/warn().
  const DEBUG = false;
  const log  = DEBUG ? console.log.bind(console)  : () => {};
  const warn = DEBUG ? console.warn.bind(console) : () => {};

  log('[accord-ext] content script loaded', {
    url: window.location.href,
    referrer: document.referrer,
    readyState: document.readyState,
  });

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
  //
  // Catch: desktop Google Forms APPLIES the prefill params and then strips them
  // from the visible URL (history.replaceState) while its bundle boots — so by
  // document_idle window.location.search is already clean and we'd wrongly
  // conclude nothing was prefilled. We run at document_start (see manifest) and
  // snapshot the params the instant this script executes, before Google's page
  // JS runs. (Android Chrome doesn't strip them, but the snapshot works there
  // too.)
  function readPrefillEntries(search) {
    const sp = new URLSearchParams(search);
    // Set: checkbox questions repeat the key once per selected option.
    const entries = new Set();
    for (const [k, v] of sp) {
      if (/^entry\.\d+$/.test(k) && v) entries.add(k);
    }
    return Array.from(entries);
  }
  const INITIAL_PREFILL_ENTRIES = readPrefillEntries(window.location.search);

  // Prefer the snapshot; only fall back to the live URL if the snapshot is
  // empty (e.g. a soft navigation landed on a freshly prefilled URL post-load).
  function getPrefillEntries() {
    return INITIAL_PREFILL_ENTRIES.length
      ? INITIAL_PREFILL_ENTRIES
      : readPrefillEntries(window.location.search);
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

  // ─── Form schema extraction ─────────────────────────────────────────────
  // Google Forms embeds the whole form definition in an inline script as
  // `var FB_PUBLIC_LOAD_DATA_ = [...]`. Questions live at data[1][1]; each is
  // [qid, title, description, type, [[entryId, options, required, rows?…]…]…]
  // and options are [[text, …, isOther]…]. Same layout Accord's server
  // parser reads (netlify/functions/parse-form.js) — keep the two in sync.
  const CHOICE_TYPES = new Set([2, 3, 4, 5, 7]); // mc, dropdown, checkbox, scale, grid

  function extractFbBlob(text) {
    const idx = text.indexOf('FB_PUBLIC_LOAD_DATA_');
    if (idx === -1) return null;
    const start = text.indexOf('[', idx);
    if (start === -1) return null;
    let depth = 0, inStr = false, quote = '', esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') { esc = true; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === '[') depth++;
      else if (c === ']' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  function questionToFields(q) {
    const out = [];
    if (!Array.isArray(q)) return out;
    const label = (q[1] || '').toString().trim();
    const type  = typeof q[3] === 'number' ? q[3] : null;
    const subs  = q[4];
    if (!Array.isArray(subs)) return out;
    for (const s of subs) {
      if (typeof s?.[0] !== 'number') continue;
      const field = { entryId: `entry.${s[0]}`, label };
      if (type !== null) field.type = type;
      if (CHOICE_TYPES.has(type) && Array.isArray(s[1])) {
        const options = [];
        let hasOther = false;
        for (const o of s[1]) {
          if (!Array.isArray(o)) continue;
          if (o[4]) { hasOther = true; continue; }
          const text = (o[0] ?? '').toString();
          if (text !== '') options.push(text);
        }
        field.options = options;
        if (hasOther) field.hasOther = true;
      }
      if (type === 7 && Array.isArray(s[3]) && typeof s[3][0] === 'string') field.row = s[3][0];
      out.push(field);
    }
    return out;
  }

  // Primary: the inline script (has every section's questions). Fallback:
  // data-params attributes on rendered questions (current section only).
  function extractSchema(formId) {
    let fields = [], title = '';
    for (const script of document.scripts) {
      if (script.src || !script.textContent.includes('FB_PUBLIC_LOAD_DATA_')) continue;
      const blob = extractFbBlob(script.textContent);
      if (!blob) continue;
      let data;
      try { data = JSON.parse(blob); } catch { continue; }
      const questions = data?.[1]?.[1];
      if (!Array.isArray(questions)) continue;
      fields = questions.flatMap(questionToFields);
      title = (typeof data[3] === 'string' && data[3]) || (typeof data?.[1]?.[8] === 'string' && data[1][8]) || '';
      break;
    }
    if (!fields.length) {
      const seen = new Set();
      for (const el of document.querySelectorAll('[data-params]')) {
        let arr;
        try { arr = JSON.parse('[' + el.getAttribute('data-params').replace(/^%\.@\./, '')); } catch { continue; }
        for (const f of questionToFields(arr?.[0])) {
          if (seen.has(f.entryId)) continue;
          seen.add(f.entryId);
          fields.push(f);
        }
      }
    }
    if (!title) title = document.title.replace(/\s*-\s*Google Forms\s*$/, '').trim();
    if (!fields.length) return null;
    return {
      v: 1,
      formId,
      formUrl: `https://docs.google.com/forms/d/e/${formId}/viewform`,
      title,
      fields,
    };
  }

  // base64url of UTF-8 JSON — safe inside a URL fragment.
  function encodeSchema(schema) {
    const json = JSON.stringify(schema);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ─── Mode A: inject the auto-fill button ───────────────────────────────
  function launchGate(formId) {
    let schema = null;
    try { schema = extractSchema(formId); } catch (e) { warn('[accord-ext] schema read failed', e); }
    log('[accord-ext] launching gate', { formId, fields: schema?.fields?.length ?? 0 });
    chrome.runtime.sendMessage({
      type: 'accord:open-gate',
      formId,
      schema: schema ? encodeSchema(schema) : null,
    }, (res) => {
      if (!res?.ok) warn('[accord-ext] open-gate failed', res);
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

  // A /forms/d/e/<id>/viewform URL isn't always a form: Google serves the same
  // path shape for "you need permission", "form not accepting responses", and
  // Drive's TOS-violation error page. Those have neither the FB_PUBLIC_LOAD_DATA_
  // inline blob nor rendered questions. Gate the button on real form content so
  // it never appears on a dead/blocked page (where it'd do nothing useful).
  function hasFormContent() {
    for (const s of document.scripts) {
      if (!s.src && s.textContent && s.textContent.includes('FB_PUBLIC_LOAD_DATA_')) return true;
    }
    return !!document.querySelector('[role="listitem"], [data-params]');
  }

  function runLaunchMode(formId) {
    // If we just came back from the gate but no entry.X params landed (no
    // matching profile rules, all fields toggled off in the preview, etc.),
    // re-showing the button would invite the user into a loop. Skip.
    if (cameFromGate()) return;
    if (hasFormContent()) { injectButton(formId); return; }
    // Real forms embed FB_PUBLIC_LOAD_DATA_ in the initial HTML, so the check
    // above usually passes immediately. Watch briefly in case content mounts
    // late; if nothing form-like appears, this isn't a form — no button.
    const obs = new MutationObserver(() => {
      if (hasFormContent()) { obs.disconnect(); injectButton(formId); }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true });
    setTimeout(() => obs.disconnect(), 4000);
  }

  // ─── Mode B: highlight prefilled fields ────────────────────────────────
  // Each Google Forms question carries a data-params attribute encoding its
  // entry IDs in the same %.@.[...] format Accord's contributor parser reads
  // from the form HTML. This is the most reliable mapping: it works for every
  // question type (text, radio, checkbox, date, scale) regardless of whether
  // the visible <input> exposes a name="entry.X" attribute. We fall back to
  // [name="entry.X"] for layouts where the data-params trick misses.
  function parseEntryIdsFromDataParams(raw) {
    if (!raw) return [];
    // Strip Google's "%.@." sentinel; re-add the leading "[" that they trim.
    const payload = '[' + raw.replace(/^%\.@\./, '');
    let arr;
    try { arr = JSON.parse(payload); } catch { return []; }
    if (!Array.isArray(arr) || !Array.isArray(arr[0]) || arr[0].length < 5) return [];
    const subs = arr[0][4];
    if (!Array.isArray(subs)) return [];
    const ids = [];
    for (const s of subs) {
      const n = s?.[0];
      if (typeof n === 'number') ids.push(`entry.${n}`);
    }
    return ids;
  }

  // Walk to the nearest sensible "whole question" container. Prefer the ARIA
  // listitem; fall back to any data-params ancestor, then the element itself
  // — defensive in case Google's DOM changes.
  function findQuestionContainer(el) {
    return el.closest('[role="listitem"]')
        || el.closest('[data-params]')
        || el;
  }

  function markContainer(container) {
    if (!container) return false;
    container.classList.add('accord-filled');
    let added = false;
    // Real DOM overlay (not a ::after pseudo) — pseudo-elements on listitems
    // can be overridden by Google's own ::after rules. A real child div with
    // !important styles is harder to dislodge.
    if (!container.querySelector(':scope > .accord-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'accord-overlay';
      container.appendChild(overlay);
      added = true;
    }
    if (!container.querySelector(':scope > .accord-badge')) {
      const badge = document.createElement('div');
      badge.className = 'accord-badge';
      badge.title = 'Auto-filled by Accord';
      badge.textContent = 'a.';
      container.appendChild(badge);
      added = true;
    }
    return added;
  }

  function highlight(entryIds) {
    const wanted = new Set(entryIds);
    let marked = 0;

    // Primary: data-params on questions (or their descendants).
    for (const el of document.querySelectorAll('[data-params]')) {
      const ids = parseEntryIdsFromDataParams(el.getAttribute('data-params'));
      if (!ids.some(id => wanted.has(id))) continue;
      const container = findQuestionContainer(el);
      const wasNew = markContainer(container);
      if (wasNew) {
        marked++;
        log('[accord-ext] marked via data-params:', {
          entryIds: ids,
          containerClass: container.className,
          role: container.getAttribute('role'),
          hasOverlay: !!container.querySelector(':scope > .accord-overlay'),
          hasBadge: !!container.querySelector(':scope > .accord-badge'),
        });
      }
    }

    // Fallback: input name attribute. Catches the rare layout where a
    // question div is present but its data-params didn't parse cleanly.
    for (const entryId of entryIds) {
      const safe = entryId.replace(/"/g, '\\"');
      const nodes = document.querySelectorAll(
        `[name="${safe}"], [name^="${safe}_"]`,
      );
      for (const node of nodes) {
        const container = findQuestionContainer(node);
        if (markContainer(container)) {
          marked++;
          log('[accord-ext] marked via name attr:', entryId, container.className);
        }
      }
    }
    return marked;
  }

  // Re-derive how many of the wanted entry IDs have already been claimed by
  // a marked container. Used to short-circuit the MutationObserver — when
  // every wanted ID has its question highlighted, we're done.
  function countTagged(entryIds) {
    const wanted = new Set(entryIds);
    const tagged = new Set();
    for (const el of document.querySelectorAll('[data-params]')) {
      const ids = parseEntryIdsFromDataParams(el.getAttribute('data-params'));
      const hit = ids.find(id => wanted.has(id));
      if (!hit) continue;
      const container = findQuestionContainer(el);
      if (container.classList.contains('accord-filled')) tagged.add(hit);
    }
    return tagged.size;
  }

  // Remember which form URLs we've already toasted so re-runs (bfcache
  // restores, soft navigations) re-apply highlights silently instead of
  // popping the "Accord auto-filled N fields" toast every time.
  const toastedUrls = new Set();

  function runHighlightMode(entryIds) {
    const dataParamsEls = document.querySelectorAll('[data-params]');
    const allEntryIdsInDom = new Set();
    for (const el of dataParamsEls) {
      parseEntryIdsFromDataParams(el.getAttribute('data-params')).forEach(id => allEntryIdsInDom.add(id));
    }
    const missingInDom = entryIds.filter(id => !allEntryIdsInDom.has(id));
    log('[accord-ext] highlight mode', {
      url: window.location.href,
      urlEntryIds: entryIds,
      domEntryIds: Array.from(allEntryIdsInDom),
      urlIdsMissingFromDom: missingInDom,
      listItems: document.querySelectorAll('[role="listitem"]').length,
      dataParamsEls: dataParamsEls.length,
    });
    if (missingInDom.length === entryIds.length && dataParamsEls.length > 0) {
      warn('[accord-ext] NONE of the URL entry IDs match any data-params in the DOM. The URL was prefilled but the form\'s questions use different entry IDs — check if the gate sent the right entries.');
    }

    if (!toastedUrls.has(window.location.href)) {
      toastedUrls.add(window.location.href);
      const toast = showToast(`Accord auto-filled ${entryIds.length} field${entryIds.length === 1 ? '' : 's'}`);
      dismissToast(toast, 2400);
    }

    // Google Forms hydrates lazily — questions are sometimes not in the DOM
    // at document_idle, especially on sign-in-walled forms. Highlight what we
    // can now and keep watching for 30s to catch late-mounted questions.
    const tick = () => {
      highlight(entryIds);
      return countTagged(entryIds) >= entryIds.length;
    };

    if (tick()) return;

    const obs = new MutationObserver(() => { if (tick()) obs.disconnect(); });
    obs.observe(document.body, { subtree: true, childList: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  // ─── Entry point ───────────────────────────────────────────────────────
  function init() {
    const formId = extractFormId();
    const prefill = getPrefillEntries();
    const fromGate = cameFromGate();
    log('[accord-ext] init', { formId, prefill, fromGate, url: window.location.href });
    if (!formId) {
      log('[accord-ext] no formId → bail (URL not a /viewform path)');
      return;
    }
    if (prefill.length) {
      runHighlightMode(prefill);
      return;
    }
    if (fromGate) {
      log('[accord-ext] came from gate with no prefill → bail (loop guard)');
      return;
    }
    runLaunchMode(formId);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ─── Re-run triggers ────────────────────────────────────────────────────
  // The content script is only injected once per document, so init() fires a
  // single time on the initial load. But a form is commonly auto-filled more
  // than once: the visitor goes back through the Accord gate, or hits "Submit
  // another response", or simply navigates Back to the form. In those cases the
  // browser usually restores the page from the back/forward cache (no fresh
  // injection, no DOMContentLoaded) and Google Forms re-renders its question
  // DOM as the visitor interacts — stripping the overlay/badge children we
  // appended. Without re-running, the yellow highlights and "a." badge only
  // ever appear the first time. So we re-run init on the events that signal the
  // page is being shown again or that the URL changed under us.

  let lastUrl = window.location.href;

  function reinit() {
    // A different form URL means a different question set — let the new run's
    // toast fire by not pre-seeding toastedUrls.
    lastUrl = window.location.href;
    init();
  }

  // bfcache restore (Back button, gate re-redirect to a cached form URL).
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) reinit();
  });

  // Soft navigations: Google Forms uses the History API for some in-page
  // transitions, which don't reload the document. Patch push/replaceState and
  // listen for popstate, then re-run if the URL actually changed.
  function onUrlMaybeChanged() {
    if (window.location.href !== lastUrl) reinit();
  }
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) {
      const ret = orig.apply(this, args);
      onUrlMaybeChanged();
      return ret;
    };
  }
  window.addEventListener('popstate', onUrlMaybeChanged);
})();
