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
    bot: null,
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
    minParentScore: config.minParentScore,
    locations: [],
    categories: config.categories.map((category) => category.key),
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
    existing.filters ||= defaultFilters(config);
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
  readState,
  upsertSubscriber,
  writeState,
};
