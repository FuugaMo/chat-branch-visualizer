// content.js — runs in supported assistant chat pages
// Responsibilities: DOM scanning, branch navigation
// Communicates with sidepanel.js via background.js message passing

(() => {
  'use strict';

  const NAV_WAIT_MS   = 500;   // ms to wait after each button click
  const NAV_TIMEOUT   = 3000;  // ms before nav is considered stuck
  const NAV_RETRIES   = 2;     // retry attempts if nav appears stuck
  const DEBOUNCE_MS   = 180;
  const VIEWPORT_SYNC_MS = 100;
  const BUILD_TIMEOUT_MS = 45000;
  const DIAGNOSTIC_SNIPPET_LIMIT = 6;
  const PLATFORM      = detectPlatform();
  const EXT_VERSION   = chrome.runtime.getManifest().version;
  const DEFAULT_SELECTORS = {
    version: EXT_VERSION,
    lastVerified: null,
    platforms: {
      chatgpt: {
        turns: [
          "article[data-testid^='conversation-turn-']",
          "[data-testid='conversation-turn']",
          '[data-message-author-role]',
          '[data-message-id]',
        ],
        turnRoleAttr: 'data-turn',
        messageIdAttr: 'data-message-id',
        branchCounter: { type: 'regex', pattern: '^\\d+\\s*/\\s*\\d+$' },
        branchPrev: ["[aria-label*='prev' i]", "[aria-label*='previous' i]", "[aria-label*='earlier' i]"],
        branchNext: ["[aria-label*='next' i]", "[aria-label*='later' i]"],
        scrollHost: ['main'],
      },
      claude: {
        humanTurn: [
          "[data-testid='user-message']",
          "[data-testid='human-turn']",
          "[class*='font-user-message']",
          "[class*='human-turn']",
          "[class*='HumanTurn']",
        ],
        assistantTurn: [
          "[data-testid='assistant-turn']",
          "[data-testid='assistant-message']",
          '.font-claude-response',
          '.font-claude-response-body',
          '.standard-markdown',
          "[class*='font-claude-message']",
        ],
        branchCounter: { type: 'regex', pattern: '^\\d+\\s*/\\s*\\d+$' },
        branchPrev: ["[aria-label*='prev' i]", "[aria-label*='previous' i]", "[aria-label*='上一']"],
        branchNext: ["[aria-label*='next' i]", "[aria-label*='later' i]", "[aria-label*='下一']"],
        scrollHost: ['main'],
      },
    },
  };

  let mutTimer  = null;
  let observer  = null;
  let building  = false;
  let cancelled = false;  // set to true by CANCEL command
  let viewportTimer = null;
  let scrollHost = null;
  let highlightedTurn = null;
  let pollTimer = null;
  let lastStateSig = '';
  let lastVisibleSig = '';
  let lastUrl = location.href;
  let selectorConfig = DEFAULT_SELECTORS;
  let lastDiagnostics = null;
  let lastDiagnosticSig = '';
  let pageLoadStartedAt = Date.now();

  // ── Platform ────────────────────────────────────────────────────────────────
  function detectPlatform() {
    return cbvDetectPlatform(location.href);
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  init();

  function init() {
    if (PLATFORM === 'unknown') {
      sendToPanel({ type: 'PAGE_READY', platform: PLATFORM, url: location.href, supported: false });
      return;
    }
    injectHighlightStyle();
    loadSelectorConfig().catch(() => {});
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      handleMessage(msg).then(sendResponse);
      return true; // async
    });
    startObserver();
    bindScrollSync();
    window.addEventListener('resize', scheduleViewportSync, { passive: true });
    startStatePolling();
    sendToPanel({ type: 'PAGE_READY', platform: PLATFORM, url: location.href });
    syncStateToPanel(true);
    scheduleViewportSync();
  }

  // ── Message handler ──────────────────────────────────────────────────────────
  async function handleMessage(msg) {
    switch (msg.type) {
      case 'BUILD':
        return await cmdBuild();
      case 'CANCEL':
        return cmdCancel();
      case 'QUICK_SCAN':
        return panelMessage({ type: 'SCAN_RESULT', turns: serializeTurns(readRawTurns()) });
      case 'NAVIGATE':
        return await cmdNavigate(msg.path);
      default:
        return { ok: false };
    }
  }

  // ── Send to sidepanel (via background) ───────────────────────────────────────
  function sendToPanel(msg) {
    chrome.runtime.sendMessage(panelMessage(msg)).catch(() => {});
  }

  function panelMessage(msg) {
    return { ...msg, url: msg.url || location.href };
  }

  async function loadSelectorConfig() {
    try {
      const response = await fetch(chrome.runtime.getURL('selectors.json'));
      if (!response.ok) return;
      const next = await response.json();
      if (next?.platforms) selectorConfig = next;
    } catch (_) {}
  }

function makePathEntry(turn) {
  return {
      id: turn.id || makeNodeId(turn.turnIndex, turn.branchIndex, turn.domId),
      turnIndex: turn.turnIndex,
      branchIndex: turn.branchIndex,
      role: turn.role,
      textSig: textSignature(turn.text),
    };
  }

  function runSelectorProbe(platform = PLATFORM) {
    const cfg = selectorConfig?.platforms?.[platform];
    if (!cfg) {
      return {
        platform,
        version: selectorConfig?.version || null,
        ts: Date.now(),
        url: location.href,
        hits: {},
        broken: ['platform-config-missing'],
      };
    }

    const hits = {};
    for (const [key, sel] of Object.entries(cfg)) {
      hits[key] = probeSelectorValue(sel);
    }

    const broken = Object.entries(hits)
      .filter(([, value]) => isProbeValueBroken(value))
      .map(([key]) => key);

    return {
      platform,
      version: selectorConfig?.version || null,
      ts: Date.now(),
      url: location.href,
      hits,
      broken,
    };
  }

  function probeSelectorValue(sel) {
    if (typeof sel === 'string') return safeQueryCount(sel);
    if (Array.isArray(sel)) return sel.map(entry => probeSelectorValue(entry));
    if (sel?.type === 'regex') return countRegexTextMatches(sel.pattern);
    if (sel && typeof sel === 'object' && typeof sel.selector === 'string') {
      return safeQueryCount(sel.selector);
    }
    return null;
  }

  function safeQueryCount(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (_) {
      return -1;
    }
  }

  function countRegexTextMatches(pattern) {
    try {
      const regex = new RegExp(pattern);
      let count = 0;
      document.querySelectorAll('span, div, p, button').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text && regex.test(text)) count += 1;
      });
      return count;
    } catch (_) {
      return -1;
    }
  }

  function isProbeValueBroken(value) {
    if (Array.isArray(value)) return value.every(entry => isProbeValueBroken(entry));
    return typeof value === 'number' ? value <= 0 : value == null;
  }

  function maybeReportBreakage(reason, extra = {}) {
    const turns = extra.turns || [];
    const probe = runSelectorProbe(PLATFORM);
    const diagnostics = {
      type: 'selector-breakage',
      reason,
      platform: PLATFORM,
      platformLabel: cbvFormatPlatformName(PLATFORM),
      extensionVersion: EXT_VERSION,
      selectorVersion: selectorConfig?.version || null,
      url: location.href,
      ts: Date.now(),
      turnCount: turns.length,
      activePath: readCurrentPath().slice(-4).map(toDiagnosticTurn),
      visiblePath: readVisiblePath().slice(-4).map(toDiagnosticTurn),
      probe,
      extra,
      domSummary: collectDomSummary(),
    };
    const sig = JSON.stringify({
      reason,
      url: diagnostics.url,
      broken: diagnostics.probe.broken,
      turnCount: diagnostics.turnCount,
    });
    if (sig === lastDiagnosticSig) return diagnostics;
    lastDiagnosticSig = sig;
    lastDiagnostics = diagnostics;
    sendToPanel({ type: 'PROBE_RESULT', diagnostics });
    return diagnostics;
  }

  function toDiagnosticTurn(turn) {
    return {
      id: turn.id || null,
      turnIndex: turn.turnIndex,
      branchIndex: turn.branchIndex,
      role: turn.role,
      text: textSignature(turn.text || turn.textSig || ''),
    };
  }

  function collectDomSummary() {
    const selectors = {
      turnArticles: "article[data-testid^='conversation-turn-']",
      messageIds: '[data-message-id]',
      userMessages: "[data-testid='user-message'], [class*='font-user-message']",
      assistantTurns: "[data-testid='assistant-turn'], [data-testid='assistant-message'], .font-claude-response",
      branchCounters: 'span, div',
    };
    return Object.entries(selectors).map(([label, selector]) => {
      const nodes = selector === 'span, div'
        ? [...document.querySelectorAll(selector)].filter(el => /^\d+\s*\/\s*\d+$/.test((el.textContent || '').trim())).slice(0, DIAGNOSTIC_SNIPPET_LIMIT)
        : [...document.querySelectorAll(selector)].slice(0, DIAGNOSTIC_SNIPPET_LIMIT);
      return {
        label,
        count: selector === 'span, div' ? nodes.length : safeQueryCount(selector),
        samples: nodes.map(el => ({
          tag: el.tagName,
          testid: el.getAttribute('data-testid') || '',
          cls: String(el.className || '').slice(0, 120),
          text: textSignature(el.innerText || el.textContent || ''),
        })),
      };
    });
  }

  function diagnosticsText(diagnostics = lastDiagnostics) {
    if (!diagnostics) return '';
    return JSON.stringify(diagnostics, null, 2);
  }

  // ── CANCEL command ────────────────────────────────────────────────────────────
  function cmdCancel() {
    if (!building) return { ok: false, reason: 'not_building' };
    cancelled = true;
    return { ok: true };
  }

  // ── BUILD command: DFS traverse, stream progress ─────────────────────────────
  async function cmdBuild() {
    if (building) return { ok: false, reason: 'already_building' };
    building   = true;
    cancelled  = false;
    observer?.disconnect();

    const treeNodes = new Map();
    const buildDeadline = Date.now() + BUILD_TIMEOUT_MS;

    sendToPanel({ type: 'BUILD_START' });

    try {
      await dfsCollect(null, 0, treeNodes, buildDeadline);
    } catch (e) {
      const reason = cancelled ? 'cancelled' : e.message;
      building       = false;
      cancelled      = false;
      lastStateSig   = '';
      lastVisibleSig = '';
      startObserver();
      if (reason === 'build_timeout') {
        const activePath = readCurrentPath();
        sendToPanel({
          type: 'BUILD_DONE',
          nodes: [...treeNodes.values()],
          activePath,
          partial: true,
          reason: 'timeout',
        });
        sendToPanel({
          type: 'BUILD_WARNING',
          message: `Build timed out after ${Math.round(BUILD_TIMEOUT_MS / 1000)}s. Partial tree restored.`,
        });
        saveToStorage(treeNodes, activePath);
        return { ok: true, partial: true };
      }
      maybeReportBreakage('build_error', {
        phase: 'build',
        message: reason,
        cancelled,
      });
      sendToPanel({ type: cancelled ? 'BUILD_CANCELLED' : 'BUILD_ERROR', message: reason });
      return { ok: false };
    }

    building  = false;
    cancelled = false;
    lastStateSig   = '';
    lastVisibleSig = '';
    startObserver();

    const activePath = readCurrentPath();
    sendToPanel({
      type:       'BUILD_DONE',
      nodes:      [...treeNodes.values()],
      activePath,
    });

    // Persist to storage
    saveToStorage(treeNodes, activePath);

    return panelMessage({ ok: true });
  }

  // ── NAVIGATE command ─────────────────────────────────────────────────────────
  async function cmdNavigate(path) {
    for (const step of path) {
      if (step.branchTotal <= 1) continue;
      const turns = readRawTurns();
      const turn  = turns[step.turnIndex];
      if (!turn) continue;
      if (turn.branchIndex !== step.branchIndex) {
        await navigateTurnToBranch(turn, step.branchIndex);
        await sleep(NAV_WAIT_MS);
      }
    }
    const leaf = path[path.length - 1];
    if (leaf) {
      sendToPanel({ type: 'CONVERSATION_LOADING' });
      const stableTurn = await waitForTurnStable(leaf.turnIndex, leaf.branchIndex);
      if (stableTurn?.article) {
        scrollToTurn(stableTurn.article);
        highlightTurn(stableTurn.article);
      }
    }
    const activePath = readCurrentPath();
    sendToPanel({ type: 'NAV_DONE', activePath });
    scheduleViewportSync();
    return panelMessage({ ok: true, activePath });
  }

  // ── DFS tree builder ─────────────────────────────────────────────────────────
  async function dfsCollect(parentId, turnIdx, treeNodes, buildDeadline) {
    if (cancelled) throw new Error('cancelled');
    if (Date.now() > buildDeadline) throw new Error('build_timeout');

    const turns = readRawTurns();
    if (turnIdx >= turns.length) return;

    const turn           = turns[turnIdx];
    const branchTotal    = turn.branchTotal;
    const originalBranch = turn.branchIndex;

    for (let b = 1; b <= branchTotal; b++) {
      if (cancelled) throw new Error('cancelled');
      if (Date.now() > buildDeadline) throw new Error('build_timeout');

      // Navigate to branch b
      const curTurns = readRawTurns();
      const curTurn  = curTurns[turnIdx];
      if (!curTurn) break;
      if (curTurn.branchIndex !== b) {
        const ok = await navigateTurnToBranch(curTurn, b);
        if (!ok) {
          // Log stuck nav as a warning and skip this branch
          sendToPanel({
            type:    'BUILD_WARNING',
            message: `Turn ${turnIdx + 1}: could not reach branch ${b}/${branchTotal} — skipped`,
          });
          maybeReportBreakage('branch_navigation_warning', {
            phase: 'build',
            turnIndex: turnIdx,
            branchIndex: b,
            branchTotal,
          });
          continue;
        }
        await sleep(NAV_WAIT_MS);
      }

      const freshTurns = readRawTurns();
      const freshTurn  = freshTurns[turnIdx];
      if (!freshTurn) break;

      const nodeId = makeNodeId(turnIdx, b, freshTurn.domId);
      const node = {
        id:          nodeId,
        parentId,
        turnIndex:   turnIdx,
        branchIndex: b,
        branchTotal,
        role:        freshTurn.role,
        text:        freshTurn.text,
        children:    [],
      };

      if (!treeNodes.has(nodeId)) {
        treeNodes.set(nodeId, node);
      } else {
        treeNodes.get(nodeId).text = node.text;
      }

      if (parentId && treeNodes.has(parentId)) {
        const parent = treeNodes.get(parentId);
        if (!parent.children.includes(nodeId)) parent.children.push(nodeId);
      }

      sendToPanel({
        type:      'BUILD_PROGRESS',
        nodeCount: treeNodes.size,
        turnIdx,
        b,
        branchTotal,
        turnCount: turns.length,
      });

      await dfsCollect(nodeId, turnIdx + 1, treeNodes, buildDeadline);

      if (cancelled) throw new Error('cancelled');
      if (Date.now() > buildDeadline) throw new Error('build_timeout');

      // Restore to b after recursion
      const afterTurns = readRawTurns();
      const afterTurn  = afterTurns[turnIdx];
      if (afterTurn && afterTurn.branchIndex !== b) {
        await navigateTurnToBranch(afterTurn, b);
        await sleep(NAV_WAIT_MS);
      }
    }

    if (cancelled) throw new Error('cancelled');
    if (Date.now() > buildDeadline) throw new Error('build_timeout');

    // Backtrack to original
    const finalTurns = readRawTurns();
    const finalTurn  = finalTurns[turnIdx];
    if (finalTurn && finalTurn.branchIndex !== originalBranch) {
      await navigateTurnToBranch(finalTurn, originalBranch);
      await sleep(NAV_WAIT_MS);
    }
  }

  // ── Nav helper — with timeout + retry ────────────────────────────────────────
  // Returns true on success, false if stuck after retries.
  async function navigateTurnToBranch(turn, target) {
    for (let attempt = 0; attempt <= NAV_RETRIES; attempt++) {
      const result = await tryNavToTarget(turn, target);
      if (result) return true;

      if (cancelled) return false;

      // Retry: re-read the turn and try once more
      const fresh = readRawTurns()[turn.turnIndex];
      if (!fresh) return false;
      if (fresh.branchIndex === target) return true;

      // Give DOM a bit more time before retry
      await sleep(NAV_WAIT_MS);
    }
    return false;
  }

  // Single attempt to nav turn to target — times out after NAV_TIMEOUT ms
  async function tryNavToTarget(turn, target) {
    const deadline = Date.now() + NAV_TIMEOUT;
    let stagnantCount = 0;
    let lastSig = '';

    for (let step = 0; step < 30; step++) {
      if (cancelled) return false;
      if (Date.now() > deadline) return false;

      const fresh = readRawTurns()[turn.turnIndex];
      if (!fresh) return false;
      if (fresh.branchIndex === target) return true;
      if (target < 1 || target > (fresh.branchTotal || 1)) return false;

      const sig = buildTurnStateSig(fresh);
      stagnantCount = sig === lastSig ? stagnantCount + 1 : 0;
      lastSig = sig;

      const wantsNext = target > fresh.branchIndex;
      const btn = wantsNext ? fresh.nextBtn : fresh.prevBtn;
      if (!btn || isDisabledButton(btn)) {
        // Try once after bringing the turn into view; if still unavailable, fail fast.
        if (fresh.article) scrollToTurn(fresh.article);
        await sleep(Math.min(NAV_WAIT_MS, 220));
        const retried = readRawTurns()[turn.turnIndex];
        const retryBtn = wantsNext ? retried?.nextBtn : retried?.prevBtn;
        if (!retryBtn || isDisabledButton(retryBtn)) return false;
        retryBtn.click();
      } else {
        btn.click();
      }

      if (stagnantCount >= 3) return false;

      await sleep(NAV_WAIT_MS);
    }

    // One last check
    const final = readRawTurns()[turn.turnIndex];
    return final?.branchIndex === target;
  }

  // ── DOM reading ──────────────────────────────────────────────────────────────
  function readRawTurns() {
    const reader = {
      chatgpt: readChatGPTTurns,
      claude: readClaudeTurns,
    }[PLATFORM];
    return reader ? reader() : readGenericTurns();
  }

  function readChatGPTTurns() {
    let turns = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];

    if (!turns.length) {
      const fallbackSelectors = [
        "[data-testid='conversation-turn']",
        '[data-message-author-role]',
        'main article',
      ];
      const candidates = dedupeElements(fallbackSelectors.flatMap(sel => [...document.querySelectorAll(sel)]))
        .filter(el => isReadableTurnCandidate(el, { minText: 2 }));
      turns = candidates
        .filter(el => !candidates.some(other => other !== el && other.contains(el)))
        .sort((a, b) => rectTop(a) - rectTop(b));
    }

    return turns.map((turn, idx) => {
      const roleAttr = turn.getAttribute('data-turn') || turn.getAttribute('data-message-author-role') || '';
      const role   = /^user$/i.test(roleAttr) ? 'user' : 'assistant';
      const msgDiv = turn.matches('[data-message-id]') ? turn : turn.querySelector('[data-message-id]');
      const msgId  = msgDiv?.getAttribute('data-message-id') || turn.getAttribute('data-turn-id') || null;
      const nav    = findChatGPTBranchNav(turn);
      return {
        turnIndex:   idx,
        domId:       msgId,
        role,
        text:        extractText(msgDiv || turn),
        branchIndex: nav?.current ?? 1,
        branchTotal: nav?.total   ?? 1,
        prevBtn:     nav?.prevBtn ?? null,
        nextBtn:     nav?.nextBtn ?? null,
        article:     turn,
      };
    });
  }

  // ── Claude turn reading ───────────────────────────────────────────────────────
  // Claude's branch nav lives inside each human turn (user message), allowing
  // users to switch between edited messages. The assistant response following
  // each branch is considered a child of that branch.
  function readClaudeTurns() {
    const userEls = getClaudeUserTurns();
    if (!userEls.length) return readGenericTurns();

    const assistantGroups = getClaudeAssistantGroups(userEls);
    const turns = [];

    userEls.forEach((userEl, userIdx) => {
      const nav = findClaudeBranchNav(userEl);
      const branchIndex = nav?.current ?? 1;
      const branchTotal = nav?.total ?? 1;
      turns.push({
        turnIndex:   turns.length,
        domId:       userEl.getAttribute('data-message-id') || null,
        role:        'user',
        text:        extractText(userEl),
        branchIndex,
        branchTotal,
        prevBtn:     nav?.prevBtn ?? null,
        nextBtn:     nav?.nextBtn ?? null,
        article:     userEl,
      });

      const group = assistantGroups[userIdx];
      if (!group?.text) return;
      turns.push({
        turnIndex:   turns.length,
        domId:       buildClaudeAssistantDomId(userEl, userIdx, group.text, branchIndex),
        role:        'assistant',
        text:        group.text,
        branchIndex: 1,
        branchTotal: 1,
        prevBtn:     null,
        nextBtn:     null,
        article:     group.article,
      });
    });

    return turns;
  }

  function getClaudeUserTurns() {
    const selectors = [
      '[data-testid="user-message"]',
      '[class*="font-user-message"]',
      '[data-testid="human-turn"]',
      '[class*="human-turn"]',
      '[class*="HumanTurn"]',
    ];
    return dedupeElements(selectTopLevelCandidates(selectors)
      .filter(el => isReadableTurnCandidate(el, { minText: 2 })))
      .sort((a, b) => rectTop(a) - rectTop(b));
  }

  function getClaudeAssistantGroups(userEls) {
    const allCandidates = getClaudeAssistantCandidates(userEls);
    const groups = userEls.map((userEl, idx) => {
      const startY = rectTop(userEl);
      const endY = idx + 1 < userEls.length ? rectTop(userEls[idx + 1]) : Infinity;
      const intervalCandidates = allCandidates.filter(el => {
        const centerY = rectCenterY(el);
        return centerY > startY && centerY < endY;
      });
      const groupEls = dedupeElements(intervalCandidates)
        .filter(el => !intervalCandidates.some(other => other !== el && other.contains(el)));
      if (!groupEls.length) return null;

      const text = [...new Set(groupEls
        .map(extractText)
        .filter(Boolean))]
        .join('\n');
      if (!text) return null;

      return {
        domId: groupEls.find(el => el.getAttribute('data-message-id'))?.getAttribute('data-message-id') || null,
        text: text.replace(/\s*\n\s*/g, ' ').trim(),
        article: groupEls[0],
      };
    });

    if (groups.some(Boolean)) return groups;

    // Fallback: recover assistant text by scanning generic readable blocks in each gap.
    return userEls.map((userEl, idx) => {
      const startY = rectTop(userEl);
      const endY = idx + 1 < userEls.length ? rectTop(userEls[idx + 1]) : Infinity;
      const fallbackEls = [...document.querySelectorAll('main p, main pre, main li, main blockquote, main h1, main h2, main h3, main div')]
        .filter(el => {
          if (userEls.some(user => user === el || user.contains(el))) return false;
          if (isClaudeBranchNavWidget(el)) return false;
          if (!isReadableTurnCandidate(el, { minText: 12 })) return false;
          const style = getComputedStyle(el);
          if (style.position === 'absolute' || style.position === 'fixed') return false;
          const centerY = rectCenterY(el);
          return centerY > startY && centerY < endY;
        });
      const topLevel = dedupeElements(fallbackEls)
        .filter(el => !fallbackEls.some(other => other !== el && other.contains(el)));
      const text = [...new Set(topLevel.map(extractText).filter(Boolean))].join(' ').trim();
      if (!text) return null;
      return {
        domId: null,
        text,
        article: topLevel[0],
      };
    });
  }

  function getClaudeAssistantCandidates(userEls) {
    const selectors = [
      '[data-testid="assistant-turn"]',
      '[data-testid="assistant-message"]',
      '.font-claude-response',
      '.font-claude-response-body',
      '.standard-markdown',
      '[class*="font-claude-message"]',
      'main [class*="prose"]',
      'main [class*="whitespace-pre-wrap"]',
      'main [class*="markdown"]',
      'main [data-testid*="assistant"]',
      'main p',
      'main pre',
      'main li',
      'main blockquote',
    ];

    return dedupeElements(selectors.flatMap(sel => [...document.querySelectorAll(sel)]))
      .filter(el => isReadableTurnCandidate(el, { minText: 8 }))
      .filter(el => !userEls.some(userEl => userEl === el || userEl.contains(el)))
      .filter(el => !isClaudeBranchNavWidget(el))
      .filter(el => {
        const style = getComputedStyle(el);
        return style.position !== 'absolute' && style.position !== 'fixed';
      })
      .sort((a, b) => rectTop(a) - rectTop(b));
  }

  function readGenericTurns() {
    const sels = ['[data-message-id]','article','[data-testid*="conversation"]','[class*="message"]'];
    let best = [];
    for (const s of sels) {
      const found = [...document.querySelectorAll(s)].filter(e => (e.innerText||'').trim().length >= 8);
      if (found.length > best.length) best = found;
    }
    return best.map((el, idx) => ({
      turnIndex: idx, domId: null,
      role: idx % 2 === 0 ? 'user' : 'assistant',
      text: extractText(el),
      branchIndex: 1, branchTotal: 1,
      prevBtn: null, nextBtn: null, article: el,
    }));
  }

  // ── findBranchNav ─────────────────────────────────────────────────────────────
  // Locates the X/Y branch counter and associated prev/next buttons.
  // Works for both ChatGPT (aria-label Chinese/English) and Claude.
  function findChatGPTBranchNav(container) {
    return findBranchNavInside(container, { allowPositionalFallback: false });
  }

  function findClaudeBranchNav(container) {
    return findBranchNavInside(container, { allowPositionalFallback: true }) || findNearbyClaudeBranchNav(container);
  }

  function findBranchNavInside(root, { allowPositionalFallback = true } = {}) {
    return resolveBranchNavFromCandidates(getBranchCounterCandidates(root), { allowPositionalFallback });
  }

  function findNearbyClaudeBranchNav(container) {
    const containerRect = container.getBoundingClientRect();
    const nearby = getBranchCounterCandidates(document)
      .map(candidate => ({ candidate, nav: resolveBranchNavCandidate(candidate, { allowPositionalFallback: true }) }))
      .filter(entry => entry.nav)
      .map(entry => {
        const rect = entry.candidate.el.getBoundingClientRect();
        const centerY = (rect.top + rect.bottom) / 2;
        const turnCenterY = (containerRect.top + containerRect.bottom) / 2;
        const overlap = Math.min(containerRect.bottom, rect.bottom) - Math.max(containerRect.top, rect.top);
        const dy = Math.abs(centerY - turnCenterY);
        const dx = Math.max(0, rect.left - containerRect.left);
        return {
          ...entry,
          rect,
          dy,
          dx,
          overlap,
        };
      })
      .filter(entry =>
        entry.rect.left >= containerRect.left - 24 &&
        entry.rect.right <= window.innerWidth + 32 &&
        (entry.overlap > 0 || entry.dy < Math.max(44, containerRect.height * 0.6)) &&
        entry.dx < Math.max(720, containerRect.width + 120)
      )
      .sort((a, b) => {
        if (a.dy !== b.dy) return a.dy - b.dy;
        return a.dx - b.dx;
      });

    return nearby[0]?.nav || null;
  }

  function getBranchCounterCandidates(root) {
    const scope = root?.querySelectorAll ? root : document;
    return [...scope.querySelectorAll('span,div')]
      .filter(el => {
        if (el.children.length > 2) return false;
        const m = el.textContent?.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
        if (!m) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8 && +m[2] > 1;
      })
      .map(el => {
        const m = el.textContent.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
        return { el, current: +m[1], total: +m[2] };
      });
  }

  function resolveBranchNavFromCandidates(candidates, options) {
    for (const candidate of candidates) {
      const nav = resolveBranchNavCandidate(candidate, options);
      if (nav) return nav;
    }
    return null;
  }

  function resolveBranchNavCandidate({ el, current, total }, { allowPositionalFallback = true } = {}) {
    let node = el.parentElement;
    for (let lvl = 0; lvl < 6 && node; lvl++) {
      const btns = [...node.querySelectorAll('button')].filter(isVisibleButton);
      if (!btns.length) {
        node = node.parentElement;
        continue;
      }

      const prevBtn = btns.find(b => {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        return l.includes('上一') || l.includes('prev') || l.includes('previous') || l.includes('earlier');
      });
      const nextBtn = btns.find(b => {
        const l = (b.getAttribute('aria-label') || '').toLowerCase();
        return l.includes('下一') || l.includes('next') || l.includes('later');
      });
      if (prevBtn && nextBtn) return { current, total, prevBtn, nextBtn };

      if (allowPositionalFallback && btns.length >= 2) {
        const counterRect = el.getBoundingClientRect();
        const withDist = btns
          .map(b => {
            const r = b.getBoundingClientRect();
            const centerX = (r.left + r.right) / 2;
            const centerY = (r.top + r.bottom) / 2;
            const counterCenterX = (counterRect.left + counterRect.right) / 2;
            const counterCenterY = (counterRect.top + counterRect.bottom) / 2;
            return {
              b,
              dist: Math.abs(centerX - counterCenterX) + Math.abs(centerY - counterCenterY),
              left: r.left,
            };
          })
          .sort((a, b) => a.dist - b.dist);

        if (withDist.length >= 2) {
          const [a, b] = withDist;
          const leftBtn = a.left < b.left ? a.b : b.b;
          const rightBtn = a.left < b.left ? b.b : a.b;
          return { current, total, prevBtn: leftBtn, nextBtn: rightBtn };
        }
      }

      node = node.parentElement;
    }
    return null;
  }

  function isVisibleButton(btn) {
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabledButton(btn) {
    return btn.disabled || btn.getAttribute('aria-disabled') === 'true';
  }

  function selectTopLevelCandidates(selectors) {
    const all = dedupeElements(selectors.flatMap(sel => [...document.querySelectorAll(sel)]));
    return all.filter(el => !all.some(other => other !== el && other.contains(el)));
  }

  function dedupeElements(elements) {
    return [...new Set(elements)];
  }

  function isReadableTurnCandidate(el, { minText = 8 } = {}) {
    const text = extractText(el);
    if (text.length < minText) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 80 && rect.height > 12;
  }

  function isClaudeBranchNavWidget(el) {
    const text = (el.textContent || '').trim();
    if (/^\d+\s*\/\s*\d+$/.test(text)) return true;
    const btnCount = el.querySelectorAll('button').length;
    return btnCount >= 2 && text.length <= 24 && /\d+\s*\/\s*\d+/.test(text);
  }

  function rectTop(el) {
    return el.getBoundingClientRect().top;
  }

  function rectCenterY(el) {
    const rect = el.getBoundingClientRect();
    return (rect.top + rect.bottom) / 2;
  }

  function buildTurnStateSig(turn) {
    return `${turn.branchIndex || 0}:${turn.branchTotal || 0}:${textSignature(turn.text)}:${Boolean(turn.prevBtn)}:${Boolean(turn.nextBtn)}`;
  }

  function buildClaudeAssistantDomId(userEl, userIdx, text, branchIndex) {
    const anchor = userEl.getAttribute('data-message-id') || `u${userIdx}`;
    const sig = textSignature(text).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'reply';
    return `cbv_a_${anchor}_b${branchIndex}_${sig}`;
  }

  function readCurrentPath() {
    return readRawTurns().map(makePathEntry);
  }

  function serializeTurns(turns) {
    return turns.map(t => ({
      id: makeNodeId(t.turnIndex, t.branchIndex, t.domId),
      turnIndex: t.turnIndex, role: t.role, text: t.text,
      branchIndex: t.branchIndex, branchTotal: t.branchTotal,
    }));
  }

  function makeNodeId(turnIndex, branchIndex, domId) {
    return cbvMakeNodeId(turnIndex, branchIndex, domId);
  }

  // ── Text extraction ───────────────────────────────────────────────────────────
  function extractText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button,svg,nav,[role="toolbar"],[role="group"]').forEach(e => e.remove());
    return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  }

  function textSignature(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  // ── Storage persistence ───────────────────────────────────────────────────────
  function saveToStorage(treeNodes, activePath) {
    const key = storageKey();
    chrome.storage.local.set({
      [key]: {
        nodes:      [...treeNodes.values()],
        activePath,
        savedAt:    Date.now(),
        url:        location.href,
      },
    }).catch(() => {});
  }

  function storageKey() {
    // Key by conversation URL (path only, strip query params)
    try {
      const u = new URL(location.href);
      return 'cbv_tree_' + (u.pathname + u.hash).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120);
    } catch { return 'cbv_tree_default'; }
  }

  // ── MutationObserver ──────────────────────────────────────────────────────────
  function startObserver() {
    observer?.disconnect();
    bindScrollSync();
    observer = new MutationObserver(() => {
      if (building) return;
      clearTimeout(mutTimer);
      mutTimer = setTimeout(() => {
        syncStateToPanel(true);
        scheduleViewportSync();
      }, DEBOUNCE_MS);
    });
    const target = document.querySelector('main') || document.body;
    observer.observe(target, { childList: true, subtree: true });
  }

  function scheduleViewportSync() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      const visiblePath = readVisiblePath();
      const sig = JSON.stringify(visiblePath.map(p => p.id));
      if (sig !== lastVisibleSig) {
        lastVisibleSig = sig;
        sendToPanel({ type: 'VISIBLE_RANGE', visiblePath });
      }
    }, VIEWPORT_SYNC_MS);
  }

  function resetLoadingWindow() {
    pageLoadStartedAt = Date.now();
  }

  function pageSeemsLoading() {
    if (Date.now() - pageLoadStartedAt < 7000) return true;

    const loadingSelectors = [
      "[aria-busy='true']",
      "[role='progressbar']",
      "[data-testid*='loading']",
      "[class*='loading']",
      "[class*='spinner']",
      "[class*='skeleton']",
    ];

    for (const selector of loadingSelectors) {
      try {
        if (document.querySelector(selector)) return true;
      } catch (_) {}
    }

    return false;
  }

  function isLikelyChatConversationPage() {
    try {
      const path = new URL(location.href).pathname || '';
      return path.includes('/c/');
    } catch (_) {
      return (location.pathname || '').includes('/c/');
    }
  }

  function syncStateToPanel(force = false) {
    const turns = serializeTurns(readRawTurns());
    if (!turns.length) {
      if (pageSeemsLoading()) {
        sendToPanel({ type: 'CONVERSATION_LOADING' });
        return;
      }
      if (isLikelyChatConversationPage()) {
        maybeReportBreakage('no_turns_detected', {
          phase: 'sync',
          force,
        });
      }
      sendToPanel({ type: 'CONVERSATION_LOADING' });
      return;
    }
    const activePath = turns.map(makePathEntry);
    const sig = JSON.stringify(turns.map(t => `${t.id}:${t.branchTotal}:${textSignature(t.text)}`));
    if (!force && sig === lastStateSig) return;
    lastStateSig = sig;
    sendToPanel({ type: 'STATE_SYNC', turns, activePath });
  }

  function startStatePolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (building) return;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastStateSig = '';
        lastVisibleSig = '';
        lastDiagnostics = null;
        lastDiagnosticSig = '';
        resetLoadingWindow();
        sendToPanel({ type: 'PAGE_READY', platform: PLATFORM, url: location.href });
        syncStateToPanel(true);
      }
      bindScrollSync();
      syncStateToPanel(false);
      scheduleViewportSync();
    }, 350);
  }

  function readVisiblePath() {
    const host = getScrollHost();
    const hostRect = host === window ? { top: 0, bottom: window.innerHeight } : host.getBoundingClientRect();
    const viewportTop = hostRect.top;
    const viewportBottom = hostRect.bottom;
    return readRawTurns()
      .filter(t => {
        const rect = t.article?.getBoundingClientRect();
        if (!rect) return false;
        const visibleTop = Math.max(viewportTop, rect.top);
        const visibleBottom = Math.min(viewportBottom, rect.bottom);
        const overlap = visibleBottom - visibleTop;
        return overlap > Math.min(60, rect.height * 0.28);
      })
      .map(makePathEntry);
  }

  async function waitForTurnStable(turnIndex, branchIndex) {
    let stableCount = 0;
    let lastSig = '';
    for (let i = 0; i < 14; i++) {
      const turn = readRawTurns()[turnIndex];
      const sig = turn ? `${turn.branchIndex}:${turn.domId || ''}:${(turn.text || '').slice(0, 32)}` : '';
      if (turn && turn.branchIndex === branchIndex && sig === lastSig) {
        stableCount += 1;
        if (stableCount >= 2) return turn;
      } else {
        stableCount = turn && turn.branchIndex === branchIndex ? 1 : 0;
        lastSig = sig;
      }
      await sleep(120);
    }
    return readRawTurns()[turnIndex] || null;
  }

  function scrollToTurn(article) {
    const host = getScrollHost();
    const anchor = article.querySelector('[data-message-id]') || article;
    const rect = anchor.getBoundingClientRect();
    if (host === window) {
      const targetTop = window.scrollY + rect.top - Math.max(72, Math.round(window.innerHeight * 0.22));
      window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const targetTop = host.scrollTop + (rect.top - hostRect.top) - Math.max(48, Math.round(host.clientHeight * 0.18));
    host.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }

  function injectHighlightStyle() {
    if (document.getElementById('cbv-nav-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'cbv-nav-highlight-style';
    style.textContent = `
      .cbv-nav-highlight {
        position: relative;
        outline: 2px solid rgba(35, 131, 226, 0.9);
        outline-offset: 4px;
        border-radius: 12px;
        box-shadow: 0 0 0 8px rgba(35, 131, 226, 0.12);
        animation: cbv-nav-pulse 1.2s ease-out 1;
      }
      @keyframes cbv-nav-pulse {
        0% { box-shadow: 0 0 0 0 rgba(35, 131, 226, 0.28); }
        100% { box-shadow: 0 0 0 10px rgba(35, 131, 226, 0.0); }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function highlightTurn(article) {
    if (highlightedTurn && highlightedTurn !== article) {
      highlightedTurn.classList.remove('cbv-nav-highlight');
    }
    highlightedTurn = article;
    article.classList.remove('cbv-nav-highlight');
    void article.offsetWidth;
    article.classList.add('cbv-nav-highlight');
    setTimeout(() => {
      if (highlightedTurn === article) article.classList.remove('cbv-nav-highlight');
    }, 1800);
  }

  function bindScrollSync() {
    const nextHost = getScrollHost();
    if (scrollHost === nextHost) return;
    if (scrollHost && scrollHost !== window) scrollHost.removeEventListener('scroll', scheduleViewportSync);
    window.removeEventListener('scroll', scheduleViewportSync);
    scrollHost = nextHost;
    if (scrollHost === window) window.addEventListener('scroll', scheduleViewportSync, { passive: true });
    else scrollHost.addEventListener('scroll', scheduleViewportSync, { passive: true });
  }

  function getScrollHost() {
    const sample = readRawTurns()[0]?.article || document.querySelector('main') || document.body;
    let node = sample;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20) return node;
      node = node.parentElement;
    }

    // Claude sometimes scrolls in a nested react scroller that does not surface on the message node path.
    const fallback = [...document.querySelectorAll('main div, section div')].find(el => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 80;
    });
    if (fallback) return fallback;

    return window;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
