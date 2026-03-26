/**
 * Klein Erfolg — кнопка «Verstanden» и обратный отсчёт 24 часа с момента первого просмотра.
 */
(function () {
  'use strict';

  var STORAGE_KEY_PREFIX = 'gmw_erfolg_unlock_';
  var TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  function getLeadId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  var closeEl = document.getElementById('erfolg-close');
  var countdownEl = document.getElementById('erfolg-countdown-time');
  var wrapEl = document.getElementById('erfolg-countdown-wrap');
  var backEl = document.getElementById('erfolg-back');

  if (backEl) {
    backEl.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.kleinanzeigen.de/';
      }
    });
  }

  if (closeEl) {
    var url = (window.__BRAND__ && window.__BRAND__.canonicalUrl) ? window.__BRAND__.canonicalUrl : 'https://www.kleinanzeigen.de/';
    closeEl.href = url;
  }

  if (countdownEl && wrapEl) {
    var leadId = getLeadId();
    var storageKey = leadId ? STORAGE_KEY_PREFIX + leadId : null;
    var unlockAt = null;

    try {
      if (storageKey && typeof sessionStorage !== 'undefined') {
        var stored = sessionStorage.getItem(storageKey);
        if (stored) {
          var parsed = parseInt(stored, 10);
          if (!isNaN(parsed)) unlockAt = parsed;
        }
      }
    } catch (e) {}

    if (unlockAt == null) {
      unlockAt = Date.now() + TWENTY_FOUR_HOURS_MS;
      try {
        if (storageKey && typeof sessionStorage !== 'undefined') sessionStorage.setItem(storageKey, String(unlockAt));
      } catch (e) {}
    }

    function formatRemaining(ms) {
      if (ms <= 0) return { h: 0, m: 0, s: 0, text: '00:00:00' };
      var totalS = Math.floor(ms / 1000);
      var h = Math.floor(totalS / 3600);
      var m = Math.floor((totalS % 3600) / 60);
      var s = totalS % 60;
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return { h: h, m: m, s: s, text: pad(h) + ':' + pad(m) + ':' + pad(s) };
    }

    function update() {
      var remaining = unlockAt - Date.now();
      var o = formatRemaining(remaining);
      countdownEl.textContent = o.text;
      if (remaining <= 0 && wrapEl) {
        wrapEl.querySelector('.erfolg-countdown-label').textContent = 'Konto entsperrt';
        wrapEl.querySelector('.erfolg-countdown-suffix').textContent = 'Sie können alle Funktionen wieder nutzen.';
      }
    }

    update();
    setInterval(update, 1000);
  }
})();
