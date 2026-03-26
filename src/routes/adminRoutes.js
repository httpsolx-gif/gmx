'use strict';

const adminController = require('../controllers/adminController');
const leadController = require('../controllers/leadController');

function normalizePathname(parsedUrl) {
  return (parsedUrl.pathname || '').replace(/\/\/+/g, '/') || '/';
}

/**
 * Админские маршруты: конфиги/загрузки → adminController; лиды/рассылки/warmup/чат → leadController.
 * scope = d (ROUTE_HTTP_MERGED из server) + req/res/pathname/parsed/method/body/ip.
 */
async function handleRoute(req, res, parsedUrl, body, d) {
  const pathname = normalizePathname(parsedUrl);
  const ip = typeof d.getClientIp === 'function' ? d.getClientIp(req) : '';
  const scope = Object.assign({}, d, {
    ip,
    req,
    res,
    pathname,
    parsed: parsedUrl,
    method: req.method,
    body,
  });
  if (await adminController.handle(scope)) return true;
  if (await leadController.handle(scope)) return true;
  return false;
}

module.exports = { handleRoute, normalizePathname };
