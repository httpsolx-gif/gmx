/**
 * Бекенд сокращения ссылок.
 * Хранилище: short/data/links.json { "code": "https://..." }
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const LEGACY_FILE = path.join(__dirname, '..', '..', 'data', 'shortlinks.json');

const CODE_LENGTH = 8;
const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      const raw = fs.readFileSync(LINKS_FILE, 'utf8');
      const data = JSON.parse(raw);
      return typeof data === 'object' && data !== null ? data : {};
    }
    // Однократная миграция из data/shortlinks.json
    if (fs.existsSync(LEGACY_FILE)) {
      const raw = fs.readFileSync(LEGACY_FILE, 'utf8');
      const data = JSON.parse(raw);
      const obj = typeof data === 'object' && data !== null ? data : {};
      if (Object.keys(obj).length > 0) {
        ensureDataDir();
        fs.writeFileSync(LINKS_FILE, JSON.stringify(obj, null, 2), 'utf8');
        return obj;
      }
    }
  } catch (e) {
    console.error('[short] getLinks error:', e.message || e);
  }
  return {};
}

function writeLinks(obj) {
  ensureDataDir();
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[short] writeLinks error:', e.message || e);
    throw e;
  }
}

function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

/**
 * Создать короткую ссылку с автогенерацией кода.
 * @param {string} url — целевой URL
 * @returns {{ code: string, url: string }} код и URL
 */
function createShortLink(url) {
  const u = (url || '').trim();
  if (!u) return null;
  const links = getLinks();
  let code = generateCode();
  while (links[code]) code = generateCode();
  links[code] = u;
  writeLinks(links);
  return { code, url: u };
}

/**
 * Создать короткую ссылку с заданным кодом (slug).
 * @param {string} code — желаемый код (только буквы, цифры, _-)
 * @param {string} url — целевой URL
 * @returns {{ code: string, url: string } | null}
 */
function createShortLinkWithCode(code, url) {
  const c = (code || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const u = (url || '').trim();
  if (!c || !u) return null;
  const links = getLinks();
  links[c] = u;
  writeLinks(links);
  return { code: c, url: u };
}

/**
 * Получить целевой URL по коду.
 * @param {string} code
 * @returns {string | null}
 */
function resolveShortLink(code) {
  const links = getLinks();
  return links[code] || null;
}

/**
 * Список всех коротких ссылок.
 * @returns {{ code: string, url: string }[]}
 */
function listShortLinks() {
  const links = getLinks();
  return Object.keys(links).map(function (code) {
    return { code, url: links[code] };
  });
}

/**
 * Удалить короткую ссылку.
 * @param {string} code
 * @returns {boolean} была ли запись
 */
function deleteShortLink(code) {
  const links = getLinks();
  if (!(code in links)) return false;
  delete links[code];
  writeLinks(links);
  return true;
}

module.exports = {
  getLinks,
  writeLinks,
  generateCode,
  createShortLink,
  createShortLinkWithCode,
  resolveShortLink,
  listShortLinks,
  deleteShortLink
};
