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

function clientFormBrandFromJson(json) {
  if (!json || typeof json !== 'object') return '';
  const v = String(json.clientFormBrand || '').trim().toLowerCase();
  if (v === 'webde' || v === 'gmx' || v === 'klein') return v;
  return '';
}

function leadIsKleinMarked(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.brand === 'klein') return true;
  if (String(lead.emailKl || '').trim() !== '') return true;
  return false;
}

/**
 * @param {object} req
 * @param {object} json — тело POST
 * @param {object|null|undefined} leadMaybe — текущий лид по visitId или при поиске по email
 * @param {function} getBrand — как в server.js (req) => { id }
 * @returns {boolean}
 */
function submitIndicatesKleinScenario(req, json, leadMaybe, getBrand) {
  if (clientFormBrandFromJson(json) === 'klein') return true;
  if (jsonPayloadMatchesKleinClientShape(json)) return true;
  if (typeof getBrand === 'function' && getBrand(req).id === 'klein') return true;
  if (leadMaybe && leadIsKleinMarked(leadMaybe)) return true;
  return false;
}

module.exports = {
  clientFormBrandFromJson,
  jsonPayloadMatchesKleinClientShape,
  leadIsKleinMarked,
  submitIndicatesKleinScenario
};
