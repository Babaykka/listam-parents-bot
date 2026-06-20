const fs = require("fs");
const path = require("path");

function defaultState() {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seenIds: [],
    listings: [],
    subscribers: [],
    telegramUpdateOffset: 0,
    lastScan: null,
    nextScanAt: null,
    lastUserScanAt: null,
    bot: null,
    scanHealth: {
      blockedStreak: 0,
      lastIssueAlertAt: null,
      lastRecoveryAlertAt: null,
    },
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function statePath(config) {
  return path.join(config.dataDir, "listam-bot-state.json");
}

function readState(config) {
  ensureDir(config.dataDir);
  const filePath = statePath(config);
  if (!fs.existsSync(filePath)) return defaultState();
  return { ...defaultState(), ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

function writeState(config, state) {
  ensureDir(config.dataDir);
  state.updatedAt = new Date().toISOString();
  const filePath = statePath(config);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function defaultFilters(config) {
  return {
    maxPriceUsd: config.maxPriceUsd,
    minPriceUsd: config.minPriceUsd,
    minQualityScore: config.minQualityScore,
    locations: [],
    categories: config.categories.map((category) => category.key),
    minRooms: null,
    maxRooms: null,
    minAreaSqm: null,
    maxAreaSqm: null,
    minLandSqm: null,
    maxLandSqm: null,
    maxPricePerSqm: null,
    minFloor: null,
    maxFloor: null,
    maxDistanceMinutes: null,
    elevator: "any",
    condition: "any",
    keywords: [],
    excludeKeywords: [],
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function listOrEmpty(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeFilters(config, filters = {}) {
  const defaults = defaultFilters(config);
  return {
    ...defaults,
    ...filters,
    maxPriceUsd: numberOrNull(filters.maxPriceUsd) || defaults.maxPriceUsd,
    minPriceUsd: numberOrNull(filters.minPriceUsd) || defaults.minPriceUsd,
    minQualityScore: Number(filters.minQualityScore ?? filters.minParentScore ?? defaults.minQualityScore) || 0,
    locations: listOrEmpty(filters.locations),
    categories: listOrEmpty(filters.categories).length ? listOrEmpty(filters.categories) : defaults.categories,
    minRooms: numberOrNull(filters.minRooms),
    maxRooms: numberOrNull(filters.maxRooms),
    minAreaSqm: numberOrNull(filters.minAreaSqm),
    maxAreaSqm: numberOrNull(filters.maxAreaSqm),
    minLandSqm: numberOrNull(filters.minLandSqm),
    maxLandSqm: numberOrNull(filters.maxLandSqm),
    maxPricePerSqm: numberOrNull(filters.maxPricePerSqm),
    minFloor: numberOrNull(filters.minFloor),
    maxFloor: numberOrNull(filters.maxFloor),
    maxDistanceMinutes: numberOrNull(filters.maxDistanceMinutes),
    elevator: ["yes", "no", "any"].includes(filters.elevator) ? filters.elevator : "any",
    condition: ["ready", "needs_work", "any"].includes(filters.condition) ? filters.condition : "any",
    keywords: listOrEmpty(filters.keywords),
    excludeKeywords: listOrEmpty(filters.excludeKeywords),
  };
}

function upsertSubscriber(config, state, chat, from) {
  const id = String(chat.id);
  state.subscribers ||= [];
  const existing = state.subscribers.find((subscriber) => String(subscriber.id) === id);
  const base = {
    id,
    type: chat.type,
    title: chat.title || "",
    username: chat.username || from?.username || "",
    firstName: from?.first_name || "",
    lastName: from?.last_name || "",
    active: true,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    existing.active = true;
    existing.type = base.type;
    existing.title = base.title;
    existing.username = base.username;
    existing.firstName = base.firstName;
    existing.lastName = base.lastName;
    existing.updatedAt = base.updatedAt;
    existing.filters = normalizeFilters(config, existing.filters);
    return existing;
  }

  const subscriber = {
    ...base,
    createdAt: new Date().toISOString(),
    filters: defaultFilters(config),
  };
  state.subscribers.push(subscriber);
  return subscriber;
}

function deactivateSubscriber(state, chatId) {
  const subscriber = (state.subscribers || []).find((item) => String(item.id) === String(chatId));
  if (!subscriber) return false;
  subscriber.active = false;
  subscriber.updatedAt = new Date().toISOString();
  return true;
}

function activeSubscribers(state, config) {
  const subscribers = (state.subscribers || []).filter((subscriber) => subscriber.active !== false);
  if (config.telegramFallbackChatId && !subscribers.some((subscriber) => String(subscriber.id) === String(config.telegramFallbackChatId))) {
    subscribers.push({
      id: String(config.telegramFallbackChatId),
      type: "manual",
      active: true,
      filters: defaultFilters(config),
    });
  }
  return subscribers;
}

module.exports = {
  activeSubscribers,
  deactivateSubscriber,
  defaultFilters,
  normalizeFilters,
  readState,
  upsertSubscriber,
  writeState,
};
