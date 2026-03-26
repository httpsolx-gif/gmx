'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.GMW_DATA_DIR
  ? path.resolve(process.env.GMW_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

const mailService = require('../services/mailService');
const warmupService = require('../services/warmupService');
const probeService = require('../services/probeService');

function initAppServices(opts) {
  const pushEvent = opts && opts.pushEvent;
  mailService.init({ dataDir: DATA_DIR, pushEvent });
  warmupService.init({ dataDir: DATA_DIR });
  probeService.init({ projectRoot: PROJECT_ROOT });
}

module.exports = {
  PROJECT_ROOT,
  DATA_DIR,
  initAppServices,
};
