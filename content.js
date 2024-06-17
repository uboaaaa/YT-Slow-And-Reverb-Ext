let audioContext;
let dryGainNode;
let wetGainNode;
let convolverNode;

const DECAY_TIME_SECONDS = 3;
const PRE_DELAY_SECONDS = 0.05;
const CHANNEL_COUNT = 2;

// Function to create white noise buffer
const createWhiteNoiseBuffer = (audioContext) => {
  const buffer = audioContext.createBuffer(
    CHANNEL_COUNT,
    (DECAY_TIME_SECONDS + PRE_DELAY_SECONDS) * audioContext.sampleRate,
    audioContext.sampleRate
  );
  for (let channelNum = 0; channelNum < CHANNEL_COUNT; channelNum++) {
    const channelData = buffer.getChannelData(channelNum);
    for (let i = 0; i < channelData.length; i++) {
      channelData[i] = Math.random() * 2 - 1;
    }
  }
  return buffer;
};

// Function to create impulse response
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
  gain.gain.setValueAtTime(1, PRE_DELAY_SECONDS);
  gain.gain.exponentialRampToValueAtTime(0.00001, DECAY_TIME_SECONDS + PRE_DELAY_SECONDS);

  bufferSource.connect(gain);
  gain.connect(offlineContext.destination);

  bufferSource.start(0);
  const renderedBuffer = await offlineContext.startRendering();
  return renderedBuffer;
};

// Initialize audio context and nodes
async function initializeAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  console.log('Audio context created.');

  // Create Gain nodes
  dryGainNode = audioContext.createGain();
  wetGainNode = audioContext.createGain();
  dryGainNode.gain.setValueAtTime(1, audioContext.currentTime); // Start with dry signal only
  wetGainNode.gain.setValueAtTime(0, audioContext.currentTime); // No reverb at start

  // Connect Gain nodes to destination
  dryGainNode.connect(audioContext.destination);
  wetGainNode.connect(audioContext.destination);

  // Create Convolver node and load impulse response
  const impulseBuffer = await createImpulseResponse(audioContext);
  convolverNode = audioContext.createConvolver();
  convolverNode.buffer = impulseBuffer;

  // Connect Convolver node to wet Gain node
  convolverNode.connect(wetGainNode);

  console.log('Audio context and nodes initialized.');
}

initializeAudio();

function connectMediaElement(element) {
  if (!element.sourceNode) {
    const sourceNode = audioContext.createMediaElementSource(element);
    
    // Connect source node to both dry and wet paths
    sourceNode.connect(dryGainNode);
    sourceNode.connect(convolverNode);

    element.sourceNode = sourceNode;
    element.preservesPitch = false; // Disable pitch preservation
    console.log(`Media element connected: ${element.tagName}`);
  }
}

function updatePlaybackRate(newPlaybackRate) {
  const mediaElements = document.querySelectorAll('video, audio');
  mediaElements.forEach((element) => {
    if (element.sourceNode) {
      element.playbackRate = newPlaybackRate;
      console.log(`Playback rate updated to ${newPlaybackRate} for element: ${element.tagName}`);
    }
  });
}

function updateReverbWetMix(wetValue) {
  const dryValue = 1 - wetValue;
  const compensationValue = Math.sqrt(dryValue);

  dryGainNode.gain.setValueAtTime(dryValue * compensationValue, audioContext.currentTime);
  wetGainNode.gain.setValueAtTime(wetValue, audioContext.currentTime);
  console.log(`Reverb wet mix updated: dry = ${dryValue * compensationValue}, wet = ${wetValue}`);
}

function connectMediaElements() {
  const mediaElements = document.querySelectorAll('video, audio');
  mediaElements.forEach((element) => {
    connectMediaElement(element);
  });
}

// Reconnect media elements when new ones are added to the DOM
const observer = new MutationObserver(connectMediaElements);
observer.observe(document.body, { childList: true, subtree: true });
console.log('Mutation observer set up.');

// Reconnect media elements on playback start (if not already connected)
document.querySelectorAll('video, audio').forEach((element) => {
  element.addEventListener('play', () => {
    connectMediaElements();
  });
});
console.log('Event listeners set up.');

// Listen for messages from the popup or background script
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'updatePlaybackRate') {
    updatePlaybackRate(message.playbackRate);
  } else if (message.type === 'updateReverbWetMix') {
    updateReverbWetMix(message.reverbWetMix);
  }
  console.log('Message received:', message);
});
