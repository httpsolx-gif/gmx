/**
 * Единый пул отпечатков для:
 * - Playwright автовхода WEB.DE (login/webde_login.py читает login/webde_fingerprints.json)
 * - Браузера: public/webde-fingerprints-pool.js (window.__GMW_FP_PRESETS)
 *
 * Внимание: в репозитории может быть курируемый короткий пул — этот скрипт перезапишет JSON на 100 синтетических.
 * Запуск: node scripts/build-webde-fingerprints.mjs
 * Немецкие Win + Chrome (лиды + синтетика): node scripts/build-webde-fingerprints-de-win11.mjs
 * Все профили — десктоп Chromium (Chrome/Edge), реалистично для web.de.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const JSON_OUT = path.join(ROOT, 'login', 'webde_fingerprints.json');
const JS_OUT = path.join(ROOT, 'public', 'webde-fingerprints-pool.js');

const CHROME_MINOR = '140.0.7338';
/** Версия Edge в UA (отдельно от Chrome token) */
function edgeToken(patch) {
  return `140.0.${3290 + (patch % 120)}.${10 + (patch % 89)}`;
}

/** @type {Array<{locale:string,timezoneId:string,acceptLanguage:string,language:string,languages:string[]}>} */
const LOCALES = [
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8', language: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  { locale: 'de-AT', timezoneId: 'Europe/Vienna', acceptLanguage: 'de-AT,de;q=0.9,en;q=0.8', language: 'de-AT', languages: ['de-AT', 'de', 'en-US', 'en'] },
  { locale: 'de-CH', timezoneId: 'Europe/Zurich', acceptLanguage: 'de-CH,de;q=0.9,fr;q=0.8,it;q=0.7,en;q=0.6', language: 'de-CH', languages: ['de-CH', 'de', 'fr', 'it', 'en'] },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en-GB;q=0.8,en;q=0.7', language: 'de-DE', languages: ['de-DE', 'de', 'en-GB', 'en'] },
  { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', acceptLanguage: 'nl-NL,nl;q=0.9,de;q=0.8,en;q=0.7', language: 'nl-NL', languages: ['nl-NL', 'nl', 'de', 'en'] },
  { locale: 'pl-PL', timezoneId: 'Europe/Warsaw', acceptLanguage: 'pl-PL,pl;q=0.9,en;q=0.8', language: 'pl-PL', languages: ['pl-PL', 'pl', 'en'] },
  { locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptLanguage: 'fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7', language: 'fr-FR', languages: ['fr-FR', 'fr', 'de', 'en'] },
  { locale: 'en-GB', timezoneId: 'Europe/London', acceptLanguage: 'en-GB,en;q=0.9,de;q=0.8', language: 'en-GB', languages: ['en-GB', 'en', 'de'] },
];

const VIEWPORTS = [
  [1920, 1080], [1366, 768], [1536, 864], [2560, 1440], [3440, 1440], [3840, 2160],
  [1680, 1050], [1440, 900], [1920, 1200], [1280, 800], [1600, 900], [1280, 720],
  [1280, 1024], [1728, 1117], [1512, 982], [1650, 1050], [2560, 1080], [2048, 1152],
  [1920, 1200], [1440, 960], [1680, 1050], [2560, 1600], [3024, 1964], [1920, 1080],
  [1360, 768], [1600, 1024], [1280, 1024], [3440, 1440], [5120, 1440],
];

const HW_MEM = [
  [4, 4], [4, 8], [6, 8], [8, 8], [8, 16], [12, 16], [16, 16], [16, 32], [12, 8], [6, 4],
];

const DPR = [1, 1, 1, 1.25, 1.5, 2];

function tzOffsetMinutes(timezoneId) {
  const m = {
    'Europe/Berlin': -60,
    'Europe/Vienna': -60,
    'Europe/Zurich': -60,
    'Europe/Amsterdam': -60,
    'Europe/Warsaw': -60,
    'Europe/Paris': -60,
    'Europe/London': 0,
  };
  return m[timezoneId] ?? -60;
}

function uaWinChrome(patch) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MINOR}.${patch} Safari/537.36`;
}
function uaWinEdge(patch) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MINOR}.${patch} Safari/537.36 Edg/${edgeToken(patch)}`;
}
function uaMacChrome(osx, patch) {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${osx}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MINOR}.${patch} Safari/537.36`;
}
function uaLinuxChrome(patch) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MINOR}.${patch} Safari/537.36`;
}

const OSX_VARIANTS = ['10_15_7', '14_7_1', '15_2_0'];

function buildEntry(i) {
  const loc = LOCALES[i % LOCALES.length];
  const [vw, vh] = VIEWPORTS[i % VIEWPORTS.length];
  const [hw, mem] = HW_MEM[i % HW_MEM.length];
  const dpr = DPR[i % DPR.length];
  const patch = 100 + (i % 50);
  const isEdge = i % 7 === 0;
  const isMac = i % 5 === 1;
  const isLinux = i % 11 === 2;

  let userAgent;
  let platform;
  if (isMac) {
    const osx = OSX_VARIANTS[i % OSX_VARIANTS.length];
    userAgent = uaMacChrome(osx, patch);
    platform = 'MacIntel';
  } else if (isLinux) {
    userAgent = uaLinuxChrome(patch);
    platform = 'Linux x86_64';
  } else if (isEdge) {
    userAgent = uaWinEdge(patch);
    platform = 'Win32';
  } else {
    userAgent = uaWinChrome(patch);
    platform = 'Win32';
  }

  const taskbar = platform === 'Win32' ? 40 : platform === 'MacIntel' ? 32 : 28;
  const availH = Math.max(vh - taskbar, Math.floor(vh * 0.92));
  const colorDepth = dpr >= 2 && platform === 'MacIntel' ? 30 : 24;

  return {
    userAgent,
    platform,
    locale: loc.locale,
    timezoneId: loc.timezoneId,
    acceptLanguage: loc.acceptLanguage,
    language: loc.language,
    languages: loc.languages,
    viewport: { width: vw, height: vh },
    hardwareConcurrency: hw,
    deviceMemory: mem,
    maxTouchPoints: 0,
    screenWidth: vw,
    screenHeight: vh,
    availWidth: vw,
    availHeight: availH,
    colorDepth,
    pixelDepth: colorDepth,
    devicePixelRatio: dpr,
    cookieEnabled: true,
    doNotTrack: i % 17 === 0 ? '1' : null,
    timezoneOffset: tzOffsetMinutes(loc.timezoneId),
  };
}

const list = [];
for (let i = 0; i < 100; i++) list.push(buildEntry(i));

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(list, null, 2), 'utf8');

const poolJs =
  '/** Автогенерация: node scripts/build-webde-fingerprints.mjs — не править вручную */\n' +
  'window.__GMW_FP_PRESETS=' +
  JSON.stringify(list) +
  ';\n';

fs.writeFileSync(JS_OUT, poolJs, 'utf8');
console.log('Wrote', JSON_OUT, 'and', JS_OUT, '(' + list.length + ' entries)');
