# 👁 EyeSense — Blink to Click Chrome Extension

Control your browser with your eyes. EyeSense uses **MediaPipe Face Mesh** to detect blinks in real-time via your webcam and fires a mouse click at your cursor position — all processed locally in the browser, with zero data leaving your device.

---

## 📁 Folder Structure

```
eye-blink-extension/
├── manifest.json          # Chrome Extension MV3 config
├── background.js          # Service worker — orchestrates start/stop, tab tracking
├── content.js             # Injected into active tab — webcam, MediaPipe, blink logic
├── popup.html             # Extension popup UI
├── popup.css              # Popup styles (dark cyberpunk theme)
├── popup.js               # Popup logic — settings, stats polling, calibration
├── styles-injected.css    # CSS injected into tracked tab (overlay, badge, flash)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🚀 Installation (Load Unpacked)

1. **Download / clone** this folder to your computer.

2. Open Chrome and navigate to:
   ```
   chrome://extensions
   ```

3. Enable **Developer Mode** (toggle in the top-right corner).

4. Click **"Load unpacked"** and select the `eye-blink-extension/` folder.

5. The EyeSense icon will appear in your Chrome toolbar.

---

## 🎮 How to Use

1. Navigate to **any regular webpage** (not `chrome://` pages).
2. Click the **EyeSense icon** in the toolbar → popup opens.
3. Click **"Start Tracking"** — Chrome will ask for webcam permission; allow it.
4. A small webcam overlay appears in the bottom-right of the page showing your face mesh.
5. **Blink deliberately** (hold ~2 frames) to trigger a click at your cursor position.
6. Click **"Stop Tracking"** to disable.

---

## 🔬 How Blink Detection Works

### Eye Aspect Ratio (EAR)

EAR is a single number that describes how "open" an eye is, derived from 6 landmark points:

```
        p2    p3
   p1 ·        · p4
        p6    p5
```

```
EAR = (||p2−p6|| + ||p3−p5||) / (2 × ||p1−p4||)
```

- **Eye open**: EAR ≈ 0.25–0.32
- **Eye blinking**: EAR drops below ~0.21
- **Eye closed**: EAR < 0.15

### Detection State Machine

```
Frame N:  EAR < threshold  → blink_counter++
Frame N+1: EAR < threshold → blink_counter++  (= 2 frames, threshold met)
Frame N+2: EAR >= threshold → BLINK CONFIRMED → fire click, reset counter
```

The **"Confirm Frames"** setting controls how many consecutive closed-eye frames are needed before a blink is registered. Higher values reduce false positives from lighting changes.

---

## ⚙️ Settings Explained

| Setting | Default | Description |
|---|---|---|
| **Blink Sensitivity** (EAR threshold) | 0.21 | Eye must fall below this EAR to count as a blink. Lower = more sensitive. |
| **Confirm Frames** | 2 | Consecutive low-EAR frames needed to confirm a blink. Higher = more deliberate. |
| **Click Cooldown** | 600ms | Minimum time between clicks. Prevents rapid-fire accidents. |
| **Show Overlay** | On | Shows the face mesh landmark canvas in the page corner. |
| **Sound Feedback** | Off | Plays a short beep when a click is fired. |

---

## 🎯 Calibration

1. Start Tracking first.
2. Open settings → click **"Run Calibration"**.
3. Look at the screen normally for 3 seconds (keep eyes open, don't blink).
4. The extension measures your personal baseline EAR and sets the threshold to 75% of that value — tuned to your eyes and lighting.

---

## 🔐 Permissions Explained

| Permission | Why it's needed |
|---|---|
| `activeTab` | To know which tab to inject the tracker into |
| `scripting` | To inject `content.js` and `styles-injected.css` into the active tab |
| `storage` | To persist your settings across sessions |
| `<all_urls>` (host permission) | To allow script injection on any website |
| **Webcam** (`getUserMedia`) | Requested at runtime by the content script — used only for face detection, never recorded or transmitted |

**Privacy:** All face/eye processing happens in your browser using MediaPipe's WASM model. No video frames, landmarks, or personal data are ever sent to any server.

---

## 🛠 Architecture Deep Dive

### Data Flow

```
[Webcam] → MediaPipe FaceMesh → landmarks[]
                                     ↓
                              computeEAR(landmarks)
                                     ↓
                         avgEAR < threshold?
                                     ↓
                    consecutiveBlinks >= blinkFrames?
                                     ↓
                         simulateClick(mouseX, mouseY)
                                     ↓
                         MouseEvent dispatched on DOM element
```

### Message Passing

```
popup.js ──START_TRACKING──► background.js
                                    │ scripting.executeScript(content.js)
                                    │ tabs.sendMessage(INIT_TRACKER)
                                    ▼
                             content.js (active tab)
                                    │
                                    │ BLINK_DETECTED → background.js (badge flash)
                                    │ GET_STATS → popup.js (live EAR/counts)
```

---

## 🐛 Troubleshooting

| Problem | Solution |
|---|---|
| "Cannot inject into this page" | Navigate to a regular `https://` website first |
| Webcam permission denied | Click the camera icon in Chrome's address bar and allow access |
| No face detected | Improve lighting; face the camera directly |
| Too many accidental clicks | Increase Confirm Frames to 3–4; increase Click Cooldown |
| Blinks not registering | Run Calibration; or manually lower the EAR threshold slider |
| Overlay not visible | Check "Show Overlay" is enabled in settings |

---

## 🔮 Optional Improvements

- **Gaze Tracking**: MediaPipe's `refineLandmarks: true` exposes iris landmarks (indices 468–477). The iris center can be mapped to screen coordinates via affine transform for cursor control.
- **Wink detection**: Compute EAR for left and right eyes independently — a left wink vs. right wink could trigger different actions.
- **Double-blink for right-click**: Track inter-blink timing; two blinks within 400ms → `contextmenu` event.
- **Head-nod scrolling**: Track the vertical position of the nose tip across frames to detect nods → scroll events.
- **Offscreen document**: Move the webcam + MediaPipe into a Chrome Offscreen Document (MV3 API) to avoid injecting a visible overlay into the page.
- **WASM caching**: Cache the MediaPipe `.wasm` and `.bin` model files using a service worker cache for faster startup.

---

## 🧰 Tech Stack

- **Chrome Extension Manifest V3**
- **MediaPipe Face Mesh 0.4** (loaded from CDN, runs as WASM in the browser)
- **Vanilla JavaScript** (no build step required)
- **HTML5 Canvas** for landmark rendering
- **Web Audio API** for click sound feedback

---

## 📜 License

MIT — free to use, modify, and distribute.
