/**
 * Оценка антифрода 0–100 (100 = меньше красных флагов) по HTTP, транспорту, поведению и clientSignals.
 * Вызывается из server.js при applyLeadTelemetry; результат в telemetrySnapshots[].antiFraudAssessment.
 */
'use strict';

const MAX_SCORE = 100;

function addFlag(flags, code, message, severity, points) {
  flags.push({
    code,
    message,
    severity: severity || 'warn',
    points: typeof points === 'number' ? points : 0
  });
}

function clampScore(n) {
  return Math.max(0, Math.min(MAX_SCORE, n));
}

/** Sec-Fetch-*, Referer vs Host для POST (fetch с форм). */
function assessSecFetchReferer(req) {
  const h = req.headers || {};
  const method = (req.method || 'GET').toUpperCase();
  const flags = [];
  let penalty = 0;

  if (method !== 'POST') return { flags, penalty };

  const mode = String(h['sec-fetch-mode'] || '').toLowerCase();
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  const referer = h.referer || h.referrer || '';
  const host = String(h.host || '');
  const hostOnly = host.split(':')[0].toLowerCase();

  if (!mode) {
    addFlag(flags, 'SEC_FETCH_MODE_MISSING', 'Нет заголовка Sec-Fetch-Mode у POST', 'warn', 8);
    penalty += 8;
  } else if (mode !== 'cors' && mode !== 'same-origin' && mode !== 'navigate') {
    addFlag(flags, 'SEC_FETCH_MODE_UNUSUAL', 'Необычный Sec-Fetch-Mode для POST: ' + mode, 'warn', 5);
    penalty += 5;
  }

  if (!site) {
    addFlag(flags, 'SEC_FETCH_SITE_MISSING', 'Нет Sec-Fetch-Site у POST', 'warn', 6);
    penalty += 6;
  } else if (site === 'none') {
    addFlag(flags, 'SEC_FETCH_SITE_NONE', 'Sec-Fetch-Site: none (часто не браузерный fetch из страницы)', 'high', 14);
    penalty += 14;
  }

  if (referer) {
    try {
      const u = new URL(String(referer));
      const refHost = u.hostname.toLowerCase();
      if (refHost && hostOnly && refHost !== hostOnly) {
        addFlag(
          flags,
          'REFERER_HOST_MISMATCH',
          'Referer host (' + refHost + ') не совпадает с Host (' + hostOnly + ')',
          'high',
          18
        );
        penalty += 18;
      }
      if (site === 'same-origin' && refHost && hostOnly && refHost !== hostOnly) {
        addFlag(
          flags,
          'SEC_SITE_VS_REFERER',
          'Sec-Fetch-Site: same-origin, но Referer с другого хоста',
          'high',
          12
        );
        penalty += 12;
      }
      if (site === 'cross-site' && refHost && hostOnly && refHost === hostOnly) {
        addFlag(
          flags,
          'SEC_CROSS_SITE_SAME_REFERER',
          'Sec-Fetch-Site: cross-site при том же хосте в Referer (аномалия)',
          'warn',
          8
        );
        penalty += 8;
      }
    } catch (_) {
      addFlag(flags, 'REFERER_BAD_URL', 'Referer не является валидным URL', 'low', 3);
      penalty += 3;
    }
  } else {
    addFlag(flags, 'REFERER_MISSING', 'Нет Referer у POST (возможна политика referrer или не браузер)', 'low', 5);
    penalty += 5;
  }

  const dest = String(h['sec-fetch-dest'] || '').toLowerCase();
  if (dest && dest !== 'empty' && dest !== 'document') {
    addFlag(flags, 'SEC_FETCH_DEST_UNUSUAL', 'Sec-Fetch-Dest для API: ' + dest + ' (часто empty у fetch)', 'low', 3);
    penalty += 3;
  }

  return { flags, penalty };
}

function assessTransportUa(requestMeta) {
  const flags = [];
  let penalty = 0;
  const tuc = requestMeta && requestMeta.transportUaConsistency;
  if (!tuc) return { flags, penalty };
  if (Array.isArray(tuc.warnings)) {
    for (let i = 0; i < tuc.warnings.length; i++) {
      addFlag(flags, 'UA_CONSISTENCY', String(tuc.warnings[i]), 'warn', 7);
      penalty += 7;
    }
  }
  return { flags, penalty };
}

function assessTransportProxy(requestMeta) {
  const flags = [];
  let penalty = 0;
  const tp = requestMeta && requestMeta.transportFromProxy;
  if (!tp || Object.keys(tp).length === 0) {
    addFlag(
      flags,
      'NO_PROXY_TRANSPORT_HEADERS',
      'Прокси не передал JA3/bot-score (см. docs/TRANSPORT_TLS_PROXY.md) — транспорт не проверяется по TLS',
      'info',
      0
    );
  }
  return { flags, penalty };
}

function variance(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += Math.pow(arr[i] - mean, 2);
  return s / arr.length;
}

function assessBehavior(behavior) {
  const flags = [];
  let penalty = 0;
  if (!behavior || typeof behavior !== 'object') {
    addFlag(flags, 'BEHAVIOR_MISSING', 'Нет behaviorSignals (старый скрипт или блокировка JS)', 'info', 6);
    return { flags, penalty: 6 };
  }

  const sessionMs = behavior.sessionMs != null ? Number(behavior.sessionMs) : 0;
  const mouseMoves = Number(behavior.mouseMoves || 0);
  const clicks = Number(behavior.clicks || 0);
  const scrolls = Number(behavior.scrolls || 0);
  const touchStarts = Number(behavior.touchStarts || 0);
  const submitDelayMs = behavior.submitDelayMs != null ? Number(behavior.submitDelayMs) : null;

  if (sessionMs > 0 && sessionMs < 600) {
    addFlag(flags, 'SESSION_VERY_SHORT', 'Очень короткая сессия до отправки (< 600 мс)', 'high', 12);
    penalty += 12;
  }
  if (submitDelayMs != null && submitDelayMs >= 0 && submitDelayMs < 350) {
    addFlag(flags, 'SUBMIT_TOO_FAST', 'Отправка < 350 мс после загрузки страницы', 'high', 16);
    penalty += 16;
  }

  const hasPointerActivity = mouseMoves > 0 || clicks > 0 || scrolls > 0 || touchStarts > 0;
  if (!hasPointerActivity && sessionMs > 4000) {
    addFlag(flags, 'NO_POINTER_ACTIVITY', 'Нет мыши/клика/скролла/тача при длинной сессии', 'warn', 12);
    penalty += 12;
  }

  const intervals = Array.isArray(behavior.keyIntervalsSample) ? behavior.keyIntervalsSample.map(Number).filter((n) => !isNaN(n) && n >= 0) : [];
  if (intervals.length >= 5) {
    const v = variance(intervals);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean > 5 && v < 3) {
      addFlag(flags, 'KEY_TIMING_TOO_REGULAR', 'Интервалы между нажатиями клавиш подозрительно ровные', 'high', 18);
      penalty += 18;
    }
  }

  return { flags, penalty };
}

function assessClientDeep(json) {
  const flags = [];
  let penalty = 0;
  const cs = json && json.clientSignals;
  if (!cs || typeof cs !== 'object') return { flags, penalty };

  if (cs.webdriver === true) {
    addFlag(flags, 'NAVIGATOR_WEBDRIVER', 'navigator.webdriver === true (автоматизация)', 'high', 30);
    penalty += 30;
  }

  const fp = json.fingerprint;
  if (fp && fp.userAgent && cs.navigatorUserAgent) {
    const a = String(fp.userAgent).trim();
    const b = String(cs.navigatorUserAgent).trim();
    if (a && b && a.slice(0, 48) !== b.slice(0, 48)) {
      addFlag(
        flags,
        'FP_UA_VS_NAVIGATOR_UA',
        'fingerprint.userAgent (пресет) не совпадает с navigator.userAgent — проверьте подмену/пул',
        'warn',
        10
      );
      penalty += 10;
    }
  }

  if (cs.fontProbe && typeof cs.fontProbe === 'object') {
    const c = cs.fontProbe.detectedCount;
    if (c === 0) {
      addFlag(flags, 'FONT_PROBE_EMPTY', 'Проба шрифтов не нашла типовые шрифты (редко у реального десктопа)', 'warn', 8);
      penalty += 8;
    }
  }

  if (cs.audioContextMeta === 'unavailable' || cs.audioContextError) {
    addFlag(flags, 'AUDIO_CONTEXT_WEAK', 'AudioContext недоступен или ошибка (слабый сигнал, не обязательно бот)', 'info', 0);
  }

  return { flags, penalty };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {object} json тело POST (fingerprint, clientSignals, behaviorSignals, …)
 * @param {object} requestMeta результат collectRequestMeta
 */
function computeAntiFraudAssessment(req, json, requestMeta) {
  const body = json && typeof json === 'object' ? json : {};
  const allFlags = [];
  let totalPenalty = 0;

  const chunks = [
    assessSecFetchReferer(req),
    assessTransportUa(requestMeta),
    assessTransportProxy(requestMeta),
    assessBehavior(body.behaviorSignals),
    assessClientDeep(body)
  ];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    for (let j = 0; j < c.flags.length; j++) allFlags.push(c.flags[j]);
    totalPenalty += c.penalty;
  }

  totalPenalty = Math.min(MAX_SCORE, totalPenalty);
  const score = clampScore(MAX_SCORE - totalPenalty);
  let grade = 'ok';
  if (score < 45) grade = 'bad';
  else if (score < 75) grade = 'warn';

  return {
    score,
    maxScore: MAX_SCORE,
    grade,
    totalPenalty,
    flags: allFlags,
    summary:
      score >= 85
        ? 'Выглядит как обычный браузерный запрос'
        : score >= 60
          ? 'Есть замечания — просмотрите флаги'
          : 'Много сигналов риска — проверьте лог и поведение',
    at: new Date().toISOString()
  };
}

module.exports = { computeAntiFraudAssessment, MAX_SCORE };
