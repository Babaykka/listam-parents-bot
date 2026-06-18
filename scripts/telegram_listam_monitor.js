const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const STATE_FILE = path.join(DATA_DIR, "listam-monitor-state.json");

const AMD_PER_USD = 368.19;

const DEFAULT_CATEGORIES = [
  { id: 60, label: "Квартира" },
  { id: 62, label: "Дом" },
];

const LOCATIONS = [
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
  "Proshyan",
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
  Merdzavan: 28,
  Balahovit: 28,
  Dzoraghbyur: 30,
  Masis: 30,
  Abovyan: 30,
};

const BADGES = [
  "Urgent",
  "Hot offer",
  "Super price",
  "Discount",
  "Agency",
  "Documents verified",
  "Verified with Cadastre",
  "Property Not Verified",
  "Never occupied",
  "Open to negotiation",
  "Listed by Owner",
  "Furnished",
  "Beautiful view",
  "Unprecedented price",
  "Black Friday Sale",
];

const PAGE_MARKERS = [
  "Regular Ads",
  "Top Ads",
  "Ads for",
  "Սովորական հայտարարություններ",
  "Թոփ հայտարարություններ",
  "հայտարարություն",
  "Обычные объявления",
  "Топ объявления",
  "объявлен",
];

function loadEnvFile(filePath) {
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
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parsePrice(text) {
  const normalized = normalizeText(text);
  const usd = normalized.match(/^\$([\d,]+)/);
  if (usd) {
    const amount = Number(usd[1].replace(/,/g, ""));
    return { amount, currency: "USD", usd: amount, label: `$${amount.toLocaleString("en-US")}` };
  }

  const amd = normalized.match(/^([\d,]+)\s*֏/);
  if (amd) {
    const amount = Number(amd[1].replace(/,/g, ""));
    const usdAmount = Math.round(amount / AMD_PER_USD);
    return {
      amount,
      currency: "AMD",
      usd: usdAmount,
      label: `${amount.toLocaleString("en-US")} AMD (~$${usdAmount.toLocaleString("en-US")})`,
    };
  }

  const eur = normalized.match(/^€([\d,]+)/);
  if (eur) {
    const amount = Number(eur[1].replace(/,/g, ""));
    const usdAmount = Math.round(amount * 1.08);
    return {
      amount,
      currency: "EUR",
      usd: usdAmount,
      label: `€${amount.toLocaleString("en-US")} (~$${usdAmount.toLocaleString("en-US")})`,
    };
  }

  return null;
}

function parseArea(text) {
  const area = text.match(/([\d.]+)\s*sq\.m\./);
  return area ? Number(area[1]) : null;
}

function parseLandArea(text) {
  const land = text.match(/on a ([\d,]+)\s*sq\.m\. land/);
  return land ? Number(land[1].replace(/,/g, "")) : null;
}

function parseRooms(text) {
  const rooms = text.match(/(\d+)\s*room/);
  return rooms ? Number(rooms[1]) : null;
}

function parseFloor(text) {
  const floor = text.match(/(\d+)\/(\d+)\s*floor/);
  return floor ? { current: Number(floor[1]), total: Number(floor[2]), label: `${floor[1]}/${floor[2]}` } : null;
}

function parseLocation(text) {
  for (const location of LOCATIONS) {
    const escaped = location.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(text)) return location;
  }
  return "";
}

function cleanTitle(text, price) {
  let title = normalizeText(text);
  if (price?.currency === "USD") title = title.replace(/^\$[\d,]+\s*/, "");
  if (price?.currency === "AMD") title = title.replace(/^[\d,]+\s*֏\s*/, "");
  if (price?.currency === "EUR") title = title.replace(/^€[\d,]+\s*/, "");

  for (const badge of BADGES) {
    title = title.replace(new RegExp(`\\b${badge.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g"), "");
  }

  title = normalizeText(title);
  const location = parseLocation(title);
  if (location) {
    const locIndex = title.lastIndexOf(`${location},`);
    if (locIndex > 20) title = normalizeText(title.slice(0, locIndex));
  }
  return title;
}

function qualityScore(item) {
  let score = 5;
  const text = item.rawText.toLowerCase();

  if (item.floor?.current === 1) score += 2;
  else if (item.floor?.current === 2) score += 1.2;
  else if (item.rawText.includes("Elevator Available")) score += 0.8;
  else if (item.floor?.current >= 4 && !item.rawText.includes("Elevator Available")) score -= 2;

  if (text.includes("major renovation") || text.includes("designer")) score += 1.5;
  if (text.includes("partial renovation")) score += 0.3;
  if (text.includes("renovation none") || text.includes("renovation old") || text.includes("unfinished")) score -= 1.5;
  if (text.includes("individual heating") || text.includes("heating system") || text.includes("natural gas")) score += 0.8;
  if (text.includes("school") || text.includes("kindergarten") || text.includes("supermarket") || text.includes("shops")) score += 0.8;
  if (item.kind === "Дом" && text.includes("3 floors")) score -= 1.5;
  if (item.landSqm && item.kind === "Дом") score -= 0.4;

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

function parseItem(raw, config) {
  const text = normalizeText(raw.text);
  const price = parsePrice(text);
  if (!price || price.usd > config.maxPriceUsd) return null;
  if (config.minPriceUsd && price.usd < config.minPriceUsd) return null;

  const id = raw.href.match(/\/item\/(\d+)/)?.[1];
  if (!id) return null;

  const location = parseLocation(text);
  if (config.requireKnownLocation && !location) return null;
  if (location && !(location in MINUTES_TO_CENTER)) return null;

  const area = parseArea(text);
  const floor = parseFloor(text);
  const item = {
    id,
    kind: raw.kind,
    title: cleanTitle(text, price),
    url: raw.href.split("?")[0],
    priceLabel: price.label,
    priceUsd: price.usd,
    areaSqm: area,
    pricePerSqm: area ? Math.round(price.usd / area) : null,
    rooms: parseRooms(text),
    floor,
    landSqm: parseLandArea(text),
    location,
    minutesToCenter: location ? MINUTES_TO_CENTER[location] : null,
    rawText: text,
  };
  item.qualityScore = qualityScore(item);
  return item;
}

function stateDefault() {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: null,
    seenIds: [],
    subscribers: [],
    telegramUpdateOffset: 0,
    lastScan: null,
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return stateDefault();
  return { ...stateDefault(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function waitForListings(page, config) {
  const attempts = Math.ceil(config.pageWaitSeconds / 1.2);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(1200);
    const title = await page.title().catch(() => "");
    const text = await page.locator("body").innerText().catch(() => "");
    if (/Just a moment/i.test(title)) continue;
    if (PAGE_MARKERS.some((marker) => text.includes(marker))) return true;
  }
  return false;
}

async function scanListAm(config) {
  const profileDir = path.join(DATA_DIR, "listam-monitor-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    locale: "en-US",
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const rawItems = [];

  for (const category of config.categories) {
    for (let pageNo = 1; pageNo <= config.pagesPerCategory; pageNo += 1) {
      const pagePart = pageNo === 1 ? "" : `/${pageNo}`;
      const url = `https://www.list.am/en/category/${category.id}${pagePart}?price2=${config.maxPriceUsd}&crc=1`;
      console.log(`[scan] ${category.label} page ${pageNo}: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      const ok = await waitForListings(page, config);
      if (!ok) {
        const title = await page.title().catch(() => "unknown title");
        console.warn(`[scan] skipped page ${pageNo}: ${title}`);
        continue;
      }

      const pageItems = await page.$$eval("a[href*='/item/']", (links) =>
        links
          .map((a) => ({ href: a.href, text: a.innerText.replace(/\s+/g, " ").trim() }))
          .filter((item) => item.text && /(\$|֏|€)/.test(item.text))
      );
      rawItems.push(...pageItems.map((item) => ({ ...item, kind: category.label })));
      await sleep(config.delayBetweenPagesMs);
    }
  }

  await context.close();

  const seen = new Set();
  return rawItems
    .map((item) => parseItem(item, config))
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => b.qualityScore - a.qualityScore || a.priceUsd - b.priceUsd);
}

function listingLine(item) {
  const details = [
    item.location || "локация не распознана",
    item.areaSqm ? `${item.areaSqm} м²` : null,
    item.rooms ? `${item.rooms}к` : null,
    item.floor?.label ? `${item.floor.label} эт.` : null,
    item.pricePerSqm ? `$${item.pricePerSqm}/м²` : null,
    `качество ${item.qualityScore}/10`,
  ].filter(Boolean);

  return [
    `<b>${escapeHtml(item.kind)} · ${escapeHtml(item.priceLabel)}</b>`,
    `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`,
    escapeHtml(details.join(" · ")),
  ].join("\n");
}

function chunkMessages(items, config) {
  const messages = [];
  for (let index = 0; index < items.length; index += config.telegramBatchSize) {
    const batch = items.slice(index, index + config.telegramBatchSize);
    messages.push(`Новые объявления List.am (${batch.length}):\n\n${batch.map(listingLine).join("\n\n")}`);
  }
  return messages;
}

function subscriberIds(state, config) {
  const ids = new Set();
  for (const subscriber of state.subscribers || []) {
    if (subscriber.active !== false) ids.add(String(subscriber.id));
  }
  if (config.telegramChatId) ids.add(String(config.telegramChatId));
  return Array.from(ids);
}

async function sendTelegramMessage(config, chatId, text) {
  if (config.dryRun) {
    console.log(`[dry-run telegram -> ${chatId}]\n${text}\n`);
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

async function notifyTelegram(config, state, items) {
  const recipients = subscriberIds(state, config);
  if (recipients.length === 0) {
    console.log("[telegram] no subscribers yet. Send /start to the bot or set TELEGRAM_CHAT_ID.");
    return;
  }

  const messages = chunkMessages(items, config);
  for (const recipient of recipients) {
    for (const message of messages) {
      await sendTelegramMessage(config, recipient, message);
      await sleep(900);
    }
  }
}

async function telegramApi(config, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data.result;
}

function upsertSubscriber(state, chat, from) {
  const id = String(chat.id);
  const subscribers = state.subscribers || [];
  const existing = subscribers.find((subscriber) => String(subscriber.id) === id);
  const record = {
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
    Object.assign(existing, record);
    return existing;
  }

  record.createdAt = new Date().toISOString();
  subscribers.push(record);
  state.subscribers = subscribers;
  return record;
}

function deactivateSubscriber(state, chatId) {
  const id = String(chatId);
  const subscriber = (state.subscribers || []).find((item) => String(item.id) === id);
  if (!subscriber) return false;
  subscriber.active = false;
  subscriber.updatedAt = new Date().toISOString();
  return true;
}

async function syncTelegramSubscribers(config, state) {
  if (config.dryRun || !config.telegramToken) return;

  const updates = await telegramApi(config, "getUpdates", {
    offset: Number(state.telegramUpdateOffset || 0) + 1,
    timeout: 0,
    allowed_updates: ["message"],
  });

  for (const update of updates) {
    state.telegramUpdateOffset = Math.max(Number(state.telegramUpdateOffset || 0), update.update_id);
    const message = update.message;
    if (!message?.chat || !message.text) continue;

    const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    if (command === "/start" || command === "/subscribe") {
      upsertSubscriber(state, message.chat, message.from);
      await sendTelegramMessage(
        config,
        message.chat.id,
        "Подписка включена. Буду присылать новые объявления List.am до $120k.\n\nКоманды: /stop, /status, /help"
      );
    } else if (command === "/stop" || command === "/unsubscribe") {
      deactivateSubscriber(state, message.chat.id);
      await sendTelegramMessage(config, message.chat.id, "Подписка выключена. Вернуться можно командой /start.");
    } else if (command === "/status") {
      const activeCount = subscriberIds(state, config).length;
      const lastScan = state.lastScan
        ? `${state.lastScan.at}: найдено ${state.lastScan.scanned}, новых ${state.lastScan.new}`
        : "скана еще не было";
      await sendTelegramMessage(config, message.chat.id, `Монитор работает.\nПодписчиков: ${activeCount}\nПоследний скан: ${lastScan}`);
    } else if (command === "/help") {
      await sendTelegramMessage(
        config,
        message.chat.id,
        "Команды:\n/start - подписаться\n/stop - отписаться\n/status - статус монитора\n/help - помощь"
      );
    }
  }
}

function loadConfig() {
  loadEnvFile(ENV_FILE);
  const args = new Set(process.argv.slice(2));
  const categoryIds = String(process.env.LISTAM_CATEGORY_IDS || "60,62")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Boolean);

  const config = {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    maxPriceUsd: envNumber("MAX_PRICE_USD", 120000),
    minPriceUsd: envNumber("MIN_PRICE_USD", 0),
    pagesPerCategory: envNumber("LISTAM_PAGES_PER_CATEGORY", 2),
    pollIntervalMinutes: envNumber("POLL_INTERVAL_MINUTES", 20),
    telegramBatchSize: envNumber("TELEGRAM_BATCH_SIZE", 8),
    subscriberPollSeconds: envNumber("TELEGRAM_SUBSCRIBER_POLL_SECONDS", 30),
    navigationTimeoutMs: envNumber("NAVIGATION_TIMEOUT_MS", 45000),
    pageWaitSeconds: envNumber("LISTAM_PAGE_WAIT_SECONDS", envBool("LISTAM_SHOW_BROWSER", false) ? 180 : 35),
    delayBetweenPagesMs: envNumber("DELAY_BETWEEN_PAGES_MS", 2500),
    headless: !envBool("LISTAM_SHOW_BROWSER", false),
    dryRun: envBool("DRY_RUN", false) || args.has("--dry-run"),
    sendInitial: envBool("SEND_INITIAL", false),
    requireKnownLocation: !envBool("ALLOW_UNKNOWN_LOCATION", false),
    once: args.has("--once"),
    initOnly: args.has("--init"),
    testTelegram: args.has("--test-telegram"),
    categories: DEFAULT_CATEGORIES.filter((category) => categoryIds.includes(category.id)),
  };

  if (config.categories.length === 0) throw new Error("No categories selected. Use LISTAM_CATEGORY_IDS=60,62.");
  if (!config.dryRun && !config.initOnly && !config.telegramToken) {
    throw new Error("Set TELEGRAM_BOT_TOKEN in .env or environment.");
  }
  return config;
}

async function runScanCycle(config) {
  const state = readState();
  await syncTelegramSubscribers(config, state);
  const oldSeen = new Set(state.seenIds);
  const items = await scanListAm(config);
  const newItems = items.filter((item) => !oldSeen.has(item.id));
  const allSeen = new Set([...state.seenIds, ...items.map((item) => item.id)]);

  state.seenIds = Array.from(allSeen).slice(-20000);
  state.lastScan = {
    at: new Date().toISOString(),
    scanned: items.length,
    new: newItems.length,
  };
  writeState(state);

  console.log(`[scan] matched ${items.length}, new ${newItems.length}`);

  if (config.initOnly) {
    console.log(`[init] saved ${items.length} existing listings as already seen`);
    return;
  }

  if (newItems.length === 0) return;
  if (!config.sendInitial && oldSeen.size === 0) {
    console.log("[scan] first run: state initialized, not sending old listings. Set SEND_INITIAL=true to send them.");
    return;
  }

  await notifyTelegram(config, state, newItems);
}

async function waitForNextCycle(config) {
  const totalMs = config.pollIntervalMinutes * 60 * 1000;
  const stepMs = Math.min(config.subscriberPollSeconds * 1000, totalMs);
  const endAt = Date.now() + totalMs;

  while (Date.now() < endAt) {
    await sleep(Math.min(stepMs, endAt - Date.now()));
    if (!config.telegramToken || config.dryRun) continue;

    const state = readState();
    try {
      await syncTelegramSubscribers(config, state);
      writeState(state);
    } catch (error) {
      console.error(`[telegram-sync-error] ${error.message}`);
    }
  }
}

async function main() {
  const config = loadConfig();

  if (config.testTelegram) {
    const state = readState();
    await syncTelegramSubscribers(config, state);
    writeState(state);
    const recipients = subscriberIds(state, config);
    if (recipients.length === 0) {
      throw new Error("No Telegram subscribers. Send /start to the bot first or set TELEGRAM_CHAT_ID.");
    }
    for (const recipient of recipients) {
      await sendTelegramMessage(config, recipient, "Тест: монитор List.am подключен.");
    }
    return;
  }

  do {
    try {
      await runScanCycle(config);
    } catch (error) {
      console.error(`[error] ${error.stack || error.message}`);
      if (!config.dryRun && config.telegramToken) {
        const state = readState();
        for (const recipient of subscriberIds(state, config)) {
          await sendTelegramMessage(config, recipient, `Ошибка монитора List.am:\n${escapeHtml(error.message)}`).catch((sendError) =>
            console.error(`[telegram-error] ${sendError.message}`)
          );
        }
      }
    }

    if (config.once) break;
    console.log(`[wait] next scan in ${config.pollIntervalMinutes} min`);
    await waitForNextCycle(config);
  } while (true);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
