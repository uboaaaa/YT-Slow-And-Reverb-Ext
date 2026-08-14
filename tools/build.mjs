// Stages loadable extension folders: dist/firefox (SVG icons, root manifest)
// and dist/chrome (PNG icons, manifest.chrome.json as manifest.json).
// Usage: node tools/build.mjs

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const SHARED = [
  "background.js",
  "content.js",
  "page-hook.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "rules.json",
  "fonts",
];

const TARGETS = {
  firefox: {
    manifest: "manifest.json",
    icons: ["icon16.svg", "icon48.svg", "icon128.svg"],
  },
  chrome: {
    manifest: "manifest.chrome.json",
    icons: ["icon16.png", "icon48.png", "icon128.png"],
  },
};

rmSync(dist, { recursive: true, force: true });

for (const [name, target] of Object.entries(TARGETS)) {
  const out = join(dist, name);
  mkdirSync(join(out, "icons"), { recursive: true });

  for (const file of SHARED) {
    cpSync(join(root, file), join(out, file), { recursive: true });
  }
  cpSync(join(root, target.manifest), join(out, "manifest.json"));
  for (const icon of target.icons) {
    cpSync(join(root, "icons", icon), join(out, "icons", icon));
  }

  console.log(`built dist/${name}`);
}
