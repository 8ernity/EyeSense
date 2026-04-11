/**
 * content.js — Bridge script, injected into the ISOLATED world
 *
 * This is the ONLY script that runs in Chrome's extension isolated world.
 * It has full access to chrome.* APIs (chrome.runtime, chrome.storage, etc.)
 * but CANNOT access page JS variables like window.FaceMesh.
 *
 * It bridges between:
 *   - The extension (background.js) via chrome.runtime.onMessage
 *   - The tracker (tracker.js, running in MAIN world) via CustomEvents
 *
 * CustomEvent channel:
 *   Isolated → MAIN:  window.dispatchEvent('eyeclick:frombridge')
 *   MAIN → Isolated:  window.addEventListener('eyeclick:tobridge')
 *
 * Note: CustomEvents on window ARE shared between isolated and MAIN worlds
 * because they both share the same underlying DOM window object.
 */

(function () {
  'use strict';

  if (window.__eyeClickBridgeLoaded) return;
  window.__eyeClickBridgeLoaded = true;

  // Pending promise resolvers for async tracker responses
  const pending = {
    init:        null,
    calibration: null,
  };

  // Stats cache (updated from tracker events)
  let cachedStats = { ear: null, blinks: 0, clicks: 0 };

  // ─── Send command to tracker (MAIN world) ─────────────────────────────────────
  function toTracker(type, payload) {
    window.dispatchEvent(new CustomEvent('eyeclick:frombridge', {
      detail: { type, payload: payload || {} },
    }));
  }

  // ─── Receive events from tracker (MAIN world) ─────────────────────────────────
  window.addEventListener('eyeclick:tobridge', (e) => {
    const { type, payload } = e.detail;

    switch (type) {
      case 'INIT_OK':
        if (pending.init) { pending.init.resolve(); pending.init = null; }
        break;

      case 'INIT_ERROR':
        if (pending.init) { pending.init.reject(new Error(payload.error)); pending.init = null; }
        break;

      case 'BLINK_DETECTED':
        try { chrome.runtime.sendMessage({ type: 'BLINK_DETECTED' }); } catch (_) {}
        break;

      case 'TRACKER_UNLOADED':
        try { chrome.runtime.sendMessage({ type: 'TRACKER_UNLOADED' }); } catch (_) {}
        break;

      case 'STATS':
        cachedStats = payload;
        break;

      case 'CALIBRATION_RESULT':
        if (pending.calibration) {
          pending.calibration(payload);
          pending.calibration = null;
        }
        break;
    }
  });

  // ─── Receive commands from background.js ──────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

    if (message.type === 'INIT_TRACKER') {
      (async () => {
        try {
          const stored = await chrome.storage.local.get([
            'blinkThreshold', 'blinkFrames', 'clickDelay', 'showOverlay', 'soundFeedback', 'eyeCursorMode'
          ]);

          // Wait for tracker to confirm init via INIT_OK / INIT_ERROR event
          await new Promise((resolve, reject) => {
            pending.init = { resolve, reject };

            toTracker('INIT', {
              settings: stored,
              // Pass extension base URL so tracker.js can build locateFile paths
              // without needing chrome.runtime (unavailable in MAIN world)
              extensionBaseUrl: chrome.runtime.getURL(''),
            });

            // Timeout after 15 s (WASM can take a while on first load)
            setTimeout(() => {
              if (pending.init) {
                pending.init.reject(new Error('Tracker init timed out after 15 s'));
                pending.init = null;
              }
            }, 15000);
          });

          sendResponse({ ok: true });
        } catch (err) {
          console.error('[EyeSense Bridge] Init error:', err);
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true; // async
    }

    if (message.type === 'STOP_TRACKER') {
      toTracker('STOP');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'UPDATE_SETTINGS') {
      toTracker('UPDATE_SETTINGS', message.settings);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'GET_STATS') {
      // Ask tracker for fresh stats, respond with cached value immediately
      // (stats are pushed continuously via STATS events, so cache is fresh)
      toTracker('GET_STATS');
      sendResponse(cachedStats);
      return;
    }

    if (message.type === 'START_CALIBRATION') {
      const durationMs = message.durationMs || 3000;

      pending.calibration = (result) => sendResponse(result);
      toTracker('START_CALIBRATION', { durationMs });

      // Timeout safety
      setTimeout(() => {
        if (pending.calibration) {
          pending.calibration({ baselineEAR: null, error: 'Calibration timed out' });
          pending.calibration = null;
        }
      }, durationMs + 2000);

      return true; // async
    }
  });

})();
