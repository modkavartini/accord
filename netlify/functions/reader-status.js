// Health check for the Accord reader (the persistent signed-in Chromium on the
// Pi, reached over Tailscale Funnel — see lib/reader-remote and the reader
// service). Surfaces whether it's configured and whether it's still signed in,
// so an expired/offline reader shows up here rather than as a wave of
// "This form requires Google sign-in" reports.
//
//   GET /.netlify/functions/reader-status
//   → { configured, signedIn: bool | null, checkedAt, error? }
const { readerHealth } = require('./lib/reader-remote');

exports.handler = async () => {
  const h = await readerHealth();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...h, checkedAt: h.checkedAt || new Date().toISOString() }),
  };
};
