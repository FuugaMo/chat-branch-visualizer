'use strict';

const crypto = require('crypto');

const MAX_DESCRIPTION = 1500;
const MAX_TEXT = 240;
const MAX_SAMPLES = 6;

function sanitizeText(value, limit = MAX_TEXT) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
}

function sanitizeUrlForDiagnostics(input) {
  try {
    const parsed = new URL(String(input || ''));
    const parts = parsed.pathname.split('/').filter(Boolean);
    const first = parts[0] || '';
    const second = parts[1] || '';

    if (first === 'c') return `${parsed.origin}/c/:id`;
    if (first === 'g') return `${parsed.origin}/g/:id`;
    if (!first) return `${parsed.origin}/`;
    if (second) return `${parsed.origin}/${first}/${second}`;
    return `${parsed.origin}/${first}`;
  } catch (_) {
    return sanitizeText(input, 120);
  }
}

function sanitizePageLabel(inputUrl, platform = '') {
  const base = sanitizeText(platform || 'unknown', 24) || 'unknown';
  try {
    const path = new URL(String(inputUrl || '')).pathname || '/';
    if (path.includes('/c/')) return `${base}:conversation`;
    if (path.startsWith('/g/')) return `${base}:project`;
    if (path.startsWith('/apps')) return `${base}:apps`;
    return `${base}:page`;
  } catch (_) {
    return `${base}:page`;
  }
}

function sanitizeTurn(turn) {
  return {
    id: sanitizeText(turn?.id, 120),
    turnIndex: Number.isFinite(turn?.turnIndex) ? turn.turnIndex : null,
    branchIndex: Number.isFinite(turn?.branchIndex) ? turn.branchIndex : null,
    role: sanitizeText(turn?.role, 24),
    text: '',
  };
}

function sanitizeDomSummary(summary) {
  return (Array.isArray(summary) ? summary : []).slice(0, MAX_SAMPLES).map(item => ({
    label: sanitizeText(item?.label, 60),
    count: Number.isFinite(item?.count) ? item.count : 0,
    samples: (Array.isArray(item?.samples) ? item.samples : []).slice(0, MAX_SAMPLES).map(sample => ({
      tag: sanitizeText(sample?.tag, 24),
      testid: sanitizeText(sample?.testid, 80),
      cls: sanitizeText(sample?.cls, 160),
      text: '',
    })),
  }));
}

function sanitizeProbe(probe) {
  return {
    platform: sanitizeText(probe?.platform, 24),
    version: sanitizeText(probe?.version, 40),
    ts: Number.isFinite(probe?.ts) ? probe.ts : null,
    url: sanitizeUrlForDiagnostics(probe?.url),
    broken: (Array.isArray(probe?.broken) ? probe.broken : []).map(item => sanitizeText(item, 60)).filter(Boolean),
    hits: probe?.hits && typeof probe.hits === 'object' ? probe.hits : {},
  };
}

function sanitizeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  return {
    type: sanitizeText(diagnostics.type, 40) || 'selector-breakage',
    reason: sanitizeText(diagnostics.reason, 80),
    platform: sanitizeText(diagnostics.platform, 24),
    platformLabel: sanitizeText(diagnostics.platformLabel, 40),
    extensionVersion: sanitizeText(diagnostics.extensionVersion, 24),
    selectorVersion: sanitizeText(diagnostics.selectorVersion, 40),
    url: sanitizeUrlForDiagnostics(diagnostics.url),
    ts: Number.isFinite(diagnostics.ts) ? diagnostics.ts : Date.now(),
    turnCount: Number.isFinite(diagnostics.turnCount) ? diagnostics.turnCount : 0,
    probe: sanitizeProbe(diagnostics.probe),
    extra: diagnostics.extra && typeof diagnostics.extra === 'object' ? diagnostics.extra : {},
    activePath: (Array.isArray(diagnostics.activePath) ? diagnostics.activePath : []).slice(-4).map(sanitizeTurn),
    visiblePath: (Array.isArray(diagnostics.visiblePath) ? diagnostics.visiblePath : []).slice(-4).map(sanitizeTurn),
    domSummary: sanitizeDomSummary(diagnostics.domSummary),
  };
}

function normalizeUrlPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return sanitizeText(url, MAX_TEXT);
  }
}

function buildDigest(report) {
  const diagnostics = report?.diagnostics || {};
  const basis = JSON.stringify({
    type: report?.type || 'auto_probe',
    platform: diagnostics.platform || '',
    reason: diagnostics.reason || '',
    broken: diagnostics.probe?.broken || [],
    url: normalizeUrlPath(diagnostics.url || ''),
    turnCount: diagnostics.turnCount || 0,
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function parseReportBody(body) {
  const input = typeof body === 'string' ? JSON.parse(body) : (body || {});
  const diagnostics = sanitizeDiagnostics(input.diagnostics);
  return {
    type: input.type === 'user_report' ? 'user_report' : 'auto_probe',
    description: sanitizeText(input.description, MAX_DESCRIPTION),
    source: sanitizeText(input.source, 40) || 'extension',
    tabUrl: sanitizeUrlForDiagnostics(input.tabUrl || diagnostics?.url),
    pageTitle: sanitizePageLabel(input.tabUrl || diagnostics?.url, diagnostics?.platform),
    reportedAt: new Date().toISOString(),
    diagnostics,
    metadata: {
      extensionVersion: sanitizeText(input.extensionVersion || diagnostics?.extensionVersion, 24),
      selectorVersion: sanitizeText(input.selectorVersion || diagnostics?.selectorVersion, 40),
      client: sanitizeText(input.client, 40) || 'chrome-extension',
      publicKey: sanitizeText(input.publicKey, 120),
    },
  };
}

function buildIssueTitle(report) {
  const diagnostics = report.diagnostics || {};
  const prefix = report.type === 'user_report' ? '[USER]' : '[AUTO]';
  const platform = diagnostics.platform || 'unknown';
  const reason = diagnostics.reason || 'breakage';
  return `${prefix} ${platform} ${reason}`;
}

function buildIssueBody(report, digest) {
  const diagnostics = report.diagnostics || {};
  const marker = `<!-- cbv-report-digest:${digest} -->`;
  const lines = [
    marker,
    '## Report Summary',
    '',
    `- Type: \`${report.type}\``,
    `- Platform: \`${diagnostics.platform || 'unknown'}\``,
    `- Reason: \`${diagnostics.reason || 'unknown'}\``,
    `- URL: ${diagnostics.url || report.tabUrl || 'unknown'}`,
    `- Extension version: \`${diagnostics.extensionVersion || report.metadata.extensionVersion || 'unknown'}\``,
    `- Selector version: \`${diagnostics.selectorVersion || report.metadata.selectorVersion || 'unknown'}\``,
    `- Broken probes: \`${(diagnostics.probe?.broken || []).join(', ') || 'none'}\``,
  ];

  if (report.description) {
    lines.push('', '## User Description', '', report.description);
  }

  lines.push(
    '',
    '## Diagnostics',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```'
  );

  return lines.join('\n');
}

async function githubRequest(path, token, method = 'GET', body = null) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('Missing GITHUB_REPOSITORY');

  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'chat-branch-visualizer-reporting',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

module.exports = {
  buildDigest,
  buildIssueBody,
  buildIssueTitle,
  githubRequest,
  parseReportBody,
  sanitizeDiagnostics,
  sanitizeText,
};
