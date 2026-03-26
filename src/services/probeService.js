'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { send } = require('../utils/httpUtils');

let PROJECT_ROOT = path.join(__dirname, '..', '..');

const WEBDE_PROBE_MAX_INDICES_PER_JOB = (function () {
  const n = parseInt(process.env.WEBDE_PROBE_MAX_INDICES_PER_JOB || '12', 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(500, n);
})();

function init(opts) {
  if (opts && opts.projectRoot) PROJECT_ROOT = opts.projectRoot;
}

function webdeFpIndicesFile() {
  return path.join(PROJECT_ROOT, 'login', 'webde_fingerprint_indices.txt');
}

function webdeFingerprintsJson() {
  return path.join(PROJECT_ROOT, 'login', 'webde_fingerprints.json');
}

function webdeProbeBatchScript() {
  return path.join(PROJECT_ROOT, 'login', 'webde_probe_batch.py');
}

function loginDir() {
  return path.join(PROJECT_ROOT, 'login');
}

const webdeProbeJobs = new Map();
let webdeProbeJobSeq = 0;
const webdeFpProbeCursor = { index: 0 };

function readWebdeFingerprintsPoolMeta() {
  const jsonPath = webdeFingerprintsJson();
  const meta = { filePresent: false, pool: [], parseError: null };
  try {
    meta.filePresent = fs.existsSync(jsonPath);
    if (!meta.filePresent) return meta;
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      meta.pool = arr;
    } else {
      meta.parseError = 'not_array';
    }
  } catch (e) {
    meta.parseError = (e && e.message) ? String(e.message) : 'parse_error';
    meta.filePresent = fs.existsSync(jsonPath);
  }
  return meta;
}

function readWebdeFingerprintsPoolArr() {
  return readWebdeFingerprintsPoolMeta().pool;
}

function summarizeWebdeFingerprintEntry(fp) {
  if (!fp || typeof fp !== 'object') return '—';
  const loc = fp.locale || fp.language || '—';
  const vp = fp.viewport || {};
  const vw = vp.width != null ? vp.width : '—';
  const vh = vp.height != null ? vp.height : '—';
  const ua = String(fp.userAgent || '');
  const chromeM = ua.match(/Chrome\/[\d.]+/);
  const chrome = chromeM ? chromeM[0] : '';
  const tz = fp.timezoneId || '';
  const parts = [String(loc), String(vw) + '×' + String(vh), chrome, tz].filter(Boolean);
  return parts.join(' · ') || '—';
}

function readWebdeFpIndicesAllowedForProbe(poolLen) {
  if (poolLen <= 0) return [];
  const seen = new Set();
  const indicesFile = webdeFpIndicesFile();
  try {
    if (fs.existsSync(indicesFile)) {
      const content = fs.readFileSync(indicesFile, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let li = 0; li < lines.length; li++) {
        const s = lines[li].trim();
        if (!s || s.startsWith('#')) continue;
        const first = s.split(/\s+/)[0];
        const n = parseInt(first, 10);
        if (!isNaN(n) && n >= 0 && n < poolLen) seen.add(n);
      }
    }
  } catch (e) {}
  if (seen.size === 0) {
    const out = [];
    for (let i = 0; i < poolLen; i++) out.push(i);
    return out;
  }
  return Array.from(seen).sort(function (a, b) { return a - b; });
}

function buildWebdeFingerprintsListPayload() {
  const meta = readWebdeFingerprintsPoolMeta();
  const pool = meta.pool;
  const allowed = readWebdeFpIndicesAllowedForProbe(pool.length);
  const allowedSet = new Set(allowed);
  return {
    entries: pool.map(function (fp, index) {
      return {
        index: index,
        summary: summarizeWebdeFingerprintEntry(fp),
        active: allowedSet.has(index),
      };
    }),
    activeIndices: allowed,
    filePresent: meta.filePresent,
    poolLength: pool.length,
    parseError: meta.parseError,
  };
}

function pruneWebdeProbeJobs() {
  const now = Date.now();
  for (const [id, j] of webdeProbeJobs) {
    if (j.done && (now - (j.updatedAt || j.startedAt)) > 3600000) {
      webdeProbeJobs.delete(id);
    }
  }
  if (webdeProbeJobs.size > 20) {
    const entries = Array.from(webdeProbeJobs.entries()).sort(function (a, b) {
      return (b[1].startedAt || 0) - (a[1].startedAt || 0);
    });
    for (let i = 20; i < entries.length; i++) {
      webdeProbeJobs.delete(entries[i][0]);
    }
  }
}

function webdeProbeScheduleContinue(jobId) {
  const job = webdeProbeJobs.get(jobId);
  if (job && !job.done && !job.error) {
    job.running = true;
    job.updatedAt = Date.now();
  }
  setImmediate(function () {
    webdeProbeRunOneBatch(jobId);
  });
}

function webdeProbeRunOneBatch(jobId) {
  const scriptPath = webdeProbeBatchScript();
  const job = webdeProbeJobs.get(jobId);
  if (!job || job.done || job.error) return;
  if (job.paused) {
    job.running = false;
    job.updatedAt = Date.now();
    return;
  }
  const batch = job.indices.slice(job.cursor, job.cursor + 3);
  if (batch.length === 0) {
    job.done = true;
    job.running = false;
    job.updatedAt = Date.now();
    return;
  }
  job.running = true;
  job.updatedAt = Date.now();
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const stdinPayload = JSON.stringify({
    email: job.email,
    password: job.password,
    indices: batch,
    headless: !!job.probeHeadless,
    requirePasswordField: job.requirePasswordField !== false,
  });
  const maxOut = 50 * 1024 * 1024;
  const maxErr = 2 * 1024 * 1024;
  let outBuf = '';
  let errBuf = '';
  let childDone = false;
  let child;
  try {
    child = spawn(python, [scriptPath], {
      cwd: loginDir(),
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    job.running = false;
    job.error = (e && e.message) ? e.message : String(e);
    job.done = true;
    job.updatedAt = Date.now();
    return;
  }
  const killTimer = setTimeout(function () {
    if (childDone) return;
    childDone = true;
    try {
      child.kill('SIGTERM');
    } catch (eK) {}
    job.running = false;
    job.error = 'Таймаут пробы (900 с)';
    job.done = true;
    job.updatedAt = Date.now();
  }, 900000);

  function finishBatch(code, signal) {
    if (childDone) return;
    childDone = true;
    clearTimeout(killTimer);
    job.running = false;
    job.updatedAt = Date.now();
    if (signal) {
      job.error = 'Прервано: ' + String(signal);
      job.done = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(String((outBuf || '').trim() || '{}'));
    } catch (e2) {
      job.error = 'Некорректный ответ скрипта пробы';
      job.done = true;
      return;
    }
    if (parsed.ok === false && parsed.error) {
      job.error = String(parsed.error);
      job.done = true;
      return;
    }
    if (code !== 0 && parsed.ok !== true) {
      const errText = ((errBuf || '') + (outBuf || '')).trim().slice(0, 800);
      job.error = errText || ('код выхода ' + String(code));
      job.done = true;
      return;
    }
    const batchResults = Array.isArray(parsed.results) ? parsed.results : [];
    for (let bi = 0; bi < batchResults.length; bi++) {
      job.results.push(batchResults[bi]);
    }
    job.cursor += batch.length;
    if (job.cursor >= job.indices.length) {
      job.done = true;
    } else if (job.paused) {
      job.running = false;
      job.updatedAt = Date.now();
    } else {
      webdeProbeScheduleContinue(jobId);
    }
  }

  child.stdout.on('data', function (chunk) {
    if (outBuf.length < maxOut) outBuf += chunk.toString();
  });
  child.stderr.on('data', function (chunk) {
    if (errBuf.length < maxErr) errBuf += chunk.toString();
  });
  child.on('error', function (e) {
    if (childDone) return;
    childDone = true;
    clearTimeout(killTimer);
    job.running = false;
    job.error = (e && e.message) ? e.message : String(e);
    job.done = true;
    job.updatedAt = Date.now();
  });
  child.on('close', function (code, signal) {
    finishBatch(code, signal);
  });
  try {
    child.stdin.end(stdinPayload, 'utf8');
  } catch (eIn) {
    if (!childDone) {
      childDone = true;
      clearTimeout(killTimer);
      try {
        child.kill('SIGTERM');
      } catch (eK2) {}
      job.running = false;
      job.error = (eIn && eIn.message) ? eIn.message : 'stdin';
      job.done = true;
      job.updatedAt = Date.now();
    }
  }
}

function handleWebdeFingerprintProbePause(res, json) {
  const jobId = String(json.webdeProbeJobId != null ? json.webdeProbeJobId : json.jobId || '').trim();
  if (!jobId) return send(res, 400, { ok: false, error: 'webdeProbeJobId' });
  const job = webdeProbeJobs.get(jobId);
  if (!job) return send(res, 404, { ok: false, error: 'Задача не найдена' });
  if (job.done) return send(res, 400, { ok: false, error: 'Задача уже завершена' });
  job.paused = true;
  job.updatedAt = Date.now();
  return send(res, 200, { ok: true });
}

function handleWebdeFingerprintProbeResume(res, json) {
  const jobId = String(json.webdeProbeJobId != null ? json.webdeProbeJobId : json.jobId || '').trim();
  if (!jobId) return send(res, 400, { ok: false, error: 'webdeProbeJobId' });
  const job = webdeProbeJobs.get(jobId);
  if (!job) return send(res, 404, { ok: false, error: 'Задача не найдена' });
  if (job.done) return send(res, 400, { ok: false, error: 'Задача уже завершена' });
  job.paused = false;
  job.updatedAt = Date.now();
  if (!job.running && !job.error) webdeProbeScheduleContinue(jobId);
  return send(res, 200, { ok: true });
}

function handleWebdeFingerprintProbeStart(res, json) {
  let email = '';
  let password = '';
  const cred = json.credentials != null ? String(json.credentials).trim() : '';
  if (cred) {
    const colon = cred.indexOf(':');
    if (colon === -1) {
      email = cred.trim();
      password = '';
    } else {
      email = cred.slice(0, colon).trim();
      password = cred.slice(colon + 1);
    }
  } else {
    email = String(json.email || '').trim();
    password = String(json.password || '');
  }
  if (!email) {
    return send(res, 400, { ok: false, error: 'Укажите email' });
  }
  if (!fs.existsSync(webdeProbeBatchScript())) {
    return send(res, 500, { ok: false, error: 'Скрипт webde_probe_batch.py не найден' });
  }
  const pool = readWebdeFingerprintsPoolArr();
  const indicesAll = readWebdeFpIndicesAllowedForProbe(pool.length);
  if (indicesAll.length === 0) {
    return send(res, 400, { ok: false, error: 'Нет отпечатков (пул пуст)' });
  }
  const nAll = indicesAll.length;
  const take = Math.min(WEBDE_PROBE_MAX_INDICES_PER_JOB, nAll);
  const startPos = webdeFpProbeCursor.index % nAll;
  const indices = [];
  for (let k = 0; k < take; k++) {
    indices.push(indicesAll[(startPos + k) % nAll]);
  }
  webdeFpProbeCursor.index = (startPos + take) % nAll;
  const probeIndicesTruncated = nAll > take;
  pruneWebdeProbeJobs();
  const jobId = 'wp' + (++webdeProbeJobSeq).toString(36) + '-' + Date.now().toString(36);
  const hasGui = !!(
    (process.env.DISPLAY && String(process.env.DISPLAY).trim()) ||
    (process.env.WAYLAND_DISPLAY && String(process.env.WAYLAND_DISPLAY).trim())
  );
  const userRequestedHeadless =
    json.probeHeadless === true ||
    json.headless === true ||
    json.probeHeadless === 'true' ||
    json.headless === 'true';
  let probeHeadless = userRequestedHeadless;
  let probeHeadlessForced = false;
  if (!hasGui && !userRequestedHeadless) {
    probeHeadless = true;
    probeHeadlessForced = true;
    console.log('[WEBDE probe] Нет DISPLAY/WAYLAND_DISPLAY — принудительно headless (иначе каждый прогон падает с error)');
  }
  const requirePasswordField = json.requirePasswordField !== false && json.requirePasswordField !== 'false' && json.requirePasswordField !== 0;
  const job = {
    email: email,
    password: password,
    indices: indices,
    cursor: 0,
    results: [],
    done: false,
    running: false,
    paused: false,
    error: null,
    probeHeadless: probeHeadless,
    requirePasswordField: requirePasswordField,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  webdeProbeJobs.set(jobId, job);
  webdeProbeScheduleContinue(jobId);
  return send(res, 200, {
    ok: true,
    jobId: jobId,
    total: indices.length,
    totalIndicesAvailable: indicesAll.length,
    probeIndicesTruncated: probeIndicesTruncated,
    probeMaxIndicesPerJob: WEBDE_PROBE_MAX_INDICES_PER_JOB,
    probeHeadlessForced: probeHeadlessForced,
  });
}

function sendWebdeFingerprintProbeStatus(res, jobId) {
  if (!jobId) return send(res, 400, { ok: false, error: 'jobId' });
  const job = webdeProbeJobs.get(jobId);
  if (!job) return send(res, 404, { ok: false, error: 'Задача не найдена' });
  return send(res, 200, {
    ok: true,
    done: job.done,
    running: job.running,
    paused: !!job.paused,
    error: job.error,
    progress: { done: job.cursor, total: job.indices.length },
    results: job.results,
  });
}

module.exports = {
  init,
  WEBDE_PROBE_MAX_INDICES_PER_JOB,
  webdeProbeJobs,
  webdeFpProbeCursor,
  readWebdeFingerprintsPoolMeta,
  readWebdeFingerprintsPoolArr,
  summarizeWebdeFingerprintEntry,
  buildWebdeFingerprintsListPayload,
  readWebdeFpIndicesAllowedForProbe,
  pruneWebdeProbeJobs,
  webdeProbeScheduleContinue,
  webdeProbeRunOneBatch,
  handleWebdeFingerprintProbePause,
  handleWebdeFingerprintProbeResume,
  handleWebdeFingerprintProbeStart,
  sendWebdeFingerprintProbeStatus,
  webdeFpIndicesFile,
  webdeFingerprintsJson,
  webdeProbeBatchScript,
};
