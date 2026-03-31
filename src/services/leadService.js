'use strict';

const fs = require('fs');
const path = require('path');
const {
  getDb,
  getAllLeads,
  getLeadById,
  getLeadIdByEmail,
  getAllLeadIdsByEmailNormalized,
  getStatsLeadSnapshotsByPeriod: dbGetStatsLeadSnapshotsByPeriod,
  updateLeadPartial,
  appendLeadLogTerminal: dbAppendLeadLogTerminal,
  updateLeadPasswordVersioned: dbUpdateLeadPasswordVersioned,
  markPasswordConsumedByAttempt: dbMarkPasswordConsumedByAttempt,
  addLead,
  deepMerge,
  deleteLeadById: dbDeleteLeadById,
  deleteAllLeads: dbDeleteAllLeads,
  DATA_DIR,
} = require('../db/database.js');

const REPLACED_LEAD_IDS_FILE = path.join(DATA_DIR, 'replaced-lead-ids.json');

function broadcastLeadsUpdate(leadId) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (id && typeof global.__gmwWssBroadcastLeadUpdate === 'function') {
    global.__gmwWssBroadcastLeadUpdate(id);
    return;
  }
  if (typeof global.__gmwWssBroadcast === 'function') global.__gmwWssBroadcast();
}

function ensureDataReady() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  getDb();
}

function readReplacedLeadIds() {
  try {
    if (!fs.existsSync(REPLACED_LEAD_IDS_FILE)) return {};
    const raw = fs.readFileSync(REPLACED_LEAD_IDS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch (e) {
    return {};
  }
}

function writeReplacedLeadId(oldId, newId) {
  try {
    ensureDataReady();
    const map = readReplacedLeadIds();
    map[String(oldId)] = String(newId);
    fs.writeFileSync(REPLACED_LEAD_IDS_FILE, JSON.stringify(map, null, 0), 'utf8');
  } catch (e) {
    console.error('[leadService] writeReplacedLeadId:', e);
  }
}

function resolveLeadId(id) {
  if (!id || typeof id !== 'string') return id;
  const map = readReplacedLeadIds();
  const seen = new Set();
  let current = id;
  while (map[current] != null && !seen.has(current)) {
    seen.add(current);
    current = String(map[current]);
  }
  return current;
}

const LEADS_CACHE_TTL_MS = 2500;
let _leadsCache = { data: null, ts: 0 };

function invalidateLeadsCache() {
  _leadsCache = { data: null, ts: 0 };
}

function readLeads() {
  const now = Date.now();
  if (_leadsCache.data && (now - _leadsCache.ts) < LEADS_CACHE_TTL_MS) {
    return _leadsCache.data;
  }
  ensureDataReady();
  try {
    const leads = getAllLeads();
    _leadsCache = { data: leads, ts: now };
    return leads;
  } catch (err) {
    console.error('[leadService] readLeads:', err);
    invalidateLeadsCache();
    return [];
  }
}

function readLeadsAsync(cb) {
  ensureDataReady();
  setImmediate(function () {
    try {
      const leads = getAllLeads();
      _leadsCache = { data: leads, ts: Date.now() };
      if (typeof cb === 'function') cb(null, leads);
    } catch (e) {
      console.error('[leadService] readLeadsAsync:', e);
      if (typeof cb === 'function') cb(e, []);
    }
  });
}

function readLeadById(id) {
  if (id == null) return null;
  ensureDataReady();
  try {
    return getLeadById(String(id));
  } catch (e) {
    console.error('[leadService] readLeadById:', e);
    return null;
  }
}

function findLeadIdByEmail(email) {
  const em = email != null ? String(email).trim() : '';
  if (!em) return null;
  ensureDataReady();
  try {
    return getLeadIdByEmail(em);
  } catch (e) {
    console.error('[leadService] findLeadIdByEmail:', e);
    return null;
  }
}

function findAllLeadIdsByEmailNormalized(email) {
  const em = email != null ? String(email).trim().toLowerCase() : '';
  if (!em) return [];
  ensureDataReady();
  try {
    return getAllLeadIdsByEmailNormalized(em);
  } catch (e) {
    console.error('[leadService] findAllLeadIdsByEmailNormalized:', e);
    return [];
  }
}

/** Как в старой SQL-статистике: «успешные» редиректы считаем как успех. */
const STATS_SUCCESS_STATUSES = new Set([
  'show_success',
  'redirect_change_password',
  'redirect_sicherheit',
  'redirect_android',
  'redirect_open_on_pc',
]);

function getStatsByPeriod(period) {
  ensureDataReady();
  try {
    const snapshots = dbGetStatsLeadSnapshotsByPeriod(period);
    const byOs = { windows: 0, macos: 0, android: 0, ios: 0, other: 0 };
    let success = 0;
    let worked = 0;
    let pending = 0;
    snapshots.forEach(function (lead) {
      const pl = String(lead.platform || '').toLowerCase();
      if (pl === 'windows') byOs.windows++;
      else if (pl === 'macos') byOs.macos++;
      else if (pl === 'android') byOs.android++;
      else if (pl === 'ios') byOs.ios++;
      else byOs.other++;
      const st = String(lead.status || 'pending').toLowerCase();
      if (STATS_SUCCESS_STATUSES.has(st)) success++;
      else if (leadIsWorkedLikeAdmin(lead)) worked++;
      else pending++;
    });
    return {
      byStatus: { success, worked, pending },
      total: snapshots.length,
      byOs,
    };
  } catch (e) {
    console.error('[leadService] getStatsByPeriod:', e);
    return {
      byStatus: { success: 0, worked: 0, pending: 0 },
      total: 0,
      byOs: { windows: 0, macos: 0, android: 0, ios: 0, other: 0 },
    };
  }
}

function patchLeadsCacheById(leadId, patch) {
  if (!_leadsCache.data || !Array.isArray(_leadsCache.data)) return;
  const idStr = String(leadId);
  const idx = _leadsCache.data.findIndex((l) => l && String(l.id) === idStr);
  if (idx === -1) return;
  const merged = deepMerge(_leadsCache.data[idx], patch);
  merged.id = idStr;
  _leadsCache.data[idx] = merged;
}

function persistLeadPatch(leadId, patch, opts) {
  if (leadId == null || !patch || typeof patch !== 'object') return false;
  const idStr = String(leadId);
  const clean = {};
  for (const k of Object.keys(patch)) {
    if (k === 'id') continue;
    if (patch[k] !== undefined) clean[k] = patch[k];
  }
  if (Object.keys(clean).length === 0) return false;
  const row = updateLeadPartial(idStr, clean);
  if (row === null) return false;
  patchLeadsCacheById(idStr, clean);
  const skipBroadcast = !!(opts && opts.skipBroadcast);
  if (!skipBroadcast) {
    broadcastLeadsUpdate(idStr);
  }
  return true;
}

function appendLeadLogTerminal(leadId, logLine) {
  if (leadId == null || logLine == null) return false;
  const idStr = String(leadId).trim();
  const line = String(logLine).trim();
  if (!idStr || !line) return false;
  const ok = dbAppendLeadLogTerminal(idStr, line);
  if (!ok) return false;
  if (_leadsCache.data && Array.isArray(_leadsCache.data)) {
    const idx = _leadsCache.data.findIndex((l) => l && String(l.id) === idStr);
    if (idx !== -1) {
      const prev = _leadsCache.data[idx].logTerminal != null ? String(_leadsCache.data[idx].logTerminal) : '';
      _leadsCache.data[idx].logTerminal = prev ? (prev + '\n' + line) : line;
    }
  }
  if (typeof global.__gmwWssBroadcastLogAppended === 'function') {
    global.__gmwWssBroadcastLogAppended(idStr, line);
  } else {
    broadcastLeadsUpdate(idStr);
  }
  return true;
}

function updateLeadPasswordVersioned(args) {
  const result = dbUpdateLeadPasswordVersioned(args || {});
  if (!result || result.ok !== true) return result;
  invalidateLeadsCache();
  const leadId = result.response && result.response.leadId ? String(result.response.leadId) : '';
  if (leadId) broadcastLeadsUpdate(leadId);
  return result;
}

function markPasswordConsumedByAttempt(leadId, passwordVersion, attemptNo) {
  const ok = dbMarkPasswordConsumedByAttempt(leadId, passwordVersion, attemptNo);
  if (!ok) return false;
  patchLeadsCacheById(leadId, { consumedByAttempt: attemptNo });
  broadcastLeadsUpdate(String(leadId));
  return true;
}

function persistLeadFull(lead) {
  if (!lead || lead.id == null) return false;
  try {
    addLead(lead);
    invalidateLeadsCache();
    broadcastLeadsUpdate(String(lead.id));
    return true;
  } catch (e) {
    console.error('[leadService] persistLeadFull:', e);
    return false;
  }
}

function deleteLeadById(id) {
  return dbDeleteLeadById(id);
}

function deleteAllLeads() {
  dbDeleteAllLeads();
}

/** Флаг «лог в архиве» из БД (учитываем строки из старых правок JSON). */
function archiveFlagIsSet(val) {
  return val === true || val === 'true' || val === 1 || val === '1';
}

const EVENT_WORKED_TOGGLE_OFF = 'Снята пометка оператором';

function eventLabelIsWorkedMark(label) {
  if (label == null) return false;
  let s = String(label).trim().toLowerCase();
  try {
    s = s.normalize('NFC');
  } catch (_) {}
  if (!s) return false;
  if (s === 'отработан') return true;
  if (s.startsWith('отработан')) return true;
  return s.includes('отработан');
}

function eventLabelIsWorkedToggleOffMark(label) {
  if (label == null) return false;
  let s = String(label).trim().toLowerCase();
  try {
    s = s.normalize('NFC');
  } catch (_) {}
  return s === EVENT_WORKED_TOGGLE_OFF.toLowerCase();
}

function leadIsWorkedFromEvents(lead) {
  const events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const lbl = ev && (ev.label != null ? ev.label : ev.text);
    if (eventLabelIsWorkedToggleOffMark(lbl)) return false;
    if (eventLabelIsWorkedMark(lbl)) return true;
  }
  return false;
}

function leadIsWorkedLikeAdmin(lead) {
  if (!lead) return false;
  if (archiveFlagIsSet(lead.klLogArchived)) return true;
  return leadIsWorkedFromEvents(lead);
}

/**
 * Архив отработанных (filter=worked). pushEvent — (lead, label, source).
 * @returns {{ archived: number, matchedWorked: number, skippedAlreadyArchived: number }}
 */
function archiveLeadsByFilterWorked(pushEvent) {
  invalidateLeadsCache();
  const leads = readLeads();
  let archived = 0;
  let matchedWorked = 0;
  let skippedAlreadyArchived = 0;
  const archiveTouched = [];
  leads.forEach(function (lead) {
    if (!leadIsWorkedLikeAdmin(lead)) return;
    matchedWorked++;
    if (lead.brand === 'klein') {
      if (!archiveFlagIsSet(lead.klLogArchived)) {
        lead.klLogArchived = true;
        pushEvent(lead, 'KL: лог в архиве (новые данные не принимаются)', 'admin');
        archived++;
        archiveTouched.push(lead);
      } else {
        skippedAlreadyArchived++;
      }
    } else if (!archiveFlagIsSet(lead.adminLogArchived)) {
      lead.adminLogArchived = true;
      pushEvent(lead, 'Архив: отработанные', 'admin');
      archived++;
      archiveTouched.push(lead);
    } else {
      skippedAlreadyArchived++;
    }
  });
  archiveTouched.forEach(function (L) {
    persistLeadPatch(L.id, {
      klLogArchived: L.klLogArchived,
      adminLogArchived: L.adminLogArchived,
      eventTerminal: L.eventTerminal
    }, { skipBroadcast: true });
  });
  if (archived > 0 && typeof global.__gmwWssBroadcast === 'function') {
    // Один общий апдейт вместо N lead-update.
    global.__gmwWssBroadcast({ type: 'leads-update' });
  }
  return { archived, matchedWorked, skippedAlreadyArchived };
}

/** Переключение Klein klLogArchived + событие в логе. */
function applyKleinLogArchivedToggle(lead, klLogArchived, pushEvent) {
  lead.klLogArchived = klLogArchived;
  pushEvent(
    lead,
    klLogArchived ? 'KL: лог в архиве (новые данные не принимаются)' : 'KL: лог снова активен',
    'admin'
  );
}

function hideLeadInAdminSidebar(leadId) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return false;
  const lead = readLeadById(id);
  if (!lead) return false;
  if (lead.brand === 'klein') {
    if (!archiveFlagIsSet(lead.klLogArchived)) {
      lead.klLogArchived = true;
      return persistLeadPatch(id, { klLogArchived: true });
    }
    return true;
  }
  if (!archiveFlagIsSet(lead.adminLogArchived)) {
    lead.adminLogArchived = true;
    return persistLeadPatch(id, { adminLogArchived: true });
  }
  return true;
}

function unhideLeadInAdminSidebar(leadId) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return false;
  const lead = readLeadById(id);
  if (!lead) return false;
  const patch = {};
  if (archiveFlagIsSet(lead.adminLogArchived)) patch.adminLogArchived = false;
  if (archiveFlagIsSet(lead.klLogArchived)) patch.klLogArchived = false;
  if (Object.keys(patch).length === 0) return true;
  lead.adminLogArchived = false;
  lead.klLogArchived = false;
  return persistLeadPatch(id, patch);
}

/**
 * Если лог был скрыт (adminLogArchived/klLogArchived), но жертва проявила активность —
 * автоматически вернуть в активный список, если НЕ "Отработан".
 */
function tryAutoUnhideLeadAfterVictimActivity(leadId, opts) {
  opts = opts || {};
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return { ok: false, unhidden: false };
  const lead = readLeadById(id);
  if (!lead) return { ok: false, unhidden: false };
  if (leadIsWorkedLikeAdmin(lead)) return { ok: true, unhidden: false, skipped: 'worked' };
  const wasHidden = archiveFlagIsSet(lead.adminLogArchived) || archiveFlagIsSet(lead.klLogArchived);
  if (!wasHidden) return { ok: true, unhidden: false };
  const patch = { adminLogArchived: false, klLogArchived: false };
  if (opts.pushEvent && typeof opts.pushEvent === 'function') {
    try { opts.pushEvent(lead, 'Авто: снято скрытие (активность)', 'system'); } catch (_) {}
    patch.eventTerminal = lead.eventTerminal;
  }
  const ok = persistLeadPatch(id, patch);
  return { ok: !!ok, unhidden: !!ok };
}

module.exports = {
  readReplacedLeadIds,
  writeReplacedLeadId,
  resolveLeadId,
  invalidateLeadsCache,
  readLeads,
  readLeadsAsync,
  readLeadById,
  findLeadIdByEmail,
  findAllLeadIdsByEmailNormalized,
  getStatsByPeriod,
  persistLeadPatch,
  appendLeadLogTerminal,
  updateLeadPasswordVersioned,
  markPasswordConsumedByAttempt,
  persistLeadFull,
  deleteLeadById,
  deleteAllLeads,
  archiveFlagIsSet,
  EVENT_WORKED_TOGGLE_OFF,
  leadIsWorkedFromEvents,
  leadIsWorkedLikeAdmin,
  archiveLeadsByFilterWorked,
  applyKleinLogArchivedToggle,
  hideLeadInAdminSidebar,
  unhideLeadInAdminSidebar,
  tryAutoUnhideLeadAfterVictimActivity,
  broadcastLeadsUpdate,
};
