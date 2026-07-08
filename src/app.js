const fs = require("fs");
const http = require("http");
const path = require("path");
const { listingsApiPayload } = require("./api");
const { loadConfig } = require("./config");
const { compareListingActivity, isSeenListing, nextSeenIds } = require("./listingFreshness");
const { mergeListings } = require("./listingStore");
const { scanBanali } = require("./banali");
const { scanEstate } = require("./estate");
const { scanListAm } = require("./listam");
const { scanListAmFeed } = require("./listamFeed");
const { scanMyRealty } = require("./myrealty");
const crypto = require("crypto");
const { relayFallbackResult, sanitizeIngestPayload, storeRelayListings } = require("./ingest");
const { coreSourcesDown, updateSourceHealth } = require("./sourceHealth");
const { activeSubscribers, deactivateSubscriber, readState, writeState } = require("./state");
const {
  configureTelegram,
  handleTelegramUpdate,
  isPermanentTelegramDeliveryError,
  notifySubscribers,
  pollTelegramOnce,
  sendMessage,
} = require("./telegram");

const config = loadConfig();
let state = readState(config);
let scanRunning = false;
let server = null;
let nextScanTimer = null;
let telegramPollTimer = null;

const RELEASE_NOTICE_ID = "2026-07-08-mini-app-catalog";
const RELEASE_NOTICE_TEXT = [
  "<b>Обновление бота</b>",
  "",
  "Появился Каталог: все подходящие квартиры и дома с фильтрами в один тап.",
  "Открыть можно кнопкой «Каталог» возле поля ввода или командой /app.",
  "",
  "Меню стало короче: /app, /latest, /filters, /status. Остальные команды продолжают работать, если набрать их вручную.",
  "",
  "Нажми /start, чтобы обновить кнопки под полем ввода.",
].join("\n");

function releaseNoticeKeyboard() {
  return {
    keyboard: [[{ text: "/start" }], [{ text: "/app" }, { text: "/latest" }]],
    resize_keyboard: true,
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function healthPayload() {
  return {
    ok: true,
    service: "listam-estate-bot",
    bot: state.bot?.username || null,
    uptimeSeconds: Math.round(process.uptime()),
    subscribers: activeSubscribers(state, config).length,
    listings: state.listings?.length || 0,
    visibleListings: (state.listings || []).filter((item) => !item.duplicateOf).length,
    seenIds: state.seenIds?.length || 0,
    scanRunning,
    lastScan: state.lastScan,
    scanHealth: state.scanHealth || null,
    sources: state.scanHealth?.sources || {},
    relay: Object.fromEntries(
      Object.entries(state.relay || {}).map(([source, entry]) => [
        source,
        { receivedAt: entry.receivedAt, listings: entry.listings?.length || 0 },
      ])
    ),
    coreSourcesDown: coreSourcesDown(state),
    scanSchedule: scanSchedulePayload(),
    nextScanAt: state.nextScanAt,
    publicUrl: config.publicUrl || null,
  };
}

function currentScanDelayMinutes() {
  const blockedStreak = Number(state.scanHealth?.blockedStreak || 0);
  if (blockedStreak <= 0) return config.scanIntervalMinutes;
  const backoffMinutes = config.blockedScanIntervalMinutes * blockedStreak;
  return Math.min(config.blockedScanMaxIntervalMinutes, Math.max(config.blockedScanIntervalMinutes, backoffMinutes));
}

function scanSchedulePayload() {
  const blockedStreak = Number(state.scanHealth?.blockedStreak || 0);
  return {
    mode: blockedStreak > 0 ? "backoff" : "normal",
    currentDelayMinutes: currentScanDelayMinutes(),
    normalIntervalMinutes: config.scanIntervalMinutes,
    blockedIntervalMinutes: config.blockedScanIntervalMinutes,
    blockedMaxIntervalMinutes: config.blockedScanMaxIntervalMinutes,
  };
}

function sourceMaxPriceUsd(config, state) {
  const subscriberMaxPrices = activeSubscribers(state, config)
    .map((subscriber) => Number(subscriber.filters?.maxPriceUsd || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(config.maxPriceUsd, ...subscriberMaxPrices);
}

function listamBlocked(result, config) {
  const expectedPages = config.categories.length * config.scanPagesPerCategory;
  return (
    result.listings.length === 0 &&
    result.skipped.length >= expectedPages &&
    result.skipped.some((item) => /Just a moment/i.test(item.title || item.error || ""))
  );
}

function scanResultSummary(source, result) {
  return {
    source,
    listings: result.listings.length,
    skipped: result.skipped.length,
    blocked: Boolean(result.blocked),
    error: result.error || null,
    durationMs: result.durationMs || null,
    probeMode: result.probeMode || null,
  };
}

function emptyScanResult(source, error) {
  return {
    listings: [],
    skipped: [{ source, error: error.message }],
    scannedAt: new Date().toISOString(),
    locations: [],
    blocked: false,
    error: error.message,
  };
}

async function safeScanSource(source, scanner, scanConfig) {
  const startedAt = Date.now();
  try {
    const result = await scanner(scanConfig);
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    console.error(`[scan] ${source} failed: ${error.stack || error.message}`);
    return { ...emptyScanResult(source, error), durationMs: Date.now() - startedAt };
  }
}

function combineScanResults(primary, fallbacks = []) {
  const sources = [primary, ...fallbacks].filter(Boolean);
  const byId = new Map();
  for (const result of sources) {
    for (const item of result.listings) {
      const existing = byId.get(item.id);
      // A relayed copy may be hours old; keep whichever snapshot is newer.
      if (existing && String(existing.scannedAt || "") >= String(item.scannedAt || "")) continue;
      byId.set(item.id, item);
    }
  }
  const listings = Array.from(byId.values()).sort(compareListingActivity);

  return {
    listings,
    skipped: sources.flatMap((result) => result.skipped),
    scannedAt: new Date().toISOString(),
    locations: uniqueLocations(sources.flatMap((result) => result.locations)),
    blocked: primary.blocked && fallbacks.every((result) => result.listings.length === 0),
    sourceResults: [
      scanResultSummary("listam", primary),
      ...fallbacks.map((result) => scanResultSummary(result.sourceName || "source", result)),
    ],
  };
}

function uniqueLocations(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function lastListamSource(state) {
  return state.lastScan?.sources?.find((source) => source.source === "listam") || null;
}

function listamProbeMode(config, state) {
  const listamSource = lastListamSource(state);
  if (!listamSource?.blocked) return "full";

  const lastFullAt = Date.parse(state.scanHealth?.lastListamFullProbeAt || "");
  if (!Number.isFinite(lastFullAt)) return "full";

  const elapsedMinutes = (Date.now() - lastFullAt) / 60000;
  return elapsedMinutes >= config.listamFullProbeIntervalMinutes ? "full" : "quick";
}

function listamConfigForProbe(config, probeMode) {
  if (probeMode !== "quick") return config;
  return {
    ...config,
    scanPageWaitSeconds: Math.min(config.scanPageWaitSeconds, config.listamQuickPageWaitSeconds),
    challengeWaitSeconds: Math.min(config.challengeWaitSeconds, config.listamQuickChallengeWaitSeconds),
  };
}

async function scanSources(config, state) {
  const scanConfig = { ...config, maxPriceUsd: sourceMaxPriceUsd(config, state) };
  const probeMode = listamProbeMode(config, state);
  const listamJob = safeScanSource("listam", scanListAm, listamConfigForProbe(scanConfig, probeMode)).then((result) => {
    result.blocked = listamBlocked(result, scanConfig);
    return {
      ...result,
      sourceName: "listam",
      probeMode,
    };
  });

  const fallbackJobs = [];
  if (config.listamFeedUrls.length > 0) {
    fallbackJobs.push(
      safeScanSource("listam_feed", scanListAmFeed, scanConfig).then((result) => ({
        ...result,
        sourceName: "listam_feed",
      }))
    );
  }
  if (config.myrealtyFallbackEnabled) {
    fallbackJobs.push(
      safeScanSource("myrealty", scanMyRealty, scanConfig).then((result) => ({
        ...result,
        sourceName: "myrealty",
      }))
    );
  }
  if (config.estateFallbackEnabled) {
    fallbackJobs.push(
      safeScanSource("estate", scanEstate, scanConfig).then((result) => ({
        ...result,
        sourceName: "estate",
      }))
    );
  }
  if (config.banaliFallbackEnabled) {
    fallbackJobs.push(
      safeScanSource("banali", scanBanali, scanConfig).then((result) => ({
        ...result,
        sourceName: "banali",
      }))
    );
  }

  const [listam, ...fallbacks] = await Promise.all([listamJob, ...fallbackJobs]);

  const relayResult = relayFallbackResult(state, config);
  if (relayResult) fallbacks.push(relayResult);

  return combineScanResults(listam, fallbacks);
}

async function runScanCycle(reason = "schedule") {
  if (scanRunning) {
    console.log(`[scan] already running, skip ${reason}`);
    return;
  }

  scanRunning = true;
  console.log(`[scan] start: ${reason}`);

  try {
    const now = new Date();
    const oldSeen = new Set(state.seenIds || []);
    const previousBlockedStreak = Number(state.scanHealth?.blockedStreak || 0);
    const result = await scanSources(config, state);
    const newListings = result.listings.filter((item) => !isSeenListing(config, oldSeen, item, now));
    const challengeBlocked = Boolean(result.blocked);
    const listamSource = result.sourceResults?.find((source) => source.source === "listam");

    state.seenIds = nextSeenIds(state.seenIds || [], result.listings, config.maxSeenIds);
    state.listings = mergeListings(state.listings, result.listings, config);

    const mergedById = new Map(state.listings.map((item) => [item.id, item]));
    // Keep duplicates in the batch: notifySubscribers suppresses them per
    // subscriber (a duplicate is still sent when its canonical is filtered
    // out for that subscriber, e.g. by a hidden source).
    const notifiableListings = newListings.map((item) => mergedById.get(item.id) || item);
    const duplicatesInBatch = notifiableListings.filter((item) => item.duplicateOf).length;

    state.lastScan = {
      at: result.scannedAt,
      reason,
      scanned: result.listings.length,
      new: newListings.length,
      duplicatesSuppressed: duplicatesInBatch,
      skipped: result.skipped.length,
      blocked: challengeBlocked,
      skippedDetails: result.skipped.slice(0, 5),
      sources: result.sourceResults || [],
      locations: result.locations,
    };
    updateScanHealth(state, config, challengeBlocked);
    updateSourceHealth(state, result.sourceResults || []);
    if (listamSource?.probeMode === "full") state.scanHealth.lastListamFullProbeAt = result.scannedAt;
    if (listamSource?.blocked) state.scanHealth.lastListamBlockedAt = result.scannedAt;

    writeState(config, state);
    console.log(
      `[scan] done: matched ${result.listings.length}, new ${newListings.length}, skipped ${result.skipped.length}, blocked ${challengeBlocked}`
    );

    if (notifiableListings.length > 0) {
      if (!config.sendInitial && oldSeen.size === 0 && previousBlockedStreak === 0) {
        console.log(`[scan] first successful run initialized ${newListings.length} seen ids without sending old listings`);
      } else {
        await notifySubscribers(config, state, notifiableListings);
      }
    }

    await maybeNotifyScanHealth(config, state, challengeBlocked, result, previousBlockedStreak);
    await maybeNotifyCoreSourceIssue(config, state);
  } catch (error) {
    console.error(`[scan] failed: ${error.stack || error.message}`);
    state.lastScan = {
      at: new Date().toISOString(),
      reason,
      error: error.message,
      scanned: 0,
      new: 0,
    };
    writeState(config, state);

    for (const subscriber of activeSubscribers(state, config)) {
      if (!config.adminChatIds.has(String(subscriber.id))) continue;
      await sendMessage(config, subscriber.id, `Ошибка скана объявлений:\n${error.message}`).catch((sendError) =>
        console.error(`[telegram] failed to send scan error: ${sendError.message}`)
      );
    }
  } finally {
    scanRunning = false;
    if (reason !== "schedule") scheduleNextScan();
  }
}

function updateScanHealth(state, config, blocked) {
  state.scanHealth ||= {};
  if (blocked) {
    if (!state.scanHealth.blockedSince) state.scanHealth.blockedSince = new Date().toISOString();
    state.scanHealth.blockedStreak = Number(state.scanHealth.blockedStreak || 0) + 1;
  } else {
    state.scanHealth.blockedStreak = 0;
    state.scanHealth.blockedSince = null;
    state.scanHealth.lastIssueAlertBlockedSince = null;
  }
  state.scanHealth.updatedAt = new Date().toISOString();
}

function canSendScanIssueAlert(config, state) {
  if (!config.scanIssueAlerts) return false;
  const health = state.scanHealth || {};
  if (Number(health.blockedStreak || 0) < config.scanIssueAlertAfter) return false;
  if (health.lastIssueAlertBlockedSince && health.lastIssueAlertBlockedSince === health.blockedSince) return false;
  if (!health.lastIssueAlertAt) return true;
  const elapsedMinutes = (Date.now() - Date.parse(health.lastIssueAlertAt)) / 60000;
  return elapsedMinutes >= config.scanIssueAlertCooldownMinutes;
}

async function sendToActiveSubscribers(config, state, text, options = {}) {
  const recipients = activeSubscribers(state, config);
  let changed = false;
  for (const subscriber of recipients) {
    await sendMessage(config, subscriber.id, text, options).catch((error) => {
      console.error(`[telegram] scan health alert failed: ${error.message}`);
      if (isPermanentTelegramDeliveryError(error)) {
        deactivateSubscriber(state, subscriber.id);
        changed = true;
      }
    });
  }
  if (changed) writeState(config, state);
}

async function maybeNotifyScanHealth(config, state, blocked, result, previousBlockedStreak = 0) {
  if (blocked && canSendScanIssueAlert(config, state)) {
    state.scanHealth.lastIssueAlertAt = new Date().toISOString();
    state.scanHealth.lastIssueAlertBlockedSince = state.scanHealth.blockedSince || state.scanHealth.lastIssueAlertAt;
    writeState(config, state);
    await sendToActiveSubscribers(
      config,
      state,
      [
        "<b>List.am временно не отдаёт объявления</b>",
        "Сайт показывает проверку браузера, поэтому новые варианты могут задержаться.",
        "Бот работает и попробует снова автоматически. Ничего нажимать не нужно.",
        "",
        "Состояние: /status",
      ].join("\n")
    );
    return;
  }

  const listamSource = result.sourceResults?.find((source) => source.source === "listam");
  if (!blocked && previousBlockedStreak > 0 && result.listings.length > 0 && !listamSource?.blocked) {
    state.scanHealth.lastRecoveryAlertAt = new Date().toISOString();
    writeState(config, state);
    await sendToActiveSubscribers(config, state, "List.am снова отдаёт объявления. Я продолжил обычную проверку и пришлю новые подходящие варианты автоматически.");
  }
}

async function maybeNotifyCoreSourceIssue(config, state) {
  if (!config.scanIssueAlerts || config.adminChatIds.size === 0) return;
  if (!coreSourcesDown(state)) {
    state.scanHealth.coreSourceAlertActive = false;
    return;
  }
  if (state.scanHealth.coreSourceAlertActive) {
    const elapsedMinutes = (Date.now() - Date.parse(state.scanHealth.lastCoreSourceAlertAt || "")) / 60000;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < config.scanIssueAlertCooldownMinutes) return;
  }

  state.scanHealth.coreSourceAlertActive = true;
  state.scanHealth.lastCoreSourceAlertAt = new Date().toISOString();
  writeState(config, state);

  const text = [
    "<b>Основные источники не отвечают</b>",
    "Banali.am и MyRealty несколько проверок подряд не возвращают объявления.",
    "Бот продолжает попытки автоматически. Подробности: /admin_sources",
  ].join("\n");
  for (const chatId of config.adminChatIds) {
    await sendMessage(config, chatId, text).catch((error) => console.error(`[telegram] core source alert failed: ${error.message}`));
  }
}

function scheduleNextScan(delayMs = currentScanDelayMinutes() * 60 * 1000) {
  if (nextScanTimer) clearTimeout(nextScanTimer);
  state.nextScanAt = new Date(Date.now() + delayMs).toISOString();
  writeState(config, state);
  nextScanTimer = setTimeout(async () => {
    await runScanCycle("schedule");
    scheduleNextScan();
  }, delayMs);
}

async function maybeSendReleaseNotice() {
  state.sentReleaseNotices ||= {};
  if (state.sentReleaseNotices[RELEASE_NOTICE_ID]) return;

  const recipients = activeSubscribers(state, config);
  if (recipients.length === 0) {
    console.log("[notice] no subscribers for release notice");
    return;
  }

  await sendToActiveSubscribers(config, state, RELEASE_NOTICE_TEXT, { replyMarkup: releaseNoticeKeyboard() });
  state.sentReleaseNotices[RELEASE_NOTICE_ID] = {
    at: new Date().toISOString(),
    recipients: recipients.length,
  };
  writeState(config, state);
  console.log(`[notice] sent release notice ${RELEASE_NOTICE_ID} to ${recipients.length} subscribers`);
}

function ingestTokenValid(req) {
  if (!config.ingestToken) return false;
  const provided = String(req.headers["x-ingest-token"] || "");
  const expected = Buffer.from(config.ingestToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function handleIngest(req, res) {
  if (!config.ingestToken) {
    json(res, 403, { ok: false, error: "ingest is disabled: INGEST_TOKEN is not set" });
    return;
  }
  if (!ingestTokenValid(req)) {
    json(res, 401, { ok: false, error: "bad ingest token" });
    return;
  }

  const body = await readRequestBody(req);
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    json(res, 400, { ok: false, error: "invalid JSON" });
    return;
  }

  const result = sanitizeIngestPayload(payload, { ...config, maxPriceUsd: sourceMaxPriceUsd(config, state) });
  if (result.error) {
    json(res, 400, { ok: false, error: result.error });
    return;
  }

  storeRelayListings(state, result.source, result.listings);
  writeState(config, state);
  console.log(`[ingest] ${result.source}: accepted ${result.listings.length}, dropped ${result.dropped}`);

  setTimeout(() => runScanCycle("relay-ingest").catch((error) => console.error(`[ingest] scan failed: ${error.message}`)), 100);
  json(res, 200, { ok: true, source: result.source, accepted: result.listings.length, dropped: result.dropped });
}

async function handleWebhook(req, res) {
  if (config.telegramWebhookSecret && req.headers["x-telegram-bot-api-secret-token"] !== config.telegramWebhookSecret) {
    json(res, 401, { ok: false, error: "bad webhook secret" });
    return;
  }

  const body = await readRequestBody(req);
  const update = JSON.parse(body || "{}");
  await handleTelegramUpdate(config, state, update, { scanNow: () => runScanCycle("telegram-command") });
  writeState(config, state);
  json(res, 200, { ok: true });
}

const WEBAPP_HTML = fs.readFileSync(path.join(__dirname, "webapp.html"), "utf8");

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        json(res, 200, healthPayload());
        return;
      }

      if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        res.end(WEBAPP_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/listings") {
        json(res, 200, listingsApiPayload(state, config, Object.fromEntries(url.searchParams)));
        return;
      }

      if (req.method === "POST" && url.pathname === "/telegram/webhook") {
        await handleWebhook(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/ingest/listings") {
        await handleIngest(req, res);
        return;
      }

      text(res, 404, "Not found");
    } catch (error) {
      console.error(`[http] ${error.stack || error.message}`);
      json(res, 500, { ok: false, error: error.message });
    }
  });
}

async function pollTelegramLoop() {
  if (config.publicUrl || !config.pollTelegramWhenNoWebhook || (!config.telegramToken && !config.dryRun)) return;
  try {
    const count = await pollTelegramOnce(config, state, { scanNow: () => runScanCycle("telegram-command") });
    if (count > 0) writeState(config, state);
  } catch (error) {
    console.error(`[telegram-poll] ${error.message}`);
  } finally {
    telegramPollTimer = setTimeout(pollTelegramLoop, 3000);
  }
}

async function start() {
  if (!config.telegramToken && !config.dryRun) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (config.categories.length === 0) {
    throw new Error("No List.am categories selected");
  }

  state = await configureTelegram(config, state);
  writeState(config, state);

  server = createServer();
  await new Promise((resolve) => server.listen(config.port, "0.0.0.0", resolve));
  console.log(`[http] listening on 0.0.0.0:${config.port}`);
  setTimeout(() => maybeSendReleaseNotice().catch((error) => console.error(`[notice] release notice failed: ${error.message}`)), 1000);

  if (config.scanOnStart || Number(state.scanHealth?.blockedStreak || 0) > 0) {
    setTimeout(() => runScanCycle("startup").catch((error) => console.error(error)), 1500);
  }
  scheduleNextScan();
  pollTelegramLoop();
}

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  if (nextScanTimer) clearTimeout(nextScanTimer);
  if (telegramPollTimer) clearTimeout(telegramPollTimer);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  writeState(config, state);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
