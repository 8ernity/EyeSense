/**
 * tracker.js — Injected into world: 'MAIN'
 *
 * This file runs in the PAGE's JS context so it can access the MediaPipe
 * globals (FaceMesh, Camera, drawConnectors, FACEMESH_*) that were injected
 * into MAIN world by background.js just before this script.
 *
 * IMPORTANT: chrome.* APIs are NOT available here. All communication with
 * the extension happens through CustomEvents on window:
 *
 *   window → bridge:  'eyeclick:tobridge'   (tracker sends data out)
 *   bridge → window:  'eyeclick:frombridge' (bridge sends commands in)
 *
 * The bridge script (content.js, running in isolated world) listens to these
 * events and translates them to/from chrome.runtime messages.
 */

(function () {
  'use strict';

  if (window.__eyeClickTrackerLoaded) return;
  window.__eyeClickTrackerLoaded = true;

  // ─── Eye Landmark Indices ─────────────────────────────────────────────────────
  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];

  // ─── Settings ─────────────────────────────────────────────────────────────────
  let settings = {
    blinkThreshold: 0.21,
    blinkFrames: 2,
    clickDelay: 600,
    showOverlay: true,
    soundFeedback: false,
    eyeCursorMode: true,
  };

  // ─── State ────────────────────────────────────────────────────────────────────
  let isRunning = false;
  let faceMesh = null;
  let camera = null;
  let consecutiveBlinks = 0;
  let blinkCooldown = false;
  let lastClickTime = 0;
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let totalBlinks = 0;
  let totalClicks = 0;
  let lastEAR = null;
  let calibrating = false;
  let calibrationEARs = [];

  // ─── DOM ──────────────────────────────────────────────────────────────────────
  let container = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx2d = null;
  let statusBadge = null;
  let blinkFlash = null;
  let virtualCursor = null;
  let smoothX = window.innerWidth / 2;
  let smoothY = window.innerHeight / 2;

  // ─── Drag State ───────────────────────────────────────────────────────────────
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Bound handler refs
  let onWindowMouseMoveDrag = null;
  let onWindowMouseUpDrag = null;

  // ─── Helpers: send event to bridge ───────────────────────────────────────────
  function toBridge(type, payload) {
    window.dispatchEvent(new CustomEvent('eyeclick:tobridge', {
      detail: { type, payload },
    }));
  }

  // ─── DOM Creation ─────────────────────────────────────────────────────────────
  function createDOM() {
    // Aggressive cleanup of any ghost elements from previous crashed sessions
    for (const id of ['__eyeclick_container', '__eyeclick_badge', '__eyeclick_flash', '__eyeclick_virtual_cursor']) {
      const ghost = document.getElementById(id);
      if (ghost) {
        if (id === '__eyeclick_container') {
          const oldV = ghost.querySelector('video');
          if (oldV && oldV.srcObject) {
            oldV.srcObject.getTracks().forEach(t => t.stop());
          }
        }
        ghost.remove();
      }
    }

    container = document.createElement('div');
    container.id = '__eyeclick_container';

    videoEl = document.createElement('video');
    videoEl.id = '__eyeclick_video';
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = true;
    if (!settings.showOverlay) videoEl.style.opacity = '0';
    videoEl.style.pointerEvents = 'none';

    canvasEl = document.createElement('canvas');
    canvasEl.id = '__eyeclick_canvas';
    canvasEl.width = 320;
    canvasEl.height = 240;
    ctx2d = canvasEl.getContext('2d');

    container.appendChild(videoEl);
    container.appendChild(canvasEl);
    document.body.appendChild(container);

    container.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
    });

    onWindowMouseMoveDrag = (e) => {
      if (!isDragging) return;
      container.style.left = (e.clientX - dragOffsetX) + 'px';
      container.style.top = (e.clientY - dragOffsetY) + 'px';
      container.style.bottom = 'auto'; // overrides default bottom
      container.style.right = 'auto';
    };

    onWindowMouseUpDrag = () => {
      isDragging = false;
    };

    window.addEventListener('mousemove', onWindowMouseMoveDrag);
    window.addEventListener('mouseup', onWindowMouseUpDrag);

    statusBadge = document.createElement('div');
    statusBadge.id = '__eyeclick_badge';
    // Build children via DOM methods — never innerHTML (Trusted Types blocks it on YouTube/Google)
    const ecDot = document.createElement('span');
    ecDot.className = 'ec-dot';
    const ecLabel = document.createElement('span');
    ecLabel.className = 'ec-label';
    ecLabel.textContent = 'EyeSense \u2014 loading\u2026';
    statusBadge.appendChild(ecDot);
    statusBadge.appendChild(ecLabel);
    document.body.appendChild(statusBadge);

    blinkFlash = document.createElement('div');
    blinkFlash.id = '__eyeclick_flash';
    document.body.appendChild(blinkFlash);

    virtualCursor = document.createElement('div');
    virtualCursor.id = '__eyeclick_virtual_cursor';
    if (!settings.eyeCursorMode) virtualCursor.classList.add('ec-hidden');
    document.body.appendChild(virtualCursor);
  }

  // ─── MediaPipe ────────────────────────────────────────────────────────────────
  function initFaceMesh(extensionBaseUrl) {
    if (!window.FaceMesh) throw new Error('FaceMesh not found on window.');

    faceMesh = new window.FaceMesh({
      locateFile: (file) => extensionBaseUrl + 'lib/' + file,
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults(onFaceMeshResults);
  }

  function initCamera() {
    if (!window.Camera) throw new Error('Camera utility not found on window.');

    camera = new window.Camera(videoEl, {
      onFrame: async () => {
        if (isRunning && faceMesh) {
          try { await faceMesh.send({ image: videoEl }); } catch (_) { }
        }
      },
      width: 320, height: 240,
    });
    camera.start();
  }

  // ─── Face Mesh Results ────────────────────────────────────────────────────────
  function onFaceMeshResults(results) {
    if (!ctx2d || !canvasEl) return;
    ctx2d.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      consecutiveBlinks = 0;
      updateBadge('no-face');
      return;
    }

    const landmarks = results.multiFaceLandmarks[0];
    if (settings.showOverlay) drawLandmarks(landmarks);

    // Gaze / Cursor tracking
    if (settings.eyeCursorMode && virtualCursor) {
      virtualCursor.classList.remove('ec-hidden');
      const nose = landmarks[4];

      // Calculate nose movement against camera frame bounds
      // Mirror the map (1 - x) to ensure intuitive horizontal movement, similar to how canvas is transformed
      let normX = 1.0 - nose.x;
      let normY = nose.y;

      // Map a smaller inner zone of the camera so user can reach screen edges without extreme head tilts
      const zoneW = 0.25;
      const zoneH = 0.25;
      const actX = Math.max(0, Math.min(1, (normX - (0.5 - zoneW / 2)) / zoneW));
      const actY = Math.max(0, Math.min(1, (normY - (0.5 - zoneH / 2)) / zoneH));

      // Map to screen
      const targetX = actX * window.innerWidth;
      const targetY = actY * window.innerHeight;

      // Exponential moving average for smooth cursor
      smoothX += (targetX - smoothX) * 0.2;
      smoothY += (targetY - smoothY) * 0.2;

      virtualCursor.style.left = smoothX + 'px';
      virtualCursor.style.top = smoothY + 'px';
    } else if (virtualCursor && !virtualCursor.classList.contains('ec-hidden')) {
      virtualCursor.classList.add('ec-hidden');
    }

    const leftEAR = computeEAR(landmarks, LEFT_EYE);
    const rightEAR = computeEAR(landmarks, RIGHT_EYE);
    const avgEAR = (leftEAR + rightEAR) / 2;
    lastEAR = avgEAR;

    if (calibrating) calibrationEARs.push(avgEAR);

    if (avgEAR < settings.blinkThreshold) {
      consecutiveBlinks++;
    } else {
      if (consecutiveBlinks >= settings.blinkFrames) {
        totalBlinks++;
        triggerBlink();
      }
      consecutiveBlinks = 0;
    }

    updateBadge('active', avgEAR);
  }

  // ─── EAR ──────────────────────────────────────────────────────────────────────
  function computeEAR(landmarks, indices) {
    const W = canvasEl.width, H = canvasEl.height;
    const p = indices.map(i => ({ x: landmarks[i].x * W, y: landmarks[i].y * H }));
    const v1 = dist(p[1], p[5]);
    const v2 = dist(p[2], p[4]);
    const h = dist(p[0], p[3]);
    return h === 0 ? 0 : (v1 + v2) / (2.0 * h);
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ─── Blink → Click ────────────────────────────────────────────────────────────
  function triggerBlink() {
    const now = Date.now();
    if (blinkCooldown || (now - lastClickTime) < settings.clickDelay) return;

    blinkCooldown = true;
    lastClickTime = now;
    setTimeout(() => { blinkCooldown = false; }, settings.clickDelay);

    flashScreen();
    if (settings.soundFeedback) playBeep();

    // Use virtual cursor pos if mode enabled, otherwise native track mouse pos
    const cX = settings.eyeCursorMode ? smoothX : mouseX;
    const cY = settings.eyeCursorMode ? smoothY : mouseY;
    simulateClick(cX, cY);
    totalClicks++;

    toBridge('BLINK_DETECTED', {});
  }

  function simulateClick(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        buttons: type === 'mousedown' ? 1 : 0, button: 0,
      }));
    }
  }

  function flashScreen() {
    if (!blinkFlash) return;
    blinkFlash.classList.remove('ec-flash-active');
    void blinkFlash.offsetWidth;
    blinkFlash.classList.add('ec-flash-active');
  }

  function playBeep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine'; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.12);
      osc.start(ac.currentTime); osc.stop(ac.currentTime + 0.12);
    } catch (_) { }
  }

  // ─── Drawing ──────────────────────────────────────────────────────────────────
  function drawLandmarks(landmarks) {
    ctx2d.save();
    ctx2d.translate(canvasEl.width, 0);
    ctx2d.scale(-1, 1);

    if (window.drawConnectors) {
      if (window.FACEMESH_TESSELATION)
        window.drawConnectors(ctx2d, landmarks, window.FACEMESH_TESSELATION,
          { color: 'rgba(0,229,255,0.06)', lineWidth: 0.4 });
      if (window.FACEMESH_RIGHT_EYE) {
        window.drawConnectors(ctx2d, landmarks, window.FACEMESH_RIGHT_EYE,
          { color: '#00e5ff', lineWidth: 1.5 });
        window.drawConnectors(ctx2d, landmarks, window.FACEMESH_LEFT_EYE,
          { color: '#00e5ff', lineWidth: 1.5 });
      }
      if (window.FACEMESH_RIGHT_IRIS) {
        window.drawConnectors(ctx2d, landmarks, window.FACEMESH_RIGHT_IRIS,
          { color: '#ff6f91', lineWidth: 1.5 });
        window.drawConnectors(ctx2d, landmarks, window.FACEMESH_LEFT_IRIS,
          { color: '#ff6f91', lineWidth: 1.5 });
      }
    }
    ctx2d.restore();

    if (lastEAR !== null) drawEARBar(lastEAR);
  }

  function drawEARBar(ear) {
    const W = canvasEl.width, H = canvasEl.height;
    const barH = 5, y = H - barH - 2;
    ctx2d.fillStyle = 'rgba(8,12,24,0.75)';
    ctx2d.fillRect(0, y - 1, W, barH + 2);
    const tx = Math.min((settings.blinkThreshold / 0.4) * W, W);
    ctx2d.strokeStyle = 'rgba(255,58,92,0.9)';
    ctx2d.lineWidth = 1; ctx2d.setLineDash([3, 3]);
    ctx2d.beginPath(); ctx2d.moveTo(tx, y - 1); ctx2d.lineTo(tx, y + barH + 1); ctx2d.stroke();
    ctx2d.setLineDash([]);
    const fillW = Math.min((ear / 0.4) * W, W);
    ctx2d.fillStyle = ear < settings.blinkThreshold ? '#ff3a5c' : '#00e5ff';
    ctx2d.fillRect(0, y, fillW, barH);
  }

  // ─── Badge ────────────────────────────────────────────────────────────────────
  function updateBadge(state, earOrMsg) {
    if (!statusBadge) return;
    const label = statusBadge.querySelector('.ec-label');
    if (!label) return;
    statusBadge.classList.remove('ec-state-active', 'ec-state-noface', 'ec-state-error');
    switch (state) {
      case 'active':
        statusBadge.classList.add('ec-state-active');
        label.textContent = earOrMsg != null ? `EyeSense  •  EAR ${earOrMsg.toFixed(3)}` : 'EyeSense Active';
        break;
      case 'no-face':
        statusBadge.classList.add('ec-state-noface');
        label.textContent = 'No face detected';
        break;
      case 'error':
        statusBadge.classList.add('ec-state-error');
        label.textContent = earOrMsg || 'EyeSense error';
        break;
      default:
        label.textContent = 'EyeSense — loading…';
    }
  }

  // ─── Mouse tracking ───────────────────────────────────────────────────────────
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
  }, { passive: true });

  // ─── Destroy ──────────────────────────────────────────────────────────────────
  function destroy() {
    isRunning = false;
    if (camera) { try { camera.stop(); } catch (_) { } camera = null; }
    if (faceMesh) { try { faceMesh.close(); } catch (_) { } faceMesh = null; }
    if (videoEl && videoEl.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    
    if (onWindowMouseMoveDrag) {
      window.removeEventListener('mousemove', onWindowMouseMoveDrag);
      window.removeEventListener('mouseup', onWindowMouseUpDrag);
    }
    
    for (const el of [container, statusBadge, blinkFlash, virtualCursor]) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    container = videoEl = canvasEl = ctx2d = statusBadge = blinkFlash = virtualCursor = null;
    window.__eyeClickTrackerLoaded = false;
    toBridge('TRACKER_UNLOADED', {});
  }

  // ─── Command listener (from bridge via CustomEvent) ───────────────────────────
  window.addEventListener('eyeclick:frombridge', (e) => {
    const { type, payload } = e.detail;

    if (type === 'INIT') {
      (async () => {
        try {
          Object.assign(settings, payload.settings || {});
          createDOM();
          updateBadge('loading');
          await new Promise(r => setTimeout(r, 300));
          initFaceMesh(payload.extensionBaseUrl);
          initCamera();
          isRunning = true;
          updateBadge('no-face');
          toBridge('INIT_OK', {});
        } catch (err) {
          console.error('[EyeSense Tracker]', err);
          if (statusBadge) updateBadge('error', err.message);
          toBridge('INIT_ERROR', { error: err.message });
        }
      })();
    }

    if (type === 'STOP') {
      destroy();
    }

    if (type === 'UPDATE_SETTINGS') {
      Object.assign(settings, payload);
      if (virtualCursor) {
        if (!settings.eyeCursorMode) virtualCursor.classList.add('ec-hidden');
        else virtualCursor.classList.remove('ec-hidden');
      }
      if (videoEl) {
        videoEl.style.opacity = settings.showOverlay ? '1' : '0';
      }
    }

    if (type === 'GET_STATS') {
      toBridge('STATS', { ear: lastEAR, blinks: totalBlinks, clicks: totalClicks });
    }

    if (type === 'START_CALIBRATION') {
      calibrating = true;
      calibrationEARs = [];
      setTimeout(() => {
        calibrating = false;
        if (calibrationEARs.length < 10) {
          toBridge('CALIBRATION_RESULT', { baselineEAR: null });
          return;
        }
        const sorted = [...calibrationEARs].sort((a, b) => b - a);
        const top80 = sorted.slice(0, Math.ceil(sorted.length * 0.8));
        const avg = top80.reduce((s, v) => s + v, 0) / top80.length;
        toBridge('CALIBRATION_RESULT', { baselineEAR: parseFloat(avg.toFixed(4)) });
      }, payload.durationMs || 3000);
    }
  });

})();
