// popup.js

document.addEventListener('DOMContentLoaded', () => {
  // Retrieve the saved playback speed from storage
  browser.storage.local.get('playbackSpeed').then((result) => {
    const savedSpeed = result.playbackSpeed !== undefined ? result.playbackSpeed : 1.0;
    const slider = document.getElementById('speed-slider');
    const speedValueLabel = document.getElementById('speed-value');

    // Set the slider's value and label to the saved speed
    slider.value = savedSpeed;
    speedValueLabel.innerText = `${savedSpeed}x`;
  });

  document.getElementById('speed-slider').addEventListener('input', (event) => {
    const newSpeed = event.target.value;
    document.getElementById('speed-value').innerText = `${newSpeed}x`;
    changePlaybackSpeed(parseFloat(newSpeed));
  });
});

function changePlaybackSpeed(speed) {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    browser.tabs.sendMessage(activeTab.id, { type: 'updatePlaybackSpeed', playbackSpeed: speed });
  });
}
