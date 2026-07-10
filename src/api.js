const { compareListingActivity, daysSince } = require("./listingFreshness");
const { priceDropPercent, visibleListings } = require("./listingStore");
const { mergedSourceEntries } = require("./sourceHealth");
const { isGmailConfigured } = require("./gmail");
const { localizeDescription } = require("./localize");
const { unique } = require("./utils");

const MAX_API_LIMIT = 500;
const DEFAULT_API_LIMIT = 100;

// A short, human-ish blurb derived from the listing text — with phones, emails,
// URLs and PII stripped, plus scraper noise (slug paths, snake_case codes,
// "N sqm/rooms/floor" already shown on the card) removed, then truncated.
function shortDescription(item) {
  // Sources emit English blurbs; render them as a short Russian description.
  const localized = localizeDescription(String(item.description || item.rawText || ""));
  if (localized) return localized;

  let text = String(item.description || item.rawText || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, " ")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, " ")
    .replace(/\bProperty Not Verified\b/gi, " ") // MyRealty status noise
    .replace(/\S*\/\S*/g, " ") // slug paths like sell/apartment/3-rooms/-B48230
    .replace(/\b\w+_\w[\w_]*\b/g, " ") // snake_case codes like heating_gas_boiler
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:sq\.?\s*m\.?|sqm|m²|м²|rooms?|room|rm\.?|комн\.?|эт\.?|floor)\b/gi, " ")
    .replace(/\b(?:rooms?|rm|floor|эт|комн)\.?\b/gi, " ") // leftover lone unit words
    .replace(/\s*[.,·]\s*(?=[.,·])/g, "") // collapse repeated punctuation
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // Drop a leading price token ("$95,000" / "46,800,000 AMD") — the card already shows price.
  text = text.replace(/^[$֏€]?\s*[\d,.\s]+\s*(?:AMD|USD|Դ|\$|€|֏)?\s*[·,-]?\s*/i, "").trim();
  // Collapse immediate duplicate words (a district often repeats in scraped text).
  text = text.replace(/\b([^\s,]+)(\s+\1\b)+/gi, "$1").trim();
  text = text.replace(/^[\s,·-]+/, "").trim();
  // Trim dangling conjunctions/commas left after removing a phone/email/url.
  text = text.replace(/(?:[\s,·-]+(?:call|or|and|или|и|звони(?:те)?)\b)+[\s,·-]*$/i, "").replace(/[\s,·-]+$/, "").trim();
  if (text.length < 12) return null;
  if (text.length <= 140) return text;
  const cut = text.slice(0, 140);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// Only fields a public catalog needs; never subscriber data or raw scrape text.
function publicListingView(item) {
  return {
    id: item.id,
    kind: item.kind,
    kindKey: item.kindKey,
    priceUsd: item.priceUsd,
    priceLabel: item.priceLabel,
    pricePerSqm: item.pricePerSqm ?? null,
    areaSqm: item.areaSqm ?? null,
    rooms: item.rooms ?? null,
    floorLabel: item.floor?.label || null,
    landSqm: item.landSqm ?? null,
    location: item.location || null,
    minutesToCenter: item.minutesToCenter ?? null,
    imageUrl: item.imageUrl || null,
    condition: item.condition || "unknown",
    elevator: item.elevator ?? null,
    publishedAt: item.publishedAt || null,
    updatedAt: item.updatedAt || null,
    changeDetectedAt: item.changeDetectedAt || null,
    discoveredAt: item.discoveredAt || null,
    url: item.url,
    description: shortDescription(item),
    sourceLabel: item.sourceLabel || (/list\.am/i.test(String(item.url || "")) ? "List.am" : ""),
    alsoSources: (item.alsoSources || []).map((entry) => entry.label),
    whyGood: item.whyGood || [],
    valueScore: item.valueScore ?? null,
    priceDropPercent: priceDropPercent(item),
    contactName: item.contactName || null,
    contactPhone: item.contactPhone || null,
  };
}

function numberParam(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function applyQueryFilters(listings, query = {}) {
  let result = listings;
  if (query.kind === "apartment" || query.kind === "house") {
    result = result.filter((item) => item.kindKey === query.kind);
  }
  if (query.location) {
    const location = String(query.location);
    result = result.filter((item) => item.location === location);
  }
  const minPrice = numberParam(query.minPrice, 0, 100000000);
  if (minPrice) result = result.filter((item) => Number(item.priceUsd || 0) >= minPrice);
  const maxPrice = numberParam(query.maxPrice, 1000, 100000000);
  if (maxPrice) result = result.filter((item) => Number(item.priceUsd || 0) <= maxPrice);
  const minArea = numberParam(query.minArea, 1, 100000);
  if (minArea) result = result.filter((item) => Number(item.areaSqm || 0) >= minArea);
  const maxArea = numberParam(query.maxArea, 1, 100000);
  if (maxArea) result = result.filter((item) => Number(item.areaSqm || 0) <= maxArea);
  const minRooms = numberParam(query.minRooms, 1, 30);
  if (minRooms) result = result.filter((item) => Number(item.rooms || 0) >= minRooms);
  const maxDistance = numberParam(query.maxDistance, 1, 240);
  if (maxDistance) result = result.filter((item) => Number.isFinite(Number(item.minutesToCenter)) && Number(item.minutesToCenter) <= maxDistance);
  const minLand = numberParam(query.minLand, 1, 1000000);
  if (minLand) result = result.filter((item) => Number(item.landSqm || 0) >= minLand);
  if (query.withPhoto === "1" || query.withPhoto === "true") {
    result = result.filter((item) => Boolean(item.imageUrl));
  }
  if (["ready", "partial", "needs_work"].includes(query.condition)) {
    result = result.filter((item) => item.condition === query.condition);
  }
  if (query.elevator === "1" || query.elevator === "true") {
    result = result.filter((item) => item.elevator === true);
  }
  const ids = String(query.ids || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 500);
  if (ids.length > 0) {
    const allowedIds = new Set(ids);
    result = result.filter((item) => allowedIds.has(String(item.id)));
  }
  const search = String(query.q || "").trim().toLowerCase().slice(0, 100);
  if (search) {
    result = result.filter((item) =>
      [item.title, item.location, item.rawText, item.sourceLabel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }
  return result;
}

function sortListings(listings, sort) {
  const sorted = listings.slice();
  if (sort === "value") {
    sorted.sort((a, b) => Number(b.valueScore ?? 0) - Number(a.valueScore ?? 0) || Number(a.priceUsd || 0) - Number(b.priceUsd || 0));
  } else if (sort === "price_asc") {
    sorted.sort((a, b) => Number(a.priceUsd || 0) - Number(b.priceUsd || 0));
  } else if (sort === "price_desc") {
    sorted.sort((a, b) => Number(b.priceUsd || 0) - Number(a.priceUsd || 0));
  } else if (sort === "area_desc") {
    sorted.sort((a, b) => Number(b.areaSqm || 0) - Number(a.areaSqm || 0));
  } else {
    sorted.sort(compareListingActivity);
  }
  return sorted;
}

function freshCount(listings, now = new Date()) {
  return listings.filter((item) => {
    const published = daysSince(item.publishedAt, now);
    const updated = daysSince(item.updatedAt, now);
    const changed = daysSince(item.changeDetectedAt, now);
    return [published, updated, changed].some((days) => days !== null && days >= 0 && days <= 1);
  }).length;
}

function listingsApiPayload(state, config, query = {}, now = new Date()) {
  const visible = visibleListings(state.listings || []);
  const filtered = sortListings(applyQueryFilters(visible, query), query.sort);
  const limit = numberParam(query.limit, 1, MAX_API_LIMIT) || DEFAULT_API_LIMIT;
  const offset = numberParam(query.offset, 0, 1000000) || 0;
  const page = filtered.slice(offset, offset + limit);

  return {
    updatedAt: state.lastScan?.at || state.updatedAt || null,
    nextScanAt: state.nextScanAt || null,
    scanIntervalMinutes: config.scanIntervalMinutes,
    total: filtered.length,
    catalogTotal: visible.length,
    freshLast24h: freshCount(filtered, now),
    offset,
    returned: page.length,
    hasMore: offset + page.length < filtered.length,
    locations: unique(visible.map((item) => item.location)).sort(),
    sources: mergedSourceEntries(state).map((entry) => {
      const gmailSetupRequired = entry.source === "listam" && config.gmailImapEnabled && !isGmailConfigured(config);
      return {
        label: entry.label,
        listings: entry.listings,
        parsedListings: entry.catalogListings ?? entry.listings,
        catalogListings: entry.catalogListings ?? entry.listings,
        lastScanListings: entry.lastScanListings ?? entry.listings,
        lastSuccessAt: entry.lastSuccessAt || null,
        stale: Boolean(entry.stale),
        ok: !gmailSetupRequired && !entry.degraded && !entry.blocked && !entry.lastError,
        statusText: gmailSetupRequired ? "нужно завершить подключение Gmail" : null,
      };
    }),
    listings: page.map(publicListingView),
  };
}

module.exports = {
  listingsApiPayload,
  publicListingView,
  shortDescription,
};
