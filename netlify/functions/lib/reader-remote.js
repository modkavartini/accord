// Client for the Accord reader running on the Pi (see the reader service).
// A persistent, logged-in Chromium there reads sign-in-walled Google Forms —
// the reliable replacement for copying Google cookies to the cloud, which
// Google expires within hours. Reached over Tailscale Funnel; every call
// carries the shared bearer token.
const ENDPOINT = (process.env.READER_ENDPOINT || '').replace(/\/+$/, '');
const TOKEN    = (process.env.READER_TOKEN || '').trim();

const configured = () => !!(ENDPOINT && TOKEN);

async function readViaPi(url) {
  if (!configured()) return { configured: false };
  try {
    const res = await fetch(`${ENDPOINT}/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) return { configured: true, ok: false, status: res.status };
    const d = await res.json();
    return { configured: true, ok: true, signedIn: d.signedIn, status: d.status, finalUrl: d.finalUrl, html: d.html };
  } catch (e) {
    return { configured: true, ok: false, error: String(e).slice(0, 120) };
  }
}

async function readerHealth() {
  if (!configured()) return { configured: false, signedIn: null };
  try {
    const res = await fetch(`${ENDPOINT}/health`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { configured: true, signedIn: null, error: `status ${res.status}` };
    const d = await res.json();
    return { configured: true, signedIn: !!d.signedIn, checkedAt: d.checkedAt };
  } catch (e) {
    return { configured: true, signedIn: null, error: String(e).slice(0, 120) };
  }
}

module.exports = { readViaPi, readerHealth, configured };
