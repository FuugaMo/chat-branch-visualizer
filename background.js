// background.js — service worker
// Responsibilities:
//   1. Open side panel when toolbar icon clicked
//   2. Route messages between content.js <-> sidepanel.js

importScripts('platform-config.js', 'reporting-config.js');

// ── Open side panel on action click ──────────────────────────────────────────
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Enable side panel for supported pages ─────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const supported = cbvIsSupportedUrl(tab.url || '');
  chrome.sidePanel.setOptions({
    tabId,
    enabled: supported,
    path:    'sidepanel.html',
  });
});

// ── Message routing ───────────────────────────────────────────────────────────
// content.js  → background → sidepanel  (content sends tree data / nav results)
// sidepanel   → background → content    (sidepanel sends nav commands)

// Keep track of UI ports (sidepanel/viewer) for a given tab
const uiPorts = new Map(); // tabId -> Set<port>
const reportedDiagnostics = new Map();

function getReportingConfig() {
  return typeof cbvGetReportingConfig === 'function'
    ? cbvGetReportingConfig()
    : { enabled: false };
}

function sanitizeText(value, limit = 240) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
}

function pruneReportedDiagnostics(now = Date.now()) {
  const ttl = Number(getReportingConfig().dedupeWindowMs) || (30 * 60 * 1000);
  for (const [key, ts] of reportedDiagnostics.entries()) {
    if (now - ts > ttl) reportedDiagnostics.delete(key);
  }
}

function buildReportKey(diagnostics) {
  const broken = (diagnostics?.probe?.broken || []).join(',');
  const url = (() => {
    try {
      const parsed = new URL(diagnostics?.url || '');
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return sanitizeText(diagnostics?.url || '', 180);
    }
  })();
  return [
    sanitizeText(diagnostics?.platform, 24),
    sanitizeText(diagnostics?.reason, 64),
    broken,
    url,
    Number.isFinite(diagnostics?.turnCount) ? diagnostics.turnCount : 0,
  ].join('|');
}

function markDiagnosticSent(key) {
  pruneReportedDiagnostics();
  reportedDiagnostics.set(key, Date.now());
}

function wasDiagnosticRecentlySent(key) {
  pruneReportedDiagnostics();
  return reportedDiagnostics.has(key);
}

function sanitizeTurn(turn) {
  return {
    id: sanitizeText(turn?.id, 120),
    turnIndex: Number.isFinite(turn?.turnIndex) ? turn.turnIndex : null,
    branchIndex: Number.isFinite(turn?.branchIndex) ? turn.branchIndex : null,
    role: sanitizeText(turn?.role, 24),
    text: sanitizeText(turn?.text || turn?.textSig, 120),
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
    url: sanitizeText(diagnostics.url, 240),
    ts: Number.isFinite(diagnostics.ts) ? diagnostics.ts : Date.now(),
    turnCount: Number.isFinite(diagnostics.turnCount) ? diagnostics.turnCount : 0,
    probe: {
      platform: sanitizeText(diagnostics.probe?.platform, 24),
      version: sanitizeText(diagnostics.probe?.version, 40),
      ts: Number.isFinite(diagnostics.probe?.ts) ? diagnostics.probe.ts : null,
      url: sanitizeText(diagnostics.probe?.url, 240),
      hits: diagnostics.probe?.hits && typeof diagnostics.probe.hits === 'object' ? diagnostics.probe.hits : {},
      broken: (Array.isArray(diagnostics.probe?.broken) ? diagnostics.probe.broken : []).map(item => sanitizeText(item, 60)),
    },
    extra: diagnostics.extra && typeof diagnostics.extra === 'object' ? diagnostics.extra : {},
    activePath: (Array.isArray(diagnostics.activePath) ? diagnostics.activePath : []).slice(-4).map(sanitizeTurn),
    visiblePath: (Array.isArray(diagnostics.visiblePath) ? diagnostics.visiblePath : []).slice(-4).map(sanitizeTurn),
    domSummary: (Array.isArray(diagnostics.domSummary) ? diagnostics.domSummary : []).slice(0, 6).map(entry => ({
      label: sanitizeText(entry?.label, 60),
      count: Number.isFinite(entry?.count) ? entry.count : 0,
      samples: (Array.isArray(entry?.samples) ? entry.samples : []).slice(0, 6).map(sample => ({
        tag: sanitizeText(sample?.tag, 24),
        testid: sanitizeText(sample?.testid, 80),
        cls: sanitizeText(sample?.cls, 160),
        text: sanitizeText(sample?.text, 160),
      })),
    })),
  };
}

async function shouldAutoSendDiagnostics(diagnostics) {
  const config = getReportingConfig();
  if (!config.enabled || !config.endpoint) return false;
  // Respect user consent stored by the side panel
  try {
    const result = await chrome.storage.local.get('cbv_consent');
    const consent = result['cbv_consent'];
    if (!consent?.decided || !consent?.autoSend) return false;
  } catch (_) {
    return false;
  }
  const platform = diagnostics?.platform || diagnostics?.probe?.platform;
  if (platform !== 'chatgpt' && platform !== 'claude') return false;
  const reason = diagnostics?.reason || '';
  const broken = diagnostics?.probe?.broken || [];
  return broken.length > 0 || reason === 'build_error' || reason === 'no_turns_detected' || reason === 'branch_navigation_warning';
}

async function postReport({ type, diagnostics, description = '', sender }) {
  const config = getReportingConfig();
  if (!config.enabled || !config.endpoint) return { ok: false, skipped: 'reporting_disabled' };

  const sanitized = sanitizeDiagnostics(diagnostics);
  if (!sanitized) return { ok: false, skipped: 'missing_diagnostics' };

  const key = buildReportKey(sanitized);
  if (type === 'auto_probe' && wasDiagnosticRecentlySent(key)) {
    return { ok: true, deduped: true };
  }

  const controller = new AbortController();
  const timeoutMs = Number(config.requestTimeoutMs) || 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CBV-Client': 'chrome-extension',
        'X-CBV-Public-Key': config.publicKey || '',
      },
      body: JSON.stringify({
        type,
        source: 'chrome-extension',
        client: 'chrome-extension',
        publicKey: config.publicKey || '',
        description: sanitizeText(description, 1500),
        tabUrl: sanitizeText(sender?.tab?.url || sanitized.url, 240),
        pageTitle: sanitizeText(sender?.tab?.title || '', 120),
        extensionVersion: sanitizeText(sanitized.extensionVersion, 24),
        selectorVersion: sanitizeText(sanitized.selectorVersion, 40),
        diagnostics: sanitized,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Reporting endpoint failed: ${response.status}`);
    }

    if (type === 'auto_probe') markDiagnosticSent(key);
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function addUiPort(tabId, port) {
  if (!uiPorts.has(tabId)) uiPorts.set(tabId, new Set());
  uiPorts.get(tabId).add(port);
}

function removeUiPort(tabId, port) {
  const set = uiPorts.get(tabId);
  if (!set) return;
  set.delete(port);
  if (!set.size) uiPorts.delete(tabId);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'cbv-sidepanel' && port.name !== 'cbv-viewer') return;

  // Figure out which tab this sidepanel belongs to
  // (sidePanel port doesn't expose tabId directly — we ask the panel to send it)
  let tabId = null;

  port.onMessage.addListener(async msg => {
    if (msg.type === 'REGISTER') {
      if (tabId && tabId !== msg.tabId) removeUiPort(tabId, port);
      tabId = msg.tabId;
      if (tabId) addUiPort(tabId, port);
      return;
    }

    // sidepanel → content: navigation / cancel commands
    if ((msg.type === 'NAVIGATE' || msg.type === 'CANCEL') && tabId) {
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId) removeUiPort(tabId, port);
  });
});

// content.js → background → UI clients
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg?.type === 'SUBMIT_REPORT') {
    postReport({
      type: msg.reportType === 'user_report' ? 'user_report' : 'auto_probe',
      diagnostics: msg.diagnostics,
      description: msg.description || '',
      sender,
    })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!tabId) return;

  // Forward to all registered UIs for this tab
  const ports = uiPorts.get(tabId);
  if (ports) {
    for (const port of ports) {
      try { port.postMessage({ ...msg, tabId }); } catch (_) {}
    }
  }

  if (msg?.type === 'PROBE_RESULT') {
    shouldAutoSendDiagnostics(msg.diagnostics).then(should => {
      if (!should) return;
      postReport({
        type: 'auto_probe',
        diagnostics: msg.diagnostics,
        sender,
      }).catch(error => {
        console.warn('CBV auto-report failed:', error);
      });
    });
  }

  // Always ACK
  sendResponse({ ok: true });
  return true;
});
