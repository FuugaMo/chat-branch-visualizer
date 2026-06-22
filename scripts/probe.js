#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const selectors = require('../selectors.json');

const ROOT = process.cwd();
const OUTFILE = path.join(ROOT, 'probe-result.json');
const EXTENSION_PATH = ROOT;
const OPTIONAL_PROBE_KEYS = {
  chatgpt: new Set(['messageIdAttr', 'branchCounter', 'branchPrev', 'branchNext', 'scrollHost']),
  claude: new Set(['branchCounter', 'branchPrev', 'branchNext', 'scrollHost']),
};

const TARGETS = [
  {
    platform: 'chatgpt',
    url: process.env.TEST_CHATGPT_URL || '',
    cookieHeader: process.env.CHATGPT_SESSION_COOKIE || '',
    origin: 'https://chatgpt.com',
  },
  {
    platform: 'claude',
    url: process.env.TEST_CLAUDE_URL || '',
    cookieHeader: process.env.CLAUDE_SESSION_COOKIE || '',
    origin: 'https://claude.ai',
  },
].filter(target => target.url);

function parseCookieHeader(header, url) {
  if (!header) return [];
  const targetUrl = new URL(url);
  return header
    .split(';')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(entry => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return null;
      return {
        name: entry.slice(0, eq),
        value: entry.slice(eq + 1),
        domain: targetUrl.hostname,
        path: '/',
        httpOnly: false,
        secure: true,
      };
    })
    .filter(Boolean);
}

async function runProbe(page, platform) {
  const config = selectors.platforms[platform];
  const optionalKeys = [...(OPTIONAL_PROBE_KEYS[platform] || new Set())];
  return page.evaluate(({ cfg, optionalKeys, platform, version }) => {
    function queryCount(selector) {
      try {
        return document.querySelectorAll(selector).length;
      } catch (_) {
        return -1;
      }
    }

    function regexCount(pattern) {
      try {
        const regex = new RegExp(pattern);
        return [...document.querySelectorAll('span, div, p, button')]
          .filter(el => regex.test((el.textContent || '').trim()))
          .length;
      } catch (_) {
        return -1;
      }
    }

    function attrCount({ name, names, selector = '*' }) {
      const attrNames = Array.isArray(names) ? names : [name];
      try {
        return [...document.querySelectorAll(selector)].filter(el =>
          attrNames.some(attr => attr && el.hasAttribute(attr))
        ).length;
      } catch (_) {
        return -1;
      }
    }

    function probeValue(value) {
      if (typeof value === 'string') return queryCount(value);
      if (Array.isArray(value)) return value.map(probeValue);
      if (value && typeof value === 'object' && value.type === 'regex') return regexCount(value.pattern);
      if (value && typeof value === 'object' && value.type === 'attr') return attrCount(value);
      if (value && typeof value === 'object' && typeof value.selector === 'string') return queryCount(value.selector);
      return null;
    }

    function broken(value) {
      if (Array.isArray(value)) return value.every(broken);
      return typeof value === 'number' ? value <= 0 : value == null;
    }

    const hits = {};
    for (const [key, value] of Object.entries(cfg || {})) hits[key] = probeValue(value);

    return {
      platform,
      version,
      url: location.href,
      title: document.title,
      ts: Date.now(),
      hits,
      broken: Object.entries(hits)
        .filter(([key, value]) => !optionalKeys.includes(key) && broken(value))
        .map(([key]) => key),
    };
  }, {
    cfg: config,
    optionalKeys,
    platform,
    version: selectors.version,
  });
}

async function probeTarget(context, target) {
  const page = await context.newPage();
  const cookies = parseCookieHeader(target.cookieHeader, target.url);
  if (cookies.length) await context.addCookies(cookies);
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);
  return runProbe(page, target.platform);
}

async function main() {
  if (!TARGETS.length) {
    const result = {
      ok: true,
      reason: 'skipped',
      message: 'No probe targets configured. Set TEST_CHATGPT_URL and/or TEST_CLAUDE_URL to enable.',
      selectorsVersion: selectors.version,
      results: [],
    };
    fs.writeFileSync(OUTFILE, JSON.stringify(result, null, 2));
    console.log(result.message);
    process.exit(0);
  }

  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cbv-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  const results = [];
  let ok = true;

  try {
    for (const target of TARGETS) {
      const result = await probeTarget(context, target);
      results.push(result);
      if (result.broken.length) ok = false;
    }
  } finally {
    await context.close();
  }

  const payload = {
    ok,
    selectorsVersion: selectors.version,
    results,
  };
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch(error => {
  const payload = {
    ok: false,
    reason: 'probe_crashed',
    message: error.message,
    stack: error.stack,
    selectorsVersion: selectors.version,
  };
  fs.writeFileSync(OUTFILE, JSON.stringify(payload, null, 2));
  console.error(error);
  process.exit(1);
});
