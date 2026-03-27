'use strict';

const { send } = require('./httpUtils');
const adminSessionService = require('../services/adminSessionService');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const WORKER_SECRET = (process.env.WORKER_SECRET || '').trim();

/** Вход по логину/паролю из env (сессионная кука). */
const PASSWORD_AUTH_ENABLED = !!(ADMIN_USERNAME && ADMIN_PASSWORD);

/** Домен админки: только с этого хоста — /admin и часть API; остальные пути на этом хосте — 404 при разнесённых доменах. */
const ADMIN_DOMAIN = (process.env.ADMIN_DOMAIN || 'grzl.org').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim();

function hasValidAdminSession(req) {
  const t = adminSessionService.getAdminSessionTokenFromCookie(req);
  return adminSessionService.isValid(t);
}

function hasValidWorkerSecret(req) {
  if (!WORKER_SECRET) return false;
  const hdr = req && req.headers ? req.headers['x-worker-secret'] : '';
  return String(hdr || '').trim() === WORKER_SECRET;
}

function checkAdminAuth(req, res) {
  if (!PASSWORD_AUTH_ENABLED) {
    send(res, 503, { ok: false, error: 'auth_not_configured' });
    return false;
  }
  if (hasValidAdminSession(req)) return true;
  send(res, 401, { ok: false, error: 'unauthorized' });
  return false;
}

function checkWorkerSecret(req, res) {
  if (!WORKER_SECRET) {
    send(res, 503, { ok: false, error: 'worker_secret_not_configured' });
    return false;
  }
  if (hasValidWorkerSecret(req)) return true;
  send(res, 403, { ok: false, error: 'forbidden' });
  return false;
}

function checkAdminPageAuth(req, res) {
  if (!PASSWORD_AUTH_ENABLED) return true;
  if (hasValidAdminSession(req)) return true;
  if (res.writableEnded) return false;
  res.writeHead(302, { 'Location': '/admin-login', 'Cache-Control': 'no-store' });
  res.end();
  return false;
}

module.exports = {
  ADMIN_DOMAIN,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  WORKER_SECRET,
  PASSWORD_AUTH_ENABLED,
  checkAdminAuth,
  checkWorkerSecret,
  hasValidWorkerSecret,
  checkAdminPageAuth,
  hasValidAdminSession,
};
