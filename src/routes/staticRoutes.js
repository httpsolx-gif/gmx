'use strict';

const staticController = require('../controllers/staticController');

function normalizePathname(parsedUrl) {
  return (parsedUrl.pathname || '').replace(/\/\/+/g, '/') || '/';
}

async function handleRoute(req, res, parsedUrl, body, d) {
  const pathname = normalizePathname(parsedUrl);
  const parsed = parsedUrl;
  const scope = Object.assign({}, d, { req, res, parsed, pathname, method: req.method, body });
  await staticController.handle(scope);
  return true;
}

module.exports = { handleRoute };
