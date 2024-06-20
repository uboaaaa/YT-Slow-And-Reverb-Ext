/* TODO:
 *  Initialize audio context*
 *  Create convolver, dry and wet nodes*
 *  Connect all media sources to input nodes*
 *  Account for dynamic additions to media sources*
 */

let audioContext;
let dryGainNode;
let wetGainNode;
let convolverNode;

const DECAY_TIME_SECONDS = 4; //TODO: fine tune reverb
const PRE_DELAY_SECONDS = 0.05;
const CHANNEL_COUNT = 2;

// Create white noise for IR, then convolver
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

// Updating functions
function updatePlaybackRate(newPlaybackRate) {
  const mediaElements = document.querySelectorAll("video, audio");
  mediaElements.forEach((element) => {
    if (element.sourceNode) {
      element.playbackRate = newPlaybackRate;
      console.log(
        `Playback rate updated to ${newPlaybackRate} for element: ${element.tagName}`
      );
    }
  });
}

function updateReverbWetMix(wetValue) {
  const dryValue = Math.cos((wetValue * Math.PI) / 2);
  const wetValueAdjusted = Math.sin((wetValue * Math.PI) / 2);
  dryGainNode.gain.setValueAtTime(dryValue, audioContext.currentTime);
  wetGainNode.gain.setValueAtTime(wetValueAdjusted, audioContext.currentTime);
  console.log(
    `Reverb wet mix updated: dry = ${dryValue}, wet = ${wetValueAdjusted}`
  );
}

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
    //connectMediaElements();
  });

  // Stop reverb when audio is paused
  element.addEventListener("pause", () => {
    wetGainNode.gain.setValueAtTime(0, audioContext.currentTime);
    console.log(`Reverb val ${wetGainNode.gain.value}`);
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
browser.runtime.onMessage.addListener((message, sendResponse) => {
  if (message.type === "updatePlaybackRate") {
    updatePlaybackRate(message.playbackRate);
  } else if (message.type === "updateReverbWetMix") {
    updateReverbWetMix(message.reverbWetMix);
  }

  if (message.type === "getAudioStatus") {
    sendResponse(getAudioStatus());
  }
});
