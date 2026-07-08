const crypto = require("crypto");
const { clamp, normalizeText, unique } = require("./utils");
const { compareListingActivity } = require("./listingFreshness");

const BASE_URL = "https://www.estate.am";

const DEFAULT_FEEDS = {
  apartment: [
    "https://www.estate.am/en/apartments-for-sale-in-yerevan-s12.rss",
    "https://www.estate.am/en/apartments-for-sale-s407147.rss",
  ],
  house: [
    "https://www.estate.am/en/houses-and-villas-for-sale-in-yerevan-s687.rss",
    "https://www.estate.am/en/houses-and-villas-for-sale-s408385.rss",
  ],
};

const LOCATION_ALIASES = [
  ["Downtown", "Kentron"],
  ["Small Center", "Kentron"],
  ["Pokr Kentron", "Kentron"],
  ["Mets Kentron", "Kentron"],
  ["Center", "Kentron"],
  ["Centre", "Kentron"],
  ["Kentron", "Kentron"],
  ["Erebouni", "Erebuni"],
  ["Erebuni", "Erebuni"],
  ["Kanaqer-Zeytun", "Kanaker-Zeytun"],
  ["Kanaker-Zeytun", "Kanaker-Zeytun"],
  ["Kanaker Zeitoun", "Kanaker-Zeytun"],
  ["Kanaker-Zeitoun", "Kanaker-Zeytun"],
  ["Norq-Marash", "Nork-Marash"],
  ["Nork Marash", "Nork-Marash"],
  ["Nork-Marash", "Nork-Marash"],
  ["Nor-Nork", "Nor Nork"],
  ["Nor Nork", "Nor Nork"],
  ["Malatia Sebastia", "Malatia-Sebastia"],
  ["Malatia-Sebastia", "Malatia-Sebastia"],
];

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "");
}

function stripHtml(value) {
  return normalizeText(decodeHtml(unCdata(String(value || "")).replace(/<[^>]+>/g, " ")));
}

function tagText(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1]) : "";
}

function entryBlocks(xml) {
  const entries = [];
  const regex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = regex.exec(xml))) entries.push(match[1]);
  return entries;
}

function alternateLink(block) {
  const match = String(block || "").match(/<link\b(?=[^>]*rel=["']alternate["'])[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return match ? decodeHtml(match[1]) : "";
}

function absoluteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  return `${BASE_URL}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function parseNumber(value) {
  const normalized = String(value || "").replace(/\s+/g, "").replace(/,/g, "");
  const number = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parsePriceFromText(text, config) {
  const value = String(text || "");
  const usdMatch = value.match(/(\d[\d,\s.]*)\s*(?:\$|USD)/i);
  if (usdMatch) {
    const amount = parseNumber(usdMatch[1]);
    if (amount) return { priceUsd: amount, priceLabel: `$${amount.toLocaleString("en-US")}` };
  }

  const amdMatch = value.match(/(\d[\d,\s.]*)\s*(?:\u058F|AMD|\u0534)/i);
  if (amdMatch) {
    const amount = parseNumber(amdMatch[1]);
    const amdPerUsd = Number(config.amdPerUsd || 390);
    if (amount && amdPerUsd > 0) {
      const priceUsd = Math.round(amount / amdPerUsd);
      return {
        priceUsd,
        priceLabel: `${amount.toLocaleString("en-US")} AMD (~$${priceUsd.toLocaleString("en-US")})`,
      };
    }
  }

  return null;
}

function parsePrice(title, summary, config) {
  return parsePriceFromText(title, config) || parsePriceFromText(summary, config);
}

function parseAreaSqm(text) {
  const match = String(text || "").match(/\b(\d+(?:[.,]\d+)?)\s*(?:m2|m²|sq\.?\s*m\.?|sqm|square meters?)\b/i);
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function parseLandSqm(text) {
  const value = String(text || "");
  const match =
    value.match(/\b(?:land(?:\s+plot)?|lot|yard|garden)\s*(?:area\s*)?(?:of\s*)?(\d+(?:[.,]\d+)?)\s*(?:m2|m²|sq\.?\s*m\.?|sqm|square meters?)\b/i) ||
    value.match(/\b(\d+(?:[.,]\d+)?)\s*(?:m2|m²|sq\.?\s*m\.?|sqm|square meters?)\s*(?:land|lot|yard|garden)\b/i);
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function parseRooms(text) {
  const match = String(text || "").match(/\b(\d+)\s*(?:room|rooms)\b/i);
  return match ? Number(match[1]) : null;
}

function parseFloor(text) {
  const match = String(text || "").match(/\bfloor\s*(\d+)\/(\d+)\b/i);
  if (!match) return null;
  return { current: Number(match[1]), total: Number(match[2]), label: `${match[1]}/${match[2]}` };
}

function parsePublishedDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function escapedRegex(value) {
  return String(value || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function parseLocation(text, config) {
  const normalized = normalizeText(text);
  for (const [needle, location] of LOCATION_ALIASES) {
    if (new RegExp(`\\b${escapedRegex(needle)}\\b`, "i").test(normalized)) return location;
  }
  for (const location of config.defaultLocations) {
    if (new RegExp(`\\b${escapedRegex(location)}\\b`, "i").test(normalized)) return location;
  }
  return "";
}

function parseCondition(text) {
  const lower = String(text || "").toLowerCase();
  if (/zero condition|shell condition|unfinished|ground condition|needs renovation|requires renovation/.test(lower)) return "needs_work";
  if (/partly renovated|partially renovated|old(?:er)? renovation|substantial renovation/.test(lower)) return "partial";
  if (/newly renovated|fully renovated|completely renovated|renovated|newly constructed|euro(?:pean)? standards|designer/.test(lower)) return "ready";
  return "unknown";
}

function parseElevator(text) {
  const lower = String(text || "").toLowerCase();
  if (/\belevator\b|building is equipped with an elevator|serviced by an elevator/.test(lower)) return true;
  return null;
}

function kindFromTitle(title) {
  if (/\b(apartment|flat)\b/i.test(title)) return "apartment";
  if (/\b(house|townhouse|mansion|villa)\b/i.test(title)) return "house";
  return null;
}

function qualityScore(item) {
  let score = 5;
  if (item.floor?.current === 1) score += 1;
  else if (item.floor?.current === 2) score += 0.6;
  else if (item.floor?.current >= 5 && item.kindKey === "apartment") score -= 0.5;
  if (item.condition === "ready") score += 0.9;
  if (item.condition === "partial") score += 0.2;
  if (item.condition === "needs_work") score -= 1;
  if (item.elevator === true) score += 0.3;
  if (item.pricePerSqm && item.pricePerSqm < 1400) score += 0.4;
  return clamp(Math.round(score * 10) / 10, 0, 10);
}

function stableId(link, feedId) {
  const raw = link || feedId || "";
  const numeric = raw.match(/-d(\d+)(?:\D|$)/i)?.[1];
  if (numeric) return `estate:${numeric}`;
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
  return `estate:${hash}`;
}

function parseEntry(entry, config) {
  const feedId = tagText(entry, "id");
  const title = tagText(entry, "title");
  const summary = tagText(entry, "summary");
  const content = tagText(entry, "content");
  const updatedRaw = tagText(entry, "updated");
  const url = absoluteUrl(alternateLink(entry) || feedId);
  const kindKey = kindFromTitle(title);
  if (!url || !kindKey) return null;
  if (!config.categories.some((category) => category.key === kindKey)) return null;

  const price = parsePrice(title, summary, config);
  if (!price || !price.priceUsd || price.priceUsd > config.maxPriceUsd || price.priceUsd < config.minPriceUsd) return null;

  const location = parseLocation(`${title} ${summary}`, config);
  if (config.requireKnownLocation && !location) return null;
  if (location && !(location in config.minutesToCenter)) return null;

  const areaSqm = parseAreaSqm(summary) || parseAreaSqm(content);
  const rooms = parseRooms(title) || parseRooms(summary) || parseRooms(content);
  const floor = kindKey === "apartment" ? parseFloor(summary) || parseFloor(content) : null;
  const landSqm = kindKey === "house" ? parseLandSqm(content) : null;
  const condition = parseCondition(content || summary);
  const elevator = kindKey === "apartment" ? parseElevator(content) : null;
  const kind = kindKey === "house" ? "Дом" : "Квартира";
  const item = {
    id: stableId(url, feedId),
    source: "estate",
    sourceLabel: "Estate.am",
    kind,
    kindKey,
    title: normalizeText(title || summary),
    url,
    priceLabel: price.priceLabel,
    priceUsd: price.priceUsd,
    areaSqm,
    pricePerSqm: areaSqm ? Math.round(price.priceUsd / areaSqm) : null,
    rooms,
    floor,
    landSqm,
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator,
    condition,
    publishedAt: null,
    publishedAtPrecision: null,
    updatedAt: parsePublishedDate(updatedRaw),
    updatedAtPrecision: updatedRaw ? "datetime" : null,
    rawText: normalizeText(
      [
        title,
        summary,
        condition !== "unknown" ? condition : "",
        elevator === true ? "elevator" : "",
        landSqm ? `land ${landSqm} m2` : "",
      ].join(" ")
    ),
    scannedAt: new Date().toISOString(),
  };
  item.qualityScore = qualityScore(item);
  return item;
}

async function fetchTextOnce(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.navigationTimeoutMs || 75000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.8",
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

function alternateHostUrl(url) {
  if (/:\/\/www\./i.test(url)) return url.replace(/:\/\/www\./i, "://");
  return url.replace(/:\/\//, "://www.");
}

async function fetchText(url, config) {
  try {
    return await fetchTextOnce(url, config);
  } catch (error) {
    if (!/HTTP 403/.test(error.message)) throw error;
    return fetchTextOnce(alternateHostUrl(url), config);
  }
}

function feedUrls(config) {
  const configured = Array.isArray(config.estateFeedUrls) ? config.estateFeedUrls.filter(Boolean) : [];
  if (configured.length > 0) return configured;
  return config.categories.flatMap((category) => DEFAULT_FEEDS[category.key] || []);
}

async function scanEstate(config, logger = console) {
  const listings = [];
  const skipped = [];

  for (const url of feedUrls(config)) {
    logger.log(`[estate] feed ${url}`);
    try {
      const xml = await fetchText(url, config);
      const entries = entryBlocks(xml);
      if (entries.length === 0) skipped.push({ source: "estate", url, title: "no entries" });
      for (const entry of entries) {
        const item = parseEntry(entry, config);
        if (item) listings.push(item);
      }
    } catch (error) {
      skipped.push({ source: "estate", url, error: error.message });
      logger.warn(`[estate] error ${url}: ${error.message}`);
    }
  }

  const seen = new Set();
  const uniqueListings = listings.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  uniqueListings.sort(compareListingActivity);

  return {
    listings: uniqueListings,
    skipped,
    scannedAt: new Date().toISOString(),
    locations: unique(uniqueListings.map((item) => item.location)),
  };
}

module.exports = {
  scanEstate,
  __test: {
    alternateHostUrl,
    entryBlocks,
    feedUrls,
    parseEntry,
    parseLocation,
    parsePrice,
    parsePublishedDate,
  },
};
