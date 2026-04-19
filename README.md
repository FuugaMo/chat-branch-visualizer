<div align="center">

# Chat Branch Visualizer

**Visualize your ChatGPT and Claude conversation branches as an interactive tree — in Chrome's native side panel.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-v0.3.6-blue?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/chat-branch-visualizer/mahknjdihdpeceompocgcclnmjikmncb)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## What it does

Every time you regenerate a response or edit a message in ChatGPT or Claude, the conversation splits into a new branch. These branches are invisible by default — Chat Branch Visualizer makes them a navigable tree.

| Feature | Description |
|---------|-------------|
| **Branch tree** | Renders every user and assistant turn as an interactive node graph |
| **Build full tree** | Auto-traverses all branches to build a complete map |
| **Navigate** | Click any node to jump to that point in the conversation |
| **Fit / Zoom / Locate** | Pan and zoom freely; jump to your current position with one click |
| **Snapshot** | Restores your last tree when you reopen a tab |

Supports **ChatGPT** (chatgpt.com) and **Claude** (claude.ai).

---

## Install

**From the Chrome Web Store (recommended)**

→ [Add to Chrome](https://chromewebstore.google.com/detail/chat-branch-visualizer/mahknjdihdpeceompocgcclnmjikmncb)

**Load unpacked (development)**

```bash
git clone https://github.com/FuugaMo/chat-branch-visualizer.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the repo folder
4. Open a ChatGPT or Claude conversation

---

## Project structure

```
├── manifest.json          Extension manifest (MV3)
├── content.js             DOM parser + branch navigator (runs in chat pages)
├── platform-config.js     Platform detection shared across contexts
├── reporting-config.js    Diagnostics reporting config
├── selectors.json         CSS selector registry for both platforms
├── background.js          Service worker — message routing + auto-reporting
├── sidepanel.html/js/css  Side panel UI
├── api/                   Vercel serverless functions (reporting backend)
├── scripts/               Local automation scripts
└── .github/workflows/     CI/CD automation
```

---

## Diagnostics & reporting

When the parser can't read the page (e.g. after a platform update changes the DOM), the extension captures a diagnostic snapshot and — if the user has opted in — sends it automatically to help identify and fix the breakage.

**What's captured:** CSS selectors, `data-testid` attributes, short text signatures (≤120 chars), extension version, page URL.
**What's never captured:** full chat content, account information, or any data outside chatgpt.com / claude.ai.

Users control reporting via the **⋯ menu → Send diagnostics** toggle. It is **off by default**.

→ [Privacy policy](https://chat-branch-visualizer.vercel.app/privacy)

### Reporting pipeline

When breakage is detected and the user has opted in, a report flows through:

```
content.js detects selector breakage / build error
  └─ PROBE_RESULT → background.js
       ├─ Consent check (cbv_consent.autoSend must be true)
       ├─ Deduplication (same platform+reason+broken selectors+url within 30 min → skip)
       └─ POST ──▶ api/reports.js (Vercel)
                        └─ repository_dispatch: extension_breakage_report
                             └─ report-intake.yml
                                  └─ Buffer: 3 identical reports → promoted to visible issue
                                       └─ OpenClaw opens fix PR (auto-fix label)
                                            └─ Codex reviews → human approves → auto-merge
```

### GitHub Actions workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `report-intake.yml` | `repository_dispatch` | Aggregates extension reports into issues (buffer → 3 reports → visible) |
| `review.yml` | PR opened | Structural review comment on auto-fix PRs |
| `codex-trigger.yml` | PR opened | Posts `@codex` mention to trigger AI review on auto-fix PRs |
| `auto-merge.yml` | PR approved | Squash merges auto-fix PRs after human approval |

---

## Scripts

```bash
npm run pack            # Build dist/chat-branch-visualizer-<version>.zip
npm run probe           # Run selector health probe locally
npm run check:reporting # Syntax-check API files
```

---

## Contributing

Bug reports and selector fixes are welcome. If the extension breaks after a ChatGPT or Claude update, open an issue — the diagnostics pipeline is designed to catch these automatically.
