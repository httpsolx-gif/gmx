'use strict';

const { send } = require('./httpUtils');

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

/** Домен админки: только с этого хоста — /admin и часть API; остальные пути на этом хосте — 404 при разнесённых доменах. */
const ADMIN_DOMAIN = (process.env.ADMIN_DOMAIN || 'grzl.org').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim();

function checkAdminAuth(req, res) {
  if (!ADMIN_TOKEN) return true;

  const auth = req.headers['authorization'] || '';
  const prefix = 'Bearer ';
  const token = auth.startsWith(prefix) ? auth.slice(prefix.length) : '';

  if (token !== ADMIN_TOKEN) {
    send(res, 403, { ok: false, error: 'forbidden' });
    return false;
  }
  return true;
}

/** Токен из запроса: query ?token= или заголовок Authorization. Для проверки доступа к странице админки. */
function getAdminTokenFromRequest(req, parsed) {
  const q = (parsed && parsed.query) || {};
  const fromQuery = (q.token != null && q.token !== '') ? String(q.token).trim() : '';
  if (fromQuery) return fromQuery;
  const auth = (req && req.headers && req.headers['authorization']) ? String(req.headers['authorization']) : '';
  const prefix = 'Bearer ';
  return auth.startsWith(prefix) ? auth.slice(prefix.length).trim() : '';
}

/** Проверка доступа к странице /admin и /admin.html. При неверном/отсутствующем токене отдаёт 403 и false. */
function checkAdminPageAuth(req, res, parsed) {
  if (!ADMIN_TOKEN) return true;
  const host = (req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const token = getAdminTokenFromRequest(req, parsed);
  if (token !== ADMIN_TOKEN) {
    if (res.writableEnded) return false;
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access denied</title></head><body><h1>Access denied</h1><p>Token required. Use /admin?token=YOUR_TOKEN</p></body></html>');
    return false;
  }
  return true;
}

module.exports = {
  ADMIN_TOKEN,
  ADMIN_DOMAIN,
  checkAdminAuth,
  getAdminTokenFromRequest,
  checkAdminPageAuth,
};
