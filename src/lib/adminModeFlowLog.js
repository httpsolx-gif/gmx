'use strict';

/**
 * Снимок настроек админки: левая колонка (Manual / Auto / Auto-Login) и правая (Login / Change / Download / Klein).
 * @param {string} mode
 * @param {boolean} autoScript
 * @param {string} startPage
 */
function formatModeStartPage(mode, autoScript, startPage) {
  const left = mode === 'manual' ? 'Manual' : autoScript ? 'Auto-Login' : 'Auto';
  const sp = startPage || 'login';
  const right =
    sp === 'login'
      ? 'Login'
      : sp === 'change'
        ? 'Change'
        : sp === 'download'
          ? 'Download'
          : sp === 'klein'
            ? 'Klein'
            : String(sp);
  return left + ' · ' + right + ' · autoScript=' + (autoScript ? 'on' : 'off');
}

/**
 * Одна строка в терминал + в лог лида (если передан leadId).
 */
function logAdminModeFlow(logTerminalFlow, readMode, readAutoScript, readStartPage, leadId, email, message) {
  const snapshot = formatModeStartPage(readMode(), readAutoScript(), readStartPage());
  const em = email != null && String(email).trim() !== '' ? String(email).trim() : '—';
  const lid = leadId != null ? String(leadId).trim() : '';
  logTerminalFlow('РЕЖИМ', 'Конфиг', '—', em, '[' + snapshot + '] ' + message, lid);
}

module.exports = { formatModeStartPage, logAdminModeFlow };
