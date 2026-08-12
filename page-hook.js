// Page hook: runs inside the page's own JavaScript context.
//
// The content script can only reach media elements that exist in the DOM. Sites
// like SoundCloud never create one — they decode audio into Web Audio buffers
// and play it through their own graph, so there is nothing to attach to.
//
// This file takes the other route in. It patches the page's own Web Audio API so
// that anything the page connects to its speakers is routed through our reverb
// chain first. Nothing about CORS applies here: the page already decoded this
// audio legally, so there is no taint, no header to inject, and no reload.
//
// It has to live in the page's context because content scripts run in an
// isolated world with their own copies of the JavaScript globals. Patching
// AudioNode.prototype from the content script would not affect the page at all.
//
// This file itself runs in the isolated world and only defines the function.
// content.js converts it to source text and injects it, which runs it in the
// page synchronously — before any of the page's own scripts. Loading it as a
// separate <script src> would be asynchronous, and a page that builds its audio
// graph early would finish before the patch was in place.
//
// Because it is stringified, this function must be entirely self-contained. It
// cannot reference anything outside its own body.

function slowAndReverbPageHook() {
  const DECAY_TIME_SECONDS = 4;
  const PRE_DELAY_SECONDS = 0.05;
  const CHANNEL_COUNT = 2;

  // A buffer holding this much audio is a whole track, which we can safely
  // change the speed of. Anything shorter is a streaming segment belonging to
  // the site's scheduler. Real segments run a few seconds; real tracks run
  // minutes, so there is a lot of room between the two.
  const MIN_SPEEDABLE_BUFFER_SECONDS = 30;

  // How often to put our speed back if the page has overwritten it.
  const RATE_REAPPLY_INTERVAL_MS = 500;

  const FROM_CONTENT_SCRIPT = "slow-and-reverb";
  const FROM_PAGE = "slow-and-reverb-page";

  let isExtensionOn = true;
  let playbackRate = 1.0;
  let reverbMix = 0.0;

  // One chain per live AudioContext. Audio nodes cannot be shared between
  // contexts, so every context the page creates needs its own set.
  const chains = new Map();

  // Things whose speed we can change, kept so a later slider move reaches
  // whatever is already playing.
  const bufferSources = new Set();

  // Every media element the page creates, whether or not it is ever added to
  // the document. A player can build one with new Audio() or createElement and
  // never append it, which makes it invisible to querySelectorAll and so
  // invisible to the content script. Catching it at creation is the only way.
  const speedElements = new Set();

  let warnedAboutSegmentedPlayback = false;
  let loggedSpeedElement = false;

  // Captured before patching, so our own wiring can bypass the patch.
  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const origCreateBufferSource = BaseAudioContext.prototype.createBufferSource;
  const origCreateMediaElementSource =
    BaseAudioContext.prototype.createMediaElementSource;

  // Only live output contexts get intercepted. An OfflineAudioContext is a
  // render target, not the speakers — including the one we use below to build
  // the impulse response, which would otherwise recurse into this patch.
  function isLiveContext(context) {
    return (
      typeof AudioContext !== "undefined" && context instanceof AudioContext
    );
  }

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

  const effectiveRate = () => (isExtensionOn ? playbackRate : 1.0);
  const effectiveMix = () => (isExtensionOn ? reverbMix : 0);

  function applyMix(context, chain) {
    const wetValue = effectiveMix();
    const dryValue = Math.cos((wetValue * Math.PI) / 2);
    const wetAdjusted = Math.sin((wetValue * Math.PI) / 2);

    chain.dry.gain.setValueAtTime(dryValue, context.currentTime);
    // A convolver with no buffer outputs silence, so hold the wet path shut
    // until the impulse response has finished rendering.
    chain.wet.gain.setValueAtTime(
      chain.convolver.buffer ? wetAdjusted : 0,
      context.currentTime
    );
  }

  // Speed comes from the element itself, so this works even when the page has
  // already routed the element through its own graph and we cannot touch it.
  function trackElementForSpeed(element) {
    if (!element || speedElements.has(element)) return;

    speedElements.add(element);
    element.addEventListener("ended", () => speedElements.delete(element));

    // A player that keeps its own clock will often write playbackRate back to 1
    // whenever it adjusts buffering. Put our value back when that happens. This
    // cannot loop: setting the rate fires ratechange again, and the second time
    // through the value already matches and we return.
    element.addEventListener("ratechange", () => {
      const wanted = effectiveRate();
      if (Math.abs(element.playbackRate - wanted) < 0.001) return;
      element.playbackRate = wanted;
    });

    // Whether this element is playing is a far more reliable signal than the
    // state of an audio context we may or may not have intercepted in time.
    element.addEventListener("play", reportState);
    element.addEventListener("pause", reportState);

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
  }

  // Tells the content script not to try claiming this element for its own
  // graph. Two createMediaElementSource calls on one element throw.
  function markPageOwned(element) {
    try {
      element.dataset.slowReverbPageOwned = "1";
    } catch (error) {
      // Not an HTMLElement with a dataset. Nothing to mark.
    }
  }

  function applyRate() {
    const rate = effectiveRate();

    // Only write when the value is actually different. This runs on a timer, and
    // assigning playbackRate fires a ratechange event, so writing every time
    // would produce a steady stream of pointless events.
    for (const node of bufferSources) {
      try {
        if (Math.abs(node.playbackRate.value - rate) > 0.001) {
          node.playbackRate.value = rate;
        }
      } catch (error) {
        // Node already finished. Harmless.
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
        // Element torn down mid-loop. Harmless.
      }
    }
  }

  function applySettings() {
    for (const [context, chain] of chains) {
      applyMix(context, chain);
    }
    applyRate();
  }

  function reportState() {
    let active = false;

    for (const context of chains.keys()) {
      if (context.state === "running") active = true;
    }

    // Also counts as audio even if we never got hold of the context that is
    // playing it, which is what left the popup showing nothing on first load.
    for (const element of speedElements) {
      if (!element.paused) active = true;
    }

    window.postMessage({ source: FROM_PAGE, type: "audioState", active }, "*");
  }

  // input --> dry -------------------> destination
  //       \-> convolver --> wet ----/
  function getChain(context) {
    const existing = chains.get(context);
    if (existing) return existing;

    const chain = {
      input: context.createGain(),
      dry: context.createGain(),
      wet: context.createGain(),
      convolver: context.createConvolver(),
    };

    // origConnect throughout: the patched connect would send these straight
    // back into the chain input and build an infinite loop.
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

    console.log("[Slow and Reverb] intercepted a page AudioContext");

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
    // A page that connected to the destination is really connected to our
    // chain input, so an unmodified disconnect would throw.
    if (target instanceof AudioDestinationNode && isLiveContext(this.context)) {
      const chain = chains.get(this.context);
      if (chain && !isChainNode(this, chain)) {
        return origDisconnect.call(this, chain.input, ...rest);
      }
    }
    return origDisconnect.apply(this, arguments);
  };

  // Speed for buffer-based playback. Changing playbackRate on an
  // AudioBufferSourceNode resamples it, so the pitch drops with the tempo —
  // the same effect preservesPitch=false gives on a media element.
  //
  // This only works when one buffer holds a whole track. A streaming player
  // decodes short segments and schedules each one on its own clock, so a
  // segment we slow down runs past the start time already booked for the next
  // one. The result is a collision and a glitch, and the pace snaps back as
  // soon as the next segment arrives on schedule. Only the site's own scheduler
  // can change the pace of playback like that, so we leave segments alone.
  function watchBufferSource(node) {
    const origStart = node.start;

    // The buffer is assigned after the node is created, so its length is only
    // known once playback is asked for.
    node.start = function () {
      const duration = node.buffer ? node.buffer.duration : 0;

      if (duration >= MIN_SPEEDABLE_BUFFER_SECONDS) {
        bufferSources.add(node);
        node.addEventListener("ended", () => bufferSources.delete(node));
        try {
          node.playbackRate.value = effectiveRate();
        } catch (error) {
          // Ignore: the node is unusable anyway.
        }
      } else if (!warnedAboutSegmentedPlayback) {
        warnedAboutSegmentedPlayback = true;
        console.warn(
          "[Slow and Reverb] This site streams audio in short scheduled " +
            "segments (" +
            duration.toFixed(2) +
            "s). Speed control is unavailable here, because changing the rate " +
            "of a segment desynchronises it from the site's own scheduler. " +
            "Reverb is unaffected."
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

  BaseAudioContext.prototype.createMediaElementSource = function (element) {
    if (element && isLiveContext(this)) {
      trackElementForSpeed(element);
      markPageOwned(element);
    }
    return origCreateMediaElementSource.apply(this, arguments);
  };

  // Every node above has a constructor form as well — new AudioBufferSourceNode
  // (context, options) rather than context.createBufferSource(). Patching only
  // the factory methods misses a player that uses the constructors, which is
  // how a site can end up with reverb working but speed doing nothing.
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
      markPageOwned(element);
    }
  });

  // The widest net for speed: catch media elements as they are created, before
  // the page has decided what to do with them. This is what reaches a player
  // that keeps its audio element out of the document entirely.
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

    // createElement is a hot path on any framework-driven page, so check the
    // cheap thing first. Both tags we care about are five characters.
    if (typeof tagName === "string" && tagName.length === 5) {
      const lower = tagName.toLowerCase();
      if (lower === "audio" || lower === "video") trackElementForSpeed(element);
    }

    return element;
  };

  // The two hooks that matter most, because they sit on the shared prototype
  // rather than on the moment of creation. Everything above only catches an
  // element if we were already installed when the page built it. These catch it
  // whenever the page uses it, even if it was created before we arrived.
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

  // A player that manages its own buffering will write playbackRate back to 1
  // whenever it resynchronises, and it can do that at any moment. The ratechange
  // listener catches most of it; this catches the rest.
  setInterval(() => {
    if (speedElements.size > 0 || bufferSources.size > 0) applyRate();
  }, RATE_REAPPLY_INTERVAL_MS);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== FROM_CONTENT_SCRIPT) return;

    if (data.type === "settings") {
      isExtensionOn = data.isExtensionOn;
      playbackRate = data.playbackRate;
      reverbMix = data.reverbMix;
      applySettings();
    } else if (data.type === "requestState") {
      reportState();
    }
  });

  // Run __slowAndReverbDebug() in the console while a track is playing to see
  // exactly what the hook is holding on to. If a tracked element shows paused
  // true and a currentTime stuck at zero while you can hear music, that element
  // is a decoy and the real audio is coming from somewhere else.
  window.__slowAndReverbDebug = function () {
    return {
      settings: { isExtensionOn, playbackRate, reverbMix },
      contexts: [...chains.keys()].map((context) => ({
        state: context.state,
        sampleRate: context.sampleRate,
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

  // A marker and a log line, both so you can confirm from the console that the
  // patch is actually in place on a given site.
  window.__slowAndReverbHookInstalled = true;
  console.log("[Slow and Reverb] page hook installed");

  window.postMessage({ source: FROM_PAGE, type: "ready" }, "*");
}
