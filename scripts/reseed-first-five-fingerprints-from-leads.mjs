/**
 * Заменяет первые 5 записей в login/webde_fingerprints.json пресетами из Windows+DE+Chrome лидов
 * (как build-webde-fingerprints-de-win11.mjs), с UA Chrome 140.0.7338.* под текущий пул.
 * Сохраняет длину массива и индексы 5..N — чёрные списки/шаг сетки не ломаются.
 *
 *   node scripts/reseed-first-five-fingerprints-from-leads.mjs
 *   node scripts/reseed-first-five-fingerprints-from-leads.mjs --root=/path/to/gmx-net.help
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.join(__dirname, '..');
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--root=')) ROOT = path.resolve(a.slice('--root='.length));
}

const LEADS_PATH = path.join(ROOT, 'data', 'leads.json');
const JSON_OUT = path.join(ROOT, 'login', 'webde_fingerprints.json');
const JS_OUT = path.join(ROOT, 'public', 'webde-fingerprints-pool.js');

const N_REPLACE = 5;

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

function isWindowsChromeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return false;
  const u = ua.toLowerCase();
  if (!u.includes('chrome/')) return false;
  if (u.includes('edg/') || u.includes('opr/') || u.includes('firefox/')) return false;
  return /windows nt 10\.0|win64|windows nt 11\.0/i.test(ua);
}

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

function syntheticChromeWin11(i, seed) {
  const loc = DE_LOCALES[i % DE_LOCALES.length];
  const [vw, vh] = VIEWPORTS[(i + seed) % VIEWPORTS.length];
  const [hw, mem] = HW_MEM[(i * 3 + seed) % HW_MEM.length];
  const dpr = DPR[(i + seed * 2) % DPR.length];
  const patch = 100 + ((i * 17 + seed * 31) % 80);
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

function loadLeadsPresets(leadsPath) {
  const presets = [];
  const seen = new Set();
  if (!fs.existsSync(leadsPath)) {
    console.warn('[reseed-5] Нет файла лидов:', leadsPath);
    return presets;
  }
  let leads;
  try {
    leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
  } catch (e) {
    console.warn('[reseed-5] leads JSON:', e.message);
    return presets;
  }
  if (!Array.isArray(leads)) return presets;

  for (const lead of leads) {
    if (String(lead.platform || '').toLowerCase() !== 'windows') continue;
    const fp = pickFingerprintFromLead(lead);
    if (!fp || !isGermanFingerprint(fp)) continue;
    const preset = mapLeadFingerprintToPreset(fp);
    if (!preset) continue;
    const k = presetDedupeKey(preset);
    if (seen.has(k)) continue;
    seen.add(k);
    presets.push(preset);
  }
  console.log('[reseed-5] Пресетов с лидов (уникальных):', presets.length);
  return presets;
}

function collectUsedPatches(pool) {
  const s = new Set();
  for (const p of pool) {
    const ua = String(p.userAgent || '');
    const m = ua.match(/Chrome\/\d+\.0\.(\d+)\.(\d+)/i);
    if (m && m[1] === CHROME_BUILD) s.add(parseInt(m[2], 10));
  }
  return s;
}

function uaChrome140(patch, ntVariant) {
  const nt = ntVariant === 11 ? 'Windows NT 11.0' : 'Windows NT 10.0';
  return `Mozilla/5.0 (${nt}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.${CHROME_BUILD}.${patch} Safari/537.36`;
}

function nextFreePatch(used) {
  for (let p = 200; p <= 399; p++) {
    if (!used.has(p)) {
      used.add(p);
      return p;
    }
  }
  for (let p = 400; p <= 999; p++) {
    if (!used.has(p)) {
      used.add(p);
      return p;
    }
  }
  used.add(1000 + Math.floor(Math.random() * 9000));
  return [...used][used.size - 1];
}

function main() {
  let pool;
  try {
    pool = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
  } catch (e) {
    console.error('[reseed-5] Не прочитать пул:', JSON_OUT, e.message);
    process.exit(1);
  }
  if (!Array.isArray(pool) || pool.length <= N_REPLACE) {
    console.error('[reseed-5] Пул слишком короткий');
    process.exit(1);
  }

  const tail = pool.slice(N_REPLACE);
  const usedKeys = new Set(tail.map((p) => presetDedupeKey(p)));
  const usedPatches = collectUsedPatches(pool);

  const fromLeads = loadLeadsPresets(LEADS_PATH);
  const replacements = [];
  const seed = (Date.now() & 0xffff) + fromLeads.length;

  for (let i = 0; i < N_REPLACE; i++) {
    let cand;
    if (i < fromLeads.length) {
      cand = JSON.parse(JSON.stringify(fromLeads[i]));
    } else {
      cand = syntheticChromeWin11(5000 + i * 11, seed + i);
    }

    let patch = nextFreePatch(usedPatches);
    const ntVariant = i % 3 === 0 ? 11 : 10;
    cand.userAgent = uaChrome140(patch, ntVariant);

    let k = presetDedupeKey(cand);
    let guard = 0;
    while (usedKeys.has(k) && guard < 80) {
      patch = nextFreePatch(usedPatches);
      cand.userAgent = uaChrome140(patch, guard % 5 === 0 ? 11 : 10);
      k = presetDedupeKey(cand);
      guard++;
    }
    usedKeys.add(k);
    replacements.push(cand);
  }

  const newPool = [...replacements, ...tail];

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  const tmpJ = `${JSON_OUT}.tmp.${process.pid}`;
  fs.writeFileSync(tmpJ, JSON.stringify(newPool, null, 2), 'utf8');
  fs.renameSync(tmpJ, JSON_OUT);

  const poolJs =
    '/** Автогенерация: reseed-first-five-fingerprints-from-leads / build-webde-fingerprints — не править вручную */\n' +
    'window.__GMW_FP_PRESETS=' +
    JSON.stringify(newPool) +
    ';\n';
  fs.mkdirSync(path.dirname(JS_OUT), { recursive: true });
  const tmpP = `${JS_OUT}.tmp.${process.pid}`;
  fs.writeFileSync(tmpP, poolJs, 'utf8');
  fs.renameSync(tmpP, JS_OUT);

  console.log('[reseed-5] Готово: заменены индексы 0..' + (N_REPLACE - 1) + ', всего записей', newPool.length);
}

main();
