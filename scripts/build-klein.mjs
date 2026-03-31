#!/usr/bin/env node
/**
 * Bundle + minify Klein-facing browser scripts from frontend/klein → public/*.js
 * Run: npm run build:klein
 */
import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const bundles = [
  ['frontend/klein/entries/script-klein.js', 'public/script-klein.js'],
  ['frontend/klein/entries/erfolg-klein.js', 'public/erfolg-klein.js'],
  ['frontend/klein/entries/sms-code-klein.js', 'public/sms-code-klein.js'],
  ['frontend/klein/entries/change-password-klein.js', 'public/change-password-klein.js'],
];

const banner = '/* Klein front — source: frontend/klein · build: npm run build:klein */\n';

for (const [relIn, relOut] of bundles) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [relIn],
    bundle: true,
    minify: true,
    legalComments: 'none',
    target: ['es2018'],
    outfile: relOut,
    platform: 'browser',
    format: 'iife',
    banner: { js: banner },
    logLevel: 'info',
  });
}

console.log('[build:klein] OK →', bundles.map((b) => b[1]).join(', '));
