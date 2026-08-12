// Background script: grants the page permission to read cross-origin media.
//
// Web Audio refuses to process media that came from another origin unless the
// server sent an "Access-Control-Allow-Origin" header. Most audio CDNs do not
// send one (Bandcamp's t4.bcbits.com, for example), so createMediaElementSource
// would silently output zeros and mute the page.
//
// We add the header ourselves as the response arrives. The content script does
// the other half of the handshake by setting crossOrigin="anonymous" on the
// media element, which is what makes the browser actually check for it.
//
// The filter is deliberately narrow: only "media" requests, which are the loads
// performed by <video> and <audio> elements. Page scripts and XHR are untouched,
// so this cannot be used to read arbitrary cross-origin data.

const ALLOW_ORIGIN_HEADER = "access-control-allow-origin";

function allowCrossOriginMedia(details) {
  // Drop any existing value first. Two Access-Control-Allow-Origin headers on
  // one response is invalid and the browser rejects the whole thing.
  const responseHeaders = details.responseHeaders.filter(
    (header) => header.name.toLowerCase() !== ALLOW_ORIGIN_HEADER
  );

  responseHeaders.push({ name: "Access-Control-Allow-Origin", value: "*" });

  return { responseHeaders };
}

browser.webRequest.onHeadersReceived.addListener(
  allowCrossOriginMedia,
  { urls: ["<all_urls>"], types: ["media"] },
  ["blocking", "responseHeaders"]
);
