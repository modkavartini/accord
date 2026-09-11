// Content scripts can't reliably call window.open across the popup blocker,
// so the gate-launch from the floating button flows through here as a
// chrome.tabs.create. The content script also hands over the form's schema
// (base64url JSON, read from the signed-in page) which rides along in the
// URL hash — fragments never leave the browser, so nothing is sent to the
// server until the gate itself decides to cache it.

const ACCORD_BASE = 'https://accord-ingly.netlify.app';
// Generous: a 100-question form is ~30KB; Chrome's URL ceiling is 2MB.
const MAX_SCHEMA_CHARS = 1_000_000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'accord:open-gate') return;
  const formId = msg.formId;
  if (typeof formId !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(formId)) {
    sendResponse({ ok: false, error: 'invalid formId' });
    return false;
  }
  let url = `${ACCORD_BASE}/go/${formId}`;
  const schema = msg.schema;
  if (typeof schema === 'string' && schema.length && schema.length <= MAX_SCHEMA_CHARS
      && /^[A-Za-z0-9_-]+$/.test(schema)) {
    url += `#schema=${schema}`;
  }
  chrome.tabs.create({
    url,
    openerTabId: sender.tab?.id,
    active: true,
  }).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true; // async sendResponse
});
