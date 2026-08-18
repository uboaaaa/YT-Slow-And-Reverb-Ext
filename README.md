# Lento
**Slow, reverb, and bass boost most music-streaming sources on the web. Applied live, right in your browser. **

[![Firefox Add-on](https://img.shields.io/amo/v/lento?label=Firefox%20Add-on&color=FF7139&logo=firefoxbrowser)](https://addons.mozilla.org/en-US/firefox/addon/lento/)
[![AMO Users](https://img.shields.io/amo/users/lento?color=blue)](https://addons.mozilla.org/en-US/firefox/addon/lento/)
[![AMO Rating](https://img.shields.io/amo/rating/lento?color=brightgreen)](https://addons.mozilla.org/en-US/firefox/addon/lento/reviews/)
[![CI](https://github.com/uboaaaa/lento-ext/actions/workflows/ci.yml/badge.svg)](https://github.com/uboaaaa/lento-ext/actions/workflows/ci.yml)

Turn any track on your favorite music-streaming platform into a relaxing slowed-and-reverbed version or a chaotic nightcore one in real time. No downloads, uploads or re-encoding needed. 

## Install
- **Firefox**: [addons.mozilla.org/firefox/addon/lento](https://addons.mozilla.org/en-US/firefox/addon/lento/)
- **Chrome**: currently under review

## Features
- **Speed** (0.5x to 2x) with pitch shift.
- **Reverb** with an equal-power dry/wet mix.
- **Bass boost** up to +9 dB low-shelf
- Presets: slow-and-reverb, default, nightcore
- Works across tabs and persists across your settings!
- Scroll-wheel functionality: scroll when hovering over sliders to move them by .05 increments, or simply click and drag them for even more fine-grained control.

## Supported Sites (as of 8/18/26)
- YouTube
- YT Music
- Spotify
- Soundcloud
- Bandcamp
- Apple Music

## How it works
Lento is a manifest v3 extension with no framework and no dependencies. It consists of just a popup, a relay content script, and an audio engine injected into the page's `MAIN` world at document_start.


## Development
```bash
node tools/build.mjs                          # stage builds into dist/firefox and dist/chrome
npx web-ext run --source-dir dist/firefox     # launch Firefox with the extension
```
For Chrome, load `dist/chrome` via "load unpacked" in `chrome://extensions`.
The CI workflow syntax-checks all scripts and lints the firefox build with web-ext. Both Chrome and Firefox builds are uploaded as workflow artifacts on each push.
Directory anatomy:
- `popup.js` / `popup.html`: UI sliders, presets, on/off, DRM state
- `content.js`: storage to page messaging bridge
- `page-hook.js`: audio engine
- `background.js`: diagnostics only
- `rules.json`: `Access-Control-Allow-Origin` header rewrite for media (applied via `declarativeNetRequest`
- `tools/build.mjs`: stages builds for Chrome and Firefox

## Known issues
- Issues with Spotify on Zen specifically (likely a browser issue rather than an extension one)
- Can only control speed on Amazon Music due to issues with fetching and applying effects on content there specifically

## Credits
- NikkeTryHard : diagnosing playback speed persistence issue on YT music

## Data disclaimer
All processing done locally, no data pertaining to the user is ever transmitted
