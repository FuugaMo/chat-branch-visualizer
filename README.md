# Chat Branch Visualizer

**Visualize your ChatGPT and Claude conversation branches as an interactive tree — in Chrome's native side panel.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-v0.2.0-blue?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/chat-branch-visualizer/mahknjdihdpeceompocgcclnmjikmncb)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What it does

Every time you regenerate a response or edit a message in ChatGPT or Claude, the conversation splits into a new branch. These branches are invisible by default — Chat Branch Visualizer makes them a navigable tree.

- **Branch tree** — renders every user and assistant turn as a node graph
- **Build full tree** — auto-traverses all branches to build a complete map
- **Navigate** — click any node to jump to that point in the conversation
- **Fit / Zoom / Locate** — pan and zoom freely; jump to your current position
- **Snapshot** — restores your last tree when you reopen a tab
- **Standalone viewer** — pop the tree out into a full tab

Supports **ChatGPT** (chatgpt.com) and **Claude** (claude.ai).

---

## Install

**From the Chrome Web Store (recommended)**
→ [Add to Chrome](https://chromewebstore.google.com/detail/chat-branch-visualizer/mahknjdihdpeceompocgcclnmjikmncb)

**Load unpacked (development)**

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder
5. Open a ChatGPT or Claude conversation

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
├── viewer.html/js/css     Standalone tree viewer
├── api/                   Vercel serverless functions (reporting backend)
├── scripts/               Local automation scripts
└── .github/workflows/     Scheduled probe + report intake automation
```

---

## Diagnostics & reporting

When the parser can't read the page (e.g. after a platform update changes the DOM), the extension captures a diagnostic snapshot and — if the user has opted in — sends it automatically to help identify and fix the breakage.

**What's captured:** CSS selectors, `data-testid` attributes, short text signatures (≤120 chars), extension version, page URL.
**What's never captured:** full chat content, account information, or any data outside chatgpt.com / claude.ai.

Users control reporting via the **⋯ menu → Send diagnostics** toggle. It is **off by default**.

Privacy policy: https://chat-branch-visualizer.vercel.app/privacy

### Reporting pipeline

```
Extension (content.js)
  └─ PROBE_RESULT message
       └─ background.js  ──[POST]──▶  api/reports.js (Vercel)
                                           └─ GitHub repository_dispatch
                                                └─ report-intake.yml (creates/updates issue)
```

### Backend setup (Vercel)

Required environment variables:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | PAT with `repo` scope |
| `GITHUB_REPOSITORY` | e.g. `NogaUwU/chat-branch-visualizer` |
| `REPORT_PUBLIC_KEY` | Optional — low-trust key checked against extension requests |

### GitHub Actions workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `probe.yml` | Daily / manual | Runs Playwright against ChatGPT & Claude; opens issue on selector drift |
| `report-intake.yml` | `repository_dispatch` | Creates or updates an issue from incoming extension reports |
| `review.yml` | PR | Adds structural review comment on auto-fix PRs |

Secrets used by `probe.yml`: `TEST_CHATGPT_URL`, `TEST_CLAUDE_URL`, `CHATGPT_SESSION_COOKIE`, `CLAUDE_SESSION_COOKIE`

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
