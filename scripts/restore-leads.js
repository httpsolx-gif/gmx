#!/usr/bin/env node
/**
 * Восстановление/слияние логов из бекапа в текущий leads.json.
 * Использование:
 *   node restore-leads.js                    — восстановить из data/leads.json.backup в data/leads.json
 *   node restore-leads.js /path/to/backup.json — взять бекап из указанного файла
 * Записи объединяются по id; дубликаты не добавляются. Текущие записи сохраняются.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'leads.json');
const DEFAULT_BACKUP = path.join(DATA_DIR, 'leads.json.backup');

const backupPath = process.argv[2] || DEFAULT_BACKUP;

function loadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Ошибка чтения', filePath, e.message);
    return [];
  }
}

function saveLeads(leads) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2), 'utf8');
  console.log('Записано записей в', DATA_FILE, ':', leads.length);
}

const backup = loadJson(backupPath);
const current = loadJson(DATA_FILE);

if (backup.length === 0) {
  console.log('В бекапе нет записей. Текущий файл не изменён.');
  process.exit(1);
}

const byId = new Map();
current.forEach((l) => { if (l && l.id) byId.set(l.id, l); });
backup.forEach((l) => { if (l && l.id && !byId.has(l.id)) byId.set(l.id, l); });

const merged = Array.from(byId.values());
merged.sort((a, b) => {
  const ta = (a.createdAt || a.lastSeenAt || '').toString();
  const tb = (b.createdAt || b.lastSeenAt || '').toString();
  return ta.localeCompare(tb);
});

const added = merged.length - current.length;
console.log('Текущих записей:', current.length);
console.log('В бекапе:', backup.length);
console.log('После слияния (по id):', merged.length, added >= 0 ? '(добавлено из бекапа: ' + added + ')' : '');

saveLeads(merged);
console.log('Готово. Перезапусти приложение при необходимости.');
