#!/usr/bin/env node
/**
 * Эмуляция запуска скрипта входа WEB.DE как в проде:
 * берёт первый лид с @web.de из SQLite (data/database.sqlite) и запускает login/lead_simulation_api.py
 * с тем же lead-id и токеном. Сервер должен быть уже запущен (npm start с PORT=3001).
 *
 * Использование:
 *   WORKER_SECRET=... PORT=3001 node scripts/emulate-auto-login.js
 *   или LEAD_ID=... WORKER_SECRET=... PORT=3001 node scripts/emulate-auto-login.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getAllLeads, closeDb, DB_PATH } = require('../src/db/database.js');

const LOGIN_DIR = path.join(__dirname, '..', 'login');
const SCRIPT_PATH = path.join(LOGIN_DIR, 'lead_simulation_api.py');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const BASE_URL = process.env.SERVER_URL || `http://127.0.0.1:${PORT}`;
const TOKEN = (process.env.WORKER_SECRET || process.env.ADMIN_TOKEN || '').trim();
const LEAD_ID_ENV = process.env.LEAD_ID && process.env.LEAD_ID.trim();

function getFirstWebdeLeadId() {
  try {
    const list = getAllLeads();
    const webde = list.find((l) => (l.email || '').toLowerCase().includes('web.de'));
    if (!webde || !webde.id) {
      console.error(
        '[emulate] Нет лида с @web.de в SQLite (' + DB_PATH + '). Задайте LEAD_ID=... или добавьте лида.'
      );
      process.exit(1);
    }
    return webde.id;
  } catch (e) {
    console.error('[emulate] Ошибка чтения SQLite:', e && e.message ? e.message : e);
    process.exit(1);
  } finally {
    try {
      closeDb();
    } catch (_) {}
  }
}

const leadId = LEAD_ID_ENV || getFirstWebdeLeadId();
if (!TOKEN) {
  console.error('[emulate] Задайте WORKER_SECRET (или устар. ADMIN_TOKEN) в .env — тот же секрет, что x-worker-secret для Python');
  process.exit(1);
}
if (!fs.existsSync(SCRIPT_PATH)) {
  console.error('[emulate] Не найден скрипт', SCRIPT_PATH);
  process.exit(1);
}

console.log('[emulate] Сервер:', BASE_URL);
console.log('[emulate] Lead ID:', leadId);
console.log('[emulate] Запуск:', SCRIPT_PATH);
const python = process.platform === 'win32' ? 'python' : 'python3';
const child = spawn(
  python,
  [SCRIPT_PATH, '--server-url', BASE_URL, '--lead-id', leadId, '--worker-secret', TOKEN],
  { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, WORKER_SECRET: TOKEN, PYTHONUNBUFFERED: '1' } }
);
child.on('close', (code) => process.exit(code != null ? code : 0));
