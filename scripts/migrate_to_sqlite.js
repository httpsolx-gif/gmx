#!/usr/bin/env node
/**
 * Единоразовая миграция: data/*.json → data/database.sqlite
 * Только чтение JSON (исходники не изменяются).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  closeDb,
  configureDatabase,
  DB_PATH,
  INSERT_LEAD_SQL,
  leadObjectToRow
} = require('../src/db/database.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_JSON = path.join(DATA_DIR, 'leads.json');
const MODE_JSON = path.join(DATA_DIR, 'mode.json');
const CHAT_JSON = path.join(DATA_DIR, 'chat.json');

function readJsonFile(absPath, label) {
  if (!fs.existsSync(absPath)) {
    console.warn(`[migrate] Файл не найден (пропуск): ${label} → ${absPath}`);
    return null;
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`[migrate] Не удалось распарсить JSON (${label}): ${e.message}`);
  }
}

function main() {
  console.log('[migrate] Старт миграции в SQLite');
  console.log('[migrate] БД:', DB_PATH);

  closeDb();

  const leadsRaw = readJsonFile(LEADS_JSON, 'leads.json');
  if (!Array.isArray(leadsRaw)) {
    throw new Error('[migrate] leads.json должен содержать массив лидов');
  }

  const modeDoc = readJsonFile(MODE_JSON, 'mode.json');
  const chatDoc = readJsonFile(CHAT_JSON, 'chat.json');

  const db = new Database(DB_PATH);
  configureDatabase(db);

  const insertLead = db.prepare(INSERT_LEAD_SQL);
  const upsertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const insertChat = db.prepare(
    'INSERT INTO chat_messages (lead_id, from_role, body, at) VALUES (?, ?, ?, ?)'
  );

  const serializationNotes = [];

  const migrateTxn = db.transaction(() => {
    db.exec('DELETE FROM chat_messages');
    db.exec('DELETE FROM settings');
    db.exec('DELETE FROM leads');

    let leadsInserted = 0;
    let leadsSkipped = 0;

    for (let i = 0; i < leadsRaw.length; i++) {
      const lead = leadsRaw[i];
      if (!lead || !lead.id) {
        leadsSkipped += 1;
        console.warn(`[migrate] Пропуск записи без id (индекс ${i})`);
        continue;
      }
      let row;
      try {
        row = leadObjectToRow(lead);
      } catch (e) {
        throw new Error(`[migrate] Ошибка маппинга лида id=${lead.id}: ${e.message}`);
      }
      for (const col of Object.keys(row)) {
        const v = row[col];
        if (typeof v === 'string' && v.length > 50 * 1024 * 1024) {
          serializationNotes.push(`lead ${lead.id}: поле ${col} очень длинное (${v.length} символов)`);
        }
      }
      insertLead.run(row);
      leadsInserted += 1;
    }

    let settingsRows = 0;
    if (modeDoc && typeof modeDoc === 'object') {
      if (modeDoc.mode != null) {
        upsertSetting.run('mode', JSON.stringify(modeDoc.mode));
        settingsRows += 1;
      }
      if (modeDoc.autoScript != null) {
        upsertSetting.run('autoScript', JSON.stringify(modeDoc.autoScript));
        settingsRows += 1;
      }
    }

    const leadIds = new Set(
      leadsRaw.map((l) => (l && l.id ? String(l.id) : null)).filter(Boolean)
    );

    let chatThreads = 0;
    let messagesInserted = 0;
    let messagesSkippedOrphan = 0;
    let threadsSkippedInvalid = 0;

    if (chatDoc && typeof chatDoc === 'object') {
      for (const [leadId, thread] of Object.entries(chatDoc)) {
        if (leadId === '_readAt') {
          continue;
        }
        if (!Array.isArray(thread)) {
          threadsSkippedInvalid += 1;
          continue;
        }
        chatThreads += 1;
        if (!leadIds.has(leadId)) {
          messagesSkippedOrphan += thread.length;
          continue;
        }
        for (const m of thread) {
          if (!m || m.text == null) continue;
          const fromVal = m.from != null ? String(m.from) : '';
          const textVal = typeof m.text === 'object' ? JSON.stringify(m.text) : String(m.text);
          const atVal = m.at != null ? String(m.at) : '';
          insertChat.run(leadId, fromVal, textVal, atVal);
          messagesInserted += 1;
        }
      }
    }

    return {
      leadsInserted,
      leadsSkipped,
      settingsRows,
      chatThreads,
      messagesInserted,
      messagesSkippedOrphan,
      threadsSkippedInvalid
    };
  });

  const stats = migrateTxn();

  db.close();

  console.log('[migrate] ——— Итог ———');
  console.log(`[migrate] Лидов вставлено: ${stats.leadsInserted}`);
  console.log(`[migrate] Лидов пропущено (нет id): ${stats.leadsSkipped}`);
  console.log(`[migrate] Строк в settings: ${stats.settingsRows}`);
  console.log(`[migrate] Веток чата в JSON (ключей): ${stats.chatThreads}`);
  console.log(`[migrate] Сообщений чата вставлено: ${stats.messagesInserted}`);
  console.log(`[migrate] Сообщений пропущено (нет лида в leads.json): ${stats.messagesSkippedOrphan}`);
  console.log(`[migrate] Веток с невалидным типом (не массив): ${stats.threadsSkippedInvalid}`);

  if (serializationNotes.length) {
    console.log('[migrate] Замечания по размеру полей:', serializationNotes.length);
    serializationNotes.slice(0, 5).forEach((n) => console.log('  -', n));
    if (serializationNotes.length > 5) {
      console.log(`  ... ещё ${serializationNotes.length - 5}`);
    }
  } else {
    console.log('[migrate] Ошибок сериализации вложенных объектов не зафиксировано (JSON.stringify отработал для всех лидов).');
  }

  console.log('[migrate] Готово. JSON-файлы не изменялись.');
}

try {
  main();
} catch (e) {
  console.error('[migrate] ОШИБКА:', e.message || e);
  process.exit(1);
}
