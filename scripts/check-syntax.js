#!/usr/bin/env node
/**
 * Проверка синтаксиса всех Node.js-скриптов проекта.
 * Запуск: node scripts/check-syntax.js  или  npm run check:syntax
 */
const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'src/server.js',
  'src/short/index.js',
  'scripts/cleanup-backups.js',
  'scripts/check-reliability.js',
  'scripts/restore-leads.js',
  'scripts/test-download-rotation.js'
];

let failed = 0;
for (const file of files) {
  const full = path.join(root, file);
  try {
    execSync('node -c ' + JSON.stringify(full), { stdio: 'pipe' });
    console.log('[OK]', file);
  } catch (e) {
    console.error('[FAIL]', file);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
