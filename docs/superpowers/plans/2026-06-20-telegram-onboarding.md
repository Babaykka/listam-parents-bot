# Telegram Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-time Telegram users understand what the bot does, how to configure it, and how to verify it works without outside explanation.

**Architecture:** Keep onboarding inside `src/telegram.js`, following the existing command-handler pattern. Add focused text helpers for the tour, setup, and concise filter summary, then wire them into `/start`, `/tour`, `/help`, and Telegram command registration.

**Tech Stack:** Node.js Telegram Bot API calls, existing reply keyboard, existing dry-run test path.

---

### Task 1: Beginner First Screen

**Files:**
- Modify: `src/telegram.js`

- [x] Add a `tourText(config)` helper that explains the bot in four short blocks: what it does, how to start, what it sends, and what to press.
- [x] Add a `shortFiltersText(config, filters)` helper for a one-line default filter summary.
- [x] Change `/start` so it sends the tour first and the current filter summary second, rather than a full filter dump.

### Task 2: Discoverable Commands

**Files:**
- Modify: `src/telegram.js`

- [x] Add `/tour` to the reply keyboard and Telegram command list.
- [x] Route `/tour` to the same beginner explanation as `/start`.
- [x] Rewrite `/help` so it starts with a plain-language explanation and shows advanced commands only after the main flow.
- [x] Rewrite `/setup` so it explains natural-language setup first, then presets.

### Task 3: Verify And Deploy

**Files:**
- Modify: `src/telegram.js`

- [x] Run `node --check` over `src/*.js` and `scripts/*.js`.
- [x] Run dry-run command simulations for `/start`, `/tour`, `/help`, `/setup`, and plain text.
- [ ] Commit, push to `main`, wait for Render deploy to become live, then verify `/health`, Telegram webhook, and registered commands.
