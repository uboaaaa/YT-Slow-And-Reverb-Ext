// Content script. builds the effects graph and wires media elements into it.

const DECAY_TIME_SECONDS = 4;
const PRE_DELAY_SECONDS = 0.05;
const CHANNEL_COUNT = 2;

// How long to wait for a media element to come back after we reload it with
// crossOrigin set, before assuming the CORS handshake failed
const CORS_RELOAD_TIMEOUT_MS = 8000; 

// How long to let DOM mutations settle before rescanning for media.
const SCAN_DEBOUNCE_MS = 300;

// How often the expensive shadow-DOM walk may run on a page with no media.
const SHADOW_SCAN_INTERVAL_MS = 3000;

const FROM_CONTENT_SCRIPT = "slow-and-reverb";
const FROM_PAGE = "slow-and-reverb-page";

// Sites that play audio without any media element (SoundCloud, for one) are
// handled by page-hook.js, which patches the page's own Web Audio graph.
//
// The hook is injected as source text rather than as a <script src>, because a
// script element with inline content executes the moment it is appended. A src
// load is asynchronous, which lets a page that builds its audio graph during
// load finish before the patch exists. Combined with run_at document_start,
// this guarantees we patch before any of the page's own scripts run.
(function injectPageHook() {
  try {
    const script = document.createElement("script");
    script.textContent = `(${slowAndReverbPageHook.toString()})();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (error) {
    console.warn("[Slow and Reverb] Could not install the page hook.", error);
  }
})();

// Whether the page hook currently has a running audio graph. The popup falls
// back to this when there is no media element to report on.
let pageAudioActive = false;

let audioContext = null;
let dryGainNode = null;
let wetGainNode = null;
let convolverNode = null;

// Resolves once the graph exists. Everything that touches the graph awaits it,
// which removes the old race between the MutationObserver and the async setup.
let audioGraphReady = null;

let isExtensionOn = true;
let storedPlaybackRate = 1.0;
let storedReverbMix = 0.0;

// WeakSet so entries disappear along with the elements themselves.
const connectedElements = new WeakSet();
const unusableElements = new WeakSet();
const trackedElements = new WeakSet();
const reloadingElements = new WeakSet();

const createWhiteNoiseBuffer = (context) => {
  const bufferLength = Math.floor(
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * context.sampleRate
  );
  const buffer = context.createBuffer(
    CHANNEL_COUNT,
    bufferLength,
    context.sampleRate
  );

  for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < bufferLength; i++) {
      channelData[i] = Math.random() * 2 - 1;
    }
  }

  return buffer;
};

const createImpulseResponse = async (context) => {
  //adapted from chrome extension
  const offlineContext = new OfflineAudioContext(
    CHANNEL_COUNT,
    Math.floor((DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * context.sampleRate),
    context.sampleRate
  );

  const bufferSource = offlineContext.createBufferSource();
  bufferSource.buffer = createWhiteNoiseBuffer(offlineContext);

  const gain = offlineContext.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.setValueAtTime(0.8, PRE_DELAY_SECONDS);
  gain.gain.exponentialRampToValueAtTime(
    0.00001,
    DECAY_TIME_SECONDS + PRE_DELAY_SECONDS
  );

  bufferSource.connect(gain);
  gain.connect(offlineContext.destination);

  bufferSource.start(0);
  return offlineContext.startRendering();
};

async function initializeAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  dryGainNode = audioContext.createGain();
  wetGainNode = audioContext.createGain();
  dryGainNode.gain.setValueAtTime(1, audioContext.currentTime);
  wetGainNode.gain.setValueAtTime(0, audioContext.currentTime);

  dryGainNode.connect(audioContext.destination);
  wetGainNode.connect(audioContext.destination);

  convolverNode = audioContext.createConvolver();
  convolverNode.connect(wetGainNode);
  convolverNode.buffer = await createImpulseResponse(audioContext);

  applyReverbMix(isExtensionOn ? storedReverbMix : 0);
}

// Build the graph on first use rather than at page load, so we never create an
// AudioContext on pages that have no media.
function ensureAudioGraph() {
  if (!audioGraphReady) {
    audioGraphReady = initializeAudio().catch((error) => {
      audioGraphReady = null;
      throw error;
    });
  }
  return audioGraphReady;
}

// An AudioContext created before the user has interacted with the page starts
// suspended, and a suspended context passes no sound at all.
async function resumeAudioGraph() {
  await ensureAudioGraph();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

let lastShadowScan = 0;

function findMediaElements(forceDeepScan = false) {
  const found = [...document.querySelectorAll("video, audio")];
  if (found.length > 0) {
    return found;
  }

  // Nothing in the light DOM. Some players hide their media element inside a
  // shadow root, which querySelectorAll cannot see into. That walk touches every
  // element on the page, so on a page with no media at all it must not run on
  // every mutation.
  const now = Date.now();
  if (!forceDeepScan && now - lastShadowScan < SHADOW_SCAN_INTERVAL_MS) {
    return found;
  }
  lastShadowScan = now;

  const searchShadowRoots = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (!element.shadowRoot) continue;
      found.push(...element.shadowRoot.querySelectorAll("video, audio"));
      searchShadowRoots(element.shadowRoot);
    }
  };
  searchShadowRoots(document);

  return found;
}

// These schemes point at data the page already holds, so Web Audio can read
// them freely. YouTube uses blob:, which is why it always worked.
const EXEMPT_SCHEMES = ["blob:", "data:", "mediasource:"];

function needsCrossOriginOptIn(element) {
  if (element.crossOrigin) return false;

  const source = element.currentSrc || element.src;
  if (!source) return false;
  if (EXEMPT_SCHEMES.some((scheme) => source.startsWith(scheme))) return false;

  try {
    return new URL(source, document.baseURI).origin !== window.location.origin;
  } catch (error) {
    return false;
  }
}

// Reload the element as a CORS request. crossOrigin only takes effect before the
// media loads, so an element that is already playing has to be reloaded and
// seeked back to where it was.
//
// Resolves true if the reload succeeded, which means the CORS check passed and
// the audio is safe to route through the graph. Resolves false if it failed, in
// which case we put the element back exactly as we found it.
function reloadWithCrossOrigin(element) {
  return new Promise((resolve) => {
    const source = element.currentSrc || element.src;
    const resumeAt = element.currentTime;
    const wasPlaying = !element.paused;

    reloadingElements.add(element);

    const restorePosition = () => {
      try {
        element.currentTime = resumeAt;
      } catch (error) {
        // Some streams refuse a seek before they are fully ready. Not fatal.
      }
      if (wasPlaying) element.play().catch(() => {});
    };

    let settled = false;
    const settle = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onFailed);
      reloadingElements.delete(element);
      resolve(succeeded);
    };

    const onLoaded = () => {
      restorePosition();
      settle(true);
    };

    const onFailed = () => {
      // CORS was refused, so the media will not load at all with the attribute
      // set. Undo it and reload without, so the page keeps working normally.
      element.removeAttribute("crossorigin");
      element.src = source;
      element.load();
      element.addEventListener("loadedmetadata", restorePosition, {
        once: true,
      });
      settle(false);
    };

    const timeout = setTimeout(onFailed, CORS_RELOAD_TIMEOUT_MS);

    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("error", onFailed);

    element.crossOrigin = "anonymous";
    element.src = source;
    element.load();
  });
}

async function connectMediaElement(element) {
  // Speed needs no audio graph, so set it first and unconditionally.
  element.preservesPitch = false;
  element.mozPreservesPitch = false;
  element.playbackRate = isExtensionOn ? storedPlaybackRate : 1.0;

  if (connectedElements.has(element)) return;
  if (unusableElements.has(element)) return;
  if (reloadingElements.has(element)) return;

  // The page routed this element through its own graph already, and the page
  // hook is handling it. A second createMediaElementSource call would throw.
  if (element.dataset && element.dataset.slowReverbPageOwned) {
    unusableElements.add(element);
    return;
  }

  await ensureAudioGraph();

  if (needsCrossOriginOptIn(element)) {
    const granted = await reloadWithCrossOrigin(element);
    if (!granted) {
      unusableElements.add(element);
      console.warn(
        "[Slow and Reverb] This site refused a cross-origin audio request, so " +
          "reverb is unavailable here. Speed still works."
      );
      return;
    }
    // The reload dropped the rate we set above.
    element.preservesPitch = false;
    element.mozPreservesPitch = false;
    element.playbackRate = isExtensionOn ? storedPlaybackRate : 1.0;
  }

  // Re-check: another call may have connected this element while we awaited.
  if (connectedElements.has(element)) return;

  try {
    const sourceNode = audioContext.createMediaElementSource(element);
    sourceNode.connect(dryGainNode);
    sourceNode.connect(convolverNode);
    connectedElements.add(element);
  } catch (error) {
    // Thrown when the page already built its own graph on this element. Give up
    // on reverb rather than letting the exception kill the rest of the script.
    unusableElements.add(element);
    console.warn(
      "[Slow and Reverb] This element is already routed through the page's own " +
        "audio graph, so reverb is unavailable for it. Speed still works.",
      error
    );
  }
}

function applyPlaybackRate(rate) {
  findMediaElements().forEach((element) => {
    element.preservesPitch = false;
    element.mozPreservesPitch = false;
    element.playbackRate = rate;
  });
}

function applyReverbMix(wetValue) {
  if (!audioContext || !dryGainNode || !wetGainNode) return;

  //TODO: recheck reverb method
  const dryValue = Math.cos((wetValue * Math.PI) / 2);
  const wetValueAdjusted = Math.sin((wetValue * Math.PI) / 2);

  dryGainNode.gain.setValueAtTime(dryValue, audioContext.currentTime);
  wetGainNode.gain.setValueAtTime(wetValueAdjusted, audioContext.currentTime);
}

// The toggle changes what we apply, never what is stored, so switching off and
// back on brings the slider positions back.
function applyCurrentSettings() {
  applyPlaybackRate(isExtensionOn ? storedPlaybackRate : 1.0);
  applyReverbMix(isExtensionOn ? storedReverbMix : 0);
  sendSettingsToPageHook();
}

// The page hook lives in a different JavaScript world, so settings reach it by
// postMessage rather than by a direct call. It applies the on/off state itself.
function sendSettingsToPageHook() {
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
    sendSettingsToPageHook();
  } else if (data.type === "audioState") {
    pageAudioActive = data.active;
  }
});

// Listeners are attached here rather than once at startup, so elements created
// later by single-page navigation get them too.
function trackMediaElement(element) {
  if (trackedElements.has(element)) return;
  trackedElements.add(element);

  element.addEventListener("play", () => {
    resumeAudioGraph()
      .then(() => connectMediaElement(element))
      .then(() => applyCurrentSettings())
      .catch((error) => {
        console.warn("[Slow and Reverb] Could not start the audio graph.", error);
      });
  });

  element.addEventListener("pause", () => {
    // Cut the reverb tail rather than letting it ring on after the pause.
    if (audioContext && wetGainNode) {
      wetGainNode.gain.setValueAtTime(0, audioContext.currentTime);
    }
  });
}

let scanScheduled = false;

function scanForMedia() {
  scanScheduled = false;
  findMediaElements().forEach((element) => {
    trackMediaElement(element);
    if (!element.paused) {
      resumeAudioGraph()
        .then(() => connectMediaElement(element))
        .then(() => applyCurrentSettings())
        .catch(() => {});
    }
  });
}

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  setTimeout(scanForMedia, SCAN_DEBOUNCE_MS);
}

// documentElement rather than body, because at document_start body does not
// exist yet and observe() would throw.
const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener("DOMContentLoaded", scanForMedia);
scanForMedia();

// Settings live in storage, and every frame in every tab reacts to changes
// there. That is what keeps media inside iframes in sync without the popup
// having to find and message each frame individually.
browser.storage.local
  .get(["isExtensionOn", "playbackRate", "reverbMix"])
  .then((result) => {
    isExtensionOn = result.isExtensionOn !== undefined ? result.isExtensionOn : true;
    storedPlaybackRate = result.playbackRate || 1.0;
    storedReverbMix = result.reverbMix || 0.0;
    applyCurrentSettings();
  });

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.isExtensionOn) isExtensionOn = changes.isExtensionOn.newValue;
  if (changes.playbackRate) storedPlaybackRate = changes.playbackRate.newValue;
  if (changes.reverbMix) storedReverbMix = changes.reverbMix.newValue;

  applyCurrentSettings();
});

function getAudioStatus() {
  // Forced deep scan: the popup opens rarely and a wrong "no audio" is worse
  // than one expensive walk.
  const mediaElements = findMediaElements(true);
  if (mediaElements.length === 0) {
    // No element, but the page hook may still be processing a Web Audio graph.
    if (pageAudioActive) {
      return { status: "playing", audioName: document.title || "Unknown" };
    }
    return null;
  }

  for (const element of mediaElements) {
    if (!element.paused) {
      return { status: "playing", audioName: document.title || "Unknown" };
    }
  }

  return { status: "audioDetected" };
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "getAudioStatus") return;

  // Returning nothing when this frame has no media lets a frame that does have
  // media answer instead. A message with no frameId reaches every frame in the
  // tab and the first response wins, so silent frames must stay silent.
  const status = getAudioStatus();
  if (!status) return;

  return Promise.resolve(status);
});
