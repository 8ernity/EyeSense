/**
 * background.js — Service Worker (Manifest V3)
 *
 * INJECTION ORDER (critical):
 *
 *  1. styles-injected.css  → insertCSS (any world, just DOM styles)
 *  2. lib/drawing_utils.js → MAIN world (sets window.drawConnectors + FACEMESH_* constants)
 *  3. lib/face_mesh.js     → MAIN world (sets window.FaceMesh)
 *  4. lib/camera_utils.js  → MAIN world (sets window.Camera)
 *  5. tracker.js           → MAIN world (uses the globals above, communicates via CustomEvents)
 *  6. content.js           → ISOLATED world (bridge: has chrome.* APIs, talks to tracker via CustomEvents)
 *
 * Why two worlds?
 *   - MAIN world: can access window.FaceMesh etc., but NO chrome.* APIs
 *   - ISOLATED world: has chrome.* APIs, but cannot see MAIN world JS variables
 *   - CustomEvents on `window` are visible to BOTH worlds (they share the DOM)
 *
 * This split is the correct architecture for MV3 extensions that need both
 * a heavy page-level library (MediaPipe) and extension APIs (chrome.storage).
 */

'use strict';

let trackingTabId = null;
let isTracking    = false;

// ─── Install ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    isTracking:     false,
    blinkThreshold: 0.21,
    blinkFrames:    2,
    clickDelay:     600,
    showOverlay:    true,
    soundFeedback:  false,
    eyeCursorMode:  true,
  });
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'GET_STATUS':
      sendResponse({ isTracking, tabId: trackingTabId });
      break;

    case 'START_TRACKING':
      handleStart(sendResponse);
      return true;

    case 'STOP_TRACKING':
      handleStop(sendResponse);
      return true;

    case 'BLINK_DETECTED':
      chrome.action.setBadgeText({ text: 'BLINK' });
      chrome.action.setBadgeBackgroundColor({ color: '#00bcd4' });
      setTimeout(() => {
        if (isTracking) {
          chrome.action.setBadgeText({ text: 'ON' });
          chrome.action.setBadgeBackgroundColor({ color: '#00e5ff' });
        }
      }, 350);
      break;

    case 'FORWARD_SETTINGS':
      if (trackingTabId !== null) {
        chrome.tabs.sendMessage(trackingTabId, {
          type:     'UPDATE_SETTINGS',
          settings: message.settings,
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;

    case 'TRACKER_UNLOADED':
      if (sender.tab && sender.tab.id === trackingTabId) {
        isTracking    = false;
        trackingTabId = null;
        chrome.storage.local.set({ isTracking: false });
        chrome.action.setBadgeText({ text: '' });
      }
      break;

    default:
      break;
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function handleStart(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');

    if (!tab.url ||
        tab.url.startsWith('chrome://') ||
        tab.url.startsWith('chrome-extension://') ||
        tab.url.startsWith('about:')) {
      return sendResponse({
        success: false,
        error:   'Cannot run on this page. Navigate to a normal website first.',
      });
    }

    trackingTabId = tab.id;
    isTracking    = true;

    // Step 1: CSS overlay (world doesn't matter for CSS)
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files:  ['styles-injected.css'],
    });

    // Step 2–4: MediaPipe libs → MAIN world
    // Each awaited separately so they execute in order
    for (const file of ['lib/drawing_utils.js', 'lib/face_mesh.js', 'lib/camera_utils.js']) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files:  [file],
        world:  'MAIN',
      });
    }

    // Step 5: tracker.js → MAIN world (accesses MediaPipe globals, fires CustomEvents)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files:  ['tracker.js'],
      world:  'MAIN',
    });

    // Step 6: content.js → ISOLATED world (has chrome.* APIs, listens to CustomEvents)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files:  ['content.js'],
      world:  'ISOLATED',
    });

    // Step 7: Trigger init — goes to content.js (isolated) which relays to tracker.js (MAIN)
    // Small delay to ensure content.js message listener is registered
    await sleep(100);
    const initResp = await chrome.tabs.sendMessage(tab.id, { type: 'INIT_TRACKER' });

    if (!initResp || !initResp.ok) {
      throw new Error(initResp?.error || 'Tracker failed to initialise');
    }

    chrome.storage.local.set({ isTracking: true });
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00e5ff' });

    sendResponse({ success: true });

  } catch (err) {
    console.error('[EyeSense BG] Start error:', err);
    isTracking    = false;
    trackingTabId = null;
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

async function handleStop(sendResponse) {
  try {
    if (trackingTabId !== null) {
      try {
        await chrome.tabs.sendMessage(trackingTabId, { type: 'STOP_TRACKER' });
      } catch (_) {}
    }
    isTracking    = false;
    trackingTabId = null;
    chrome.storage.local.set({ isTracking: false });
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Tab closed ───────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === trackingTabId) {
    isTracking    = false;
    trackingTabId = null;
    chrome.storage.local.set({ isTracking: false });
    chrome.action.setBadgeText({ text: '' });
  }
});

// ─── Tab navigated ────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isTracking && tabId === trackingTabId && changeInfo.status === 'complete') {
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('about:')) {
      handleStart(() => {});
    } else {
      isTracking    = false;
      trackingTabId = null;
      chrome.storage.local.set({ isTracking: false });
      chrome.action.setBadgeText({ text: '' });
    }
  }
});

// ─── Util ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
