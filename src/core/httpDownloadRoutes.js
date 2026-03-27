'use strict';

/**
 * Скачивание: /download/<file>?t=TOKEN + legacy-редиректы.
 * Возвращает true, если запрос обработан.
 */
function handleDownloadRoutes(req, res, parsed, pathname, deps) {
  const {
    ADMIN_DOMAIN,
    requestHost,
    hasValidAdminSession,
    consumeDownloadToken,
    checkRateLimit,
    RATE_LIMITS,
    ip,
    findDownloadFile,
    incrementDownloadCount,
    sanitizeFilenameForHeader,
    safeEnd,
    send,
    fs,
    path,
    getSicherheitDownloadFile,
  } = deps;

  const downloadFileMatch = pathname.match(/^\/download\/([^/?#]+)$/);
  if (downloadFileMatch && req.method === 'GET') {
    const token = (parsed.query && parsed.query.t) ? String(parsed.query.t).trim() : '';
    let fileName = null;
    if (token) {
      fileName = consumeDownloadToken(token);
    } else if (requestHost === ADMIN_DOMAIN || hasValidAdminSession(req)) {
      let rawName;
      try {
        rawName = decodeURIComponent(downloadFileMatch[1]).replace(/\0/g, '');
      } catch (e) {
        rawName = downloadFileMatch[1].replace(/\0/g, '');
      }
      fileName = path.basename(rawName);
    }
    if (!fileName) {
      if (safeEnd(res)) return true;
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }
    if (!checkRateLimit(ip, 'downloadGet', RATE_LIMITS.downloadGet)) {
      if (safeEnd(res)) return true;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'too_many_requests' }));
      return true;
    }
    const fullPath = findDownloadFile(fileName);
    if (fullPath) {
      const displayName = path.basename(fullPath);
      incrementDownloadCount(fileName);
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = ext === '.zip' ? 'application/zip' : 'application/octet-stream';
      var fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch (e) {}
      if (safeEnd(res)) return true;
      var downloadHeaders = {
        'Content-Type': contentType,
        'Content-Disposition': 'attachment; filename="' + sanitizeFilenameForHeader(displayName) + '"',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache'
      };
      if (fileSize > 0) downloadHeaders['Content-Length'] = String(fileSize);
      res.writeHead(200, downloadHeaders);
      const stream = fs.createReadStream(fullPath);
      stream.on('error', function (err) {
        console.error('[SERVER] download stream error:', fileName, err.message || err);
        try { if (!res.writableEnded) res.end(); } catch (e) {}
      });
      stream.pipe(res);
      return true;
    }
    send(res, 404, 'Not Found', 'text/plain');
    return true;
  }

  // Старые URL скачивания — редирект на текущий файл по имени (или 404)
  if ((pathname === '/download/sicherheit-tool' || pathname === '/download/sicherheit-tool.zip' || pathname === '/download/sicherheit-tool.exe') && req.method === 'GET') {
    const info = getSicherheitDownloadFile();
    if (info && info.fileName) {
      if (safeEnd(res)) return true;
      res.writeHead(302, { 'Location': '/download/' + encodeURIComponent(info.fileName), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    send(res, 404, 'Not Found', 'text/plain');
    return true;
  }

  return false;
}

module.exports = {
  handleDownloadRoutes,
};
