const { clamp, normalizeText, unique } = require("./utils");

const YEREVAN_OFFSET_MINUTES = 4 * 60;
const BASE_URL = "https://myrealty.am";

const CATEGORY_URLS = {
  apartment: "https://myrealty.am/en/for-sale/apartments",
  house: "https://myrealty.am/en/for-sale/houses",
};

const LOCATION_ALIASES = [
  ["Center", "Kentron"],
  ["Centre", "Kentron"],
  ["Kentron", "Kentron"],
  ["Kanaqer-Zeytun", "Kanaker-Zeytun"],
  ["Kanaker-Zeytun", "Kanaker-Zeytun"],
  ["Norq-Marash", "Nork-Marash"],
  ["Nork-Marash", "Nork-Marash"],
  ["Nor Nork", "Nor Nork"],
  ["Malatia-Sebastia", "Malatia-Sebastia"],
];

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return normalizeText(decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")));
}

function parseNumber(value) {
  const number = Number(String(value || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePublishedDate(value) {
  const match = String(value || "").match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)) - YEREVAN_OFFSET_MINUTES * 60000).toISOString();
}

function parseLocation(address, config) {
  const normalized = normalizeText(address);
  for (const [needle, location] of LOCATION_ALIASES) {
    if (new RegExp(`\\b${needle.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(normalized)) return location;
  }
  for (const location of config.defaultLocations) {
    const escaped = location.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(normalized)) return location;
  }
  return "";
}

function parseCondition(text) {
  const lower = String(text || "").toLowerCase();
  if (/newly renovated|renovated|new construction|newly constructed|designer/.test(lower)) return "ready";
  if (/needs renovation|old renovation|unfinished/.test(lower)) return "needs_work";
  return "unknown";
}

function parseFloor(value) {
  const text = normalizeText(value);
  const split = text.match(/^(\d+)\/(\d+)$/);
  if (split) return { current: Number(split[1]), total: Number(split[2]), label: text };
  const single = text.match(/^(\d+)$/);
  return single ? { current: Number(single[1]), total: null, label: text } : null;
}

function qualityScore(item) {
  let score = 5;
  const text = item.rawText.toLowerCase();
  if (item.floor?.current === 1) score += 1.4;
  else if (item.floor?.current === 2) score += 0.8;
  else if (item.floor?.current >= 5 && item.kindKey === "apartment") score -= 0.7;
  if (item.condition === "ready") score += 1;
  if (item.condition === "needs_work") score -= 1.2;
  if (/heating|gas|garage|balcony|terrace|yard/.test(text)) score += 0.5;
  if (item.pricePerSqm && item.pricePerSqm < 1400) score += 0.4;
  return clamp(Math.round(score * 10) / 10, 0, 10);
}

function cardBlocks(html) {
  const blocks = [];
  const regex = /<figcaption class="figure-caption d-flex flex-column">([\s\S]*?)<\/figcaption>/g;
  let match;
  while ((match = regex.exec(html))) {
    const before = html.slice(Math.max(0, match.index - 5000), match.index);
    const hrefMatch = before.match(/<a href="([^"]+\/(\d+))"[^>]*class="image"/);
    if (!hrefMatch) continue;
    blocks.push({ href: hrefMatch[1], idFromHref: hrefMatch[2], html: match[1] });
  }
  return blocks;
}

function paginationPageUrls(html) {
  const links = new Map();
  const regex = /href="([^"]*\?page=(\d+)[^"]*)"/g;
  let match;
  while ((match = regex.exec(html))) {
    const pageNo = Number(match[2]);
    const href = decodeHtml(match[1]);
    if (Number.isFinite(pageNo) && pageNo > 1 && !links.has(pageNo)) {
      links.set(pageNo, href.startsWith("http") ? href : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`);
    }
  }
  return links;
}

function parseCard(card, config) {
  const html = card.html;
  const id = html.match(/ID\s*(\d+)/)?.[1] || card.idFromHref;
  const kindText = stripHtml(html.match(/item-property-type[\s\S]*?<\/i>\s*([^<]+)/)?.[1] || "");
  const kindKey = /house/i.test(kindText) ? "house" : /apartment/i.test(kindText) ? "apartment" : null;
  if (!id || !kindKey) return null;
  if (!config.categories.some((category) => category.key === kindKey)) return null;
  if (!/FOR SALE/i.test(stripHtml(html.match(/item-type show-on-list[\s\S]*?<span>([^<]+)/)?.[1] || ""))) return null;

  const priceUsd = parseNumber(html.match(/item-price[^>]*>[\s\S]*?([\d,]+)/)?.[1]);
  if (!priceUsd || priceUsd > config.maxPriceUsd || priceUsd < config.minPriceUsd) return null;

  const address = stripHtml(html.match(/item-address[^>]*>[\s\S]*?<\/i>\s*([^<]+)/)?.[1] || "");
  const location = parseLocation(address, config);
  if (config.requireKnownLocation && !location) return null;
  if (location && !(location in config.minutesToCenter)) return null;

  const addedText = html.match(/<label>Added in<\/label>[\s\S]*?(\d{2}\.\d{2}\.20\d{2})/)?.[1] || "";
  const areaSqm = parseNumber(html.match(/item-sqm[\s\S]*?<span>([^<]+)/)?.[1]);
  const rooms = parseNumber(html.match(/item-rooms[\s\S]*?<span>([^<]+)/)?.[1]);
  const floor = parseFloor(html.match(/item-floor[\s\S]*?<span>([^<]+)/)?.[1] || "");
  const description = stripHtml(html.match(/item-short-text-info[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
  const rawText = normalizeText([address, description, kindText, `${areaSqm || ""} SQ. M.`, `${rooms || ""} Room`, floor?.label || ""].join(" "));
  const kind = kindKey === "house" ? "Дом" : "Квартира";
  const item = {
    id: `myrealty:${id}`,
    source: "myrealty",
    sourceLabel: "MyRealty",
    kind,
    kindKey,
    title: normalizeText(`${rooms ? `${rooms} room ` : ""}${kindKey === "house" ? "house" : "apartment"}${areaSqm ? `, ${areaSqm} sq.m.` : ""} · ${address}`),
    url: card.href.startsWith("http") ? card.href : `${BASE_URL}${card.href}`,
    priceLabel: `$${priceUsd.toLocaleString("en-US")}`,
    priceUsd,
    areaSqm,
    pricePerSqm: areaSqm ? Math.round(priceUsd / areaSqm) : null,
    rooms,
    floor,
    landSqm: null,
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator: null,
    condition: parseCondition(description),
    publishedAt: parsePublishedDate(addedText),
    publishedAtPrecision: addedText ? "date" : null,
    rawText,
    scannedAt: new Date().toISOString(),
  };
  item.qualityScore = qualityScore(item);
  return item;
}

async function fetchText(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.navigationTimeoutMs || 75000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function scanMyRealty(config, logger = console) {
  const listings = [];
  const skipped = [];
  const pages = Math.max(1, Number(config.myrealtyPagesPerCategory || 2));

  for (const category of config.categories) {
    const baseUrl = CATEGORY_URLS[category.key];
    if (!baseUrl) continue;
    let pageUrls = new Map();
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      const url = pageNo === 1 ? baseUrl : pageUrls.get(pageNo) || `${baseUrl}?page=${pageNo}`;
      logger.log(`[myrealty] ${category.label} page ${pageNo}`);
      try {
        const html = await fetchText(url, config);
        if (pageNo === 1) pageUrls = paginationPageUrls(html);
        const cards = cardBlocks(html);
        if (cards.length === 0) skipped.push({ source: "myrealty", category: category.key, pageNo, title: "no cards" });
        for (const card of cards) {
          const item = parseCard(card, config);
          if (item) listings.push(item);
        }
      } catch (error) {
        skipped.push({ source: "myrealty", category: category.key, pageNo, error: error.message });
        logger.warn(`[myrealty] error ${category.label} page ${pageNo}: ${error.message}`);
      }
    }
  }

  const seen = new Set();
  const uniqueListings = listings.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  uniqueListings.sort((a, b) => String(b.publishedAt || b.scannedAt).localeCompare(String(a.publishedAt || a.scannedAt)));

  return {
    listings: uniqueListings,
    skipped,
    scannedAt: new Date().toISOString(),
    locations: unique(uniqueListings.map((item) => item.location)),
  };
}

module.exports = {
  scanMyRealty,
  __test: {
    cardBlocks,
    paginationPageUrls,
    parseCard,
    parseLocation,
    parsePublishedDate,
  },
};
