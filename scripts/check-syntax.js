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
  'src/core/httpServerApp.js',
  'src/core/bootstrap.js',
  'src/core/routeHttpDeps.js',
  'src/core/adminPaths.js',
  'src/services/wsAdminBroadcast.js',
  'src/services/mailService.js',
  'src/services/warmupService.js',
  'src/services/probeService.js',
  'src/services/downloadKitService.js',
  'src/routes/adminRoutes.js',
  'src/controllers/adminController.js',
  'src/controllers/leadController.js',
  'src/controllers/clientController.js',
  'src/controllers/staticController.js',
  'src/middleware/gateMiddleware.js',
  'src/routes/staticRoutes.js',
  'src/utils/staticFileServe.js',
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
