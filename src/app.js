const http = require("http");
const { loadConfig } = require("./config");
const { scanListAm } = require("./listam");
const { activeSubscribers, readState, writeState } = require("./state");
const { configureTelegram, handleTelegramUpdate, notifySubscribers, pollTelegramOnce, sendMessage } = require("./telegram");

const config = loadConfig();
let state = readState(config);
let scanRunning = false;
let server = null;
let nextScanTimer = null;
let telegramPollTimer = null;

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
    scanRunning,
    lastScan: state.lastScan,
    nextScanAt: state.nextScanAt,
    publicUrl: config.publicUrl || null,
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

async function runScanCycle(reason = "schedule") {
  if (scanRunning) {
    console.log(`[scan] already running, skip ${reason}`);
    return;
  }

  scanRunning = true;
  console.log(`[scan] start: ${reason}`);

  try {
    const oldSeen = new Set(state.seenIds || []);
    const result = await scanListAm(config);
    const allSeen = new Set([...(state.seenIds || []), ...result.listings.map((item) => item.id)]);
    const newListings = result.listings.filter((item) => !oldSeen.has(item.id));

    state.seenIds = Array.from(allSeen).slice(-config.maxSeenIds);
    state.listings = mergeListings(state.listings, result.listings, config);
    state.lastScan = {
      at: result.scannedAt,
      reason,
      scanned: result.listings.length,
      new: newListings.length,
      skipped: result.skipped.length,
      locations: result.locations,
    };

    writeState(config, state);
    console.log(`[scan] done: matched ${result.listings.length}, new ${newListings.length}, skipped ${result.skipped.length}`);

    if (newListings.length > 0) {
      if (!config.sendInitial && oldSeen.size === 0) {
        console.log("[scan] first run initialized seen ids without sending old listings");
      } else {
        await notifySubscribers(config, state, newListings);
      }
    }
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
  }
}

function scheduleNextScan(delayMs = config.scanIntervalMinutes * 60 * 1000) {
  if (nextScanTimer) clearTimeout(nextScanTimer);
  state.nextScanAt = new Date(Date.now() + delayMs).toISOString();
  writeState(config, state);
  nextScanTimer = setTimeout(async () => {
    await runScanCycle("schedule");
    scheduleNextScan();
  }, delayMs);
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

  if (config.scanOnStart) {
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
