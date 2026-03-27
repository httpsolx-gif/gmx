'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const { DATA_DIR } = require('../db/database');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DEFAULT_BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_BACKUP_RETENTION_DAYS = 7;
const DEFAULT_BACKUP_STARTUP_DELAY_MS = 5 * 60 * 1000;
const pipelineAsync = promisify(pipeline);

let started = false;
let backupInterval = null;
let firstBackupTimer = null;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function backupBaseName(now) {
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  return 'backup-' + y + '-' + m + '-' + d + '_' + hh + '-' + mm;
}

async function gzipFile(srcPath, destPath) {
  await pipelineAsync(
    fs.createReadStream(srcPath),
    zlib.createGzip(),
    fs.createWriteStream(destPath)
  );
}

async function createBackup(db) {
  if (!db) throw new Error('createBackup: db is required');
  ensureBackupDir();
  const base = backupBaseName(new Date());
  const gzPath = path.join(BACKUP_DIR, base + '.sqlite.gz');
  const tempDbPath = path.join(BACKUP_DIR, 'temp_' + Date.now() + '.sqlite');
  const escapedTempPath = tempDbPath.replace(/'/g, "''");

  console.log('[BACKUP] Начинаю создание резервной копии...');
  try {
    db.exec("VACUUM INTO '" + escapedTempPath + "'");
    await gzipFile(tempDbPath, gzPath);
    console.log('[BACKUP] Резервная копия успешно создана:', gzPath);
    return gzPath;
  } finally {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  }
}

async function cleanupOldBackups(retentionDays) {
  ensureBackupDir();
  const retentionMs = Math.max(1, Number(retentionDays) || DEFAULT_BACKUP_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  const files = await fs.promises.readdir(BACKUP_DIR);
  for (const file of files) {
    const fullPath = path.join(BACKUP_DIR, file);
    const isCompressedBackup = file.endsWith('.gz');
    const isDanglingSqlite = file.endsWith('.sqlite');
    if (!isCompressedBackup && !isDanglingSqlite) continue;
    let st;
    try {
      st = await fs.promises.stat(fullPath);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    if (isDanglingSqlite || (isCompressedBackup && (now - st.mtimeMs) > retentionMs)) {
      try {
        await fs.promises.unlink(fullPath);
        removed++;
      } catch (_) {}
    }
  }
  return removed;
}

async function runBackupCycle(db, retentionDays) {
  try {
    await cleanupOldBackups(retentionDays);
    await createBackup(db);
  } catch (e) {
    console.error('[BACKUP] Ошибка backup-цикла:', e && e.message ? e.message : e);
  }
}

function startAutoBackups(db) {
  if (!db || started) return;
  started = true;
  ensureBackupDir();

  const backupIntervalMs = Math.max(1000, parseInt(process.env.BACKUP_INTERVAL_MS, 10) || DEFAULT_BACKUP_INTERVAL_MS);
  const backupRetentionDays = Math.max(1, parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || DEFAULT_BACKUP_RETENTION_DAYS);
  const startupDelayMs = Math.max(0, parseInt(process.env.BACKUP_STARTUP_DELAY_MS, 10) || DEFAULT_BACKUP_STARTUP_DELAY_MS);

  console.log(
    '[BACKUP] Автобэкапы запущены: interval=' + backupIntervalMs +
    'ms, retention=' + backupRetentionDays + 'd, startupDelay=' + startupDelayMs + 'ms.'
  );

  firstBackupTimer = setTimeout(() => runBackupCycle(db, backupRetentionDays), startupDelayMs);
  if (typeof firstBackupTimer.unref === 'function') firstBackupTimer.unref();

  backupInterval = setInterval(() => runBackupCycle(db, backupRetentionDays), backupIntervalMs);
  if (typeof backupInterval.unref === 'function') backupInterval.unref();
}

module.exports = {
  BACKUP_DIR,
  createBackup,
  cleanupOldBackups,
  startAutoBackups,
};
