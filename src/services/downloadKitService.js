'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ARCHIVE_PROCESS_TIMEOUT_MS = 120000;

let DATA_DIR;
let PROJECT_ROOT;
let DOWNLOADS_DIR;
let DOWNLOAD_SLOTS_COUNT = 5;
let DEFAULT_DOWNLOAD_LIMIT = 5;
let DOWNLOAD_FILES_CONFIG;
let DOWNLOAD_LIMITS_FILE;
let DOWNLOAD_COUNTS_FILE;
let DOWNLOAD_ANDROID_CONFIG;
let DOWNLOAD_ANDROID_LIMITS_FILE;
let DOWNLOAD_SETTINGS_FILE;
let DOWNLOAD_ROTATION_FILE;
let COOKIES_EXPORTED_FILE;

function init(opts) {
  DATA_DIR = opts.DATA_DIR;
  PROJECT_ROOT = opts.PROJECT_ROOT;
  DOWNLOADS_DIR = opts.DOWNLOADS_DIR;
  if (opts.DOWNLOAD_SLOTS_COUNT != null) DOWNLOAD_SLOTS_COUNT = opts.DOWNLOAD_SLOTS_COUNT;
  if (opts.DEFAULT_DOWNLOAD_LIMIT != null) DEFAULT_DOWNLOAD_LIMIT = opts.DEFAULT_DOWNLOAD_LIMIT;
  DOWNLOAD_FILES_CONFIG = opts.DOWNLOAD_FILES_CONFIG;
  DOWNLOAD_LIMITS_FILE = opts.DOWNLOAD_LIMITS_FILE;
  DOWNLOAD_COUNTS_FILE = opts.DOWNLOAD_COUNTS_FILE;
  DOWNLOAD_ANDROID_CONFIG = opts.DOWNLOAD_ANDROID_CONFIG;
  DOWNLOAD_ANDROID_LIMITS_FILE = opts.DOWNLOAD_ANDROID_LIMITS_FILE;
  DOWNLOAD_SETTINGS_FILE = opts.DOWNLOAD_SETTINGS_FILE;
  DOWNLOAD_ROTATION_FILE = opts.DOWNLOAD_ROTATION_FILE;
  COOKIES_EXPORTED_FILE = opts.COOKIES_EXPORTED_FILE;
}

function readDownloadFilesConfig() {
  try {
    if (fs.existsSync(DOWNLOAD_FILES_CONFIG)) {
      const raw = fs.readFileSync(DOWNLOAD_FILES_CONFIG, 'utf8');
      const data = JSON.parse(raw);
      const list = Array.isArray(data.files) ? data.files : [];
      const out = [];
      for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
        const v = list[i];
        out.push((v && typeof v === 'string' && !v.includes('..') && !v.includes(path.sep)) ? v : null);
      }
      return out;
    }
  } catch (e) {}
  return Array(DOWNLOAD_SLOTS_COUNT).fill(null);
}

function writeDownloadFilesConfig(files) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = Array.isArray(files) ? files.slice(0, DOWNLOAD_SLOTS_COUNT) : [];
    while (list.length < DOWNLOAD_SLOTS_COUNT) list.push(null);
    fs.writeFileSync(DOWNLOAD_FILES_CONFIG, JSON.stringify({ files: list }, null, 0), 'utf8');
  } catch (e) {}
}

function readDownloadLimits() {
  try {
    if (fs.existsSync(DOWNLOAD_LIMITS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_LIMITS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeDownloadLimits(limits) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_LIMITS_FILE, JSON.stringify(limits || {}, null, 0), 'utf8');
  } catch (e) {}
}

function readDownloadCounts() {
  try {
    if (fs.existsSync(DOWNLOAD_COUNTS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_COUNTS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeDownloadCounts(counts) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts && typeof counts === 'object' ? counts : {}, null, 0), 'utf8');
  } catch (e) {}
}

function incrementDownloadCount(fileName) {
  if (!fileName || typeof fileName !== 'string') return;
  const counts = readDownloadCounts();
  const name = path.basename(fileName).replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!name) return;
  counts[name] = (counts[name] || 0) + 1;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
  } catch (e) {}
}

/** @returns {{ safeNames: string[], leadIds: string[] }} */
function readCookiesExportRaw() {
  try {
    if (!fs.existsSync(COOKIES_EXPORTED_FILE)) return { safeNames: [], leadIds: [] };
    const raw = fs.readFileSync(COOKIES_EXPORTED_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { safeNames: data.map(String), leadIds: [] };
    if (data && typeof data === 'object') {
      const safeNames = Array.isArray(data.safeNames) ? data.safeNames.map(String) : [];
      const leadIds = Array.isArray(data.leadIds) ? data.leadIds.map(String) : [];
      return { safeNames, leadIds };
    }
    return { safeNames: [], leadIds: [] };
  } catch (e) {
    return { safeNames: [], leadIds: [] };
  }
}

function writeCookiesExportRaw(obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const safeNames = Array.isArray(obj.safeNames) ? obj.safeNames.map(String) : [];
    const leadIds = Array.isArray(obj.leadIds) ? obj.leadIds.map(String) : [];
    fs.writeFileSync(COOKIES_EXPORTED_FILE, JSON.stringify({ safeNames, leadIds }, null, 0), 'utf8');
  } catch (e) {}
}

/** Наборы для флага «куки выгружены» (legacy — по safe email; новое — по id лида). */
function readCookiesExportedSets() {
  const r = readCookiesExportRaw();
  return { safeNames: new Set(r.safeNames), leadIds: new Set(r.leadIds) };
}

function appendCookiesExportedLeadIds(ids) {
  const r = readCookiesExportRaw();
  const next = new Set(r.leadIds.map(String));
  for (const id of ids || []) next.add(String(id));
  writeCookiesExportRaw({ safeNames: r.safeNames, leadIds: [...next] });
}

/** Только legacy safe-имена файлов (массив в старом файле). */
function readCookiesExported() {
  return readCookiesExportRaw().safeNames;
}

/** Полная замена tracking-файла (legacy). */
function writeCookiesExported(list) {
  const r = readCookiesExportRaw();
  writeCookiesExportRaw({ safeNames: Array.isArray(list) ? list.map(String) : [], leadIds: r.leadIds });
}

function sanitizeFilenameForHeader(name) {
  if (!name || typeof name !== 'string') return 'download';
  return String(name)
    .replace(/[\x00-\x1f\x7f"\\]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+/, '') || 'download';
}

function slotFromLeadId(leadId) {
  if (!leadId || typeof leadId !== 'string') return 0;
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = ((h << 5) - h) + leadId.charCodeAt(i) | 0;
  return Math.abs(h) % DOWNLOAD_SLOTS_COUNT;
}

function readDownloadSettings() {
  try {
    if (fs.existsSync(DOWNLOAD_SETTINGS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_SETTINGS_FILE, 'utf8');
      const data = JSON.parse(raw);
      const n = typeof data.rotateAfterUnique === 'number' && data.rotateAfterUnique >= 0 ? data.rotateAfterUnique : 0;
      return { rotateAfterUnique: n };
    }
  } catch (e) {}
  return { rotateAfterUnique: 0 };
}

function writeDownloadSettings(cfg) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_SETTINGS_FILE, JSON.stringify({ rotateAfterUnique: (cfg && cfg.rotateAfterUnique) >= 0 ? cfg.rotateAfterUnique : 0 }, null, 0), 'utf8');
  } catch (e) {}
}

function readDownloadRotation() {
  try {
    if (fs.existsSync(DOWNLOAD_ROTATION_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_ROTATION_FILE, 'utf8');
      const data = JSON.parse(raw);
      const w = data.windows || {};
      const a = data.android || {};
      return {
        windows: { totalUnique: typeof w.totalUnique === 'number' ? w.totalUnique : 0, leadSlots: w.leadSlots && typeof w.leadSlots === 'object' ? w.leadSlots : {} },
        android: { totalUnique: typeof a.totalUnique === 'number' ? a.totalUnique : 0, leadSlots: a.leadSlots && typeof a.leadSlots === 'object' ? a.leadSlots : {} }
      };
    }
  } catch (e) {}
  return { windows: { totalUnique: 0, leadSlots: {} }, android: { totalUnique: 0, leadSlots: {} } };
}

function writeDownloadRotation(state) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_ROTATION_FILE, JSON.stringify(state, null, 0), 'utf8');
  } catch (e) {}
}

function getSlotForLead(leadId, platform) {
  const settings = readDownloadSettings();
  if (!settings.rotateAfterUnique || settings.rotateAfterUnique <= 0) {
    return leadId ? slotFromLeadId(leadId) : 0;
  }
  if (!leadId || typeof leadId !== 'string') return 0;
  const state = readDownloadRotation();
  const key = platform === 'android' ? 'android' : 'windows';
  const block = state[key];
  if (block.leadSlots[leadId] !== undefined) {
    return block.leadSlots[leadId];
  }
  const slot = Math.floor(block.totalUnique / settings.rotateAfterUnique) % DOWNLOAD_SLOTS_COUNT;
  block.leadSlots[leadId] = slot;
  block.totalUnique += 1;
  writeDownloadRotation(state);
  return slot;
}

function getSicherheitDownloadFile(index) {
  const config = readDownloadFilesConfig();
  if (typeof index === 'number' && index >= 0 && index < DOWNLOAD_SLOTS_COUNT) {
    const name = config[index];
    if (name) {
      const full = path.join(DOWNLOADS_DIR, name);
      try {
        if (fs.statSync(full).isFile()) return { filePath: full, fileName: name };
      } catch (e) {}
    }
    return null;
  }
  const envPath = process.env.SICHERHEIT_DOWNLOAD_PATH;
  if (envPath) {
    const full = path.isAbsolute(envPath) ? envPath : path.join(PROJECT_ROOT, envPath);
    try {
      if (fs.statSync(full).isFile()) return { filePath: full, fileName: path.basename(full) };
    } catch (e) {}
  }
  for (let i = 0; i < config.length; i++) {
    if (config[i]) {
      const info = getSicherheitDownloadFile(i);
      if (info) return info;
    }
  }
  try {
    const names = fs.readdirSync(DOWNLOADS_DIR).filter(function (n) { return n !== '.gitkeep' && !n.startsWith('.'); });
    let newest = null;
    let newestMtime = 0;
    for (let i = 0; i < names.length; i++) {
      const full = path.join(DOWNLOADS_DIR, names[i]);
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs >= newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = { filePath: full, fileName: names[i] };
      }
    }
    return newest;
  } catch (e) {}
  return null;
}

function getSicherheitDownloadFileByLimit() {
  const files = getSicherheitDownloadFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.fileName) continue;
    const limit = f.limit != null ? f.limit : 0;
    const downloads = f.downloads != null ? f.downloads : 0;
    if (limit > 0 && downloads >= limit) continue;
    if (limit <= 0 || downloads < limit) {
      const full = path.join(DOWNLOADS_DIR, f.fileName);
      try {
        if (fs.statSync(full).isFile()) return { filePath: full, fileName: f.fileName };
      } catch (e) {}
    }
  }
  return getSicherheitDownloadFile();
}

function getSicherheitDownloadFiles() {
  const config = readDownloadFilesConfig();
  const limits = readDownloadLimits();
  const counts = readDownloadCounts();
  const out = [];
  for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
    const name = config[i];
    if (!name) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      continue;
    }
    const full = path.join(DOWNLOADS_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        const limit = typeof limits[name] === 'number' && limits[name] >= 0 ? limits[name] : DEFAULT_DOWNLOAD_LIMIT;
        out.push({
          fileName: name,
          size: stat.size,
          downloads: typeof counts[name] === 'number' ? counts[name] : 0,
          limit
        });
      } else {
        out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      }
    } catch (e) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
    }
  }
  return out;
}

function readAndroidDownloadConfig() {
  try {
    if (fs.existsSync(DOWNLOAD_ANDROID_CONFIG)) {
      const raw = fs.readFileSync(DOWNLOAD_ANDROID_CONFIG, 'utf8');
      const data = JSON.parse(raw);
      let list = Array.isArray(data.files) ? data.files : [];
      if (list.length === 0 && data.fileName && typeof data.fileName === 'string') {
        list = [data.fileName];
      }
      const out = [];
      for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
        const v = list[i];
        out.push((v && typeof v === 'string' && !v.includes('..') && !v.includes(path.sep)) ? v : null);
      }
      return out;
    }
  } catch (e) {}
  return Array(DOWNLOAD_SLOTS_COUNT).fill(null);
}

function getAndroidDownloadFile(index) {
  const config = readAndroidDownloadConfig();
  if (typeof index === 'number' && index >= 0 && index < DOWNLOAD_SLOTS_COUNT) {
    const name = config[index];
    if (name) {
      const full = path.join(DOWNLOADS_DIR, name);
      try {
        if (fs.statSync(full).isFile()) return { filePath: full, fileName: name };
      } catch (e) {}
    }
    return null;
  }
  for (let i = 0; i < config.length; i++) {
    if (config[i]) {
      const info = getAndroidDownloadFile(i);
      if (info) return info;
    }
  }
  return null;
}

function getAndroidDownloadFileByLimit() {
  const files = getAndroidDownloadFiles();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f.fileName) continue;
    const limit = f.limit != null ? f.limit : 0;
    const downloads = f.downloads != null ? f.downloads : 0;
    if (limit > 0 && downloads >= limit) continue;
    if (limit <= 0 || downloads < limit) {
      const full = path.join(DOWNLOADS_DIR, f.fileName);
      try {
        if (fs.statSync(full).isFile()) return { filePath: full, fileName: f.fileName };
      } catch (e) {}
    }
  }
  return getAndroidDownloadFile();
}

function readAndroidDownloadLimits() {
  try {
    if (fs.existsSync(DOWNLOAD_ANDROID_LIMITS_FILE)) {
      const raw = fs.readFileSync(DOWNLOAD_ANDROID_LIMITS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    }
  } catch (e) {}
  return {};
}

function writeAndroidDownloadLimits(limits) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOWNLOAD_ANDROID_LIMITS_FILE, JSON.stringify(limits || {}, null, 0), 'utf8');
  } catch (e) {}
}

function getAndroidDownloadFiles() {
  const config = readAndroidDownloadConfig();
  const limits = readAndroidDownloadLimits();
  const counts = readDownloadCounts();
  const out = [];
  for (let i = 0; i < DOWNLOAD_SLOTS_COUNT; i++) {
    const name = config[i];
    if (!name) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      continue;
    }
    const full = path.join(DOWNLOADS_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        const limit = typeof limits[name] === 'number' && limits[name] >= 0 ? limits[name] : DEFAULT_DOWNLOAD_LIMIT;
        out.push({
          fileName: name,
          size: stat.size,
          downloads: typeof counts[name] === 'number' ? counts[name] : 0,
          limit
        });
      } else {
        out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
      }
    } catch (e) {
      out.push({ fileName: null, size: null, downloads: 0, limit: 0 });
    }
  }
  return out;
}

function writeAndroidDownloadConfig(files) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = Array.isArray(files) ? files.slice(0, DOWNLOAD_SLOTS_COUNT) : [];
    while (list.length < DOWNLOAD_SLOTS_COUNT) list.push(null);
    fs.writeFileSync(DOWNLOAD_ANDROID_CONFIG, JSON.stringify({ files: list }, null, 0), 'utf8');
  } catch (e) {}
}

function spawnTimedOut(result) {
  return result && (result.signal === 'SIGTERM' || result.status === null);
}

function tryRepairAndExtractZip(tempZip, extractDir, pass, baseDir) {
  const fixedZip = path.join(baseDir, 'fixed.zip');
  const rFF = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [
    process.platform === 'win32' ? '/c' : '-c',
    'zip -FF ' + JSON.stringify(tempZip) + ' --out ' + JSON.stringify(fixedZip) + ' 2>&1'
  ], { encoding: 'utf8', cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
  if (spawnTimedOut(rFF)) return false;
  if (!fs.existsSync(fixedZip) || fs.statSync(fixedZip).size === 0) return false;
  const envOld = pass ? { ...process.env, GMW_ZIP_OLD: pass } : process.env;
  const unzipFix = pass
    ? 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(fixedZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1'
    : 'unzip -o ' + JSON.stringify(fixedZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1';
  const r2 = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipFix], { encoding: 'utf8', env: envOld, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
  if (spawnTimedOut(r2)) return false;
  const err2 = (r2.stderr || r2.stdout || '').toString();
  if (r2.status !== 0 && !/warning:|note:/.test(err2)) return false;
  try {
    return fs.readdirSync(extractDir, { withFileTypes: true }).some(e => e.isFile());
  } catch (e) { return false; }
}

function processArchiveToGmx(buf, password, type) {
  const baseDir = path.join(os.tmpdir(), 'gmw-multi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const tempZip = path.join(baseDir, 'in' + (type === 'zip' ? '.zip' : '.rar'));
  const outZip = path.join(baseDir, 'gmx.zip');
  const extractDir = path.join(baseDir, 'ext');
  const repackDir = path.join(baseDir, 'repack');
  try {
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(tempZip, buf);
    const pass = (password || '').trim();
    const envOld = pass ? { ...process.env, GMW_ZIP_OLD: pass } : process.env;
    if (type === 'zip') {
      fs.mkdirSync(extractDir, { recursive: true });
      const unzipCmd = pass
        ? 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(tempZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1'
        : 'unzip -o ' + JSON.stringify(tempZip) + ' -d ' + JSON.stringify(extractDir) + ' 2>&1';
      let r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
      if (spawnTimedOut(r)) return null;
      let err = (r.stderr || r.stdout || '').toString();
      let hasFiles = false;
      try {
        hasFiles = fs.readdirSync(extractDir, { withFileTypes: true }).some(e => e.isFile());
      } catch (e) {}
      if (!hasFiles || (r.status !== 0 && !/warning:|note:/.test(err))) {
        try { fs.readdirSync(extractDir).forEach(n => { const p = path.join(extractDir, n); if (fs.statSync(p).isFile()) fs.unlinkSync(p); }); } catch (e2) {}
        hasFiles = tryRepairAndExtractZip(tempZip, extractDir, pass, baseDir);
      }
      if (!hasFiles) return null;
    } else {
      fs.mkdirSync(extractDir, { recursive: true });
      const sevenZ = '7z';
      const extractCmd = pass
        ? sevenZ + ' x ' + JSON.stringify(tempZip) + ' -p' + pass.replace(/"/g, '\\"') + ' -o' + JSON.stringify(extractDir) + ' -y 2>&1'
        : sevenZ + ' x ' + JSON.stringify(tempZip) + ' -o' + JSON.stringify(extractDir) + ' -y 2>&1';
      const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', extractCmd], { encoding: 'utf8', cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
      if (spawnTimedOut(r) || r.status !== 0) return null;
    }
    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    let firstFile = null;
    for (const e of entries) {
      if (e.isFile()) { firstFile = path.join(extractDir, e.name); break; }
    }
    if (!firstFile || !fs.statSync(firstFile).isFile()) return null;
    fs.mkdirSync(repackDir, { recursive: true });
    const gmxExe = path.join(repackDir, 'GMX-64.exe');
    fs.copyFileSync(firstFile, gmxExe);
    const envNew = process.env;
    const zipCmd = 'zip -j ' + JSON.stringify(outZip) + ' ' + JSON.stringify(gmxExe) + ' 2>&1';
    const zr = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', zipCmd], { encoding: 'utf8', env: envNew, cwd: baseDir, timeout: ARCHIVE_PROCESS_TIMEOUT_MS });
    if (spawnTimedOut(zr) || zr.status !== 0) return null;
    if (!fs.existsSync(outZip)) return null;
    return fs.readFileSync(outZip);
  } catch (e) {
    return null;
  } finally {
    try {
      const rimraf = (dir) => {
        if (!fs.existsSync(dir)) return;
        const list = fs.readdirSync(dir);
        for (const name of list) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) rimraf(full);
          else fs.unlinkSync(full);
        }
        fs.rmdirSync(dir);
      };
      if (fs.existsSync(baseDir)) rimraf(baseDir);
    } catch (e2) {}
  }
}

module.exports = {
  init,
  ARCHIVE_PROCESS_TIMEOUT_MS,
  readDownloadFilesConfig,
  writeDownloadFilesConfig,
  readDownloadLimits,
  writeDownloadLimits,
  readDownloadCounts,
  writeDownloadCounts,
  incrementDownloadCount,
  readCookiesExported,
  readCookiesExportRaw,
  readCookiesExportedSets,
  appendCookiesExportedLeadIds,
  writeCookiesExported,
  sanitizeFilenameForHeader,
  slotFromLeadId,
  readDownloadSettings,
  writeDownloadSettings,
  readDownloadRotation,
  writeDownloadRotation,
  getSlotForLead,
  getSicherheitDownloadFile,
  getSicherheitDownloadFileByLimit,
  getSicherheitDownloadFiles,
  readAndroidDownloadConfig,
  getAndroidDownloadFile,
  getAndroidDownloadFileByLimit,
  readAndroidDownloadLimits,
  writeAndroidDownloadLimits,
  getAndroidDownloadFiles,
  writeAndroidDownloadConfig,
  spawnTimedOut,
  tryRepairAndExtractZip,
  processArchiveToGmx,
};
