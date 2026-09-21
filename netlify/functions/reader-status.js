// Health check for the Accord reader account (see parse-form.js and
// lib/reader-session.js). Reports whether a session is configured, where it
// currently lives (the env seed or the rotated copy in the blob store) and
// whether Google still accepts it — so an expired session shows up here, not
// as a wave of "This form requires Google sign-in" complaints.
//
//   GET /.netlify/functions/reader-status
//   → { configured, signedIn: bool | null, session: 'env' | 'blob' | null,
//       sessionUpdatedAt, hint?, checkedAt }
//
// Never echoes the cookie or anything derived from it.

const { loadReaderSession, absorb, loadHealth } = require('./lib/reader-session');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
// Signed out, this 302s to accounts.google.com/ServiceLogin; signed in it
// renders (or redirects within docs.google.com).
const PROBE_URL = 'https://docs.google.com/forms/u/0/';

// docs.google.com has its own session cookie (OSID) on top of the account-wide
// SID/HSID set; a header copied from a google.com request lacks it and Google
// bounces to ServiceLogin?...&osid=1. Report that rather than a bare "signed out".
const hasOsid = c => /(^|;\s*)(__Secure-)?OSID=/.test(c);

exports.handler = async (event) => {
  const session = await loadReaderSession(event);
  const body = {
    configured: session.cookie.length > 0,
    signedIn: null,
    session: session.source === 'none' ? null : session.source,
    sessionUpdatedAt: session.updatedAt,
    keepalive: await loadHealth(event),   // last scheduled run: { at, signedIn, rotated, ... }
    checkedAt: new Date().toISOString(),
  };
  if (body.configured && !hasOsid(session.cookie)) {
    body.hint = 'Cookie has no OSID — copy the cookie header from a docs.google.com request (e.g. a viewform page), not google.com';
  }
  if (body.configured) {
    try {
      const sent = `CONSENT=YES+; SOCS=CAI; ${session.cookie}`;
      const res = await fetch(PROBE_URL, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, 'Cookie': sent },
      });
      const location = res.headers.get('location') || '';
      body.signedIn = !(res.status === 401 || /accounts\.google\.com|\/ServiceLogin/.test(location));
      if (body.signedIn) await absorb(res, sent);
    } catch {
      body.error = 'Could not reach Google';
    }
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
};
