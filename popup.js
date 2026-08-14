// Popup: renders the controls and writes settings to storage. Content scripts
// in every frame react to storage changes; nothing is messaged directly.

// One entry per slider; wireSlider() attaches all behavior from this table.
const SLIDERS = [
  { id: "rate", storageKey: "playbackRate", presetKey: "rate", default: 1.0 },
  { id: "reverb", storageKey: "reverbMix", presetKey: "mix", default: 0.0 },
  { id: "bass", storageKey: "bassBoost", presetKey: "bass", default: 0.0 },
];

const PRESETS = {
  slowrev: { rate: 0.85, mix: 0.5, bass: 0.0 },
  default: { rate: 1.0, mix: 0.0, bass: 0.0 },
  nightcore: { rate: 1.35, mix: 0.0, bass: 0.0 },
};

// How long to wait for a frame to answer the DRM query before giving up.
const STATUS_TIMEOUT_MS = 400;

let isExtensionOn = true;

function sliderElements(config) {
  return {
    slider: document.getElementById(config.id + "-slider"),
    label: document.getElementById(config.id + "-value"),
    container: document.getElementById(config.id + "-slider-container"),
  };
}

// Update the slider UI and persist the value.
function setSlider(config, value) {
  const { slider, label } = sliderElements(config);
  slider.value = value;
  label.innerText = value.toFixed(2);
  browser.storage.local.set({ [config.storageKey]: value });
}

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
  const current = {};
  SLIDERS.forEach((config) => {
    current[config.presetKey] = parseFloat(sliderElements(config).slider.value);
  });

  document.querySelectorAll(".preset-btn").forEach((button) => {
    const preset = PRESETS[button.dataset.preset];
    button.classList.toggle(
      "is-active",
      !!preset &&
        SLIDERS.every(
          (config) =>
            Math.abs(preset[config.presetKey] - current[config.presetKey]) <
            0.001
        )
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
      SLIDERS.forEach((config) => {
        sliderElements(config).container.title = explanation;
      });
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

  SLIDERS.forEach((config) => setSlider(config, preset[config.presetKey]));
  updateActivePreset();
}

function wireSlider(config) {
  const { slider, label, container } = sliderElements(config);

  slider.addEventListener("input", () => {
    if (!isExtensionOn) return;
    const value = parseFloat(slider.value);
    label.innerText = value.toFixed(2);
    browser.storage.local.set({ [config.storageKey]: value });
    updateActivePreset();
  });

  document.getElementById("reset-" + config.id).addEventListener("click", () => {
    setSlider(config, config.default);
    updateActivePreset();
  });

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

      setSlider(config, next);
      updateActivePreset();
    },
    { passive: false }
  );
}

document.addEventListener("DOMContentLoaded", () => {
  browser.storage.local
    .get(["isExtensionOn", ...SLIDERS.map((config) => config.storageKey)])
    .then((result) => {
      isExtensionOn =
        result.isExtensionOn !== undefined ? result.isExtensionOn : true;

      // Write the default only on a genuine first run, so an "off" state that
      // was saved earlier survives reopening the popup.
      if (result.isExtensionOn === undefined) {
        browser.storage.local.set({ isExtensionOn: true });
      }

      SLIDERS.forEach((config) => {
        const value = result[config.storageKey] || config.default;
        const { slider, label } = sliderElements(config);
        slider.value = value;
        label.innerText = value.toFixed(2);
      });

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

  SLIDERS.forEach(wireSlider);

  document.querySelectorAll(".preset-btn").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  document
    .getElementById("toggle-button")
    .addEventListener("click", toggleExtension);
});
