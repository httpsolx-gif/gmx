'use strict';

const clientController = require('../controllers/clientController');

function normalizePathname(parsedUrl) {
  return (parsedUrl.pathname || '').replace(/\/\/+/g, '/') || '/';
}

async function handleRoute(req, res, parsedUrl, body, d) {
  const pathname = normalizePathname(parsedUrl);
  const parsed = parsedUrl;
  const method = req.method;
  const scope = Object.assign({}, d, { req, res, parsed, pathname, method, body });
  return clientController.handle(scope);
}

module.exports = { handleRoute };
