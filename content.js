// Bridge: injects the engine into the page, relays settings from storage down
// to it, and answers the popup from the engine's status reports.

const FROM_CONTENT_SCRIPT = "slow-and-reverb";
const FROM_PAGE = "slow-and-reverb-page";

let isExtensionOn = true;
let storedPlaybackRate = 1.0;
let storedReverbMix = 0.0;

// Latest status pushed up by the engine.
let engineStatus = { hasMedia: false, playing: false };

// Inline source text executes synchronously on append, so the engine's patches
// are in place before any page script runs (with run_at document_start).
(function injectEngine() {
  try {
    const script = document.createElement("script");
    script.textContent = `(${slowAndReverbPageHook.toString()})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (error) {
    console.warn("[Slow and Reverb] Could not install the engine.", error);
  }
})();

function sendSettings() {
  window.postMessage(
    {
      source: FROM_CONTENT_SCRIPT,
      type: "settings",
      isExtensionOn,
      playbackRate: storedPlaybackRate,
      reverbMix: storedReverbMix,
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
    engineStatus = { hasMedia: !!data.hasMedia, playing: !!data.playing };
  }
});

// Settings live in storage; every frame in every tab reacts to changes there.
browser.storage.local
  .get(["isExtensionOn", "playbackRate", "reverbMix"])
  .then((result) => {
    isExtensionOn =
      result.isExtensionOn !== undefined ? result.isExtensionOn : true;
    storedPlaybackRate = result.playbackRate || 1.0;
    storedReverbMix = result.reverbMix || 0.0;
    sendSettings();
  });

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.isExtensionOn) isExtensionOn = changes.isExtensionOn.newValue;
  if (changes.playbackRate) storedPlaybackRate = changes.playbackRate.newValue;
  if (changes.reverbMix) storedReverbMix = changes.reverbMix.newValue;

  sendSettings();
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "getAudioStatus") return;

  // Stay silent when this frame has no media, so a frame that does can answer.
  if (engineStatus.playing) {
    return Promise.resolve({
      status: "playing",
      audioName: document.title || "Unknown",
    });
  }
  if (engineStatus.hasMedia) {
    return Promise.resolve({ status: "audioDetected" });
  }
});
