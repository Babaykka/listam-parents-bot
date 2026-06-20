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
  const item = {
    id,
    kind: category.label,
    kindKey: category.key,
    title: cleanTitle(text, price, config),
    url: raw.href.split("?")[0].replace("/item/", "/en/item/"),
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
      .map((a) => ({ href: a.href, text: a.innerText.replace(/\s+/g, " ").trim() }))
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
  scanListAm,
  __test: {
    parseItem,
    parsePrice,
    parseLocation,
    qualityScore,
  },
};
