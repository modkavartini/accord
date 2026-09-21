// Scheduled keep-alive for the reader account session (see lib/reader-session).
// A browser keeps a Google session healthy simply by making requests and
// storing the rotated cookies Google sends back; this does the same every
// 30 minutes so the session doesn't go stale between walled-form visits.
// Netlify runs scheduled functions on production deploys only.

const { schedule } = require('@netlify/functions');
const { loadReaderSession, absorb, rotateSession, recordHealth } = require('./lib/reader-session');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const PROBE_URL = 'https://docs.google.com/forms/u/0/';

const handler = async (event) => {
  const session = await loadReaderSession(event);
  if (!session.cookie) {
    console.log('[reader-keepalive] no reader cookie configured');
    return { statusCode: 200 };
  }
  const sent = `CONSENT=YES+; SOCS=CAI; ${session.cookie}`;
  let res;
  try {
    res = await fetch(PROBE_URL, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT, 'Cookie': sent } });
  } catch (e) {
    console.warn('[reader-keepalive] fetch failed:', e.message);
    return { statusCode: 200 };
  }
  const location = res.headers.get('location') || '';
  const signedIn = !(res.status === 401 || /accounts\.google\.com|\/ServiceLogin/.test(location));
  let rotated = false, rotateStatus = null;
  if (signedIn) {
    const merged = await absorb(res, sent);
    // Refresh the session tokens the way the browser would (see lib).
    try {
      const r = await rotateSession(merged);
      rotated = r.rotated; rotateStatus = r.status;
    } catch (e) {
      console.warn('[reader-keepalive] RotateCookies failed:', e.message);
    }
    console.log(`[reader-keepalive] ok (${session.source}${rotated ? ', tokens rotated' : ''}; RotateCookies ${rotateStatus})`);
  } else {
    console.warn(`[reader-keepalive] session rejected (${res.status}) — re-copy the reader cookie`);
  }
  await recordHealth(event, { signedIn, probeStatus: res.status, rotated, rotateStatus, source: session.source });
  return { statusCode: 200 };
};

exports.handler = schedule('*/30 * * * *', handler);
