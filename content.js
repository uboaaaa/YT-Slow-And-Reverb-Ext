let audioContext;
let dryGainNode;
let wetGainNode;
let convolverNode;

const DECAY_TIME_SECONDS = 4;
const PRE_DELAY_SECONDS = 0.05;
const CHANNEL_COUNT = 2;

const createWhiteNoiseBuffer = (audioContext) => {
  const bufferLength =
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate;
  const buffer = audioContext.createBuffer(
    CHANNEL_COUNT,
    bufferLength,
    audioContext.sampleRate
  );

  for (let i = 0; i < bufferLength; i++) {
    for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
      const channelData = buffer.getChannelData(channel);
      channelData[i] = Math.random() * 2 - 1;
    }
  }

  return buffer;
};

const createImpulseResponse = async (audioContext) => {
  //adapted from chrome extension
  const offlineContext = new OfflineAudioContext(
    CHANNEL_COUNT,
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate,
    audioContext.sampleRate
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
  const renderedBuffer = await offlineContext.startRendering();
  return renderedBuffer;
};

// Initialize audio context and nodes
// media --> dry --> output
// media --> convolver --> wet --> output (reverb adjustment path)
async function initializeAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // Create Gain nodes
  dryGainNode = audioContext.createGain();
  wetGainNode = audioContext.createGain();
  dryGainNode.gain.setValueAtTime(1, audioContext.currentTime); // Start with dry signal only
  wetGainNode.gain.setValueAtTime(0, audioContext.currentTime); // No reverb at start

  // Connect Gain nodes to destination
  dryGainNode.connect(audioContext.destination);
  wetGainNode.connect(audioContext.destination);

  // Create Convolver node and load IR
  const impulseBuffer = await createImpulseResponse(audioContext);
  convolverNode = audioContext.createConvolver();
  convolverNode.buffer = impulseBuffer;

  // Connect Convolver node to wet Gain node
  convolverNode.connect(wetGainNode);
}

initializeAudio();

function connectMediaElement(element) {
  if (!element.sourceNode) {
    const sourceNode = audioContext.createMediaElementSource(element);

    // Connect source node to both dry and wet paths
    sourceNode.connect(dryGainNode);
    sourceNode.connect(convolverNode);

    element.sourceNode = sourceNode;
    element.preservesPitch = false;
  }
}

// Updating functions
function updatePlaybackRate(newPlaybackRate) {
  const mediaElements = document.querySelectorAll("video, audio");
  mediaElements.forEach((element) => {
    if (element.sourceNode) {
      element.playbackRate = newPlaybackRate;
    }
  });
}

function updateReverbWetMix(wetValue) {
  //TODO: recheck reverb method
  const dryValue = Math.cos((wetValue * Math.PI) / 2);
  const wetValueAdjusted = Math.sin((wetValue * Math.PI) / 2);

  dryGainNode.gain.setValueAtTime(dryValue, audioContext.currentTime);
  wetGainNode.gain.setValueAtTime(wetValueAdjusted, audioContext.currentTime);
}

function connectMediaElements() {
  const mediaElements = document.querySelectorAll("video, audio");
  mediaElements.forEach((element) => {
    connectMediaElement(element);
  });
}

// Reconnect media elements when new ones are added to the DOM
const observer = new MutationObserver(connectMediaElements);
observer.observe(document.body, { childList: true, subtree: true });

// Reconnect media elements on playback start (if not already connected)
document.querySelectorAll("video, audio").forEach((element) => {
  element.addEventListener("play", () => {
    connectMediaElements();
  });
});

// Make playbackRate and reverb mix persist across pages
document.querySelectorAll("video, audio").forEach((element) => {
  element.addEventListener("play", () => {
    browser.storage.local
      .get(["isExtensionOn", "playbackRate", "reverbMix"])
      .then((result) => {
        if (result.isExtensionOn) {
          const storedReverbMix = result.reverbMix || 0;
          const storedPlaybackRate = result.playbackRate || 1.0;
          updateReverbWetMix(storedReverbMix);
          updatePlaybackRate(storedPlaybackRate);
        }
      });
    connectMediaElements();
  });

  // Stop reverb when audio is paused
  element.addEventListener("pause", () => {
    wetGainNode.gain.setValueAtTime(0, audioContext.currentTime);
  });
});

// Get audio status
function getAudioStatus() {
  const audioElements = document.querySelectorAll("video, audio");
  if (audioElements.length === 0) {
    return { status: "noAudio" };
  }

  for (const element of audioElements) {
    if (!element.paused) {
      return { status: "playing", audioName: document.title || "Unknown" };
    }
  }

  return { status: "audioDetected" };
}

// Listen for messages from the popup or background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "updatePlaybackRate") {
    updatePlaybackRate(message.playbackRate);
  } else if (message.type === "updateReverbWetMix") {
    updateReverbWetMix(message.reverbWetMix);
  }

  if (message.type === "getAudioStatus") {
    sendResponse(getAudioStatus());
  }
});
