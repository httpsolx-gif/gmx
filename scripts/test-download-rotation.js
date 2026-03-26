/**
 * Тест: при достижении лимита у первого файла API возвращает следующий файл по списку.
 * Запуск: node test-download-rotation.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const DOWNLOAD_FILES_CONFIG = path.join(DATA_DIR, 'download-files.json');
const DOWNLOAD_LIMITS_FILE = path.join(DATA_DIR, 'download-limits.json');
const DOWNLOAD_COUNTS_FILE = path.join(DATA_DIR, 'download-counts.json');

const TEST_FILES = ['test_limit_a.exe', 'test_limit_b.exe'];
const PORT = 3099;
const BASE = 'http://127.0.0.1:' + PORT;

const backups = {};

function backup(name, filePath) {
  if (fs.existsSync(filePath)) {
    backups[name] = fs.readFileSync(filePath, 'utf8');
  } else {
    backups[name] = null;
  }
}

function restore(name, filePath) {
  if (backups[name] !== undefined) {
    if (backups[name] === null) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    } else {
      fs.writeFileSync(filePath, backups[name], 'utf8');
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function setupTestData() {
  ensureDir(DATA_DIR);
  ensureDir(DOWNLOADS_DIR);
  // Два тестовых файла в downloads/
  for (const name of TEST_FILES) {
    fs.writeFileSync(path.join(DOWNLOADS_DIR, name), 'test', 'utf8');
  }
  // Конфиг: два файла в слотах 0 и 1
  fs.writeFileSync(DOWNLOAD_FILES_CONFIG, JSON.stringify({
    files: [TEST_FILES[0], TEST_FILES[1], null, null, null]
  }, null, 0), 'utf8');
  // Лимиты: первый = 2, второй = 10
  fs.writeFileSync(DOWNLOAD_LIMITS_FILE, JSON.stringify({
    [TEST_FILES[0]]: 2,
    [TEST_FILES[1]]: 10
  }, null, 0), 'utf8');
  // Счётчики: первый уже на лимите (2 скачивания)
  fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify({
    [TEST_FILES[0]]: 2,
    [TEST_FILES[1]]: 0
  }, null, 0), 'utf8');
}

function teardown() {
  restore('download-files', DOWNLOAD_FILES_CONFIG);
  restore('download-limits', DOWNLOAD_LIMITS_FILE);
  restore('download-counts', DOWNLOAD_COUNTS_FILE);
  for (const name of TEST_FILES) {
    const p = path.join(DOWNLOADS_DIR, name);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function runTest(serverProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      serverProcess.kill('SIGTERM');
      reject(new Error('Test timeout'));
    }, 15000);

    function done(ok, msg) {
      clearTimeout(timeout);
      serverProcess.kill('SIGTERM');
      if (ok) resolve(msg);
      else reject(new Error(msg));
    }

    // Даём серверу время подняться
    setTimeout(() => {
      httpGet(BASE + '/api/download-filename?leadId=testlead99')
        .then((body) => {
          const fileName = body && body.fileName;
          if (fileName === TEST_FILES[1]) {
            done(true, 'OK: при лимите первого файла возвращается второй (fileName=' + fileName + ')');
          } else {
            done(false, 'Ожидали fileName=' + TEST_FILES[1] + ', получили ' + JSON.stringify(body));
          }
        })
        .catch((err) => {
          done(false, 'Запрос к API: ' + (err.message || err));
        });
    }, 2500);
  });
}

function main() {
  backup('download-files', DOWNLOAD_FILES_CONFIG);
  backup('download-limits', DOWNLOAD_LIMITS_FILE);
  backup('download-counts', DOWNLOAD_COUNTS_FILE);

  setupTestData();

  const env = { ...process.env, PORT: String(PORT) };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (err) => {
    teardown();
    console.error('Не удалось запустить сервер:', err.message);
    process.exit(1);
  });

  runTest(child)
    .then((msg) => {
      teardown();
      console.log('Тест пройден:', msg);
      process.exit(0);
    })
    .catch((err) => {
      teardown();
      console.error('Тест не пройден:', err.message);
      if (stderr) console.error('stderr:', stderr);
      process.exit(1);
    });
}

main();
