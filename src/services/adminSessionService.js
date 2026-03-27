'use strict';

const crypto = require('crypto');
const { getDb } = require('../db/database');

const INSERT_SESSION_SQL = 'INSERT OR REPLACE INTO admin_sessions (token) VALUES (?)';
const HAS_SESSION_SQL = 'SELECT 1 FROM admin_sessions WHERE token = ? LIMIT 1';
const DELETE_SESSION_SQL = 'DELETE FROM admin_sessions WHERE token = ?';

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(INSERT_SESSION_SQL).run(token);
  return token;
}

function isValid(token) {
  if (!token || typeof token !== 'string') return false;
  const row = getDb().prepare(HAS_SESSION_SQL).get(String(token));
  return !!row;
}

function revoke(token) {
  if (token) getDb().prepare(DELETE_SESSION_SQL).run(String(token));
}

function getAdminSessionTokenFromCookie(req) {
  const raw = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
  const name = 'admin_session';
  const re = new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)');
  const m = raw.match(re);
  return m ? decodeURIComponent(m[1].trim()) : '';
}

module.exports = {
  createSession,
  isValid,
  revoke,
  getAdminSessionTokenFromCookie,
};
