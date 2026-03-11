// sidepanel.js
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let treeNodes  = new Map();
let activePath = new Set();
let activePathKeys = new Set();
let activePathSigs = new Set();
let visiblePath = new Set();
let visiblePathKeys = new Set();
let visiblePathSigs = new Set();
let renderedNodes = new Map();
let renderedExpandedGroups = [];
let expandedChainStarts = new Set();
let forceCollapseAll = false;
let treeCompleteness = 'loading';
let treeLoadingMode = 'idle';
let treeLoadingTimer = null;
let treeLoadingShownAt = 0;
let currentTabId = null;
let currentPageUrl = '';
let currentPlatform = 'unknown';
let panelPort = null;
let treeSource = 'live';
let treeDataUrl = '';
let lastDiagnostics = null;
let toolFabMeasureCanvas = null;

// ── Camera ────────────────────────────────────────────────────────────────────
let cam = { x: 20, y: 20, scale: 1 };
let isPanning  = false;
let panStart   = { x: 0, y: 0, cx: 0, cy: 0 };
let lastPinch  = null;
let gestureBaseScale = null;
let gestureCenter = null;
let resizeTimer = null;
// Fix 2: rAF throttle
let rafPending = false;

// ── Layout constants ───────────────────────────────────────────────────────────
// Card mode (default): rounded-rect cards with text preview
const CARD_NW   = 148;
const CARD_NH   = 54;
const CARD_HGAP = 14;
const CARD_VGAP = 48;
// Compact mode: single-line pill nodes
const PILL_NW   = 120;
const PILL_NH   = 26;
const PILL_HGAP = 10;
const PILL_VGAP = 34;
// Mini mode: for fit-all on very dense trees
const MINI_NW   = 74;
const MINI_NH   = 18;
const MINI_HGAP = 8;
const MINI_VGAP = 24;

const PAD      = 24;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;

// ── Node display mode ─────────────────────────────────────────────────────────
let compactMode = false;
let autoNodeMode = 'card';
compactMode = true;

function getNodeMode() {
  if (autoNodeMode === 'mini') return 'mini';
  if (compactMode || autoNodeMode === 'compact') return 'compact';
  return 'card';
}

function NW() {
  const mode = getNodeMode();
  return mode === 'mini' ? MINI_NW : mode === 'compact' ? PILL_NW : CARD_NW;
}

function NH() {
  const mode = getNodeMode();
  return mode === 'mini' ? MINI_NH : mode === 'compact' ? PILL_NH : CARD_NH;
}

function H_GAP() {
  const mode = getNodeMode();
  return mode === 'mini' ? MINI_HGAP : mode === 'compact' ? PILL_HGAP : CARD_HGAP;
}

function V_GAP() {
  const mode = getNodeMode();
  return mode === 'mini' ? MINI_VGAP : mode === 'compact' ? PILL_VGAP : CARD_VGAP;
}

// Fix 4: module-scope layout map (shared by renderTree + minimap + panToNode)
let layoutMap = new Map();   // nodeId → { x, y, w }

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  panelPort = chrome.runtime.connect({ name: 'cbv-sidepanel' });
  panelPort.onMessage.addListener(onContentMessage);

  document.getElementById('btn-build').addEventListener('click', maybeStartBuild);
  document.getElementById('btn-cancel').addEventListener('click', () =>
    { sendToContent({ type: 'CANCEL' }); });
  document.getElementById('btn-fit').addEventListener('click', fitView);
  document.getElementById('btn-locate-visible').addEventListener('click', panToVisibleRange);
  document.getElementById('btn-viewer').addEventListener('click', openStandaloneViewer);
  document.getElementById('btn-expand-toggle').addEventListener('click', toggleExpandCollapseAll);
  document.getElementById('btn-build-cancel').addEventListener('click', closeBuildModal);
  document.getElementById('btn-build-confirm').addEventListener('click', confirmBuild);
  document.getElementById('cbv-zoom-slider').addEventListener('input', onZoomSliderInput);
  document.getElementById('btn-copy-diagnostics').addEventListener('click', copyDiagnostics);
  document.getElementById('btn-report-breakage').addEventListener('click', reportBreakage);
  document.getElementById('btn-diagnostics-toggle').addEventListener('click', toggleDiagnosticsConsent);
  document.getElementById('btn-consent-allow').addEventListener('click', () => saveConsent(true));
  document.getElementById('btn-consent-deny').addEventListener('click',  () => saveConsent(false));
  updateExpandToggleButton();
  updateTreeCompletenessBadge();
  updateDiagnosticsActions();
  initMoreMenu();
  syncAllToolFabWidths();

  initInteraction();
  syncZoomSlider();
  chrome.tabs.onActivated.addListener(handleActiveTabChanged);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  await bindToActiveTab({ reset: false, restore: true });
  await initConsentBanner();

})();

// ── Diagnostics consent ───────────────────────────────────────────────────────
const CBV_CONSENT_KEY = 'cbv_consent';

async function initConsentBanner() {
  try {
    const result = await chrome.storage.local.get(CBV_CONSENT_KEY);
    const consent = result[CBV_CONSENT_KEY];
    if (!consent?.decided) {
      document.getElementById('cbv-consent-banner').hidden = false;
    }
    syncDiagnosticsToggle(consent?.autoSend === true);
  } catch (_) {}
}

async function saveConsent(allow) {
  document.getElementById('cbv-consent-banner').hidden = true;
  try {
    await chrome.storage.local.set({ [CBV_CONSENT_KEY]: { decided: true, autoSend: allow } });
    syncDiagnosticsToggle(allow);
  } catch (_) {}
}

async function toggleDiagnosticsConsent() {
  closeMoreMenu();
  try {
    const result = await chrome.storage.local.get(CBV_CONSENT_KEY);
    const current = result[CBV_CONSENT_KEY]?.autoSend === true;
    await saveConsent(!current);
  } catch (_) {}
}

// ── Messaging ─────────────────────────────────────────────────────────────────
function sendToContent(msg) {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, msg).then(handleDirectResponse).catch(() => {});
}

async function handleActiveTabChanged() {
  await bindToActiveTab({ reset: true, restore: true });
}

async function handleTabUpdated(tabId, info) {
  if (tabId !== currentTabId || info.status !== 'complete') return;
  await bindToActiveTab({ reset: true, restore: true });
}

async function bindToActiveTab({ reset = true, restore = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const nextTabId = tab?.id ?? null;
  const nextUrl = tab?.url || '';
  const nextPlatform = cbvDetectPlatform(nextUrl);
  const changed = nextTabId !== currentTabId || nextUrl !== currentPageUrl;

  currentTabId = nextTabId;
  currentPageUrl = nextUrl;
  currentPlatform = nextPlatform;

  panelPort?.postMessage({ type: 'REGISTER', tabId: currentTabId });

  if (!nextTabId) {
    resetTreeState();
    hideTreeLoading(true);
    setSupportedPageEmptyState('empty');
    setStatus('Waiting for page…', 'idle');
    return;
  }

  if (!isSupportedPlatform(nextPlatform)) {
    resetTreeState();
    hideTreeLoading(true);
    setSupportedPageEmptyState('unsupported');
    setStatus('Open a ChatGPT or Claude conversation', 'idle');
    return;
  }

  setSupportedPageEmptyState('supported');

  if (reset && changed) {
    resetTreeState();
    setTreeCompleteness('loading');
    setStatus(nextTabId ? `Switched — ${assistantDisplayName()}` : 'Waiting for page…', nextTabId ? 'ok' : 'idle');
    showTreeLoading('Loading conversation…', 'Syncing tree with the active tab', 'conversation');
  }

  if (restore && changed) await restoreFromStorage(nextUrl);
  if (currentTabId) sendToContent({ type: 'QUICK_SCAN' });
}

async function openStandaloneViewer() {
  if (!currentTabId) return;
  let sourceUrl = currentPageUrl;
  if (!sourceUrl) {
    try {
      const tab = await chrome.tabs.get(currentTabId);
      sourceUrl = tab?.url || '';
    } catch (_) {}
  }

  const url = new URL(chrome.runtime.getURL('viewer.html'));
  url.searchParams.set('tabId', String(currentTabId));
  if (sourceUrl) url.searchParams.set('src', sourceUrl);
  await chrome.tabs.create({ url: url.toString() });

  try {
    if (chrome.sidePanel?.close) {
      await chrome.sidePanel.close({ tabId: currentTabId });
    } else {
      window.close();
    }
  } catch (_) {}
}

function onContentMessage(msg) {
  if (isStaleMessage(msg)) return;
  syncTreeDataContext(msg);
  switch (msg.type) {
    case 'PAGE_READY':
      if (msg.supported === false || !isSupportedPlatform(msg.platform)) {
        currentPageUrl = msg.url || currentPageUrl;
        currentPlatform = 'unknown';
        resetTreeState();
        hideTreeLoading(true);
        setSupportedPageEmptyState('unsupported');
        setStatus('Open a ChatGPT or Claude conversation', 'idle');
        break;
      }
      if (msg.url && msg.url !== currentPageUrl) {
        currentPageUrl = msg.url;
        currentPlatform = msg.platform || detectCurrentPlatform();
        resetTreeState();
        setTreeCompleteness('loading');
        showTreeLoading('Loading conversation…', 'Syncing tree with the newly opened chat', 'conversation');
      } else {
        currentPageUrl = msg.url || currentPageUrl;
        currentPlatform = msg.platform || detectCurrentPlatform();
      }
      setStatus(`Connected — ${formatPlatformName(msg.platform)}`, 'ok');
      sendToContent({ type: 'QUICK_SCAN' });
      break;

    case 'SCAN_RESULT':
      {
      const wasEmpty = treeNodes.size === 0;
      const wasPartial = treeCompleteness === 'partial';
      msg.turns = sanitizeTurns(msg.turns);
      if (treeCompleteness !== 'full') {
        if (msg.turns.length) mergeTurnsIntoTree(msg.turns);
        else replaceTreeWithTurns(msg.turns);
        setTreeCompleteness(msg.turns.length ? 'partial' : (treeLoadingMode === 'conversation' ? 'loading' : 'empty'));
      }
      setActivePathState(sanitizePathTurns(msg.turns.map(t => ({
        id: t.id || `t${t.turnIndex}_b${t.branchIndex}`,
        turnIndex: t.turnIndex,
        branchIndex: t.branchIndex,
        role: t.role,
        text: t.text,
      }))));
      setVisiblePathState([]);
      if (treeCompleteness === 'partial' && (wasEmpty || !wasPartial)) setExpandedByDefaultForPartial();
      renderTree();
      break;
      }

    case 'BUILD_START':
      treeNodes.clear(); activePath.clear(); activePathKeys.clear(); visiblePath.clear(); visiblePathKeys.clear(); expandedChainStarts.clear();
      treeSource = 'live';
      setTreeCompleteness('building');
      setProgress(0); showProgress();
      showTreeLoading('Building full tree…', `${assistantDisplayName()} may switch branches while history is collected`, 'build');
      setStatus('Building tree…', 'working');
      setBuildBusy();
      break;

    case 'BUILD_PROGRESS': {
      const pct = Math.min(99, Math.round((msg.turnIdx / Math.max(msg.turnCount, 1)) * 100));
      setProgress(pct);
      setStatus(`Scanning turn ${msg.turnIdx + 1}/${msg.turnCount} · ${msg.nodeCount} nodes`, 'working');
      break;
    }

    case 'BUILD_DONE':
      treeNodes   = new Map(msg.nodes.map(n => [n.id, n]));
      treeSource = msg.partial ? 'live' : 'build';
      setTreeCompleteness(msg.partial ? 'partial' : 'full');
      setActivePathState(sanitizePathTurns(msg.activePath));
      setVisiblePathState([]);
      expandedChainStarts.clear();
      hideProgress();
      setBuildIdle();
      hideTreeLoading(true);
      setStatus(
        msg.partial
          ? `Partial tree ready${msg.reason ? ` · ${msg.reason}` : ''}`
          : 'Full tree ready',
        msg.partial ? 'idle' : 'ok'
      );
      if (msg.partial) setExpandedByDefaultForPartial();
      else collapseByDefault();
      requestAnimationFrame(fitView);
      break;

    case 'BUILD_ERROR':
      hideProgress();
      setBuildIdle();
      hideTreeLoading(true);
      setStatus(`Error: ${msg.message}`, 'error');
      break;

    case 'BUILD_CANCELLED':
      hideProgress();
      setBuildIdle();
      hideTreeLoading(true);
      setStatus('Build cancelled', 'idle');
      break;

    case 'BUILD_WARNING':
      // Non-fatal: show warning in status but keep building
      setStatus(`Warning: ${msg.message}`, 'working');
      break;

    case 'PROBE_RESULT':
      lastDiagnostics = msg.diagnostics || null;
      updateDiagnosticsActions();
      if (lastDiagnostics?.probe?.broken?.length) {
        if (!(treeCompleteness === 'full' && treeSource === 'snapshot' && treeNodes.size > 0)) {
          setStatus(`Selector mismatch detected · ${lastDiagnostics.probe.broken.join(', ')}`, 'error');
        }
      }
      break;

    case 'NAV_DONE':
    case 'ACTIVE_PATH':
      msg.activePath = sanitizePathTurns(msg.activePath);
      setActivePathState(msg.activePath);
      hideTreeLoading(true);
      setStatus(describeActivePathStatus(msg.activePath), 'ok');
      renderTree();
      // Fix 4: jump camera to active leaf after nav
      requestAnimationFrame(panToActiveLeaf);
      break;

    case 'VISIBLE_RANGE':
      setVisiblePathState(sanitizePathTurns(msg.visiblePath));
      renderTree();
      break;

    case 'CONVERSATION_LOADING':
      if (!treeNodes.size || treeCompleteness === 'loading' || treeCompleteness === 'empty') {
        setTreeCompleteness('loading');
      }
      showTreeLoading('Loading conversation…', `Waiting for ${assistantDisplayName()} to finish switching branches`, 'conversation');
      break;

    case 'STATE_SYNC':
      {
      const wasEmpty = treeNodes.size === 0;
      const wasPartial = treeCompleteness === 'partial';
      msg.turns = sanitizeTurns(msg.turns);
      msg.activePath = sanitizePathTurns(msg.activePath);
      const isFull = treeCompleteness === 'full';
      const isSnapshot = treeSource === 'snapshot';
      if (!isFull || !isSnapshot) {
        if (msg.turns.length) {
          mergeTurnsIntoTree(msg.turns);
        } else if (!isFull) {
          replaceTreeWithTurns(msg.turns);
        }
        if (!isFull) {
          setTreeCompleteness(msg.turns.length ? 'partial' : (treeLoadingMode === 'conversation' ? 'loading' : 'empty'));
        }
      }
      setActivePathState(msg.activePath);
      if (msg.turns.length > 0 || msg.activePath.length > 0) hideTreeLoading(false);
      if (treeCompleteness === 'partial' && (wasEmpty || !wasPartial)) setExpandedByDefaultForPartial();
      renderTree();
      break;
      }
  }
}

function isStaleMessage(msg) {
  if (!msg?.url || !currentPageUrl) return false;
  return msg.type !== 'PAGE_READY' && msg.url !== currentPageUrl;
}

function syncTreeDataContext(msg) {
  if (!msg?.url) return;
  if (msg.type === 'PAGE_READY') {
    treeDataUrl = msg.url;
    return;
  }
  if (!treeDataUrl) {
    treeDataUrl = msg.url;
    return;
  }
  if (msg.url !== treeDataUrl) {
    resetTreeState();
    treeDataUrl = msg.url;
  }
}

function handleDirectResponse(msg) {
  if (msg?.type) onContentMessage(msg);
}

// ── Navigate ──────────────────────────────────────────────────────────────────
function navigateTo(nodeId) {
  const node = treeNodes.get(nodeId);
  if (!node) return;
  const path = [];
  let cur = node;
  while (cur) {
    path.unshift({ turnIndex: cur.turnIndex, branchIndex: cur.branchIndex, branchTotal: cur.branchTotal });
    cur = cur.parentId ? treeNodes.get(cur.parentId) : null;
  }
  sendToContent({ type: 'NAVIGATE', path });
  showTreeLoading('Switching branch…', `Waiting for ${assistantDisplayName()} to load the selected branch`, 'switch');
  setStatus(`Navigating to turn ${node.turnIndex + 1}, branch ${node.branchIndex}…`, 'working');
}

function pathKey(turnIndex, branchIndex) {
  return `${turnIndex}:${branchIndex}`;
}

function textSignature(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function nodeSig(node) {
  return `${node.turnIndex}:${node.branchIndex}:${node.role || ''}:${textSignature(node.text)}`;
}

function pathEntrySig(entry) {
  return `${entry.turnIndex}:${entry.branchIndex}:${entry.role || ''}:${textSignature(entry.textSig || entry.text || '')}`;
}

function buildPathLineageSet(path) {
  const set = new Set();
  const parts = [];
  for (const entry of path || []) {
    parts.push(pathEntrySig(entry));
    set.add(parts.join('>'));
  }
  return set;
}

function buildNodeLineageSig(node) {
  const parts = [];
  let cur = node;
  while (cur) {
    if (cur.kind === 'cluster') break;
    parts.unshift(nodeSig(cur));
    cur = cur.parentId ? treeNodes.get(cur.parentId) : null;
  }
  return parts.join('>');
}

function setActivePathState(path) {
  activePath = new Set((path || []).map(p => p.id));
  activePathKeys = new Set((path || []).map(p => pathKey(p.turnIndex, p.branchIndex)));
  activePathSigs = buildPathLineageSet(path || []);
}

function setVisiblePathState(path) {
  visiblePath = new Set((path || []).map(p => p.id));
  visiblePathKeys = new Set((path || []).map(p => pathKey(p.turnIndex, p.branchIndex)));
  visiblePathSigs = buildPathLineageSet(path || []);
}

function shouldRenderTurn(turn) {
  if (!turn) return false;
  const text = String(turn.text || '').trim();
  if (text) return true;
  return turn.role === 'user';
}

function sanitizeTurns(turns) {
  return (turns || []).filter(shouldRenderTurn);
}

function shouldKeepPathTurn(turn) {
  if (!turn) return false;
  return Boolean(turn.id || turn.role === 'user' || String(turn.text || '').trim());
}

function sanitizePathTurns(turns) {
  return (turns || []).filter(shouldKeepPathTurn);
}

function describeActivePathStatus(path) {
  const leaf = (path || []).at(-1);
  if (!leaf) return 'Navigation complete';
  return `Viewing turn ${leaf.turnIndex + 1}, branch ${leaf.branchIndex}`;
}

function mergeTurnsIntoTree(turns) {
  turns = sanitizeTurns(turns);
  if (!turns?.length) return;
  let parentId = null;
  for (const turn of turns) {
    const id = turn.id || `t${turn.turnIndex}_b${turn.branchIndex}`;
    const existing = treeNodes.get(id);
    const node = treeNodes.get(id) || {
      id,
      parentId,
      turnIndex: turn.turnIndex,
      branchIndex: turn.branchIndex,
      branchTotal: turn.branchTotal || 1,
      role: turn.role,
      text: turn.text || '',
      children: [],
    };

    const oldParentId = existing?.parentId ?? null;
    if (oldParentId && oldParentId !== parentId && treeNodes.has(oldParentId)) {
      const oldParent = treeNodes.get(oldParentId);
      oldParent.children = (oldParent.children || []).filter(childId => childId !== id);
    }

    node.parentId = parentId;
    node.turnIndex = turn.turnIndex;
    node.branchIndex = turn.branchIndex;
    node.branchTotal = Math.max(node.branchTotal || 1, turn.branchTotal || 1);
    node.role = turn.role;
    node.text = turn.text || node.text;
    if (!Array.isArray(node.children)) node.children = [];
    treeNodes.set(id, node);

    if (parentId && treeNodes.has(parentId)) {
      const parent = treeNodes.get(parentId);
      if (!parent.children.includes(id)) parent.children.push(id);
    }
    parentId = id;
  }
}

function replaceTreeWithTurns(turns) {
  const nextTree = new Map();
  turns = sanitizeTurns(turns);
  if (!turns?.length) {
    treeNodes = nextTree;
    updateTreeSummary();
    return;
  }
  let parentId = null;
  for (const turn of turns) {
    const id = turn.id || `t${turn.turnIndex}_b${turn.branchIndex}`;
    const node = {
      id,
      parentId,
      turnIndex: turn.turnIndex,
      branchIndex: turn.branchIndex,
      branchTotal: turn.branchTotal || 1,
      role: turn.role,
      text: turn.text || '',
      children: [],
    };
    nextTree.set(id, node);
    if (parentId && nextTree.has(parentId)) nextTree.get(parentId).children.push(id);
    parentId = id;
  }
  treeNodes = nextTree;
  updateTreeSummary();
}

function isNodeOnActivePath(node) {
  if (!node) return false;
  if (node.kind === 'cluster') {
    return (node.chainIds || []).some(id => {
      const original = treeNodes.get(id);
      return original && isNodeOnActivePath(original);
    });
  }
  return activePath.has(node.id) || activePathSigs.has(buildNodeLineageSig(node));
}

function isNodeVisible(node) {
  if (!node) return false;
  if (node.kind === 'cluster') {
    return (node.chainIds || []).some(id => {
      const original = treeNodes.get(id);
      return original && isNodeVisible(original);
    });
  }
  return visiblePath.has(node.id) || visiblePathSigs.has(buildNodeLineageSig(node));
}

function hasExpandedChains() {
  return expandedChainStarts.size > 0;
}

function updateExpandToggleButton() {
  const btn = document.getElementById('btn-expand-toggle');
  if (!btn) return;
  const expanded = hasExpandedChains();
  btn.title = expanded ? 'Collapse all chains' : 'Expand all chains';
  btn.classList.toggle('cbv-tool-fab-active', expanded);
  const label = btn.querySelector('span');
  if (label) label.textContent = expanded ? 'Collapse All' : 'Expand All';
  const icon = btn.querySelector('svg');
  if (icon) {
    icon.setAttribute('viewBox', '0 -960 960 960');
    icon.innerHTML = expanded
      ? '<path fill="currentColor" d="M480-297 364-181q-9 9-21 8.5t-21-9.5q-9-9-9-21.5t9-21.5l137-137q5-5 10-7t11-2q6 0 11 2t10 7l138 138q9 9 9 21t-9 21q-9 9-21.5 9t-21.5-9L480-297Zm0-366 116-116q9-9 21-8.5t21 9.5q9 9 9 21.5t-9 21.5L501-598q-5 5-10 7t-11 2q-6 0-11-2t-10-7L321-736q-9-9-8.5-21.5T322-779q9-9 21.5-9t21.5 9l115 116Z"/>'
      : '<path fill="currentColor" d="m480-208 114-114q9.13-9 22.07-9 12.93 0 21.93 9.1 9 9.11 9 22 0 12.9-9 21.9L501-141q-5 5-10.13 7-5.14 2-11 2-5.87 0-10.87-2-5-2-10-7L322-278q-9-9.13-9-22.07 0-12.93 9.1-21.93 9.11-9 22-9 12.9 0 21.9 9l114 114Zm0-540L366-634q-9.13 9-22.07 9-12.93 0-21.93-9.1-9-9.11-9-22 0-12.9 9-21.9l137-137q5-5 10.13-7 5.14-2 11-2 5.87 0 10.87 2 5 2 10 7l137 137q9 9.13 9 22.07 0 12.93-9.1 21.93-9.11 9-22 9-12.9 0-21.9-9L480-748Z"/>';
  }
  syncToolFabWidth(btn);
}

function setTreeCompleteness(mode) {
  treeCompleteness = mode;
  updateTreeCompletenessBadge();
  updateBuildButtonLabel();
  updateTreeSummary();
}

function updateTreeCompletenessBadge() {
  const el = document.getElementById('cbv-tree-state');
  if (!el) return;
  const cls = treeCompleteness === 'full'
    ? 'cbv-tree-state-full'
    : treeCompleteness === 'building'
    ? 'cbv-tree-state-building'
    : treeCompleteness === 'loading'
    ? 'cbv-tree-state-loading'
    : treeCompleteness === 'empty'
    ? 'cbv-tree-state-empty'
    : 'cbv-tree-state-partial';
  el.className = `cbv-tree-state ${cls}`;
  el.textContent = treeCompleteness === 'full'
    ? 'Full'
    : treeCompleteness === 'building'
    ? 'Building...'
    : treeCompleteness === 'loading'
    ? 'Loading...'
    : treeCompleteness === 'empty'
    ? 'Empty'
    : 'Partial';
  el.toggleAttribute('data-snapshot', treeCompleteness === 'full' && treeSource === 'snapshot');
  updatePartialBanner();
}

function updateTreeSummary() {
  const el = document.getElementById('cbv-tree-summary');
  if (!el) return;
  if (!treeNodes.size || treeCompleteness === 'building' || treeCompleteness === 'loading' || treeCompleteness === 'empty') {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const branchCount = countLeaves();
  el.hidden = false;
  el.textContent = `${treeNodes.size} nodes · ${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}`;
}

function updateBuildButtonLabel() {
  const btn = document.getElementById('btn-build');
  if (!btn) return;
  const label = btn.querySelector('span');
  if (label) label.textContent = treeCompleteness === 'full' ? 'Update Tree' : 'Build Full Tree';
  btn.classList.toggle('cbv-build-fab-attention', treeCompleteness === 'partial');
  btn.classList.toggle('cbv-tool-fab-pinned', treeCompleteness === 'empty' || treeCompleteness === 'partial' || (treeCompleteness === 'full' && treeSource === 'snapshot'));
  btn.title = treeCompleteness === 'full'
    ? 'Update the full tree by traversing branches again'
    : 'Build full tree by traversing all branches';
  syncToolFabWidth(btn);
}

function getToolFabMeasureCanvas() {
  if (!toolFabMeasureCanvas) toolFabMeasureCanvas = document.createElement('canvas');
  return toolFabMeasureCanvas;
}

function measureToolFabLabelWidth(button) {
  const label = button?.querySelector('span');
  if (!label) return 0;
  const text = (label.textContent || '').trim();
  if (!text) return 0;

  const ctx = getToolFabMeasureCanvas().getContext('2d');
  if (!ctx) return Math.ceil(label.scrollWidth || 0);

  const style = window.getComputedStyle(button);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return Math.ceil(ctx.measureText(text).width);
}

function syncToolFabWidth(button) {
  if (!button || button.classList.contains('cbv-menu-trigger')) return;
  const labelWidth = measureToolFabLabelWidth(button);
  const collapsedWidth = 34;
  const horizontalPadding = labelWidth > 0 ? 12 : 0;
  const gap = labelWidth > 0 ? 5 : 0;
  const extraBuffer = 1;
  const expandedWidth = Math.max(collapsedWidth, collapsedWidth + labelWidth + gap + horizontalPadding + extraBuffer);
  button.style.setProperty('--cbv-tool-label-max-width', `${labelWidth}px`);
  button.style.setProperty('--cbv-tool-expand-width', `${expandedWidth}px`);
}

function syncAllToolFabWidths() {
  document.querySelectorAll('.cbv-tool-fab').forEach(syncToolFabWidth);
}

function updatePartialBanner() {
  const el = document.getElementById('cbv-partial-banner');
  if (!el) return;
  el.hidden = treeCompleteness !== 'partial';
}

function maybeStartBuild() {
  try {
    if (localStorage.getItem('cbv-skip-build-warning') === '1') return sendToContent({ type: 'BUILD' });
  } catch (_) {}
  const modal = document.getElementById('cbv-build-modal');
  if (modal) modal.hidden = false;
}

function closeBuildModal() {
  const modal = document.getElementById('cbv-build-modal');
  if (modal) modal.hidden = true;
}

function confirmBuild() {
  try {
    if (document.getElementById('cbv-skip-build-warning')?.checked) localStorage.setItem('cbv-skip-build-warning', '1');
  } catch (_) {}
  closeBuildModal();
  sendToContent({ type: 'BUILD' });
}

function showTreeLoading(text = 'Updating tree…', subtext = '', mode = 'transient') {
  const el = document.getElementById('cbv-loading');
  const label = document.getElementById('cbv-loading-text');
  const sub = document.getElementById('cbv-loading-subtext');
  clearTimeout(treeLoadingTimer);
  treeLoadingMode = mode;
  treeLoadingShownAt = Date.now();
  if (label) label.textContent = text;
  if (sub) sub.textContent = subtext;
  if (el) el.hidden = false;
  if (mode !== 'build') {
    treeLoadingTimer = setTimeout(() => hideTreeLoading(true), 7000);
  }
}

function resetTreeState() {
  treeNodes.clear();
  activePath.clear();
  activePathKeys.clear();
  activePathSigs.clear();
  visiblePath.clear();
  visiblePathKeys.clear();
  visiblePathSigs.clear();
  renderedNodes.clear();
  renderedExpandedGroups = [];
  expandedChainStarts.clear();
  layoutMap.clear();
  treeCompleteness = 'empty';
  treeSource = 'live';
  treeDataUrl = currentPageUrl || '';
  lastDiagnostics = null;
  document.getElementById('cbv-canvas')?.remove();
  const emptyEl = document.getElementById('cbv-empty');
  if (emptyEl) emptyEl.style.display = '';
  setSupportedPageEmptyState(isSupportedPlatform(currentPlatform) ? 'supported' : 'unsupported');
  updateTreeSummary();
  updateExpandToggleButton();
  updateDiagnosticsActions();
}

function isSupportedPlatform(platform) {
  return platform === 'chatgpt' || platform === 'claude';
}

function setSupportedPageEmptyState(mode = 'supported') {
  const titleEl = document.getElementById('cbv-empty-title');
  const subEl = document.getElementById('cbv-empty-sub');
  if (!titleEl || !subEl) return;
  if (mode === 'unsupported') {
    titleEl.textContent = 'Unsupported page';
    subEl.innerHTML = 'Branch Visualizer only works on <strong>ChatGPT</strong> and <strong>Claude</strong> chat pages.';
    return;
  }
  if (mode === 'empty') {
    titleEl.textContent = 'No active tab';
    subEl.innerHTML = 'Select a <strong>ChatGPT</strong> or <strong>Claude</strong> chat to view its branch tree.';
    return;
  }
  titleEl.textContent = 'No conversation tree yet';
  subEl.innerHTML = 'Open a ChatGPT or Claude chat,<br>then click <strong>Build</strong>.';
}

function hideTreeLoading(force = false) {
  if (!force && treeLoadingMode === 'build') return;
  if (!force && treeLoadingMode !== 'idle') {
    const elapsed = Date.now() - treeLoadingShownAt;
    if (elapsed < 420) {
      clearTimeout(treeLoadingTimer);
      treeLoadingTimer = setTimeout(() => hideTreeLoading(true), 420 - elapsed);
      return;
    }
  }
  clearTimeout(treeLoadingTimer);
  treeLoadingTimer = null;
  treeLoadingMode = 'idle';
  const el = document.getElementById('cbv-loading');
  const sub = document.getElementById('cbv-loading-subtext');
  if (sub) sub.textContent = '';
  if (el) el.hidden = true;
}

function toggleExpandCollapseAll() {
  if (hasExpandedChains()) collapseAllChains();
  else expandAllChains();
}

function setExpandedByDefaultForPartial() {
  if (treeCompleteness !== 'partial') return;
  const next = new Set();
  treeNodes.forEach(node => {
    const chain = collectCollapsibleChain(node.id);
    if (chain.length) next.add(chain[0]);
  });
  expandedChainStarts = next;
  updateExpandToggleButton();
}

function collapseByDefault() {
  expandedChainStarts.clear();
  forceCollapseAll = true;
  renderTree();
  forceCollapseAll = false;
  updateExpandToggleButton();
}

function toggleChainExpansion(startId) {
  if (!startId) return;
  if (expandedChainStarts.has(startId)) expandedChainStarts.delete(startId);
  else expandedChainStarts.add(startId);
  renderTree();
  updateExpandToggleButton();
}

function expandAllChains() {
  const next = new Set();
  treeNodes.forEach(node => {
    const chain = collectCollapsibleChain(node.id);
    if (chain.length) next.add(chain[0]);
  });
  expandedChainStarts = next;
  renderTree();
  updateExpandToggleButton();
  requestAnimationFrame(() => fitView(false));
}

function collapseAllChains() {
  expandedChainStarts.clear();
  forceCollapseAll = true;
  renderTree();
  forceCollapseAll = false;
  updateExpandToggleButton();
  requestAnimationFrame(() => fitView(false));
}

function collectCollapsibleChain(startId) {
  const start = treeNodes.get(startId);
  if (!start || !start.parentId) return [];

  const ids = [];
  let current = start;
  while (
    current &&
    current.parentId &&
    current.branchTotal === 1 &&
    current.children.length === 1
  ) {
    ids.push(current.id);
    const nextId = current.children[0];
    const next = treeNodes.get(nextId);
    if (
      !next ||
      next.branchTotal !== 1 ||
      next.children.length !== 1
    ) break;
    current = next;
  }

  return ids.length >= 2 ? ids : [];
}

function summarizeChain(chainIds) {
  const first = treeNodes.get(chainIds[0]);
  const last = treeNodes.get(chainIds[chainIds.length - 1]);
  if (!first || !last) return `${chainIds.length} hidden steps`;
  const turnLabel = first.turnIndex === last.turnIndex
    ? `T${first.turnIndex + 1}`
    : `T${first.turnIndex + 1}-${last.turnIndex + 1}`;
  return `${chainIds.length} hidden steps · ${turnLabel}`;
}

function buildDisplayGraph() {
  const nodes = new Map();
  const roots = [];
  const expandedGroups = [];

  function attachNode(displayNode, parentDisplayId) {
    nodes.set(displayNode.id, displayNode);
    if (parentDisplayId) {
      const parent = nodes.get(parentDisplayId);
      if (parent) parent.children.push(displayNode.id);
    } else {
      roots.push(displayNode.id);
    }
    return displayNode.id;
  }

  function attachOriginalNode(originalId, parentDisplayId) {
    const original = treeNodes.get(originalId);
    if (!original) return null;
    return attachNode({ ...original, kind: 'message', originalId, children: [] }, parentDisplayId);
  }

  function walk(originalId, parentDisplayId) {
    const original = treeNodes.get(originalId);
    if (!original) return;

    const chain = collectCollapsibleChain(originalId);
    if (chain.length) {
      const startId = chain[0];
      const endId = chain[chain.length - 1];

      if (!expandedChainStarts.has(startId)) {
        const first = treeNodes.get(startId);
        const last = treeNodes.get(endId);
        const clusterId = `cluster:${startId}`;
        attachNode({
          id: clusterId,
          kind: 'cluster',
          originalId: startId,
          startId,
          endId,
          chainIds: chain,
          count: chain.length,
          role: first?.role || 'assistant',
          turnIndex: first?.turnIndex || 0,
          branchIndex: 1,
          branchTotal: 1,
          text: summarizeChain(chain),
          children: [],
        }, parentDisplayId);

        const tail = last ? last.children : [];
        tail.forEach(childId => walk(childId, clusterId));
        return;
      }

      let previousId = parentDisplayId;
      chain.forEach(chainId => {
        previousId = attachOriginalNode(chainId, previousId);
      });
      expandedGroups.push({ startId, chainIds: [...chain], displayIds: [...chain] });
      const last = treeNodes.get(endId);
      (last?.children || []).forEach(childId => walk(childId, previousId));
      return;
    }

    const displayId = attachOriginalNode(originalId, parentDisplayId);
    original.children.forEach(childId => walk(childId, displayId));
  }

  [...treeNodes.values()]
    .filter(n => !n.parentId || !treeNodes.has(n.parentId))
    .forEach(root => walk(root.id, null));

  return { nodes, roots, expandedGroups };
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderTree() {
  const container = document.getElementById('cbv-tree');
  if (!container) return;

  const emptyEl = document.getElementById('cbv-empty');
  if (treeNodes.size === 0) {
    if (emptyEl) emptyEl.style.display = '';
    const old = document.getElementById('cbv-canvas');
    if (old) old.remove();
    layoutMap.clear();
    renderedNodes.clear();
    renderedExpandedGroups = [];
    updateExpandToggleButton();
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // ── CSS token reads (theme-aware) ───────────────────────────────────────
  const C = {
    nodeFillU:         cssVar('--node-fill-u'),
    nodeFillA:         cssVar('--node-fill-a'),
    nodeFillActiveU:   cssVar('--node-fill-active-u'),
    nodeFillActiveA:   cssVar('--node-fill-active-a'),
    nodeStroke:        cssVar('--node-stroke'),
    nodeStrokeActiveU: cssVar('--node-stroke-active-u'),
    nodeStrokeActiveA: cssVar('--node-stroke-active-a'),
    nodeTx:            cssVar('--node-tx'),
    nodeTxMuted:       cssVar('--node-tx-muted'),
    tagBgU:            cssVar('--bg-tag-u'),
    tagBgA:            cssVar('--bg-tag-a'),
    tagTxU:            cssVar('--tx-tag-u'),
    tagTxA:            cssVar('--tx-tag-a'),
    badgeBg:           cssVar('--bg-badge'),
    badgeTx:           cssVar('--tx-badge'),
    edge:              cssVar('--edge-color'),
    edgeActiveU:       cssVar('--edge-active-u'),
    edgeActiveA:       cssVar('--edge-active-a'),
    visible:           '#d4a017',
  };

  const graph = buildDisplayGraph();
  const renderNodes = graph.nodes;
  const roots = graph.roots.map(id => renderNodes.get(id)).filter(Boolean);
  renderedNodes = renderNodes;
  renderedExpandedGroups = graph.expandedGroups || [];

  // ── 2. Layout into module-scope layoutMap ─────────────────────────────────
  layoutMap.clear();

  const mode = getNodeMode();
  const nw = NW(), nh = NH(), hgap = H_GAP(), vgap = V_GAP();

  function subtreeW(id) {
    const n = renderNodes.get(id);
    if (!n) return nw;
    const kids = n.children.map(c => renderNodes.get(c)).filter(Boolean);
    if (!kids.length) { layoutMap.set(id, { w: nw }); return nw; }
    let total = kids.reduce((s, k, i) => s + subtreeW(k.id) + (i > 0 ? hgap : 0), 0);
    total = Math.max(total, nw);
    layoutMap.set(id, { w: total });
    return total;
  }

  function assign(id, left, depth) {
    const n = renderNodes.get(id);
    if (!n) return;
    const info = layoutMap.get(id) || { w: nw };
    info.x = left + info.w / 2;
    info.y = PAD + depth * (nh + vgap);
    layoutMap.set(id, info);
    const kids = n.children.map(c => renderNodes.get(c)).filter(Boolean);
    let c = left;
    kids.forEach((k, i) => {
      if (i > 0) c += hgap;
      assign(k.id, c, depth + 1);
      c += layoutMap.get(k.id)?.w ?? nw;
    });
  }

  let c = PAD;
  roots.forEach((r, i) => {
    subtreeW(r.id);
    if (i > 0) c += hgap * 2;
    assign(r.id, c, 0);
    c += layoutMap.get(r.id)?.w ?? nw;
  });

  // ── 3. Canvas bounds ──────────────────────────────────────────────────────
  let maxX = 0, maxY = 0;
  layoutMap.forEach(({ x, y }) => {
    maxX = Math.max(maxX, x + nw / 2 + PAD);
    maxY = Math.max(maxY, y + nh + PAD);
  });

  // ── 4. Build SVG ──────────────────────────────────────────────────────────
  const NS  = 'http://www.w3.org/2000/svg';
  const svg = el(NS, 'svg', { width: maxX, height: maxY });

  // Edges
  const edgeG = el(NS, 'g');
  renderNodes.forEach(node => {
    const pi = layoutMap.get(node.id);
    if (!pi) return;
    node.children.forEach(cid => {
      const child = renderNodes.get(cid);
      const ci    = layoutMap.get(cid);
      if (!ci || !child) return;
      // Connect bottom-center of parent to top-center of child
      const x1 = pi.x, y1 = pi.y + nh, x2 = ci.x, y2 = ci.y;
      const my = (y1 + y2) / 2;
      const both   = isNodeOnActivePath(node) && isNodeOnActivePath(child);
      const bothVisible = isNodeVisible(node) && isNodeVisible(child);
      const isUser = child.role === 'user';
      edgeG.appendChild(el(NS, 'path', {
        d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`,
        fill: 'none',
        stroke: both ? (isUser ? C.edgeActiveU : C.edgeActiveA) : bothVisible ? C.visible : C.edge,
        'stroke-width': both ? '2.4' : bothVisible ? '1.9' : '1.5',
        'stroke-linecap': 'round',
        opacity: both ? '1' : bothVisible ? '0.98' : '0.72',
      }));
    });
  });
  svg.appendChild(edgeG);

  const braceG = el(NS, 'g');
  renderedExpandedGroups.forEach(group => {
    const infos = group.displayIds.map(id => layoutMap.get(id)).filter(Boolean);
    if (infos.length < 2) return;
    const top = infos[0].y;
    const bottom = infos[infos.length - 1].y + nh;
    const left = Math.min(...infos.map(info => info.x - nw / 2)) - 16;
    const mid = (top + bottom) / 2;
    const visible = group.chainIds.some(id => isNodeVisible(treeNodes.get(id)));
    const stroke = visible ? C.visible : cssVar('--node-stroke');
    const hook = 12;

    braceG.appendChild(el(NS, 'path', {
      d: `M${left + 10},${top} Q${left},${top} ${left},${top + hook} L${left},${bottom - hook} Q${left},${bottom} ${left + 10},${bottom}`,
      fill: 'none',
      stroke,
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      opacity: visible ? '0.95' : '0.78',
    }));

    const bx = left + 3;
    const by = top + 10;
    const btn = el(NS, 'g', { class: 'node-g' });
    btn.appendChild(el(NS, 'circle', {
      cx: bx, cy: by, r: '7',
      fill: cssVar('--bg-app'),
      stroke,
      'stroke-width': '1.2',
    }));
    btn.appendChild(svgText(bx, by + 0.5, '−', {
      fill: stroke,
      'font-size': '11', 'font-weight': '700',
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-family': 'ui-monospace, monospace',
    }));
    const hit = el(NS, 'circle', { cx: bx, cy: by, r: '10', fill: 'transparent' });
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => toggleChainExpansion(group.startId));
    btn.appendChild(hit);
    braceG.appendChild(btn);
  });
  svg.appendChild(braceG);

  // Nodes
  const nodeG = el(NS, 'g');
  renderNodes.forEach(node => {
    const info = layoutMap.get(node.id);
    if (!info) return;

    const isCluster = node.kind === 'cluster';
    const isActive = isNodeOnActivePath(node);
    const isVisible = isNodeVisible(node);
    const isUser   = node.role === 'user';
    const badgeKind = isCluster ? 'cluster' : isUser ? 'user' : assistantBrand();
    // Top-left corner of node rect
    const nx = info.x - nw / 2;
    const ny = info.y;
    const clusterActiveStroke = cssVar('--bd-strong') || C.nodeStroke;
    const accentColor = isCluster
      ? (isActive ? clusterActiveStroke : C.nodeStroke)
      : (isUser ? C.edgeActiveU : C.edgeActiveA);
    const fill = isCluster
      ? cssVar('--bg-btn')
      : isActive ? (isUser ? C.nodeFillActiveU : C.nodeFillActiveA)
      : (isUser ? C.nodeFillU : C.nodeFillA);
    const stroke = isCluster
      ? (isActive ? clusterActiveStroke : C.nodeStroke)
      : isActive ? (isUser ? C.nodeStrokeActiveU : C.nodeStrokeActiveA)
      : C.nodeStroke;

    const g = el(NS, 'g', { class: 'node-g', opacity: isActive ? '1' : isVisible ? '0.96' : '0.82' });
    const visibleStroke = C.visible;

    if (mode === 'mini') {
      const pr = 6;
      if (isVisible && !isActive) {
        g.appendChild(el(NS, 'rect', {
          x: nx - 2, y: ny - 2, width: nw + 4, height: nh + 4,
          rx: pr + 2, ry: pr + 2,
          fill: visibleStroke, opacity: '0.08',
        }));
      }
      if (isVisible) {
        g.appendChild(el(NS, 'rect', {
          class: 'cbv-visible-pulse',
          x: nx - 3, y: ny - 3, width: nw + 6, height: nh + 6,
          rx: pr + 3, ry: pr + 3,
          fill: 'none', stroke: visibleStroke, 'stroke-width': isActive ? '1.5' : '1.25',
        }));
      }
      const box = el(NS, 'rect', {
        class: 'node-box',
        x: nx, y: ny, width: nw, height: nh,
        rx: pr, ry: pr,
        fill, stroke, 'stroke-width': isActive ? '1.25' : '1',
      });
      g.appendChild(box);

      g.appendChild(el(NS, 'rect', {
        x: nx, y: ny, width: isActive ? 4 : 3, height: nh,
        rx: pr, ry: pr,
        fill: accentColor,
      }));

      appendNodeBadge(g, nx + 13, ny + nh / 2, badgeKind, isActive);

      g.appendChild(svgText(nx + 24, ny + nh / 2 + 0.5, isCluster ? `+${node.count}` : `${node.turnIndex + 1}`, {
        fill: isActive ? C.nodeTx : C.nodeTxMuted,
        'font-size': '8', 'font-weight': '700',
        'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }));

      if (!isCluster && node.branchTotal > 1) {
        g.appendChild(svgText(nx + nw - 8, ny + nh / 2 + 0.5, `${node.branchIndex}`, {
          fill: C.badgeTx,
          'font-size': '8', 'font-weight': '700',
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-family': 'ui-monospace, monospace',
        }));
      }

      const hit = el(NS, 'rect', {
        x: nx - 3, y: ny - 3, width: nw + 6, height: nh + 6,
        rx: pr + 3, ry: pr + 3, fill: 'transparent',
      });
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => isCluster ? toggleChainExpansion(node.startId) : navigateTo(node.id));
      hit.addEventListener('mouseenter', () => {
        box.setAttribute('stroke', accentColor);
        box.setAttribute('stroke-width', '1.75');
        showTooltip(node, info.x, ny);
      });
      hit.addEventListener('mouseleave', () => {
        box.setAttribute('stroke', stroke);
        box.setAttribute('stroke-width', isActive ? '1.25' : '1');
        hideTooltip();
      });
      g.appendChild(hit);

    } else if (mode === 'compact') {
      // ── Compact pill mode ────────────────────────────────────────────────
      const pr = nh / 2; // pill radius

      // Glow for active
      if (isActive) {
        g.appendChild(el(NS, 'rect', {
          x: nx - 2, y: ny - 2, width: nw + 4, height: nh + 4,
          rx: pr + 2, ry: pr + 2,
          fill: accentColor, opacity: '0.15',
        }));
      } else if (isVisible) {
        g.appendChild(el(NS, 'rect', {
          x: nx - 2, y: ny - 2, width: nw + 4, height: nh + 4,
          rx: pr + 2, ry: pr + 2,
          fill: visibleStroke, opacity: '0.08',
        }));
      }
      if (isVisible) {
        g.appendChild(el(NS, 'rect', {
          class: 'cbv-visible-pulse',
          x: nx - 3, y: ny - 3, width: nw + 6, height: nh + 6,
          rx: pr + 3, ry: pr + 3,
          fill: 'none', stroke: visibleStroke, 'stroke-width': isActive ? '1.7' : '1.35',
        }));
      }

      const box = el(NS, 'rect', {
        class: 'node-box',
        x: nx, y: ny, width: nw, height: nh,
        rx: pr, ry: pr,
        fill, stroke, 'stroke-width': isActive ? '1.5' : '1',
      });
      g.appendChild(box);

      // Dot indicator
      appendNodeBadge(g, nx + 14, ny + nh / 2, badgeKind, isActive);

      // Role + Turn label
      const turnLabel = isCluster ? `+${node.count}` : `${node.turnIndex + 1}`;
      g.appendChild(svgText(nx + 26, ny + nh / 2 + 0.5, turnLabel, {
        fill: isActive ? C.nodeTx : C.nodeTxMuted,
        'font-size': '9', 'font-weight': '700',
        'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }));

      // Text snippet (truncated to fit remaining width)
      const snippetX = nx + 42;
      const snippet = truncateToWidth(node.text || '', isCluster ? 10 : 14);
      if (snippet) {
        const snippetClipId = `pill-clip-${node.id.replace(/[^a-z0-9]/gi, '')}`;
        const defs = el(NS, 'defs');
        const clipPath = el(NS, 'clipPath', { id: snippetClipId });
        clipPath.appendChild(el(NS, 'rect', {
          x: snippetX, y: ny + 4, width: nw - 46, height: nh - 8,
          rx: pr - 2, ry: pr - 2,
        }));
        defs.appendChild(clipPath);
        g.appendChild(defs);

        const snippetText = svgText(snippetX, ny + nh / 2 + 0.5, snippet, {
          fill: C.nodeTxMuted,
          'font-size': '9',
          'dominant-baseline': 'middle',
          'font-family': 'ui-sans-serif, system-ui, sans-serif',
          'clip-path': `url(#${snippetClipId})`,
        });
        g.appendChild(snippetText);
      }

      // Hit area
      const hit = el(NS, 'rect', {
        x: nx - 4, y: ny - 4, width: nw + 8, height: nh + 8,
        rx: pr + 4, ry: pr + 4, fill: 'transparent',
      });
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => isCluster ? toggleChainExpansion(node.startId) : navigateTo(node.id));
      hit.addEventListener('mouseenter', () => {
        box.setAttribute('stroke', accentColor);
        box.setAttribute('stroke-width', '2');
        showTooltip(node, info.x, ny);
      });
      hit.addEventListener('mouseleave', () => {
        box.setAttribute('stroke', stroke);
        box.setAttribute('stroke-width', isActive ? '1.5' : '1');
        hideTooltip();
      });
      g.appendChild(hit);

    } else {
      // ── Card mode ────────────────────────────────────────────────────────
      const rx = 8;
      const accentBarW = isActive ? 4 : 3;

      if (isVisible && !isActive) {
        g.appendChild(el(NS, 'rect', {
          x: nx - 2, y: ny - 2, width: nw + 4, height: nh + 4,
          rx, ry: rx,
          fill: visibleStroke, opacity: '0.06',
        }));
      }
      if (isVisible) {
        g.appendChild(el(NS, 'rect', {
          class: 'cbv-visible-pulse',
          x: nx - 3, y: ny - 3, width: nw + 6, height: nh + 6,
          rx: rx + 2, ry: rx + 2,
          fill: 'none', stroke: visibleStroke, 'stroke-width': isActive ? '1.8' : '1.4',
        }));
      }

      // Drop shadow
      g.appendChild(el(NS, 'rect', {
        x: nx + 2, y: ny + 3, width: nw, height: nh,
        rx, ry: rx,
        fill: '#000', opacity: isActive ? '0.10' : '0.05',
        style: 'filter:blur(4px)',
      }));

      // Card body
      const box = el(NS, 'rect', {
        class: 'node-box',
        x: nx, y: ny, width: nw, height: nh,
        rx, ry: rx,
        fill, stroke, 'stroke-width': isActive ? '1.5' : '1',
      });
      g.appendChild(box);

      // Left accent bar (clip to card shape)
      const barClipId = `bar-clip-${node.id.replace(/[^a-z0-9]/gi, '')}`;
      const defs = el(NS, 'defs');
      const clipPath = el(NS, 'clipPath', { id: barClipId });
      clipPath.appendChild(el(NS, 'rect', {
        x: nx, y: ny, width: nw, height: nh, rx, ry: rx,
      }));
      defs.appendChild(clipPath);
      g.appendChild(defs);

      g.appendChild(el(NS, 'rect', {
        x: nx, y: ny, width: accentBarW, height: nh,
        fill: accentColor,
        'clip-path': `url(#${barClipId})`,
      }));

      // ── Kicker row (role dot + role name + turn + branch badge) ──────────
      const kickerY = ny + 15;
      const textX   = nx + accentBarW + 8;

      // Role dot
      appendNodeBadge(g, textX + 1, kickerY - 1, badgeKind, isActive);

      // Role label
      const roleLabel = isCluster ? 'Collapsed' : (isUser ? 'User' : assistantDisplayName());
      g.appendChild(svgText(textX + 12, kickerY, roleLabel, {
        fill: C.nodeTxMuted,
        'font-size': '9', 'font-weight': '700',
        'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
        'letter-spacing': '0.03em',
      }));

      // Turn number
      const turnStr = isCluster ? `+${node.count}` : `T${node.turnIndex + 1}`;
      g.appendChild(svgText(textX + 56, kickerY, turnStr, {
        fill: C.nodeTxMuted,
        'font-size': '9', 'font-weight': '600',
        'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }));

      // Branch badge (only when branching)
      if (!isCluster && node.branchTotal > 1) {
        const badgeLabel = `${node.branchIndex}/${node.branchTotal}`;
        const badgeX = nx + nw - 6;
        const badgeY = ny + 12;
        const badgeW = badgeLabel.length <= 3 ? 20 : 26;
        g.appendChild(el(NS, 'rect', {
          x: badgeX - badgeW, y: badgeY - 8, width: badgeW, height: 13,
          rx: '4', ry: '4',
          fill: C.badgeBg,
        }));
        g.appendChild(svgText(badgeX - badgeW / 2, badgeY + 0.5, badgeLabel, {
          fill: C.badgeTx,
          'font-size': '8', 'font-weight': '700',
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-family': 'ui-monospace, monospace',
        }));
      }

      // ── Divider line ─────────────────────────────────────────────────────
      g.appendChild(el(NS, 'line', {
        x1: nx + accentBarW, y1: ny + 22, x2: nx + nw, y2: ny + 22,
        stroke: C.nodeStroke, 'stroke-width': '0.5',
      }));

      // ── Text preview (1-2 lines) ─────────────────────────────────────────
      const previewX = textX;
      const previewMaxW = nw - accentBarW - 14;
      const previewLines = wrapSnippet(node.text || '', isCluster ? 1 : 2, Math.floor((previewMaxW - 2) / 6.2));
      if (previewLines.length > 0 && previewLines[0]) {
        const previewClipId = `preview-clip-${node.id.replace(/[^a-z0-9]/gi, '')}`;
        const previewDefs = el(NS, 'defs');
        const clipPath = el(NS, 'clipPath', { id: previewClipId });
        clipPath.appendChild(el(NS, 'rect', {
          x: previewX, y: ny + 26, width: nw - accentBarW - 12, height: nh - 28,
          rx: 2, ry: 2,
        }));
        previewDefs.appendChild(clipPath);
        g.appendChild(previewDefs);

        const previewText = svgMultilineText(previewX, ny + 33, previewLines, {
          fill: isActive ? C.nodeTx : C.nodeTxMuted,
          'font-size': '10',
          'dominant-baseline': 'hanging',
          'font-family': 'ui-sans-serif, system-ui, sans-serif',
          'clip-path': `url(#${previewClipId})`,
        }, 12);
        g.appendChild(previewText);
      } else {
        // Empty message placeholder
        g.appendChild(svgText(previewX, ny + 33, '—', {
          fill: C.nodeTxMuted, 'font-size': '10',
          'dominant-baseline': 'hanging',
          'font-family': 'ui-sans-serif, system-ui, sans-serif',
        }));
      }

      // Hit area
      const hit = el(NS, 'rect', {
        x: nx - 2, y: ny - 2, width: nw + 4, height: nh + 4,
        rx: rx + 2, ry: rx + 2, fill: 'transparent',
      });
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => isCluster ? toggleChainExpansion(node.startId) : navigateTo(node.id));
      hit.addEventListener('mouseenter', () => {
        box.setAttribute('stroke', accentColor);
        box.setAttribute('stroke-width', '2');
        showTooltip(node, info.x, ny);
      });
      hit.addEventListener('mouseleave', () => {
        box.setAttribute('stroke', stroke);
        box.setAttribute('stroke-width', isActive ? '1.5' : '1');
        hideTooltip();
      });
      g.appendChild(hit);
    }

    nodeG.appendChild(g);
  });
  svg.appendChild(nodeG);

  // ── 5. Mount ──────────────────────────────────────────────────────────────
  let canvas = document.getElementById('cbv-canvas');
  if (!canvas) {
    canvas = document.createElement('div');
    canvas.id = 'cbv-canvas';
    container.appendChild(canvas);
  }
  canvas.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform;';
  canvas.innerHTML = '';
  canvas.appendChild(svg);
  applyTransform();
  renderMinimap();
}

// ── Pan + Zoom ────────────────────────────────────────────────────────────────
function initInteraction() {
  const tree = document.getElementById('cbv-tree');

  function localPoint(e) {
    const r = tree.getBoundingClientRect();
    const x = Number.isFinite(e.clientX) ? e.clientX : r.left + r.width / 2;
    const y = Number.isFinite(e.clientY) ? e.clientY : r.top + r.height / 2;
    return { x: x - r.left, y: y - r.top };
  }

  function handleWheelGesture(e) {
    e.preventDefault();
    const p = localPoint(e);

    if (e.altKey || e.shiftKey) {
      const dx = e.deltaMode === 1 ? e.deltaX * 20 : e.deltaX;
      const dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      cam.x -= dx;
      cam.y -= dy;
      applyTransform();
      renderMinimap();
      return;
    }

    const raw = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
    const factor = Math.pow(1.01, -raw);
    zoomAt(p.x, p.y, factor);
  }

  function handleGestureStart(e) {
    e.preventDefault();
    const p = localPoint(e);
    gestureBaseScale = cam.scale;
    gestureCenter = { x: p.x, y: p.y };
  }

  function handleGestureChange(e) {
    if (!gestureCenter || gestureBaseScale == null) return;
    e.preventDefault();
    zoomToAbsolute(gestureCenter.x, gestureCenter.y, gestureBaseScale * e.scale);
  }

  function handleGestureEnd(e) {
    if (gestureBaseScale == null && !gestureCenter) return;
    e.preventDefault();
    gestureBaseScale = null;
    gestureCenter = null;
  }

  // ── Wheel / trackpad ──────────────────────────────────────────────────────
  // Chrome sends wheel events for both trackpad scroll and pinch-to-zoom.
  // Key distinction: pinch sets e.ctrlKey = true; two-finger scroll does not.
  //
  // Desired behaviour:
  //   • Two-finger wheel / trackpad       → zoom centred on cursor
  //   • Alt/Shift + wheel                 → pan
  //   • Drag                             → pan
  window.addEventListener('wheel', handleWheelGesture, { passive: false, capture: true });

  // ── Mouse drag pan ────────────────────────────────────────────────────────
  tree.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.node-g')) return;
    isPanning = true;
    panStart  = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    tree.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    cam.x = panStart.cx + (e.clientX - panStart.x);
    cam.y = panStart.cy + (e.clientY - panStart.y);
    applyTransform();
    renderMinimap();
  });
  window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    tree.style.cursor = 'grab';
  });

  // ── Touch (physical touchscreen, not trackpad) ────────────────────────────
  // 1-finger → pan; 2-finger → pinch zoom.
  // {passive:false} on touchstart/touchmove so we can call preventDefault.
  tree.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      isPanning = true;
      panStart  = { x: e.touches[0].clientX, y: e.touches[0].clientY, cx: cam.x, cy: cam.y };
    } else if (e.touches.length === 2) {
      isPanning = false;
      lastPinch = pinchDist(e.touches);
      e.preventDefault();
    }
  }, { passive: false });

  tree.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && isPanning) {
      cam.x = panStart.cx + (e.touches[0].clientX - panStart.x);
      cam.y = panStart.cy + (e.touches[0].clientY - panStart.y);
      applyTransform();
      renderMinimap();
    } else if (e.touches.length === 2 && lastPinch != null) {
      e.preventDefault();
      const d  = pinchDist(e.touches);
      const r  = tree.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      zoomAt(cx, cy, d / lastPinch);
      lastPinch = d;
      renderMinimap();
    }
  }, { passive: false });

  tree.addEventListener('touchend', () => {
    isPanning = false;
    lastPinch = null;
  }, { passive: true });

  // macOS trackpad pinch fallback.
  // Some Chrome/WebView surfaces emit gesture* events instead of wheel+ctrlKey.
  window.addEventListener('gesturestart', handleGestureStart, { passive: false, capture: true });
  window.addEventListener('gesturechange', handleGestureChange, { passive: false, capture: true });
  window.addEventListener('gestureend', handleGestureEnd, { passive: false, capture: true });

  tree.style.cursor = 'grab';

  // ── Minimap click → pan to that region ───────────────────────────────────
  initMinimapClick();

  window.addEventListener('resize', () => {
    if (!treeNodes.size) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitView(false), 90);
  });
}

function pinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function onZoomSliderInput(e) {
  const tree = document.getElementById('cbv-tree');
  if (!tree) return;
  const next = sliderValueToScale(Number(e.target.value));
  const px = tree.clientWidth - 56;
  const py = tree.clientHeight / 2;
  zoomToAbsolute(px, py, next);
}

function sliderValueToScale(value) {
  const t = Math.max(0, Math.min(100, value)) / 100;
  const min = Math.log(ZOOM_MIN);
  const max = Math.log(ZOOM_MAX);
  return Math.exp(min + (max - min) * t);
}

function scaleToSliderValue(scale) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  const min = Math.log(ZOOM_MIN);
  const max = Math.log(ZOOM_MAX);
  return ((Math.log(clamped) - min) / (max - min)) * 100;
}

function syncZoomSlider() {
  const slider = document.getElementById('cbv-zoom-slider');
  const output = document.getElementById('cbv-zoom-value');
  if (slider) slider.value = String(Math.round(scaleToSliderValue(cam.scale)));
  if (output) output.textContent = `${Math.round(cam.scale * 100)}%`;
}

function showTooltip(node, svgX, svgY) {
  const tip = document.getElementById('cbv-tooltip');
  const tree = document.getElementById('cbv-tree');
  if (!tip || !tree) return;
  const left = Math.min(tree.clientWidth - 272, svgX * cam.scale + cam.x + 18);
  const top = Math.max(12, svgY * cam.scale + cam.y - 6);
  if (node.kind === 'cluster') {
    const start = treeNodes.get(node.startId);
    const end = treeNodes.get(node.endId);
    tip.innerHTML = `<div class="cbv-tooltip-kicker"><span class="cbv-tooltip-dot" style="background:${cssVar('--node-stroke')}"></span>Collapsed chain · ${node.count} steps</div><div class="cbv-tooltip-text">${escapeHtml(start?.text || '')}${end?.text ? `<br><br><strong>Last:</strong> ${escapeHtml(end.text)}` : ''}<br><br><em>Click to expand</em></div>`;
  } else {
    const color = node.role === 'user' ? cssVar('--edge-active-u') : cssVar('--edge-active-a');
    const role = node.role === 'user' ? 'User' : 'Assistant';
    tip.innerHTML = `<div class="cbv-tooltip-kicker"><span class="cbv-tooltip-dot" style="background:${color}"></span>${role} · Turn ${node.turnIndex + 1}${node.branchTotal > 1 ? ` · ${node.branchIndex}/${node.branchTotal}` : ''}</div><div class="cbv-tooltip-text">${escapeHtml(node.text || '')}</div>`;
  }
  tip.style.left = `${Math.max(12, left)}px`;
  tip.style.top = `${top}px`;
  tip.hidden = false;
}

function hideTooltip() {
  const tip = document.getElementById('cbv-tooltip');
  if (tip) tip.hidden = true;
}

function zoomAt(px, py, factor) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.scale * factor));
  cam.x      = px - (px - cam.x) * (next / cam.scale);
  cam.y      = py - (py - cam.y) * (next / cam.scale);
  cam.scale  = next;
  applyTransform();
  renderMinimap();
}

function zoomToAbsolute(px, py, absoluteScale) {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, absoluteScale));
  cam.x      = px - (px - cam.x) * (next / cam.scale);
  cam.y      = py - (py - cam.y) * (next / cam.scale);
  cam.scale  = next;
  applyTransform();
  renderMinimap();
}

// Fix 2: rAF-throttled transform writes
function applyTransform() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    const c = document.getElementById('cbv-canvas');
    if (c) c.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.scale})`;
    syncZoomSlider();
    rafPending = false;
  });
}

// Fix 6: read SVG intrinsic size, not scrollWidth
function fitView(animated = true) {
  const tree = document.getElementById('cbv-tree');
  const svg  = document.querySelector('#cbv-canvas svg');
  if (!tree || !svg) return;
  const tw = tree.clientWidth, th = tree.clientHeight;
  const cw = +svg.getAttribute('width');
  const ch = +svg.getAttribute('height');
  if (!cw || !ch) return;

  cam.scale = Math.min(1, (tw - PAD * 2) / cw, (th - PAD * 2) / ch) * 0.95;
  cam.x     = (tw - cw * cam.scale) / 2;
  cam.y     = (th - ch * cam.scale) / 2;
  if (animated) {
    const canvas = document.getElementById('cbv-canvas');
    if (canvas) {
      canvas.style.transition = 'transform 0.38s cubic-bezier(0.4,0,0.2,1)';
      applyTransform();
      renderMinimap();
      setTimeout(() => { canvas.style.transition = ''; }, 400);
      return;
    }
  }
  applyTransform();
  renderMinimap();
}

// Fix 4: pan camera to center the active leaf node
function panToActiveLeaf() {
  // Find the deepest node that is active and has no active children
  let leaf = null;
  treeNodes.forEach(n => {
    if (!isNodeOnActivePath(n)) return;
    const hasActiveChild = n.children.some(c => isNodeOnActivePath(renderedNodes.get(c) || treeNodes.get(c)));
    if (!hasActiveChild) leaf = n;
  });
  if (!leaf) return;

  const info = layoutMap.get(leaf.id);
  if (!info) return;

  const tree = document.getElementById('cbv-tree');
  if (!tree) return;
  const tw = tree.clientWidth, th = tree.clientHeight;

  const targetX = tw / 2 - info.x * cam.scale;
  const targetY = th / 2 - (info.y + NH() / 2) * cam.scale;

  const canvas = document.getElementById('cbv-canvas');
  if (canvas) {
    canvas.style.transition = 'transform 0.4s cubic-bezier(0.4,0,0.2,1)';
    cam.x = targetX;
    cam.y = targetY;
    applyTransform();
    renderMinimap();
    setTimeout(() => { canvas.style.transition = ''; }, 420);
  }
}

function panToVisibleRange() {
  const tree = document.getElementById('cbv-tree');
  const canvas = document.getElementById('cbv-canvas');
  if (!tree || !canvas) return;

  const visibleInfos = [];
  renderedNodes.forEach(node => {
    if (!isNodeVisible(node)) return;
    const info = layoutMap.get(node.id);
    if (info) visibleInfos.push({ node, info });
  });

  if (!visibleInfos.length) {
    panToActiveLeaf();
    return;
  }

  const halfW = NW() / 2;
  const halfH = NH() / 2;
  const minX = Math.min(...visibleInfos.map(({ info }) => info.x - halfW));
  const maxX = Math.max(...visibleInfos.map(({ info }) => info.x + halfW));
  const minY = Math.min(...visibleInfos.map(({ info }) => info.y));
  const maxY = Math.max(...visibleInfos.map(({ info }) => info.y + halfH * 2));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const tw = tree.clientWidth;
  const th = tree.clientHeight;
  const contentW = maxX - minX || NW();
  const contentH = maxY - minY || NH();
  const targetScale = Math.min(
    1.0,
    (tw - PAD * 3) / contentW,
    (th - PAD * 3) / contentH
  ) * 0.92;
  cam.scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetScale));

  canvas.style.transition = 'transform 0.38s cubic-bezier(0.4,0,0.2,1)';
  cam.x = tw / 2 - centerX * cam.scale;
  cam.y = th / 2 - centerY * cam.scale;
  applyTransform();
  syncZoomSlider();
  renderMinimap();
  setTimeout(() => { canvas.style.transition = ''; }, 400);
}

// Fix 7: minimap
function renderMinimap() {
  const mini = document.getElementById('cbv-minimap');
  const svg  = document.querySelector('#cbv-canvas svg');
  const tree = document.getElementById('cbv-tree');
  if (!mini || !svg || !tree || layoutMap.size === 0) return;

  const ctx  = mini.getContext('2d');
  const mw   = mini.width, mh = mini.height;
  const svgW = +svg.getAttribute('width');
  const svgH = +svg.getAttribute('height');
  if (!svgW || !svgH) return;

  const sx = mw / svgW, sy = mh / svgH;
  ctx.clearRect(0, 0, mw, mh);

  // Draw edges
  ctx.strokeStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--edge-color').trim() || '#ccc';
  ctx.lineWidth = 0.8;
  const mnw = NW(), mnh = NH();
  renderedNodes.forEach(node => {
    const pi = layoutMap.get(node.id);
    if (!pi) return;
    node.children.forEach(cid => {
      const ci = layoutMap.get(cid);
      if (!ci) return;
      ctx.beginPath();
      ctx.moveTo(pi.x * sx, (pi.y + mnh) * sy);
      ctx.lineTo(ci.x * sx, ci.y * sy);
      ctx.stroke();
    });
  });

  // Draw nodes
  renderedNodes.forEach(node => {
    const info = layoutMap.get(node.id);
    if (!info) return;
    const isActive = isNodeOnActivePath(node);
    const isUser   = node.role === 'user';
    ctx.fillStyle = isActive
      ? (isUser ? '#2383e2' : '#0f7b6c')
      : node.kind === 'cluster' ? '#cbd5e1' : (isUser ? '#93c5fd' : '#6ee7b7');
    ctx.globalAlpha = isActive ? 1 : 0.5;
    ctx.beginPath();
    ctx.roundRect(
      (info.x - mnw / 2) * sx, info.y * sy,
      mnw * sx, mnh * sy, 2
    );
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // Draw viewport rect
  const tw = tree.clientWidth, th = tree.clientHeight;
  const vx = (-cam.x / cam.scale) * sx;
  const vy = (-cam.y / cam.scale) * sy;
  const vw = (tw / cam.scale) * sx;
  const vh = (th / cam.scale) * sy;
  ctx.strokeStyle = '#2383e2';
  ctx.lineWidth   = 1.5;
  ctx.globalAlpha = 0.8;
  ctx.strokeRect(vx, vy, vw, vh);
  ctx.globalAlpha = 1;
}

// ── Minimap click / drag → pan main view ─────────────────────────────────────
function initMinimapClick() {
  const mini = document.getElementById('cbv-minimap');
  if (!mini) return;

  let minimapDragging = false;

  function panFromMinimap(e) {
    const svg  = document.querySelector('#cbv-canvas svg');
    const tree = document.getElementById('cbv-tree');
    if (!svg || !tree) return;

    const mr   = mini.getBoundingClientRect();
    const mw   = mini.width,  mh  = mini.height;
    const svgW = +svg.getAttribute('width');
    const svgH = +svg.getAttribute('height');
    if (!svgW || !svgH) return;

    // Fraction within minimap canvas
    const fx = (e.clientX - mr.left)  / mr.width;
    const fy = (e.clientY - mr.top)   / mr.height;

    // Corresponding SVG-space coordinate
    const svgX = fx * svgW;
    const svgY = fy * svgH;

    // Centre that SVG point in the viewport
    const tw = tree.clientWidth, th = tree.clientHeight;
    cam.x = tw / 2 - svgX * cam.scale;
    cam.y = th / 2 - svgY * cam.scale;

    applyTransform();
    renderMinimap();
  }

  mini.style.cursor = 'crosshair';

  mini.addEventListener('mousedown', e => {
    minimapDragging = true;
    panFromMinimap(e);
    e.stopPropagation();
  });

  window.addEventListener('mousemove', e => {
    if (!minimapDragging) return;
    panFromMinimap(e);
  });

  window.addEventListener('mouseup', () => {
    minimapDragging = false;
  });

  // Touch support for minimap
  mini.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      minimapDragging = true;
      panFromMinimap(e.touches[0]);
    }
    e.stopPropagation();
    e.preventDefault();
  }, { passive: false });

  mini.addEventListener('touchmove', e => {
    if (minimapDragging && e.touches.length === 1) {
      panFromMinimap(e.touches[0]);
    }
    e.preventDefault();
  }, { passive: false });

  mini.addEventListener('touchend', () => {
    minimapDragging = false;
  }, { passive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function el(ns, tag, attrs = {}) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function svgText(x, y, text, attrs = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const t  = document.createElementNS(NS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
  t.textContent = text;
  return t;
}

function svgMultilineText(x, y, lines, attrs = {}, lineHeight = 12) {
  const NS = 'http://www.w3.org/2000/svg';
  const text = document.createElementNS(NS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  for (const [k, v] of Object.entries(attrs)) text.setAttribute(k, v);
  lines.forEach((line, index) => {
    const tspan = document.createElementNS(NS, 'tspan');
    tspan.setAttribute('x', x);
    tspan.setAttribute('dy', index === 0 ? '0' : String(lineHeight));
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  return text;
}

function wrapSnippet(text, maxLines, maxChars) {
  const source = (text || '').replace(/\s+/g, ' ').trim();
  if (!source) return [''];

  const lines = [];
  let rest = source;

  while (rest && lines.length < maxLines) {
    if (rest.length <= maxChars) {
      lines.push(rest);
      rest = '';
      break;
    }

    const slice = rest.slice(0, maxChars + 1);
    let breakAt = Math.max(
      slice.lastIndexOf(' '),
      slice.lastIndexOf('/'),
      slice.lastIndexOf('-'),
      slice.lastIndexOf('_')
    );

    if (breakAt < Math.floor(maxChars * 0.45)) breakAt = maxChars;

    lines.push(rest.slice(0, breakAt).trim());
    rest = rest.slice(breakAt).trim();
  }

  if (rest && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s.]+$/, '') + '…';
  }

  return lines.slice(0, maxLines);
}

function truncateToWidth(text, maxChars) {
  const s = (text || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + '…';
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatPlatformName(platform) {
  return cbvFormatPlatformName(platform);
}

function assistantBrand() {
  return cbvGetAssistantBadgeKind(detectCurrentPlatform());
}

function assistantDisplayName() {
  const platform = detectCurrentPlatform();
  return platform && platform !== 'unknown' ? formatPlatformName(platform) : 'Assistant';
}

function detectCurrentPlatform() {
  return currentPlatform !== 'unknown' ? currentPlatform : cbvDetectPlatform(currentPageUrl);
}

function updateDiagnosticsActions() {
  const hasDiagnostics = Boolean(lastDiagnostics);
  const menu = document.getElementById('cbv-more-menu');
  const copyBtn = document.getElementById('btn-copy-diagnostics');
  const reportBtn = document.getElementById('btn-report-breakage');
  if (menu) menu.hidden = false;
  if (copyBtn) copyBtn.dataset.ready = hasDiagnostics ? 'true' : 'false';
  if (reportBtn) reportBtn.dataset.ready = hasDiagnostics ? 'true' : 'false';
}

function syncDiagnosticsToggle(autoSend) {
  const btn = document.getElementById('btn-diagnostics-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', autoSend ? 'true' : 'false');
}

async function copyDiagnostics() {
  if (!lastDiagnostics) {
    setStatus('No diagnostics captured yet', 'idle');
    closeMoreMenu();
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastDiagnostics, null, 2));
    setStatus('Diagnostics copied', 'ok');
  } catch (_) {
    setStatus('Failed to copy diagnostics', 'error');
  }
  closeMoreMenu();
}

async function reportBreakage() {
  if (!lastDiagnostics) {
    setStatus('No diagnostics captured yet', 'idle');
    closeMoreMenu();
    return;
  }
  const reporting = typeof cbvGetReportingConfig === 'function' ? cbvGetReportingConfig() : { enabled: false, endpoint: '' };
  if (reporting.enabled && reporting.endpoint) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SUBMIT_REPORT',
        reportType: 'user_report',
        diagnostics: lastDiagnostics,
      });
      if (result?.ok) {
        setStatus('Diagnostics submitted', 'ok');
      } else {
        throw new Error(result?.error || 'submit_failed');
      }
    } catch (_) {
      await copyDiagnostics();
      downloadDiagnostics();
      setStatus('Diagnostics copied and downloaded', 'ok');
    }
  } else {
    await copyDiagnostics();
    downloadDiagnostics();
    setStatus('Diagnostics copied and downloaded', 'ok');
  }
  closeMoreMenu();
}

function closeMoreMenu() {
  const menu = document.getElementById('cbv-more-menu');
  if (menu) menu.open = false;
}

function initMoreMenu() {
  document.addEventListener('click', event => {
    const menu = document.getElementById('cbv-more-menu');
    if (!menu?.open) return;
    if (menu.contains(event.target)) return;
    closeMoreMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMoreMenu();
  });
}

function downloadDiagnostics() {
  if (!lastDiagnostics) return;
  const stamp = new Date(lastDiagnostics.ts || Date.now()).toISOString().replace(/[:.]/g, '-');
  const platform = (lastDiagnostics.platform || 'unknown').toLowerCase();
  const blob = new Blob([JSON.stringify(lastDiagnostics, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cbv-breakage-${platform}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Unique ID counter for SVG clipPath elements
let _badgeClipId = 0;

function appendNodeBadge(parent, cx, cy, kind, active = false) {
  const NS = 'http://www.w3.org/2000/svg';
  const palette = {
    user:    { bg: '#e8f0fe', fg: '#1f6fd6' },
    chatgpt: { bg: '#e8f5ef', fg: '#167c5a' },
    claude:  { bg: '#fff1e6', fg: '#c66a1c' },
    cluster: { bg: '#eef1f4', fg: '#6b7280' },
  }[kind] || { bg: '#eef1f4', fg: '#6b7280' };

  // Background circle
  parent.appendChild(el(NS, 'circle', {
    cx, cy, r: '8',
    fill: palette.bg,
    stroke: active ? palette.fg : 'none',
    'stroke-width': active ? '1' : '0',
  }));

  // Claude & ChatGPT: real logo images clipped to circle
  if (kind === 'claude' || kind === 'chatgpt') {
    const clipId = `cbv-bc-${++_badgeClipId}`;
    const clipPath = document.createElementNS(NS, 'clipPath');
    clipPath.setAttribute('id', clipId);
    const clipCircle = document.createElementNS(NS, 'circle');
    clipCircle.setAttribute('cx', cx);
    clipCircle.setAttribute('cy', cy);
    clipCircle.setAttribute('r', '7');
    clipPath.appendChild(clipCircle);
    parent.appendChild(clipPath);

    const img = document.createElementNS(NS, 'image');
    img.setAttribute('href', chrome.runtime.getURL(
      kind === 'claude' ? 'img/badge-claude.png' : 'img/badge-chatgpt.png'
    ));
    img.setAttribute('x', cx - 7);
    img.setAttribute('y', cy - 7);
    img.setAttribute('width', '14');
    img.setAttribute('height', '14');
    img.setAttribute('clip-path', `url(#${clipId})`);
    img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    parent.appendChild(img);
    return;
  }

  if (kind === 'user') {
    parent.appendChild(el(NS, 'circle', { cx, cy: cy - 2.2, r: '2', fill: palette.fg }));
    parent.appendChild(el(NS, 'path', {
      d: `M${cx - 4.2},${cy + 4} C${cx - 3.4},${cy + 1.4} ${cx + 3.4},${cy + 1.4} ${cx + 4.2},${cy + 4}`,
      fill: 'none', stroke: palette.fg, 'stroke-width': '1.3', 'stroke-linecap': 'round',
    }));
    return;
  }

  if (kind === 'cluster') {
    [-3, 0, 3].forEach(dx => {
      parent.appendChild(el(NS, 'circle', { cx: cx + dx, cy, r: '1.2', fill: palette.fg }));
    });
    return;
  }
}

function countLeaves() {
  let n = 0;
  treeNodes.forEach(node => { if (!node.children.length) n++; });
  return n;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setBuildIdle() {
  document.getElementById('btn-build').hidden  = false;
  document.getElementById('btn-cancel').hidden = true;
}

function setStatus(text, state = 'idle') {
  const txt = document.getElementById('cbv-status-text');
  const dot = document.getElementById('cbv-dot');
  if (txt) txt.textContent = text;
  if (dot) {
    dot.className = 'cbv-status-dot';
    if (state === 'ok')      dot.classList.add('ok');
    if (state === 'working') dot.classList.add('working');
    if (state === 'error')   dot.classList.add('error');
  }
}

function setProgress(pct) {
  const bar = document.getElementById('cbv-progress-bar');
  if (bar) bar.style.width = pct + '%';
}
function showProgress() {
  const w = document.getElementById('cbv-progress-wrap');
  if (w) w.hidden = false;
}
function hideProgress() {
  const w = document.getElementById('cbv-progress-wrap');
  if (w) w.hidden = true;
}

// ── Storage restore ───────────────────────────────────────────────────────────
async function restoreFromStorage(expectedUrl = currentPageUrl) {
  if (!currentTabId) return;
  try {
    const tab = await chrome.tabs.get(currentTabId);
    const restoredUrl = tab.url || '';
    if (!restoredUrl || restoredUrl !== expectedUrl || currentPageUrl !== expectedUrl) return;
    const key = storageKeyFromUrl(restoredUrl);
    if (!key) return;
    const result = await chrome.storage.local.get(key);
    const saved  = result[key];
    if (!saved || !saved.nodes?.length) return;

    // Only restore if saved within the last 24 hours
    const AGE_LIMIT = 24 * 60 * 60 * 1000;
    if (Date.now() - saved.savedAt > AGE_LIMIT) return;

    treeNodes  = new Map(saved.nodes.map(n => [n.id, n]));
    if (currentPageUrl !== expectedUrl) return;
    treeSource = 'snapshot';
    treeDataUrl = restoredUrl;
    setTreeCompleteness('full');
    setActivePathState(saved.activePath || []);
    setVisiblePathState([]);
    expandedChainStarts.clear();
    setStatus(`Snapshot restored · saved ${timeAgo(saved.savedAt)}`, 'ok');
    collapseByDefault();
    requestAnimationFrame(fitView);
  } catch (_) { /* storage unavailable — fine */ }
}

function storageKeyFromUrl(url) {
  return cbvMakeStorageKey(url);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
