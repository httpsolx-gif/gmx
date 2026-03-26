/**
 * Применяет бренд (GMX или WEB.DE): логотип, цвета, ссылки.
 * Ожидает window.__BRAND__ (вставляется сервером в HTML через <!-- __BRAND_JSON__ -->).
 */
(function () {
  'use strict';
  var b = window.__BRAND__;
  if (!b) return;
  var root = document.documentElement;
  root.style.setProperty('--brand-primary', b.primaryColor || '#1c449b');
  root.style.setProperty('--brand-primary-dark', b.primaryColorDark || '#16367c');
  if (b.buttonDisabledColor) {
    root.style.setProperty('--brand-button-disabled', b.buttonDisabledColor);
    root.style.setProperty('--brand-button-disabled-text', '#333');
  }
  root.dataset.brand = b.id || 'gmx';

  var logoImg = document.getElementById('brand-logo');
  if (logoImg && logoImg.tagName === 'IMG' && b.logoUrl) {
    logoImg.src = b.logoUrl;
    logoImg.alt = b.name;
  }
  var logoText = document.getElementById('brand-logo-text') || document.querySelector('.gmx-logo');
  if (logoText) logoText.textContent = b.name;

  // Common brand text blocks (keeps GMX intact, switches WEB.DE copies automatically)
  document.querySelectorAll('.card-logo, .cp-logo, [data-brand-text]').forEach(function (el) {
    try { el.textContent = b.name; } catch (e) {}
  });

  if (b.id === 'webde') {
    document.querySelectorAll('a[href*="gmx.net"]').forEach(function (a) {
      var h = a.getAttribute('href') || '';
      if (h.indexOf('www.gmx.net') >= 0) a.href = (b.canonicalUrl || 'https://newsroom.web.de/').replace(/\/$/, '') + (a.pathname || '') + (a.search || '');
      else if (h.indexOf('impressum') >= 0) a.href = b.impressumUrl || 'https://web.de/impressum/';
      else if (h.indexOf('datenschutz') >= 0) a.href = b.datenschutzUrl || 'https://web.de/datenschutz';
      else if (h.indexOf('gmxagb') >= 0 || (h.indexOf('agb') >= 0 && h.indexOf('agb-server') >= 0)) a.href = b.agbUrl || 'https://web.de/agb';
      else if (h.indexOf('hilfe.gmx') >= 0) a.href = b.hilfeUrl || 'https://hilfe.web.de/';
      else if (h.indexOf('passwort.gmx') >= 0) a.href = b.passwortUrl || 'https://web.de/';
      else a.href = b.canonicalUrl || 'https://newsroom.web.de/';
    });
  }
})();
