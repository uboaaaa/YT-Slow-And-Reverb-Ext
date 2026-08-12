// Background: diagnostics only. The CORS header rewrite that used to live here
// is now a declarativeNetRequest rule (rules.json) applied by the browser's
// network stack itself — nothing here needs to be awake for it to work.

console.log("[Slow and Reverb] background loaded");

// Pages ping at load; answering proves the event page can wake.
browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "ping") {
    return Promise.resolve({ ok: true });
  }
});
