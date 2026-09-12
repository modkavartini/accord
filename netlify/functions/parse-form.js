// Resolve a Google Form (URL or bare form ID) into:
//   { formId, formUrl, formTitle, fields: [{entryId, label}] }
// Lets Accord prefill any form on first visit, no creator setup required.
//
// Forms that require Google sign-in (file-upload questions, "restrict to
// org", verified email collection) return 401 to an anonymous fetch. For
// those we retry with the session cookies of a dedicated Google account —
// the "Accord reader" — stored in ACCORD_GOOGLE_COOKIE (see README §Reader
// account). Google Forms are readable by *any* signed-in account unless the
// owner restricted them to their organisation, so this covers nearly every
// sign-in-walled form without anyone having to teach it via the extension.

const FORMS_HOSTS = new Set(['docs.google.com', 'forms.gle']);
// Common URL shorteners. We follow them server-side, then verify the final
// URL lands on a Google Forms host (mitigates SSRF — shorteners only host
// redirects, and the destination check rejects anything that isn't a form).
const SHORTENER_HOSTS = new Set([
  'bit.ly', 'bitly.com',
  'tinyurl.com', 'tiny.cc',
  't.co',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'is.gd', 'v.gd',
  'shorturl.at',
  'rebrand.ly', 'rb.gy',
  'cutt.ly', 'kutt.it', 'kutti.link',
  's.id', 'short.io',
]);
const ALLOWED_HOSTS = new Set([...FORMS_HOSTS, ...SHORTENER_HOSTS]);
const FORM_ID_RE    = /^[A-Za-z0-9_-]{20,}$/;

// Real Chrome UA — Google serves a stripped/sign-in variant to UAs it
// doesn't recognize as a browser, which breaks FB_PUBLIC_LOAD_DATA_ extraction.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
// Pre-accept Google's cookie consent so the form page isn't replaced by a
// consent.google.com interstitial on cookieless server-side fetches.
const CONSENT_COOKIE = 'CONSENT=YES+; SOCS=CAI';
// Full `Cookie:` header of a browser signed in as the Accord reader account.
// Never logged, never echoed — only ever sent to docs.google.com.
const READER_COOKIE = (process.env.ACCORD_GOOGLE_COOKIE || '').trim();

const SIGNIN_ERROR = 'This form requires Google sign-in';

exports.handler = async (event) => {
  const raw = (event.queryStringParameters?.url || '').trim();
  if (!raw) return json(400, { error: 'Missing url' });

  // Bare form ID → build the canonical viewform URL
  let formUrl = FORM_ID_RE.test(raw)
    ? `https://docs.google.com/forms/d/e/${raw}/viewform`
    : null;

  if (!formUrl) {
    let target;
    try { target = new URL(raw); } catch { return json(400, { error: 'Invalid URL' }); }
    if (!ALLOWED_HOSTS.has(target.hostname)) return json(400, { error: 'Unsupported link — paste a Google Forms URL or a known shortener' });

    formUrl = `${target.origin}${target.pathname}`;
    if (target.hostname === 'docs.google.com') {
      if (!/\/forms\//.test(target.pathname)) return json(400, { error: 'Not a Google Forms URL' });
      formUrl = formUrl.replace(/\/(edit|viewform|formResponse)\/?$/, '') + '/viewform';
    }
  }

  // Pass 1: anonymous. Public forms (the vast majority) resolve here and the
  // reader account's session never touches the request.
  let page = await fetchFormPage(formUrl, CONSENT_COOKIE);
  if (page.error) return json(502, { error: 'Could not reach the form' });
  let requiresSignIn = false;

  if (page.kind === 'signin') {
    requiresSignIn = true;
    // Pass 2: the same URL as the Accord reader account. Google's 401 lands
    // on the canonical form URL (shorteners already followed), so retry
    // that rather than re-walking the redirect chain.
    if (!READER_COOKIE) {
      return signInResponse(page.formUrl, 'none');
    }
    page = await fetchFormPage(page.formUrl || formUrl, `${CONSENT_COOKIE}; ${READER_COOKIE}`);
    if (page.error) return json(502, { error: 'Could not reach the form' });
    // Still bounced to accounts.google.com → the stored session is dead.
    if (page.kind === 'signin') return signInResponse(page.formUrl, 'expired');
  }

  if (page.kind === 'consent') {
    return json(502, { error: 'Google blocked the request with a consent prompt — please retry' });
  }
  if (page.kind === 'http-error') {
    return json(502, { error: `Form fetch failed (${page.status})`, formUrl: page.formUrl });
  }
  if (page.kind === 'not-a-form') {
    return json(400, { error: "That link doesn't point to a Google Form" });
  }

  const { finalUrl, html } = page;
  const formId = extractFormId(finalUrl.pathname);

  const blob = extractFbBlob(html);
  if (!blob) {
    // Page loaded but no form data — distinguish "needs permission" from
    // genuinely-broken parsing so the user knows whether to retry or fix sharing.
    if (looksLikePermissionWall(html)) {
      // Signed in as the reader and *still* walled: the owner restricted the
      // form to their organisation. Nothing server-side can fix that — only
      // a browser that is a member can read it (→ extension).
      return signInResponse(page.formUrl, requiresSignIn ? 'denied' : 'none');
    }
    return json(422, { error: "Couldn't read the form — make sure the link is correct and the form accepts responses", formUrl: page.formUrl });
  }

  let data;
  try { data = JSON.parse(blob); } catch { return json(422, { error: 'Form data unparseable' }); }

  const rawFields = data?.[1]?.[1];
  if (!Array.isArray(rawFields)) return json(422, { error: 'No fields found in form' });

  const fields = questionsToFields(rawFields);

  // Google Forms' "Collect email addresses" toggle adds a special email field
  // that lives outside the normal questions array and uses `emailAddress` as
  // the prefill key (not entry.<number>). Detection across form versions is
  // unreliable, so always include a synthetic field — Google Forms silently
  // ignores `?emailAddress=…` on forms that don't have collection enabled.
  if (!fields.some(f => f.entryId === 'emailAddress')) {
    fields.unshift({ entryId: 'emailAddress', label: 'Email' });
  }

  if (!fields.length) return json(422, { error: 'No prefillable fields detected' });

  return json(200, {
    formId,
    formUrl: page.formUrl,
    formTitle: extractTitle(html, data),
    fields,
    // Tell the gate this schema came through the reader account so it can
    // remember the form is sign-in-walled (the visitor still has to be signed
    // in to Google when they land on it — prefill itself works the same).
    ...(requiresSignIn ? { requiresSignIn: true, readVia: 'reader' } : {}),
  });
};

// Fetch a form page and classify where we ended up. Returns one of
//   { kind: 'ok', finalUrl, html, formUrl }
//   { kind: 'signin' | 'consent' | 'not-a-form' | 'http-error', status, formUrl }
//   { error: true }
async function fetchFormPage(url, cookie) {
  let res, html;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookie,
      },
    });
    html = await res.text();
  } catch {
    return { error: true };
  }

  // After redirects (forms.gle / bit.ly / etc.), check where we ended up.
  // A signed-in fetch may get bounced through /forms/u/<n>/… — strip that
  // so the canonical URL we hand back is account-agnostic.
  const finalUrl = new URL(res.url || url);
  const isForm = FORMS_HOSTS.has(finalUrl.hostname) && /\/forms\//.test(finalUrl.pathname);
  const formUrl = isForm
    ? `${finalUrl.origin}${finalUrl.pathname.replace(/^\/forms\/u\/\d+\//, '/forms/')}`
    : null;
  const base = { status: res.status, formUrl };

  // Google returns 401 with a "request storage access" interstitial for forms
  // that require sign-in; a dead session gets redirected to accounts.google.com.
  if (res.status === 401) return { kind: 'signin', ...base };
  if (finalUrl.hostname === 'accounts.google.com' || /\/ServiceLogin/.test(finalUrl.pathname)) {
    return { kind: 'signin', ...base };
  }
  // Consent interstitial (defensive — should be bypassed by CONSENT_COOKIE).
  if (finalUrl.hostname.includes('consent.google.com')) return { kind: 'consent', ...base };
  if (!res.ok) return { kind: 'http-error', ...base };
  if (!isForm) return { kind: 'not-a-form', ...base };
  return { kind: 'ok', finalUrl, html, ...base };
}

function looksLikePermissionWall(html) {
  const lower = html.toLowerCase();
  return lower.includes('you need permission')
      || lower.includes('request access')
      || lower.includes('sign in to continue')
      || /<title[^>]*>[^<]*sign[- ]in[^<]*<\/title>/i.test(html);
}

// 403 for a form we couldn't read even as the reader account. `reader` tells
// the gate which situation it is so it can show the right fix:
//   none    — no ACCORD_GOOGLE_COOKIE configured on this deploy
//   expired — the reader session was rejected by Google (needs re-copying)
//   denied  — reader is signed in but the form is restricted to an org
function signInResponse(formUrl, reader) {
  const detail = {
    none:    "Accord's reader account isn't set up on this deployment",
    expired: "Accord's reader account session has expired",
    denied:  "it's restricted to an organisation Accord's reader account isn't part of",
  }[reader];
  return json(403, {
    error: `${SIGNIN_ERROR} — ${detail}`,
    formUrl,
    requiresSignIn: true,
    reader,
  });
}

// Google Forms item types (FB_PUBLIC_LOAD_DATA_[1][1][i][3]). Only the
// choice-bearing ones matter to Accord: for those we ship the option texts so
// the gate can pick the right option instead of a free-text value that Google
// would silently drop.
//   0 short answer · 1 paragraph · 2 multiple choice · 3 dropdown ·
//   4 checkboxes · 5 linear scale · 7 grid · 8 section header · 9 date ·
//   10 time · 13 file upload
const CHOICE_TYPES = new Set([2, 3, 4, 5, 7]);
// Types that can't be set through prefill params at all — skipped entirely.
const UNFILLABLE_TYPES = new Set([13]);

// Flatten the per-question arrays into Accord fields. A question can carry
// several entry IDs (grid rows) — each becomes its own field. Shape per
// question: [qid, title, description, type, [[entryId, options, required,
// rowLabels?, …], …], …]; options: [[text, …, isOther], …].
function questionsToFields(rawFields) {
  const fields = [];
  for (const f of rawFields) {
    const label = (f?.[1] || '').toString().trim();
    const type  = typeof f?.[3] === 'number' ? f[3] : null;
    const subs  = f?.[4];
    if (!Array.isArray(subs) || UNFILLABLE_TYPES.has(type)) continue;
    for (const s of subs) {
      const entryNum = s?.[0];
      if (typeof entryNum !== 'number') continue;
      const field = { entryId: `entry.${entryNum}`, label };
      if (type !== null) field.type = type;
      if (CHOICE_TYPES.has(type) && Array.isArray(s[1])) {
        const options = [];
        let hasOther = false;
        for (const o of s[1]) {
          if (!Array.isArray(o)) continue;
          if (o[4]) { hasOther = true; continue; } // "Other…" placeholder row
          const text = (o[0] ?? '').toString();
          if (text !== '') options.push(text);
        }
        field.options = options;
        if (hasOther) field.hasOther = true;
      }
      // Grid rows: s[3] is [rowLabel]; expose it so the gate can show
      // "Question — Row" instead of the same title N times.
      if (type === 7 && Array.isArray(s[3]) && typeof s[3][0] === 'string') {
        field.row = s[3][0];
      }
      fields.push(field);
    }
  }
  return fields;
}

function extractFormId(pathname) {
  const m = pathname.match(/\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractTitle(html, data) {
  // Prefer the array — it has the unaltered form title. Fall back to <title>.
  const fromData = data?.[3] || data?.[1]?.[8];
  if (typeof fromData === 'string' && fromData.trim()) return fromData.trim();

  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (m) return m[1].replace(/\s*-\s*Google Forms\s*$/, '').trim();
  return '';
}

// Walk the HTML to capture the FB_PUBLIC_LOAD_DATA_ array literal by counting
// brackets — far more reliable than regex against deeply nested JSON-ish data.
function extractFbBlob(html) {
  const marker = 'FB_PUBLIC_LOAD_DATA_';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('[', idx);
  if (start === -1) return null;

  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === quote) { inStr = false; quote = ''; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function json(statusCode, body) {
  // Form schemas (fields, formId, title) and sign-in walls change rarely —
  // cache the result at Netlify's edge so repeat visits to /go/<short> or
  // /go/<formId> skip the 500-1500ms Google fetch entirely. Browsers stay
  // on no-store so a user can paste the same link into /fill and see fresh
  // status while the next visitor still gets the warm edge response.
  // Skip caching for 5xx (transient errors) and 502 (rate limits) where
  // we want the next request to retry. Sign-in walls that only exist
  // because the reader account is missing/expired get a short TTL so a
  // fixed ACCORD_GOOGLE_COOKIE takes effect within minutes, not an hour.
  const shortLived = statusCode === 403 && body.reader !== 'denied';
  const cacheable = statusCode === 200 || statusCode === 403 || statusCode === 422;
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': !cacheable ? 'no-store'
        : shortLived ? 'public, max-age=0, s-maxage=120'
        : 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
