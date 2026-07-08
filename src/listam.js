const path = require("path");
const { chromium } = require("playwright");
const { clamp, normalizeText, sleep, unique } = require("./utils");

const AMD_PER_USD = 368.19;

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

const MONTH_INDEX = {
  jan: 0,
  january: 0,
  "янв": 0,
  "январь": 0,
  "января": 0,
  feb: 1,
  february: 1,
  "фев": 1,
  "февраль": 1,
  "февраля": 1,
  mar: 2,
  march: 2,
  "мар": 2,
  "март": 2,
  "марта": 2,
  apr: 3,
  april: 3,
  "апр": 3,
  "апрель": 3,
  "апреля": 3,
  may: 4,
  "май": 4,
  "мая": 4,
  jun: 5,
  june: 5,
  "июн": 5,
  "июнь": 5,
  "июня": 5,
  jul: 6,
  july: 6,
  "июл": 6,
  "июль": 6,
  "июля": 6,
  aug: 7,
  august: 7,
  "авг": 7,
  "август": 7,
  "августа": 7,
  sep: 8,
  sept: 8,
  september: 8,
  "сен": 8,
  "сент": 8,
  "сентябрь": 8,
  "сентября": 8,
  oct: 9,
  october: 9,
  "окт": 9,
  "октябрь": 9,
  "октября": 9,
  nov: 10,
  november: 10,
  "ноя": 10,
  "ноябрь": 10,
  "ноября": 10,
  dec: 11,
  december: 11,
  "дек": 11,
  "декабрь": 11,
  "декабря": 11,
};

const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|" +
  "sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|янв(?:арь|аря)?|" +
  "фев(?:раль|раля)?|мар(?:т|та)?|апр(?:ель|еля)?|ма[йя]|июн(?:ь|я)?|июл(?:ь|я)?|" +
  "авг(?:уст|уста)?|сен(?:т(?:ябрь|ября)?)?|окт(?:ябрь|ября)?|ноя(?:брь|бря)?|дек(?:абрь|абря)?";
const DAY_MONTH_PATTERN = new RegExp(
  `\\b(\\d{1,2})\\s+(${MONTH_PATTERN}),?\\s*(20\\d{2})?(?:[, ]+(\\d{1,2}):(\\d{2}))?\\b`,
  "i"
);
const MONTH_DAY_PATTERN = new RegExp(
  `\\b(${MONTH_PATTERN})\\s+(\\d{1,2}),?\\s*(20\\d{2})?(?:[, ]+(\\d{1,2}):(\\d{2}))?\\b`,
  "i"
);
const YEREVAN_OFFSET_MINUTES = 4 * 60;
const YEREVAN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Yerevan",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

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

function ymdInYerevan(date) {
  const parts = Object.fromEntries(YEREVAN_DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}

function shiftYmd({ year, month, day }, days) {
  const date = new Date(Date.UTC(year, month, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

function yerevanLocalDate(year, month, day, hour, minute) {
  const hasTime = hour !== undefined && minute !== undefined;
  const localHour = hasTime ? Number(hour) : 0;
  const localMinute = hasTime ? Number(minute) : 0;
  return {
    iso: new Date(Date.UTC(year, month, day, localHour, localMinute) - YEREVAN_OFFSET_MINUTES * 60000).toISOString(),
    precision: hasTime ? "datetime" : "date",
  };
}

function monthIndex(value) {
  return MONTH_INDEX[String(value || "").toLowerCase()];
}

function parsePublishedDate(text, now = new Date()) {
  const normalized = normalizeText(text);
  let match = normalized.match(/\b(today|yesterday|сегодня|вчера)(?:[, ]+(\d{1,2}):(\d{2}))?\b/i);
  if (match) {
    const ymd = shiftYmd(ymdInYerevan(now), /yesterday|вчера/i.test(match[1]) ? -1 : 0);
    return yerevanLocalDate(ymd.year, ymd.month, ymd.day, match[2], match[3]);
  }

  match = normalized.match(DAY_MONTH_PATTERN);
  if (match) {
    const month = monthIndex(match[2]);
    const year = Number(match[3] || ymdInYerevan(now).year);
    if (month !== undefined) return yerevanLocalDate(year, month, Number(match[1]), match[4], match[5]);
  }

  match = normalized.match(MONTH_DAY_PATTERN);
  if (match) {
    const month = monthIndex(match[1]);
    const year = Number(match[3] || ymdInYerevan(now).year);
    if (month !== undefined) return yerevanLocalDate(year, month, Number(match[2]), match[4], match[5]);
  }

  match = normalized.match(/\b(\d{1,2})[.-](\d{1,2})[.-](20\d{2})(?:[, ]+(\d{1,2}):(\d{2}))?\b/);
  if (match) return yerevanLocalDate(Number(match[3]), Number(match[2]) - 1, Number(match[1]), match[4], match[5]);

  return null;
}

function parsePublishedAt(text, now = new Date()) {
  return parsePublishedDate(text, now)?.iso || null;
}

function parseElevator(text) {
  if (/Elevator Available/i.test(text)) return true;
  if (/No Elevator|Elevator Not Available/i.test(text)) return false;
  return null;
}

function parseCondition(text) {
  const lower = text.toLowerCase();
  if (/renovation none|renovation old|unfinished|zero condition|needs renovation|no renovation/.test(lower)) return "needs_work";
  if (/partial renovation|cosmetic renovation/.test(lower)) return "partial";
  if (/major renovation|designer renovation|euro renovation|newly renovated|never occupied|renovated/.test(lower)) return "ready";
  return "unknown";
}

function parseLocation(text, config) {
  for (const location of config.defaultLocations) {
    const escaped = location.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(text)) return location;
  }
  return "";
}

function cleanTitle(text, price, config) {
  let title = normalizeText(text);
  if (price?.currency === "USD") title = title.replace(/^\$[\d,]+\s*/, "");
  if (price?.currency === "AMD") title = title.replace(/^[\d,]+\s*֏\s*/, "");
  if (price?.currency === "EUR") title = title.replace(/^€[\d,]+\s*/, "");

  for (const badge of BADGES) {
    title = title.replace(new RegExp(`\\b${badge.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "g"), "");
  }

  title = normalizeText(title);
  const location = parseLocation(title, config);
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
  else if (item.elevator === true) score += 0.8;
  else if (item.floor?.current >= 4 && item.elevator !== true) score -= 2;

  if (item.condition === "ready") score += 1.5;
  if (item.condition === "partial") score += 0.4;
  if (item.condition === "needs_work") score -= 1.5;
  if (text.includes("individual heating") || text.includes("heating system") || text.includes("natural gas")) score += 0.8;
  if (text.includes("school") || text.includes("kindergarten") || text.includes("supermarket") || text.includes("shops")) score += 0.8;
  if (item.kindKey === "house" && (text.includes("3 floors") || text.includes("three story"))) score -= 1.5;
  if (item.landSqm && item.kindKey === "house") score -= 0.4;
  if (item.pricePerSqm && item.pricePerSqm < 1200) score += 0.5;
  if (item.location === "Abovyan" && item.kindKey === "house") score -= 0.4;

  return clamp(Math.round(score * 10) / 10, 0, 10);
}

function parseItem(raw, category, config) {
  const text = normalizeText(raw.text);
  const price = parsePrice(text);
  if (!price || price.usd > config.maxPriceUsd || price.usd < config.minPriceUsd) return null;

  const id = raw.href.match(/\/item\/(\d+)/)?.[1];
  if (!id) return null;

  const location = parseLocation(text, config);
  if (config.requireKnownLocation && !location) return null;
  if (location && !(location in config.minutesToCenter)) return null;

  const area = parseArea(text);
  const published = parsePublishedDate(text);
  const item = {
    id,
    source: "listam",
    sourceLabel: "List.am",
    kind: category.label,
    kindKey: category.key,
    title: cleanTitle(text, price, config),
    url: `https://www.list.am/item/${id}`,
    imageUrl: /^https?:\/\//i.test(String(raw.imageUrl || "")) ? String(raw.imageUrl).replace(/^http:/i, "https:") : null,
    priceLabel: price.label,
    priceUsd: price.usd,
    areaSqm: area,
    pricePerSqm: area ? Math.round(price.usd / area) : null,
    rooms: parseRooms(text),
    floor: parseFloor(text),
    landSqm: parseLandArea(text),
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator: parseElevator(text),
    condition: parseCondition(text),
    publishedAt: published?.iso || null,
    publishedAtPrecision: published?.precision || null,
    rawText: text,
    scannedAt: new Date().toISOString(),
  };
  item.qualityScore = qualityScore(item);
  return item;
}

async function waitForListings(page, config) {
  const attempts = Math.ceil(config.scanPageWaitSeconds / 1.2);
  let firstChallengeAt = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(1200);
    const title = await page.title().catch(() => "");
    const text = await page.locator("body").innerText().catch(() => "");
    const looksLikeChallenge = /Just a moment/i.test(title) || /checking your browser|verify you are human|cloudflare/i.test(text);
    if (looksLikeChallenge) {
      firstChallengeAt ||= Date.now();
      if (Date.now() - firstChallengeAt >= config.challengeWaitSeconds * 1000) return false;
      continue;
    }
    if (PAGE_MARKERS.some((marker) => text.includes(marker))) return true;
    const itemLinks = await page.locator("a[href*='/item/']").count().catch(() => 0);
    if (itemLinks > 0 && /(\$|֏|€)/.test(text)) return true;
  }
  return false;
}

async function extractPageItems(page) {
  return page.$$eval("a[href*='/item/']", (links) =>
    links
      .map((a) => {
        const img = a.querySelector("img");
        const imageUrl = (img && (img.currentSrc || img.src || img.getAttribute("data-src") || img.getAttribute("data-original"))) || "";
        return { href: a.href, text: a.innerText.replace(/\s+/g, " ").trim(), imageUrl };
      })
      .filter((item) => item.text && /(\$|֏|€)/.test(item.text))
  );
}

async function scanListAm(config, logger = console) {
  const profileDir = path.join(config.dataDir, "listam-browser-profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    locale: "en-US",
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  });

  const listings = [];
  const skipped = [];

  try {
    const page = await context.newPage();

    for (const category of config.categories) {
      for (let pageNo = 1; pageNo <= config.scanPagesPerCategory; pageNo += 1) {
        const pagePart = pageNo === 1 ? "" : `/${pageNo}`;
        const url = `https://www.list.am/en/category/${category.id}${pagePart}?price2=${config.maxPriceUsd}&crc=1`;
        logger.log(`[scan] ${category.label} page ${pageNo}`);

        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
          const ok = await waitForListings(page, config);
          if (!ok) {
            const title = await page.title().catch(() => "unknown title");
            skipped.push({ category: category.key, pageNo, title });
            logger.warn(`[scan] skipped ${category.label} page ${pageNo}: ${title}`);
            continue;
          }

          const rawItems = await extractPageItems(page);
          for (const raw of rawItems) {
            const item = parseItem(raw, category, config);
            if (item) listings.push(item);
          }
        } catch (error) {
          skipped.push({ category: category.key, pageNo, error: error.message });
          logger.warn(`[scan] error ${category.label} page ${pageNo}: ${error.message}`);
        }

        await sleep(config.delayBetweenPagesMs);
      }
    }
  } finally {
    await context.close().catch((error) => logger.warn(`[scan] browser close failed: ${error.message}`));
  }

  const seen = new Set();
  const uniqueListings = listings.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  uniqueListings.sort((a, b) => b.qualityScore - a.qualityScore || a.priceUsd - b.priceUsd);

  return {
    listings: uniqueListings,
    skipped,
    scannedAt: new Date().toISOString(),
    locations: unique(uniqueListings.map((item) => item.location)),
  };
}

module.exports = {
  parseListAmItem: parseItem,
  scanListAm,
  __test: {
    parseItem,
    parsePublishedDate,
    parsePublishedAt,
    parsePrice,
    parseLocation,
    qualityScore,
  },
};
