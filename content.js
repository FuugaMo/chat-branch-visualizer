// content.js — runs in the ChatGPT/Claude page
// Responsibilities: DOM scanning, branch navigation
// Communicates with sidepanel.js via background.js message passing

(() => {
  'use strict';

  const NAV_WAIT_MS   = 500;   // ms to wait after each button click
  const NAV_TIMEOUT   = 3000;  // ms before nav is considered stuck
  const NAV_RETRIES   = 2;     // retry attempts if nav appears stuck
  const DEBOUNCE_MS   = 1200;
  const PLATFORM      = detectPlatform();

  let mutTimer  = null;
  let observer  = null;
  let building  = false;
  let cancelled = false;  // set to true by CANCEL command

  // ── Platform ────────────────────────────────────────────────────────────────
  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
    if (h.includes('claude.ai'))  return 'claude';
    return 'unknown';
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  init();

  function init() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      handleMessage(msg).then(sendResponse);
      return true; // async
    });
    startObserver();
    sendToPanel({ type: 'PAGE_READY', platform: PLATFORM, url: location.href });
  }

  // ── Message handler ──────────────────────────────────────────────────────────
  async function handleMessage(msg) {
    switch (msg.type) {
      case 'BUILD':
        return await cmdBuild();
      case 'CANCEL':
        return cmdCancel();
      case 'QUICK_SCAN':
        return { type: 'SCAN_RESULT', turns: serializeTurns(readRawTurns()) };
      case 'NAVIGATE':
        return await cmdNavigate(msg.path);
      default:
        return { ok: false };
    }
  }

  // ── Send to sidepanel (via background) ───────────────────────────────────────
  function sendToPanel(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
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

    sendToPanel({ type: 'BUILD_START' });

    try {
      await dfsCollect(null, 0, treeNodes);
    } catch (e) {
      const reason = cancelled ? 'cancelled' : e.message;
      sendToPanel({ type: cancelled ? 'BUILD_CANCELLED' : 'BUILD_ERROR', message: reason });
      building   = false;
      cancelled  = false;
      startObserver();
      return { ok: false };
    }

    building  = false;
    cancelled = false;
    startObserver();

    const activePath = readCurrentPath();
    sendToPanel({
      type:       'BUILD_DONE',
      nodes:      [...treeNodes.values()],
      activePath,
    });

    // Persist to storage
    saveToStorage(treeNodes, activePath);

    return { ok: true };
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
      const turns = readRawTurns();
      const t     = turns[leaf.turnIndex];
      if (t?.article) t.article.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const activePath = readCurrentPath();
    sendToPanel({ type: 'NAV_DONE', activePath });
    return { ok: true, activePath };
  }

  // ── DFS tree builder ─────────────────────────────────────────────────────────
  async function dfsCollect(parentId, turnIdx, treeNodes) {
    if (cancelled) throw new Error('cancelled');

    const turns = readRawTurns();
    if (turnIdx >= turns.length) return;

    const turn           = turns[turnIdx];
    const branchTotal    = turn.branchTotal;
    const originalBranch = turn.branchIndex;

    for (let b = 1; b <= branchTotal; b++) {
      if (cancelled) throw new Error('cancelled');

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

      await dfsCollect(nodeId, turnIdx + 1, treeNodes);

      if (cancelled) throw new Error('cancelled');

      // Restore to b after recursion
      const afterTurns = readRawTurns();
      const afterTurn  = afterTurns[turnIdx];
      if (afterTurn && afterTurn.branchIndex !== b) {
        await navigateTurnToBranch(afterTurn, b);
        await sleep(NAV_WAIT_MS);
      }
    }

    if (cancelled) throw new Error('cancelled');

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

    for (let step = 0; step < 30; step++) {
      if (cancelled) return false;
      if (Date.now() > deadline) return false;

      const fresh = readRawTurns()[turn.turnIndex];
      if (!fresh) return false;
      if (fresh.branchIndex === target) return true;

      if (target > fresh.branchIndex) { fresh.nextBtn?.click(); }
      else                            { fresh.prevBtn?.click(); }

      await sleep(NAV_WAIT_MS);
    }

    // One last check
    const final = readRawTurns()[turn.turnIndex];
    return final?.branchIndex === target;
  }

  // ── DOM reading ──────────────────────────────────────────────────────────────
  function readRawTurns() {
    if (PLATFORM === 'chatgpt') return readChatGPTTurns();
    if (PLATFORM === 'claude')  return readClaudeTurns();
    return readGenericTurns();
  }

  function readChatGPTTurns() {
    const turns = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    return turns.map((turn, idx) => {
      const role   = turn.getAttribute('data-turn') === 'user' ? 'user' : 'assistant';
      const msgDiv = turn.querySelector('[data-message-id]');
      const msgId  = msgDiv?.getAttribute('data-message-id') || turn.getAttribute('data-turn-id') || null;
      const nav    = findBranchNav(turn);
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
    // Strategy 1: prefer data-testid human/assistant turns
    let turnEls = [
      ...document.querySelectorAll('[data-testid="human-turn"],[data-testid="assistant-turn"]'),
    ];

    // Strategy 2: fall back to conversation-turn wrappers
    if (!turnEls.length) {
      turnEls = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
    }

    // Strategy 3: look for message-container divs used in some Claude layouts
    if (!turnEls.length) {
      turnEls = [...document.querySelectorAll(
        '[class*="human-turn"],[class*="assistant-turn"],[class*="HumanTurn"],[class*="AssistantTurn"]'
      )];
    }

    return turnEls.map((turn, idx) => {
      const testId = turn.getAttribute('data-testid') || '';
      const cls    = turn.className || '';
      const isUser =
        testId.includes('human') ||
        cls.toLowerCase().includes('human') ||
        cls.toLowerCase().includes('user');
      const role = isUser ? 'user' : 'assistant';

      const nav = findBranchNav(turn);

      return {
        turnIndex:   idx,
        domId:       turn.getAttribute('data-message-id') || null,
        role,
        text:        extractText(turn),
        branchIndex: nav?.current ?? 1,
        branchTotal: nav?.total   ?? 1,
        prevBtn:     nav?.prevBtn ?? null,
        nextBtn:     nav?.nextBtn ?? null,
        article:     turn,
      };
    });
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
  function findBranchNav(container) {
    const candidates = [];

    // Walk all descendants looking for "X / Y" text patterns
    for (const el of container.querySelectorAll('*')) {
      if (el.children.length > 2) continue;
      const m = el.textContent?.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) continue;
      const current = +m[1], total = +m[2];
      if (total < 2) continue;
      candidates.push({ el, current, total });
    }

    if (!candidates.length) return null;

    for (const { el, current, total } of candidates) {
      // Walk up ancestors to find the button group
      let node = el.parentElement;
      for (let lvl = 0; lvl < 6 && node; lvl++) {
        const btns = [...node.querySelectorAll('button')];
        if (!btns.length) { node = node.parentElement; continue; }

        // ChatGPT: aria-label based (Chinese or English)
        const prevBtn = btns.find(b => {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          return l.includes('上一') || l.includes('prev') || l.includes('previous') || l.includes('earlier');
        });
        const nextBtn = btns.find(b => {
          const l = (b.getAttribute('aria-label') || '').toLowerCase();
          return l.includes('下一') || l.includes('next') || l.includes('later');
        });
        if (prevBtn && nextBtn) return { current, total, prevBtn, nextBtn };

        // Claude: no aria-labels — the two buttons immediately surrounding the
        // counter element are prev (left) and next (right).
        // Find buttons that are siblings/neighbors of the counter's parent.
        if (btns.length >= 2) {
          const counterRect = el.getBoundingClientRect();
          const sorted = btns
            .map(b => ({ b, r: b.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0)  // visible only
            .sort((a, b2) => a.r.left - b2.r.left);

          // Find the two closest buttons to the counter by X position
          const withDist = sorted.map(({ b, r }) => ({
            b,
            dist: Math.abs((r.left + r.right) / 2 - (counterRect.left + counterRect.right) / 2),
          })).sort((a, b2) => a.dist - b2.dist);

          if (withDist.length >= 2) {
            const [closestA, closestB] = withDist;
            const rA = closestA.b.getBoundingClientRect();
            const rB = closestB.b.getBoundingClientRect();
            const leftBtn  = rA.left < rB.left ? closestA.b : closestB.b;
            const rightBtn = rA.left < rB.left ? closestB.b : closestA.b;
            return { current, total, prevBtn: leftBtn, nextBtn: rightBtn };
          }
        }

        node = node.parentElement;
      }
    }
    return null;
  }

  function readCurrentPath() {
    return readRawTurns().map(t => ({
      id:          makeNodeId(t.turnIndex, t.branchIndex, t.domId),
      turnIndex:   t.turnIndex,
      branchIndex: t.branchIndex,
    }));
  }

  function serializeTurns(turns) {
    return turns.map(t => ({
      turnIndex: t.turnIndex, role: t.role, text: t.text,
      branchIndex: t.branchIndex, branchTotal: t.branchTotal,
    }));
  }

  function makeNodeId(turnIndex, branchIndex, domId) {
    if (domId && !domId.startsWith('g_') && !domId.startsWith('claude_')) return domId;
    return `t${turnIndex}_b${branchIndex}`;
  }

  // ── Text extraction ───────────────────────────────────────────────────────────
  function extractText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button,svg,nav,[role="toolbar"],[role="group"]').forEach(e => e.remove());
    return (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 220);
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
    observer = new MutationObserver(() => {
      if (building) return;
      clearTimeout(mutTimer);
      mutTimer = setTimeout(() => {
        sendToPanel({ type: 'ACTIVE_PATH', activePath: readCurrentPath() });
      }, DEBOUNCE_MS);
    });
    const target = document.querySelector('main') || document.body;
    observer.observe(target, { childList: true, subtree: true });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
