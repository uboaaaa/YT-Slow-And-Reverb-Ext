// Popup: renders the controls and writes settings to storage. Content scripts
// in every frame react to storage changes; nothing is messaged directly.
//
// The bass slider is a visual placeholder: its label updates, but nothing is
// stored or applied yet.

const DEFAULT_RATE = 1.0;
const DEFAULT_REVERB_MIX = 0.0;

// A preset is just a hand moving both sliders at once: same storage writes,
// same gating. The engine has no idea presets exist.
const PRESETS = {
  slowrev: { rate: 0.85, mix: 0.5 },
  default: { rate: DEFAULT_RATE, mix: DEFAULT_REVERB_MIX },
  nightcore: { rate: 1.35, mix: 0.0 },
};

// How long to wait for a frame to answer the DRM query before giving up.
const STATUS_TIMEOUT_MS = 400;

let isExtensionOn = true;

// Dot, toggle label, and dimming all follow the on/off state.
function updateVisualState() {
  document
    .getElementById("status-dot")
    .classList.toggle("is-off", !isExtensionOn);
  document.body.classList.toggle("extension-off", !isExtensionOn);

  const toggleButton = document.getElementById("toggle-button");
  const label = isExtensionOn ? "Turn off" : "Turn on";
  toggleButton.title = label;
  toggleButton.setAttribute("aria-label", label);
}

// Highlight the preset matching the current slider values, if any.
function updateActivePreset() {
  const rate = parseFloat(document.getElementById("rate-slider").value);
  const mix = parseFloat(document.getElementById("reverb-slider").value);

  document.querySelectorAll(".preset-btn").forEach((button) => {
    const preset = PRESETS[button.dataset.preset];
    button.classList.toggle(
      "is-active",
      !!preset &&
        Math.abs(preset.rate - rate) < 0.001 &&
        Math.abs(preset.mix - mix) < 0.001
    );
  });
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
        document.getElementById("status-text").innerText = "Lento";
        refreshDrmState();
      }
    })
    .catch(() => {});
}

// DRM-protected pages get no effects (the site's player may break playback if
// touched); dim the controls and say why.
function refreshDrmState() {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    if (!activeTab) return;

    // Frames without media deliberately do not reply, so race a timer.
    const askFrames = browser.tabs
      .sendMessage(activeTab.id, { type: "getAudioStatus" })
      .catch(() => null);

    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), STATUS_TIMEOUT_MS)
    );

    Promise.race([askFrames, timeout]).then((response) => {
      const drmBlocked = !!(response && response.drmBlocked);
      document.body.classList.toggle("drm-blocked", drmBlocked);

      const explanation = drmBlocked
        ? "This site's audio is DRM-protected; its player may break playback " +
          "when effects are applied, so the controls are disabled."
        : "";
      document.getElementById("rate-slider-container").title = explanation;
      document.getElementById("reverb-slider-container").title = explanation;
      document.getElementById("bass-slider-container").title = explanation;
    });
  });
}

function toggleExtension() {
  isExtensionOn = !isExtensionOn;

  // Only the on/off flag is written. The stored rate and mix are left alone so
  // that switching back on restores the slider positions.
  browser.storage.local.set({ isExtensionOn });

  updateVisualState();
  if (isExtensionOn) refreshDrmState();
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

  updateActivePreset();
}

document.addEventListener("DOMContentLoaded", () => {
  const rateSlider = document.getElementById("rate-slider");
  const rateValueLabel = document.getElementById("rate-value");
  const reverbSlider = document.getElementById("reverb-slider");
  const reverbValueLabel = document.getElementById("reverb-value");
  const bassSlider = document.getElementById("bass-slider");
  const bassValueLabel = document.getElementById("bass-value");

  // Load the extension state and stored settings from storage.
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
      rateValueLabel.innerText = storedRate.toFixed(2);
      reverbSlider.value = storedReverbMix;
      reverbValueLabel.innerText = storedReverbMix.toFixed(2);

      updateVisualState();
      updateActivePreset();

      if (!isExtensionOn) return;

      checkSiteAccess().then((hasAccess) => {
        if (hasAccess) {
          refreshDrmState();
        } else {
          document.body.classList.add("no-access");
          document.getElementById("status-text").innerText =
            "click to grant access";
        }
      });
    });

  document.querySelector("header").addEventListener("click", () => {
    if (document.body.classList.contains("no-access")) {
      requestSiteAccess();
    }
  });

  rateSlider.addEventListener("input", (event) => {
    if (!isExtensionOn) return;
    const newRate = parseFloat(event.target.value);
    rateValueLabel.innerText = newRate.toFixed(2);
    storePlaybackRate(newRate);
    updateActivePreset();
  });

  reverbSlider.addEventListener("input", (event) => {
    if (!isExtensionOn) return;
    const newReverbMix = parseFloat(event.target.value);
    reverbValueLabel.innerText = newReverbMix.toFixed(2);
    storeReverbMix(newReverbMix);
    updateActivePreset();
  });

  // Placeholder: label only, no storage, no effect.
  bassSlider.addEventListener("input", (event) => {
    bassValueLabel.innerText = parseFloat(event.target.value).toFixed(2);
  });

  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  // Scroll-wheel nudging: one step per notch, through the same path as a drag.
  // Listens on the whole container; the thin track is a poor wheel target.
  const addWheelSupport = (container, slider, label, store) => {
    container.addEventListener(
      "wheel",
      (event) => {
        if (!isExtensionOn) return;
        event.preventDefault();

        const step = parseFloat(slider.step) || 0.05;
        const direction = event.deltaY < 0 ? 1 : -1;
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);

        // Round to cents so repeated steps don't accumulate float dust.
        const next =
          Math.round(
            Math.min(
              max,
              Math.max(min, parseFloat(slider.value) + direction * step)
            ) * 100
          ) / 100;

        slider.value = next;
        label.innerText = next.toFixed(2);
        store(next);
        updateActivePreset();
      },
      { passive: false }
    );
  };

  addWheelSupport(
    document.getElementById("rate-slider-container"),
    rateSlider,
    rateValueLabel,
    storePlaybackRate
  );
  addWheelSupport(
    document.getElementById("reverb-slider-container"),
    reverbSlider,
    reverbValueLabel,
    storeReverbMix
  );

  document.getElementById("toggle-button").addEventListener("click", toggleExtension);

  document.getElementById("reset-rate").addEventListener("click", () => {
    storePlaybackRate(DEFAULT_RATE);
    rateSlider.value = DEFAULT_RATE;
    rateValueLabel.innerText = DEFAULT_RATE.toFixed(2);
    updateActivePreset();
  });

  document.getElementById("reset-reverb").addEventListener("click", () => {
    storeReverbMix(DEFAULT_REVERB_MIX);
    reverbSlider.value = DEFAULT_REVERB_MIX;
    reverbValueLabel.innerText = DEFAULT_REVERB_MIX.toFixed(2);
    updateActivePreset();
  });

  // Placeholder: resets the label only.
  document.getElementById("reset-bass").addEventListener("click", () => {
    bassSlider.value = 0;
    bassValueLabel.innerText = "0.00";
  });
});

function storePlaybackRate(rate) {
  browser.storage.local.set({ playbackRate: rate });
}

function storeReverbMix(mix) {
  browser.storage.local.set({ reverbMix: mix });
}
