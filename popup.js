document.addEventListener('DOMContentLoaded', () => {
  const defaultRate = 1.0;
  const defaultReverbMix = 0.0;

  const rateSlider = document.getElementById('rate-slider');
  const rateValueLabel = document.getElementById('rate-value');
  const reverbSlider = document.getElementById('reverb-slider');
  const reverbValueLabel = document.getElementById('reverb-value');

  // Set the slider's value and label to the default values
  browser.storage.local.get(['playbackRate', 'reverbMix']).then((result) => {
    const storedRate = result.playbackRate || defaultRate;
    const storedReverbMix = result.reverbMix || defaultReverbMix;

    rateSlider.value = storedRate;
    rateValueLabel.innerText = `${storedRate.toFixed(2)}x`;
    reverbSlider.value = storedReverbMix;
    reverbValueLabel.innerText = `${storedReverbMix.toFixed(2)}`;

    changePlaybackRate(parseFloat(storedRate));
    changeReverbMix(parseFloat(storedReverbMix));
  });

  rateSlider.addEventListener('input', (event) => {
    const newRate = parseFloat(event.target.value).toFixed(2);
    rateValueLabel.innerText = `${newRate}x`;
    changePlaybackRate(parseFloat(newRate));
    storePlaybackRate(parseFloat(newRate));
  });

  reverbSlider.addEventListener('input', (event) => {
    const newReverbMix = parseFloat(event.target.value).toFixed(2);
    reverbValueLabel.innerText = `${newReverbMix}`;
    changeReverbMix(parseFloat(newReverbMix));
    storeReverbMix(parseFloat(newReverbMix));
  });
});

function storePlaybackRate(rate) {
  browser.storage.local.set({ playbackRate: rate });
}

function storeReverbMix(mix) {
  browser.storage.local.set({ reverbMix: mix });
}

function changePlaybackRate(rate) {
  console.log(`Changing playback rate to: ${rate}`);
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    browser.tabs.sendMessage(activeTab.id, { type: 'updatePlaybackRate', playbackRate: rate }).then(() => {
      console.log(`Message sent to tab ${activeTab.id}`);
    }).catch((error) => {
      console.error(`Error sending message to tab ${activeTab.id}: ${error}`);
    });
  });
}

function changeReverbMix(mix) {
  console.log(`Changing reverb mix to: ${mix}`);
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const activeTab = tabs[0];
    browser.tabs.sendMessage(activeTab.id, { type: 'updateReverbWetMix', reverbWetMix: mix }).then(() => {
      console.log(`Message sent to tab ${activeTab.id}`);
    }).catch((error) => {
      console.error(`Error sending message to tab ${activeTab.id}: ${error}`);
    });
  });
}
