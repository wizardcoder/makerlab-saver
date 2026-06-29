# MakerLab Config Saver

A Chrome/Edge Manifest V3 browser extension that saves and restores MakerLab customisation options on MakerWorld (makerworld.com).

## How It Works

MakerLab sends model parameters to the server when you generate a model. For OpenSCAD models, this is base64-encoded source code with `-D` parameter overrides. For Fusion 360 parametric models, it's a JSON object of parameter key/value pairs. This extension intercepts those requests, parses the configurable parameters, and lets you save, restore, compare, and export them.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `makerlab-saver` folder
5. The extension icon should appear in your toolbar

For Firefox, load it as a temporary add-on via `about:debugging` → "This Firefox" → "Load Temporary Add-on" → select `manifest.json`. Note: you may need to change `chrome.` to `browser.` for full Firefox compatibility, or use a polyfill.

## Usage

### Capturing a Config
1. Go to a MakerLab design on MakerWorld
2. Change any options in the customiser
3. Click **Generate** (triggers the model rebuild)
4. The extension status dot turns green — it captured the config

### Saving
1. Click the extension icon
2. Enter a name for the config
3. Click **Save**

### Restoring
1. Open the extension popup
2. Click **Load** on a saved config
3. The extension restores values into the MakerLab UI (text inputs, dropdowns, and switches)
4. Click **Generate** to confirm the model builds with restored values

### Comparing (Diff)
1. Make sure you have a current capture (change something and generate)
2. Click **Diff** on any saved config
3. See which parameters differ between saved and current

### Import / Export
- **Export** — downloads a slim config JSON (name, params, design info)
- **Import** — loads a previously exported JSON config file (supports both old full-size and new slim formats)
- **Copy Payload** — copies the raw API payload to clipboard (useful for replaying requests)

## Architecture

```
manifest.json        — Extension config (Manifest V3)
inject.js            — Runs in PAGE context (main world)
                       • Intercepts fetch() and XMLHttpRequest to capture MakerLab payloads
                       • Discovers DOM fields and restores values into them
                       • Communicates with content.js via window.postMessage
content.js           — Runs in CONTENT SCRIPT isolated world
                       • Bridges between inject.js (postMessage) and popup.js (chrome.runtime)
                       • Parses OpenSCAD source + -D overrides into parameter objects
                       • Manages chrome.storage.local for saved configs
popup.html / popup.js — Extension popup UI (dark theme)
```

## Limitations

- **Capture requires a generate action** — the extension only sees the config when MakerLab sends it to the server. Simply changing options without generating won't trigger a capture. A warning is shown if you try to save after changing values without re-generating.
- **Computed parameters are skipped** (OpenSCAD only) — only simple variable declarations (numbers, strings, booleans) are parsed. Derived values that use expressions are ignored since they're computed from the simple params.

## License

This project is licensed under the [GPL-3.0 License](LICENSE).
