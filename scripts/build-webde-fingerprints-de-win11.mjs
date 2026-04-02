/**
 * Пул отпечатков: немецкие локали + Windows + Chrome (без Edge в основном наборе).
 * 1) Парсит data/leads.json — лиды с platform === 'windows', реальный Chrome в UA, язык de-*.
 * 2) Добивает до --count уникальных синтетических Win32/NT10 (как у Win10/11 в реальном Chrome) + de-DE/de-AT/de-CH.
 *
 * Запуск из корня проекта:
 *   node scripts/build-webde-fingerprints-de-win11.mjs
 *   node scripts/build-webde-fingerprints-de-win11.mjs --count=120 --leads=data/leads.json
 *
 * Пишет login/webde_fingerprints.json и public/webde-fingerprints-pool.js (как build-webde-fingerprints.mjs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const JSON_OUT = path.join(ROOT, 'login', 'webde_fingerprints.json');
const JS_OUT = path.join(ROOT, 'public', 'webde-fingerprints-pool.js');

const DE_LOCALES = [
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8', language: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] },
  { locale: 'de-AT', timezoneId: 'Europe/Vienna', acceptLanguage: 'de-AT,de;q=0.9,en;q=0.8', language: 'de-AT', languages: ['de-AT', 'de', 'en-US', 'en'] },
  { locale: 'de-CH', timezoneId: 'Europe/Zurich', acceptLanguage: 'de-CH,de;q=0.9,fr;q=0.8,it;q=0.7,en;q=0.6', language: 'de-CH', languages: ['de-CH', 'de', 'fr', 'it', 'en'] },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en-GB;q=0.8,en;q=0.7', language: 'de-DE', languages: ['de-DE', 'de', 'en-GB', 'en'] },
];

const VIEWPORTS = [
  [1920, 1080], [1366, 768], [1536, 864], [2560, 1440], [1680, 1050], [1440, 900], [1920, 1200],
  [1280, 800], [1600, 900], [1280, 720], [1728, 1117], [1650, 1050], [1920, 1040], [2560, 1080],
  [2048, 1152], [3440, 1440], [1512, 948], [3840, 2160],
];

const HW_MEM = [
  [4, 4], [6, 8], [8, 8], [8, 16], [12, 16], [16, 16], [16, 32], [12, 8],
];

const DPR = [1, 1, 1.25, 1.5];

/** Реальный Chrome на Win10/11 по-прежнему шлёт Windows NT 10.0 в UA */
const CHROME_MAJOR = 140;
const CHROME_BUILD = '7338';

function tzOffsetMinutes(timezoneId) {
  const m = {
    'Europe/Berlin': -60,
    'Europe/Vienna': -60,
    'Europe/Zurich': -60,
    'Europe/Amsterdam': -60,
  };
  return m[timezoneId] ?? -60;
}

function parseArgs() {
  const out = { count: 100, leadsPath: path.join(ROOT, 'data', 'leads.json'), seed: Date.now() };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--count=')) out.count = Math.max(10, Math.min(500, parseInt(a.split('=')[1], 10) || 100));
    else if (a.startsWith('--leads=')) out.leadsPath = path.resolve(ROOT, a.slice('--leads='.length));
    else if (a.startsWith('--seed=')) out.seed = parseInt(a.split('=')[1], 10) || out.seed;
  }
  return out;
}

function createPrng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffleInPlace(arr, seed) {
  const rnd = createPrng(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function isWindowsChromeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return false;
  const u = ua.toLowerCase();
  if (!u.includes('chrome/')) return false;
  if (u.includes('edg/') || u.includes('opr/') || u.includes('firefox/')) return false;
  return /windows nt 10\.0|win64|windows nt 11\.0/i.test(ua);
}

/** Основной язык браузера — de-* (не «nl-NL + de в хвосте languages»). */
function isGermanFingerprint(fp) {
  if (!fp || typeof fp !== 'object') return false;
  const lang = String(fp.language || '').replace('_', '-').toLowerCase();
  if (lang.startsWith('de')) return true;
  const langs = fp.languages;
  if (Array.isArray(langs) && langs.length > 0) {
    return String(langs[0]).replace('_', '-').toLowerCase().startsWith('de');
  }
  return false;
}

function languagesToAcceptLanguage(langs, fallback) {
  if (!Array.isArray(langs) || langs.length === 0) return fallback;
  return langs
    .map((l, i) => {
      const s = String(l).trim();
      if (!s) return null;
      return i === 0 ? s : `${s};q=${(0.95 - i * 0.08).toFixed(2)}`;
    })
    .filter(Boolean)
    .join(',');
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

function pickFingerprintFromLead(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const snaps = lead.telemetrySnapshots;
  if (Array.isArray(snaps) && snaps.length > 0) {
    const last = snaps[snaps.length - 1];
    if (last && last.fingerprint && typeof last.fingerprint === 'object') return last.fingerprint;
  }
  if (lead.fingerprint && typeof lead.fingerprint === 'object') return lead.fingerprint;
  return null;
}

/** Нормализация в формат webde_fingerprints.json */
function mapLeadFingerprintToPreset(fp) {
  const ua = String(fp.userAgent || '').trim();
  if (!isWindowsChromeUserAgent(ua)) return null;

  const sw = clamp(fp.screenWidth ?? fp.innerWidth, 320, 4096);
  const sh = clamp(fp.screenHeight ?? fp.innerHeight, 240, 4096);
  const iw = clamp(fp.innerWidth ?? sw, 320, 4096);
  const ih = clamp(fp.innerHeight ?? sh, 240, 4096);
  const vw = Math.min(iw, sw);
  const vh = Math.min(ih, sh);

  const languages = Array.isArray(fp.languages) && fp.languages.length
    ? fp.languages.map((x) => String(x).replace('_', '-'))
    : [];
  const primary = String(fp.language || languages[0] || 'de-DE').replace('_', '-');
  const lang = primary.toLowerCase().startsWith('de') ? primary : 'de-DE';
  const langsOut = languages.length ? languages : [lang, 'de', 'en'];

  const tz = String(fp.timezone || 'Europe/Berlin').trim() || 'Europe/Berlin';
  const locMeta = DE_LOCALES.find((l) => l.language === lang || l.locale === lang) || DE_LOCALES[0];

  const preset = {
    userAgent: ua,
    platform: 'Win32',
    locale: locMeta.locale,
    timezoneId: ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'].includes(tz) ? tz : locMeta.timezoneId,
    acceptLanguage: languagesToAcceptLanguage(langsOut, locMeta.acceptLanguage),
    language: lang,
    languages: langsOut,
    viewport: { width: vw, height: vh },
    hardwareConcurrency: clamp(fp.hardwareConcurrency, 2, 32),
    deviceMemory: fp.deviceMemory != null ? clamp(fp.deviceMemory, 2, 64) : null,
    maxTouchPoints: clamp(fp.maxTouchPoints ?? 0, 0, 10),
    screenWidth: sw,
    screenHeight: sh,
    availWidth: clamp(fp.availWidth ?? vw, 200, sw),
    availHeight: clamp(fp.availHeight ?? vh - 40, 200, sh),
    colorDepth: clamp(fp.colorDepth, 24, 30),
    pixelDepth: clamp(fp.pixelDepth ?? fp.colorDepth, 24, 30),
    devicePixelRatio: clamp(fp.devicePixelRatio ?? 1, 1, 3) || 1,
    cookieEnabled: fp.cookieEnabled !== false,
    doNotTrack: fp.doNotTrack != null ? String(fp.doNotTrack) : null,
    timezoneOffset: typeof fp.timezoneOffset === 'number' ? fp.timezoneOffset : tzOffsetMinutes(locMeta.timezoneId),
  };

  if (preset.availHeight > preset.screenHeight) preset.availHeight = Math.max(preset.screenHeight - 40, 200);
  if (preset.availWidth > preset.screenWidth) preset.availWidth = preset.screenWidth;

  return preset;
}

function presetDedupeKey(p) {
  return [
    p.userAgent,
    p.viewport.width,
    p.viewport.height,
    p.screenWidth,
    p.screenHeight,
    p.hardwareConcurrency,
    p.deviceMemory ?? '',
    (p.languages || []).join(','),
  ].join('|');
}

function syntheticChromeWin11(i, seed, rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const loc = pick(DE_LOCALES);
  const [vw, vh] = pick(VIEWPORTS);
  const [hw, mem] = pick(HW_MEM);
  const dpr = pick(DPR);
  const patch = 100 + Math.floor(rnd() * 900);
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.${CHROME_BUILD}.${patch} Safari/537.36`;
  const taskbar = 48;
  const availH = Math.max(vh - taskbar, Math.floor(vh * 0.93));

  return {
    userAgent: ua,
    platform: 'Win32',
    locale: loc.locale,
    timezoneId: loc.timezoneId,
    acceptLanguage: loc.acceptLanguage,
    language: loc.language,
    languages: [...loc.languages],
    viewport: { width: vw, height: vh },
    hardwareConcurrency: hw,
    deviceMemory: mem,
    maxTouchPoints: 0,
    screenWidth: vw,
    screenHeight: vh,
    availWidth: vw,
    availHeight: availH,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: dpr,
    cookieEnabled: true,
    doNotTrack: (i + seed) % 13 === 0 ? '1' : null,
    timezoneOffset: tzOffsetMinutes(loc.timezoneId),
  };
}

function loadLeadsFingerprints(leadsPath) {
  const presets = [];
  const seen = new Set();
  if (!fs.existsSync(leadsPath)) {
    console.warn('[de-win11] Файл лидов не найден:', leadsPath, '— только синтетика');
    return { presets, seen };
  }
  let raw;
  try {
    raw = fs.readFileSync(leadsPath, 'utf8');
  } catch (e) {
    console.warn('[de-win11] Не прочитать leads:', e.message);
    return { presets, seen };
  }
  let leads;
  try {
    leads = JSON.parse(raw);
  } catch (e) {
    console.warn('[de-win11] JSON leads невалиден:', e.message);
    return { presets, seen };
  }
  if (!Array.isArray(leads)) {
    console.warn('[de-win11] leads.json не массив');
    return { presets, seen };
  }

  let winCount = 0;
  for (const lead of leads) {
    const plat = String(lead.platform || '').toLowerCase();
    if (plat !== 'windows') continue;
    winCount++;
    const fp = pickFingerprintFromLead(lead);
    if (!fp || !isGermanFingerprint(fp)) continue;
    const preset = mapLeadFingerprintToPreset(fp);
    if (!preset) continue;
    const k = presetDedupeKey(preset);
    if (seen.has(k)) continue;
    seen.add(k);
    presets.push(preset);
  }
  console.log('[de-win11] Лиды windows:', winCount, '→ уникальных DE+Chrome пресетов:', presets.length);
  return { presets, seen };
}

function main() {
  const { count, leadsPath, seed } = parseArgs();
  const { presets, seen } = loadLeadsFingerprints(leadsPath);
  // Перемешиваем входные пресеты из лидов, чтобы "Сгенерировать (DE)"
  // реально обновлял пул между запусками.
  if (presets.length > 1) shuffleInPlace(presets, seed);
  let synthSeed = (Number(seed) || 0) + presets.length;
  const rnd = createPrng(synthSeed || Date.now());

  for (let i = 0; presets.length < count; i++) {
    const p = syntheticChromeWin11(i, synthSeed, rnd);
    const k = presetDedupeKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    presets.push(p);
  }

  presets.length = Math.min(presets.length, count);

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(presets, null, 2), 'utf8');

  const poolJs =
    '/** Автогенерация: node scripts/build-webde-fingerprints-de-win11.mjs — не править вручную */\n' +
    'window.__GMW_FP_PRESETS=' +
    JSON.stringify(presets) +
    ';\n';
  fs.writeFileSync(JS_OUT, poolJs, 'utf8');

  console.log('Wrote', JSON_OUT, 'and', JS_OUT, '(' + presets.length + ' entries, target', count + ', seed=' + seed + ')');
}

main();
