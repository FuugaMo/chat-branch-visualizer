// background.js — service worker
// Responsibilities:
//   1. Open side panel when toolbar icon clicked
//   2. Route messages between content.js <-> sidepanel.js

// ── Open side panel on action click ──────────────────────────────────────────
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Enable side panel for supported pages ─────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const supported =
    tab.url?.includes('chatgpt.com') ||
    tab.url?.includes('chat.openai.com') ||
    tab.url?.includes('claude.ai');
  chrome.sidePanel.setOptions({
    tabId,
    enabled: supported,
    path:    'sidepanel.html',
  });
});

// ── Message routing ───────────────────────────────────────────────────────────
// content.js  → background → sidepanel  (content sends tree data / nav results)
// sidepanel   → background → content    (sidepanel sends nav commands)

// Keep track of which port is the sidepanel for a given tab
const sidepanelPorts = new Map(); // tabId → port

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'cbv-sidepanel') return;

  // Figure out which tab this sidepanel belongs to
  // (sidePanel port doesn't expose tabId directly — we ask the panel to send it)
  let tabId = null;

  port.onMessage.addListener(async msg => {
    if (msg.type === 'REGISTER') {
      tabId = msg.tabId;
      sidepanelPorts.set(tabId, port);
      return;
    }

    // sidepanel → content: navigation / cancel commands
    if ((msg.type === 'NAVIGATE' || msg.type === 'CANCEL') && tabId) {
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (tabId) sidepanelPorts.delete(tabId);
  });
});

// content.js → background → sidepanel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Forward to sidepanel if connected
  const port = sidepanelPorts.get(tabId);
  if (port) {
    try { port.postMessage({ ...msg, tabId }); } catch (_) {}
  }

  // Always ACK
  sendResponse({ ok: true });
  return true;
});
