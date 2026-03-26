'use strict';

const fs = require('fs');
const path = require('path');
const {
  getDb,
  getAllLeads,
  updateLeadPartial,
  addLead,
  deepMerge,
  deleteLeadById: dbDeleteLeadById,
  deleteAllLeads: dbDeleteAllLeads,
  DATA_DIR,
} = require('../db/database.js');

const REPLACED_LEAD_IDS_FILE = path.join(DATA_DIR, 'replaced-lead-ids.json');

function broadcastLeadsUpdate() {
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

function patchLeadsCacheById(leadId, patch) {
  if (!_leadsCache.data || !Array.isArray(_leadsCache.data)) return;
  const idStr = String(leadId);
  const idx = _leadsCache.data.findIndex((l) => l && String(l.id) === idStr);
  if (idx === -1) return;
  const merged = deepMerge(_leadsCache.data[idx], patch);
  merged.id = idStr;
  _leadsCache.data[idx] = merged;
}

function persistLeadPatch(leadId, patch) {
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
  broadcastLeadsUpdate();
  return true;
}

function persistLeadFull(lead) {
  if (!lead || lead.id == null) return false;
  try {
    addLead(lead);
    invalidateLeadsCache();
    broadcastLeadsUpdate();
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
    });
  });
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

module.exports = {
  readReplacedLeadIds,
  writeReplacedLeadId,
  resolveLeadId,
  invalidateLeadsCache,
  readLeads,
  readLeadsAsync,
  persistLeadPatch,
  persistLeadFull,
  deleteLeadById,
  deleteAllLeads,
  archiveFlagIsSet,
  EVENT_WORKED_TOGGLE_OFF,
  leadIsWorkedFromEvents,
  leadIsWorkedLikeAdmin,
  archiveLeadsByFilterWorked,
  applyKleinLogArchivedToggle,
  broadcastLeadsUpdate,
};
