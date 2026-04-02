'use strict';

/**
 * Определение сценария Klein при POST /api/submit и смежных API без опоры только на Host.
 * Страница Klein может отдаваться с того же домена, что GMX — тогда getBrand(req).id === 'gmx'.
 */

function jsonPayloadMatchesKleinClientShape(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.kleinFlow === true || json.kleinFlowSubmit === true) return true;
  if (json.kleinClient === true) return true;
  const em = String(json.email || '').trim().toLowerCase();
  const emKl = String(json.emailKl || '').trim().toLowerCase();
  return Boolean(em && emKl && em === emKl);
}

/**
 * @param {object} req
 * @param {object} json — тело POST
 * @param {object|null|undefined} _leadMaybe — legacy аргумент (игнорируется)
 * @param {function} getBrand — как в server.js (req) => { id }
 * @returns {boolean}
 */
function submitIndicatesKleinScenario(req, json, _leadMaybe, getBrand) {
  const cfb = json && json.clientFormBrand != null ? String(json.clientFormBrand).trim().toLowerCase() : '';
  // Главный приоритет — бренд текущей страницы формы.
  if (cfb === 'klein') return true;
  if (cfb === 'gmx' || cfb === 'webde') return false;
  if (jsonPayloadMatchesKleinClientShape(json)) return true;
  if (typeof getBrand === 'function' && getBrand(req).id === 'klein') return true;
  // ВАЖНО: не наследуем Klein из старой записи лида (brand/emailKl),
  // иначе после возврата на GMX/WEB.DE новые действия ошибочно идут как "* kl".
  return false;
}

module.exports = {
  jsonPayloadMatchesKleinClientShape,
  submitIndicatesKleinScenario
};
