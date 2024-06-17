// content.js

let audioContext;
let gainNode;

function initializeAudio() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(1, audioContext.currentTime); // Initial gain
  console.log('Audio context initialized.');
}

initializeAudio();

function connectMediaElement(element) {
  if (!element.sourceNode) {
    const sourceNode = audioContext.createMediaElementSource(element);
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
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

function connectMediaElements() {
  const mediaElements = document.querySelectorAll('video, audio');
  mediaElements.forEach((element) => {
    connectMediaElement(element);
  });
}

connectMediaElements();

// Reconnect media elements when new ones are added to the DOM
const observer = new MutationObserver(connectMediaElements);
observer.observe(document.body, { childList: true, subtree: true });

// Reconnect media elements on playback start (if not already connected)
document.querySelectorAll('video, audio').forEach((element) => {
  element.addEventListener('play', () => {
    connectMediaElements();
  });
});

// Listen for messages from the popup or background script
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'updatePlaybackRate') {
    updatePlaybackRate(message.playbackRate);
  }
});