'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.GMW_DATA_DIR
  ? path.resolve(process.env.GMW_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

const mailService = require('../services/mailService');
const warmupService = require('../services/warmupService');
const probeService = require('../services/probeService');

/** Согласовано с automationService (WEBDE_SCRIPT_MAX_AGE_MS по умолчанию). */
function getWebdeLockStaleMaxAgeMs() {
  const v = parseInt(process.env.WEBDE_SCRIPT_LOCK_MAX_AGE_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return 270000;
}

/** Старт: убрать устаревшие .lock в data/webde-locks/, чтобы не блокировать автоматизацию после сбоя/рестарта. */
function cleanupStaleWebdeLocks(dataDir) {
  const dir = path.join(dataDir, 'webde-locks');
  if (!fs.existsSync(dir)) return;
  const maxAge = getWebdeLockStaleMaxAgeMs();
  const now = Date.now();
  let removed = 0;
  try {
    const names = fs.readdirSync(dir);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!name.endsWith('.lock')) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > maxAge) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[bootstrap] webde-locks cleanup:', e && e.message ? e.message : e);
  }
  if (removed) console.log('[SERVER] webde-locks: удалено устаревших .lock: ' + removed);
}

function initAppServices(opts) {
  cleanupStaleWebdeLocks(DATA_DIR);
  const pushEvent = opts && opts.pushEvent;
  mailService.init({ dataDir: DATA_DIR, pushEvent });
  warmupService.init({ dataDir: DATA_DIR });
  probeService.init({ projectRoot: PROJECT_ROOT });
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  initAppServices,
};
