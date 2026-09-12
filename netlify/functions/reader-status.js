// Health check for the Accord reader account (see parse-form.js). Reports
// whether ACCORD_GOOGLE_COOKIE is set on this deploy and whether Google still
// accepts that session — so an expired cookie shows up here, not as a wave
// of "This form requires Google sign-in" complaints.
//
//   GET /.netlify/functions/reader-status
//   → { configured: bool, signedIn: bool | null, checkedAt }
//
// Never echoes the cookie or anything derived from it.

const READER_COOKIE = (process.env.ACCORD_GOOGLE_COOKIE || '').trim();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
// Signed out, this 302s to accounts.google.com/ServiceLogin; signed in it
// renders (or redirects within docs.google.com).
const PROBE_URL = 'https://docs.google.com/forms/u/0/';

// docs.google.com has its own session cookie (OSID) on top of the account-wide
// SID/HSID set; a header copied from a google.com request lacks it and Google
// bounces to ServiceLogin?...&osid=1. Report that rather than a bare "signed out".
const hasOsid = /(^|;\s*)(__Secure-)?OSID=/.test(READER_COOKIE);

exports.handler = async () => {
  const body = { configured: READER_COOKIE.length > 0, signedIn: null, checkedAt: new Date().toISOString() };
  if (body.configured && !hasOsid) {
    body.hint = 'Cookie has no OSID — copy the cookie header from a docs.google.com request (e.g. a viewform page), not google.com';
  }
  if (body.configured) {
    try {
      const res = await fetch(PROBE_URL, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, 'Cookie': `CONSENT=YES+; SOCS=CAI; ${READER_COOKIE}` },
      });
      const location = res.headers.get('location') || '';
      body.signedIn = !(res.status === 401 || /accounts\.google\.com|\/ServiceLogin/.test(location));
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
