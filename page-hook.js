// Engine: all audio work, running in the page's own JavaScript context.
// content.js injects this function as source text, so it must stay fully
// self-contained — it cannot reference anything outside its own body.
//
// Two layers. Acquisition notices audio (media elements, page-built audio
// graphs, raw buffer playback) and feeds the registry. Effects applies speed
// and reverb to whatever the registry holds, without caring where it came from.

function slowAndReverbPageHook() {
  // ------------------------------------------------------------- constants
  const DECAY_TIME_SECONDS = 4;
  const PRE_DELAY_SECONDS = 0.05;
  const CHANNEL_COUNT = 2;

  // Shorter buffers are streaming segments owned by the site's scheduler;
  // changing their rate only desynchronises them.
  const MIN_SPEEDABLE_BUFFER_SECONDS = 30;

  const RATE_REAPPLY_INTERVAL_MS = 500;
  const CORS_RELOAD_TIMEOUT_MS = 8000;
  const SCAN_DEBOUNCE_MS = 300;
  const SHADOW_SCAN_INTERVAL_MS = 3000;

  // Schemes that point at data the page already holds; CORS never applies.
  const EXEMPT_SCHEMES = ["blob:", "data:", "mediasource:"];

  const FROM_CONTENT_SCRIPT = "slow-and-reverb";
  const FROM_PAGE = "slow-and-reverb-page";

  // -------------------------------------- settings (pushed down by content.js)
  let isExtensionOn = true;
  let playbackRate = 1.0;
  let reverbMix = 0.0;

  const effectiveRate = () => (isExtensionOn ? playbackRate : 1.0);
  const effectiveMix = () => (isExtensionOn ? reverbMix : 0);

  // -------------------------------------------------------------- registry
  const speedElements = new Set(); // every media element seen; speed targets
  const bufferSources = new Set(); // live whole-track buffer nodes; speed targets
  const chains = new Map(); // AudioContext -> effect chain; reverb targets
  const pageOwnedElements = new WeakSet(); // wired into the page's own graph
  const connectedElements = new WeakSet(); // wired into our chain
  const unusableElements = new WeakSet(); // reverb given up on these
  const reloadingElements = new WeakSet(); // mid CORS reload
  let ownContext = null; // our AudioContext for DOM media elements

  let warnedAboutSegmentedPlayback = false;
  let loggedSpeedElement = false;

  // Originals, captured so our own wiring bypasses our patches.
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const origCreateBufferSource = BaseAudioContext.prototype.createBufferSource;
  // On AudioContext, not BaseAudioContext: only live contexts have it.
  const origCreateMediaElementSource =
    AudioContext.prototype.createMediaElementSource;

  // Live output contexts only. OfflineAudioContext is a render target (ours
  // for the impulse response included) and must pass through untouched.
  function isLiveContext(context) {
    return (
      typeof AudioContext !== "undefined" && context instanceof AudioContext
    );
  }

  // ---------------------------------------------------------------- reverb
  function createWhiteNoiseBuffer(context) {
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
  }

  function createImpulseResponse(context) {
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
  }

  // input --> dry ------------------> destination
  //       \-> convolver --> wet ---/
  function getChain(context) {
    const existing = chains.get(context);
    if (existing) return existing;

    const chain = {
      input: context.createGain(),
      dry: context.createGain(),
      wet: context.createGain(),
      convolver: context.createConvolver(),
    };

    // origConnect: the patched connect would loop these back into the chain.
    origConnect.call(chain.input, chain.dry);
    origConnect.call(chain.input, chain.convolver);
    origConnect.call(chain.convolver, chain.wet);
    origConnect.call(chain.dry, context.destination);
    origConnect.call(chain.wet, context.destination);

    chains.set(context, chain);
    applyMix(context, chain);

    createImpulseResponse(context)
      .then((buffer) => {
        chain.convolver.buffer = buffer;
        applyMix(context, chain);
      })
      .catch(() => {});

    context.addEventListener("statechange", reportState);
    reportState();

    if (context !== ownContext) {
      console.log("[Slow and Reverb] intercepted a page AudioContext");
    }

    return chain;
  }

  function isChainNode(node, chain) {
    return (
      node === chain.input ||
      node === chain.dry ||
      node === chain.wet ||
      node === chain.convolver
    );
  }

  // ---------------------------------------------------------------- effects
  function applyMix(context, chain) {
    const wetValue = effectiveMix();
    const dryValue = Math.cos((wetValue * Math.PI) / 2);
    const wetAdjusted = Math.sin((wetValue * Math.PI) / 2);

    chain.dry.gain.setValueAtTime(dryValue, context.currentTime);
    // A convolver with no buffer outputs silence; hold the wet path shut
    // until the impulse response is ready.
    chain.wet.gain.setValueAtTime(
      chain.convolver.buffer ? wetAdjusted : 0,
      context.currentTime
    );
  }

  function applyRate() {
    const rate = effectiveRate();

    // Only write when different: this runs on a timer, and every write fires
    // a ratechange event.
    for (const node of bufferSources) {
      try {
        if (Math.abs(node.playbackRate.value - rate) > 0.001) {
          node.playbackRate.value = rate;
        }
      } catch (error) {
        // Node already finished.
      }
    }

    for (const element of speedElements) {
      try {
        if (element.preservesPitch !== false) element.preservesPitch = false;
        if (element.mozPreservesPitch !== false) element.mozPreservesPitch = false;
        if (Math.abs(element.playbackRate - rate) > 0.001) {
          element.playbackRate = rate;
        }
      } catch (error) {
        // Element torn down mid-loop.
      }
    }
  }

  function applySettings() {
    for (const [context, chain] of chains) {
      applyMix(context, chain);
    }
    applyRate();
  }

  // ---------------------------------------------------------------- status
  function reportState() {
    let hasMedia = speedElements.size > 0 || bufferSources.size > 0;
    let playing = false;

    for (const context of chains.keys()) {
      if (context === ownContext) continue; // ours runs even with nothing playing
      hasMedia = true;
      if (context.state === "running") playing = true;
    }

    for (const element of speedElements) {
      if (!element.paused) playing = true;
    }

    window.postMessage(
      { source: FROM_PAGE, type: "status", hasMedia, playing },
      "*"
    );
  }

  // ------------------------------------------- acquisition: media elements
  function trackElementForSpeed(element) {
    if (!element || speedElements.has(element)) return;

    speedElements.add(element);
    element.addEventListener("ended", () => {
      speedElements.delete(element);
      reportState();
    });

    // Players write playbackRate back to 1 when rebuffering; put ours back.
    element.addEventListener("ratechange", () => {
      const wanted = effectiveRate();
      if (Math.abs(element.playbackRate - wanted) < 0.001) return;
      element.playbackRate = wanted;
    });

    element.addEventListener("play", () => {
      connectElementReverb(element)
        .then(() => applySettings())
        .catch(() => {});
      reportState();
    });

    element.addEventListener("pause", () => {
      // Cut the reverb tail on our chain; applySettings restores it on play.
      const chain = ownContext && chains.get(ownContext);
      if (chain) chain.wet.gain.setValueAtTime(0, ownContext.currentTime);
      reportState();
    });

    element.preservesPitch = false;
    element.mozPreservesPitch = false;
    element.playbackRate = effectiveRate();

    if (!loggedSpeedElement) {
      loggedSpeedElement = true;
      console.log(
        "[Slow and Reverb] found a media element for speed control (in the DOM: " +
          element.isConnected +
          ")"
      );
    }

    reportState();
  }

  function ensureOwnGraph() {
    if (!ownContext) {
      ownContext = new (window.AudioContext || window.webkitAudioContext)();
      getChain(ownContext);
    }
  }

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

  // Reload the element as a CORS request; crossOrigin only takes effect
  // before the media loads. Resolves true when the CORS check passed, false
  // after restoring the element exactly as it was.
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
          // Stream not seekable yet.
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
        // CORS refused: undo the attribute and reload plain, so the page
        // keeps working normally.
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

  async function connectElementReverb(element) {
    if (connectedElements.has(element)) return;
    if (unusableElements.has(element)) return;
    if (reloadingElements.has(element)) return;
    // The page's graph carries it; our destination patch adds the reverb.
    if (pageOwnedElements.has(element)) return;

    ensureOwnGraph();
    if (ownContext.state === "suspended") {
      await ownContext.resume().catch(() => {});
    }

    if (needsCrossOriginOptIn(element)) {
      const granted = await reloadWithCrossOrigin(element);
      if (!granted) {
        unusableElements.add(element);
        console.warn(
          "[Slow and Reverb] Site refused a cross-origin audio request; " +
            "reverb unavailable here. Speed still works."
        );
        return;
      }
      // The reload reset the rate set at tracking time.
      element.preservesPitch = false;
      element.mozPreservesPitch = false;
      element.playbackRate = effectiveRate();
    }

    if (connectedElements.has(element)) return; // connected while awaiting

    try {
      const source = origCreateMediaElementSource.call(ownContext, element);
      const chain = getChain(ownContext);
      origConnect.call(source, chain.input);
      connectedElements.add(element);
    } catch (error) {
      unusableElements.add(element);
      // InvalidStateError means another graph already claimed the element;
      // anything else is a real failure and should say so.
      if (error && error.name === "InvalidStateError") {
        console.warn(
          "[Slow and Reverb] Element already belongs to another audio graph; " +
            "reverb unavailable for it. Speed still works."
        );
      } else {
        console.warn(
          "[Slow and Reverb] Could not connect this element for reverb.",
          error
        );
      }
    }
  }

  // -------------------------------------------------- acquisition: DOM scan
  let lastShadowScan = 0;

  function findMediaElements() {
    const found = [...document.querySelectorAll("video, audio")];
    if (found.length > 0) return found;

    // Shadow-root walk touches every element; throttle it on media-less pages.
    const now = Date.now();
    if (now - lastShadowScan < SHADOW_SCAN_INTERVAL_MS) return found;
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

  let scanScheduled = false;

  function scanForMedia() {
    scanScheduled = false;
    findMediaElements().forEach((element) => {
      trackElementForSpeed(element);
      if (!element.paused) {
        connectElementReverb(element)
          .then(() => applySettings())
          .catch(() => {});
      }
    });
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(scanForMedia, SCAN_DEBOUNCE_MS);
  }

  // documentElement: body does not exist yet at document_start.
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", scanForMedia);
  scanForMedia();

  // ------------------------------------- acquisition: page-built audio graphs
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode && isLiveContext(this.context)) {
      const chain = getChain(this.context);
      if (!isChainNode(this, chain)) {
        return origConnect.call(this, chain.input, ...rest);
      }
    }
    return origConnect.apply(this, arguments);
  };

  AudioNode.prototype.disconnect = function (target, ...rest) {
    // Nodes that "connected to the destination" really connected to our
    // chain input; mirror that here or the disconnect throws.
    if (target instanceof AudioDestinationNode && isLiveContext(this.context)) {
      const chain = chains.get(this.context);
      if (chain && !isChainNode(this, chain)) {
        return origDisconnect.call(this, chain.input, ...rest);
      }
    }
    return origDisconnect.apply(this, arguments);
  };

  // ------------------------------------------- acquisition: buffer playback
  function watchBufferSource(node) {
    const origStart = node.start;

    // Buffer is assigned after creation; length is only known at start().
    node.start = function () {
      const duration = node.buffer ? node.buffer.duration : 0;

      if (duration >= MIN_SPEEDABLE_BUFFER_SECONDS) {
        bufferSources.add(node);
        node.addEventListener("ended", () => bufferSources.delete(node));
        try {
          node.playbackRate.value = effectiveRate();
        } catch (error) {
          // Node unusable anyway.
        }
      } else if (!warnedAboutSegmentedPlayback) {
        warnedAboutSegmentedPlayback = true;
        console.warn(
          "[Slow and Reverb] This site streams audio in short scheduled " +
            "segments (" +
            duration.toFixed(2) +
            "s); speed control is unavailable here. Reverb is unaffected."
        );
      }

      return origStart.apply(this, arguments);
    };
  }

  BaseAudioContext.prototype.createBufferSource = function () {
    const node = origCreateBufferSource.apply(this, arguments);
    if (isLiveContext(this)) watchBufferSource(node);
    return node;
  };

  AudioContext.prototype.createMediaElementSource = function (element) {
    if (element && isLiveContext(this)) {
      trackElementForSpeed(element);
      pageOwnedElements.add(element);
    }
    return origCreateMediaElementSource.apply(this, arguments);
  };

  // Constructor forms of the nodes above; a player can use either.
  function patchConstructor(name, onConstruct) {
    const Original = window[name];
    if (typeof Original !== "function") return;

    const Patched = function (context, options) {
      const node = new Original(context, options);
      if (isLiveContext(context)) onConstruct(node, options);
      return node;
    };
    Patched.prototype = Original.prototype;
    window[name] = Patched;
  }

  patchConstructor("AudioBufferSourceNode", (node) => watchBufferSource(node));
  patchConstructor("MediaElementAudioSourceNode", (node, options) => {
    const element = options && options.mediaElement;
    if (element) {
      trackElementForSpeed(element);
      pageOwnedElements.add(element);
    }
  });

  // ------------------------------------ acquisition: element creation and use
  const OriginalAudio = window.Audio;
  if (typeof OriginalAudio === "function") {
    const PatchedAudio = function (...args) {
      const element = new OriginalAudio(...args);
      trackElementForSpeed(element);
      return element;
    };
    PatchedAudio.prototype = OriginalAudio.prototype;
    window.Audio = PatchedAudio;
  }

  const origCreateElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, ...rest) {
    const element = origCreateElement.call(this, tagName, ...rest);

    // Hot path: cheapest check first. Both tags are five characters.
    if (typeof tagName === "string" && tagName.length === 5) {
      const lower = tagName.toLowerCase();
      if (lower === "audio" || lower === "video") trackElementForSpeed(element);
    }

    return element;
  };

  // Prototype hooks: catch elements whenever they are used, even ones created
  // before we were installed.
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    trackElementForSpeed(this);
    return origPlay.apply(this, args);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "src"
  );
  if (srcDescriptor && srcDescriptor.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      get: srcDescriptor.get,
      set: function (value) {
        trackElementForSpeed(this);
        return srcDescriptor.set.call(this, value);
      },
      configurable: true,
      enumerable: srcDescriptor.enumerable,
    });
  }

  // Players rewrite playbackRate at any moment; the ratechange listener
  // catches most of it, this catches the rest.
  setInterval(() => {
    if (speedElements.size > 0 || bufferSources.size > 0) applyRate();
  }, RATE_REAPPLY_INTERVAL_MS);

  // -------------------------------------------------------------- messaging
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== FROM_CONTENT_SCRIPT) return;

    if (data.type === "settings") {
      isExtensionOn = data.isExtensionOn;
      playbackRate = data.playbackRate;
      reverbMix = data.reverbMix;
      applySettings();
    }
  });

  // ------------------------------------------------------------- diagnostics
  // Run __slowAndReverbDebug() in the console to see what the engine holds.
  window.__slowAndReverbDebug = function () {
    return {
      settings: { isExtensionOn, playbackRate, reverbMix },
      contexts: [...chains.keys()].map((context) => ({
        state: context.state,
        sampleRate: context.sampleRate,
        own: context === ownContext,
      })),
      liveBufferSources: bufferSources.size,
      elements: [...speedElements].map((element) => ({
        tag: element.tagName,
        inDocument: element.isConnected,
        src: (element.currentSrc || element.src || "").slice(0, 80),
        paused: element.paused,
        currentTime: element.currentTime,
        duration: element.duration,
        playbackRate: element.playbackRate,
        volume: element.volume,
        muted: element.muted,
        readyState: element.readyState,
      })),
    };
  };

  window.__slowAndReverbHookInstalled = true;
  console.log("[Slow and Reverb] engine installed");

  window.postMessage({ source: FROM_PAGE, type: "ready" }, "*");
}
