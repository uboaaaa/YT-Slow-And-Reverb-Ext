// Engine: all audio work. Injected into the page world (world: "MAIN"), so
// page CSP does not apply. Acquisition notices audio and feeds the registries;
// effects apply speed/reverb/bass to whatever the registries hold.

(() => {
  if (window.__slowAndReverbHookInstalled) return;
  // ------------------------------------------------------------- constants
  const DECAY_TIME_SECONDS = 4;
  const PRE_DELAY_SECONDS = 0.05;
  const CHANNEL_COUNT = 2;

  // Shorter buffers are streaming segments owned by the site's scheduler;
  // changing their rate only desynchronises them.
  const MIN_SPEEDABLE_BUFFER_SECONDS = 30;

  // Low-shelf boost below this frequency; ~200Hz lifts kick and bass while
  // leaving voices alone.
  const BASS_SHELF_HZ = 200;

  // Slider 0..1 maps to 0..this many dB (+6dB is roughly double amplitude).
  // Kept conservative to avoid clipping loud tracks.
  const MAX_BASS_DECIBELS = 9;

  const RATE_REAPPLY_INTERVAL_MS = 500;

  // Minimum gap between corrective writes from the ratechange listener, so
  // they can never escalate into a ratechange storm.
  const RATE_FIGHT_MIN_INTERVAL_MS = 250;

  // An element that pauses this soon after one of our corrective rate writes
  // is treating the write as a reason to stop (e.g. Spotify hover previews);
  // back off speed control for it permanently.
  const RATE_BACKOFF_WINDOW_MS = 300;

  // DRM hands-off guards: when on, DRM elements are left completely untouched
  // (some environments kill DRM playback when modified). Off by default —
  // standard Firefox is unaffected; a user-facing toggle is planned.
  const DRM_SPEED_GUARD = false;
  const DRM_REVERB_GUARD = false;

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
  let bassBoost = 0.0;

  const effectiveRate = () => (isExtensionOn ? playbackRate : 1.0);
  const effectiveMix = () => (isExtensionOn ? reverbMix : 0);
  const effectiveBass = () => (isExtensionOn ? bassBoost : 0);

  // -------------------------------------------------------------- registry
  // Registries hold WeakRefs so media elements are never pinned for the
  // page's lifetime; dead refs are swept on iteration.
  const speedElementRefs = new Set(); // every media element seen; speed targets
  const seenSpeedElements = new WeakSet(); // membership test for the above
  const bufferSourceRefs = new Set(); // whole-track buffer nodes; speed targets
  const chains = new Map(); // AudioContext -> effect chain; reverb targets
  const pageOwnedElements = new WeakSet(); // wired into the page's own graph
  const connectedElements = new WeakSet(); // wired into our chain
  const unusableElements = new WeakSet(); // reverb given up on these
  const reloadingElements = new WeakSet(); // mid CORS reload
  const drmElements = new WeakSet(); // DRM: hands off entirely, speed included
  const rateEligible = new WeakSet(); // cleared for speed: playing and non-DRM
  const rateBackoff = new WeakSet(); // pauses on rate writes; speed given up
  const corsPreempted = new WeakSet(); // opted into CORS before first fetch
  const corsFallback = new WeakSet(); // CORS opt-in refused; never preempt again
  let ownContext = null; // our AudioContext for DOM media elements

  let warnedAboutSegmentedPlayback = false;

  // Yields live targets and sweeps garbage-collected ones out of the set.
  function* liveRefs(refSet) {
    for (const ref of refSet) {
      const target = ref.deref();
      if (target === undefined) {
        refSet.delete(ref);
        continue;
      }
      yield target;
    }
  }

  // True once any media on this page turned out to be DRM-protected; the
  // popup uses it to show why the controls are unavailable.
  let drmBlocked = false;

  function markElementDrm(element) {
    if (drmElements.has(element)) return;

    drmElements.add(element);
    if (DRM_REVERB_GUARD) unusableElements.add(element);
    drmBlocked = true;

    if (DRM_SPEED_GUARD) {
      // Undo anything we already set, so their player sees a pristine element.
      rateEligible.delete(element);
      try {
        element.playbackRate = 1;
        element.preservesPitch = true;
        element.mozPreservesPitch = true;
      } catch (error) {
        // Element torn down. Harmless.
      }
    }

    reportState();
    console.warn(
      DRM_SPEED_GUARD && DRM_REVERB_GUARD
        ? "[Slow and Reverb] DRM-protected media; leaving it untouched — this " +
            "site's player may break playback when speed or reverb are changed."
        : "[Slow and Reverb] DRM-protected media detected."
    );
  }

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

  // input --> bass --> dry ------------------> destination
  //                \-> convolver --> wet ---/
  // Bass sits before the split so the reverb echoes the boosted signal.
  function getChain(context) {
    const existing = chains.get(context);
    if (existing) return existing;

    const chain = {
      input: context.createGain(),
      bass: context.createBiquadFilter(),
      dry: context.createGain(),
      wet: context.createGain(),
      convolver: context.createConvolver(),
    };

    chain.bass.type = "lowshelf";
    chain.bass.frequency.value = BASS_SHELF_HZ;
    chain.bass.gain.value = 0;

    // origConnect: the patched connect would loop these back into the chain.
    // The bass->convolver link is managed by applyMix: a connected convolver
    // burns CPU continuously even when the wet gain is zero, so it is only
    // wired in while the mix is actually above zero.
    origConnect.call(chain.input, chain.bass);
    origConnect.call(chain.bass, chain.dry);
    origConnect.call(chain.convolver, chain.wet);
    origConnect.call(chain.dry, context.destination);
    origConnect.call(chain.wet, context.destination);
    chain.convolverConnected = false;

    chains.set(context, chain);
    applyMix(context, chain);

    createImpulseResponse(context)
      .then((buffer) => {
        chain.convolver.buffer = buffer;
        applyMix(context, chain);
      })
      .catch(() => {});

    context.addEventListener("statechange", () => {
      // A closed context can never make sound again; dropping its chain lets
      // the context and the ~MB impulse buffer be garbage collected.
      if (context.state === "closed") {
        chains.delete(context);
        if (context === ownContext) ownContext = null;
      }
      reportState();
    });
    reportState();

    if (context !== ownContext) {
      console.log("[Slow and Reverb] intercepted a page AudioContext");
    }

    return chain;
  }

  function isChainNode(node, chain) {
    return (
      node === chain.input ||
      node === chain.bass ||
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

    // Wire the convolver in only while it is audible (see getChain). Dropping
    // the mix to zero cuts any ringing tail, same as pausing does.
    const wetAudible = wetValue > 0.001 && !!chain.convolver.buffer;
    if (wetAudible && !chain.convolverConnected) {
      origConnect.call(chain.bass, chain.convolver);
      chain.convolverConnected = true;
    } else if (!wetAudible && chain.convolverConnected) {
      origDisconnect.call(chain.bass, chain.convolver);
      chain.convolverConnected = false;
    }

    chain.bass.gain.setValueAtTime(
      effectiveBass() * MAX_BASS_DECIBELS,
      context.currentTime
    );
  }

  function applyRate() {
    const rate = effectiveRate();

    // Only write when different: this runs on a timer, and every write fires
    // a ratechange event.
    for (const node of liveRefs(bufferSourceRefs)) {
      try {
        if (Math.abs(node.playbackRate.value - rate) > 0.001) {
          node.playbackRate.value = rate;
        }
      } catch (error) {
        // Node already finished.
      }
    }

    for (const element of liveRefs(speedElementRefs)) {
      // Untouched until playing and DRM-checked; see enableRate.
      if (!rateEligible.has(element)) continue;
      if (DRM_SPEED_GUARD && drmElements.has(element)) continue;
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
    let hasMedia = false;
    let playing = false;

    for (const context of chains.keys()) {
      if (context === ownContext) continue; // ours runs even with nothing playing
      hasMedia = true;
      if (context.state === "running") playing = true;
    }

    for (const element of liveRefs(speedElementRefs)) {
      hasMedia = true;
      if (!element.paused) playing = true;
    }

    for (const node of liveRefs(bufferSourceRefs)) {
      hasMedia = true;
      break;
    }

    window.postMessage(
      {
        source: FROM_PAGE,
        type: "status",
        hasMedia,
        playing,
        // Only dim the popup's controls when the guard actually blocks them.
        drmBlocked: DRM_SPEED_GUARD && drmBlocked,
      },
      "*"
    );
  }

  // ------------------------------------------- acquisition: media elements
  // True when any tracked element other than the given one is playing, e.g. a
  // main track while a transient hover preview comes and goes.
  function anyOtherElementPlaying(excluded) {
    for (const element of liveRefs(speedElementRefs)) {
      if (element !== excluded && !element.paused) return true;
    }
    return false;
  }

  // Clear an element for speed control and apply the current rate.
  function makeRateEligible(element) {
    rateEligible.add(element);
    element.preservesPitch = false;
    element.mozPreservesPitch = false;
    element.playbackRate = effectiveRate();
  }

  function trackElementForSpeed(element) {
    if (!element || seenSpeedElements.has(element)) return;

    seenSpeedElements.add(element);
    speedElementRefs.add(new WeakRef(element));
    element.addEventListener("ended", reportState);

    // Fires when the element meets encrypted (DRM) data, which can happen
    // before mediaKeys is set — back off as early as possible.
    element.addEventListener("encrypted", () => {
      markElementDrm(element);
    });
    if (element.mediaKeys) markElementDrm(element);

    // Speed is only ever applied to an element that is actually playing and
    // has been checked for DRM at that moment. Applying earlier (at creation)
    // would touch DRM elements before the encrypted event can fire.
    const enableRate = () => {
      if (rateBackoff.has(element)) return;
      if (DRM_SPEED_GUARD && (drmElements.has(element) || element.mediaKeys)) {
        return;
      }
      makeRateEligible(element);
    };

    element.addEventListener("playing", enableRate);
    if (!element.paused) enableRate();

    // Players write playbackRate back to 1 when rebuffering; put ours back.
    let rateFightCount = 0;
    let lastRateFight = 0;
    element.addEventListener("ratechange", () => {
      if (!rateEligible.has(element)) return;
      if (DRM_SPEED_GUARD && drmElements.has(element)) return;
      const wanted = effectiveRate();
      if (Math.abs(element.playbackRate - wanted) < 0.001) return;

      // Throttled so corrective writes can never escalate into an event
      // storm. Anything missed lands via the timer sweep.
      const now = Date.now();
      if (now - lastRateFight < RATE_FIGHT_MIN_INTERVAL_MS) return;
      lastRateFight = now;

      rateFightCount++;
      element.playbackRate = wanted;
    });

    element.addEventListener("play", () => {
      connectElementReverb(element)
        .then(() => applySettings())
        .catch(() => {});
      reportState();
    });

    element.addEventListener("pause", () => {
      // Cut the reverb tail on our chain, but only when nothing else is still
      // playing — a transient element (hover preview) pausing must not mute
      // the wet path under the main track. applySettings restores it on play.
      const chain = ownContext && chains.get(ownContext);
      if (chain && !anyOtherElementPlaying(element)) {
        chain.wet.gain.setValueAtTime(0, ownContext.currentTime);
      }

      // Pausing right after a corrective rate write is the signature of a
      // player that stops when its rate is touched; leave its speed alone
      // for good and hand its rate back.
      if (
        rateFightCount > 0 &&
        Date.now() - lastRateFight < RATE_BACKOFF_WINDOW_MS &&
        !rateBackoff.has(element)
      ) {
        rateBackoff.add(element);
        rateEligible.delete(element);
        try {
          element.playbackRate = 1;
          element.preservesPitch = true;
          element.mozPreservesPitch = true;
        } catch (error) {
          // Element torn down. Harmless.
        }
        console.warn(
          "[Slow and Reverb] this element pauses when its rate is changed; " +
            "giving up speed control for it."
        );
      }

      // Diagnostic for players that pause themselves when the rate is changed.
      if (rateFightCount > 0 || Math.abs(element.playbackRate - 1) > 0.001) {
        console.log(
          "[Slow and Reverb] paused at " +
            element.currentTime.toFixed(2) +
            "s, rate " +
            element.playbackRate.toFixed(2) +
            ", after " +
            rateFightCount +
            " rate fight(s)"
        );
      }
      reportState();
    });

    reportState();
  }

  function ensureOwnGraph() {
    if (!ownContext) {
      ownContext = new (window.AudioContext || window.webkitAudioContext)();
      getChain(ownContext);
    }
  }

  // Players that break when their media element is captured or reloaded.
  // Amazon's player refuses DRM playback once its element feeds an audio
  // graph (it checks mozAudioCaptured), so capture is off entirely there.
  // Apple MusicKit (music.apple.com and third-party embeds) only wedges when
  // the CORS reload interrupts its play(); elements opted into CORS before
  // their first fetch (maybePreemptCors) are safe to capture.
  let warnedStrictPlayer = false;
  function warnStrictOnce() {
    if (warnedStrictPlayer) return;
    warnedStrictPlayer = true;
    console.log(
      "[Slow and Reverb] this site's player breaks when its audio is " +
        "rerouted; reverb and bass are limited here. Speed still works."
    );
  }

  function playerBreaksOnCapture() {
    return /(^|\.)music\.amazon\./.test(window.location.hostname);
  }

  function playerBreaksOnReload() {
    return typeof window.MusicKit !== "undefined";
  }

  // Opt an element into CORS mode before its first fetch of a cross-origin
  // URL, so its audio is never tainted and reverb needs no later reload.
  // Anonymous mode sends no cookies; if the server refuses the request, the
  // error listener undoes the opt-in and loads plain, once per element.
  function maybePreemptCors(element, value) {
    if (element.crossOrigin) return;
    if (corsFallback.has(element)) return;
    if (typeof value !== "string" || value === "") return;
    if (EXEMPT_SCHEMES.some((scheme) => value.startsWith(scheme))) return;

    try {
      if (new URL(value, document.baseURI).origin === window.location.origin) {
        return;
      }
    } catch (error) {
      return; // not a parseable URL; leave it alone
    }

    if (!corsPreempted.has(element)) {
      element.addEventListener("error", () => {
        // Only undo a fetch that failed outright before any data arrived;
        // mid-play network errors are not ours to handle.
        if (!corsPreempted.has(element)) return;
        if (element.readyState !== 0) return;
        corsPreempted.delete(element);
        corsFallback.add(element);
        const source = element.currentSrc || element.src;
        element.removeAttribute("crossorigin");
        if (source) {
          element.src = source;
          element.load();
        }
      });
    }
    corsPreempted.add(element);
    element.crossOrigin = "anonymous";
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
    if (playerBreaksOnCapture()) {
      warnStrictOnce();
      return;
    }
    if (playerBreaksOnReload() && needsCrossOriginOptIn(element)) {
      warnStrictOnce();
      return;
    }
    // The page's graph carries it; our destination patch adds the reverb.
    if (pageOwnedElements.has(element)) return;

    if (element.mediaKeys) {
      markElementDrm(element);
      if (DRM_REVERB_GUARD) return;
    }

    ensureOwnGraph();
    if (ownContext.state === "suspended") {
      await ownContext.resume().catch(() => {});
    }

    if (needsCrossOriginOptIn(element)) {
      // The CORS reload rips the element out from under the site's player;
      // never do that while other audio is playing (e.g. a hover preview next
      // to a live main track). Not marked unusable: a later solo play can
      // still get reverb.
      if (anyOtherElementPlaying(element)) return;

      const granted = await reloadWithCrossOrigin(element);
      if (!granted) {
        unusableElements.add(element);
        console.warn(
          "[Slow and Reverb] Site refused a cross-origin audio request; " +
            "reverb unavailable here. Speed still works."
        );
        return;
      }
      // The reload reset the rate; this element is confirmed non-DRM.
      makeRateEligible(element);
    }

    if (connectedElements.has(element)) return; // connected while awaiting

    try {
      const source = origCreateMediaElementSource.call(ownContext, element);
      const chain = getChain(ownContext);
      origConnect.call(source, chain.input);
      connectedElements.add(element);
      console.log("[Slow and Reverb] reverb connected to a media element");
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
        bufferSourceRefs.add(new WeakRef(node));
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
      // new Audio(url) bypasses the src setter hook; the fetch has not
      // started yet, so the opt-in still lands in time.
      if (args.length > 0) maybePreemptCors(element, String(args[0]));
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
        maybePreemptCors(this, value);
        return srcDescriptor.set.call(this, value);
      },
      configurable: true,
      enumerable: srcDescriptor.enumerable,
    });
  }

  // Players rewrite playbackRate at any moment; the ratechange listener
  // catches most of it, this catches the rest.
  setInterval(() => {
    if (speedElementRefs.size > 0 || bufferSourceRefs.size > 0) applyRate();
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
      bassBoost = data.bassBoost || 0;
      applySettings();
    }
  });

  // ------------------------------------------------------------- diagnostics
  // Run __slowAndReverbDebug() in the console to see what the engine holds.
  window.__slowAndReverbDebug = function () {
    return {
      settings: { isExtensionOn, playbackRate, reverbMix, bassBoost },
      contexts: [...chains.keys()].map((context) => ({
        state: context.state,
        sampleRate: context.sampleRate,
        own: context === ownContext,
      })),
      liveBufferSources: [...liveRefs(bufferSourceRefs)].length,
      elements: [...liveRefs(speedElementRefs)].map((element) => ({
        tag: element.tagName,
        drm: drmElements.has(element),
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
})();
