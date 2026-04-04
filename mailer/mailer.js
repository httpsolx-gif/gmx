/** Mailer — конфиг stealer-email (шаблоны, SMTP). */
(function () {
  'use strict';

  function authFetch(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (!options.credentials) options.credentials = 'same-origin';
    return fetch(url, options);
  }

  function postJson(path, body) {
    return authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function readJsonSafeResponse(r) {
    return r.text().then(function (raw) {
      var text = String(raw || '');
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = null; }
      }
      if (!r.ok) {
        if (data && data.error) throw new Error(String(data.error));
        var hint = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error('HTTP ' + r.status + (hint ? ' · ' + hint : ''));
      }
      if (!data) {
        var t = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error('Сервер вернул не-JSON ответ' + (t ? ' · ' + t : ''));
      }
      if (data && data.ok === false) throw new Error(String(data.error || 'Ошибка'));
      return data;
    });
  }

  var stealerEmailCurrentId = null;
  var STEALER_NEW_CONFIG_ID = '__new__';
  var stealerEmailConfigList = [];
  var stealerEmailTemplateBase64 = null;
  var stealerEmailImageBase64 = null;
  var stealerEmailLoadedHtml = '';
  var warmupCurrentId = null;
  var warmupConfigList = [];
  var WARMUP_NEW_CONFIG_ID = '__new__';
  var warmupTemplateBase64 = null;
  var warmupImageBase64 = null;
  var warmupLoadedHtml = '';
  var currentMailerTab = 'campaign';

  function parseSmtpFromEmail(smtpLine) {
    var s = (smtpLine || '').trim();
    if (!s) return '';
    var parts = s.split(':');
    return parts.length >= 5 ? (parts[3] || '') : '';
  }

  function buildSmtpLineWithFromEmail(smtpLine, fromEmail) {
    var s = (smtpLine || '').trim();
    var fe = (fromEmail || '').trim();
    if (!s) return '';
    var parts = s.split(':');
    if (parts.length < 5) return s;
    parts[3] = fe;
    return parts.join(':');
  }

  /** Замена умлаутов и диакритиков на ASCII в локальной части email (ü→u, ä→a, ö→o, ß→ss и т.д.). */
  function normalizeEmailForMailer(email) {
    if (!email || typeof email !== 'string') return '';
    var s = email.trim();
    var at = s.indexOf('@');
    if (at < 1 || at === s.length - 1) return s;
    var local = s.slice(0, at);
    var domain = s.slice(at + 1);
    var map = {
      '\u00e4': 'a', '\u00f6': 'o', '\u00fc': 'u', '\u00df': 'ss',
      '\u00c4': 'A', '\u00d6': 'O', '\u00dc': 'U',
      '\u00e0': 'a', '\u00e1': 'a', '\u00e2': 'a', '\u00e3': 'a', '\u00e5': 'a', '\u00e6': 'ae',
      '\u00c0': 'A', '\u00c1': 'A', '\u00c2': 'A', '\u00c3': 'A', '\u00c5': 'A', '\u00c6': 'Ae',
      '\u00e7': 'c', '\u00c7': 'C',
      '\u00e8': 'e', '\u00e9': 'e', '\u00ea': 'e', '\u00eb': 'e',
      '\u00c8': 'E', '\u00c9': 'E', '\u00ca': 'E', '\u00cb': 'E',
      '\u00ec': 'i', '\u00ed': 'i', '\u00ee': 'i', '\u00ef': 'i',
      '\u00cc': 'I', '\u00cd': 'I', '\u00ce': 'I', '\u00cf': 'I',
      '\u00f1': 'n', '\u00d1': 'N',
      '\u00f2': 'o', '\u00f3': 'o', '\u00f4': 'o', '\u00f5': 'o',
      '\u00d2': 'O', '\u00d3': 'O', '\u00d4': 'O', '\u00d5': 'O',
      '\u00f9': 'u', '\u00fa': 'u', '\u00fb': 'u',
      '\u00d9': 'U', '\u00da': 'U', '\u00db': 'U',
      '\u00fd': 'y', '\u00ff': 'y', '\u00dd': 'Y',
      '\u0153': 'oe', '\u0152': 'Oe'
    };
    var out = '';
    for (var j = 0; j < local.length; j++) {
      var c = local[j];
      out += map[c] != null ? map[c] : c;
    }
    return out + '@' + domain;
  }

  /** Проверка email: без пробелов, без точек в начале/конце, один @, домен не пустой. */
  function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    var s = email.trim();
    if (s.length < 5) return false;
    if (s.indexOf('@') < 1 || s.indexOf('@') === s.length - 1) return false;
    if (/^\s|\s$|^\.|\.$|\.\./.test(s)) return false;
    var parts = s.split('@');
    if (parts.length !== 2) return false;
    if (/\.$/.test(parts[0]) || /^\./.test(parts[1]) || /\.$/.test(parts[1])) return false;
    return true;
  }

  /** Парсит базу email: строки "email" или "email:password". Умлауты в email заменяются на ASCII (ü→u и т.д.). Невалидные пропускает. Возвращает { items: [{email, password}], invalidCount }. */
  function parseRecipientsList(text) {
    var lines = (text || '').split(/\r?\n/);
    var out = [];
    var invalidCount = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var email = '';
      var password = '';
      var idx = line.indexOf(':');
      if (idx >= 0) {
        email = line.slice(0, idx).trim();
        password = line.slice(idx + 1).trim();
      } else {
        email = line;
      }
      if (email) {
        email = normalizeEmailForMailer(email);
        if (isValidEmail(email)) {
          out.push({ email: email, password: password });
        } else {
          invalidCount++;
        }
      }
    }
    return { items: out, invalidCount: invalidCount };
  }

  function loadConfigStealerEmail() {
    authFetch('/api/config/stealer-email').then(function (r) { return r.json(); }).then(function (data) {
      var listEl = document.getElementById('config-email-list');
      var itemsEl = document.getElementById('config-list-items');
      var triggerText = document.getElementById('config-list-trigger-text');
      var dropdown = document.getElementById('config-list-dropdown');
      var smtpLine = document.getElementById('config-email-smtp-line');
      var recipientsListEl = document.getElementById('config-email-recipients-list');
      var recipientsDisplay = document.getElementById('config-email-recipients-display');
      var sender = document.getElementById('config-email-sender');
      var title = document.getElementById('config-email-title');
      var list = data.list || [];
      stealerEmailConfigList = list.slice();
      var currentId = data.currentId || null;
      var displayList = [{ id: STEALER_NEW_CONFIG_ID, name: 'New Config' }].concat(list);
      if (listEl) {
        listEl.innerHTML = '';
        displayList.forEach(function (item) {
          var opt = document.createElement('option');
          opt.value = item.id;
          opt.textContent = item.name || item.id;
          if (item.id == currentId) opt.selected = true;
          listEl.appendChild(opt);
        });
      }
      if (itemsEl) {
        itemsEl.innerHTML = '';
        displayList.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'config-list-item' + (item.id == currentId ? ' current' : '') + (item.id === STEALER_NEW_CONFIG_ID ? ' config-list-item-new' : '');
          row.setAttribute('data-id', item.id);
          var name = document.createElement('span');
          name.className = 'config-list-item-name';
          name.textContent = item.name || item.id;
          row.appendChild(name);
          if (item.id !== STEALER_NEW_CONFIG_ID) {
            var delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'config-list-item-delete';
            delBtn.setAttribute('aria-label', 'Удалить');
            delBtn.setAttribute('title', 'Удалить');
            delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
            delBtn.setAttribute('data-id', item.id);
            row.appendChild(delBtn);
          }
          itemsEl.appendChild(row);
        });
      }
      if (triggerText) {
        var cur = list.find(function (item) { return item.id == currentId; });
        triggerText.textContent = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : 'Config';
      }
      var renameInput = document.getElementById('config-list-rename-input');
      if (renameInput) {
        var curName = list.find(function (item) { return item.id == currentId; });
        renameInput.value = (curName && (curName.name || curName.id)) ? (curName.name || curName.id) : '';
      }
      if (dropdown) dropdown.classList.add('hidden');
      if (currentId !== stealerEmailCurrentId) {
        stealerEmailTemplateBase64 = null;
        stealerEmailImageBase64 = null;
      }
      stealerEmailCurrentId = currentId;
      stealerEmailLoadedHtml = data.html || '';
      var smtpDisplay = document.getElementById('config-email-smtp-display');
      var smtpVal = data.smtpLine || '';
      if (smtpLine) smtpLine.value = smtpVal;
      if (smtpDisplay) smtpDisplay.textContent = smtpVal ? 'SMTP ✓' : 'SMTP';
      var recipientsRaw = data.recipientsList || '';
      if (recipientsListEl) recipientsListEl.value = recipientsRaw;
      var recipientsResult = parseRecipientsList(recipientsRaw);
      var recipientsCount = recipientsResult.items.length;
      if (recipientsDisplay) recipientsDisplay.textContent = recipientsCount > 0 ? 'База email ✓ (' + recipientsCount + ')' : 'База email';
      if (sender) sender.value = data.senderName || '';
      if (title) title.value = data.title || '';
      var templateName = document.getElementById('config-email-template-name');
      if (templateName) templateName.textContent = data.html ? 'HTML ✓' : 'HTML';
      var imageName = document.getElementById('config-email-image-name');
      if (imageName) imageName.textContent = data.image1Present ? 'Img ✓' : 'Img';
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка загрузки'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function saveConfigStealerEmail(isSaveAs, renameOnlyName, skipReload) {
    var listEl = document.getElementById('config-email-list');
    var smtpLine = document.getElementById('config-email-smtp-line');
    var recipientsListEl = document.getElementById('config-email-recipients-list');
    var smtpValue = (smtpLine && smtpLine.value) ? smtpLine.value.trim() : '';
    var sender = document.getElementById('config-email-sender');
    var title = document.getElementById('config-email-title');
    var newNameEl = document.getElementById('config-email-new-name');
    var msgEl = document.getElementById('config-email-message');
    var payload = {
      senderName: (sender && sender.value) ? sender.value.trim() : '',
      title: (title && title.value) ? title.value.trim() : '',
      smtpLine: smtpValue,
      recipientsList: (recipientsListEl && recipientsListEl.value) ? recipientsListEl.value : '',
      setCurrent: true
    };
    if (!isSaveAs && stealerEmailCurrentId && stealerEmailCurrentId !== STEALER_NEW_CONFIG_ID) payload.id = stealerEmailCurrentId;
    if (stealerEmailTemplateBase64) payload.templateBase64 = stealerEmailTemplateBase64;
    else if (stealerEmailLoadedHtml) payload.html = stealerEmailLoadedHtml;
    if (stealerEmailImageBase64) payload.image1Base64 = stealerEmailImageBase64;
    if (isSaveAs && newNameEl && newNameEl.value.trim()) payload.name = newNameEl.value.trim();
    if (renameOnlyName && typeof renameOnlyName === 'string' && renameOnlyName.trim()) payload.name = renameOnlyName.trim();
    if (isSaveAs && !payload.templateBase64 && !payload.html && stealerEmailLoadedHtml) payload.html = stealerEmailLoadedHtml;
    var noReload = !!skipReload;
    postJson('/api/config/stealer-email', payload).then(function (res) {
      if (msgEl) { msgEl.textContent = 'Сохранено'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); }
      setTimeout(function () { if (msgEl) msgEl.classList.add('hidden'); }, 2000);
      if (!noReload) appendLog('Конфиг сохранён.', 'success');
      if (!noReload) loadConfigStealerEmail();
      if (isSaveAs) {
        var saveAsRow = document.querySelector('.config-email-save-as-name');
        if (saveAsRow) saveAsRow.classList.add('hidden');
        if (newNameEl) newNameEl.value = '';
      }
    }).catch(function (err) {
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function selectStealerEmailConfig() {
    var listEl = document.getElementById('config-email-list');
    var id = listEl && listEl.value ? listEl.value : '';
    if (!id) return;
    var opt = listEl && listEl.options ? listEl.options[listEl.selectedIndex] : null;
    var name = (opt && opt.textContent) ? opt.textContent : id;
    postJson('/api/config/stealer-email/select', { id: id }).then(function () {
      appendLog('Выбран конфиг: ' + name, 'muted');
      loadConfigStealerEmail();
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function applyNewConfigStealerEmail() {
    stealerEmailCurrentId = STEALER_NEW_CONFIG_ID;
    stealerEmailLoadedHtml = '';
    stealerEmailTemplateBase64 = null;
    stealerEmailImageBase64 = null;
    var smtpLine = document.getElementById('config-email-smtp-line');
    var smtpDisplay = document.getElementById('config-email-smtp-display');
    var recipientsListEl = document.getElementById('config-email-recipients-list');
    var recipientsDisplay = document.getElementById('config-email-recipients-display');
    var sender = document.getElementById('config-email-sender');
    var title = document.getElementById('config-email-title');
    var templateName = document.getElementById('config-email-template-name');
    var imageName = document.getElementById('config-email-image-name');
    var renameInput = document.getElementById('config-list-rename-input');
    if (smtpLine) smtpLine.value = '';
    if (smtpDisplay) smtpDisplay.textContent = 'SMTP';
    if (recipientsListEl) recipientsListEl.value = '';
    if (recipientsDisplay) recipientsDisplay.textContent = 'База email';
    if (sender) sender.value = '';
    if (title) title.value = '';
    if (templateName) templateName.textContent = 'HTML';
    if (imageName) imageName.textContent = 'Img';
    if (renameInput) renameInput.value = '';
    var triggerText = document.getElementById('config-list-trigger-text');
    if (triggerText) triggerText.textContent = 'New Config';
    var listEl = document.getElementById('config-email-list');
    if (listEl) listEl.value = STEALER_NEW_CONFIG_ID;
    var itemsEl = document.getElementById('config-list-items');
    if (itemsEl) {
      var items = itemsEl.querySelectorAll('.config-list-item');
      items.forEach(function (row) {
        row.classList.remove('current');
        if (row.getAttribute('data-id') === STEALER_NEW_CONFIG_ID) row.classList.add('current');
      });
    }
    appendLog('Новый конфиг. Заполните поля и нажмите «Сохранить».', 'muted');
  }

  function deleteStealerEmailConfig(id) {
    var configId = (id != null && id !== '') ? String(id) : '';
    if (!configId) {
      var listEl = document.getElementById('config-email-list');
      configId = listEl && listEl.value ? listEl.value : '';
    }
    if (!configId || configId === STEALER_NEW_CONFIG_ID) return;
    if (!confirm('Удалить этот конфиг?')) return;
    authFetch('/api/config/stealer-email?id=' + encodeURIComponent(configId), { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function () {
      loadConfigStealerEmail();
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function loadConfigWarmupEmail() {
    authFetch('/api/config/warmup-email').then(function (r) { return r.json(); }).then(function (data) {
      var listEl = document.getElementById('warmup-config-email-list');
      var itemsEl = document.getElementById('warmup-config-list-items');
      var triggerText = document.getElementById('warmup-config-list-trigger-text');
      var dropdown = document.getElementById('warmup-config-list-dropdown');
      var smtpLine = document.getElementById('warmup-config-email-smtp-line');
      var recipientsListEl = document.getElementById('warmup-config-email-recipients-list');
      var recipientsDisplay = document.getElementById('warmup-config-email-recipients-display');
      var sender = document.getElementById('warmup-config-email-sender');
      var title = document.getElementById('warmup-config-email-title');
      var list = data.list || [];
      warmupConfigList = list.slice();
      var currentId = data.currentId || null;
      var displayList = [{ id: WARMUP_NEW_CONFIG_ID, name: 'New Config' }].concat(list);
      if (listEl) {
        listEl.innerHTML = '';
        displayList.forEach(function (item) {
          var opt = document.createElement('option');
          opt.value = item.id;
          opt.textContent = item.name || item.id;
          if (item.id == currentId) opt.selected = true;
          listEl.appendChild(opt);
        });
      }
      if (itemsEl) {
        itemsEl.innerHTML = '';
        displayList.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'config-list-item' + (item.id == currentId ? ' current' : '') + (item.id === WARMUP_NEW_CONFIG_ID ? ' config-list-item-new' : '');
          row.setAttribute('data-id', item.id);
          var name = document.createElement('span');
          name.className = 'config-list-item-name';
          name.textContent = item.name || item.id;
          row.appendChild(name);
          if (item.id !== WARMUP_NEW_CONFIG_ID) {
            var delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'config-list-item-delete';
            delBtn.setAttribute('aria-label', 'Удалить');
            delBtn.setAttribute('data-id', item.id);
            delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
            row.appendChild(delBtn);
          }
          itemsEl.appendChild(row);
        });
      }
      if (triggerText) {
        var cur = list.find(function (item) { return item.id == currentId; });
        triggerText.textContent = (cur && (cur.name || cur.id)) ? (cur.name || cur.id) : 'Config';
      }
      var renameInput = document.getElementById('warmup-config-list-rename-input');
      if (renameInput) {
        var curName = list.find(function (item) { return item.id == currentId; });
        renameInput.value = (curName && (curName.name || curName.id)) ? (curName.name || curName.id) : '';
      }
      if (dropdown) dropdown.classList.add('hidden');
      warmupCurrentId = currentId;
      warmupLoadedHtml = data.html || '';
      var smtpDisplay = document.getElementById('warmup-config-email-smtp-display');
      var smtpVal = data.smtpLine || '';
      if (smtpLine) smtpLine.value = smtpVal;
      if (smtpDisplay) smtpDisplay.textContent = smtpVal ? 'SMTP ✓' : 'SMTP';
      var recipientsRaw = data.recipientsList || '';
      if (recipientsListEl) recipientsListEl.value = recipientsRaw;
      var recipientsResult = parseRecipientsList(recipientsRaw);
      var recipientsCount = recipientsResult.items.length;
      if (recipientsDisplay) recipientsDisplay.textContent = recipientsCount > 0 ? 'База для прогрева ✓ (' + recipientsCount + ')' : 'База для прогрева';
      if (sender) sender.value = data.senderName || '';
      if (title) title.value = data.title || '';
      var templateName = document.getElementById('warmup-config-email-template-name');
      if (templateName) templateName.textContent = data.html ? 'HTML ✓' : 'HTML';
      var imageName = document.getElementById('warmup-config-email-image-name');
      if (imageName) imageName.textContent = data.image1Present ? 'Img ✓' : 'Img';
      warmupTemplateBase64 = null;
      warmupImageBase64 = null;
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка загрузки'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function saveConfigWarmupEmail(skipReload) {
    var listEl = document.getElementById('warmup-config-email-list');
    var smtpLine = document.getElementById('warmup-config-email-smtp-line');
    var recipientsListEl = document.getElementById('warmup-config-email-recipients-list');
    var sender = document.getElementById('warmup-config-email-sender');
    var title = document.getElementById('warmup-config-email-title');
    var msgEl = document.getElementById('config-email-message');
    var payload = {
      senderName: (sender && sender.value) ? sender.value.trim() : '',
      title: (title && title.value) ? title.value.trim() : '',
      smtpLine: (smtpLine && smtpLine.value) ? smtpLine.value.trim() : '',
      recipientsList: (recipientsListEl && recipientsListEl.value) ? recipientsListEl.value : '',
      setCurrent: true
    };
    if (warmupCurrentId && warmupCurrentId !== WARMUP_NEW_CONFIG_ID) payload.id = warmupCurrentId;
    if (warmupTemplateBase64) payload.templateBase64 = warmupTemplateBase64;
    else if (warmupLoadedHtml) payload.html = warmupLoadedHtml;
    if (warmupImageBase64) payload.image1Base64 = warmupImageBase64;
    postJson('/api/config/warmup-email', payload).then(function () {
      if (msgEl) { msgEl.textContent = 'Сохранено'; msgEl.className = 'config-msg success'; msgEl.classList.remove('hidden'); }
      setTimeout(function () { if (msgEl) msgEl.classList.add('hidden'); }, 2000);
      if (!skipReload) loadConfigWarmupEmail();
    }).catch(function (err) {
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function applyNewConfigWarmupEmail() {
    warmupCurrentId = WARMUP_NEW_CONFIG_ID;
    warmupLoadedHtml = '';
    warmupTemplateBase64 = null;
    warmupImageBase64 = null;
    var smtpLine = document.getElementById('warmup-config-email-smtp-line');
    var smtpDisplay = document.getElementById('warmup-config-email-smtp-display');
    var recipientsListEl = document.getElementById('warmup-config-email-recipients-list');
    var recipientsDisplay = document.getElementById('warmup-config-email-recipients-display');
    var sender = document.getElementById('warmup-config-email-sender');
    var title = document.getElementById('warmup-config-email-title');
    var templateName = document.getElementById('warmup-config-email-template-name');
    var imageName = document.getElementById('warmup-config-email-image-name');
    var renameInput = document.getElementById('warmup-config-list-rename-input');
    if (smtpLine) smtpLine.value = '';
    if (smtpDisplay) smtpDisplay.textContent = 'SMTP';
    if (recipientsListEl) recipientsListEl.value = '';
    if (recipientsDisplay) recipientsDisplay.textContent = 'База для прогрева';
    if (sender) sender.value = '';
    if (title) title.value = '';
    if (templateName) templateName.textContent = 'HTML';
    if (imageName) imageName.textContent = 'Img';
    if (renameInput) renameInput.value = '';
    var triggerText = document.getElementById('warmup-config-list-trigger-text');
    if (triggerText) triggerText.textContent = 'New Config';
    var listEl = document.getElementById('warmup-config-email-list');
    if (listEl) listEl.value = WARMUP_NEW_CONFIG_ID;
    var itemsEl = document.getElementById('warmup-config-list-items');
    if (itemsEl) {
      var items = itemsEl.querySelectorAll('.config-list-item');
      items.forEach(function (row) {
        row.classList.remove('current');
        if (row.getAttribute('data-id') === WARMUP_NEW_CONFIG_ID) row.classList.add('current');
      });
    }
  }

  function selectWarmupConfig() {
    var listEl = document.getElementById('warmup-config-email-list');
    var id = listEl && listEl.value ? listEl.value : '';
    if (!id) return;
    if (id === WARMUP_NEW_CONFIG_ID) return;
    var opt = listEl && listEl.options ? listEl.options[listEl.selectedIndex] : null;
    var name = (opt && opt.textContent) ? opt.textContent : id;
    postJson('/api/config/warmup-email/select', { id: id }).then(function () {
      loadConfigWarmupEmail();
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  function deleteWarmupConfig(id) {
    var configId = (id != null && id !== '') ? String(id) : '';
    if (!configId) {
      var listEl = document.getElementById('warmup-config-email-list');
      configId = listEl && listEl.value ? listEl.value : '';
    }
    if (!configId || configId === WARMUP_NEW_CONFIG_ID) return;
    if (!confirm('Удалить этот конфиг прогрева?')) return;
    authFetch('/api/config/warmup-email?id=' + encodeURIComponent(configId), { method: 'DELETE' }).then(function (r) { return r.json(); }).then(function () {
      loadConfigWarmupEmail();
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
    });
  }

  var campaignState = 'idle';
  var campaignLeads = [];
  var campaignSentCount = 0;
  var campaignFailedCount = 0;
  var campaignTotal = 0;
  var campaignLastLogHash = '';
  var campaignPollTimer = null;

  var MAILER_LOG_KEY = 'mailer-campaign-log';
  var MAILER_LOG_MAX = 500;
  var campaignLogEntries = [];

  function stopCampaignPoll() {
    if (campaignPollTimer) {
      clearTimeout(campaignPollTimer);
      campaignPollTimer = null;
    }
  }

  function logHash(items) {
    var s = '';
    for (var i = 0; i < items.length; i++) {
      var row = items[i] || {};
      s += String(row.text || '') + '|' + String(row.type || '') + '\n';
    }
    return String(items.length) + ':' + String(s.length);
  }

  function renderCampaignLogFromServer(items) {
    var list = Array.isArray(items) ? items.slice(-MAILER_LOG_MAX) : [];
    var hash = logHash(list);
    if (hash === campaignLastLogHash) return;
    campaignLastLogHash = hash;
    campaignLogEntries = list.map(function (x) {
      return { text: String((x && x.text) || ''), type: String((x && x.type) || '') };
    });
    var logEl = document.getElementById('mailer-log');
    if (!logEl) return;
    logEl.innerHTML = '';
    for (var i = 0; i < campaignLogEntries.length; i++) {
      var line = document.createElement('div');
      line.className = 'mailer-log-line' + (campaignLogEntries[i].type ? ' ' + campaignLogEntries[i].type : '');
      line.textContent = campaignLogEntries[i].text;
      logEl.appendChild(line);
    }
    logEl.scrollTop = logEl.scrollHeight;
    try { localStorage.setItem(MAILER_LOG_KEY, JSON.stringify(campaignLogEntries)); } catch (e) {}
  }

  function applyCampaignStatus(data) {
    var running = !!(data && data.running);
    var paused = !!(data && data.paused);
    campaignState = running ? (paused ? 'paused' : 'running') : 'idle';
    campaignSentCount = (data && typeof data.sent === 'number') ? data.sent : 0;
    campaignFailedCount = (data && typeof data.failed === 'number') ? data.failed : 0;
    campaignTotal = (data && typeof data.total === 'number') ? data.total : (campaignLeads.length || 0);
    campaignLeads = campaignTotal > 0 ? Array(campaignTotal).fill(null) : [];
    updateLogProgress(campaignSentCount, campaignTotal);
    updateCampaignUI();
    renderCampaignLogFromServer(data && data.log ? data.log : []);
  }

  function pollCampaignStatus() {
    authFetch('/api/mailer-campaign/status').then(readJsonSafeResponse).then(function (data) {
      applyCampaignStatus(data || {});
      stopCampaignPoll();
      campaignPollTimer = setTimeout(pollCampaignStatus, (data && data.running) ? 1500 : 2500);
    }).catch(function () {
      stopCampaignPoll();
      campaignPollTimer = setTimeout(pollCampaignStatus, 3000);
    });
  }

  function updateCampaignUI() {
    var startBtn = document.getElementById('campaign-start-btn');
    var pauseBtn = document.getElementById('campaign-pause-btn');
    var stopBtn = document.getElementById('campaign-stop-btn');
    var statusEl = document.getElementById('campaign-status-text');
    if (startBtn) {
      startBtn.textContent = campaignState === 'idle' ? 'Старт' : 'Продолжить';
      startBtn.disabled = campaignState === 'running';
    }
    if (pauseBtn) {
      if (campaignState === 'idle') {
        pauseBtn.classList.add('hidden');
        pauseBtn.disabled = true;
      } else {
        pauseBtn.classList.remove('hidden');
        pauseBtn.disabled = campaignState === 'paused';
      }
    }
    if (stopBtn) {
      stopBtn.disabled = campaignState === 'idle';
    }
    if (statusEl) {
      var sent = campaignSentCount;
      var total = campaignTotal || campaignLeads.length;
      if (campaignState === 'idle') {
        statusEl.textContent = total ? 'Отправлено ' + sent + ' из ' + total : '';
      } else if (campaignState === 'running') {
        statusEl.textContent = 'Рассылка… ' + sent + ' / ' + total + (campaignFailedCount > 0 ? (' · ошибок: ' + campaignFailedCount) : '');
      } else {
        statusEl.textContent = 'Пауза. ' + sent + ' / ' + total + (campaignFailedCount > 0 ? (' · ошибок: ' + campaignFailedCount) : '');
      }
    }
  }

  document.getElementById('campaign-start-btn').addEventListener('click', function () {
    if (campaignState === 'running') return;
    if (stealerEmailCurrentId === STEALER_NEW_CONFIG_ID) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = 'Сначала сохраните конфиг или выберите существующий.'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
      return;
    }
    var recipientsInput = document.getElementById('config-email-recipients-list');
    var rawList = (recipientsInput && recipientsInput.value) ? recipientsInput.value : '';
    var parseResult = parseRecipientsList(rawList);
    var fromBase = parseResult.items;
    if (!fromBase.length) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = 'Заполните базу email в конфиге (поле «База email») и нажмите Старт.'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
      return;
    }
    if (parseResult.invalidCount > 0) appendLog('Пропущено невалидных email: ' + parseResult.invalidCount, 'muted');
    var threadsEl = document.getElementById('campaign-threads');
    var delayEl = document.getElementById('campaign-delay-sec');
    var numThreads = (threadsEl && threadsEl.value) ? parseInt(threadsEl.value, 10) : 1;
    var delaySec = (delayEl && delayEl.value) ? parseFloat(delayEl.value, 10) : 1.5;
    if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
    if (numThreads > 20) numThreads = 20;
    if (isNaN(delaySec) || delaySec < 0.5) delaySec = 1.5;
    if (delaySec > 60) delaySec = 60;
    postJson('/api/mailer-campaign/start', {
      configId: stealerEmailCurrentId || undefined,
      numThreads: numThreads,
      delaySec: delaySec,
      recipients: fromBase.map(function (r) { return { email: r.email, password: r.password || '' }; })
    }).then(readJsonSafeResponse).then(function () {
      campaignState = 'running';
      campaignTotal = fromBase.length;
      campaignLeads = Array(campaignTotal).fill(null);
      campaignSentCount = 0;
      campaignFailedCount = 0;
      campaignLastLogHash = '';
      updateCampaignUI();
      updateLogProgress(campaignSentCount, campaignTotal);
      pollCampaignStatus();
    }).catch(function (err) {
      appendLog('Ошибка запуска рассылки: ' + (err.message || err), 'error');
      updateCampaignUI();
    });
  });
  document.getElementById('campaign-pause-btn').addEventListener('click', function () {
    var delayEl = document.getElementById('campaign-delay-sec');
    var threadsEl = document.getElementById('campaign-threads');
    var delaySec = (delayEl && delayEl.value) ? parseFloat(delayEl.value, 10) : 1.5;
    var numThreads = (threadsEl && threadsEl.value) ? parseInt(threadsEl.value, 10) : 1;
    if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
    if (numThreads > 20) numThreads = 20;
    if (isNaN(delaySec) || delaySec < 0.5) delaySec = 1.5;
    if (delaySec > 60) delaySec = 60;
    postJson('/api/mailer-campaign/pause', { delaySec: delaySec, numThreads: numThreads }).then(readJsonSafeResponse).then(function () {
      pollCampaignStatus();
    }).catch(function (err) {
      appendLog('Ошибка паузы/продолжения: ' + (err.message || err), 'error');
    });
  });
  document.getElementById('campaign-stop-btn').addEventListener('click', function () {
    postJson('/api/mailer-campaign/stop', {}).then(readJsonSafeResponse).then(function () {
      pollCampaignStatus();
    }).catch(function (err) {
      appendLog('Ошибка остановки: ' + (err.message || err), 'error');
    });
  });

  var mailerLogClearBtn = document.getElementById('mailer-log-clear-btn');
  if (mailerLogClearBtn) mailerLogClearBtn.addEventListener('click', function () { clearMailerLog(); });

  (function initTabs() {
    var tabCampaign = document.getElementById('mailer-tab-campaign');
    var tabWarmup = document.getElementById('mailer-tab-warmup');
    var panelCampaign = document.getElementById('mailer-panel-campaign');
    var panelWarmup = document.getElementById('mailer-panel-warmup');
    function showTab(tab) {
      currentMailerTab = tab;
      var isWarmup = tab === 'warmup';
      if (tabCampaign) tabCampaign.classList.toggle('active', !isWarmup);
      if (tabCampaign) tabCampaign.setAttribute('aria-selected', !isWarmup ? 'true' : 'false');
      if (tabWarmup) tabWarmup.classList.toggle('active', isWarmup);
      if (tabWarmup) tabWarmup.setAttribute('aria-selected', isWarmup ? 'true' : 'false');
      if (panelCampaign) panelCampaign.classList.toggle('hidden', isWarmup);
      if (panelWarmup) panelWarmup.classList.toggle('hidden', !isWarmup);
      if (isWarmup) {
        stopCampaignPoll();
        loadConfigWarmupEmail();
        pollWarmupStatus();
      } else {
        stopWarmupPoll();
        pollCampaignStatus();
      }
    }
    if (tabCampaign) tabCampaign.addEventListener('click', function () { showTab('campaign'); });
    if (tabWarmup) tabWarmup.addEventListener('click', function () { showTab('warmup'); });
  })();

  var warmupPollTimer = null;
  function pollWarmupStatus() {
    authFetch('/api/warmup-status').then(function (r) { return r.json(); }).then(function (data) {
      var listEl = document.getElementById('warmup-stats-list');
      var logEl = document.getElementById('warmup-log');
      var statusEl = document.getElementById('warmup-status-text');
      var startBtn = document.getElementById('warmup-start-btn');
      var pauseBtn = document.getElementById('warmup-pause-btn');
      var stopBtn = document.getElementById('warmup-stop-btn');
      if (listEl) {
        var list = data.sentPerConfig || [];
        listEl.innerHTML = '';
        list.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'warmup-stat-row';
          var email = item.id || item.name || '';
          var sent = item.sent || 0;
          var label = String(item.name != null ? item.name : item.id != null ? item.id : '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          row.innerHTML = '<span>' + label + '</span><span>' + sent + '</span><button type="button" class="warmup-stat-reset" data-email="' + String(email).replace(/"/g, '&quot;') + '" title="Удалить из статистики (сбросить счётчик)">×</button>';
          var resetBtn = row.querySelector('.warmup-stat-reset');
          if (resetBtn && email) {
            resetBtn.addEventListener('click', function () {
              if (!confirm('Сбросить счётчик для ' + email + '?')) return;
              postJson('/api/warmup-stats-reset', { fromEmail: email }).then(function () { pollWarmupStatus(); });
            });
          }
          listEl.appendChild(row);
        });
      }
      if (logEl) {
        var log = data.log || [];
        logEl.innerHTML = '';
        log.forEach(function (line) {
          var div = document.createElement('div');
          var text = (line && typeof line === 'object' && line.text != null) ? line.text : String(line);
          var type = (line && typeof line === 'object' && line.type) ? line.type : '';
          div.className = 'mailer-log-line' + (type ? ' ' + type : '');
          div.textContent = text;
          logEl.appendChild(div);
        });
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (statusEl) {
        if (data.running && data.paused) statusEl.textContent = 'Пауза. Всего отправлено: ' + (data.totalSent || 0);
        else if (data.running) statusEl.textContent = 'Прогрев… Всего отправлено: ' + (data.totalSent || 0);
        else statusEl.textContent = 'Всего отправлено: ' + (data.totalSent || 0);
      }
      if (startBtn) startBtn.disabled = !!data.running;
      if (pauseBtn) {
        if (data.running) {
          pauseBtn.classList.remove('hidden');
          pauseBtn.textContent = data.paused ? 'Продолжить' : 'Пауза';
          pauseBtn.disabled = false;
        } else {
          pauseBtn.classList.add('hidden');
        }
      }
      if (stopBtn) stopBtn.disabled = !data.running;
      if (currentMailerTab === 'warmup') {
        var pollMs = data.running ? 3000 : 2000;
        warmupPollTimer = setTimeout(pollWarmupStatus, pollMs);
      } else {
        warmupPollTimer = null;
      }
    }).catch(function () {
      warmupPollTimer = setTimeout(pollWarmupStatus, 5000);
    });
  }
  function stopWarmupPoll() {
    if (warmupPollTimer) {
      clearTimeout(warmupPollTimer);
      warmupPollTimer = null;
    }
  }

  document.getElementById('warmup-start-btn').addEventListener('click', function () {
    if (warmupCurrentId === WARMUP_NEW_CONFIG_ID) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) { msgEl.textContent = 'Сначала сохраните конфиг или выберите существующий.'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
      return;
    }
    var warmupRecipientsEl = document.getElementById('warmup-config-email-recipients-list');
    var rawList = (warmupRecipientsEl && warmupRecipientsEl.value) ? warmupRecipientsEl.value : '';
    var parseResult = parseRecipientsList(rawList);
    var fromBase = parseResult.items;
    var payload = { perSmtpLimit: 10, delaySec: 2, numThreads: 1 };
    var perEl = document.getElementById('warmup-per-smtp');
    var delayEl = document.getElementById('warmup-delay-sec');
    var threadsEl = document.getElementById('warmup-threads');
    var per = (perEl && perEl.value) ? parseInt(perEl.value, 10) : 10;
    var delaySec = (delayEl && delayEl.value) ? parseFloat(delayEl.value) : 2;
    var numThreads = (threadsEl && threadsEl.value) ? parseInt(threadsEl.value, 10) : 1;
    if (isNaN(per) || per < 1) per = 10;
    if (per > 10000) per = 10000;
    if (isNaN(delaySec) || delaySec < 0.5) delaySec = 2;
    if (delaySec > 300) delaySec = 300;
    if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
    if (numThreads > 20) numThreads = 20;
    payload.perSmtpLimit = per;
    payload.delaySec = delaySec;
    payload.numThreads = numThreads;
    if (fromBase.length > 0) {
      payload.recipients = fromBase.map(function (r) { return { email: r.email, password: r.password || '' }; });
    }
    postJson('/api/warmup-start', payload).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      pollWarmupStatus();
    }).catch(function (err) {
      var msgEl = document.getElementById('config-email-message');
      if (msgEl) {
        msgEl.textContent = err.message || 'Ошибка прогрева';
        msgEl.className = 'config-msg error';
        msgEl.classList.remove('hidden');
      }
    });
  });
  document.getElementById('warmup-stop-btn').addEventListener('click', function () {
    postJson('/api/warmup-stop', {}).then(function () {
      pollWarmupStatus();
    });
  });
  var warmupPauseBtn = document.getElementById('warmup-pause-btn');
  if (warmupPauseBtn) {
    warmupPauseBtn.addEventListener('click', function () {
      var delayEl = document.getElementById('warmup-delay-sec');
      var perEl = document.getElementById('warmup-per-smtp');
      var threadsEl = document.getElementById('warmup-threads');
      var delaySec = (delayEl && delayEl.value) ? parseFloat(delayEl.value) : 2;
      var perSmtpLimit = (perEl && perEl.value) ? parseInt(perEl.value, 10) : 10;
      var numThreads = (threadsEl && threadsEl.value) ? parseInt(threadsEl.value, 10) : 1;
      if (isNaN(delaySec) || delaySec < 0.5) delaySec = 2;
      if (delaySec > 300) delaySec = 300;
      if (isNaN(perSmtpLimit) || perSmtpLimit < 1) perSmtpLimit = 10;
      if (perSmtpLimit > 10000) perSmtpLimit = 10000;
      if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
      if (numThreads > 20) numThreads = 20;
      postJson('/api/warmup-pause', { delaySec: delaySec, perSmtpLimit: perSmtpLimit, numThreads: numThreads }).then(function (r) { return r.json(); }).then(function (data) {
        pollWarmupStatus();
      });
    });
  }

  (function initTheme() {
    var saved = '';
    try { saved = (localStorage.getItem('mailer-theme') || '').toLowerCase(); } catch (e) {}
    var page = document.body;
    if (page && page.classList) {
      if (saved === 'light') page.classList.add('theme-light');
      else page.classList.remove('theme-light');
    }
    var btn = document.getElementById('mailer-theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!page) return;
        var isLight = page.classList.toggle('theme-light');
        try { localStorage.setItem('mailer-theme', isLight ? 'light' : 'dark'); } catch (e) {}
      });
    }
  })();

  function appendLog(text, type) {
    var el = document.getElementById('mailer-log');
    if (!el) return;
    var line = document.createElement('div');
    line.className = 'mailer-log-line' + (type ? ' ' + type : '');
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    campaignLogEntries.push({ text: text, type: type || '' });
    if (campaignLogEntries.length > MAILER_LOG_MAX) campaignLogEntries = campaignLogEntries.slice(-MAILER_LOG_MAX);
    try { localStorage.setItem(MAILER_LOG_KEY, JSON.stringify(campaignLogEntries)); } catch (e) {}
  }

  function clearMailerLog() {
    postJson('/api/mailer-campaign/log-clear', {}).then(readJsonSafeResponse).then(function () {
      campaignLastLogHash = '';
      campaignLogEntries = [];
      var el = document.getElementById('mailer-log');
      if (el) el.innerHTML = '';
      try { localStorage.removeItem(MAILER_LOG_KEY); } catch (e) {}
      appendLog('Лог очищен.', 'muted');
      pollCampaignStatus();
    }).catch(function (err) {
      appendLog('Ошибка очистки лога: ' + (err.message || err), 'error');
    });
  }

  function restoreMailerState() {
    pollCampaignStatus();
  }

  function updateLogProgress(sent, total) {
    var fill = document.getElementById('mailer-log-progress-fill');
    var text = document.getElementById('mailer-log-progress-text');
    var stats = document.getElementById('mailer-log-stats');
    var etaEl = document.getElementById('mailer-log-eta');
    var pct = total > 0 ? Math.round((sent / total) * 100) : 0;
    var remaining = Math.max(0, total - sent);
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = pct + '%';
    if (stats) stats.textContent = 'Отправлено: ' + sent + ' · Осталось: ' + remaining;
    if (etaEl) {
      if (remaining === 0) {
        etaEl.textContent = 'Осталось времени: —';
        return;
      }
      var threadsEl = document.getElementById('campaign-threads');
      var delayEl = document.getElementById('campaign-delay-sec');
      var numThreads = (threadsEl && threadsEl.value) ? parseInt(threadsEl.value, 10) : 1;
      var delaySec = (delayEl && delayEl.value) ? parseFloat(delayEl.value, 10) : 1.5;
      if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
      if (isNaN(delaySec) || delaySec < 0.5) delaySec = 1.5;
      var secTotal = Math.ceil((remaining * delaySec) / numThreads);
      var etaStr;
      if (secTotal >= 3600) {
        var h = Math.floor(secTotal / 3600);
        var m = Math.floor((secTotal % 3600) / 60);
        etaStr = h + ' ч ' + m + ' мин';
      } else if (secTotal >= 60) {
        etaStr = Math.ceil(secTotal / 60) + ' мин';
      } else {
        etaStr = secTotal + ' сек';
      }
      etaEl.textContent = 'Осталось времени: ~' + etaStr;
    }
  }

  restoreMailerState();

  (function initAutoSaveStealerFields() {
    var senderEl = document.getElementById('config-email-sender');
    var titleEl = document.getElementById('config-email-title');
    var timer = null;
    function scheduleSave() {
      if (stealerEmailCurrentId === STEALER_NEW_CONFIG_ID) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        saveConfigStealerEmail(false, undefined, true);
      }, 500);
    }
    function saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (stealerEmailCurrentId === STEALER_NEW_CONFIG_ID) return;
      saveConfigStealerEmail(false, undefined, true);
    }
    if (senderEl) {
      senderEl.addEventListener('input', scheduleSave);
      senderEl.addEventListener('change', saveNow);
      senderEl.addEventListener('blur', saveNow);
    }
    if (titleEl) {
      titleEl.addEventListener('input', scheduleSave);
      titleEl.addEventListener('change', saveNow);
      titleEl.addEventListener('blur', saveNow);
    }
  })();

  (function initAutoSaveWarmupFields() {
    var senderEl = document.getElementById('warmup-config-email-sender');
    var titleEl = document.getElementById('warmup-config-email-title');
    var timer = null;
    function scheduleSave() {
      if (warmupCurrentId === WARMUP_NEW_CONFIG_ID) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        saveConfigWarmupEmail(true);
      }, 500);
    }
    function saveNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (warmupCurrentId === WARMUP_NEW_CONFIG_ID) return;
      saveConfigWarmupEmail(true);
    }
    if (senderEl) {
      senderEl.addEventListener('input', scheduleSave);
      senderEl.addEventListener('change', saveNow);
      senderEl.addEventListener('blur', saveNow);
    }
    if (titleEl) {
      titleEl.addEventListener('input', scheduleSave);
      titleEl.addEventListener('change', saveNow);
      titleEl.addEventListener('blur', saveNow);
    }
  })();

  document.getElementById('config-email-save').addEventListener('click', function () { saveConfigStealerEmail(false); });

  document.getElementById('config-list-save-name-btn').addEventListener('click', function () {
    var id = stealerEmailCurrentId;
    if (id === STEALER_NEW_CONFIG_ID || !id) return;
    var input = document.getElementById('config-list-rename-input');
    var name = (input && input.value) ? input.value.trim() : '';
    if (!id || !name) return;
    saveConfigStealerEmail(false, name);
    appendLog('Имя конфига изменено на «' + name + '».', 'muted');
    var dropdown = document.getElementById('config-list-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
  });

  (function initConfigListDropdown() {
    var trigger = document.getElementById('config-list-trigger');
    var dropdown = document.getElementById('config-list-dropdown');
    var listEl = document.getElementById('config-email-list');
    var itemsEl = document.getElementById('config-list-items');
    if (trigger && dropdown) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', function () {
        dropdown.classList.add('hidden');
      });
      dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    if (itemsEl) {
      itemsEl.addEventListener('click', function (e) {
        var item = e.target.closest('.config-list-item');
        var delBtn = e.target.closest('.config-list-item-delete');
        if (delBtn && item) {
          e.preventDefault();
          e.stopPropagation();
          var id = delBtn.getAttribute('data-id');
          if (id) deleteStealerEmailConfig(id);
          return;
        }
        if (item && !delBtn) {
          var id = item.getAttribute('data-id');
          if (id && listEl) {
            listEl.value = id;
            if (id === STEALER_NEW_CONFIG_ID) {
              applyNewConfigStealerEmail();
              dropdown.classList.add('hidden');
            } else {
              selectStealerEmailConfig();
              dropdown.classList.add('hidden');
            }
          }
        }
      });
    }
  })();

  (function initWarmupConfigListDropdown() {
    var trigger = document.getElementById('warmup-config-list-trigger');
    var dropdown = document.getElementById('warmup-config-list-dropdown');
    var listEl = document.getElementById('warmup-config-email-list');
    var itemsEl = document.getElementById('warmup-config-list-items');
    if (trigger && dropdown) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', function () {
        dropdown.classList.add('hidden');
      });
      dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    if (itemsEl) {
      itemsEl.addEventListener('click', function (e) {
        var item = e.target.closest('.config-list-item');
        var delBtn = e.target.closest('.config-list-item-delete');
        if (delBtn && item) {
          e.preventDefault();
          e.stopPropagation();
          var id = delBtn.getAttribute('data-id');
          if (id) deleteWarmupConfig(id);
          return;
        }
        if (item && !delBtn) {
          var id = item.getAttribute('data-id');
          if (id && listEl) {
            listEl.value = id;
            if (id === WARMUP_NEW_CONFIG_ID) {
              applyNewConfigWarmupEmail();
              dropdown.classList.add('hidden');
            } else {
              selectWarmupConfig();
              dropdown.classList.add('hidden');
            }
          }
        }
      });
    }
  })();

  var warmupSaveBtn = document.getElementById('warmup-config-email-save');
  if (warmupSaveBtn) warmupSaveBtn.addEventListener('click', function () { saveConfigWarmupEmail(); });
  var warmupRenameSaveBtn = document.getElementById('warmup-config-list-save-name-btn');
  if (warmupRenameSaveBtn) {
    warmupRenameSaveBtn.addEventListener('click', function () {
      var id = warmupCurrentId;
      var input = document.getElementById('warmup-config-list-rename-input');
      var name = (input && input.value) ? input.value.trim() : '';
      if (!id || id === WARMUP_NEW_CONFIG_ID || !name) return;
      postJson('/api/config/warmup-email', { id: id, name: name, setCurrent: true }).then(function (r) { return r.json(); }).then(function () {
        loadConfigWarmupEmail();
        var dropdown = document.getElementById('warmup-config-list-dropdown');
        if (dropdown) dropdown.classList.add('hidden');
      }).catch(function (err) {
        var msgEl = document.getElementById('config-email-message');
        if (msgEl) { msgEl.textContent = err.message || 'Ошибка'; msgEl.className = 'config-msg error'; msgEl.classList.remove('hidden'); }
      });
    });
  }

  var templateInput = document.getElementById('config-email-template-file');
  var templateNameEl = document.getElementById('config-email-template-name');
  var imageInput = document.getElementById('config-email-image-file');
  var imageNameEl = document.getElementById('config-email-image-name');

  var editModal = document.getElementById('mailer-edit-modal');
  var editModalTitle = document.getElementById('mailer-edit-modal-title');
  var editTextarea = document.getElementById('mailer-edit-textarea');
  var editDrop = document.getElementById('mailer-edit-drop');
  var editDropHint = document.getElementById('mailer-edit-drop-hint');
  var editFileInput = document.getElementById('mailer-edit-file');
  var currentEditMode = null;
  var currentEditTab = 'campaign';

  function openEditModal(mode, tab) {
    currentEditMode = mode;
    currentEditTab = tab || currentMailerTab;
    var titles = { smtp: 'SMTP', email: 'База email', html: 'HTML' };
    if (currentEditTab === 'warmup' && mode === 'email') titles.email = 'База для прогрева';
    if (editModalTitle) editModalTitle.textContent = titles[mode] || mode;
    if (editTextarea) {
      if (mode === 'smtp') {
        var smtpId = currentEditTab === 'warmup' ? 'warmup-config-email-smtp-line' : 'config-email-smtp-line';
        var smtpInput = document.getElementById(smtpId);
        editTextarea.value = (smtpInput && smtpInput.value) ? smtpInput.value : '';
      } else if (mode === 'email') {
        var recId = currentEditTab === 'warmup' ? 'warmup-config-email-recipients-list' : 'config-email-recipients-list';
        var recipientsInput = document.getElementById(recId);
        editTextarea.value = (recipientsInput && recipientsInput.value) ? recipientsInput.value : '';
      } else {
        var htmlContent = currentEditTab === 'warmup' ? warmupLoadedHtml : stealerEmailLoadedHtml;
        var b64 = currentEditTab === 'warmup' ? warmupTemplateBase64 : stealerEmailTemplateBase64;
        if (b64) {
          try { htmlContent = decodeURIComponent(escape(atob(b64))); } catch (e) {}
        }
        editTextarea.value = htmlContent || '';
      }
      editTextarea.placeholder = mode === 'html' ? 'Вставьте HTML или перетащите файл .html' : (mode === 'email' ? 'Один email на строку или email:password (лишнее удаляется)' : 'Вставьте текст или перетащите файл');
    }
    if (editModal) {
      editModal.classList.remove('hidden');
      editModal.setAttribute('aria-hidden', 'false');
      setTimeout(function () { if (editTextarea) editTextarea.focus(); }, 50);
    }
  }

  function closeEditModal() {
    if (editModal) {
      editModal.classList.add('hidden');
      editModal.setAttribute('aria-hidden', 'true');
    }
    currentEditMode = null;
  }

  function saveEditModal() {
    if (!currentEditMode || !editTextarea) return;
    var val = editTextarea.value.trim();
    var isWarmup = currentEditTab === 'warmup';
    if (currentEditMode === 'smtp') {
      var smtpInput = document.getElementById(isWarmup ? 'warmup-config-email-smtp-line' : 'config-email-smtp-line');
      var smtpDisplay = document.getElementById(isWarmup ? 'warmup-config-email-smtp-display' : 'config-email-smtp-display');
      if (smtpInput) smtpInput.value = val;
      if (smtpDisplay) smtpDisplay.textContent = val ? 'SMTP ✓' : 'SMTP';
      if (isWarmup) saveConfigWarmupEmail();
      else saveConfigStealerEmail(false);
    } else if (currentEditMode === 'email') {
      var recipientsInput = document.getElementById(isWarmup ? 'warmup-config-email-recipients-list' : 'config-email-recipients-list');
      var recipientsDisplay = document.getElementById(isWarmup ? 'warmup-config-email-recipients-display' : 'config-email-recipients-display');
      if (recipientsInput) recipientsInput.value = val;
      var n = parseRecipientsList(val).items.length;
      if (recipientsDisplay) recipientsDisplay.textContent = n > 0 ? (isWarmup ? 'База для прогрева ✓ (' + n + ')' : 'База email ✓ (' + n + ')') : (isWarmup ? 'База для прогрева' : 'База email');
      if (isWarmup) {
        saveConfigWarmupEmail();
      } else {
        saveConfigStealerEmail(false);
      }
    } else if (currentEditMode === 'html') {
      if (isWarmup) {
        warmupTemplateBase64 = val ? btoa(unescape(encodeURIComponent(val))) : null;
        warmupLoadedHtml = val || '';
        var warmupTemplateName = document.getElementById('warmup-config-email-template-name');
        if (warmupTemplateName) warmupTemplateName.textContent = val ? 'HTML ✓' : 'HTML';
        saveConfigWarmupEmail();
      } else {
        stealerEmailTemplateBase64 = val ? btoa(unescape(encodeURIComponent(val))) : null;
        stealerEmailLoadedHtml = val || '';
        if (templateNameEl) templateNameEl.textContent = val ? 'HTML ✓' : 'HTML';
        saveConfigStealerEmail(false);
      }
    }
    closeEditModal();
  }

  function readFileAsText(file, cb) {
    var r = new FileReader();
    r.onload = function () { cb(null, r.result); };
    r.onerror = function () { cb(new Error('Не удалось прочитать файл')); };
    r.readAsText(file, 'utf8');
  }

  document.getElementById('edit-zone-smtp').addEventListener('click', function (e) {
    if (e.target.closest('.upload-clear')) return;
    openEditModal('smtp', 'campaign');
  });
  document.getElementById('edit-zone-smtp').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('smtp', 'campaign'); }
  });
  document.getElementById('edit-zone-email').addEventListener('click', function (e) {
    if (e.target.closest('.upload-clear')) return;
    openEditModal('email', 'campaign');
  });
  document.getElementById('edit-zone-email').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('email', 'campaign'); }
  });
  document.getElementById('upload-zone-template').addEventListener('click', function (e) {
    if (e.target.closest('.upload-clear')) return;
    openEditModal('html', 'campaign');
  });
  document.getElementById('upload-zone-template').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('html', 'campaign'); }
  });

  var warmupZoneSmtp = document.getElementById('warmup-edit-zone-smtp');
  if (warmupZoneSmtp) {
    warmupZoneSmtp.addEventListener('click', function (e) { if (e.target.closest('.upload-clear')) return; openEditModal('smtp', 'warmup'); });
    warmupZoneSmtp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('smtp', 'warmup'); } });
  }
  var warmupZoneEmail = document.getElementById('warmup-edit-zone-email');
  if (warmupZoneEmail) {
    warmupZoneEmail.addEventListener('click', function (e) { if (e.target.closest('.upload-clear')) return; openEditModal('email', 'warmup'); });
    warmupZoneEmail.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('email', 'warmup'); } });
  }
  var warmupZoneTemplate = document.getElementById('warmup-upload-zone-template');
  if (warmupZoneTemplate) {
    warmupZoneTemplate.addEventListener('click', function (e) { if (e.target.closest('.upload-clear')) return; openEditModal('html', 'warmup'); });
    warmupZoneTemplate.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditModal('html', 'warmup'); } });
  }

  document.getElementById('edit-clear-smtp').addEventListener('click', function (e) {
    e.stopPropagation();
    var smtpInput = document.getElementById('config-email-smtp-line');
    var smtpDisplay = document.getElementById('config-email-smtp-display');
    if (smtpInput) smtpInput.value = '';
    if (smtpDisplay) smtpDisplay.textContent = 'SMTP';
  });
  document.getElementById('edit-clear-email').addEventListener('click', function (e) {
    e.stopPropagation();
    var recipientsInput = document.getElementById('config-email-recipients-list');
    var recipientsDisplay = document.getElementById('config-email-recipients-display');
    if (recipientsInput) recipientsInput.value = '';
    if (recipientsDisplay) recipientsDisplay.textContent = 'База email';
  });
  document.getElementById('upload-clear-template').addEventListener('click', function (e) {
    e.stopPropagation();
    templateInput.value = '';
    stealerEmailTemplateBase64 = null;
    stealerEmailLoadedHtml = '';
    if (templateNameEl) templateNameEl.textContent = 'HTML';
  });

  var warmupClearSmtp = document.getElementById('warmup-edit-clear-smtp');
  if (warmupClearSmtp) warmupClearSmtp.addEventListener('click', function (e) {
    e.stopPropagation();
    var el = document.getElementById('warmup-config-email-smtp-line');
    var disp = document.getElementById('warmup-config-email-smtp-display');
    if (el) el.value = ''; if (disp) disp.textContent = 'SMTP';
  });
  var warmupClearEmail = document.getElementById('warmup-edit-clear-email');
  if (warmupClearEmail) warmupClearEmail.addEventListener('click', function (e) {
    e.stopPropagation();
    var el = document.getElementById('warmup-config-email-recipients-list');
    var disp = document.getElementById('warmup-config-email-recipients-display');
    if (el) el.value = ''; if (disp) disp.textContent = 'База для прогрева';
  });
  var warmupClearTemplate = document.getElementById('warmup-upload-clear-template');
  if (warmupClearTemplate) warmupClearTemplate.addEventListener('click', function (e) {
    e.stopPropagation();
    warmupTemplateBase64 = null;
    warmupLoadedHtml = '';
    var warmupTemplateFile = document.getElementById('warmup-config-email-template-file');
    if (warmupTemplateFile) warmupTemplateFile.value = '';
    var disp = document.getElementById('warmup-config-email-template-name');
    if (disp) disp.textContent = 'HTML';
  });

  document.getElementById('upload-zone-image').addEventListener('click', function (e) {
    if (e.target.closest('.upload-clear')) return;
    imageInput.click();
  });
  document.getElementById('upload-zone-image').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imageInput.click(); }
  });
  document.getElementById('upload-clear-image').addEventListener('click', function (e) {
    e.stopPropagation();
    imageInput.value = '';
    stealerEmailImageBase64 = null;
    if (imageNameEl) imageNameEl.textContent = 'Img';
  });
  var warmupImageInput = document.getElementById('warmup-config-email-image-file');
  var warmupImageNameEl = document.getElementById('warmup-config-email-image-name');
  var warmupUploadZoneImage = document.getElementById('warmup-upload-zone-image');
  if (warmupUploadZoneImage) {
    warmupUploadZoneImage.addEventListener('click', function (e) { if (e.target.closest('.upload-clear')) return; if (warmupImageInput) warmupImageInput.click(); });
    warmupUploadZoneImage.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (warmupImageInput) warmupImageInput.click(); } });
  }
  var warmupClearImage = document.getElementById('warmup-upload-clear-image');
  if (warmupClearImage) warmupClearImage.addEventListener('click', function (e) {
    e.stopPropagation();
    if (warmupImageInput) warmupImageInput.value = '';
    warmupImageBase64 = null;
    if (warmupImageNameEl) warmupImageNameEl.textContent = 'Img';
  });
  if (warmupImageInput) {
    warmupImageInput.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) { warmupImageBase64 = null; if (warmupImageNameEl) warmupImageNameEl.textContent = 'Img'; return; }
      var r = new FileReader();
      r.onload = function () {
        try {
          var s = r.result;
          if (s.indexOf('base64,') !== -1) s = s.slice(s.indexOf('base64,') + 7);
          warmupImageBase64 = s;
          if (warmupImageNameEl) warmupImageNameEl.textContent = 'Img ✓';
        } catch (e) { warmupImageBase64 = null; if (warmupImageNameEl) warmupImageNameEl.textContent = 'Img'; }
      };
      r.readAsDataURL(f);
    });
  }
  var warmupTemplateFileInput = document.getElementById('warmup-config-email-template-file');
  if (warmupTemplateFileInput) {
    warmupTemplateFileInput.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) { warmupTemplateBase64 = null; return; }
      var r = new FileReader();
      r.onload = function () {
        try {
          warmupTemplateBase64 = btoa(unescape(encodeURIComponent(r.result)));
          var disp = document.getElementById('warmup-config-email-template-name');
          if (disp) disp.textContent = 'HTML ✓';
        } catch (e) {}
      };
      r.readAsText(f, 'utf8');
    });
  }

  if (editModal) {
    document.getElementById('mailer-edit-modal-backdrop').addEventListener('click', closeEditModal);
    document.getElementById('mailer-edit-modal-box').addEventListener('click', function (e) { e.stopPropagation(); });
    document.getElementById('mailer-edit-modal-close').addEventListener('click', closeEditModal);
    document.getElementById('mailer-edit-btn-close').addEventListener('click', closeEditModal);
    document.getElementById('mailer-edit-btn-save').addEventListener('click', saveEditModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && editModal && !editModal.classList.contains('hidden')) closeEditModal();
    });
  }
  if (editDropHint && editFileInput) {
    editDropHint.addEventListener('click', function () { editFileInput.click(); });
  }
  if (editDrop) {
    editDrop.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      editDrop.classList.add('drag-over');
    });
    editDrop.addEventListener('dragleave', function (e) {
      e.preventDefault();
      editDrop.classList.remove('drag-over');
    });
    editDrop.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      editDrop.classList.remove('drag-over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      readFileAsText(f, function (err, text) {
        if (!err && editTextarea) editTextarea.value = text || '';
      });
    });
  }
  if (editFileInput && editTextarea) {
    editFileInput.addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      readFileAsText(f, function (err, text) {
        if (!err) editTextarea.value = text || '';
      });
      this.value = '';
    });
  }

  templateInput.addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) { stealerEmailTemplateBase64 = null; if (templateNameEl) templateNameEl.textContent = 'HTML'; return; }
    var r = new FileReader();
    r.onload = function () {
      try {
        stealerEmailTemplateBase64 = btoa(unescape(encodeURIComponent(r.result)));
        if (templateNameEl) templateNameEl.textContent = 'HTML ✓';
        if (stealerEmailCurrentId) saveConfigStealerEmail(false);
      } catch (e) { stealerEmailTemplateBase64 = null; if (templateNameEl) templateNameEl.textContent = 'HTML'; }
    };
    r.readAsText(f, 'utf8');
  });

  imageInput.addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) { stealerEmailImageBase64 = null; if (imageNameEl) imageNameEl.textContent = 'Img'; return; }
    var r = new FileReader();
    r.onload = function () {
      try {
        var s = r.result;
        if (s.indexOf('base64,') !== -1) s = s.slice(s.indexOf('base64,') + 7);
        stealerEmailImageBase64 = s;
        if (imageNameEl) imageNameEl.textContent = 'Img ✓';
      } catch (e) { stealerEmailImageBase64 = null; if (imageNameEl) imageNameEl.textContent = 'Img'; }
    };
    r.readAsDataURL(f);
  });

  loadConfigStealerEmail();
})();
