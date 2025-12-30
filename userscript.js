// ==UserScript==
// @name         GeoFS Flightradar
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Transmits GeoFS flight data to the radar server
// @author       JThweb
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /*** CONFIG ***/
  // If running server locally, use 'ws://localhost:6969/ws' (You may need to allow mixed content)
  // If using public server, use 'wss://radar.yugp.me/ws'
  const WS_URL = 'wss://radar.yugp.me/ws'; 
  const SEND_INTERVAL_MS = 500;
  /*************/

    // ===== Modal Function =====
  function showModal(msg, duration = null, updateBtnUrl = null) {
    if (document.getElementById("geofs-atc-modal")) return;
    let overlay = document.createElement("div");
    overlay.id = "geofs-atc-modal";
    overlay.style.cssText = `
      position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;
      background:rgba(24,32,48,0.45);display:flex;align-items:center;justify-content:center;
    `;
    let box = document.createElement("div");
    box.style.cssText = `
      background: rgba(22, 25, 32, 0.95);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #e9ecef;
      padding: 40px;
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      min-width: 360px;
      max-width: 90vw;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      border: 1px solid rgba(255,255,255,0.1);
      font-family: 'Segoe UI', system-ui, sans-serif;
      text-align: center;
      animation: popIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    `;
    let content = document.createElement("div");
    content.innerHTML = msg;
    content.style.fontSize = "1.2rem";
    content.style.lineHeight = "1.6";
    box.appendChild(content);

    if (updateBtnUrl) {
      let updateBtn = document.createElement("a");
      updateBtn.textContent = "Update Now";
      updateBtn.href = updateBtnUrl;
      updateBtn.target = "_blank";
      updateBtn.style.cssText = `
        margin-top: 10px;
        padding: 12px 32px;
        font-size: 1rem;
        background: linear-gradient(135deg, #4dabf7, #339af0);
        color: #fff;
        border: none;
        border-radius: 12px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(51, 154, 240, 0.3);
        transition: transform 0.2s, box-shadow 0.2s;
        text-decoration: none;
        display: inline-block;
      `;
      updateBtn.onmouseover = function(){this.style.transform="translateY(-2px)";this.style.boxShadow="0 6px 16px rgba(51, 154, 240, 0.4)";}
      updateBtn.onmouseout = function(){this.style.transform="translateY(0)";this.style.boxShadow="0 4px 12px rgba(51, 154, 240, 0.3)";}
      box.appendChild(updateBtn);
    }

    let okBtn = document.createElement("button");
    okBtn.textContent = "Got it";
    okBtn.style.cssText = `
      margin-top: 10px;
      padding: 12px 40px;
      font-size: 1rem;
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    `;
    okBtn.onmouseover = function(){this.style.background="rgba(255,255,255,0.2)";}
    okBtn.onmouseout = function(){this.style.background="rgba(255,255,255,0.1)";}
    okBtn.onclick = () => { document.body.removeChild(overlay); };
    box.appendChild(okBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (duration) setTimeout(() => {
      if (document.body.contains(overlay)) document.body.removeChild(overlay);
    }, duration);

    overlay.tabIndex = -1; overlay.focus();
    overlay.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
      }
    };

    if (!document.getElementById("geofs-atc-modal-anim")) {
      const style = document.createElement('style');
      style.id = "geofs-atc-modal-anim";
      style.textContent = `
        @keyframes popIn { from { transform:scale(0.85);opacity:0; } to { transform:scale(1);opacity:1; } }
      `;
      document.head.appendChild(style);
    }
  }

  function log(...args) {
    console.log('[ATC-Reporter]', ...args);
  }

  // --- Global Variables ---
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '', registration: '' };
  let isTransponderActive = false;
  
  // Load saved flight info
  try {
      const saved = localStorage.getItem('geofs_radar_flightinfo');
      if (saved) {
          const parsed = JSON.parse(saved);
          flightInfo = { ...flightInfo, ...parsed };
      }
  } catch(e) {}

  let flightUI;
  let wasOnGround = true;
  let takeoffTimeUTC = '';
    // ======= Update check (English) =======
  const CURRENT_VERSION = '1.9.6';
  const VERSION_JSON_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/version.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/userscript.js';
(function checkUpdate() {
  fetch(VERSION_JSON_URL)
    .then(r => r.json())
    .then(data => {
      if (data.version && data.version !== CURRENT_VERSION) {
        showModal(
          `🚩 GeoFS flightradar receiver new version available (${data.version})!<br>Please reinstall the latest user.js from GitHub.`,
          null,
          UPDATE_URL
        );
      }
    })
    .catch(() => {});
})();
  // --- WebSocket Management ---
  let ws;
  function connect() {
    const statusDot = document.querySelector('.geofs-radar-status');
    if (statusDot) statusDot.style.background = '#eab308'; // Connecting (Yellow)

    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected to ' + WS_URL);
        // Status dot will be updated when transponder is active
        safeSend({ type: 'hello', role: 'player' });
        showToast('Connected to Radar Server');
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        if (statusDot) {
            statusDot.style.background = '#ef4444'; // Disconnected (Red)
            statusDot.style.boxShadow = 'none';
        }
        setTimeout(connect, 2000);
      });
      ws.addEventListener('error', (e) => {
        console.warn('[ATC-Reporter] WS error', e);
        try { ws.close(); } catch {}
      });
    } catch (e) {
      console.warn('[ATC-Reporter] WS connect error', e);
      setTimeout(connect, 2000);
    }
  }
  connect();

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  // --- Utility Functions ---
  function getAircraftName() {
    try {
        // Try multiple sources for aircraft name
        return geofs?.aircraft?.instance?.aircraftRecord?.name || 
               geofs?.aircraft?.instance?.name || 
               geofs?.aircraft?.instance?.id || 
               'Unknown Aircraft';
    } catch (e) {
        return 'Unknown Aircraft';
    }
  }
  function getPlayerCallsign() {
    return geofs?.userRecord?.callsign || 'Unknown';
  }
  // --- AGL Calculation ---
  function calculateAGL() {
    try {
      const altitudeMSL = geofs?.animation?.values?.altitude;
      const groundElevationFeet = geofs?.animation?.values?.groundElevationFeet;
      const aircraft = geofs?.aircraft?.instance;

      if (
        typeof altitudeMSL === 'number' &&
        typeof groundElevationFeet === 'number' &&
        aircraft?.collisionPoints?.length >= 2 &&
        typeof aircraft.collisionPoints[aircraft.collisionPoints.length - 2]?.worldPosition?.[2] === 'number'
      ) {
        const collisionZFeet = aircraft.collisionPoints[aircraft.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        return Math.round((altitudeMSL - groundElevationFeet) + collisionZFeet);
      }
    } catch (err) {
      console.warn('[ATC-Reporter] AGL calculation error:', err);
    }
    return null;
  }

  // --- Takeoff Detection ---
  function checkTakeoff() {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    
    
    // If we are already flying and haven't set a time, set it now (approximate)
    if (!onGround && !takeoffTimeUTC) {
        takeoffTimeUTC = new Date().toISOString();
    }

    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
      console.log('[ATC-Reporter] Takeoff at', takeoffTimeUTC);
    }
    wasOnGround = onGround;
  }

  // --- Flight Status Snapshot ---
  function readSnapshot() {
    try {
      const inst = geofs?.aircraft?.instance;
      if (!inst) return null;

      const lla = inst.llaLocation || [];
      const lat = lla[0];
      const lon = lla[1];
      const altMeters = lla[2];

      if (typeof lat !== 'number' || typeof lon !== 'number') return null;

      const altMSL = (typeof altMeters === 'number') ? altMeters * 3.28084 : geofs?.animation?.values?.altitude ?? 0;
      const altAGL = calculateAGL();
      const heading = geofs?.animation?.values?.heading360 ?? 0;
      
      // Try to get ground speed first (m/s -> knots), then KIAS
      let speed = 0;
      // groundSpeed is usually in m/s in GeoFS backend
      if (typeof geofs?.animation?.values?.groundSpeed === 'number') {
          speed = geofs.animation.values.groundSpeed * 1.94384;
      } else if (typeof geofs?.animation?.values?.kias === 'number') {
          speed = geofs.animation.values.kias;
      } else if (typeof geofs?.aircraft?.instance?.trueAirSpeed === 'number') {
          speed = geofs.aircraft.instance.trueAirSpeed * 1.94384;
      }

      return { lat, lon, altMSL, altAGL, heading, speed: parseFloat(speed.toFixed(1)) };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- Build Payload ---
function buildPayload(snap) {
  checkTakeoff();
  // Debug Log
  if (Math.random() < 0.05) { // Log occasionally to avoid spam
      console.log('[ATC-Reporter] Snapshot:', snap, 'FlightInfo:', flightInfo);
  }
  
  let flightPlan = [];
  try {
    if (geofs.flightPlan && typeof geofs.flightPlan.export === "function") {
      flightPlan = geofs.flightPlan.export();
    }
  } catch (e) {}
 const userId = geofs?.userRecord?.id || null;
  
  // Use manual callsign if entered, otherwise fallback to GeoFS username
  const finalCallsign = flightInfo.flightNo ? flightInfo.flightNo : getPlayerCallsign();

  return {
    id: getPlayerCallsign(), // Keep ID as unique user identifier
    callsign: finalCallsign,
    type: getAircraftName(),
    lat: snap.lat,
    lon: snap.lon,
    alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
    altMSL: Math.round(snap.altMSL || 0),
    heading: Math.round(snap.heading || 0),
    speed: Math.round(snap.speed || 0),
    flightNo: flightInfo.flightNo,
    registration: flightInfo.registration,
    departure: flightInfo.departure,
    arrival: flightInfo.arrival,
    takeoffTime: takeoffTimeUTC,
    squawk: flightInfo.squawk,
    flightPlan: flightPlan,
    nextWaypoint: geofs.flightPlan?.trackedWaypoint?.ident || null,
    userId: userId,
    apiKey: localStorage.getItem('geofs_flightradar_apikey') || null
  };
}

  // --- Periodic Send ---
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (!isTransponderActive) return; // Only send if transponder is active
    const snap = readSnapshot();
    if (!snap) return;
    const payload = buildPayload(snap);
    safeSend({ type: 'position_update', payload });
  }, SEND_INTERVAL_MS);

  // --- Toast Notification ---
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.background = 'rgba(0,0,0,0.8)';
    toast.style.color = '#fff';
    toast.style.padding = '8px 12px';
    toast.style.borderRadius = '6px';
    toast.style.fontSize = '13px';
    toast.style.zIndex = 1000000;
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // --- Screenshot Capture ---
  function captureAndSendScreenshot() {
      try {
          const canvas = document.querySelector('canvas');
          if (canvas) {
              // Use lower quality to save bandwidth
              const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
              safeSend({ type: 'screenshot', payload: dataUrl });
              log('Screenshot sent');
          }
      } catch (e) {
          console.warn('[ATC-Reporter] Screenshot failed', e);
      }
  }

  // Send screenshot shortly after connection (once per session)
  let screenshotSent = false;
  setInterval(() => {
      if (ws && ws.readyState === 1 && !screenshotSent && geofs && geofs.aircraft && geofs.aircraft.instance) {
          // Wait until we are actually in a flight (aircraft loaded)
          captureAndSendScreenshot();
          screenshotSent = true;
      }
  }, 5000);

  // --- UI Injection ---
  function injectFlightUI() {
    flightUI = document.createElement('div');
    flightUI.id = 'flightInfoUI';
    flightUI.style.position = 'fixed';
    flightUI.style.bottom = '280px';
    flightUI.style.right = '20px';
    flightUI.style.zIndex = 999999;

    flightUI.innerHTML = `
      <style>
        .geofs-radar-panel {
          font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          width: 240px;
          background: rgba(15, 23, 42, 0.9);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 20px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
          color: #e2e8f0;
          transition: opacity 0.2s ease;
        }
        .geofs-radar-header {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 2px;
          color: #94a3b8;
          margin-bottom: 16px;
          font-weight: 800;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          user-select: none;
        }
        .geofs-radar-header-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .geofs-radar-min-btn {
            cursor: pointer;
            color: #64748b;
            transition: color 0.2s;
            font-size: 14px;
            line-height: 1;
            padding: 4px;
        }
        .geofs-radar-min-btn:hover { color: #fff; }
        .geofs-radar-status {
            width: 8px; height: 8px; background: #64748b; border-radius: 50%; box-shadow: none; transition: all 0.3s;
        }
        .geofs-radar-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }
        .geofs-radar-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .geofs-radar-label {
          font-size: 10px;
          color: #64748b;
          font-weight: 700;
          text-transform: uppercase;
        }
        .geofs-radar-input {
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          padding: 8px 10px;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          width: 100%;
          box-sizing: border-box;
          transition: all 0.2s;
          text-transform: uppercase;
          font-family: monospace;
        }
        .geofs-radar-input:focus {
          outline: none;
          border-color: #3b82f6;
          background: rgba(0, 0, 0, 0.4);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }
        .geofs-radar-btn {
          width: 100%;
          background: linear-gradient(135deg, #3b82f6, #2563eb);
          border: none;
          border-radius: 8px;
          color: white;
          padding: 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          transition: all 0.2s;
          box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }
        .geofs-radar-btn:hover {
          box-shadow: 0 6px 16px rgba(59, 130, 246, 0.5);
          transform: translateY(-1px);
        }
        .geofs-radar-btn:active {
          transform: translateY(1px);
        }
        .geofs-radar-content {
            transition: max-height 0.3s ease, opacity 0.3s ease;
            max-height: 500px;
            opacity: 1;
            overflow: hidden;
        }
        .geofs-radar-content.minimized {
            max-height: 0;
            opacity: 0;
            margin: 0;
        }
      </style>
      <div class="geofs-radar-panel">
        <div class="geofs-radar-header" id="radarHeader">
          <span>Flight Data</span>
          <div class="geofs-radar-header-controls">
            <div class="geofs-radar-status"></div>
            <div class="geofs-radar-min-btn" id="minBtn" title="Minimize">_</div>
            <div class="geofs-radar-min-btn" id="closeBtn" title="Hide (Press W)">×</div>
          </div>
        </div>
        <div class="geofs-radar-content" id="radarContent">
            <div class="geofs-radar-grid">
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Origin</label>
                <input id="depInput" class="geofs-radar-input" placeholder="----" maxlength="4" value="${flightInfo.departure}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Dest</label>
                <input id="arrInput" class="geofs-radar-input" placeholder="----" maxlength="4" value="${flightInfo.arrival}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Callsign</label>
                <input id="fltInput" class="geofs-radar-input" placeholder="UNK" value="${flightInfo.flightNo}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Reg</label>
                <input id="regInput" class="geofs-radar-input" placeholder="REG" value="${flightInfo.registration}">
            </div>
            <div class="geofs-radar-group">
                <label class="geofs-radar-label">Squawk</label>
                <input id="sqkInput" class="geofs-radar-input" placeholder="7000" maxlength="4" value="${flightInfo.squawk}">
            </div>
            <div class="geofs-radar-group" style="grid-column: span 2;">
                <label class="geofs-radar-label">API Key (Optional)</label>
                <input id="apiKeyInput" class="geofs-radar-input" placeholder="Paste Key from Radar Website" value="${localStorage.getItem('geofs_flightradar_apikey') || ''}" style="font-size: 11px;">
            </div>
            </div>
            <button id="saveBtn" class="geofs-radar-btn">Update Transponder</button>
        </div>
      </div>
    `;

    document.body.appendChild(flightUI);

    // Drag Logic
    const header = document.getElementById('radarHeader');
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    // Load saved position
    try {
        const savedPos = localStorage.getItem('geofs_radar_ui_pos');
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            xOffset = pos.x;
            yOffset = pos.y;
            setTranslate(xOffset, yOffset, flightUI);
        }
    } catch(e) {}

    header.addEventListener("mousedown", dragStart);
    document.addEventListener("mouseup", dragEnd);
    document.addEventListener("mousemove", drag);

    function dragStart(e) {
      // Ignore if clicking buttons inside header
      if (e.target.closest('.geofs-radar-min-btn')) return;
      
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (header.contains(e.target)) {
        isDragging = true;
      }
    }

    function dragEnd(e) {
      initialX = currentX;
      initialY = currentY;
      isDragging = false;
      
      // Save position
      localStorage.setItem('geofs_radar_ui_pos', JSON.stringify({ x: xOffset, y: yOffset }));
    }

    function drag(e) {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, flightUI);
      }
    }

    function setTranslate(xPos, yPos, el) {
      el.style.transform = "translate3d(" + xPos + "px, " + yPos + "px, 0)";
    }

    // Minimize Logic
    const minBtn = document.getElementById('minBtn');
    const closeBtn = document.getElementById('closeBtn');
    const content = document.getElementById('radarContent');
    
    minBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    minBtn.onclick = (e) => {
        e.stopPropagation();
        content.classList.toggle('minimized');
        minBtn.textContent = content.classList.contains('minimized') ? '□' : '_';
    };

    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        flightUI.style.display = 'none';
        showToast('Press W to show Flight Info');
    };

    // Auto-uppercase input fields
    ['depInput','arrInput','fltInput','sqkInput', 'regInput'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => {
        el.value = el.value.toUpperCase();
      });
    });

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      flightInfo.registration = document.getElementById('regInput').value.trim();
      
      const apiKey = document.getElementById('apiKeyInput').value.trim();
      if (apiKey) {
          localStorage.setItem('geofs_flightradar_apikey', apiKey);
      } else {
          localStorage.removeItem('geofs_flightradar_apikey');
      }

      localStorage.setItem('geofs_radar_flightinfo', JSON.stringify(flightInfo));
      
      isTransponderActive = true;
      const statusDot = document.querySelector('.geofs-radar-status');
      if (statusDot) {
          statusDot.style.background = '#22c55e';
          statusDot.style.boxShadow = '0 0 10px #22c55e';
      }
      
      showToast('Transponder Updated & Active');
    };
  }
  injectFlightUI();

  // --- Hotkey W to Toggle UI ---
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'w') {
      if (flightUI.style.display === 'none') {
        flightUI.style.display = 'block';
        showToast('Flight Info UI Shown');
      } else {
        flightUI.style.display = 'none';
        showToast('Flight Info UI Hidden');
      }
    }
  });

  // --- Disable Autocomplete for Inputs ---
  document.querySelectorAll("input").forEach(el => {
    el.setAttribute("autocomplete", "off");
  });

  // --- Prevent Input from Triggering GeoFS Hotkeys ---
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      e.stopPropagation();
    }
  }, true);

})();
