// Resolve a Google Form (URL or bare form ID) into:
//   { formId, formUrl, formTitle, fields: [{entryId, label}] }
// Lets Accord prefill any form on first visit, no creator setup required.

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

  let res, html;
  try {
    res = await fetch(formUrl, {
      redirect: 'follow',
      headers: {
        // Real Chrome UA — Google serves a stripped/sign-in variant to UAs
        // it doesn't recognize as a browser, which breaks FB_PUBLIC_LOAD_DATA_
        // extraction.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        // Pre-accept Google's cookie consent so the form page isn't replaced
        // by a consent.google.com interstitial on cookieless server-side fetches.
        'Cookie': 'CONSENT=YES+; SOCS=CAI',
      },
    });
    if (!res.ok) return json(502, { error: `Form fetch failed (${res.status})` });
    html = await res.text();
  } catch {
    return json(502, { error: 'Could not reach the form' });
  }

  // After redirects (forms.gle / bit.ly / etc.), check where we ended up.
  const finalUrl = new URL(res.url || formUrl);
  // Sign-in-walled forms redirect to accounts.google.com — surface a real reason.
  if (finalUrl.hostname === 'accounts.google.com' || /\/ServiceLogin/.test(finalUrl.pathname)) {
    return json(403, { error: 'This form requires sign-in — Accord can only prefill public forms' });
  }
  // Consent interstitial (defensive — should be bypassed by the cookie above).
  if (finalUrl.hostname.includes('consent.google.com')) {
    return json(502, { error: 'Google blocked the request with a consent prompt — please retry' });
  }
  if (!FORMS_HOSTS.has(finalUrl.hostname) || !/\/forms\//.test(finalUrl.pathname)) {
    return json(400, { error: "That link doesn't point to a Google Form" });
  }
  const formId = extractFormId(finalUrl.pathname);

  const blob = extractFbBlob(html);
  if (!blob) {
    // Page loaded but no form data — distinguish "needs permission" from
    // genuinely-broken parsing so the user knows whether to retry or fix sharing.
    const lower = html.toLowerCase();
    if (lower.includes('you need permission') || lower.includes('request access') || lower.includes('sign in to continue')) {
      return json(403, { error: 'This form requires sign-in or explicit access' });
    }
    return json(422, { error: "Couldn't read the form — make sure the link is correct and the form accepts responses" });
  }

  let data;
  try { data = JSON.parse(blob); } catch { return json(422, { error: 'Form data unparseable' }); }

  const rawFields = data?.[1]?.[1];
  if (!Array.isArray(rawFields)) return json(422, { error: 'No fields found in form' });

  const fields = [];
  for (const f of rawFields) {
    const label = (f?.[1] || '').toString().trim();
    const subs  = f?.[4];
    if (!Array.isArray(subs)) continue;
    for (const s of subs) {
      const entryNum = s?.[0];
      if (typeof entryNum !== 'number') continue;
      fields.push({ entryId: `entry.${entryNum}`, label });
    }
  }

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
    formUrl: `${finalUrl.origin}${finalUrl.pathname}`,
    formTitle: extractTitle(html, data),
    fields,
  });
};

function extractFormId(pathname) {
  const m = pathname.match(/\/forms\/d\/(?:e\/)?([A-Za-z0-9_-]+)/);
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
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
