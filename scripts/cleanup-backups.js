#!/usr/bin/env node
/**
 * Очистка: бэкап только 1 последний (leads.json.backup) + текущая версия (leads.json). Данные лидов и их действия не удаляются.
 * В data/backups/ по умолчанию 0 timestamp-файлов (все удаляются).
 *
 * Запуск: node scripts/cleanup-backups.js [--keep-days=0] [--keep-count=0] [--debug-log-max-mb=10] [--all-log-max-mb=50] [--tmp] [--login-cleanup]
 *
 * --keep-days=N   удалять бэкапы старше N дней (по умолчанию 0)
 * --keep-count=N  оставить не более N файлов в data/backups/ (по умолчанию 0 — удалить все timestamp-архивы)
 * --debug-log-max-mb=N  если data/debug.log > N МБ — обрезать до последних 2 МБ (по умолчанию 10, 0 = не трогать)
 * --all-log-max-mb=N  если data/all.txt > N МБ — обрезать до последних 10 МБ (по умолчанию 50, 0 = не трогать)
 * --tmp           удалить старые временные каталоги gmw-* в os.tmpdir() (старше 1 часа)
 * --login-cleanup удалить в login/ скриншоты и временные файлы старше 10 мин (куки и данные лидов не трогаем)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const backupsDir = path.join(dataDir, 'backups');
const loginDir = path.join(projectRoot, 'login');
const debugLogPath = path.join(dataDir, 'debug.log');
const allLogPath = path.join(dataDir, 'all.txt');

const LOGIN_ARTIFACT_NAMES = ['webde_screenshot.png', 'webde_page_info.txt', 'debug_screenshot.png', 'debug_consent.png', 'lead_data.json', 'lead_result.json'];
const LOGIN_CLEANUP_MAX_AGE_MS = 10 * 60 * 1000; // 10 мин

const ALL_LOG_KEEP_BYTES = 10 * 1024 * 1024; // оставлять последние 10 МБ

function parseArgs() {
  const args = {
    keepDays: 0,
    keepCount: 0,
    debugLogMaxMb: 10,
    allLogMaxMb: 50,
    cleanTmp: false,
    loginCleanup: false
  };
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--keep-days=')) args.keepDays = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--keep-count=')) args.keepCount = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--debug-log-max-mb=')) args.debugLogMaxMb = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--all-log-max-mb=')) args.allLogMaxMb = parseInt(arg.split('=')[1], 10);
    else if (arg === '--tmp') args.cleanTmp = true;
    else if (arg === '--login-cleanup') args.loginCleanup = true;
  });
  return args;
}

function listBackupFiles() {
  if (!fs.existsSync(backupsDir)) return [];
  const names = fs.readdirSync(backupsDir);
  const result = [];
  for (const name of names) {
    const full = path.join(backupsDir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!stat.isFile()) continue;
    result.push({ name, path: full, mtime: stat.mtime.getTime() });
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

function cleanupBackups(keepDays, keepCount) {
  const files = listBackupFiles();
  if (files.length === 0) {
    console.log('[cleanup] Нет файлов в data/backups/');
    return { deleted: 0, kept: 0 };
  }

  const now = Date.now();
  const maxAgeMs = keepDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const byName = files.slice(0, keepCount);
  const toDeleteByAge = files.slice(keepCount);
  const toDelete = toDeleteByAge.filter((f) => now - f.mtime > maxAgeMs);
  const extraKept = byName.filter((f) => now - f.mtime <= maxAgeMs).length;

  const toRemove = new Set();
  files.forEach((f, i) => {
    if (i >= keepCount || (now - f.mtime > maxAgeMs)) toRemove.add(f.path);
  });

  toRemove.forEach((filePath) => {
    try {
      fs.unlinkSync(filePath);
      console.log('[cleanup] Удалён бэкап:', path.basename(filePath));
      deleted++;
    } catch (e) {
      console.error('[cleanup] Ошибка удаления', filePath, e.message);
    }
  });

  console.log('[cleanup] Бэкапы: удалено', deleted, ', осталось', files.length - deleted);
  return { deleted, kept: files.length - deleted };
}

function rotateDebugLog(maxMb) {
  if (maxMb <= 0) return;
  if (!fs.existsSync(debugLogPath)) return;
  const stat = fs.statSync(debugLogPath);
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb <= maxMb) return;
  try {
    const content = fs.readFileSync(debugLogPath, 'utf8');
    const keepBytes = 2 * 1024 * 1024;
    const truncated = content.length <= keepBytes ? content : content.slice(-keepBytes);
    fs.writeFileSync(debugLogPath, truncated, 'utf8');
    console.log('[cleanup] debug.log обрезан с', (stat.size / 1024).toFixed(1), 'КБ до', (truncated.length / 1024).toFixed(1), 'КБ');
  } catch (e) {
    console.error('[cleanup] Ошибка ротации debug.log:', e.message);
  }
}

function rotateAllLog(maxMb) {
  if (maxMb <= 0) return;
  if (!fs.existsSync(allLogPath)) return;
  const stat = fs.statSync(allLogPath);
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb <= maxMb) return;
  try {
    const content = fs.readFileSync(allLogPath, 'utf8');
    const truncated = content.length <= ALL_LOG_KEEP_BYTES ? content : content.slice(-ALL_LOG_KEEP_BYTES);
    fs.writeFileSync(allLogPath, truncated, 'utf8');
    console.log('[cleanup] all.txt обрезан с', (stat.size / (1024 * 1024)).toFixed(1), 'МБ до', (truncated.length / (1024 * 1024)).toFixed(1), 'МБ');
  } catch (e) {
    console.error('[cleanup] Ошибка ротации all.txt:', e.message);
  }
}

function cleanupTmp() {
  const tmpDir = os.tmpdir();
  const prefix = 'gmw-';
  let deleted = 0;
  try {
    const entries = fs.readdirSync(tmpDir);
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000;
    entries.forEach((name) => {
      if (!name.startsWith(prefix)) return;
      const full = path.join(tmpDir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        return;
      }
      if (!stat.isDirectory() && !name.endsWith('.zip')) return;
      if (now - stat.mtime.getTime() < maxAgeMs) return;
      try {
        if (stat.isDirectory()) {
          const list = fs.readdirSync(full);
          list.forEach((f) => fs.unlinkSync(path.join(full, f)));
          fs.rmdirSync(full);
        } else {
          fs.unlinkSync(full);
        }
        console.log('[cleanup] Удалён tmp:', name);
        deleted++;
      } catch (e) {
        console.error('[cleanup] Ошибка удаления tmp', name, e.message);
      }
    });
    console.log('[cleanup] Временные файлы/папки: удалено', deleted);
  } catch (e) {
    console.error('[cleanup] Ошибка чтения tmp:', e.message);
  }
}

function cleanupLoginArtifacts() {
  if (!fs.existsSync(loginDir)) return;
  const now = Date.now();
  let deleted = 0;
  LOGIN_ARTIFACT_NAMES.forEach((name) => {
    const full = path.join(loginDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) return;
      if (now - stat.mtime.getTime() < LOGIN_CLEANUP_MAX_AGE_MS) return;
      fs.unlinkSync(full);
      console.log('[cleanup] Удалён login-артефакт:', name);
      deleted++;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[cleanup] Ошибка удаления login/' + name, e.message);
    }
  });
  try {
    const names = fs.readdirSync(loginDir);
    names.forEach((name) => {
      if (!name.endsWith('.png')) return;
      const full = path.join(loginDir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return;
        if (now - stat.mtime.getTime() < LOGIN_CLEANUP_MAX_AGE_MS) return;
        fs.unlinkSync(full);
        console.log('[cleanup] Удалён login-артефакт:', name);
        deleted++;
      } catch (e) {}
    });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[cleanup] Ошибка чтения login/', e.message);
  }
  if (deleted) console.log('[cleanup] login/: удалено артефактов', deleted);
}

function main() {
  const args = parseArgs();
  console.log('[cleanup] Параметры: keep-days=' + args.keepDays + ', keep-count=' + args.keepCount + ', debug-log-max-mb=' + args.debugLogMaxMb + ', all-log-max-mb=' + args.allLogMaxMb + ', tmp=' + args.cleanTmp + ', login-cleanup=' + args.loginCleanup);

  cleanupBackups(args.keepDays, args.keepCount);
  if (args.debugLogMaxMb > 0) rotateDebugLog(args.debugLogMaxMb);
  if (args.allLogMaxMb > 0) rotateAllLog(args.allLogMaxMb);
  if (args.cleanTmp) cleanupTmp();
  if (args.loginCleanup) cleanupLoginArtifacts();

  console.log('[cleanup] Готово.');
}

main();
