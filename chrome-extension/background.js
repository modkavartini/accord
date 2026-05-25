// Content scripts can't reliably call window.open across the popup blocker,
// so the gate-launch from the floating button flows through here as a
// chrome.tabs.create.

const ACCORD_BASE = 'https://accord-ingly.netlify.app';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'accord:open-gate') return;
  const formId = msg.formId;
  if (typeof formId !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(formId)) {
    sendResponse({ ok: false, error: 'invalid formId' });
    return false;
  }
  chrome.tabs.create({
    url: `${ACCORD_BASE}/go/${formId}`,
    openerTabId: sender.tab?.id,
    active: true,
  }).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true; // async sendResponse
});
