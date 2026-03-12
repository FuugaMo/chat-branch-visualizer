'use strict';

// pack.js — build a Chrome Web Store-ready zip
// Usage: node scripts/pack.js
// Output: dist/chat-branch-visualizer-<version>.zip

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..');
const DIST    = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version  = manifest.version;
const outFile  = path.join(DIST, `chat-branch-visualizer-${version}.zip`);

// Files / dirs to include (everything else is excluded)
const INCLUDE = [
  'manifest.json',
  'background.js',
  'content.js',
  'platform-config.js',
  'reporting-config.js',
  'selectors.json',
  'sidepanel.html',
  'sidepanel.js',
  'sidepanel.css',
  'viewer.html',
  'viewer.js',
  'viewer.css',
  'styles.css',
  'icons/',
  'img/',
];

fs.mkdirSync(DIST, { recursive: true });

// Remove old zip if present
if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

const items = INCLUDE.filter(item => {
  const full = path.join(ROOT, item);
  const exists = fs.existsSync(full);
  if (!exists) console.warn(`  skip (not found): ${item}`);
  return exists;
});

const args = items.map(i => `"${i}"`).join(' ');
execSync(`cd "${ROOT}" && zip -r "${outFile}" ${args}`, { stdio: 'inherit' });

const size = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(ROOT, outFile)}  (${size} KB)`);
