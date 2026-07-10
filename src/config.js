const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");

const DEFAULT_LOCATIONS = [
  "Ajapnyak",
  "Arabkir",
  "Avan",
  "Davtashen",
  "Erebuni",
  "Kanaker-Zeytun",
  "Kentron",
  "Malatia-Sebastia",
  "Nor Nork",
  "Nork-Marash",
  "Nubarashen",
  "Shengavit",
  "Abovyan",
  "Arinj",
  "Balahovit",
  "Dzoraghbyur",
  "Jrvezh",
  "Kasakh",
  "Masis",
  "Merdzavan",
  "Parakar",
  "Ptghni",
  "Proshyan",
  "Verin Ptghni",
  "Zovuni",
];

const MINUTES_TO_CENTER = {
  Kentron: 0,
  Arabkir: 10,
  "Kanaker-Zeytun": 15,
  "Nork-Marash": 15,
  Erebuni: 15,
  Shengavit: 15,
  Ajapnyak: 18,
  Davtashen: 18,
  "Nor Nork": 20,
  Avan: 20,
  "Malatia-Sebastia": 22,
  Nubarashen: 30,
  Arinj: 20,
  Jrvezh: 23,
  Zovuni: 24,
  Kasakh: 24,
  Proshyan: 25,
  Parakar: 25,
  Ptghni: 27,
  Merdzavan: 28,
  Balahovit: 28,
  "Verin Ptghni": 29,
  Dzoraghbyur: 30,
  Masis: 30,
  Abovyan: 30,
};

const CATEGORIES = [
  { id: 60, key: "apartment", label: "Квартира" },
  { id: 62, key: "house", label: "Дом" },
];

function loadEnvFile(filePath = ENV_FILE) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function envList(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function publicUrl() {
  const value = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "";
  return value.replace(/\/+$/, "");
}

function webhookSecret(value, fallbackSeed) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_-]{1,256}$/.test(raw)) return raw;
  return crypto.createHash("sha256").update(raw || fallbackSeed || "dev").digest("hex");
}

function loadConfig() {
  loadEnvFile();

  const categoryIds = envList("LISTAM_CATEGORY_IDS", ["60", "62"])
    .map((value) => Number(value))
    .filter(Boolean);

  const dataDir = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
  const minQualityScore = envNumber("MIN_QUALITY_SCORE", envNumber("MIN_PARENT_SCORE", 0));
  const scanIntervalMinutes = envNumber("POLL_INTERVAL_MINUTES", 5);
  const blockedScanIntervalMinutes = envNumber("BLOCKED_POLL_INTERVAL_MINUTES", Math.max(15, scanIntervalMinutes));
  const blockedScanMaxIntervalMinutes = envNumber("BLOCKED_POLL_MAX_INTERVAL_MINUTES", Math.max(60, blockedScanIntervalMinutes));

  return {
    rootDir: ROOT_DIR,
    dataDir,
    port: Number(process.env.PORT || 3000),
    dryRun: envBool("DRY_RUN", false),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramFallbackChatId: process.env.TELEGRAM_CHAT_ID || "",
    telegramWebhookSecret: webhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET, process.env.TELEGRAM_BOT_TOKEN),
    publicUrl: publicUrl(),
    adminChatIds: new Set(envList("ADMIN_CHAT_IDS", [])),
    pollTelegramWhenNoWebhook: envBool("TELEGRAM_LONG_POLL_FALLBACK", true),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-5-mini",
    aiFiltersEnabled: envBool("AI_FILTERS_ENABLED", true),

    maxPriceUsd: envNumber("MAX_PRICE_USD", 120000),
    minPriceUsd: envNumber("MIN_PRICE_USD", 0),
    minQualityScore,
    minParentScore: minQualityScore,
    scanOnStart: envBool("SCAN_ON_START", true),
    scanIntervalMinutes,
    blockedScanIntervalMinutes,
    blockedScanMaxIntervalMinutes,
    scanPagesPerCategory: envNumber("LISTAM_PAGES_PER_CATEGORY", 3),
    scanPageWaitSeconds: envNumber("LISTAM_PAGE_WAIT_SECONDS", 60),
    challengeWaitSeconds: envNumber("LISTAM_CHALLENGE_MAX_SECONDS", 45),
    listamQuickPageWaitSeconds: envNumber("LISTAM_QUICK_PAGE_WAIT_SECONDS", 12),
    listamQuickChallengeWaitSeconds: envNumber("LISTAM_QUICK_CHALLENGE_MAX_SECONDS", 8),
    listamFullProbeIntervalMinutes: envNumber("LISTAM_FULL_PROBE_INTERVAL_MINUTES", 60),
    listamFeedUrls: envList("LISTAM_FEED_URLS", []),
    ingestToken: process.env.INGEST_TOKEN || "",
    relayMaxAgeMinutes: envNumber("RELAY_MAX_AGE_MINUTES", 180),
    imageBackfillPerScan: envNumber("IMAGE_BACKFILL_PER_SCAN", 12),
    listamChromePath: process.env.LISTAM_CHROME_PATH || "",
    scanIssueAlerts: envBool("SCAN_ISSUE_ALERTS", true),
    scanIssueAlertAfter: envNumber("SCAN_ISSUE_ALERT_AFTER", 3),
    scanIssueAlertCooldownMinutes: envNumber("SCAN_ISSUE_ALERT_COOLDOWN_MINUTES", 360),
    myrealtyFallbackEnabled: envBool("MYREALTY_FALLBACK_ENABLED", true),
    myrealtyPagesPerCategory: envNumber("MYREALTY_PAGES_PER_CATEGORY", 5),
    estateFallbackEnabled: envBool("ESTATE_FALLBACK_ENABLED", true),
    estateFeedUrls: envList("ESTATE_FEED_URLS", []),
    estateCollectAll: envBool("ESTATE_COLLECT_ALL", true),
    estateDelayMs: envNumber("ESTATE_DELAY_MS", 10000),
    banaliFallbackEnabled: envBool("BANALI_FALLBACK_ENABLED", true),
    banaliPagesPerCategory: envNumber("BANALI_PAGES_PER_CATEGORY", 5),
    banaliConcurrency: envNumber("BANALI_CONCURRENCY", 4),
    amdPerUsd: envNumber("AMD_PER_USD", 390),
    notifyPublishedWithinDays: envNumber("NOTIFY_PUBLISHED_WITHIN_DAYS", 30),
    notifyUpdatedWithinDays: envNumber("NOTIFY_UPDATED_WITHIN_DAYS", 14),
    userScanEnabled: envBool("USER_SCAN_ENABLED", true),
    userScanCooldownMinutes: envNumber("USER_SCAN_COOLDOWN_MINUTES", 10),
    navigationTimeoutMs: envNumber("NAVIGATION_TIMEOUT_MS", 75000),
    delayBetweenPagesMs: envNumber("DELAY_BETWEEN_PAGES_MS", 2500),
    headless: !envBool("LISTAM_SHOW_BROWSER", false),
    sendInitial: envBool("SEND_INITIAL", false),
    requireKnownLocation: !envBool("ALLOW_UNKNOWN_LOCATION", false),
    maxSeenIds: envNumber("MAX_SEEN_IDS", 30000),
    maxListingsCache: envNumber("MAX_LISTINGS_CACHE", 1000),
    telegramBatchSize: envNumber("TELEGRAM_BATCH_SIZE", 6),
    telegramSendDelayMs: envNumber("TELEGRAM_SEND_DELAY_MS", 80),
    telegramRetryMaxSeconds: envNumber("TELEGRAM_RETRY_MAX_SECONDS", 3),

    categories: CATEGORIES.filter((category) => categoryIds.includes(category.id)),
    defaultLocations: DEFAULT_LOCATIONS,
    minutesToCenter: MINUTES_TO_CENTER,
  };
}

module.exports = {
  CATEGORIES,
  DEFAULT_LOCATIONS,
  MINUTES_TO_CENTER,
  loadConfig,
};
