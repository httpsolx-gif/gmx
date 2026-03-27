'use strict';

/**
 * Ранние быстрые маршруты (до тяжёлой логики).
 * Возвращает true, если ответ уже отправлен.
 */
function handleFastPreGateRoutes(req, res, pathname, deps) {
  const { safeEnd, short } = deps;

  // Ранний лёгкий ответ для проверки, что сервер живой (до readShortDomains и прочей логики)
  if ((pathname === '/health' || pathname === '/ping') && req.method === 'GET') {
    if (safeEnd(res)) return true;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('ok');
    return true;
  }

  // Сокращалка: /s/:slug → редирект (бекенд в short/)
  const shortlinkMatch = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
  if (shortlinkMatch && req.method === 'GET') {
    const slug = shortlinkMatch[1];
    const target = short.resolveShortLink(slug);
    if (target) {
      if (safeEnd(res)) return true;
      res.writeHead(302, { 'Location': target, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
  }

  return false;
}

/**
 * Спец-маршруты после API-цепочки, но до статического контроллера.
 * Возвращает true, если ответ уже отправлен.
 */
function handlePreStaticSpecialRoutes(req, res, pathname, deps) {
  const { safeEnd, getBrand, gateMiddleware, getShortDomainsList } = deps;

  if (pathname === '/api/brand' && req.method === 'GET') {
    if (safeEnd(res)) return true;
    const brand = getBrand(req);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(brand));
    return true;
  }

  if (pathname === '/gate-white' && req.method === 'GET') {
    gateMiddleware.handleGateWhite(req, res, getBrand, getShortDomainsList);
    return true;
  }

  return false;
}

module.exports = {
  handleFastPreGateRoutes,
  handlePreStaticSpecialRoutes,
};
