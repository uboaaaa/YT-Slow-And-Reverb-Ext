// Popup: renders the controls and writes settings to storage.
//
// It does not message the content script to apply settings. Content scripts in
// every frame listen for storage changes instead, which reaches media inside
// iframes that the popup has no easy way to address.

const DEFAULT_RATE = 1.0;
const DEFAULT_REVERB_MIX = 0.0;

// A preset is just a hand moving both sliders at once: same storage writes,
// same gating. The engine has no idea presets exist.
const PRESETS = {
  slowrev: { rate: 0.75, mix: 0.7 },
  default: { rate: DEFAULT_RATE, mix: DEFAULT_REVERB_MIX },
  nightcore: { rate: 1.35, mix: 0.0 },
};

// How long to wait for a frame that has media to answer before deciding the
// page has none.
const STATUS_TIMEOUT_MS = 400;

let isExtensionOn = true;

//Update header
function updateStatus(status) {
  const statusText = document.getElementById("status-text");
  const statusIcon = document.getElementById("status-icon");

  statusText.innerText = status;

  if (status === "No audio detected!") {
    statusIcon.src = "icons/noAudio.svg";
    document.body.classList.add("no-audio");
    document.body.classList.remove("extension-off");
  } else if (status === "Click here to grant site access!") {
    // MV3: host permissions are revocable, and nothing works without them.
    // Own class: extension-off would make the header unclickable.
    statusIcon.src = "icons/off.svg";
    document.body.classList.add("no-access");
    document.body.classList.remove("no-audio", "extension-off");
  } else if (status === "Audio paused!") {
    statusIcon.src = "icons/pause.svg"; //TODO: replace placeholder icon
    document.body.classList.remove("no-audio", "extension-off");
  } else if (status === "Extension is off!") {
    statusIcon.src = "icons/off.svg";
    document.body.classList.add("extension-off");
    document.body.classList.remove("no-audio");
  } else {
    statusIcon.src = "icons/playing.svg";
    document.body.classList.remove("no-audio", "extension-off");
  }
}

// MV3 host permissions can be denied or revoked per user choice; without them
// no content script runs and the extension can do nothing on the page.
function checkSiteAccess() {
  return browser.permissions
    .contains({ origins: ["<all_urls>"] })
    .catch(() => false);
}

function requestSiteAccess() {
  // Must be called from a user-gesture handler (the header click).
  browser.permissions
    .request({ origins: ["<all_urls>"] })
    .then((granted) => {
      if (granted) {
        document.body.classList.remove("no-access");
        getAudioStatus();
      }
    })
    .catch(() => {});
}

function getAudioStatus() {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    if (!activeTab) {
      updateStatus("No audio detected!");
      return;
    }

    // Frames without media deliberately do not reply, so this can hang. Race it
    // against a timer rather than waiting forever.
    const askFrames = browser.tabs
      .sendMessage(activeTab.id, { type: "getAudioStatus" })
      .catch(() => null);

    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), STATUS_TIMEOUT_MS)
    );

    Promise.race([askFrames, timeout]).then((response) => {
      if (response && response.status === "playing") {
        updateStatus(`${response.audioName}`);
      } else if (response && response.status === "audioDetected") {
        updateStatus("Audio paused!");
      } else {
        updateStatus("No audio detected!");
      }

      // DRM-protected pages get neither effect (the site's player breaks
      // playback if we touch it); dim both sliders and say why.
      const drmBlocked = !!(response && response.drmBlocked);
      document.body.classList.toggle("drm-blocked", drmBlocked);
      const explanation = drmBlocked
        ? "This site's audio is DRM-protected; its player breaks playback " +
          "when speed or reverb are changed, so the controls are disabled."
        : "";
      document.getElementById("rate-slider-container").title = explanation;
      document.getElementById("reverb-slider-container").title = explanation;
    });
  });
}

function toggleExtension() {
  isExtensionOn = !isExtensionOn;

  // Only the on/off flag is written. The stored rate and mix are left alone so
  // that switching back on restores the slider positions.
  browser.storage.local.set({ isExtensionOn });

  if (isExtensionOn) {
    document.body.classList.remove("extension-off");
    getAudioStatus();
  } else {
    updateStatus("Extension is off!");
  }
}

function applyPreset(name) {
  if (!isExtensionOn) return;

  const preset = PRESETS[name];
  if (!preset) return;

  storePlaybackRate(preset.rate);
  storeReverbMix(preset.mix);

  document.getElementById("rate-slider").value = preset.rate;
  document.getElementById("rate-value").innerText = preset.rate.toFixed(2);
  document.getElementById("reverb-slider").value = preset.mix;
  document.getElementById("reverb-value").innerText = preset.mix.toFixed(2);
}

function rateDefault() {
  const rateSlider = document.getElementById("rate-slider");
  const rateValueLabel = document.getElementById("rate-value");

  storePlaybackRate(DEFAULT_RATE);

  rateSlider.value = DEFAULT_RATE;
  rateValueLabel.innerText = `${DEFAULT_RATE.toFixed(2)}`;
}

function reverbDefault() {
  const reverbSlider = document.getElementById("reverb-slider");
  const reverbValueLabel = document.getElementById("reverb-value");

  storeReverbMix(DEFAULT_REVERB_MIX);

  reverbSlider.value = DEFAULT_REVERB_MIX;
  reverbValueLabel.innerText = `${DEFAULT_REVERB_MIX.toFixed(2)}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const rateSlider = document.getElementById("rate-slider");
  const rateValueLabel = document.getElementById("rate-value");
  const reverbSlider = document.getElementById("reverb-slider");
  const reverbValueLabel = document.getElementById("reverb-value");

  // Load the extension state and stored settings from storage
  browser.storage.local
    .get(["isExtensionOn", "playbackRate", "reverbMix"])
    .then((result) => {
      isExtensionOn =
        result.isExtensionOn !== undefined ? result.isExtensionOn : true;

      // Write the default only on a genuine first run, so an "off" state that
      // was saved earlier survives reopening the popup.
      if (result.isExtensionOn === undefined) {
        browser.storage.local.set({ isExtensionOn: true });
      }

      const storedRate = result.playbackRate || DEFAULT_RATE;
      const storedReverbMix = result.reverbMix || DEFAULT_REVERB_MIX;

      rateSlider.value = storedRate;
      rateValueLabel.innerText = `${storedRate.toFixed(2)}`;
      reverbSlider.value = storedReverbMix;
      reverbValueLabel.innerText = `${storedReverbMix.toFixed(2)}`;

      if (!isExtensionOn) {
        document.body.classList.add("extension-off");
        updateStatus("Extension is off!");
        return;
      }

      checkSiteAccess().then((hasAccess) => {
        if (hasAccess) {
          getAudioStatus();
        } else {
          updateStatus("Click here to grant site access!");
        }
      });
    });

  const header = document.querySelector("header");
  header.addEventListener("click", () => {
    if (document.body.classList.contains("no-access")) {
      requestSiteAccess();
    }
  });

  rateSlider.addEventListener("input", (event) => {
    if (isExtensionOn) {
      const newRate = parseFloat(event.target.value);
      rateValueLabel.innerText = `${newRate.toFixed(2)}`;
      storePlaybackRate(newRate);
    }
  });

  reverbSlider.addEventListener("input", (event) => {
    if (isExtensionOn) {
      const newReverbMix = parseFloat(event.target.value);
      reverbValueLabel.innerText = `${newReverbMix.toFixed(2)}`;
      storeReverbMix(newReverbMix);
    }
  });

  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  const toggleButton = document.getElementById("toggle-button");
  toggleButton.addEventListener("click", toggleExtension);

  const resetRateButton = document.getElementById("reset-rate");
  resetRateButton.addEventListener("click", rateDefault);

  const resetReverbButton = document.getElementById("reset-reverb");
  resetReverbButton.addEventListener("click", reverbDefault);
});

function storePlaybackRate(rate) {
  browser.storage.local.set({ playbackRate: rate });
}

function storeReverbMix(mix) {
  browser.storage.local.set({ reverbMix: mix });
}
