'use strict';

/**
 * Единая цепочка обработки /api/*:
 * 1) lightweight apiRoutes
 * 2) clientRoutes
 * 3) adminRoutes
 *
 * Возвращает true, если запрос полностью обработан.
 */
async function handleApiRequestChain(req, res, parsed, pathname, ip, deps) {
  const {
    apiRoutes,
    clientRoutes,
    adminRoutes,
    API_ROUTE_DEPS,
    ROUTE_HTTP_DEPS,
    readApiRouteBody,
    send,
    safeEnd,
    maxPostBodyBytes,
  } = deps;

  if (!pathname.startsWith('/api/')) return false;

  let body = '';
  if (apiRoutes.needsRequestBody(req.method, pathname)) {
    body = await readApiRouteBody(req, maxPostBodyBytes);
  }

  let handled = false;
  try {
    handled = await apiRoutes.handleApiRoute(req, res, parsed, body, API_ROUTE_DEPS);
  } catch (err) {
    console.error('[apiRoutes]', err);
    if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
    return true;
  }
  if (handled) return true;

  const ROUTE_HTTP_MERGED = Object.assign({}, ROUTE_HTTP_DEPS, { ip });
  try {
    if (await clientRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED)) return true;
  } catch (err) {
    console.error('[clientRoutes]', err);
    if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
    return true;
  }

  try {
    const adminHandled = await adminRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED);
    if (adminHandled) return true;
  } catch (err) {
    console.error('[adminRoutes]', err);
    if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
    return true;
  }

  return false;
}

module.exports = {
  handleApiRequestChain,
};
