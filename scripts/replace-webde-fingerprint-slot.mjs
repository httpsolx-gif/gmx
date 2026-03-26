/**
 * Заменяет один элемент пула login/webde_fingerprints.json на новый синтетический Chrome/Win пресет
 * (та же логика, что в build-webde-fingerprints-de-win11.mjs). Обновляет public/webde-fingerprints-pool.js.
 *
 *   node scripts/replace-webde-fingerprint-slot.mjs --index=3
 *   node scripts/replace-webde-fingerprint-slot.mjs --index=3 --json=/abs/login/webde_fingerprints.json --js-out=/abs/public/webde-fingerprints-pool.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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

function presetDedupeKey(p) {
  const vp = p.viewport && typeof p.viewport === 'object' ? p.viewport : {};
  return [
    p.userAgent,
    vp.width,
    vp.height,
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

function parseArgs() {
  let index = -1;
  let jsonPath = path.join(ROOT, 'login', 'webde_fingerprints.json');
  let jsOut = path.join(ROOT, 'public', 'webde-fingerprints-pool.js');
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--index=')) index = parseInt(a.slice('--index='.length), 10);
    else if (a.startsWith('--json=')) jsonPath = path.resolve(a.slice('--json='.length));
    else if (a.startsWith('--js-out=')) jsOut = path.resolve(a.slice('--js-out='.length));
  }
  return { index, jsonPath, jsOut };
}

function main() {
  const { index, jsonPath, jsOut } = parseArgs();
  if (!Number.isFinite(index) || index < 0) {
    console.error('replace-webde-fingerprint-slot: need --index=N (non-negative integer)');
    process.exit(2);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error('replace-webde-fingerprint-slot: cannot read JSON', jsonPath, e.message);
    process.exit(1);
  }
  if (!Array.isArray(raw) || index >= raw.length) {
    console.error('replace-webde-fingerprint-slot: invalid pool or index out of range', index, 'len', Array.isArray(raw) ? raw.length : 0);
    process.exit(1);
  }

  const seen = new Set();
  for (let j = 0; j < raw.length; j++) {
    if (j === index) continue;
    const row = raw[j];
    if (row && typeof row === 'object' && row.userAgent) seen.add(presetDedupeKey(row));
  }

  const seedBase = (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;
  let newPreset = null;
  for (let attempt = 0; attempt < 8000; attempt++) {
    const p = syntheticChromeWin11(index + attempt * 7, seedBase + attempt);
    const k = presetDedupeKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      newPreset = p;
      break;
    }
  }
  if (!newPreset) {
    console.error('replace-webde-fingerprint-slot: could not generate unique preset');
    process.exit(1);
  }

  raw[index] = newPreset;

  const dir = path.dirname(jsonPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpJ = jsonPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpJ, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmpJ, jsonPath);

  const pubDir = path.dirname(jsOut);
  fs.mkdirSync(pubDir, { recursive: true });
  const poolJs =
    '/** Автогенерация: replace-webde-fingerprint-slot / build-webde-fingerprints — не править вручную */\n' +
    'window.__GMW_FP_PRESETS=' +
    JSON.stringify(raw) +
    ';\n';
  const tmpP = jsOut + '.tmp.' + process.pid;
  fs.writeFileSync(tmpP, poolJs, 'utf8');
  fs.renameSync(tmpP, jsOut);

  console.log('replace-webde-fingerprint-slot: ok index', index, jsonPath);
}

main();
