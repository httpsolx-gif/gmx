#!/usr/bin/env node
/**
 * Проверки по плану надёжности (docs/RELIABILITY-AND-TESTING-PLAN.md).
 * Запуск: npm run check:phase1  или  node scripts/check-reliability.js
 * Сейчас реализована Фаза 1.1 (зависимости и окружение).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failed = 0;

function ok(msg) {
  console.log('[OK]', msg);
}
function warn(msg) {
  console.log('[?]', msg);
}
function fail(msg) {
  console.log('[FAIL]', msg);
  failed++;
}

console.log('=== Фаза 1.1: Зависимости и окружение ===\n');

// 1. package-lock.json есть
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) ok('package-lock.json присутствует');
else { fail('package-lock.json отсутствует — выполните: npm install'); }

// 2. package.json — зависимости есть
const pkgPath = path.join(root, 'package.json');
let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  fail('package.json не читается или невалидный JSON');
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) ok('dependencies заданы');
else warn('dependencies пусты');
if (pkg.devDependencies && pkg.devDependencies.sharp) warn('devDependencies: sharp — в production не обязателен');

// 3. .env.example — есть и без секретов (плейсхолдер)
const envExamplePath = path.join(root, 'config', '.env.example');
const envExampleRoot = path.join(root, '.env.example');
const envExample = fs.existsSync(envExamplePath) ? envExamplePath : (fs.existsSync(envExampleRoot) ? envExampleRoot : null);
if (envExample) {
  const content = fs.readFileSync(envExample, 'utf8');
  if (/ADMIN_TOKEN=/.test(content) && !/ADMIN_TOKEN=[a-f0-9]{32,}/i.test(content)) ok('.env.example есть, плейсхолдер токена (не реальный секрет)');
  else if (/ADMIN_TOKEN=[a-f0-9]{32,}/i.test(content)) fail('.env.example: похоже на реальный токен — замените на плейсхолдер');
  else ok('.env.example есть');
} else warn('.env.example не найден в config/ или корне — добавьте пример для деплоя');

// 4. .env не в репо (проверяем только наличие в корне — не читаем содержимое)
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) ok('.env существует (локально)');
else warn('.env отсутствует — скопируйте из config/.env.example и задайте ADMIN_TOKEN');

console.log('\n=== Фаза 1.2–1.3: код и безопасность ===\n');

const serverPath = path.join(root, 'src', 'server.js');
let serverContent = '';
try { serverContent = fs.readFileSync(serverPath, 'utf8'); } catch (e) {}
if (serverContent.indexOf('readLeadsAsync') !== -1) ok('server.js: есть readLeadsAsync (нет блокировки в /api/leads)');
else warn('server.js: readLeadsAsync не найден');
if (serverContent.indexOf('getShortDomainsList') !== -1) ok('server.js: кэш short domains (getShortDomainsList)');
else warn('server.js: getShortDomainsList не найден');
if (serverContent.indexOf('res.writableEnded') !== -1) ok('server.js: защита от двойной отправки (res.writableEnded)');
else warn('server.js: res.writableEnded не найден');
if (serverContent.indexOf('path.relative(PROJECT_ROOT') !== -1) ok('src/server.js: проверка path traversal (PROJECT_ROOT)');
else warn('src/server.js: path.relative(PROJECT_ROOT не найден');
if (serverContent.indexOf('checkAdminAuth') !== -1) ok('server.js: checkAdminAuth используется');
else fail('server.js: checkAdminAuth не найден');

const gitignorePath = path.join(root, '.gitignore');
const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
if (/.env/.test(gitignore)) ok('.gitignore: содержит .env');
else warn('.gitignore: нет .env');

console.log('\nРучные шаги:');
console.log('  1. Выполните: npm install  или  npm ci');
console.log('  2. На проде задайте переменные из .env.example в окружении или .env');
console.log('  3. Для очистки бэкапов и tmp: npm run cleanup  или  npm run cleanup:full\n');

if (failed) process.exit(1);
