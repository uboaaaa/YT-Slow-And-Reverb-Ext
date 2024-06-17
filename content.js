// content.js

function updatePlaybackSpeed(newSpeed) {
    const mediaElements = document.querySelectorAll('video, audio');
    mediaElements.forEach((element) => {
      element.playbackRate = newSpeed;
      element.preservesPitch = false;
    });

    browser.storage.local.set({playbackSpeed: newSpeed});
  }
  
  // Listen for messages from the popup or background script
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'updatePlaybackSpeed') {
      updatePlaybackSpeed(message.playbackSpeed);
    }
  });

  browser.storage.local.get('playbackSpeed').then((result) => {
    if (result.playbackSpeed !== undefined) {
        updatePlaybackSpeed(result.playbackSpeed);
    }
  });
  