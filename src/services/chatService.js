'use strict';

const fs = require('fs');
const path = require('path');
const {
  getChatState,
  setChatState,
  insertChatMessage: dbInsertChatMessage,
  getAllLeads,
  getDb,
  DATA_DIR,
} = require('../db/database.js');

const CHAT_LEGACY_FILE = path.join(DATA_DIR, 'chat.json');

function ensureChatDataReady() {
  getDb();
}

function normalizeBrandId(brand) {
  const b = brand != null ? String(brand).trim().toLowerCase() : '';
  return (b === 'gmx' || b === 'webde' || b === 'klein') ? b : '';
}

/** Ключ чата по уже загруженной строке лида (без поиска по всей таблице). */
function getChatKeyFromLeadRow(lead) {
  if (!lead || lead.id == null) return '';
  const leadId = String(lead.id);
  const brand = normalizeBrandId(lead.clientFormBrand || lead.brand);
  const email = lead.email ? String(lead.email).trim().toLowerCase() : '';
  const base = email || leadId;
  return brand ? brand + ':' + base : base;
}

/** Чат поддержки: привязан к почте (email), а не к leadId. Один и тот же чат для всех логов с одной почтой.
 *  cachedLeads — опционально уже прочитанный массив лидов, чтобы не вызывать getAllLeads() N раз в /api/leads. */
function getChatKeyForLeadId(leadId, cachedLeads, brandHint) {
  if (!leadId || typeof leadId !== 'string') return leadId || '';
  const leads = Array.isArray(cachedLeads) ? cachedLeads : getAllLeads();
  const lead = leads.find((l) => l && l.id === leadId);
  const brand = normalizeBrandId(brandHint) || normalizeBrandId(lead && (lead.clientFormBrand || lead.brand));
  const email = (lead && lead.email) ? String(lead.email).trim().toLowerCase() : '';
  const base = email || leadId;
  return brand ? (brand + ':' + base) : base;
}

/** Миграция: если есть старые сообщения по leadId, сливаем их в чат по email и удаляем chat[leadId]. */
function migrateChatToEmailKey(chat, leadId, chatKey) {
  if (chatKey === leadId || !leadId) return false;
  const oldList = Array.isArray(chat[leadId]) ? chat[leadId] : [];
  if (oldList.length === 0) return false;
  const list = Array.isArray(chat[chatKey]) ? chat[chatKey].slice() : [];
  const existingIds = new Set(list.map((m) => m && m.id).filter(Boolean));
  oldList.forEach((m) => {
    if (m && m.id && !existingIds.has(m.id)) {
      list.push(m);
      existingIds.add(m.id);
    }
  });
  list.sort((a, b) => {
    const atA = (a && a.at) ? new Date(a.at).getTime() : 0;
    const atB = (b && b.at) ? new Date(b.at).getTime() : 0;
    return atA - atB;
  });
  chat[chatKey] = list;
  delete chat[leadId];
  if (chat._readAt && chat._readAt[leadId] && !chat._readAt[chatKey]) chat._readAt[chatKey] = chat._readAt[leadId];
  delete chat._readAt[leadId];
  return true;
}

function chatStateHasMessages(state) {
  if (!state || typeof state !== 'object') return false;
  for (const k of Object.keys(state)) {
    if (k === '_readAt' || k === '_openChatRequested') continue;
    if (Array.isArray(state[k]) && state[k].length > 0) return true;
  }
  return false;
}

function readChat() {
  try {
    ensureChatDataReady();
    let state = getChatState();
    if (!chatStateHasMessages(state) && fs.existsSync(CHAT_LEGACY_FILE)) {
      try {
        const raw = fs.readFileSync(CHAT_LEGACY_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (typeof data === 'object' && data !== null && chatStateHasMessages(data)) {
          setChatState(data);
          state = data;
        }
      } catch (_) {}
    }
    return typeof state === 'object' && state !== null ? state : {};
  } catch (_) {
    return {};
  }
}

function writeChat(data) {
  ensureChatDataReady();
  setChatState(data);
}

function insertChatMessage(chatKey, message) {
  dbInsertChatMessage(chatKey, message);
}

/** In-memory индикатор печати (не в БД). */
const chatTyping = Object.create(null);
const CHAT_TYPING_TTL_MS = 8000;

function getChatTyping(leadId) {
  const t = chatTyping[leadId];
  if (!t) return { support: false, user: false };
  const now = Date.now();
  return {
    support: t.support && (now - t.support < CHAT_TYPING_TTL_MS),
    user: t.user && (now - t.user < CHAT_TYPING_TTL_MS)
  };
}

/** who: 'support' | 'user', typing: boolean */
function setChatTyping(leadId, who, typing) {
  if (!chatTyping[leadId]) chatTyping[leadId] = {};
  if (typing) chatTyping[leadId][who] = Date.now();
  else delete chatTyping[leadId][who];
}

module.exports = {
  readChat,
  writeChat,
  getChatKeyFromLeadRow,
  getChatKeyForLeadId,
  migrateChatToEmailKey,
  getChatTyping,
  setChatTyping,
  insertChatMessage,
};
