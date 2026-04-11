/**
 * popup.js — Popup UI logic
 *
 * Handles:
 * - Start / Stop button
 * - Settings sliders and toggles (persisted via chrome.storage)
 * - Live stats (EAR, blink count, click count) via polling content script
 * - Calibration flow
 */

'use strict';

// ─── DOM Refs ──────────────────────────────────────────────────────────────────

const btnToggle       = document.getElementById('btnToggle');
const btnIcon         = btnToggle.querySelector('.btn-icon');
const btnLabel        = btnToggle.querySelector('.btn-label');
const statusRing      = document.getElementById('statusRing');
const statusIcon      = document.getElementById('statusIcon');
const statusText      = document.getElementById('statusText');
const statEAR         = document.getElementById('statEAR');
const statBlinks      = document.getElementById('statBlinks');
const statClicks      = document.getElementById('statClicks');
const settingsToggle  = document.getElementById('settingsToggle');
const settingsBody    = document.getElementById('settingsBody');
const settingsChevron = document.getElementById('settingsChevron');
const btnCalibrate    = document.getElementById('btnCalibrate');

const sliderThreshold = document.getElementById('sliderThreshold');
const valThreshold    = document.getElementById('valThreshold');
const sliderFrames    = document.getElementById('sliderFrames');
const valFrames       = document.getElementById('valFrames');
const sliderDelay     = document.getElementById('sliderDelay');
const valDelay        = document.getElementById('valDelay');
const chkEyeCursor    = document.getElementById('chkEyeCursor');
const chkOverlay      = document.getElementById('chkOverlay');
const chkSound        = document.getElementById('chkSound');

// ─── State ─────────────────────────────────────────────────────────────────────

let isTracking  = false;
let statsPoller = null;

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  await syncStatus();
  bindEvents();
}

// ─── Settings Persistence ──────────────────────────────────────────────────────

async function loadSettings() {
  const defaults = {
    blinkThreshold: 0.21,
    blinkFrames:    2,
    clickDelay:     600,
    showOverlay:    true,
    soundFeedback:  false,
    eyeCursorMode:  true,
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  const s = { ...defaults, ...stored };

  sliderThreshold.value = s.blinkThreshold;
  valThreshold.textContent = s.blinkThreshold.toFixed(2);

  sliderFrames.value = s.blinkFrames;
  valFrames.textContent = s.blinkFrames;

  sliderDelay.value = s.clickDelay;
  valDelay.textContent = s.clickDelay + 'ms';

  chkOverlay.checked   = s.showOverlay;
  chkSound.checked     = s.soundFeedback;
  chkEyeCursor.checked = s.eyeCursorMode;
}

function saveSettings() {
  const settings = {
    blinkThreshold: parseFloat(sliderThreshold.value),
    blinkFrames:    parseInt(sliderFrames.value),
    clickDelay:     parseInt(sliderDelay.value),
    showOverlay:    chkOverlay.checked,
    soundFeedback:  chkSound.checked,
    eyeCursorMode:  chkEyeCursor.checked,
  };
  chrome.storage.local.set(settings);

  // Propagate to running content script
  if (isTracking) {
    chrome.runtime.sendMessage({ type: 'FORWARD_SETTINGS', settings })
      .catch(() => {});
  }
}

// ─── Status Sync ───────────────────────────────────────────────────────────────

async function syncStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    setTrackingState(resp.isTracking);
  } catch (_) {
    setTrackingState(false);
  }
}

function setTrackingState(active) {
  isTracking = active;

  // Button
  btnToggle.classList.toggle('is-active', active);
  btnIcon.textContent  = active ? '■' : '▶';
  btnLabel.textContent = active ? 'Stop Tracking' : 'Start Tracking';

  // Ring
  statusRing.classList.toggle('is-active', active);
  statusIcon.textContent = active ? '👁' : '⏸';
  statusText.textContent = active ? 'Active' : 'Inactive';

  // Calibrate
  btnCalibrate.disabled = !active;

  // Stats polling
  if (active) {
    startStatsPolling();
  } else {
    stopStatsPolling();
    resetStats();
  }
}

// ─── Button Events ─────────────────────────────────────────────────────────────

function bindEvents() {
  // Main toggle
  btnToggle.addEventListener('click', handleToggle);

  // Settings accordion
  settingsToggle.addEventListener('click', () => {
    const open = settingsBody.classList.toggle('open');
    settingsChevron.classList.toggle('open', open);
  });

  // Sliders
  sliderThreshold.addEventListener('input', () => {
    valThreshold.textContent = parseFloat(sliderThreshold.value).toFixed(2);
    saveSettings();
  });

  sliderFrames.addEventListener('input', () => {
    valFrames.textContent = sliderFrames.value;
    saveSettings();
  });

  sliderDelay.addEventListener('input', () => {
    valDelay.textContent = sliderDelay.value + 'ms';
    saveSettings();
  });

  // Checkboxes
  chkOverlay.addEventListener('change',   saveSettings);
  chkSound.addEventListener('change',     saveSettings);
  chkEyeCursor.addEventListener('change', saveSettings);

  // Calibration
  btnCalibrate.addEventListener('click', runCalibration);
}

async function handleToggle() {
  btnToggle.classList.add('is-loading');
  btnLabel.textContent = isTracking ? 'Stopping…' : 'Starting…';

  try {
    const type = isTracking ? 'STOP_TRACKING' : 'START_TRACKING';
    const resp = await chrome.runtime.sendMessage({ type });

    if (resp.success) {
      setTrackingState(!isTracking);
    } else {
      showError(resp.error || 'Unknown error');
      // Revert UI
      setTrackingState(isTracking);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    btnToggle.classList.remove('is-loading');
  }
}

// ─── Live Stats Polling ────────────────────────────────────────────────────────

function startStatsPolling() {
  stopStatsPolling();
  statsPoller = setInterval(pollStats, 500);
}

function stopStatsPolling() {
  if (statsPoller) { clearInterval(statsPoller); statsPoller = null; }
}

async function pollStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' });
    if (resp) {
      statEAR.textContent    = resp.ear    != null ? resp.ear.toFixed(3) : '—';
      statBlinks.textContent = resp.blinks ?? 0;
      statClicks.textContent = resp.clicks ?? 0;
    }
  } catch (_) {
    // Content script not yet loaded — no-op
  }
}

function resetStats() {
  statEAR.textContent    = '—';
  statBlinks.textContent = '0';
  statClicks.textContent = '0';
}

// ─── Calibration ──────────────────────────────────────────────────────────────

async function runCalibration() {
  btnCalibrate.disabled  = true;
  btnCalibrate.textContent = '👁 Calibrating… Keep eyes open';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No tab');

    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'START_CALIBRATION',
      durationMs: 3000,
    });

    if (resp && resp.baselineEAR) {
      // Set threshold slightly below open-eye baseline
      const threshold = (resp.baselineEAR * 0.75).toFixed(2);
      sliderThreshold.value    = threshold;
      valThreshold.textContent = threshold;
      await chrome.storage.local.set({ blinkThreshold: parseFloat(threshold) });
      saveSettings();
      btnCalibrate.textContent = `✓ Calibrated! EAR=${resp.baselineEAR.toFixed(3)}`;
    } else {
      btnCalibrate.textContent = '⚠ Could not calibrate — face not detected';
    }
  } catch (err) {
    btnCalibrate.textContent = '⚠ Calibration failed';
  } finally {
    setTimeout(() => {
      btnCalibrate.disabled     = !isTracking;
      btnCalibrate.textContent  = '🎯 Run Calibration';
    }, 2500);
  }
}

// ─── Error Display ────────────────────────────────────────────────────────────

function showError(msg) {
  statusText.textContent = 'Error';
  statusIcon.textContent = '⚠';
  console.error('[EyeSense Popup]', msg);

  const errEl = document.createElement('div');
  errEl.style.cssText = `
    margin: 0 18px 10px;
    padding: 8px 12px;
    background: rgba(255,58,92,0.1);
    border: 1px solid rgba(255,58,92,0.4);
    border-radius: 5px;
    font-size: 12px;
    color: #ff3a5c;
  `;
  errEl.textContent = '⚠ ' + msg;
  document.querySelector('.control-section').after(errEl);
  setTimeout(() => errEl.remove(), 4000);
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

init();
