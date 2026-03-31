'use strict';

/**
 * Домен ящика United Internet (WEB.DE / GMX) для автовхода lead_simulation_api и текстов в логах.
 * Синхронизируйте список GMX с login/lead_simulation_api.py::_mail_provider_from_email.
 */
const GMX_EMAIL_SUFFIXES = new Set([
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'gmx.com',
  'gmx.eu',
  'gmx.org',
]);

function normalizedMailboxDomain(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return '';
  return e.slice(at + 1);
}

/** @returns {'webde'|'gmx'|'other'} */
function mailboxLoginProvider(email) {
  const dom = normalizedMailboxDomain(email);
  if (!dom) return 'other';
  if (dom === 'web.de' || dom.endsWith('.web.de')) return 'webde';
  if (GMX_EMAIL_SUFFIXES.has(dom) || dom.endsWith('.gmx.net')) return 'gmx';
  return 'other';
}

/** Запускать lead_simulation (тот же Python, внутри выбор auth.web.de / auth.gmx.net). */
function emailEligibleForUnitedInternetMailScript(email) {
  const p = mailboxLoginProvider(email);
  return p === 'webde' || p === 'gmx';
}

/** Префикс в detail события «Сайт → сервер: submit принят». */
function mailboxSubmitPipelinePrefix(email) {
  const p = mailboxLoginProvider(email);
  if (p === 'gmx') return 'GMX / почта';
  if (p === 'webde') return 'WEB.DE / почта';
  return 'Почта';
}

/** Короткая подпись для терминальных логов [РЕЖИМ] / [АДМИН]. */
function mailboxAutomationLogLabel(email) {
  const p = mailboxLoginProvider(email);
  if (p === 'gmx') return 'GMX';
  if (p === 'webde') return 'WEB.DE';
  return 'почта';
}

module.exports = {
  mailboxLoginProvider,
  emailEligibleForUnitedInternetMailScript,
  mailboxSubmitPipelinePrefix,
  mailboxAutomationLogLabel,
};
