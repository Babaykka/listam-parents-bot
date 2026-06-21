const http = require("http");
const { loadConfig } = require("./config");
const { scanListAm } = require("./listam");
const { scanMyRealty } = require("./myrealty");
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

const RELEASE_NOTICE_ID = "2026-06-21-mandatory-fallback-source";
const RELEASE_NOTICE_TEXT = [
  "<b>Обновление бота</b>",
  "Исправил проблему, из-за которой объявления не приходили.",
  "",
  "Что изменилось:",
  "- List.am сейчас часто показывает проверку браузера и не отдает карточки;",
  "- бот теперь подключает резервный источник MyRealty, чтобы все равно присылать варианты;",
  "- повторные предупреждения про List.am больше не будут спамить чат;",
  "- кнопка /start ниже обновит меню и подсказки.",
  "",
  "Чтобы обновить меню, нажми /start.",
].join("\n");

function releaseNoticeKeyboard() {
  return {
    keyboard: [[{ text: "/start" }], [{ text: "/status" }, { text: "/latest" }]],
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
    subscribers: activeSubscribers(state, config).length,
    listings: state.listings?.length || 0,
    seenIds: state.seenIds?.length || 0,
    scanRunning,
    lastScan: state.lastScan,
    scanHealth: state.scanHealth || null,
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

function mergeListings(previous, scanned, config) {
  const now = new Date().toISOString();
  const byId = new Map();

  for (const item of previous || []) {
    byId.set(item.id, {
      ...item,
      qualityScore: item.qualityScore ?? item["parent" + "Score"] ?? 0,
    });
  }

  for (const item of scanned) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      ...existing,
      ...item,
      discoveredAt: existing?.discoveredAt || now,
      lastSeenAt: now,
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => String(b.discoveredAt || b.scannedAt).localeCompare(String(a.discoveredAt || a.scannedAt)))
    .slice(0, config.maxListingsCache);
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

function combineScanResults(primary, fallback) {
  if (!fallback) {
    return {
      ...primary,
      sourceResults: [{ source: "listam", listings: primary.listings.length, skipped: primary.skipped.length, blocked: primary.blocked }],
    };
  }

  const byId = new Map();
  for (const item of [...primary.listings, ...fallback.listings]) byId.set(item.id, item);
  const listings = Array.from(byId.values()).sort((a, b) => {
    const left = String(b.publishedAt || b.scannedAt);
    const right = String(a.publishedAt || a.scannedAt);
    return left.localeCompare(right) || Number(a.priceUsd || 0) - Number(b.priceUsd || 0);
  });

  return {
    listings,
    skipped: [...primary.skipped, ...fallback.skipped],
    scannedAt: new Date().toISOString(),
    locations: uniqueLocations([...primary.locations, ...fallback.locations]),
    blocked: primary.blocked && fallback.listings.length === 0,
    sourceResults: [
      { source: "listam", listings: primary.listings.length, skipped: primary.skipped.length, blocked: primary.blocked },
      { source: "myrealty", listings: fallback.listings.length, skipped: fallback.skipped.length, blocked: false },
    ],
  };
}

function uniqueLocations(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function scanSources(config, state) {
  const scanConfig = { ...config, maxPriceUsd: sourceMaxPriceUsd(config, state) };
  const listam = await scanListAm(scanConfig);
  listam.blocked = listamBlocked(listam, scanConfig);

  if (!config.myrealtyFallbackEnabled || (listam.listings.length > 0 && !listam.blocked)) {
    return combineScanResults(listam, null);
  }

  const fallback = await scanMyRealty(scanConfig);
  return combineScanResults(listam, fallback);
}

async function runScanCycle(reason = "schedule") {
  if (scanRunning) {
    console.log(`[scan] already running, skip ${reason}`);
    return;
  }

  scanRunning = true;
  console.log(`[scan] start: ${reason}`);

  try {
    const oldSeen = new Set(state.seenIds || []);
    const previousBlockedStreak = Number(state.scanHealth?.blockedStreak || 0);
    const result = await scanSources(config, state);
    const allSeen = new Set([...(state.seenIds || []), ...result.listings.map((item) => item.id)]);
    const newListings = result.listings.filter((item) => !oldSeen.has(item.id));
    const challengeBlocked = Boolean(result.blocked);

    state.seenIds = Array.from(allSeen).slice(-config.maxSeenIds);
    state.listings = mergeListings(state.listings, result.listings, config);
    state.lastScan = {
      at: result.scannedAt,
      reason,
      scanned: result.listings.length,
      new: newListings.length,
      skipped: result.skipped.length,
      blocked: challengeBlocked,
      skippedDetails: result.skipped.slice(0, 5),
      sources: result.sourceResults || [],
      locations: result.locations,
    };
    updateScanHealth(state, config, challengeBlocked);

    writeState(config, state);
    console.log(
      `[scan] done: matched ${result.listings.length}, new ${newListings.length}, skipped ${result.skipped.length}, blocked ${challengeBlocked}`
    );

    if (newListings.length > 0) {
      if (!config.sendInitial && oldSeen.size === 0 && previousBlockedStreak === 0) {
        console.log(`[scan] first successful run initialized ${newListings.length} seen ids without sending old listings`);
      } else {
        await notifySubscribers(config, state, newListings);
      }
    }

    await maybeNotifyScanHealth(config, state, challengeBlocked, result, previousBlockedStreak);
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
      await sendMessage(config, subscriber.id, `Ошибка скана List.am:\n${error.message}`).catch((sendError) =>
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

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        json(res, 200, healthPayload());
        return;
      }

      if (req.method === "POST" && url.pathname === "/telegram/webhook") {
        await handleWebhook(req, res);
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
