const { compareListingActivity } = require("./listingFreshness");
const { parseListAmItem } = require("./listam");
const { normalizeText, unique } = require("./utils");

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

function absoluteListAmUrl(value, id = "") {
  const raw = String(value || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, "https://");
  if (raw.startsWith("/")) return `https://www.list.am${raw}`;
  if (id) return `https://www.list.am/item/${encodeURIComponent(id)}`;
  return "";
}

function xmlBlocks(xml) {
  const blocks = [];
  for (const tag of ["item", "entry"]) {
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let match;
    while ((match = regex.exec(xml))) blocks.push(match[1]);
  }
  return blocks;
}

function linkFromXmlBlock(block) {
  const linkTag = tagText(block, "link");
  if (linkTag) return linkTag;
  const alternate = String(block || "").match(/<link\b(?=[^>]*rel=["']alternate["'])[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return alternate ? decodeHtml(alternate[1]) : "";
}

function rawItemsFromXml(xml) {
  return xmlBlocks(xml).map((block) => {
    const title = tagText(block, "title");
    const description = tagText(block, "description") || tagText(block, "summary") || tagText(block, "content");
    const pubDate = tagText(block, "pubDate") || tagText(block, "published") || tagText(block, "updated");
    const guid = tagText(block, "guid") || tagText(block, "id");
    const href = absoluteListAmUrl(linkFromXmlBlock(block) || guid);
    return {
      href,
      text: normalizeText([title, description, pubDate].filter(Boolean).join(" ")),
    };
  });
}

function collectJsonRecords(value, records = []) {
  if (!value || typeof value !== "object") return records;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonRecords(item, records);
    return records;
  }

  const hasListingShape =
    value.url ||
    value.href ||
    value.link ||
    value.id ||
    value.itemId ||
    value.title ||
    value.price ||
    value.description;
  if (hasListingShape) records.push(value);

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") collectJsonRecords(item, records);
  }
  return records;
}

function rawItemFromRecord(record) {
  const id = record.id || record.itemId || record.listingId || record.listamId || "";
  const href = absoluteListAmUrl(record.url || record.href || record.link || "", id);
  const price =
    record.priceLabel ||
    record.priceUsd ||
    record.priceUSD ||
    record.price ||
    (record.price_amd ? `${record.price_amd} ֏` : "");
  const area = record.areaSqm || record.area || record.squareMeters || record.sqm;
  const rooms = record.rooms || record.roomCount;
  const floor = record.floorLabel || record.floor;
  const location = record.location || record.district || record.address;
  const published = record.publishedAt || record.published || record.pubDate || record.createdAt || record.updatedAt || "";
  return {
    href,
    text: normalizeText(
      [
        price,
        record.title,
        record.description,
        area ? `${area} sq.m.` : "",
        rooms ? `${rooms} room` : "",
        floor ? `${floor} floor` : "",
        location,
        published,
      ]
        .filter(Boolean)
        .join(" ")
    ),
  };
}

function rawItemsFromJson(text) {
  const data = JSON.parse(text);
  return collectJsonRecords(data).map(rawItemFromRecord);
}

function parseRawItem(raw, config) {
  const categories = [];
  const lower = raw.text.toLowerCase();
  const house = /\b(house|home|villa|townhouse|առանձնատուն|дом|коттедж)\b/i.test(lower);
  const apartment = /\b(apartment|flat|квартир|բնակարան)\b/i.test(lower);
  if (house) categories.push(config.categories.find((category) => category.key === "house"));
  if (apartment) categories.push(config.categories.find((category) => category.key === "apartment"));
  if (categories.length === 0) categories.push(...config.categories);

  for (const category of categories.filter(Boolean)) {
    const item = parseListAmItem(raw, category, config);
    if (item) return item;
  }
  return null;
}

function parseFeedText(text, config) {
  const trimmed = String(text || "").trim();
  const rawItems = /^[\[{]/.test(trimmed) ? rawItemsFromJson(trimmed) : rawItemsFromXml(trimmed);
  const listings = [];
  for (const raw of rawItems) {
    const item = parseRawItem(raw, config);
    if (item) listings.push(item);
  }
  return listings;
}

async function fetchText(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.navigationTimeoutMs || 75000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json, application/rss+xml, application/atom+xml, text/xml, */*",
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

async function scanListAmFeed(config, logger = console) {
  const listings = [];
  const skipped = [];
  const urls = config.listamFeedUrls || [];
  if (urls.length === 0) {
    return { listings, skipped, scannedAt: new Date().toISOString(), locations: [] };
  }

  for (const url of urls) {
    logger.log(`[listam-feed] ${url}`);
    try {
      const text = await fetchText(url, config);
      const parsed = parseFeedText(text, config);
      if (parsed.length === 0) skipped.push({ source: "listam_feed", url, title: "no matching listings" });
      listings.push(...parsed);
    } catch (error) {
      skipped.push({ source: "listam_feed", url, error: error.message });
      logger.warn(`[listam-feed] error ${url}: ${error.message}`);
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
  scanListAmFeed,
  __test: {
    parseFeedText,
    rawItemsFromJson,
    rawItemsFromXml,
  },
};
