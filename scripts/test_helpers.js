const fs = require("fs");
const os = require("os");
const path = require("path");
const { CATEGORIES, DEFAULT_LOCATIONS, MINUTES_TO_CENTER } = require("../src/config");
const { TelegramApiError } = require("../src/telegram");

function tempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testConfig(overrides = {}) {
  return {
    dataDir: tempDataDir("listam-bot-test-"),
    dryRun: false,
    telegramToken: "test-token",
    telegramFallbackChatId: "",
    telegramWebhookSecret: "test-secret",
    publicUrl: "",
    adminChatIds: new Set(),
    pollTelegramWhenNoWebhook: false,
    openaiApiKey: "",
    openaiModel: "gpt-5-mini",
    aiFiltersEnabled: false,
    maxPriceUsd: 120000,
    minPriceUsd: 0,
    collectAllListings: false,
    minQualityScore: 0,
    minParentScore: 0,
    scanOnStart: false,
    scanIntervalMinutes: 5,
    blockedScanIntervalMinutes: 15,
    blockedScanMaxIntervalMinutes: 60,
    scanPagesPerCategory: 1,
    scanPageWaitSeconds: 1,
    challengeWaitSeconds: 1,
    listamQuickPageWaitSeconds: 1,
    listamQuickChallengeWaitSeconds: 1,
    listamFullProbeIntervalMinutes: 60,
    listamFeedUrls: [],
    gmailImapEnabled: false,
    gmailUser: "",
    gmailAppPassword: "",
    gmailSender: "post@list.am",
    gmailMailbox: "INBOX",
    gmailPollSeconds: 60,
    gmailLookbackDays: 14,
    gmailRetryMaxSeconds: 900,
    gmailSocketTimeoutMs: 180000,
    ingestToken: "",
    relayMaxAgeMinutes: 180,
    imageBackfillPerScan: 12,
    scanIssueAlerts: true,
    scanIssueAlertAfter: 3,
    scanIssueAlertCooldownMinutes: 360,
    myrealtyFallbackEnabled: true,
    myrealtyPagesPerCategory: 5,
    estateFallbackEnabled: true,
    estateFeedUrls: [],
    banaliFallbackEnabled: true,
    banaliPagesPerCategory: 5,
    banaliConcurrency: 4,
    amdPerUsd: 390,
    notifyPublishedWithinDays: 30,
    notifyUpdatedWithinDays: 14,
    userScanEnabled: true,
    userScanCooldownMinutes: 10,
    navigationTimeoutMs: 1000,
    delayBetweenPagesMs: 0,
    headless: true,
    sendInitial: false,
    requireKnownLocation: true,
    maxSeenIds: 30000,
    maxListingsCache: 1000,
    telegramBatchSize: 6,
    telegramSendDelayMs: 0,
    telegramRetryMaxSeconds: 0,
    categories: CATEGORIES,
    defaultLocations: DEFAULT_LOCATIONS,
    minutesToCenter: MINUTES_TO_CENTER,
    ...overrides,
  };
}

function telegramError(errorCode, description, status = errorCode === 429 ? 429 : 400, parameters = {}) {
  return new TelegramApiError("sendMessage", status, {
    ok: false,
    error_code: errorCode,
    description,
    parameters,
  });
}

function createFakeTelegram() {
  const fake = {
    calls: [],
    messages: [],
    actions: [],
    failSend: null,
    sendAttempts: 0,
    async api(method, body) {
      fake.calls.push({ method, body });
      if (method === "getMe") return { id: 10, username: "test_listam_bot", first_name: "Test List.am Bot" };
      if (method === "sendChatAction") {
        fake.actions.push(body);
        return true;
      }
      if (method === "sendMessage") {
        fake.sendAttempts += 1;
        if (typeof fake.failSend === "function") {
          const error = fake.failSend(body, fake.sendAttempts);
          if (error) throw error;
        }
        fake.messages.push(body);
        return { message_id: fake.sendAttempts };
      }
      if (method === "getUpdates") return [];
      return true;
    },
  };
  return fake;
}

function update(text, chatId = 1001, options = {}) {
  return {
    update_id: options.updateId || Date.now(),
    message: {
      message_id: options.messageId || 1,
      text,
      chat: {
        id: chatId,
        type: options.type || "private",
        title: options.title || "",
        username: options.username || "",
      },
      from: {
        id: options.fromId || chatId,
        is_bot: false,
        first_name: options.firstName || `User${chatId}`,
        username: options.fromUsername || `user${chatId}`,
      },
    },
  };
}

function callbackUpdate(data, chatId = 1001, options = {}) {
  return {
    update_id: options.updateId || Date.now(),
    callback_query: {
      id: options.callbackId || `cb-${Date.now()}`,
      from: {
        id: options.fromId || chatId,
        is_bot: false,
        first_name: options.firstName || `User${chatId}`,
        username: options.fromUsername || `user${chatId}`,
      },
      message: {
        message_id: options.messageId || 1,
        chat: {
          id: chatId,
          type: options.type || "private",
          title: options.title || "",
          username: options.username || "",
        },
      },
      data,
    },
  };
}

function listing(id, overrides = {}) {
  const kindKey = overrides.kindKey || "apartment";
  const location = overrides.location || "Avan";
  const priceUsd = overrides.priceUsd || 90000;
  const areaSqm = overrides.areaSqm || 70;
  return {
    id: String(id),
    kind: kindKey === "house" ? "Дом" : "Квартира",
    kindKey,
    title: overrides.title || `${kindKey === "house" ? "House" : "Apartment"} in ${location}`,
    url: overrides.url || `https://www.list.am/en/item/${id}`,
    priceLabel: overrides.priceLabel || `$${priceUsd.toLocaleString("en-US")}`,
    priceUsd,
    areaSqm,
    pricePerSqm: overrides.pricePerSqm || Math.round(priceUsd / areaSqm),
    rooms: overrides.rooms || 2,
    floor: overrides.floor === undefined ? { current: 2, total: 9, label: "2/9" } : overrides.floor,
    landSqm: overrides.landSqm || null,
    location,
    minutesToCenter: MINUTES_TO_CENTER[location] ?? null,
    elevator: overrides.elevator ?? true,
    condition: overrides.condition || "ready",
    publishedAt: overrides.publishedAt || null,
    publishedAtPrecision: overrides.publishedAtPrecision || null,
    updatedAt: overrides.updatedAt || null,
    updatedAtPrecision: overrides.updatedAtPrecision || null,
    rawText: overrides.rawText || `${location} renovated individual heating balcony`,
    qualityScore: overrides.qualityScore ?? 7,
    discoveredAt: overrides.discoveredAt || new Date(Date.now() - Number(id) * 1000).toISOString(),
    scannedAt: overrides.scannedAt || new Date().toISOString(),
  };
}

module.exports = {
  callbackUpdate,
  createFakeTelegram,
  listing,
  telegramError,
  tempDataDir,
  testConfig,
  update,
};
