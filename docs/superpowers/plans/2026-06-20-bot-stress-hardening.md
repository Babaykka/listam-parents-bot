# Bot Stress Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add safe full and stress testing for the Telegram List.am bot, harden Telegram delivery, and make user-facing update/status messages clearer.

**Architecture:** Keep production behavior unchanged for normal users, but add an injectable Telegram API transport for tests. Use local Node scripts to simulate Telegram updates, fake users, fake listings, and delivery failures without sending real Telegram messages. Harden runtime delivery with small retry/delay settings and permanent-failure subscriber deactivation.

**Tech Stack:** Node.js CommonJS, built-in `assert`, existing Telegram bot modules, Render blueprint env vars.

---

### Task 1: Testable Telegram Transport

**Files:**
- Modify: `src/telegram.js`
- Modify: `src/config.js`
- Modify: `.env.example`
- Modify: `render.yaml`

- [x] Add an optional `config.telegramApi` function in `telegramApi`.
- [x] Add `TelegramApiError` metadata for Telegram status, error code, and retry-after seconds.
- [x] Retry short Telegram 429 responses once when `retry_after` is below `TELEGRAM_RETRY_MAX_SECONDS`.
- [x] Add `TELEGRAM_SEND_DELAY_MS` to slow production sends slightly.

### Task 2: Delivery Hardening

**Files:**
- Modify: `src/telegram.js`
- Modify: `src/app.js`

- [x] Add `isPermanentTelegramDeliveryError`.
- [x] Deactivate subscribers when Telegram returns permanent delivery errors such as 403 blocked bot or 400 chat not found.
- [x] Keep notification loops running when one recipient fails.

### Task 3: Clear Customer Language

**Files:**
- Modify: `src/app.js`
- Modify: `src/telegram.js`

- [x] Replace technical update notice text with plain customer language.
- [x] Replace `/status` blocked/backoff wording with plain language about List.am temporarily asking for a browser check.
- [x] Add a new release notice id so active users receive one final update after deployment.

### Task 4: Full Bot Test

**Files:**
- Create: `scripts/full_bot_test.js`
- Modify: `package.json`

- [x] Build a fake Telegram API transport that records messages/actions and never calls Telegram.
- [x] Simulate core commands: `/start`, `/tour`, `/filters`, `/budget`, `/rooms`, `/areas`, `/types`, `/latest`, `/status`, `/scan`, `/stop`.
- [x] Simulate natural-language help when AI is disabled.
- [x] Verify saved listings, filters, manual scan cooldown, and notification matching.
- [x] Add `npm run test:full`.

### Task 5: Stress Test

**Files:**
- Create: `scripts/stress_bot_test.js`
- Modify: `package.json`

- [x] Generate hundreds of fake subscribers and listings.
- [x] Run `notifySubscribers` against the generated data.
- [x] Simulate Telegram delivery failures and confirm the loop continues.
- [x] Assert runtime, message counts, and permanent-failure deactivation.
- [x] Add `npm run test:stress` and aggregate `npm test`.

### Task 6: Verification And Deployment

**Files:**
- Modify: `TELEGRAM_MONITOR.md`

- [x] Document test commands.
- [x] Run `npm test`, `node --check`, and `render blueprints validate`.
- [x] Commit, push, wait for Render live deploy.
- [x] Check production `/health`, webhook info, and Render logs for the release notice.
