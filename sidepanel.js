// sidepanel.js
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let treeNodes  = new Map();
let activePath = new Set();
let currentTabId = null;

// ── Camera ────────────────────────────────────────────────────────────────────
let cam = { x: 20, y: 20, scale: 1 };
let isPanning  = false;
let panStart   = { x: 0, y: 0, cx: 0, cy: 0 };
let lastPinch  = null;
// Fix 2: rAF throttle
let rafPending = false;

// ── Layout constants (Fix 5: wider nodes) ─────────────────────────────────────
const NW    = 180;   // node width
const NH    = 52;    // node height (two-line layout)
const H_GAP = 16;
const V_GAP = 64;
const PAD   = 24;

// Fix 4: module-scope layout map (shared by renderTree + minimap + panToNode)
let layoutMap = new Map();   // nodeId → { x, y, w }

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;

  const port = chrome.runtime.connect({ name: 'cbv-sidepanel' });
  port.postMessage({ type: 'REGISTER', tabId: currentTabId });
  port.onMessage.addListener(onContentMessage);

  document.getElementById('btn-build').addEventListener('click', () =>
    sendToContent({ type: 'BUILD' }));
  document.getElementById('btn-cancel').addEventListener('click', () =>
    sendToContent({ type: 'CANCEL' }));
  document.getElementById('btn-refresh').addEventListener('click', () =>
    sendToContent({ type: 'QUICK_SCAN' }));
  document.getElementById('btn-fit').addEventListener('click', fitView);

  initInteraction();
  sendToContent({ type: 'QUICK_SCAN' });

  // Attempt to restore a previously built tree for this tab's URL
  restoreFromStorage();
})();

// ── Messaging ─────────────────────────────────────────────────────────────────
function sendToContent(msg) {
  if (!currentTabId) return;
  chrome.tabs.sendMessage(currentTabId, msg).catch(() => {});
}

function onContentMessage(msg) {
  switch (msg.type) {
    case 'PAGE_READY':
      setStatus(`Connected — ${msg.platform}`, 'ok');
      sendToContent({ type: 'QUICK_SCAN' });
      break;

    case 'SCAN_RESULT':
      activePath = new Set(msg.turns.map(t => `t${t.turnIndex}_b${t.branchIndex}`));
      renderTree();
      break;

    case 'BUILD_START':
      treeNodes.clear(); activePath.clear();
      setProgress(0); showProgress();
      setStatus('Building tree…', 'working');
      document.getElementById('btn-build').hidden = true;
      document.getElementById('btn-cancel').hidden = false;
      break;

    case 'BUILD_PROGRESS': {
      const pct = Math.min(99, Math.round((msg.turnIdx / Math.max(msg.turnCount, 1)) * 100));
      setProgress(pct);
      setStatus(`Scanning turn ${msg.turnIdx + 1}/${msg.turnCount} · ${msg.nodeCount} nodes`, 'working');
      break;
    }

    case 'BUILD_DONE':
      treeNodes   = new Map(msg.nodes.map(n => [n.id, n]));
      activePath  = new Set(msg.activePath.map(p => p.id));
      hideProgress();
      setBuildIdle();
      setStatus(`${treeNodes.size} nodes · ${countLeaves()} branches`, 'ok');
      renderTree();
      requestAnimationFrame(fitView);
      break;

    case 'BUILD_ERROR':
      hideProgress();
      setBuildIdle();
      setStatus(`Error: ${msg.message}`, 'error');
      break;

    case 'BUILD_CANCELLED':
      hideProgress();
      setBuildIdle();
      setStatus('Build cancelled', 'idle');
      break;

    case 'BUILD_WARNING':
      // Non-fatal: show warning in status but keep building
      setStatus(`Warning: ${msg.message}`, 'working');
      break;

    case 'NAV_DONE':
    case 'ACTIVE_PATH':
      activePath = new Set(msg.activePath.map(p => p.id));
      renderTree();
      // Fix 4: jump camera to active leaf after nav
      requestAnimationFrame(panToActiveLeaf);
      break;
  }
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
  setStatus(`Navigating to turn ${node.turnIndex + 1}, branch ${node.branchIndex}…`, 'working');
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
  };

  // ── 1. Roots ─────────────────────────────────────────────────────────────
  const roots = [...treeNodes.values()].filter(n => !n.parentId || !treeNodes.has(n.parentId));

  // ── 2. Layout into module-scope layoutMap ─────────────────────────────────
  layoutMap.clear();

  function subtreeW(id) {
    const n = treeNodes.get(id);
    if (!n) return NW;
    const kids = n.children.map(c => treeNodes.get(c)).filter(Boolean);
    if (!kids.length) { layoutMap.set(id, { w: NW }); return NW; }
    let total = kids.reduce((s, k, i) => s + subtreeW(k.id) + (i > 0 ? H_GAP : 0), 0);
    total = Math.max(total, NW);
    layoutMap.set(id, { w: total });
    return total;
  }

  function assign(id, left, depth) {
    const n = treeNodes.get(id);
    if (!n) return;
    const info = layoutMap.get(id) || { w: NW };
    info.x = left + info.w / 2;
    info.y = PAD + depth * (NH + V_GAP);
    layoutMap.set(id, info);
    const kids = n.children.map(c => treeNodes.get(c)).filter(Boolean);
    let c = left;
    kids.forEach((k, i) => {
      if (i > 0) c += H_GAP;
      assign(k.id, c, depth + 1);
      c += layoutMap.get(k.id)?.w ?? NW;
    });
  }

  let c = PAD;
  roots.forEach((r, i) => {
    subtreeW(r.id);
    if (i > 0) c += H_GAP * 2;
    assign(r.id, c, 0);
    c += layoutMap.get(r.id)?.w ?? NW;
  });

  // ── 3. Canvas bounds ──────────────────────────────────────────────────────
  let maxX = 0, maxY = 0;
  layoutMap.forEach(({ x, y }) => {
    maxX = Math.max(maxX, x + NW / 2 + PAD);
    maxY = Math.max(maxY, y + NH + PAD);
  });

  // ── 4. Build SVG ──────────────────────────────────────────────────────────
  const NS  = 'http://www.w3.org/2000/svg';
  const svg = el(NS, 'svg', { width: maxX, height: maxY });

  // Edges
  const edgeG = el(NS, 'g');
  treeNodes.forEach(node => {
    const pi = layoutMap.get(node.id);
    if (!pi) return;
    node.children.forEach(cid => {
      const child = treeNodes.get(cid);
      const ci    = layoutMap.get(cid);
      if (!ci || !child) return;
      const x1 = pi.x, y1 = pi.y + NH, x2 = ci.x, y2 = ci.y;
      const my = (y1 + y2) / 2;
      const both   = activePath.has(node.id) && activePath.has(cid);
      const isUser = child.role === 'user';
      edgeG.appendChild(el(NS, 'path', {
        d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`,
        fill: 'none',
        stroke: both ? (isUser ? C.edgeActiveU : C.edgeActiveA) : C.edge,
        'stroke-width': both ? '2' : '1.5',
        'stroke-linecap': 'round',
        opacity: both ? '1' : '0.55',
      }));
    });
  });
  svg.appendChild(edgeG);

  // Nodes
  const nodeG = el(NS, 'g');
  treeNodes.forEach(node => {
    const info = layoutMap.get(node.id);
    if (!info) return;

    const isActive = activePath.has(node.id);
    const isUser   = node.role === 'user';
    const nx = info.x - NW / 2, ny = info.y;

    const g = el(NS, 'g', { class: 'node-g' });

    // Shadow
    g.appendChild(el(NS, 'rect', {
      x: nx + 1, y: ny + 2, width: NW, height: NH, rx: 10,
      fill: '#000',
      opacity: isActive ? '0.12' : '0.05',
      style: 'filter:blur(3px)',
    }));

    // Box
    const fill   = isActive ? (isUser ? C.nodeFillActiveU : C.nodeFillActiveA)
                            : (isUser ? C.nodeFillU        : C.nodeFillA);
    const stroke = isActive ? (isUser ? C.nodeStrokeActiveU : C.nodeStrokeActiveA)
                            : C.nodeStroke;
    const box = el(NS, 'rect', {
      class: 'node-box',
      x: nx, y: ny, width: NW, height: NH, rx: 10,
      fill, stroke, 'stroke-width': isActive ? '1.5' : '1',
    });
    g.appendChild(box);

    // Fix 5: two-line layout
    // Row 1 (top): role pill + branch badge
    // Row 2 (bottom): message text
    const ROW1_Y = ny + 13;   // center of top row
    const ROW2_Y = ny + NH - 13; // center of bottom row

    // Role pill
    const pillW = 20, pillH = 14;
    g.appendChild(el(NS, 'rect', {
      x: nx + 8, y: ROW1_Y - pillH / 2, width: pillW, height: pillH, rx: 3,
      fill: isUser ? C.tagBgU : C.tagBgA,
    }));
    g.appendChild(svgText(nx + 8 + pillW / 2, ROW1_Y + 0.5,
      isUser ? 'U' : 'A', {
        fill: isUser ? C.tagTxU : C.tagTxA,
        'font-size': '9', 'font-weight': '700',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }
    ));

    // Branch badge (row 1, right of pill)
    let badgeRightX = nx + 8 + pillW + 5;
    if (node.branchTotal > 1) {
      const label  = `${node.branchIndex}/${node.branchTotal}`;
      const badgeW = label.length <= 3 ? 26 : 32;
      g.appendChild(el(NS, 'rect', {
        x: badgeRightX, y: ROW1_Y - pillH / 2,
        width: badgeW, height: pillH, rx: 3,
        fill: C.badgeBg,
      }));
      g.appendChild(svgText(badgeRightX + badgeW / 2, ROW1_Y + 0.5, label, {
        fill: C.badgeTx,
        'font-size': '9', 'font-weight': '600',
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }));
      badgeRightX += badgeW + 4;
    }

    // Turn index hint (small, right-aligned in row 1)
    g.appendChild(svgText(nx + NW - 7, ROW1_Y + 0.5,
      `#${node.turnIndex + 1}`, {
        fill: C.nodeTxMuted,
        'font-size': '9',
        'text-anchor': 'end', 'dominant-baseline': 'middle',
        'font-family': 'ui-monospace, monospace',
      }
    ));

    // Separator line between rows
    g.appendChild(el(NS, 'line', {
      x1: nx + 8, y1: ny + NH / 2,
      x2: nx + NW - 8, y2: ny + NH / 2,
      stroke: stroke, opacity: '0.35', 'stroke-width': '0.75',
    }));

    // Message text (row 2) — full width, more chars
    const maxChars = Math.max(6, Math.floor((NW - 16) / 6.2));
    const label    = node.text.length > maxChars
      ? node.text.slice(0, maxChars - 1) + '…'
      : node.text;
    g.appendChild(svgText(nx + 8, ROW2_Y + 0.5, label, {
      fill: isActive ? C.nodeTx : C.nodeTxMuted,
      'font-size': '11',
      'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'dominant-baseline': 'middle',
    }));

    // Tooltip
    const ttl = document.createElementNS(NS, 'title');
    ttl.textContent = `Turn ${node.turnIndex + 1} · ${node.role}\n${node.text}`;
    g.appendChild(ttl);

    // Hit + hover
    const hit = el(NS, 'rect', { x: nx, y: ny, width: NW, height: NH, fill: 'transparent' });
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => navigateTo(node.id));
    hit.addEventListener('mouseenter', () => {
      box.setAttribute('stroke', isUser ? C.nodeStrokeActiveU : C.nodeStrokeActiveA);
      box.setAttribute('stroke-width', '2');
    });
    hit.addEventListener('mouseleave', () => {
      box.setAttribute('stroke', stroke);
      box.setAttribute('stroke-width', isActive ? '1.5' : '1');
    });
    g.appendChild(hit);

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

  // ── Wheel / trackpad ──────────────────────────────────────────────────────
  // Chrome sends wheel events for both trackpad scroll and pinch-to-zoom.
  // Key distinction: pinch sets e.ctrlKey = true; two-finger scroll does not.
  //
  // Desired behaviour (matching Figma / Miro):
  //   • Two-finger scroll (ctrlKey=false) → pan (deltaX = horizontal, deltaY = vertical)
  //   • Pinch (ctrlKey=true)              → zoom centred on cursor
  //   • Ctrl + scroll wheel               → zoom (same as pinch)
  tree.addEventListener('wheel', e => {
    e.preventDefault();
    const r = tree.getBoundingClientRect();

    if (e.ctrlKey) {
      // Pinch-to-zoom or Ctrl+scroll → zoom
      // deltaY is negative when spreading (zoom in), positive when pinching (zoom out)
      const raw    = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      const factor = Math.pow(0.998, raw); // smaller base = gentler curve
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    } else {
      // Two-finger scroll → pan
      const dx = e.deltaMode === 1 ? e.deltaX * 20 : e.deltaX;
      const dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
      cam.x -= dx;
      cam.y -= dy;
      applyTransform();
      renderMinimap();
    }
  }, { passive: false });

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

  tree.style.cursor = 'grab';

  // ── Minimap click → pan to that region ───────────────────────────────────
  initMinimapClick();
}

function pinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function zoomAt(px, py, factor) {
  const next = Math.max(0.1, Math.min(5, cam.scale * factor));
  cam.x      = px - (px - cam.x) * (next / cam.scale);
  cam.y      = py - (py - cam.y) * (next / cam.scale);
  cam.scale  = next;
  applyTransform();
}

// Fix 2: rAF-throttled transform writes
function applyTransform() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    const c = document.getElementById('cbv-canvas');
    if (c) c.style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.scale})`;
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
  cam.y     = PAD;
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
    if (!activePath.has(n.id)) return;
    const hasActiveChild = n.children.some(c => activePath.has(c));
    if (!hasActiveChild) leaf = n;
  });
  if (!leaf) return;

  const info = layoutMap.get(leaf.id);
  if (!info) return;

  const tree = document.getElementById('cbv-tree');
  if (!tree) return;
  const tw = tree.clientWidth, th = tree.clientHeight;

  const targetX = tw / 2 - info.x * cam.scale;
  const targetY = th / 2 - (info.y + NH / 2) * cam.scale;

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
  treeNodes.forEach(node => {
    const pi = layoutMap.get(node.id);
    if (!pi) return;
    node.children.forEach(cid => {
      const ci = layoutMap.get(cid);
      if (!ci) return;
      ctx.beginPath();
      ctx.moveTo(pi.x * sx, (pi.y + NH) * sy);
      ctx.lineTo(ci.x * sx, ci.y * sy);
      ctx.stroke();
    });
  });

  // Draw nodes
  treeNodes.forEach(node => {
    const info = layoutMap.get(node.id);
    if (!info) return;
    const isActive = activePath.has(node.id);
    const isUser   = node.role === 'user';
    ctx.fillStyle = isActive
      ? (isUser ? '#2383e2' : '#0f7b6c')
      : (isUser ? '#93c5fd' : '#6ee7b7');
    ctx.globalAlpha = isActive ? 1 : 0.5;
    ctx.beginPath();
    ctx.roundRect(
      (info.x - NW / 2) * sx, info.y * sy,
      NW * sx, NH * sy, 2
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
async function restoreFromStorage() {
  if (!currentTabId) return;
  try {
    const tab = await chrome.tabs.get(currentTabId);
    const key = storageKeyFromUrl(tab.url || '');
    if (!key) return;
    const result = await chrome.storage.local.get(key);
    const saved  = result[key];
    if (!saved || !saved.nodes?.length) return;

    // Only restore if saved within the last 24 hours
    const AGE_LIMIT = 24 * 60 * 60 * 1000;
    if (Date.now() - saved.savedAt > AGE_LIMIT) return;

    treeNodes  = new Map(saved.nodes.map(n => [n.id, n]));
    activePath = new Set((saved.activePath || []).map(p => p.id));
    setStatus(`Restored ${treeNodes.size} nodes (saved ${timeAgo(saved.savedAt)})`, 'ok');
    renderTree();
    requestAnimationFrame(fitView);
  } catch (_) { /* storage unavailable — fine */ }
}

function storageKeyFromUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('chatgpt.com') &&
        !u.hostname.includes('chat.openai.com') &&
        !u.hostname.includes('claude.ai')) return null;
    return 'cbv_tree_' + (u.pathname + u.hash).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120);
  } catch { return null; }
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
