let isExtensionOn = true;

//Update header
function updateStatus(status) {
  const statusText = document.getElementById('status-text');
  const statusIcon = document.getElementById('status-icon');

  statusText.innerText = status;

  if (status === 'No audio detected!') {
    statusIcon.src = 'icons/noAudio.svg';
    document.body.classList.add('no-audio');
    document.body.classList.remove('extension-off');

  } else if (status === 'Audio paused!') {
    statusIcon.src = 'icons/pause.svg'; //TODO: replace placeholder icon
    document.body.classList.remove('no-audio', 'extension-off');

  } else if (status === 'Extension is off!') {
    statusIcon.src = 'icons/off.svg';
    document.body.classList.add('extension-off');
    document.body.classList.remove('no-audio');

  } else {
    statusIcon.src = 'icons/playing.svg';
    document.body.classList.remove('no-audio', 'extension-off');

  }
}

function getAudioStatus() {
  browser.tabs.query({ active: true, currentWindow: true}).then((tabs) => {
    const activeTab = tabs[0];
    browser.tabs.sendMessage(activeTab.id, { type: 'getAudioStatus' }).then((response) => {

      if (response.status == 'playing') {
        updateStatus(`${response.audioName}`);

      } else if (response.status == 'noAudio') {
        updateStatus(`No audio detected!`);

      } else if (response.status == 'audioDetected') {
        updateStatus(`Audio paused!`);

      } else if (response.status == 'extensionOff') {
        updateStatus(`Extension is off!`);

      }
    }).catch((error) => {
      console.error(`Error getting audio status from tab ${activeTab.id}: ${error}`);
    });
  });
}

function toggleExtension() {
  if (isExtensionOn) { 
    //extension on -> off
    isExtensionOn = false;
    changePlaybackRate(1.0);
    changeReverbMix(0.0);
    updateStatus('Extension is off!');
    browser.storage.local.set({ isExtensionOn: false });
  } else{
    //extension off -> on
    isExtensionOn = true 
    browser.storage.local.set({ isExtensionOn: true });
    const rateSlider = document.getElementById('rate-slider');
    const reverbSlider = document.getElementById('reverb-slider');
    changePlaybackRate(parseFloat(rateSlider.value));
    changeReverbMix(parseFloat(reverbSlider.value));
    getAudioStatus();
    document.body.classList.remove('extension-off');
  }
}

function rateDefault() {
  const defaultRate = 1.0;


  const rateSlider = document.getElementById('rate-slider');
  const rateValueLabel = document.getElementById('rate-value');


  changePlaybackRate(defaultRate);

  storePlaybackRate(defaultRate);


  rateSlider.value = defaultRate;
  rateValueLabel.innerText = `${defaultRate.toFixed(2)}`;

}

function reverbDefault() {
  const defaultReverbMix = 0.0;

  const reverbSlider = document.getElementById('reverb-slider');
  const reverbValueLabel = document.getElementById('reverb-value');

  changeReverbMix(defaultReverbMix);
  storeReverbMix(defaultReverbMix);

  reverbSlider.value = defaultReverbMix;
  reverbValueLabel.innerText = `${defaultReverbMix.toFixed(2)}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const defaultRate = 1.0;
  const defaultReverbMix = 0.0;
  const rateSlider = document.getElementById('rate-slider');
  const rateValueLabel = document.getElementById('rate-value');
  const reverbSlider = document.getElementById('reverb-slider');
  const reverbValueLabel = document.getElementById('reverb-value');

  // Load the extension state and stored settings from storage
  browser.storage.local.get(['isExtensionOn', 'playbackRate', 'reverbMix']).then((result) => {
    isExtensionOn = result.isExtensionOn !== undefined ? result.isExtensionOn : true;
    const storedRate = result.playbackRate || defaultRate;
    const storedReverbMix = result.reverbMix || defaultReverbMix;

    rateSlider.value = storedRate;
    rateValueLabel.innerText = `${storedRate.toFixed(2)}`;
    reverbSlider.value = storedReverbMix;
    reverbValueLabel.innerText = `${storedReverbMix.toFixed(2)}`;

    if (isExtensionOn) {
      changePlaybackRate(parseFloat(storedRate));
      changeReverbMix(parseFloat(storedReverbMix));
      getAudioStatus();
    } else {
      document.body.classList.add('extension-off');
      updateStatus('Extension is off!');
    }
  });

  rateSlider.addEventListener('input', (event) => {
    if (isExtensionOn) {
      const newRate = parseFloat(event.target.value).toFixed(2);
      rateValueLabel.innerText = `${newRate}`;
      changePlaybackRate(parseFloat(newRate));
      storePlaybackRate(parseFloat(newRate));
    }
  });

  reverbSlider.addEventListener('input', (event) => {
    if (isExtensionOn) {
      const newReverbMix = parseFloat(event.target.value).toFixed(2);
      reverbValueLabel.innerText = `${newReverbMix}`;
      changeReverbMix(parseFloat(newReverbMix));
      storeReverbMix(parseFloat(newReverbMix));
    }
  });

  const toggleButton = document.getElementById("toggle-button");
  toggleButton.addEventListener('click', toggleExtension);

  const resetRateButton = document.getElementById("reset-rate");
  resetRateButton.addEventListener('click', rateDefault);

  const resetReverbButton = document.getElementById("reset-reverb");
  resetReverbButton.addEventListener('click', reverbDefault);
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
