// popup.js

document.addEventListener('DOMContentLoaded', () => {
  // Retrieve the saved playback rate from storage
  browser.storage.local.get('playbackRate').then((result) => {
    const savedRate = result.playbackRate !== undefined ? result.playbackRate : 1.0;
    const rateSlider = document.getElementById('rate-slider');
    const rateValueLabel = document.getElementById('rate-value');

    // Set the slider's value and label to the saved value
    rateSlider.value = savedRate;
    rateValueLabel.innerText = `${savedRate.toFixed(2)}x`;
  });

  document.getElementById('rate-slider').addEventListener('input', (event) => {
    const newRate = parseFloat(event.target.value).toFixed(2);
    document.getElementById('rate-value').innerText = `${newRate}x`;
    changePlaybackRate(parseFloat(newRate));
  });
});

function changePlaybackRate(rate) {
  console.log(`Changing playback rate to: ${rate}`);
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    browser.tabs.sendMessage(activeTab.id, { type: 'updatePlaybackRate', playbackRate: rate }).then(() => {
      console.log(`Message sent to tab ${activeTab.id}`);
    }).catch((error) => {
      console.error(`Error sending message to tab ${activeTab.id}: ${error}`);
    });
    browser.storage.local.set({ playbackRate: rate }); // Save the rate to storage
  });
}
