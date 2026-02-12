// ==UserScript==
// @name         GeoFS Flightradar
// @namespace    http://tampermonkey.net/
// @version      4.7.2
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
  const WS_URL = 'wss://radar.yugp.me/ws';
  const SSE_POST_URL = 'https://sse.radarthing.com/api/atc/position';
  const RADARTHING_WS_URL = SSE_POST_URL
    .replace('https://', 'wss://')
    .replace('http://', 'ws://')
    .replace('/api/atc/position', '/ws');
  const SEND_INTERVAL_MS = 1000;
  // Track which airline codes we've prefetched in this session
  const prefetchedLogos = new Set();
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

    // Allow clicking outside the box to dismiss the modal
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        if (document.body.contains(overlay)) document.body.removeChild(overlay);
      }
    };

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

  // --- On-screen Debug Panel (helps when browser console isn't available) ---
  const ATC_ICON_COLOR = '#ffd700';
  const ATC_ICON_BORDER = '#000000';


  // atcDebugLog removed (on-screen debug panel disabled)



  // --- Global Variables ---
  let flightInfo = { departure: '', arrival: '', flightNo: '', squawk: '', registration: '' };
  let isTransponderActive = localStorage.getItem('geofs_radar_transponder_active') === 'true';
  let prevAltMSL = null;
  let prevAltTs = null;
  
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
  let actualDeparture = null;
  let actualArrival = null;
  
  // Diversion tracking
  let originalArrival = null;  // The arrival set at takeoff time
  let divertedTo = null;       // New destination if diverted
  let isDiverted = false;      // Whether a diversion occurred
  let flightStartedWithArrival = false; // Whether we had an arrival set at takeoff

  // --- Airport Manager ---
  const AirportManager = {
    airports: [],
    airportByCode: new Map(),
    loaded: false,
    
    async load() {
      try {
        const res = await fetch('https://raw.githubusercontent.com/mwgg/Airports/master/airports.json');
        const data = await res.json();
        this.airports = Object.values(data);
        this.airportByCode = new Map();
        for (const apt of this.airports) {
          const icao = (apt?.icao || '').toString().trim().toUpperCase();
          const iata = (apt?.iata || '').toString().trim().toUpperCase();
          if (icao) this.airportByCode.set(icao, apt);
          // Prefer ICAO when both exist; only set IATA if unused
          if (iata && !this.airportByCode.has(iata)) this.airportByCode.set(iata, apt);
        }
        this.loaded = true;
        console.log('[ATC-Reporter] Airports loaded:', this.airports.length);
      } catch (e) {
        console.warn('[ATC-Reporter] Failed to load airports:', e);
      }
    },

    getNearest(lat, lon) {
      if (!this.loaded) return null;
      let minDst = Infinity;
      let nearest = null;
      
      for (const apt of this.airports) {
        const d = Math.sqrt(Math.pow(apt.lat - lat, 2) + Math.pow(apt.lon - lon, 2));
        if (d < minDst) {
          minDst = d;
          nearest = apt;
        }
      }
      
      // Threshold (e.g. 0.1 degrees ~ 10km)
      if (minDst < 0.1) return nearest;
      return null;
    }
  };
  
  AirportManager.load();

  function cleanupOverlays() {
    try {
      const stray = document.getElementById('geofs-atc-modal');
      if (stray && stray.parentElement) stray.parentElement.removeChild(stray);
    } catch (e) {}

    try {
      
      document.querySelectorAll('body > *').forEach(el => {
        try {
          const cs = window.getComputedStyle(el);
          const isFixed = cs.position === 'fixed';
          const isFullscreen = (cs.top === '0px' && cs.left === '0px' && (cs.width === '100vw' || cs.width === '100%' || cs.width === window.innerWidth + 'px') && (cs.height === '100vh' || cs.height === '100%' || cs.height === window.innerHeight + 'px'));
          const z = parseInt(cs.zIndex || 0, 10) || 0;
          if (isFixed && isFullscreen && z >= 10000) {
            el.remove();
          }
        } catch (err) {}
      });
    } catch (e) {}

    try {
      
      const root = document.getElementById('react-root'); if (root) root.style.display = 'block';
      const mapEl = document.getElementById('map'); if (mapEl) mapEl.style.display = 'block';
      const cesiumEl = document.getElementById('cesiumContainer'); if (cesiumEl) cesiumEl.style.display = 'block';
    } catch (e) {}
  }

 
  cleanupOverlays();
  const overlayCleanupInterval = setInterval(cleanupOverlays, 2000);
  setTimeout(() => clearInterval(overlayCleanupInterval), 20000);

  // --- Flight Logger Integration ---
  const FlightLogger = {
    webhooks: {},
    airlineCodes: {},
    userInfo: null,
    flightStarted: false,
    flightStartTime: null,
    departureICAO: "UNKNOWN",
    arrivalICAO: "UNKNOWN",
    firstGroundContact: false,
    oldAGL: 0,
    newAGL: 0,
    calculatedVerticalSpeed: 0,
    oldTime: Date.now(),
    bounces: 0,
    isGrounded: true,
    justLanded: false,
    teleportWarnings: 0,
    teleportCooloffUntil: 0,
    lastPosition: null,
    lastPositionTime: null,
    
    async init() {
        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/webhooks`);
            this.webhooks = await res.json();
            console.log('[FlightLogger] Webhooks loaded:', Object.keys(this.webhooks).length);
        } catch (e) {
            console.warn('[FlightLogger] Failed to load webhooks:', e);
        }

        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/airline_codes`);
            this.airlineCodes = await res.json();
            console.log('[FlightLogger] Airline codes loaded:', Object.keys(this.airlineCodes).length);
        } catch (e) {
            console.warn('[FlightLogger] Failed to load airline codes:', e);
        }

        try {
            const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
            const res = await fetch(`${httpUrl}/api/me`, { credentials: 'include' });
            if (res.ok) {
                this.userInfo = await res.json();
                console.log('[FlightLogger] User authenticated:', this.userInfo.username);
            }
        } catch (e) {
            console.warn('[FlightLogger] Failed to fetch user info:', e);
        }

        setInterval(() => this.monitor(), 1000);
        setInterval(() => this.updateCalVertS(), 25);
    },

    updateCalVertS() {
        if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values || geofs.isPaused()) return;
        
        const values = geofs.animation.values;
        const inst = geofs.aircraft?.instance;
        if (!inst || !inst.collisionPoints || inst.collisionPoints.length < 2) return;

        const alt = values.altitude;
        const ground = values.groundElevationFeet;
        if (alt === undefined || ground === undefined) return;

        const collisionZ = inst.collisionPoints[inst.collisionPoints.length - 2].worldPosition[2] * 3.2808399;
        const currentAGL = (alt - ground) + collisionZ;

        if (currentAGL !== this.oldAGL) {
            const newTime = Date.now();
            const timeDiff = newTime - this.oldTime;
            if (timeDiff > 0) {
                this.calculatedVerticalSpeed = (currentAGL - this.oldAGL) * (60000 / timeDiff);
                this.oldAGL = currentAGL;
                this.oldTime = newTime;
            }
        }
    },

    monitor() {
        if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values || !geofs.aircraft || !geofs.aircraft.instance) return;
        
        const values = geofs.animation.values;
        const onGround = values.groundContact;
        const altitudeFt = values.altitude * 3.28084;
        const [lat, lon] = geofs.aircraft.instance.llaLocation || [values.latitude, values.longitude];
        const now = Date.now();

      // If we recently flagged a teleport, suppress state changes until cooldown ends
      if (this.teleportCooloffUntil && now < this.teleportCooloffUntil) {
        this.lastPosition = { lat, lon, altitude: altitudeFt };
        this.lastPositionTime = now;
        return;
      }

        if (this.flightStarted && this.lastPosition) {
             const dist = this.calculateDistance(this.lastPosition.lat, this.lastPosition.lon, lat, lon);
             const timeDiff = (now - this.lastPositionTime) / 1000;
         const tooFast = timeDiff > 0.3 && (dist / timeDiff) > 20; // >20 km/s (~10 km in 0.5s)
         const bigJump = timeDiff <= 0.6 && dist > 10; // explicit 10 km in ~0.5s
         if (tooFast || bigJump) {
           this.teleportWarnings++;
           this.teleportCooloffUntil = now + 8000;
           this.flightStarted = false; // force a fresh start after a teleport
           this.firstGroundContact = false;
           this.justLanded = false;
           console.warn('[FlightLogger] Teleport detected! Suppressing updates for 8s.');
           this.lastPosition = { lat, lon, altitude: altitudeFt };
           this.lastPositionTime = now;
           return;
         }
        }
        this.lastPosition = { lat, lon, altitude: altitudeFt };
        this.lastPositionTime = now;

        const enhancedAGL = (values.altitude !== undefined && values.groundElevationFeet !== undefined) ?
          ((values.altitude - values.groundElevationFeet) +
           (geofs.aircraft.instance.collisionPoints[geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2] * 3.2808399))
          : 0;

        if (enhancedAGL < 500) {
          if (onGround && !this.isGrounded) {
              this.justLanded = true;
          }
          this.isGrounded = onGround;
        }

        if (!this.flightStarted && !onGround && enhancedAGL > 100) {
            this.flightStarted = true;
            this.flightStartTime = now;
            const apt = AirportManager.getNearest(lat, lon);
            this.departureICAO = apt ? (apt.icao || apt.iata || "UNKNOWN") : "UNKNOWN";
            this.teleportWarnings = 0;
            this.bounces = 0;
            this.firstGroundContact = false;
            console.log(`[FlightLogger] Flight started from ${this.departureICAO}`);
            if (typeof showToast === 'function') showToast(`Flight Started from ${this.departureICAO}`);
        }

        const elapsed = (now - this.flightStartTime) / 1000;
        
        // Landing Detection
        if (this.flightStarted && onGround && enhancedAGL <= 50) {
             // Check for Teleportation (prevent false landing log)
             if (this.teleportWarnings > 0) {
                 console.log('[FlightLogger] Teleport detected on arrival - resetting flight without logging.');
                 this.flightStarted = false;
                 this.teleportWarnings = 0;
                 return;
             }

             
             if (elapsed < 30) {
                 return;
             }

             if (!this.firstGroundContact) {
                 this.firstGroundContact = true;
                 
                 // Calculate landing stats
                 const vs = this.calculatedVerticalSpeed !== 0 && Math.abs(this.calculatedVerticalSpeed) < 5000
                    ? this.calculatedVerticalSpeed
                    : values.verticalSpeed || 0;

                let quality = "CRASH";
                if (vs >= -50) quality = "SUPER BUTTER";
                else if (vs >= -200) quality = "BUTTER";
                else if (vs >= -500) quality = "ACCEPTABLE";
                else if (vs >= -1000) quality = "HARD";

                const apt = AirportManager.getNearest(lat, lon);
                this.arrivalICAO = apt ? (apt.icao || apt.iata || "UNKNOWN") : "UNKNOWN";

                if (vs <= -1000 || vs > 200) {
                    quality = "CRASH";
                    if (typeof showToast === 'function') showToast("💥 CRASH DETECTED");
                } else {
                    if (typeof showToast === 'function') showToast(`🛬 Landed at ${this.arrivalICAO} (${quality})`);
                }

                this.sendLog(vs, quality);
                try {
                  const gsKts = typeof values.groundSpeed === 'number' ? values.groundSpeed * 1.94384 : (typeof values.kias === 'number' ? values.kias : 0);
                  clearFlightPlan({
                    lat,
                    lon,
                    altAGL: enhancedAGL,
                    altMSL: altitudeFt,
                    heading: values.heading360 || 0,
                    speed: gsKts,
                    verticalSpeedFpm: vs
                  });
                } catch (e) {
                  console.warn('[FlightLogger] Failed to clear plan after landing:', e);
                }
                this.flightStarted = false;
                this.justLanded = true;
             }
        }
    },

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    },

    sendLog(vs, quality) {
      const callsign = flightInfo.flightNo || getPlayerCallsign() || geofs?.userRecord?.callsign || 'Unknown';
        
      let webhookUrl = null;
      let webhookCode = null;
      let logoCode = 'GFS';

      // 1. Prefer 3-letter ICAO prefix for logo; map to IATA if known for logo fetch
      const match3 = callsign.match(/^([A-Z]{3})/i);
      if (match3) {
        const code = match3[1].toUpperCase();
        logoCode = this.airlineCodes?.[code] || code;
        if (this.webhooks[code]) {
          webhookCode = code;
        } else if (this.airlineCodes?.[code] && this.webhooks[this.airlineCodes[code]]) {
          // Allow ICAO→IATA mapping for webhook lookup
          webhookCode = this.airlineCodes[code];
        }
      }

      // 2. Try 2-letter IATA prefix for webhook/logo if ICAO not matched
      if (!webhookCode) {
        const match2 = callsign.match(/^([A-Z]{2})/i);
        if (match2) {
          const code = match2[1].toUpperCase();
          logoCode = logoCode || code;
          if (this.webhooks[code]) {
            webhookCode = code;
          }
        }
      }

      // 3. Fallback webhook
      webhookUrl = webhookCode ? this.webhooks[webhookCode] : this.webhooks["GFS"];

        if (!webhookUrl) {
            console.warn('[FlightLogger] No webhook found for callsign:', callsign);
            return;
        }

        const aircraft = getAircraftName();
        const durationMin = Math.round((Date.now() - this.flightStartTime) / 60000);
        const formattedDuration = `${Math.floor(durationMin / 60).toString().padStart(2, '0')}:${(durationMin % 60).toString().padStart(2, '0')}`;
        
        const pilotName = this.userInfo ? `<@${this.userInfo.discordId}>` : (callsign || "Unknown");

        let embedColor = 0x0099FF;
        if (quality === "CRASH") embedColor = 0xDC143C;
        else if (quality === "HARD") embedColor = 0xFF8000;
        else if (quality === "SUPER BUTTER") embedColor = 0x00FF00;

        // Use Server Logo Proxy
        // The server handles: Local File -> IATA Lookup -> CDN Redirect
        const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
        const logoUrl = `${httpUrl}/logos/${logoCode || 'GFS'}.png`;
        const flightUrl = `${httpUrl}/?flight=${encodeURIComponent(callsign)}`;

        const message = {
            embeds: [{
                title: "🛫 Flight Report - GeoFS",
                url: flightUrl,
                color: embedColor,
                thumbnail: { url: logoUrl },
                fields: [
                    { name: "✈️ Flight Information", value: `**Flight no.**: ${callsign}\n**Pilot**: ${pilotName}\n**Aircraft**: ${aircraft}`, inline: false },
                    { name: "📍 Route", value: `**Departure**: ${this.departureICAO}\n**Arrival**: ${this.arrivalICAO}`, inline: true },
                    { name: "⏱️ Duration", value: `**Time**: ${formattedDuration}`, inline: true },
                    { name: "📊 Landing", value: `**V/S**: ${vs.toFixed(1)} fpm\n**Quality**: ${quality}\n**Bounces**: ${this.bounces}`, inline: true },
                    { name: "🔗 Track", value: `[View on GeoFS Radar](${flightUrl})`, inline: false }
                ],
                timestamp: new Date().toISOString(),
                footer: { text: "GeoFS Radar • radar.yugp.me" + (this.teleportWarnings > 0 ? " | ⚠️ Teleport Detected" : "") }
            }]
        };

        fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message)
        }).then(() => console.log('[FlightLogger] Log sent'))
          .catch(e => console.error('[FlightLogger] Failed to send log:', e));
    }
  };
  setTimeout(() => FlightLogger.init(), 5000);

    // ======= Update check (English) =======
  const CURRENT_VERSION = '4.7.2';
  const VERSION_JSON_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/version.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/jthweb/JThweb/main/radar.user.js';
(function checkUpdate() {
  fetch(VERSION_JSON_URL)
    .then(r => r.json())
    .then(data => {
      if (data.version && data.version !== CURRENT_VERSION) {
        showModal(
          `✈️ GeoFS FlightRadar receiver new version available (${data.version})!<br>Please reinstall the latest user.js from GitHub.`,
          null,
          UPDATE_URL
        );
      }
    })
    .catch(() => {});
})();
  // --- WebSocket Management ---
  let ws;
  let radarthingWs;
  function updateStatusDot() {
    const statusDot = document.querySelector('.geofs-radar-status');
    if (!statusDot) return;

    if (ws && ws.readyState === 0) {
      statusDot.style.background = '#eab308'; // Connecting (Yellow)
      statusDot.style.boxShadow = '0 0 8px rgba(234, 179, 8, 0.5)';
    } else if (!ws || ws.readyState !== 1) {
      statusDot.style.background = '#ef4444'; // Disconnected (Red)
      statusDot.style.boxShadow = 'none';
    } else if (!isTransponderActive) {
      statusDot.style.background = '#3b82f6'; // Connected, Inactive (Blue)
      statusDot.style.boxShadow = '0 0 8px rgba(59, 130, 246, 0.5)';
    } else {
      statusDot.style.background = '#22c55e'; // Active (Green)
      statusDot.style.boxShadow = '0 0 10px #22c55e';
    }
  }

  function findAirportByCode(code) {
    const normalized = (code || '').toString().trim().toUpperCase();
    if (!normalized || !AirportManager.loaded) return null;
    return AirportManager.airportByCode.get(normalized) || null;
  }

  function formatAirportFullName(airport) {
    if (!airport) return '';
    return (airport.name || '').toString();
  }

  function refreshAirportTooltips() {
    const depEl = document.getElementById('depInput');
    const arrEl = document.getElementById('arrInput');
    if (!depEl || !arrEl) return;

    const depAirport = findAirportByCode(depEl.value);
    const arrAirport = findAirportByCode(arrEl.value);

    depEl.title = formatAirportFullName(depAirport);
    arrEl.title = formatAirportFullName(arrAirport);
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const statusDot = document.querySelector('.geofs-radar-status');
    if (statusDot) statusDot.style.background = '#eab308'; // Connecting (Yellow)

    try {
      ws = new WebSocket(WS_URL);
      ws.addEventListener('open', () => {
        log('WS connected to ' + WS_URL);
        updateStatusDot();
        safeSend({ type: 'hello', role: 'player' });
        showToast('Connected to Radar Server');
      });
      ws.addEventListener('close', () => {
        log('WS closed, retrying...');
        updateStatusDot();
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

  function connectRadarthing() {
    if (radarthingWs && (radarthingWs.readyState === 0 || radarthingWs.readyState === 1)) return;
    try {
      radarthingWs = new WebSocket(RADARTHING_WS_URL);
      radarthingWs.addEventListener('open', () => {
        log('RadarThing WS connected to ' + RADARTHING_WS_URL);
      });
      radarthingWs.addEventListener('close', () => {
        setTimeout(connectRadarthing, 4000);
      });
      radarthingWs.addEventListener('error', () => {
        try { radarthingWs.close(); } catch {}
      });
    } catch (e) {
      setTimeout(connectRadarthing, 4000);
    }
  }
  connectRadarthing();

  // Some browsers/userscript engines miss a single event-driven update;
  // keep the status dot accurate across reconnects/UI timing.
  setInterval(updateStatusDot, 1000);

  function safeSend(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] send error', e);
    }
  }

  function safeSendRadarthing(obj) {
    try {
      if (radarthingWs && radarthingWs.readyState === 1) radarthingWs.send(JSON.stringify(obj));
    } catch (e) {
      console.warn('[ATC-Reporter] RadarThing send error', e);
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

  // Extracts an airline code (ICAO 3 / IATA 2) from a callsign string
  function getAirlineCodeFromCallsign(callsign) {
    const cs = (callsign || '').toString().trim().toUpperCase();
    if (!cs) return 'GFS';
    const match3 = cs.match(/^([A-Z]{3})/);
    const match2 = cs.match(/^([A-Z]{2})/);
    if (match3) return match3[1];
    if (match2) return match2[1];
    return 'GFS';
  }

  // Attempt to prefetch server-hosted logo to warm browser cache
  function prefetchLogoForCallsign(callsign) {
    try {
      const code = getAirlineCodeFromCallsign(callsign);
      if (!code || prefetchedLogos.has(code)) return;
      prefetchedLogos.add(code);
      const httpUrl = WS_URL.startsWith('wss://') ? WS_URL.replace('wss://', 'https://') : WS_URL.replace('ws://', 'http://');
      const url = `${httpUrl}/logos/${code}.png`;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => log('[ATC-Reporter] Prefetched logo for', code);
      img.onerror = () => { /* ignore */ };
      img.src = url;
    } catch (e) { /* ignore */ }
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
  function checkTakeoff(snap) {
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    
    // If we are already flying and haven't set a time, set it now (approximate)
    if (!onGround && !takeoffTimeUTC) {
        takeoffTimeUTC = new Date().toISOString();
    }

    if (wasOnGround && !onGround) {
      takeoffTimeUTC = new Date().toISOString();
      console.log('[ATC-Reporter] Takeoff at', takeoffTimeUTC);
      
      if (snap) {
          const apt = AirportManager.getNearest(snap.lat, snap.lon);
          if (apt) {
              actualDeparture = apt.icao || apt.iata || apt.name;
              showToast(`Departed from ${apt.name}`);
          }
      }
      actualArrival = null;
      
      // Store the original arrival at takeoff time for diversion tracking
      originalArrival = flightInfo.arrival || null;
      flightStartedWithArrival = !!flightInfo.arrival;
      divertedTo = null;
      isDiverted = false;
      console.log('[ATC-Reporter] Original arrival set:', originalArrival);
    }

    if (!wasOnGround && onGround) {
        if (snap) {
            const apt = AirportManager.getNearest(snap.lat, snap.lon);
            if (apt) {
                actualArrival = apt.icao || apt.iata || apt.name;
                showToast(`Landed at ${apt.name}`);
            }
        }
        // Reset diversion state on landing
        originalArrival = null;
        divertedTo = null;
        isDiverted = false;
        flightStartedWithArrival = false;
    }

    wasOnGround = onGround;
  }
  
  // --- Diversion Detection ---
  function checkDiversion() {
    // Only check for diversion if we're in the air and had an arrival set at takeoff
    const onGround = geofs?.aircraft?.instance?.groundContact ?? true;
    if (onGround || !flightStartedWithArrival) return;
    
    const currentArrival = flightInfo.arrival;
    
    // If the arrival changed and it's different from the original
    if (currentArrival && originalArrival && currentArrival !== originalArrival && currentArrival !== divertedTo) {
      divertedTo = currentArrival;
      isDiverted = true;
      console.log('[ATC-Reporter] DIVERSION DETECTED! Original:', originalArrival, 'New:', divertedTo);
      showToast(`✈️ DIVERTED to ${divertedTo}`);
    }
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
      const now = Date.now();
      
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

      let vsFpm = 0;
      const vsRaw = geofs?.animation?.values?.verticalSpeed ??
                   geofs?.animation?.values?.verticalVelocity ??
                   geofs?.animation?.values?.verticalSpeedFPM ??
                   geofs?.animation?.values?.verticalSpeedFpm ??
                   geofs?.animation?.values?.vs;

      if (typeof vsRaw === 'number') {
        const abs = Math.abs(vsRaw);
        // If the magnitude is small, assume m/s and convert; otherwise assume already fpm
        vsFpm = abs <= 50 ? Math.round(vsRaw * 196.8504) : Math.round(vsRaw);
      }

      if (!vsFpm && typeof altMSL === 'number') {
        const dtMs = now - (prevAltTs || now);
        if (dtMs > 0 && prevAltMSL !== null) {
          vsFpm = Math.round((altMSL - prevAltMSL) / (dtMs / 60000));
        }
        prevAltMSL = altMSL;
        prevAltTs = now;
      } else {
        prevAltMSL = altMSL;
        prevAltTs = now;
      }

      // Wind Data
      let windSpeed = 0;
      let windDir = 0;
      if (geofs?.animation?.values?.windSpeed) {
          windSpeed = geofs.animation.values.windSpeed * 1.94384; // m/s to knots
      }
      if (geofs?.animation?.values?.windDir) {
          windDir = geofs.animation.values.windDir;
      }

      return { lat, lon, altMSL, altAGL, heading, speed: parseFloat(speed.toFixed(1)), verticalSpeedFpm: vsFpm, windSpeed, windDir };
    } catch (e) {
      console.warn('[ATC-Reporter] readSnapshot error:', e);
      return null;
    }
  }

  // --- Build Payload ---
function buildPayload(snap) {
  checkTakeoff();
  checkDiversion();  // Check if destination changed during flight
  
  // Debug Log
  if (Math.random() < 0.05) { // Log occasionally to avoid spam
      console.log('[ATC-Reporter] Snapshot:', snap, 'FlightInfo:', flightInfo);
  }
  
  const rawPlan = geofs.flightPlan?.export ? geofs.flightPlan.export() : (geofs.flightPlan?.plan || geofs.flightPlan?.waypoints || geofs.flightPlan?.route || []);
  const flightPlan = Array.isArray(rawPlan) ? rawPlan : (rawPlan?.points && Array.isArray(rawPlan.points) ? rawPlan.points : []);
  const nextWaypoint = geofs.flightPlan?.trackedWaypoint?.ident || null;
  const userId = geofs?.userRecord?.id || null;
  
  // Use manual callsign (flight number) if entered, otherwise fallback to player callsign, then GeoFS username
  const finalCallsign = flightInfo.flightNo ? flightInfo.flightNo : (getPlayerCallsign() || geofs?.userRecord?.callsign || 'Unknown');

  return {
    id: geofs?.userRecord?.googleid || flightInfo.flightNo || getPlayerCallsign() || geofs?.userRecord?.callsign || null,
    googleId: geofs?.userRecord?.googleid || null,
    callsign: finalCallsign,
    type: geofs?.aircraft?.instance?.aircraftRecord?.name || getAircraftName() || "Unknown",
    lat: snap.lat,
    lon: snap.lon,
    alt: (typeof snap.altAGL === 'number') ? snap.altAGL : Math.round(snap.altMSL || 0),
    altMSL: Math.round(snap.altMSL || 0),
    heading: Math.round(snap.heading || 0),
    speed: Math.round(snap.speed || 0),
    flightNo: flightInfo.flightNo,
    departure: flightInfo.departure,
    arrival: flightInfo.arrival,
    takeoffTime: takeoffTimeUTC,
    squawk: flightInfo.squawk,
    flightPlan: flightPlan,
    nextWaypoint: nextWaypoint,
    vspeed: Math.floor(geofs.animation?.values?.verticalSpeed || 0),
    actualDeparture: actualDeparture,
    actualArrival: actualArrival,
    registration: flightInfo.registration,
    userId: userId,
    playerId: userId,
    apiKey: localStorage.getItem('geofs_flightradar_apikey') || null,
    // Diversion information
    isDiverted: isDiverted,
    originalArrival: originalArrival,
    divertedTo: divertedTo
  };
}

  // --- Periodic Send ---
  let lastFlightPlanHash = "";

  function clearFlightPlan(snap = null) {
    lastFlightPlanHash = "";

    try {
      if (geofs?.flightPlan?.clear) {
        geofs.flightPlan.clear();
      } else if (geofs?.flightPlan) {
        geofs.flightPlan.plan = [];
        if ('trackedWaypoint' in geofs.flightPlan) geofs.flightPlan.trackedWaypoint = null;
        if (typeof geofs.flightPlan.render === 'function') geofs.flightPlan.render();
      }
    } catch (e) {
      console.warn('[ATC-Reporter] Failed to clear local flight plan:', e);
    }

    try {
      const baseSnap = snap || readSnapshot();
      const payload = {
        id: geofs?.userRecord?.googleid || flightInfo.flightNo || getPlayerCallsign() || null,
        googleId: geofs?.userRecord?.googleid || null,
        callsign: flightInfo.flightNo || getPlayerCallsign() || geofs?.userRecord?.callsign || 'Unknown',
        flightNo: flightInfo.flightNo,
        departure: flightInfo.departure,
        arrival: flightInfo.arrival,
        registration: flightInfo.registration,
        flightPlan: [],
        nextWaypoint: null,
        lat: baseSnap?.lat ?? null,
        lon: baseSnap?.lon ?? null,
        alt: Math.round(baseSnap?.altAGL ?? 0),
        altMSL: Math.round(baseSnap?.altMSL ?? 0),
        heading: Math.round(baseSnap?.heading ?? 0),
        speed: Math.round(baseSnap?.speed ?? 0),
        vspeed: Math.round(baseSnap?.verticalSpeedFpm ?? 0),
        apiKey: localStorage.getItem('geofs_flightradar_apikey') || null
      };
      safeSend({ type: 'position_update', payload });
    } catch (e) {
      console.warn('[ATC-Reporter] Failed to push cleared flight plan:', e);
    }
  }
  
  setInterval(() => {
    try {
      if (!ws || ws.readyState !== 1) return;
      
      if (!isTransponderActive) {
        // Send heartbeat every 10 seconds to keep connection alive
        if (Date.now() % 10000 < SEND_INTERVAL_MS) {
          safeSend({ type: 'heartbeat' });
        }
        return;
      }

      if (FlightLogger.teleportCooloffUntil && Date.now() < FlightLogger.teleportCooloffUntil) {
        console.warn('[ATC-Reporter] Skipping update due to recent teleport');
        return;
      }

      const snap = readSnapshot();
      if (!snap) return;
      
          const payload = buildPayload(snap);
      // include desired icon color/border so the server/client can use it if needed
      try { payload.iconColor = ATC_ICON_COLOR; payload.iconBorder = ATC_ICON_BORDER; } catch(e){}
      
      // Optimize: Only send flight plan if it changed
      const currentPlanHash = JSON.stringify(payload.flightPlan);
      if (currentPlanHash === lastFlightPlanHash) {
          delete payload.flightPlan;
      } else {
          lastFlightPlanHash = currentPlanHash;
      }
      
      try { console.log('[ATC-Reporter] Sending position_update', { callsign: payload.callsign, type: payload.type, iconColor: payload.iconColor }); } catch(e){}
      safeSend({ type: 'position_update', payload });

      // Also send full details to external SSE endpoint (non-blocking)
      try {
        const ssePayload = { ...payload, flightInfo: { ...flightInfo }, ts: Date.now() };
        const body = JSON.stringify(ssePayload);
        // Prefer sendBeacon for reliability on unload when available
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          try {
            const blob = new Blob([body], { type: 'application/json' });
            navigator.sendBeacon(SSE_POST_URL, blob);
          } catch (e) {
            // fallback to fetch
            fetch(SSE_POST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(e => console.warn('[ATC-Reporter] SSE post failed', e));
          }
        } else {
          fetch(SSE_POST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(e => console.warn('[ATC-Reporter] SSE post failed', e));
        }
      } catch (e) { console.warn('[ATC-Reporter] SSE post error', e); }

      // Send to RadarThing WebSocket if available
      try {
        const wsPayload = { type: 'position_update', payload: { ...payload, flightInfo: { ...flightInfo }, ts: Date.now() } };
        safeSendRadarthing(wsPayload);
      } catch (e) { console.warn('[ATC-Reporter] RadarThing WS error', e); }

      // Prefetch corresponding airline logo once per code per session
      try { prefetchLogoForCallsign(payload.callsign || payload.flightNo || getPlayerCallsign()); } catch (e) {}
    } catch (e) {
      console.warn('[ATC-Reporter] Periodic send error:', e);
    }
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
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&display=swap');
        .geofs-radar-panel {
          font-family: "Rajdhani", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          width: 260px;
          background: linear-gradient(160deg, rgba(10, 18, 28, 0.95), rgba(7, 12, 18, 0.75));
          backdrop-filter: blur(14px) saturate(170%);
          -webkit-backdrop-filter: blur(14px) saturate(170%);
          border: 1px solid rgba(90, 200, 255, 0.18);
          border-radius: 18px;
          padding: 18px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
          color: #e2e8f0;
          transition: opacity 0.2s ease;
          cursor: grab; /* indicate draggable area */
        }
        .geofs-radar-input, .geofs-radar-btn, .geofs-radar-min-btn { cursor: default; /* interactive controls keep default cursor */ }
        .geofs-radar-header {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 2.5px;
          color: rgba(187, 230, 255, 0.9);
          margin-bottom: 14px;
          font-weight: 700;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          user-select: none;
          text-shadow: 0 2px 8px rgba(0,0,0,0.4);
        }
        .geofs-radar-header-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .geofs-radar-min-btn {
            cursor: pointer;
            color: rgba(255, 255, 255, 0.6);
            transition: color 0.2s;
            font-size: 14px;
            line-height: 1;
            padding: 4px;
        }
        .geofs-radar-min-btn:hover { color: #fff; }
        .geofs-radar-status {
            width: 8px; height: 8px; background: #64748b; border-radius: 50%; box-shadow: 0 0 8px rgba(100, 116, 139, 0.5); transition: all 0.3s;
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
          color: rgba(255, 255, 255, 0.5);
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .geofs-radar-input {
          background: rgba(6, 16, 26, 0.7);
          border: 1px solid rgba(90, 200, 255, 0.18);
          border-radius: 10px;
          padding: 8px 10px;
          color: #e5f6ff;
          font-size: 13px;
          font-weight: 600;
          width: 100%;
          box-sizing: border-box;
          transition: all 0.2s;
          text-transform: uppercase;
          font-family: "Courier New", monospace;
        }
        .geofs-radar-input:focus {
          outline: none;
          border-color: rgba(59, 130, 246, 0.5);
          background: rgba(255, 255, 255, 0.1);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
        }
        .geofs-radar-btn {
          width: 100%;
          background: linear-gradient(135deg, rgba(0, 200, 255, 0.18), rgba(0, 140, 255, 0.12));
          border: 1px solid rgba(90, 200, 255, 0.4);
          border-radius: 10px;
          color: #9be7ff;
          padding: 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          letter-spacing: 0.8px;
          text-transform: uppercase;
          transition: all 0.2s;
          backdrop-filter: blur(4px);
        }
        .geofs-radar-btn:hover {
          background: rgba(59, 130, 246, 0.3);
          border-color: rgba(59, 130, 246, 0.5);
          color: #fff;
          box-shadow: 0 0 15px rgba(59, 130, 246, 0.3);
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
                <label class="geofs-radar-label">API Key (Required)</label>
                <input id="apiKeyInput" class="geofs-radar-input" placeholder="Paste Key from Radar Website (required)" value="${localStorage.getItem('geofs_flightradar_apikey') || ''}" style="font-size: 11px;">
            </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
                <button id="saveBtn" class="geofs-radar-btn" style="flex:1;min-width:160px;">Update Transponder</button>
                <button id="landedBtn" class="geofs-radar-btn" style="background:rgba(59, 130, 246, 0.2);border:2px solid rgba(59, 130, 246, 0.4);color:#bfdbfe;font-weight:800;min-width:140px;">🛬 Mark Landed</button>
                <button id="stopBtn" class="geofs-radar-btn" style="background:rgba(239, 68, 68, 0.3);border:2px solid rgba(239, 68, 68, 0.5);color:#fca5a5;font-weight:800;min-width:80px;">🛑 Stop</button>
                <button id="detailsBtn" class="geofs-radar-btn" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:#cbd5e1;min-width:100px;">Details</button>
            </div>
            <div id="radarDetails" style="margin-top:12px;display:none;background:rgba(0,0,0,0.5);padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.03);font-size:12px;max-height:260px;overflow:auto;">
                <div id="radarDetailsSummary" style="margin-bottom:8px;color:#e6edf3;font-weight:600;font-size:13px;">No snapshot yet.</div>
                <!-- Day/Night preview -->
                <canvas id="daynightPreview" width="320" height="40" style="width:100%;height:40px;border-radius:6px;display:block;margin-bottom:8px;background:linear-gradient(90deg,#000,#111);"></canvas>
                <div id="daynightInfo" style="font-size:11px;color:#cbd5e1;margin-bottom:6px;">UTC: --:-- — Subsolar: --°</div>
                <pre id="radarDetailsJson" style="white-space:pre-wrap;color:#cbd5e1;font-size:11px;margin:0;">{}</pre>
            </div>
        </div>
      </div>
    `;

    document.body.appendChild(flightUI);
    updateStatusDot();
    refreshAirportTooltips();

    // Drag Logic
    const header = document.getElementById('radarHeader');
    // Allow dragging from any non-interactive part of the window
    const dragRoot = flightUI;

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

    // Use the whole panel as the drag root; ignore interactive controls
    dragRoot.addEventListener("mousedown", dragStart);
    document.addEventListener("mouseup", dragEnd);
    document.addEventListener("mousemove", drag);

    // Touch support
    dragRoot.addEventListener("touchstart", dragStart, { passive: false });
    document.addEventListener("touchend", dragEnd);
    document.addEventListener("touchmove", drag, { passive: false });

    function isInteractiveTarget(target) {
      return target.closest('input, textarea, select, button, a, label, .geofs-radar-btn, .geofs-radar-min-btn') !== null;
    }

    function getClientXY(e) {
      if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function dragStart(e) {
      // Don't start dragging when interacting with form controls or buttons
      if (isInteractiveTarget(e.target)) return;

      const pos = getClientXY(e);
      initialX = pos.x - xOffset;
      initialY = pos.y - yOffset;

      isDragging = true;
      // visual cue
      document.body.style.cursor = 'grabbing';
    }

    function dragEnd(e) {
      initialX = currentX;
      initialY = currentY;
      isDragging = false;
      document.body.style.cursor = '';

      // Save position
      localStorage.setItem('geofs_radar_ui_pos', JSON.stringify({ x: xOffset, y: yOffset }));
    }

    function drag(e) {
      if (!isDragging) return;
      e.preventDefault();
      const pos = getClientXY(e);
      currentX = pos.x - initialX;
      currentY = pos.y - initialY;

      xOffset = currentX;
      yOffset = currentY;

      setTranslate(currentX, currentY, flightUI);
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

    // Airport full-name tooltips on hover
    ['depInput', 'arrInput'].forEach((id) => {
      const el = document.getElementById(id);
      el.addEventListener('input', refreshAirportTooltips);
      el.addEventListener('blur', refreshAirportTooltips);
      el.addEventListener('mouseenter', refreshAirportTooltips);
    });

    document.getElementById('saveBtn').onclick = () => {
      flightInfo.departure = document.getElementById('depInput').value.trim();
      flightInfo.arrival = document.getElementById('arrInput').value.trim();
      flightInfo.flightNo = document.getElementById('fltInput').value.trim();
      flightInfo.squawk = document.getElementById('sqkInput').value.trim();
      flightInfo.registration = document.getElementById('regInput').value.trim();
      
      const apiKey = document.getElementById('apiKeyInput').value.trim();
      // API Key is required. If the user is a pilot in-game they MUST provide an API key (log into the website to get one)
      if (!apiKey) {
          if (geofs && geofs.userRecord && geofs.userRecord.id) {
              return showToast('API Key required for pilots. Please log in on the website to obtain your API Key.');
          }
          return showToast('API Key is required. Obtain one from the website and paste it here.');
      }

      localStorage.setItem('geofs_flightradar_apikey', apiKey);
      localStorage.setItem('geofs_radar_flightinfo', JSON.stringify(flightInfo));
      
      isTransponderActive = true;
      localStorage.setItem('geofs_radar_transponder_active', 'true');
      updateStatusDot();
      refreshAirportTooltips();
      
      showToast('Transponder Updated & Active');
      // Warm logo cache for this callsign to make logos on the website show faster
      try { prefetchLogoForCallsign(flightInfo.flightNo || getPlayerCallsign()); } catch (e) {}
      // Also prefetch for the registration (if present) via server-side endpoints implicitly handled by other pages

      // Update details immediately
      try { updateDetails(); } catch (e) {}
    };
    
    // Stop Transponder Button Handler
    document.getElementById('stopBtn').onclick = () => {
      isTransponderActive = false;
      localStorage.setItem('geofs_radar_transponder_active', 'false');
      updateStatusDot();
      try { clearFlightPlan(readSnapshot()); } catch (e) { console.warn('[ATC-Reporter] Failed to clear plan on stop:', e); }
      showToast('Transponder Stopped');
    };

    // Landed Button Handler - send manual land message to server
    document.getElementById('landedBtn').onclick = () => {
      const snap = readSnapshot();
      if (!snap) return showToast('Unable to capture position');
      safeSend({ type: 'manual_land', payload: {
        callsign: getPlayerCallsign(),
        lat: snap.lat,
        lon: snap.lon,
        alt: snap.altMSL || 0,
        userId: geofs?.userRecord?.id || null,
        ts: Date.now()
      }});
      try { clearFlightPlan(snap); } catch (e) { console.warn('[ATC-Reporter] Failed to clear plan on manual land:', e); }
      // Reset state so the next flight can start cleanly
      FlightLogger.flightStarted = false;
      FlightLogger.firstGroundContact = false;
      FlightLogger.justLanded = true;
      FlightLogger.teleportWarnings = 0;
      FlightLogger.teleportCooloffUntil = 0;
      FlightLogger.lastPosition = null;
      FlightLogger.lastPositionTime = null;
      isTransponderActive = false;
      localStorage.setItem('geofs_radar_transponder_active', 'false');
      updateStatusDot();
      showToast('Marked as Landed — flight ended. Update Transponder to start again.');
      try { updateDetails(); } catch(e) {}
    };

    // Details panel toggle & update
    const detailsBtn = document.getElementById('detailsBtn');
    const detailsWrap = document.getElementById('radarDetails');
    const detailsSummary = document.getElementById('radarDetailsSummary');
    const detailsJson = document.getElementById('radarDetailsJson');

    detailsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!detailsWrap) return;
      if (detailsWrap.style.display === 'none') {
        detailsWrap.style.display = 'block';
        detailsBtn.textContent = 'Hide Details';
        try { drawDayNightPreview(); } catch(e) {}
        try { updateDetails(); } catch(e) {}
      } else {
        detailsWrap.style.display = 'none';
        detailsBtn.textContent = 'Details';
      }
    });

    function updateDetails() {
      const snap = readSnapshot();
      if (!snap) {
        detailsSummary.textContent = 'No snapshot available';
        detailsJson.textContent = '{}';
        return;
      }
      const payload = buildPayload(snap);
      detailsSummary.textContent = `${payload.callsign || 'N/A'} — ${payload.type || 'Unknown'} • ${payload.departure || '-'} → ${payload.arrival || '-'}`;
      // Pretty JSON with selected fields first
      const out = {
        id: payload.id, callsign: payload.callsign, flightNo: payload.flightNo, type: payload.type, registration: payload.registration,
        lat: payload.lat, lon: payload.lon, alt: payload.alt, altMSL: payload.altMSL, heading: payload.heading, speed: payload.speed, vspeed: payload.vspeed,
        squawk: payload.squawk, takeoffTime: payload.takeoffTime, flightPlanPoints: Array.isArray(payload.flightPlan) ? payload.flightPlan.length : 0, apiKey: payload.apiKey
      };
      detailsJson.textContent = JSON.stringify(out, null, 2);
      // Also update the mini Day/Night preview when details update
      try { drawDayNightPreview(); } catch(e) {}
    }

    function drawDayNightPreview() {
      try {
        const canvas = document.getElementById('daynightPreview');
        const info = document.getElementById('daynightInfo');
        if (!canvas) return;
        const now = new Date();
        const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
        const subsolarLon = ((utcHours - 12) * 15 + 540) % 360 - 180;
        const midnightLon = (((subsolarLon + 180) % 360 + 360) % 360) - 180;
        const centerPercent = ((midnightLon + 180) / 360);
        const ctx = canvas.getContext('2d');
        // Handle HiDPI scaling
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 320;
        const cssH = canvas.clientHeight || 40;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        ctx.scale(dpr, dpr);
        const w = cssW;
        const h = cssH;
        // Build gradient similar to map overlay
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        const addStop = (p, a) => grad.addColorStop(Math.max(0, Math.min(1, p)), `rgba(0,0,0,${a})`);
        addStop(centerPercent - 0.4, 0);
        addStop(centerPercent - 0.3, 0.12);
        addStop(centerPercent - 0.12, 0.28);
        addStop(centerPercent, 0.6);
        addStop(centerPercent + 0.12, 0.28);
        addStop(centerPercent + 0.3, 0.12);
        addStop(centerPercent + 0.4, 0);
        // Draw background and gradient
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#071020';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        // Subsolar marker
        const subsolarX = ((subsolarLon + 180) / 360) * w;
        ctx.fillStyle = 'rgba(255,223,99,0.95)';
        ctx.beginPath();
        ctx.arc(subsolarX, h / 2, Math.max(2, h * 0.15), 0, Math.PI * 2);
        ctx.fill();
        if (info) info.textContent = `UTC: ${now.getUTCHours().toString().padStart(2,'0')}:${now.getUTCMinutes().toString().padStart(2,'0')} — Subsolar: ${subsolarLon.toFixed(1)}°`;
      } catch(e) { }
    }

    // Update the preview every minute
    setInterval(() => { try { drawDayNightPreview(); } catch(e) {} }, 60 * 1000);

    // Update details while transponder is active
    setInterval(() => { try { if (isTransponderActive) updateDetails(); } catch(e) {} }, 2000);
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

  // --- Live Chat Scraper (ATC Audio Support) ---
  function initChatScraper() {
    console.log('[ATC-Reporter] Chat Scraper initializing...');
    // Common selectors for GeoFS chat
    const selectors = ['.geofs-chat-messages', '.geofs-chat-msg', 'li.geofs-chat-message', '.geofs-chat-list'];
    
    // Attempt to find container
    let container = null;
    for (const s of selectors) {
       const el = document.querySelector(s);
       if(el) { container = el; console.log('[ATC-Reporter] Found chat container:', s); break; }
    }
    // If specific container not found, watch body (fallback, less efficient but works)
    if (!container) container = document.body;

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) {
                        const text = node.textContent || node.innerText;
                        // Heuristic: check if it looks like a chat line
                        const isChat = (node.className && (node.className.includes('chat') || node.className.includes('msg'))) || 
                                       (node.parentNode && node.parentNode.className && node.parentNode.className.includes('chat'));
                        
                        if ((isChat || container.className.includes('chat')) && text && text.trim().length > 0) {
                            // Send to server via existing WebSocket if open
                            // `ws` is defined in the upper closure scope
                            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'chat', text: text.trim().substring(0, 200) }));
                            }
                        }
                    }
                });
            }
        });
    });
    
    observer.observe(container, { childList: true, subtree: true });
    console.log('[ATC-Reporter] Chat Scraper started.');
  }

  // Delay initialization to ensure GeoFS UI is loaded
  setTimeout(initChatScraper, 8000);

})();