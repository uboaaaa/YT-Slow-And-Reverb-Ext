// Bridge: relays settings from storage down to the engine (which the browser
// injects into the page via world: "MAIN"), and answers the popup from the
// engine's status reports.

globalThis.browser ??= chrome; // Chrome has no browser namespace; Firefox does



const FROM_CONTENT_SCRIPT = "slow-and-reverb";
const FROM_PAGE = "slow-and-reverb-page";

let isExtensionOn = true;
let storedPlaybackRate = 1.0;
let storedReverbMix = 0.0;
let storedBassBoost = 0.0;

// Latest status pushed up by the engine.
let engineStatus = { hasMedia: false, playing: false, drmBlocked: false };

// Wake the background event page and prove it's reachable. Without it, the
// CORS header rewrite is dead and cross-origin reverb fails.
browser.runtime
  .sendMessage({ type: "ping" })
  .then((reply) => {
    if (!reply || !reply.ok) {
      console.warn("[Slow and Reverb] background gave an unexpected reply");
    }
  })
  .catch(() => {
    console.warn("[Slow and Reverb] background unreachable");
  });

function sendSettings() {
  window.postMessage(
    {
      source: FROM_CONTENT_SCRIPT,
      type: "settings",
      isExtensionOn,
      playbackRate: storedPlaybackRate,
      reverbMix: storedReverbMix,
      bassBoost: storedBassBoost,
    },
    "*"
  );
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== FROM_PAGE) return;

  if (data.type === "ready") {
    sendSettings();
  } else if (data.type === "status") {
    engineStatus = {
      hasMedia: !!data.hasMedia,
      playing: !!data.playing,
      drmBlocked: !!data.drmBlocked,
    };
  }
});

// Settings live in storage; every frame in every tab reacts to changes there.
browser.storage.local
  .get(["isExtensionOn", "playbackRate", "reverbMix", "bassBoost"])
  .then((result) => {
    isExtensionOn =
      result.isExtensionOn !== undefined ? result.isExtensionOn : true;
    storedPlaybackRate = result.playbackRate || 1.0;
    storedReverbMix = result.reverbMix || 0.0;
    storedBassBoost = result.bassBoost || 0.0;
    sendSettings();
  });

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.isExtensionOn) isExtensionOn = changes.isExtensionOn.newValue;
  if (changes.playbackRate) storedPlaybackRate = changes.playbackRate.newValue;
  if (changes.reverbMix) storedReverbMix = changes.reverbMix.newValue;
  if (changes.bassBoost) storedBassBoost = changes.bassBoost.newValue;

  sendSettings();
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "getAudioStatus") return;

  // Stay silent when this frame has no media, so a frame that does can answer.
  if (engineStatus.playing) {
    return Promise.resolve({
      status: "playing",
      audioName: document.title || "Unknown",
      drmBlocked: engineStatus.drmBlocked,
    });
  }
  if (engineStatus.hasMedia) {
    return Promise.resolve({
      status: "audioDetected",
      drmBlocked: engineStatus.drmBlocked,
    });
  }
});
