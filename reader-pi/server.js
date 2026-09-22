// Accord reader — a persistent, logged-in Chromium on the Pi that reads
// sign-in-walled Google Forms for the Netlify parse-form function.
//
// Why this exists: Google expires a *copied* web session within ~2h and only
// the browser that created it can rotate the gating token. So instead of
// copying cookies to the cloud, we keep one real browser signed in here and
// let it read forms locally — it refreshes its own session like any browser.
//
// Exposed to Netlify over Tailscale Funnel (public HTTPS → 127.0.0.1:PORT).
// Every request must carry `Authorization: Bearer $READER_TOKEN`.
const http = require('http');
const { chromium } = require('playwright-core');

const PORT        = parseInt(process.env.PORT || '8787', 10);
const TOKEN       = (process.env.READER_TOKEN || '').trim();
const PROFILE_DIR = process.env.PROFILE_DIR || `${process.env.HOME}/accord-reader/profile`;
const CHROMIUM    = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
if (!TOKEN) { console.error('READER_TOKEN not set'); process.exit(1); }

// Only Google form hosts — never let this be a general-purpose fetch proxy.
const ALLOWED = new Set(['docs.google.com', 'forms.gle']);
const LOGIN_PROBE = 'https://docs.google.com/forms/u/0/';

let context = null;
let launching = null;
let queue = Promise.resolve();          // serialize page work (bounded memory)

async function getContext() {
  if (context) return context;
  if (!launching) {
    launching = chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,                  // real headed browser (under Xvfb) — most browser-like
      executablePath: CHROMIUM,
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    }).then(ctx => {
      ctx.on('close', () => { context = null; launching = null; });
      context = ctx;
      return ctx;
    }).catch(e => { launching = null; throw e; });
  }
  return launching;
}

// Run fn with a fresh page, serialized. Relaunch the context once if it died.
function withPage(fn) {
  const task = queue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let ctx;
      try { ctx = await getContext(); } catch (e) { if (attempt) throw e; continue; }
      const page = await ctx.newPage().catch(() => null);
      if (!page) { context = null; launching = null; continue; }  // stale ctx → retry
      try { return await fn(page); }
      finally { await page.close().catch(() => {}); }
    }
    throw new Error('browser unavailable');
  });
  // Keep the queue chain alive even if this task rejects.
  queue = task.catch(() => {});
  return task;
}

const isSignInUrl = u => /accounts\.google\.com/.test(u) || /\/ServiceLogin/.test(u);

async function readForm(url) {
  return withPage(async page => {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // A form page hydrates its questions into FB_PUBLIC_LOAD_DATA_; give it a beat.
    await page.waitForFunction(
      () => /FB_PUBLIC_LOAD_DATA_/.test(document.documentElement.innerHTML)
         || location.hostname === 'accounts.google.com',
      null, { timeout: 8000 },
    ).catch(() => {});
    const finalUrl = page.url();
    const html = await page.content();
    return { status: resp ? resp.status() : 0, finalUrl, signedIn: !isSignInUrl(finalUrl), html };
  });
}

// Cheap login check, cached briefly so /health isn't a navigation storm.
let healthCache = { at: 0, signedIn: null };
async function health() {
  if (Date.now() - healthCache.at < 60000 && healthCache.signedIn !== null) return healthCache;
  const r = await withPage(async page => {
    await page.goto(LOGIN_PROBE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return !isSignInUrl(page.url());
  });
  healthCache = { at: Date.now(), signedIn: r };
  return healthCache;
}

// Keep the session warm: a navigation every 10 min so the browser keeps
// rotating its own tokens even when no form is requested.
setInterval(() => { health().then(h => console.log('[reader] keepalive signedIn=' + h.signedIn)).catch(() => {}); }, 10 * 60 * 1000);

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    // Health needs auth too (it navigates the browser), but keep it lenient:
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    health().then(h => send(res, 200, { ok: true, signedIn: h.signedIn, checkedAt: new Date(h.at).toISOString() }))
            .catch(e => send(res, 502, { error: 'browser error', detail: String(e).slice(0, 200) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/read') {
    if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let target;
      try { target = new URL(JSON.parse(raw).url); } catch { return send(res, 400, { error: 'bad url' }); }
      if (!ALLOWED.has(target.hostname)) return send(res, 400, { error: 'host not allowed' });
      readForm(target.toString())
        .then(r => send(res, 200, r))
        .catch(e => send(res, 502, { error: 'read failed', detail: String(e).slice(0, 200) }));
    });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[reader] listening on 127.0.0.1:${PORT}, profile ${PROFILE_DIR}`);
  getContext().then(() => health()).then(h => console.log('[reader] startup signedIn=' + h.signedIn)).catch(e => console.error('[reader] startup', e));
});
