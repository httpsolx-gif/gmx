#!/usr/bin/env node
'use strict';

/**
 * Route inventory for src/*.js
 *
 * Modes:
 *   --write : generate/update docs/http-route-inventory.json
 *   --check : compare current inventory with docs/http-route-inventory.json
 *   (no mode) print current inventory to stdout
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'docs', 'http-route-inventory.json');

const MODE_WRITE = process.argv.includes('--write');
const MODE_CHECK = process.argv.includes('--check');

function listJsFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function posToLine(content, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function pushHit(list, seen, hit) {
  const key = [hit.route, hit.kind, hit.file, String(hit.line)].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  list.push(hit);
}

function extractFromFile(absPath) {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, '/');
  const content = fs.readFileSync(absPath, 'utf8');
  const hits = [];
  const seen = new Set();

  const eqRe = /\bpathname\s*===\s*['"`]([^'"`]+)['"`]/g;
  const startsRe = /\bpathname\.startsWith\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const matchRe = /\bpathname\.match\(\s*\/\^([^/]+)\/[a-z]*\s*\)/g;
  const setPathsRe = /const\s+([A-Z0-9_]*PATHS)\s*=\s*new Set\(\[([\s\S]*?)\]\);/g;
  const quotedInSetRe = /['"`]([^'"`]+)['"`]/g;

  let m;
  while ((m = eqRe.exec(content)) !== null) {
    pushHit(hits, seen, {
      route: m[1],
      kind: 'equals',
      file: rel,
      line: posToLine(content, m.index),
    });
  }
  while ((m = startsRe.exec(content)) !== null) {
    pushHit(hits, seen, {
      route: m[1],
      kind: 'startsWith',
      file: rel,
      line: posToLine(content, m.index),
    });
  }
  while ((m = matchRe.exec(content)) !== null) {
    pushHit(hits, seen, {
      route: '/^' + m[1] + '/',
      kind: 'regex',
      file: rel,
      line: posToLine(content, m.index),
    });
  }
  while ((m = setPathsRe.exec(content)) !== null) {
    const setBody = m[2];
    let q;
    while ((q = quotedInSetRe.exec(setBody)) !== null) {
      const route = q[1];
      if (!route || route.charAt(0) !== '/') continue;
      pushHit(hits, seen, {
        route: route,
        kind: 'setPath',
        file: rel,
        line: posToLine(content, m.index + q.index),
      });
    }
  }

  return hits.sort((a, b) => {
    if (a.route !== b.route) return a.route.localeCompare(b.route);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
}

function buildInventory() {
  const files = listJsFiles(SRC_DIR);
  const entries = [];
  for (const file of files) entries.push(...extractFromFile(file));

  const summaryByKind = entries.reduce((acc, it) => {
    acc[it.kind] = (acc[it.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    schemaVersion: 1,
    sourceRoot: 'src',
    totalEntries: entries.length,
    summaryByKind,
    entries,
  };
}

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function ensureDocsDir() {
  const docsDir = path.dirname(OUT_FILE);
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
}

function run() {
  const current = buildInventory();
  const currentText = stableStringify(current);

  if (MODE_WRITE) {
    ensureDocsDir();
    fs.writeFileSync(OUT_FILE, currentText, 'utf8');
    console.log('[OK] Route inventory written:', path.relative(ROOT, OUT_FILE));
    console.log('[OK] Entries:', current.totalEntries);
    return;
  }

  if (MODE_CHECK) {
    if (!fs.existsSync(OUT_FILE)) {
      console.error('[FAIL] Missing baseline file:', path.relative(ROOT, OUT_FILE));
      console.error('[HINT] Run: node scripts/route-inventory.js --write');
      process.exit(1);
    }
    const savedText = fs.readFileSync(OUT_FILE, 'utf8');
    if (savedText !== currentText) {
      console.error('[FAIL] Route inventory drift detected');
      console.error('[HINT] Review diff and update baseline: node scripts/route-inventory.js --write');
      process.exit(1);
    }
    console.log('[OK] Route inventory matches baseline');
    console.log('[OK] Entries:', current.totalEntries);
    return;
  }

  process.stdout.write(currentText);
}

run();
