const { activeSubscribers, deactivateSubscriber, defaultFilters, normalizeFilters, upsertSubscriber, writeState } = require("./state");
const { parseFilterRequest } = require("./aiFilters");
const { listingSourceKey } = require("./dedupe");
const { compareListingActivity, daysSince, shouldNotifyListing } = require("./listingFreshness");
const { sourceStatusEntries } = require("./sourceHealth");
const { clamp, escapeHtml, normalizeText, sleep } = require("./utils");

const YEREVAN_DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Yerevan",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const YEREVAN_DATE_ONLY_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Yerevan",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

class TelegramApiError extends Error {
  constructor(method, status, data) {
    super(`Telegram ${method} failed: ${status} ${JSON.stringify(data)}`);
    this.name = "TelegramApiError";
    this.method = method;
    this.status = status;
    this.telegramCode = data?.error_code || null;
    this.description = data?.description || "";
    this.retryAfter = Number(data?.parameters?.retry_after || 0) || null;
    this.response = data;
  }
}

function apiUrl(config, method) {
  return `https://api.telegram.org/bot${config.telegramToken}/${method}`;
}

async function telegramApi(config, method, body = {}) {
  if (typeof config.telegramApi === "function") {
    return config.telegramApi(method, body, config);
  }

  if (config.dryRun) {
    console.log(`[dry-run telegram api] ${method} ${JSON.stringify(body)}`);
    if (method === "getUpdates") return [];
    return method === "getMe" ? { username: "dry_run_bot", first_name: "Dry Run Bot" } : true;
  }

  if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const maxRetrySeconds = Number(config.telegramRetryMaxSeconds ?? 3);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(apiUrl(config, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.ok) return data.result;

    const error = new TelegramApiError(method, response.status, data);
    if (attempt === 0 && error.status === 429 && error.retryAfter && error.retryAfter <= maxRetrySeconds) {
      await sleep(error.retryAfter * 1000 + 250);
      continue;
    }
    throw error;
  }

  return null;
}

async function sendMessage(config, chatId, text, options = {}) {
  if (config.dryRun) {
    console.log(`[dry-run telegram -> ${chatId}]\n${text}\n`);
    return true;
  }

  const result = await telegramApi(config, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: options.disablePreview ?? false,
    reply_markup: options.replyMarkup,
  });
  if (Number(config.telegramSendDelayMs || 0) > 0) await sleep(Number(config.telegramSendDelayMs));
  return result;
}

function isPermanentTelegramDeliveryError(error) {
  const description = String(error?.description || error?.message || "").toLowerCase();
  if (error?.telegramCode === 403) return true;
  return error?.telegramCode === 400 && /chat not found|bot was blocked|user is deactivated|have no rights/.test(description);
}

async function sendChatAction(config, chatId, action = "typing") {
  if (config.dryRun) {
    console.log(`[dry-run telegram action -> ${chatId}] ${action}`);
    return true;
  }

  return telegramApi(config, "sendChatAction", {
    chat_id: chatId,
    action,
  }).catch((error) => {
    console.warn(`[telegram] sendChatAction failed: ${error.message}`);
    return false;
  });
}

async function withTyping(config, chatId, task) {
  await sendChatAction(config, chatId);
  const timer = setInterval(() => {
    sendChatAction(config, chatId).catch(() => {});
  }, 4000);
  timer.unref?.();

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

async function setupTelegramApi(config, method, body) {
  try {
    return await telegramApi(config, method, body);
  } catch (error) {
    console.warn(`[telegram] setup ${method} skipped: ${error.message}`);
    return null;
  }
}

function money(value) {
  return `$${Number(value || 0).toLocaleString("en-US")}`;
}

function scoreOf(item) {
  return Number(item.qualityScore ?? item["parent" + "Score"] ?? 0);
}

function rankScoreOf(item) {
  return Number(item.valueScore ?? scoreOf(item));
}

function whyGoodLine(item) {
  if (!Array.isArray(item.whyGood) || item.whyGood.length < 2) return null;
  return escapeHtml(`Почему интересно: ${item.whyGood.join("; ")}`);
}

function conditionLabel(value) {
  return (
    {
      ready: "хорошее состояние",
      partial: "частичный ремонт",
      needs_work: "нужен ремонт",
      unknown: "",
      any: "любое",
    }[value] || ""
  );
}

function categoryLabel(value) {
  return (
    {
      apartment: "квартиры",
      house: "дома",
    }[value] || value
  );
}

const TOGGLE_SOURCES = [
  ["listam", "List.am"],
  ["banali", "Banali.am"],
  ["myrealty", "MyRealty"],
  ["estate", "Estate.am"],
];

function toggleSourceLabel(source) {
  return TOGGLE_SOURCES.find(([key]) => key === source)?.[1] || source;
}

function listingUrl(item) {
  const rawUrl = String(item.url || "");
  if (rawUrl && !/https?:\/\/(?:www\.)?list\.am\//i.test(rawUrl)) return rawUrl;
  const id = String(rawUrl.match(/\/(?:[a-z]{2}\/)*item\/(\d+)/i)?.[1] || (/^\d+$/.test(String(item.id || "")) ? item.id : "")).trim();
  if (id) return `https://www.list.am/item/${encodeURIComponent(id)}`;
  return item.url || "https://www.list.am/";
}

function formatYerevanDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return YEREVAN_DATE_FORMATTER.format(date);
}

function formatYerevanDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return YEREVAN_DATE_ONLY_FORMATTER.format(date);
}

function listingDateDetail(item) {
  if (item.updatedAt) {
    const updatedValue =
      item.updatedAtPrecision === "date" ? formatYerevanDate(item.updatedAt) : formatYerevanDateTime(item.updatedAt);
    const publishedValue = item.publishedAt
      ? item.publishedAtPrecision === "date"
        ? formatYerevanDate(item.publishedAt)
        : formatYerevanDateTime(item.publishedAt)
      : "";
    if (updatedValue && publishedValue && updatedValue !== publishedValue) {
      return `обновлено ${updatedValue}, опубликовано ${publishedValue}`;
    }
    if (updatedValue) return `обновлено ${updatedValue}`;
  }

  if (item.publishedAt) {
    const value =
      item.publishedAtPrecision === "date"
        ? formatYerevanDate(item.publishedAt)
        : formatYerevanDateTime(item.publishedAt);
    if (value) return `опубликовано ${value}`;
  }

  const fallback = item.discoveredAt || item.scannedAt;
  if (!fallback) return null;
  const value = formatYerevanDateTime(fallback);
  return value ? `найдено ботом ${value}` : null;
}

function joinLine(label, values) {
  const text = values.filter(Boolean).join(" · ");
  return text ? escapeHtml(`${label}: ${text}`) : null;
}

function sourceLabel(item) {
  if (item.sourceLabel) return item.sourceLabel;
  if (/list\.am/i.test(String(item.url || ""))) return "List.am";
  return "";
}

function listingLine(item) {
  const location = item.location || "локация не распознана";
  const parameters = [
    item.areaSqm ? `${item.areaSqm} м²` : null,
    item.rooms ? `${item.rooms} комн.` : null,
    item.floor?.label ? `${item.floor.label} эт.` : null,
    item.landSqm ? `участок ${item.landSqm} м²` : null,
  ];
  const priceDetails = [
    item.pricePerSqm ? `${money(item.pricePerSqm)}/м²` : null,
    item.minutesToCenter !== null && item.minutesToCenter !== undefined ? `${item.minutesToCenter} мин до центра` : null,
  ];
  const comfort = [
    item.elevator === true ? "лифт" : item.elevator === false && item.floor?.current >= 3 ? "без лифта" : null,
    conditionLabel(item.condition),
  ];

  return [
    `<b>${escapeHtml(item.kind)} · ${escapeHtml(item.priceLabel)}</b>`,
    escapeHtml(`Район: ${location}`),
    joinLine("Параметры", parameters),
    joinLine("Цена", priceDetails),
    joinLine("Дополнительно", comfort),
    whyGoodLine(item),
    listingDateDetail(item) ? escapeHtml(`Дата: ${listingDateDetail(item)}`) : null,
    sourceLabel(item) ? escapeHtml(`Источник: ${sourceLabel(item)}`) : null,
    item.alsoSources?.length ? escapeHtml(`Также на: ${item.alsoSources.map((entry) => entry.label).join(", ")}`) : null,
    `<a href="${escapeHtml(listingUrl(item))}">Открыть объявление</a>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function chunkListings(title, listings, config) {
  const chunks = [];
  for (let index = 0; index < listings.length; index += config.telegramBatchSize) {
    const batch = listings.slice(index, index + config.telegramBatchSize);
    const range =
      listings.length > batch.length
        ? `Показаны ${index + 1}-${index + batch.length} из ${listings.length}`
        : `Найдено: ${batch.length}`;
    chunks.push(`<b>${escapeHtml(title)}</b>\n${escapeHtml(range)}\n\n${batch.map(listingLine).join("\n\n")}`);
  }
  return chunks;
}

function pluralRu(count, forms) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

function listingsCountText(count) {
  return `${count} ${pluralRu(count, ["объявление", "объявления", "объявлений"])}`;
}

function relativeTimeText(value, now = Date.now()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const diffMinutes = Math.round((now - time) / 60000);
  if (Math.abs(diffMinutes) < 1) return "только что";
  if (diffMinutes > 0) {
    if (diffMinutes < 60) return `${diffMinutes} мин назад`;
    const hours = Math.round(diffMinutes / 60);
    if (hours < 48) return `${hours} ч назад`;
    return `${Math.round(hours / 24)} дн назад`;
  }
  const ahead = -diffMinutes;
  if (ahead < 60) return `через ~${ahead} мин`;
  return `через ~${Math.round(ahead / 60)} ч`;
}

function rangeText(min, max, unit = "", anyText = "любой") {
  if (min && max) return min === max ? `${min}${unit}` : `${min}-${max}${unit}`;
  if (min) return `от ${min}${unit}`;
  if (max) return `до ${max}${unit}`;
  return anyText;
}

function hasFilterRange(min, max) {
  return (min !== null && min !== undefined && min !== 0) || (max !== null && max !== undefined && max !== 0);
}

function filtersText(config, rawFilters) {
  const filters = normalizeFilters(config, rawFilters);
  const categories = filters.categories?.length ? filters.categories.map(categoryLabel).join(", ") : "квартиры, дома";
  const locations = filters.locations?.length ? filters.locations.join(", ") : "все разрешенные районы";
  const elevator = { yes: "только с лифтом", no: "только без лифта", any: "любой" }[filters.elevator] || "любой";
  const keywords = filters.keywords.length ? filters.keywords.join(", ") : "нет";
  const excludeKeywords = filters.excludeKeywords.length ? filters.excludeKeywords.join(", ") : "нет";
  const rows = [
    `<b>Фильтры</b>`,
    `Цена: ${filters.minPriceUsd ? `${money(filters.minPriceUsd)}-` : "до "}${money(filters.maxPriceUsd)}`,
    `Тип: ${escapeHtml(categories)}`,
    `Районы: ${escapeHtml(locations)}`,
  ];

  if (hasFilterRange(filters.minRooms, filters.maxRooms)) rows.push(`Комнаты: ${rangeText(filters.minRooms, filters.maxRooms)}`);
  if (hasFilterRange(filters.minAreaSqm, filters.maxAreaSqm)) rows.push(`Площадь: ${rangeText(filters.minAreaSqm, filters.maxAreaSqm, " м²")}`);
  if (hasFilterRange(filters.minLandSqm, filters.maxLandSqm)) rows.push(`Участок: ${rangeText(filters.minLandSqm, filters.maxLandSqm, " м²")}`);
  if (hasFilterRange(filters.minFloor, filters.maxFloor)) rows.push(`Этаж: ${rangeText(filters.minFloor, filters.maxFloor)}`);
  if (filters.maxDistanceMinutes) rows.push(`До центра: до ${filters.maxDistanceMinutes} мин`);
  if (filters.maxPricePerSqm) rows.push(`Цена за м²: до ${money(filters.maxPricePerSqm)}`);
  if (filters.elevator !== "any") rows.push(`Лифт: ${elevator}`);
  if (filters.condition !== "any") rows.push(`Состояние: ${conditionLabel(filters.condition)}`);
  if (filters.minQualityScore > config.minQualityScore) rows.push(`Мин. качество: ${filters.minQualityScore}/10`);
  if (filters.keywords.length) rows.push(`Ключевые слова: ${escapeHtml(keywords)}`);
  if (filters.excludeKeywords.length) rows.push(`Исключить слова: ${escapeHtml(excludeKeywords)}`);
  if (filters.excludeSources?.length) rows.push(`Скрытые источники: ${escapeHtml(filters.excludeSources.map(toggleSourceLabel).join(", "))}`);

  if (rows.length === 4) rows.push("Остальное: без ограничений");
  return rows.join("\n");
}

function haystack(item) {
  return normalizeText([item.title, item.location, item.rawText].filter(Boolean).join(" ")).toLowerCase();
}

function matchesSubscriber(config, subscriber, item) {
  const filters = normalizeFilters(config, subscriber.filters || defaultFilters(config));
  if (item.priceUsd > filters.maxPriceUsd) return false;
  if (item.priceUsd < (filters.minPriceUsd || 0)) return false;
  if (scoreOf(item) < filters.minQualityScore) return false;
  if (filters.categories?.length && !filters.categories.includes(item.kindKey)) return false;
  if (filters.locations?.length && !filters.locations.includes(item.location)) return false;
  if (filters.minRooms && (!item.rooms || item.rooms < filters.minRooms)) return false;
  if (filters.maxRooms && (!item.rooms || item.rooms > filters.maxRooms)) return false;
  if (filters.minAreaSqm && (!item.areaSqm || item.areaSqm < filters.minAreaSqm)) return false;
  if (filters.maxAreaSqm && (!item.areaSqm || item.areaSqm > filters.maxAreaSqm)) return false;
  if (filters.minLandSqm && (!item.landSqm || item.landSqm < filters.minLandSqm)) return false;
  if (filters.maxLandSqm && (!item.landSqm || item.landSqm > filters.maxLandSqm)) return false;
  if (filters.maxPricePerSqm && (!item.pricePerSqm || item.pricePerSqm > filters.maxPricePerSqm)) return false;
  if (filters.minFloor && (!item.floor?.current || item.floor.current < filters.minFloor)) return false;
  if (filters.maxFloor && (!item.floor?.current || item.floor.current > filters.maxFloor)) return false;
  if (filters.maxDistanceMinutes && (item.minutesToCenter === null || item.minutesToCenter === undefined || item.minutesToCenter > filters.maxDistanceMinutes)) return false;
  if (filters.elevator === "yes" && item.elevator !== true) return false;
  if (filters.elevator === "no" && item.elevator !== false) return false;
  if (filters.condition === "ready" && !["ready", "partial"].includes(item.condition)) return false;
  if (filters.condition === "needs_work" && item.condition !== "needs_work") return false;

  if (filters.excludeSources?.length && filters.excludeSources.includes(listingSourceKey(item))) return false;

  const text = haystack(item);
  if (filters.keywords.length && !filters.keywords.every((keyword) => text.includes(keyword.toLowerCase()))) return false;
  if (filters.excludeKeywords.length && filters.excludeKeywords.some((keyword) => text.includes(keyword.toLowerCase()))) return false;
  return true;
}

function filteredSortedListings(config, subscriber, listings, mode = "latest") {
  // One entry per dedupe group: the canonical copy when it matches the
  // subscriber's filters, otherwise a matching duplicate (e.g. when the
  // canonical comes from a source this subscriber has hidden).
  const groups = new Map();
  for (const item of listings || []) {
    if (!matchesSubscriber(config, subscriber, item)) continue;
    const groupKey = item.duplicateOf || item.id;
    const existing = groups.get(groupKey);
    if (!existing || (!item.duplicateOf && existing.duplicateOf)) groups.set(groupKey, item);
  }
  const filtered = Array.from(groups.values());
  if (mode === "top") {
    filtered.sort((a, b) => rankScoreOf(b) - rankScoreOf(a) || a.priceUsd - b.priceUsd);
  } else {
    filtered.sort(compareListingActivity);
  }
  return filtered;
}

function matchingListings(config, subscriber, listings, limit = 10, mode = "latest") {
  return filteredSortedListings(config, subscriber, listings, mode).slice(0, limit);
}

function groupLatestSections(config, listings, now = new Date()) {
  const fresh = [];
  const raised = [];
  const rest = [];
  for (const item of listings) {
    const publishedDays = daysSince(item.publishedAt, now);
    const updatedDays = daysSince(item.updatedAt, now);
    if (publishedDays !== null && publishedDays >= 0 && publishedDays <= 3) fresh.push(item);
    else if (updatedDays !== null && updatedDays >= 0 && updatedDays <= 3) raised.push(item);
    else rest.push(item);
  }
  const value = rest.slice().sort((a, b) => rankScoreOf(b) - rankScoreOf(a)).slice(0, 4);
  return [
    { key: "fresh", title: "Свежие объявления", items: fresh.slice(0, 8) },
    { key: "raised", title: "Недавно поднятые", items: raised.slice(0, 6) },
    { key: "value", title: "Выгодные по цене за м²", items: value },
  ].filter((section) => section.items.length > 0);
}

function naturalListingRequest(text) {
  const lower = normalizeText(text).toLowerCase();
  const wantsDelivery = /(покажи|показать|отправь|отправить|пришли|скинь|дай|выведи|хочу\s+посмотреть|что\s+есть|show|send|list)/i.test(lower);
  const hasHouse = /\b(дом|дома|house|houses|таун)/i.test(lower);
  const hasApartment = /(квартир|apartment|apartments|flat|flats)/i.test(lower);
  const asksListings = /(объявлен|публикац|вариант|листинг|предложен|недвижим)/i.test(lower) || hasHouse || hasApartment;
  const asksFresh = /(нов|свеж|последн|актуальн|latest|new|fresh)/i.test(lower);
  const hasDetailedCriteria = /(\$|€|֏|\b\d+\s*(?:к|k|тыс|м²|m2|sqm|комнат|мин|этаж)|\b(?:до|от)\s*\d|ремонт|лифт|участ|центр|агент)/i.test(lower);

  if (!(wantsDelivery && (asksListings || asksFresh)) && !(asksListings && asksFresh)) return null;
  if (hasDetailedCriteria) return null;

  const categories = hasHouse && !hasApartment ? ["house"] : hasApartment && !hasHouse ? ["apartment"] : null;
  const wantsAll = /\b(все|всё|all)\b/i.test(lower);
  const wantsTop = /(лучшие|выгод|топ|top|best)/i.test(lower);
  const shouldScan = /(нов|свеж|актуальн|проверь|проверить|обнов|скан|scan|сейчас|найди|latest|new|fresh)/i.test(lower);

  return {
    categories,
    limit: wantsAll ? 20 : 8,
    mode: wantsTop ? "top" : "latest",
    shouldScan,
  };
}

async function sendSavedMatches(config, state, subscriber, chatId, options = {}) {
  const limit = options.limit || 6;
  const mode = options.mode || "latest";
  const title = options.title || (mode === "top" ? "Лучшие сохраненные варианты" : "Сохраненные подходящие варианты");
  const listings = matchingListings(config, subscriber, state.listings || [], limit, mode);
  if (listings.length === 0) return false;

  for (const chunk of chunkListings(title, listings, config)) {
    await sendMessage(config, chatId, chunk);
  }
  return true;
}

function scopedSubscriberForCategories(config, subscriber, categories) {
  if (!categories?.length) return subscriber;
  return {
    ...subscriber,
    filters: normalizeFilters(config, {
      ...subscriber.filters,
      categories,
    }),
  };
}

async function triggerManualScan(config, state, chatId, hooks = {}, options = {}) {
  const isAdmin = config.adminChatIds.has(String(chatId));
  if (!isAdmin && !config.userScanEnabled) {
    await sendMessage(config, chatId, "Внеочередная проверка сейчас выключена. Статус: /status");
    return true;
  }

  const now = Date.now();
  const lastUserScanAt = Date.parse(state.lastUserScanAt || "");
  const cooldownMs = config.userScanCooldownMinutes * 60 * 1000;
  if (!isAdmin && Number.isFinite(lastUserScanAt) && now - lastUserScanAt < cooldownMs) {
    const waitMinutes = Math.max(1, Math.ceil((cooldownMs - (now - lastUserScanAt)) / 60000));
    await sendMessage(config, chatId, `Скан уже запускали недавно. Следующий ручной запуск будет доступен примерно через ${waitMinutes} мин. Статус: /status`);
    return true;
  }

  state.lastUserScanAt = new Date(now).toISOString();
  await sendMessage(
    config,
    chatId,
    options.message || "Запускаю внеочередную проверку источников. Если один сайт временно не отдаст объявления, остальные всё равно проверю."
  );
  Promise.resolve(hooks.scanNow?.()).catch((error) => console.error(`[telegram] manual scan failed: ${error.message}`));
  return true;
}

async function handleNaturalListingRequest(config, state, subscriber, chat, text, hooks = {}) {
  const request = naturalListingRequest(text);
  if (!request) return false;

  const scopedSubscriber = scopedSubscriberForCategories(config, subscriber, request.categories);
  const title =
    request.mode === "top"
      ? "Лучшие подходящие варианты"
      : request.categories?.[0] === "house"
        ? "Последние подходящие дома"
        : request.categories?.[0] === "apartment"
          ? "Последние подходящие квартиры"
          : "Последние подходящие варианты";
  const sent = await sendSavedMatches(config, state, scopedSubscriber, chat.id, {
    limit: request.limit,
    mode: request.mode,
    title,
  });

  if (!sent) {
    await sendMessage(
      config,
      chat.id,
      "В сохраненной базе пока нет объявлений под эти фильтры. Я могу проверить источники сейчас и пришлю новые подходящие варианты автоматически."
    );
  }

  if (request.shouldScan) {
    await triggerManualScan(config, state, chat.id, hooks, {
      message: "Параллельно запускаю проверку источников. Если появятся новые подходящие объявления, пришлю их автоматически.",
    });
  }

  return true;
}

function parseNumberArg(args, fallback) {
  const raw = args.join(" ").replace(/[^\d.]/g, "");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isResetText(text) {
  return /^(all|any|все|любой|любое|reset|сброс|off|none)$/i.test(text.trim());
}

function numbersFromText(text) {
  return (text.match(/\d+(?:[.,]\d+)?/g) || []).map((value) => Number(value.replace(",", "."))).filter((value) => Number.isFinite(value));
}

function parseRangeArg(args, single = "max") {
  const text = args.join(" ").toLowerCase();
  if (!text || isResetText(text)) return { reset: true };

  const numbers = numbersFromText(text);
  if (numbers.length === 0) return null;
  if (numbers.length >= 2) return { min: Math.min(numbers[0], numbers[1]), max: Math.max(numbers[0], numbers[1]) };

  const value = numbers[0];
  if (/от|from|min|\+/.test(text) || single === "min") return { min: value, max: null };
  if (/до|under|max|≤/.test(text) || single === "max") return { min: null, max: value };
  return { min: value, max: value };
}

function parseListArg(args) {
  const text = args.join(" ").trim();
  if (!text || isResetText(text)) return [];
  return text
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseAreas(config, args) {
  const text = args.join(" ").trim();
  if (!text || isResetText(text)) return [];

  const lowered = text.toLowerCase();
  const matched = config.defaultLocations.filter((location) => lowered.includes(location.toLowerCase()));
  if (matched.length > 0) return matched;

  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => config.defaultLocations.includes(item));
}

function parseTypes(args) {
  const text = args.join(" ").toLowerCase();
  if (!text || /all|все|reset|сброс/.test(text)) return ["apartment", "house"];
  const types = [];
  if (/apartment|apt|flat|кварт/.test(text)) types.push("apartment");
  if (/house|home|дом|таун/.test(text)) types.push("house");
  return types.length ? types : ["apartment", "house"];
}

function parseElevator(args) {
  const text = args.join(" ").toLowerCase();
  if (!text || isResetText(text)) return "any";
  if (/yes|да|лифт|with/.test(text) && !/без|no/.test(text)) return "yes";
  if (/no|нет|без/.test(text)) return "no";
  return "any";
}

function parseCondition(args) {
  const text = args.join(" ").toLowerCase();
  if (!text || isResetText(text)) return "any";
  if (/под ремонт|без ремонта|нужен|needs|old|unfinished|repair/.test(text)) return "needs_work";
  if (/ready|готов|с ремонтом|renovated|major|euro|designer/.test(text)) return "ready";
  return "any";
}

function shortFiltersText(config, rawFilters) {
  const filters = normalizeFilters(config, rawFilters);
  const categories = filters.categories?.length ? filters.categories.map(categoryLabel).join(", ") : "квартиры, дома";
  const locations = filters.locations?.length ? filters.locations.join(", ") : "все районы из базы";
  const rooms = rangeText(filters.minRooms, filters.maxRooms);
  const area = rangeText(filters.minAreaSqm, filters.maxAreaSqm, " м²");
  const distance = filters.maxDistanceMinutes ? `до ${filters.maxDistanceMinutes} мин до центра` : "без ограничения по времени до центра";

  return [
    `<b>Сейчас бот ищет</b>`,
    `${escapeHtml(categories)} до ${money(filters.maxPriceUsd)}.`,
    `Районы: ${escapeHtml(locations)}.`,
    `Комнаты: ${rooms}, площадь: ${area}, ${distance}.`,
    "",
    `Хочешь изменить - просто напиши обычным текстом, например:`,
    `<i>дом до 120к, до 30 минут от центра, без агентств</i>`,
  ].join("\n");
}

function sourceStatusLine(entry) {
  if (entry.degraded) {
    const error = entry.lastError ? ` (${entry.lastError})` : "";
    return `⚠️ ${entry.label} — временно недоступен${error}, бот пробует снова автоматически`;
  }
  if (entry.blocked) {
    return `⚠️ ${entry.label} — сайт показывает проверку браузера, бот пробует снова автоматически`;
  }
  if (entry.lastError) {
    return `⚠️ ${entry.label} — ошибка: ${entry.lastError}`;
  }
  const duration = entry.durationMs ? ` за ${Math.max(1, Math.round(entry.durationMs / 1000))}с` : "";
  return `✅ ${entry.label} — ${listingsCountText(entry.listings)}${duration}`;
}

function statusText(config, state) {
  const activeCount = activeSubscribers(state, config).length;
  const blockedStreak = Number(state.scanHealth?.blockedStreak || 0);
  const entries = sourceStatusEntries(state);

  const lines = ["Бот работает и следит за объявлениями."];
  if (state.lastScan) {
    const when = relativeTimeText(state.lastScan.at);
    const summary = state.lastScan.error
      ? `закончилась ошибкой: ${state.lastScan.error}`
      : `нашла ${listingsCountText(Number(state.lastScan.scanned || 0))}, новых для рассылки: ${Number(state.lastScan.new || 0)}`;
    lines.push(`Последняя проверка ${when ? `${when} ` : ""}${summary}.`);
  } else {
    lines.push("Первая проверка ещё не выполнялась.");
  }
  const nextWhen = relativeTimeText(state.nextScanAt);
  lines.push(`Проверяю источники каждые ${config.scanIntervalMinutes} мин${nextWhen ? `, следующая ${nextWhen}` : ""}.`);

  if (entries.length > 0) {
    lines.push("", "Источники:");
    for (const entry of entries) lines.push(sourceStatusLine(entry));
  } else if (blockedStreak > 0) {
    lines.push("", "List.am сейчас показывает проверку браузера. Другие источники бот проверяет параллельно.");
  }

  lines.push("", `Подписчиков: ${activeCount}.`, "Твои фильтры: /filters · Свежие варианты: /latest");
  return lines.map((line) => escapeHtml(line)).join("\n");
}

function latestKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Показать ещё", callback_data: "latest:more" }],
      [
        { text: "Только дома", callback_data: "latest:houses" },
        { text: "Только квартиры", callback_data: "latest:apartments" },
      ],
      [
        { text: "От 70 м²", callback_data: "flt:minarea:70" },
        { text: "Источники", callback_data: "src:menu" },
      ],
    ],
  };
}

function sourcesKeyboard(subscriber) {
  const excluded = new Set(subscriber.filters?.excludeSources || []);
  return {
    inline_keyboard: TOGGLE_SOURCES.map(([key, label]) => [
      { text: `${excluded.has(key) ? "🚫" : "✅"} ${label}`, callback_data: `src:toggle:${key}` },
    ]),
  };
}

function rememberShownListings(subscriber, items) {
  const shown = new Set(subscriber.latestSession?.shownIds || []);
  for (const item of items) shown.add(item.id);
  subscriber.latestSession = {
    shownIds: Array.from(shown).slice(-200),
    at: new Date().toISOString(),
  };
}

async function sendListingsPageWithMore(config, state, subscriber, chatId) {
  const shown = new Set(subscriber.latestSession?.shownIds || []);
  const remaining = filteredSortedListings(config, subscriber, state.listings || [], "latest").filter((item) => !shown.has(item.id));
  const items = remaining.slice(0, 8);
  if (items.length === 0) return false;

  rememberShownListings(subscriber, items);
  const chunks = chunkListings("Ещё варианты", items, config);
  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = index === chunks.length - 1;
    const options = isLast && remaining.length > items.length ? { replyMarkup: latestKeyboard() } : {};
    await sendMessage(config, chatId, chunks[index], options);
  }
  return true;
}

async function handleCallbackQuery(config, state, callbackQuery, hooks = {}) {
  const data = String(callbackQuery.data || "");
  const chat = callbackQuery.message?.chat;
  const answer = (text) =>
    telegramApi(config, "answerCallbackQuery", { callback_query_id: callbackQuery.id, ...(text ? { text } : {}) }).catch((error) =>
      console.warn(`[telegram] answerCallbackQuery failed: ${error.message}`)
    );
  if (!chat) {
    await answer();
    return true;
  }

  // Unlike commands, a button tap must not re-activate a /stop-ped subscriber.
  const subscriber =
    (state.subscribers || []).find((item) => String(item.id) === String(chat.id)) ||
    upsertSubscriber(config, state, chat, callbackQuery.from);
  subscriber.filters = normalizeFilters(config, subscriber.filters);

  try {
    if (data.startsWith("latest:more")) {
      const sent = await sendListingsPageWithMore(config, state, subscriber, chat.id);
      await answer(sent ? undefined : "Больше подходящих вариантов пока нет");
      return true;
    }

    if (data === "latest:houses" || data === "latest:apartments") {
      const categoryKey = data === "latest:houses" ? "house" : "apartment";
      const scoped = scopedSubscriberForCategories(config, subscriber, [categoryKey]);
      const sent = await sendSavedMatches(config, state, scoped, chat.id, {
        limit: 8,
        title: categoryKey === "house" ? "Последние дома по фильтрам" : "Последние квартиры по фильтрам",
      });
      await answer(sent ? undefined : "Пока нет таких вариантов");
      return true;
    }

    if (data === "flt:minarea:70") {
      subscriber.filters.minAreaSqm = 70;
      await answer("Теперь показываю только от 70 м²");
      await sendMessage(config, chat.id, `Фильтр обновлён: площадь от 70 м².\n\n${filtersText(config, subscriber.filters)}`);
      return true;
    }

    if (data === "src:menu") {
      await answer();
      await sendMessage(config, chat.id, "Какие источники показывать? Нажми, чтобы скрыть или вернуть:", {
        replyMarkup: sourcesKeyboard(subscriber),
      });
      return true;
    }

    if (data.startsWith("src:toggle:")) {
      const source = data.split(":")[2];
      if (!TOGGLE_SOURCES.some(([key]) => key === source)) {
        await answer();
        return true;
      }
      const excluded = new Set(subscriber.filters.excludeSources || []);
      const nowExcluded = !excluded.has(source);
      if (nowExcluded) excluded.add(source);
      else excluded.delete(source);
      subscriber.filters.excludeSources = Array.from(excluded);
      await answer(nowExcluded ? `${toggleSourceLabel(source)} скрыт` : `${toggleSourceLabel(source)} снова показывается`);
      await telegramApi(config, "editMessageReplyMarkup", {
        chat_id: chat.id,
        message_id: callbackQuery.message.message_id,
        reply_markup: sourcesKeyboard(subscriber),
      }).catch((error) => console.warn(`[telegram] editMessageReplyMarkup failed: ${error.message}`));
      return true;
    }

    await answer();
  } catch (error) {
    // Swallow errors: a thrown callback would 500 the webhook and make
    // Telegram redeliver the update, duplicating messages.
    console.error(`[telegram] callback ${data} failed: ${error.stack || error.message}`);
    await answer("Не получилось, попробуй ещё раз");
  }
  return true;
}

function commandKeyboard() {
  return {
    keyboard: [
      [{ text: "/tour" }, { text: "/setup" }],
      [{ text: "/latest" }, { text: "/top" }],
      [{ text: "/filters" }, { text: "/status" }],
      [{ text: "/houses" }, { text: "/apartments" }],
      [{ text: "/scan" }, { text: "/test" }],
      [{ text: "/help" }],
    ],
    resize_keyboard: true,
  };
}

function tourText(config) {
  return [
    `<b>Что делает этот бот</b>`,
    `Я проверяю новые объявления по недвижимости из нескольких источников и присылаю сюда только те варианты, которые подходят под твои фильтры.`,
    "",
    `<b>Самый простой старт</b>`,
    `1. Напиши, что ищешь, обычным текстом.`,
    `2. Я превращу это в фильтры и покажу, что понял.`,
    `3. Если все верно, нажми /apply.`,
    `4. Дальше просто жди новые объявления.`,
    "",
    `<b>Пример сообщения</b>`,
    `<i>квартира 2-3 комнаты до 110к, Аван или Нор Норк, с ремонтом</i>`,
    `<i>дом до 120к, до 30 минут от центра, участок от 200 м²</i>`,
    "",
    `<b>Главные кнопки</b>`,
    `/setup - примеры настройки`,
    `/latest - уже найденные варианты`,
    `/filters - что сейчас ищем`,
    `/status - работает ли монитор`,
    `/scan - проверить источники прямо сейчас`,
    "",
    `По умолчанию бюджет до ${money(config.maxPriceUsd)}. Команды знать не нужно: можно писать обычным текстом.`,
  ].join("\n");
}

function helpText(config, state) {
  const username = state.bot?.username ? `@${state.bot.username}` : "бота";
  return [
    `<b>Как работает бот</b>`,
    `Бот периодически проверяет несколько сайтов с недвижимостью. Если появилось новое объявление под твои фильтры, он присылает его сюда.`,
    "",
    `<b>Как настроить проще всего</b>`,
    `Просто напиши обычным текстом, что нужно:`,
    `<i>2-3 комнаты до 110к, не выше 5 этажа, без агентств</i>`,
    `Бот покажет будущие фильтры. Применить их можно командой /apply.`,
    "",
    `<b>Главное</b>`,
    `/tour - короткое объяснение с нуля`,
    `/setup - примеры и пресеты`,
    `/latest - последние варианты`,
    `/top - лучшие по качеству`,
    `/houses - дома по твоим фильтрам`,
    `/apartments - квартиры по твоим фильтрам`,
    `/filters - показать фильтры`,
    `/status - проверить монитор`,
    `/scan - запустить внеочередной скан`,
    `/test - проверить доставку Telegram`,
    `/share - ссылка, чтобы передать ${escapeHtml(username)}`,
    "",
    `<b>Точная ручная настройка</b>`,
    `/price 80000-120000 - диапазон цены`,
    `/budget 100000 - цена до суммы`,
    `/rooms 2-3 - комнаты`,
    `/area 50-100 - площадь`,
    `/land 100-600 - участок для домов`,
    `/sqm 1600 - цена за м² до суммы`,
    `/floor 1-4 - этаж`,
    `/distance 25 - до центра не дальше минут`,
    `/elevator yes - только с лифтом`,
    `/condition ready - с ремонтом`,
    `/keywords gas, balcony - обязательные слова`,
    `/exclude agency - исключить слова`,
    `/areas Avan, Nor Nork, Abovyan - районы`,
    `/types apartment, house - тип жилья`,
    `/score 6 - минимальное качество 0-10`,
    `/reset - сбросить все фильтры`,
  ].join("\n");
}

function setupText() {
  return [
    `<b>Настройка без команд</b>`,
    `Напиши одним сообщением, что ищешь. Бот сам разложит это на фильтры и попросит подтвердить.`,
    "",
    `<b>Примеры</b>`,
    `<i>дом до 120к, максимум 30 минут до центра, участок от 200 м²</i>`,
    `<i>квартира 2-3 комнаты до 110к, Аван или Нор Норк, с ремонтом</i>`,
    `<i>только квартиры, 50-90 м², до 1600 за м², без агентств</i>`,
    "",
    `<b>Пресеты</b>`,
    `/preset ready - больше вариантов с ремонтом`,
    `/preset value - больше выгодных по цене за м²`,
    `/preset apartment - только квартиры`,
    `/preset house - только дома`,
    `/preset near - ближе к центру`,
    "",
    `После любого пресета можно снова написать обычным текстом, и бот обновит фильтры.`,
  ].join("\n");
}

function applyPreset(config, subscriber, name) {
  const filters = normalizeFilters(config, subscriber.filters);
  if (name === "ready") {
    filters.condition = "ready";
    filters.minQualityScore = Math.max(filters.minQualityScore, 6);
    filters.maxFloor ||= 5;
  } else if (name === "value") {
    filters.maxPricePerSqm = 1500;
    filters.minQualityScore = Math.max(filters.minQualityScore, 5);
  } else if (name === "apartment" || name === "flat") {
    filters.categories = ["apartment"];
  } else if (name === "house") {
    filters.categories = ["house"];
    filters.maxDistanceMinutes ||= 30;
  } else if (name === "near") {
    filters.maxDistanceMinutes = 20;
  } else {
    return null;
  }
  subscriber.filters = filters;
  return filters;
}

function clearFilterFields(config, filters, fields) {
  if (fields.includes("all")) return defaultFilters(config);

  const next = { ...filters };
  for (const field of fields) {
    if (field === "price") {
      next.minPriceUsd = config.minPriceUsd;
      next.maxPriceUsd = config.maxPriceUsd;
    } else if (field === "rooms") {
      next.minRooms = null;
      next.maxRooms = null;
    } else if (field === "area") {
      next.minAreaSqm = null;
      next.maxAreaSqm = null;
    } else if (field === "land") {
      next.minLandSqm = null;
      next.maxLandSqm = null;
    } else if (field === "sqm") {
      next.maxPricePerSqm = null;
    } else if (field === "floor") {
      next.minFloor = null;
      next.maxFloor = null;
    } else if (field === "distance") {
      next.maxDistanceMinutes = null;
    } else if (field === "quality") {
      next.minQualityScore = config.minQualityScore;
    } else if (field === "locations") {
      next.locations = [];
    } else if (field === "categories") {
      next.categories = config.categories.map((category) => category.key);
    } else if (field === "elevator") {
      next.elevator = "any";
    } else if (field === "condition") {
      next.condition = "any";
    } else if (field === "keywords") {
      next.keywords = [];
    } else if (field === "excludeKeywords") {
      next.excludeKeywords = [];
    }
  }
  return next;
}

function orderedRange(min, max) {
  if (min && max && min > max) return { min: max, max: min };
  return { min, max };
}

function hasAreaLowerBoundIntent(text) {
  const value = normalizeText(text).toLowerCase();
  return (
    /(?:от|from|min(?:imum)?|минимум|не\s*меньше|больше|>=)\s*\d+(?:[.,]\d+)?\s*(?:кв\.?\s*м|квм|м²|м2|m²|m2|sq\.?\s*m|sqm)?/i.test(value) ||
    /\d+(?:[.,]\d+)?\s*(?:кв\.?\s*м|квм|м²|м2|m²|m2|sq\.?\s*m|sqm)\s*\+/i.test(value)
  );
}

function hasAreaUpperBoundIntent(text) {
  return /(?:до|under|max(?:imum)?|не\s*больше|меньше|<=)\s*\d+(?:[.,]\d+)?\s*(?:кв\.?\s*м|квм|м²|м2|m²|m2|sq\.?\s*m|sqm)?/i.test(
    normalizeText(text).toLowerCase()
  );
}

function normalizeAreaRangeFromText(userText, area) {
  if (!area.min || !area.max || area.min !== area.max) return area;
  if (hasAreaLowerBoundIntent(userText)) return { min: area.min, max: null };
  if (hasAreaUpperBoundIntent(userText)) return { min: null, max: area.max };
  return area;
}

function isAdditiveFilterText(text) {
  return /\b(add|include|also|plus)\b|добав|добавь|добавить|добавим|плюс|ещ[её]|также|\+/i.test(normalizeText(text));
}

function isReplacementFilterText(text) {
  return /\b(only|replace|instead)\b|только|замени|заменить|вместо|оставь\s+только/i.test(normalizeText(text));
}

function mergeUnique(existing, incoming) {
  return Array.from(new Set([...(existing || []), ...(incoming || [])].filter(Boolean)));
}

function shouldMergeAiListPatch(userText, field, baseFilters, patch) {
  if (!Array.isArray(patch[field]) || patch[field].length === 0) return false;
  if (isReplacementFilterText(userText) || !isAdditiveFilterText(userText)) return false;
  return Array.isArray(baseFilters[field]) && baseFilters[field].length > 0;
}

function applyAiPatch(config, currentFilters, result, userText = "") {
  let next = clearFilterFields(config, normalizeFilters(config, currentFilters), result.clear || []);
  if (result.action === "reset") return defaultFilters(config);
  const baseFilters = normalizeFilters(config, currentFilters);

  const patch = result.patch || {};
  for (const key of ["minPriceUsd", "maxPriceUsd", "maxPricePerSqm", "maxDistanceMinutes", "minQualityScore"]) {
    if (patch[key] !== null && patch[key] !== undefined) next[key] = patch[key];
  }

  const rooms = orderedRange(patch.minRooms, patch.maxRooms);
  if (rooms.min !== null && rooms.min !== undefined) next.minRooms = rooms.min;
  if (rooms.max !== null && rooms.max !== undefined) next.maxRooms = rooms.max;

  const area = normalizeAreaRangeFromText(userText, orderedRange(patch.minAreaSqm, patch.maxAreaSqm));
  if (area.min !== null && area.min !== undefined) next.minAreaSqm = area.min;
  if (area.max !== null && area.max !== undefined) next.maxAreaSqm = area.max;

  const floor = orderedRange(patch.minFloor, patch.maxFloor);
  if (floor.min !== null && floor.min !== undefined) next.minFloor = floor.min;
  if (floor.max !== null && floor.max !== undefined) next.maxFloor = floor.max;

  const land = orderedRange(patch.minLandSqm, patch.maxLandSqm);
  if (land.min !== null && land.min !== undefined) next.minLandSqm = land.min;
  if (land.max !== null && land.max !== undefined) next.maxLandSqm = land.max;
  if (next.minLandSqm || next.maxLandSqm) next.categories = ["house"];

  if (Array.isArray(patch.locations)) {
    next.locations = shouldMergeAiListPatch(userText, "locations", baseFilters, patch) ? mergeUnique(baseFilters.locations, patch.locations) : patch.locations;
  }
  if (Array.isArray(patch.categories) && patch.categories.length) {
    next.categories = shouldMergeAiListPatch(userText, "categories", baseFilters, patch) ? mergeUnique(baseFilters.categories, patch.categories) : patch.categories;
  }
  if (["yes", "no", "any"].includes(patch.elevator)) next.elevator = patch.elevator;
  if (["ready", "needs_work", "any"].includes(patch.condition)) next.condition = patch.condition;
  if (Array.isArray(patch.keywords)) {
    next.keywords = shouldMergeAiListPatch(userText, "keywords", baseFilters, patch) ? mergeUnique(baseFilters.keywords, patch.keywords) : patch.keywords;
  }
  if (Array.isArray(patch.excludeKeywords)) {
    next.excludeKeywords = shouldMergeAiListPatch(userText, "excludeKeywords", baseFilters, patch)
      ? mergeUnique(baseFilters.excludeKeywords, patch.excludeKeywords)
      : patch.excludeKeywords;
  }

  return normalizeFilters(config, next);
}

function aiSetupText(config) {
  return [
    `<b>Настройка текстом</b>`,
    config.openaiApiKey ? "Пиши обычным текстом, а я превращу это в фильтры и попрошу подтвердить." : "Настройка текстом пока не подключена. Можно настроить через /setup.",
    "",
    `<b>Примеры</b>`,
    `2-3 комнаты до 110к, Аван или Нор Норк, не выше 5 этажа`,
    `только квартиры с ремонтом, 50-90 м², до 1600 за м²`,
    `дома до 120к, максимум 30 минут до центра, без агентств`,
    "",
    `После разбора нажми /apply, если всё верно, или /cancel, если нужно отменить.`,
  ].join("\n");
}

function assistantAnswerFallback(config) {
  return [
    `Я бот для поиска недвижимости из нескольких источников.`,
    `Ты можешь написать обычным текстом, что ищешь, а я превращу это в фильтры и попрошу подтвердить через /apply.`,
    "",
    `Пример: дом до ${money(config.maxPriceUsd)}, до 30 минут от центра, без агентств.`,
    "",
    `/tour - коротко объясню всё с нуля`,
    `/latest - покажу сохраненные варианты`,
    `/status - покажу, работает ли монитор`,
  ].join("\n");
}

function isBotUsageQuestion(text) {
  const lower = normalizeText(text).toLowerCase();
  const asksAboutBot = /(как.*(польз|работ|настро)|что.*(уме|можешь|делаешь)|кто\s+ты|зачем\s+ты|помощ|help|инструкц|команд|как\s+искать|привет|здравств)/i.test(lower);
  const hasSearchCriteria = /(кварт|дом|таун|комнат|ремонт|центр|агент|этаж|участ|район|лифт|м²|m2|sqm|\$|доллар|до\s*\d|от\s*\d)/i.test(lower);
  return asksAboutBot && !hasSearchCriteria;
}

async function proposeAiFilters(config, subscriber, chatId, text) {
  if (!config.aiFiltersEnabled || !config.openaiApiKey) {
    await sendMessage(config, chatId, isBotUsageQuestion(text) ? assistantAnswerFallback(config) : aiSetupText(config));
    return true;
  }

  try {
    const pending = subscriber.pendingAiFilters;
    const baseFilters = pending?.filters ? normalizeFilters(config, pending.filters) : subscriber.filters;
    const result = await withTyping(config, chatId, () =>
      parseFilterRequest(config, baseFilters, text, {
        source: pending?.filters ? "pending" : "active",
        pendingSummary: pending?.summary || "",
        pendingSourceText: pending?.sourceText || "",
      })
    );
    if (result.action === "answer" || result.action === "help") {
      await sendMessage(config, chatId, escapeHtml(result.reply || assistantAnswerFallback(config)));
      return true;
    }

    if (result.action === "unclear" || result.confidence < 0.35) {
      await sendMessage(
        config,
        chatId,
        [
          `Не совсем понял запрос.`,
          result.reply ? escapeHtml(result.reply) : result.summary ? `Похоже: ${escapeHtml(result.summary)}` : null,
          "",
          `Можешь написать проще, например:`,
          `<i>дом до 120к, до 30 минут от центра, без агентств</i>`,
          `Или нажми /tour, если хочешь быстро понять, как я работаю.`,
        ]
          .filter(Boolean)
          .join("\n")
      );
      return true;
    }

    const proposedFilters = applyAiPatch(config, baseFilters, result, text);
    subscriber.pendingAiFilters = {
      sourceText: text,
      summary: result.summary,
      previousSourceText: pending?.sourceText || "",
      previousSummary: pending?.summary || "",
      filters: proposedFilters,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await sendMessage(
      config,
      chatId,
      [
        `<b>Я понял так</b>`,
        escapeHtml(result.summary || "Обновить фильтры по твоему описанию."),
        "",
        filtersText(config, proposedFilters),
        "",
        `Применить: /apply`,
        `Отменить: /cancel`,
      ].join("\n")
    );
    return true;
  } catch (error) {
    console.error(`[openai] filter parse failed: ${error.message}`);
    if (isBotUsageQuestion(text)) {
      await sendMessage(config, chatId, assistantAnswerFallback(config));
      return true;
    }
    await sendMessage(config, chatId, `Настройка текстом сейчас не сработала: ${escapeHtml(error.message)}\nМожно настроить через /setup или попробовать написать проще.`);
    return true;
  }
}

async function configureTelegram(config, state) {
  if (!config.telegramToken && !config.dryRun) return state;

  const bot = await telegramApi(config, "getMe");
  state.bot = {
    id: bot.id,
    username: bot.username,
    firstName: bot.first_name,
  };

  await setupTelegramApi(config, "setMyName", {
    name: "Yerevan Real Estate Bot",
  });
  await setupTelegramApi(config, "setMyShortDescription", {
    short_description: "Новые квартиры и дома из нескольких источников. Просто напиши, что ищешь.",
  });
  await setupTelegramApi(config, "setMyDescription", {
    description:
      "Бот проверяет новые объявления по недвижимости из нескольких источников и присылает совпадения. Настройка простая: напиши обычным текстом, что ищешь, например 'дом до 120к, до 30 минут от центра'.",
  });
  await setupTelegramApi(config, "setMyCommands", {
    commands: [
      { command: "start", description: "Включить подписку" },
      { command: "tour", description: "Как работает бот" },
      { command: "latest", description: "Последние варианты" },
      { command: "top", description: "Лучшие по качеству" },
      { command: "houses", description: "Дома по фильтрам" },
      { command: "apartments", description: "Квартиры по фильтрам" },
      { command: "filters", description: "Мои фильтры" },
      { command: "test", description: "Проверить доставку" },
      { command: "scan", description: "Запустить скан" },
      { command: "ai", description: "Настроить фильтры текстом" },
      { command: "apply", description: "Применить настройку" },
      { command: "cancel", description: "Отменить настройку" },
      { command: "setup", description: "Быстрая настройка" },
      { command: "price", description: "Диапазон цены" },
      { command: "budget", description: "Бюджет до суммы" },
      { command: "rooms", description: "Комнаты" },
      { command: "area", description: "Площадь" },
      { command: "land", description: "Участок для домов" },
      { command: "sqm", description: "Цена за м²" },
      { command: "floor", description: "Этаж" },
      { command: "distance", description: "Минут до центра" },
      { command: "elevator", description: "Фильтр лифта" },
      { command: "condition", description: "Состояние" },
      { command: "keywords", description: "Обязательные слова" },
      { command: "exclude", description: "Исключить слова" },
      { command: "areas", description: "Районы" },
      { command: "types", description: "Тип жилья" },
      { command: "score", description: "Минимальное качество" },
      { command: "status", description: "Статус монитора" },
      { command: "help", description: "Помощь" },
      { command: "stop", description: "Выключить подписку" },
    ],
  });

  if (config.publicUrl) {
    await telegramApi(config, "setWebhook", {
      url: `${config.publicUrl}/telegram/webhook`,
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log(`[telegram] webhook set: ${config.publicUrl}/telegram/webhook`);
  } else if (config.pollTelegramWhenNoWebhook) {
    await telegramApi(config, "deleteWebhook", { drop_pending_updates: false });
    console.log("[telegram] no PUBLIC_URL/RENDER_EXTERNAL_URL, using getUpdates polling");
  }

  return state;
}

async function handleCommand(config, state, message, hooks = {}) {
  const chat = message.chat;
  const from = message.from;
  const text = normalizeText(message.text || "");
  if (!text) return false;

  const parts = text.split(/\s+/);
  const command = parts[0].split("@")[0].toLowerCase();
  const args = parts.slice(1);
  const subscriber = upsertSubscriber(config, state, chat, from);
  subscriber.filters = normalizeFilters(config, subscriber.filters);
  if (command.startsWith("/") || chat.type === "private") {
    await sendChatAction(config, chat.id);
  }

  if (command === "/start" || command === "/subscribe") {
    await sendMessage(
      config,
      chat.id,
      ["Подписка включена.", "", tourText(config)].join("\n"),
      { replyMarkup: commandKeyboard(), disablePreview: true }
    );
    await sendMessage(config, chat.id, shortFiltersText(config, subscriber.filters));
    await sendSavedMatches(config, state, subscriber, chat.id, {
      limit: 5,
      title: "Так выглядят подходящие варианты",
    });
    return true;
  }

  if (command === "/tour") {
    await sendMessage(config, chat.id, tourText(config), { replyMarkup: commandKeyboard(), disablePreview: true });
    await sendMessage(config, chat.id, shortFiltersText(config, subscriber.filters));
    return true;
  }

  if (command === "/stop" || command === "/unsubscribe") {
    deactivateSubscriber(state, chat.id);
    await sendMessage(config, chat.id, "Подписка выключена. Вернуться можно командой /start.");
    return true;
  }

  if (command === "/help") {
    await sendMessage(config, chat.id, helpText(config, state), { replyMarkup: commandKeyboard(), disablePreview: true });
    return true;
  }

  if (command === "/setup") {
    await sendMessage(config, chat.id, setupText());
    return true;
  }

  if (command === "/share") {
    const username = state.bot?.username;
    const link = username ? `https://t.me/${username}` : "Ссылка появится после первого запуска Telegram API.";
    await sendMessage(config, chat.id, `Передать бот можно этой ссылкой:\n${escapeHtml(link)}`, { disablePreview: true });
    return true;
  }

  if (command === "/filters") {
    await sendMessage(config, chat.id, filtersText(config, subscriber.filters));
    return true;
  }

  if (command === "/test") {
    const blocked = Number(state.scanHealth?.blockedStreak || 0);
    await sendMessage(
      config,
      chat.id,
      [
        "Тестовое уведомление доставлено.",
        "Если видишь это сообщение, Telegram и подписка работают.",
        blocked ? "Важно: один из источников сейчас показывает проверку браузера, поэтому часть объявлений может задержаться. Подробности: /status" : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
    return true;
  }

  if (command === "/ai") {
    const prompt = normalizeText(args.join(" "));
    if (!prompt) {
      await sendMessage(config, chat.id, aiSetupText(config));
      return true;
    }
    return proposeAiFilters(config, subscriber, chat.id, prompt);
  }

  if (command === "/apply") {
    if (!subscriber.pendingAiFilters?.filters) {
      await sendMessage(config, chat.id, "Пока нечего применять. Сначала напиши обычным текстом, что ищешь, например: дом до 120к до 30 минут от центра.");
      return true;
    }
    subscriber.filters = normalizeFilters(config, subscriber.pendingAiFilters.filters);
    delete subscriber.pendingAiFilters;
    await sendMessage(config, chat.id, `Готово, фильтры применены.\n\n${filtersText(config, subscriber.filters)}`);
    const sent = await sendSavedMatches(config, state, subscriber, chat.id, {
      limit: 8,
      title: "Подходящие варианты из уже сохраненных",
    });
    if (!sent) await sendMessage(config, chat.id, "В сохраненной базе пока нет совпадений под эти фильтры. Новые пришлю после следующего успешного скана.");
    return true;
  }

  if (command === "/cancel") {
    if (subscriber.pendingAiFilters) {
      delete subscriber.pendingAiFilters;
      await sendMessage(config, chat.id, "Отменил. Текущие фильтры не менял.");
    } else {
      await sendMessage(config, chat.id, "Нечего отменять. Текущие фильтры не менял.");
    }
    return true;
  }

  if (command === "/preset") {
    const preset = normalizeText(args.join(" ")).toLowerCase();
    if (!preset || isResetText(preset)) {
      await sendMessage(config, chat.id, setupText());
      return true;
    }
    const filters = applyPreset(config, subscriber, preset);
    await sendMessage(config, chat.id, filters ? `Пресет применен.\n\n${filtersText(config, filters)}` : setupText());
    return true;
  }

  if (command === "/budget") {
    const budget = clamp(Math.round(parseNumberArg(args, config.maxPriceUsd)), 10000, 10000000);
    subscriber.filters.maxPriceUsd = budget;
    await sendMessage(config, chat.id, `Бюджет обновлен: ${money(budget)}\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/price") {
    const range = parseRangeArg(args, "max");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /price 80000-120000 или /price any");
      return true;
    }
    subscriber.filters.minPriceUsd = range.reset ? config.minPriceUsd : Math.round(range.min || 0);
    subscriber.filters.maxPriceUsd = range.reset ? config.maxPriceUsd : Math.round(range.max || range.min || config.maxPriceUsd);
    await sendMessage(config, chat.id, `Цена обновлена.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/score" || command === "/quality" || command === "/minscore") {
    const score = clamp(parseNumberArg(args, subscriber.filters.minQualityScore ?? config.minQualityScore), 0, 10);
    subscriber.filters.minQualityScore = Math.round(score * 10) / 10;
    await sendMessage(config, chat.id, `Минимальное качество обновлено: ${subscriber.filters.minQualityScore}/10`);
    return true;
  }

  if (command === "/rooms") {
    const range = parseRangeArg(args, "exact");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /rooms 2-3 или /rooms any");
      return true;
    }
    subscriber.filters.minRooms = range.reset ? null : Math.round(range.min || 0) || null;
    subscriber.filters.maxRooms = range.reset ? null : Math.round(range.max || range.min || 0) || null;
    await sendMessage(config, chat.id, `Комнаты обновлены.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/area") {
    const range = parseRangeArg(args, "min");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /area 50-100, /area от 60 или /area any");
      return true;
    }
    subscriber.filters.minAreaSqm = range.reset ? null : Math.round(range.min || 0) || null;
    subscriber.filters.maxAreaSqm = range.reset ? null : Math.round(range.max || 0) || null;
    await sendMessage(config, chat.id, `Площадь обновлена.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/land" || command === "/plot") {
    const range = parseRangeArg(args, "min");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /land 100-600, /land от 200 или /land any");
      return true;
    }
    subscriber.filters.minLandSqm = range.reset ? null : Math.round(range.min || 0) || null;
    subscriber.filters.maxLandSqm = range.reset ? null : Math.round(range.max || 0) || null;
    if (!range.reset) subscriber.filters.categories = ["house"];
    await sendMessage(config, chat.id, `Участок обновлен.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/sqm" || command === "/m2") {
    const range = parseRangeArg(args, "max");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /sqm 1600 или /sqm any");
      return true;
    }
    subscriber.filters.maxPricePerSqm = range.reset ? null : Math.round(range.max || range.min || 0) || null;
    await sendMessage(config, chat.id, `Цена за м² обновлена.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/floor") {
    const range = parseRangeArg(args, "max");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /floor 1-4, /floor до 5 или /floor any");
      return true;
    }
    subscriber.filters.minFloor = range.reset ? null : Math.round(range.min || 0) || null;
    subscriber.filters.maxFloor = range.reset ? null : Math.round(range.max || range.min || 0) || null;
    await sendMessage(config, chat.id, `Этаж обновлен.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/distance") {
    const range = parseRangeArg(args, "max");
    if (!range) {
      await sendMessage(config, chat.id, "Пример: /distance 25 или /distance any");
      return true;
    }
    subscriber.filters.maxDistanceMinutes = range.reset ? null : Math.round(range.max || range.min || 0) || null;
    await sendMessage(config, chat.id, `Расстояние обновлено.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/elevator") {
    subscriber.filters.elevator = parseElevator(args);
    await sendMessage(config, chat.id, `Лифт обновлен.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/condition") {
    subscriber.filters.condition = parseCondition(args);
    await sendMessage(config, chat.id, `Состояние обновлено.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/keywords") {
    subscriber.filters.keywords = parseListArg(args);
    await sendMessage(config, chat.id, `Ключевые слова обновлены.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/exclude") {
    subscriber.filters.excludeKeywords = parseListArg(args);
    await sendMessage(config, chat.id, `Исключения обновлены.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/areas") {
    const areas = parseAreas(config, args);
    subscriber.filters.locations = areas;
    await sendMessage(config, chat.id, areas.length ? `Районы обновлены: ${escapeHtml(areas.join(", "))}` : "Районы сброшены: теперь все разрешенные районы.");
    return true;
  }

  if (command === "/types") {
    const types = parseTypes(args);
    subscriber.filters.categories = types;
    await sendMessage(config, chat.id, `Типы обновлены: ${escapeHtml(types.map(categoryLabel).join(", "))}`);
    return true;
  }

  if (command === "/reset") {
    subscriber.filters = defaultFilters(config);
    await sendMessage(config, chat.id, `Фильтры сброшены.\n\n${filtersText(config, subscriber.filters)}`);
    return true;
  }

  if (command === "/latest") {
    const matched = matchingListings(config, subscriber, state.listings || [], 40, "latest");
    if (matched.length === 0) {
      await sendMessage(config, chat.id, "Пока нет сохраненных объявлений под эти фильтры. Можно подождать следующий успешный скан или расширить фильтры через /filters.");
      return true;
    }
    const sections = groupLatestSections(config, matched);
    const chunks = [];
    subscriber.latestSession = null;
    for (const section of sections) {
      chunks.push(...chunkListings(section.title, section.items, config));
      rememberShownListings(subscriber, section.items);
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const isLast = index === chunks.length - 1;
      await sendMessage(config, chat.id, chunks[index], isLast ? { replyMarkup: latestKeyboard() } : {});
    }
    return true;
  }

  if (command === "/top" || command === "/houses" || command === "/apartments") {
    const limit = clamp(Math.round(parseNumberArg(args, 8)), 1, 20);
    const mode = command === "/top" ? "top" : "latest";
    const scopedSubscriber = scopedSubscriberForCategories(
      config,
      subscriber,
      command === "/houses" || command === "/apartments" ? [command === "/houses" ? "house" : "apartment"] : null
    );
    const listings = matchingListings(config, scopedSubscriber, state.listings || [], limit, mode);
    if (listings.length === 0) {
      await sendMessage(config, chat.id, "Пока нет сохраненных объявлений под эти фильтры. Можно подождать следующий успешный скан или расширить фильтры через /filters.");
      return true;
    }
    const title =
      command === "/top"
        ? "Лучшие варианты"
        : command === "/houses"
          ? "Последние дома по фильтрам"
          : "Последние квартиры по фильтрам";
    for (const chunk of chunkListings(title, listings, config)) {
      await sendMessage(config, chat.id, chunk);
    }
    return true;
  }

  if (command === "/status") {
    await sendMessage(config, chat.id, statusText(config, state));
    return true;
  }

  if (command === "/scan") {
    return triggerManualScan(config, state, chat.id, hooks);
  }

  if (command.startsWith("/admin")) {
    return handleAdminCommand(config, state, chat, command, args, hooks);
  }

  if (command.startsWith("/")) {
    await sendMessage(config, chat.id, "Не понял команду. Нажми /tour, если хочешь быстро понять, как работает бот, или /help для всех команд.");
    return true;
  }

  if (chat.type === "private") {
    const handledListingRequest = await handleNaturalListingRequest(config, state, subscriber, chat, text, hooks);
    if (handledListingRequest) return true;
    return proposeAiFilters(config, subscriber, chat.id, text);
  }

  return false;
}

function adminHelpText() {
  return [
    "<b>Команды администратора</b>",
    "/admin_status - подробный статус бота",
    "/admin_sources - состояние каждого источника",
    "/admin_rescan - принудительный скан с полной проверкой List.am",
    "/admin_broadcast текст - подготовить рассылку всем подписчикам",
    "/admin_broadcast_send - отправить подготовленную рассылку",
    "/admin_debug id - показать объявление из кеша как JSON",
  ].join("\n");
}

function adminStatusText(config, state) {
  const subscribers = state.subscribers || [];
  const active = subscribers.filter((subscriber) => subscriber.active !== false).length;
  const listings = state.listings || [];
  const duplicates = listings.filter((item) => item.duplicateOf).length;
  const relay = state.relay?.listam;
  const memoryMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  const lastScan = state.lastScan;
  return [
    "<b>Админ-статус</b>",
    `Аптайм процесса: ${Math.round(process.uptime() / 60)} мин, память: ${memoryMb} МБ`,
    `Подписчики: ${active} активных из ${subscribers.length}`,
    `Кеш объявлений: ${listings.length} (из них дубликатов: ${duplicates}), seenIds: ${(state.seenIds || []).length}`,
    lastScan
      ? escapeHtml(
          `Последний скан: ${lastScan.at} (${lastScan.reason || "schedule"}), найдено ${lastScan.scanned}, новых ${lastScan.new}, подавлено дубликатов ${lastScan.duplicatesSuppressed || 0}${lastScan.error ? `, ошибка: ${lastScan.error}` : ""}`
        )
      : "Скана еще не было",
    `Блок-стрик List.am: ${Number(state.scanHealth?.blockedStreak || 0)}`,
    relay
      ? escapeHtml(`Relay List.am: ${relay.listings?.length || 0} объявлений, получено ${relativeTimeText(relay.receivedAt) || relay.receivedAt}`)
      : "Relay List.am: данных не поступало",
    escapeHtml(`Следующий скан: ${state.nextScanAt || "планируется"}`),
  ].join("\n");
}

function adminSourcesText(state) {
  const entries = sourceStatusEntries(state, { all: true });
  if (entries.length === 0) return "Данных по источникам еще нет: скан не выполнялся.";
  const lines = ["<b>Источники</b>"];
  for (const entry of entries) {
    const details = [
      `последний скан: ${listingsCountText(entry.listings)}`,
      entry.durationMs ? `${Math.max(1, Math.round(entry.durationMs / 1000))}с` : null,
      entry.failStreak ? `подряд неудач: ${entry.failStreak}` : null,
      entry.lastError ? `ошибка: ${entry.lastError}` : null,
      entry.lastSuccessAt ? `успех ${relativeTimeText(entry.lastSuccessAt) || entry.lastSuccessAt}` : null,
    ].filter(Boolean);
    lines.push(escapeHtml(`${entry.degraded || entry.blocked ? "⚠️" : "✅"} ${entry.label}: ${details.join(", ")}`));
  }
  return lines.join("\n");
}

async function broadcastToSubscribers(config, state, text) {
  const recipients = activeSubscribers(state, config);
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await sendMessage(config, recipient.id, text);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`[telegram] broadcast failed for ${recipient.id}: ${error.message}`);
      if (isPermanentTelegramDeliveryError(error)) deactivateSubscriber(state, recipient.id);
    }
  }
  return { sent, failed, total: recipients.length };
}

async function handleAdminCommand(config, state, chat, command, args, hooks = {}) {
  if (!config.adminChatIds.has(String(chat.id))) {
    await sendMessage(config, chat.id, "Эта команда доступна только администратору бота.");
    return true;
  }

  if (command === "/admin" || command === "/admin_help") {
    await sendMessage(config, chat.id, adminHelpText());
    return true;
  }

  if (command === "/admin_status") {
    await sendMessage(config, chat.id, adminStatusText(config, state));
    return true;
  }

  if (command === "/admin_sources") {
    await sendMessage(config, chat.id, adminSourcesText(state));
    return true;
  }

  if (command === "/admin_rescan") {
    state.scanHealth ||= {};
    state.scanHealth.lastListamFullProbeAt = null;
    await sendMessage(config, chat.id, "Запускаю принудительный скан всех источников с полной проверкой List.am.");
    Promise.resolve(hooks.scanNow?.()).catch((error) => console.error(`[telegram] admin rescan failed: ${error.message}`));
    return true;
  }

  if (command === "/admin_broadcast") {
    const text = normalizeText(args.join(" "));
    if (!text) {
      await sendMessage(config, chat.id, "Пример: /admin_broadcast Обновил бота, нажмите /start\nПосле проверки текста отправь /admin_broadcast_send");
      return true;
    }
    state.pendingAdminBroadcast = { text, by: String(chat.id), at: new Date().toISOString() };
    await sendMessage(
      config,
      chat.id,
      [
        "<b>Черновик рассылки</b>",
        escapeHtml(text),
        "",
        `Получателей: ${activeSubscribers(state, config).length}`,
        "Отправить: /admin_broadcast_send",
        "Отменить: просто не отправляй.",
      ].join("\n")
    );
    return true;
  }

  if (command === "/admin_broadcast_send") {
    const pending = state.pendingAdminBroadcast;
    if (!pending?.text) {
      await sendMessage(config, chat.id, "Нет подготовленной рассылки. Сначала: /admin_broadcast текст");
      return true;
    }
    delete state.pendingAdminBroadcast;
    const result = await broadcastToSubscribers(config, state, escapeHtml(pending.text));
    await sendMessage(config, chat.id, `Рассылка отправлена: ${result.sent} из ${result.total}${result.failed ? `, ошибок: ${result.failed}` : ""}.`);
    return true;
  }

  if (command === "/admin_debug") {
    const query = normalizeText(args.join(" ")).toLowerCase();
    if (!query) {
      await sendMessage(config, chat.id, "Пример: /admin_debug 22979765 или /admin_debug banali:H47316");
      return true;
    }
    const found = (state.listings || []).find(
      (item) =>
        String(item.id).toLowerCase() === query ||
        String(item.id).toLowerCase().includes(query) ||
        String(item.url || "").toLowerCase().includes(query)
    );
    if (!found) {
      await sendMessage(config, chat.id, `Объявление «${escapeHtml(query)}» в кеше не найдено.`);
      return true;
    }
    const dump = JSON.stringify(found, null, 1).slice(0, 3500);
    await sendMessage(config, chat.id, `<pre>${escapeHtml(dump)}</pre>`, { disablePreview: true });
    return true;
  }

  await sendMessage(config, chat.id, adminHelpText());
  return true;
}

async function handleTelegramUpdate(config, state, update, hooks = {}) {
  if (update.callback_query) return handleCallbackQuery(config, state, update.callback_query, hooks);
  const message = update.message;
  if (!message?.chat || !message.text) return false;
  return handleCommand(config, state, message, hooks);
}

async function pollTelegramOnce(config, state, hooks = {}) {
  const updates = await telegramApi(config, "getUpdates", {
    offset: Number(state.telegramUpdateOffset || 0) + 1,
    timeout: 0,
    allowed_updates: ["message", "callback_query"],
  });

  for (const update of updates) {
    state.telegramUpdateOffset = Math.max(Number(state.telegramUpdateOffset || 0), update.update_id);
    await handleTelegramUpdate(config, state, update, hooks);
  }
  return updates.length;
}

async function notifySubscribers(config, state, newListings) {
  const recipients = activeSubscribers(state, config);
  if (recipients.length === 0) {
    console.log("[telegram] no subscribers yet");
    return;
  }

  const now = new Date();
  const notifiableListings = newListings.filter((item) => shouldNotifyListing(config, item, now));
  const archivedOnly = newListings.length - notifiableListings.length;
  console.log(
    `[telegram] notification pass: recipients ${recipients.length}, new listings ${newListings.length}, notifiable ${notifiableListings.length}, archived ${archivedOnly}`
  );
  if (notifiableListings.length === 0) return;

  let matchedSubscribers = 0;
  let totalMatches = 0;
  let sentMessages = 0;
  let deactivatedSubscribers = 0;

  const cachedById = new Map((state.listings || []).map((item) => [item.id, item]));
  for (const subscriber of recipients) {
    if (subscriber.active === false) continue;
    subscriber.filters = normalizeFilters(config, subscriber.filters);
    const matches = notifiableListings.filter((item) => {
      if (!matchesSubscriber(config, subscriber, item)) return false;
      // A duplicate is only worth sending when its canonical copy does not
      // reach this subscriber (it was already sent or will be sent instead).
      const canonical = item.duplicateOf ? cachedById.get(item.duplicateOf) : null;
      if (canonical && matchesSubscriber(config, subscriber, canonical)) return false;
      return true;
    });
    if (matches.length === 0) continue;
    matchedSubscribers += 1;
    totalMatches += matches.length;
    const title = "Новые и обновленные варианты";
    for (const chunk of chunkListings(title, matches, config)) {
      await sendMessage(config, subscriber.id, chunk)
        .then(() => {
          sentMessages += 1;
        })
        .catch((error) => {
          console.error(`[telegram] failed to send listing notification: ${error.message}`);
          if (isPermanentTelegramDeliveryError(error)) {
            deactivateSubscriber(state, subscriber.id);
            deactivatedSubscribers += 1;
          }
        });
      if (subscriber.active === false) break;
    }
  }

  if (deactivatedSubscribers > 0) writeState(config, state);

  console.log(
    `[telegram] notification pass done: matched subscribers ${matchedSubscribers}, matched listings ${totalMatches}, messages sent ${sentMessages}, deactivated ${deactivatedSubscribers}`
  );
}

module.exports = {
  TelegramApiError,
  configureTelegram,
  handleTelegramUpdate,
  isPermanentTelegramDeliveryError,
  notifySubscribers,
  pollTelegramOnce,
  sendMessage,
  __test: {
    chunkListings,
    filtersText,
    groupLatestSections,
    listingLine,
    listingUrl,
    listingDateDetail,
    matchesSubscriber,
    matchingListings,
    parseAreas,
    parseRangeArg,
    parseTypes,
    relativeTimeText,
    shouldNotifyListing,
    statusText,
  },
};
