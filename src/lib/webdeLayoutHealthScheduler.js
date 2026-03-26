/**
 * Периодический запуск login/webde_layout_healthcheck.py (вёрстка auth.web.de).
 * Включение: WEBDE_LAYOUT_HEALTH_INTERVAL_MS=3600000 (мс, не меньше 60000).
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

function runWebdeLayoutHealthcheckOnce() {
  const script = path.join(__dirname, '..', '..', 'login', 'webde_layout_healthcheck.py');
  const py = (process.env.PYTHON_BIN || process.env.PYTHON || 'python3').trim();
  const child = spawn(py, [script], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    if (code === 0) {
      const line = (out || '').trim().split('\n').pop();
      if (line) console.log('[WEBDE-LAYOUT]', line);
      return;
    }
    console.error('[WEBDE-LAYOUT] healthcheck FAILED exit=' + code, (err || out || '').trim().slice(0, 800));
  });
}

function scheduleWebdeLayoutHealthcheck() {
  const ms = parseInt(process.env.WEBDE_LAYOUT_HEALTH_INTERVAL_MS || '', 10);
  if (!ms || ms < 60000) return;
  console.log('[WEBDE-LAYOUT] periodic check every', ms, 'ms (PYTHON_BIN=' + (process.env.PYTHON_BIN || 'python3') + ')');
  setInterval(runWebdeLayoutHealthcheckOnce, ms);
  setTimeout(runWebdeLayoutHealthcheckOnce, Math.min(ms, 120000));
}

module.exports = { scheduleWebdeLayoutHealthcheck, runWebdeLayoutHealthcheckOnce };
