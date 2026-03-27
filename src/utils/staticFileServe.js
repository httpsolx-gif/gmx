'use strict';

const fs = require('fs');
const path = require('path');
const { send } = require('./httpUtils');

/** Отдача файла; для HTML подставляет window.__BRAND__ при плейсхолдере (getBrand обязателен для HTML). */
function serveFile(filePath, res, req, getBrand) {
  if (res.writableEnded) return;
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
  const contentType = types[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (res.writableEnded) return;
    if (err) {
      if (err.code === 'ENOENT') return send(res, 404, 'Not Found', 'text/plain');
      return send(res, 500, 'Error', 'text/plain');
    }
    let out = data;
    if (ext === '.html' && req && getBrand && (out.indexOf('__BRAND_JSON__') !== -1 || out.indexOf('<!-- __BRAND_JSON__ -->') !== -1)) {
      const brand = getBrand(req);
      const jsonStr = JSON.stringify(brand).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
      const script = '<script>window.__BRAND__=JSON.parse(\'' + jsonStr + '\');</script>';
      out = Buffer.from(out.toString().replace('<!-- __BRAND_JSON__ -->', script).replace('__BRAND_JSON__', script), 'utf8');
    }
    const headers = { 'Content-Type': contentType };
    if (ext === '.js' || ext === '.css' || ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
      headers['Last-Modified'] = new Date().toUTCString();
    }
    if (req && req.method === 'HEAD') {
      headers['Content-Length'] = String(Buffer.byteLength(out));
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(out);
  });
}

module.exports = { serveFile };
