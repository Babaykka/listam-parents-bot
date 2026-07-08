const { compareListingActivity, daysSince } = require("./listingFreshness");
const { visibleListings } = require("./listingStore");
const { sourceStatusEntries } = require("./sourceHealth");
const { unique } = require("./utils");

const MAX_API_LIMIT = 300;
const DEFAULT_API_LIMIT = 120;

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
    condition: item.condition || "unknown",
    elevator: item.elevator ?? null,
    publishedAt: item.publishedAt || null,
    updatedAt: item.updatedAt || null,
    discoveredAt: item.discoveredAt || null,
    url: item.url,
    sourceLabel: item.sourceLabel || "",
    alsoSources: (item.alsoSources || []).map((entry) => entry.label),
    whyGood: item.whyGood || [],
    valueScore: item.valueScore ?? null,
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
  const maxPrice = numberParam(query.maxPrice, 1000, 100000000);
  if (maxPrice) result = result.filter((item) => Number(item.priceUsd || 0) <= maxPrice);
  const minArea = numberParam(query.minArea, 1, 100000);
  if (minArea) result = result.filter((item) => Number(item.areaSqm || 0) >= minArea);
  const minRooms = numberParam(query.minRooms, 1, 30);
  if (minRooms) result = result.filter((item) => Number(item.rooms || 0) >= minRooms);
  return result;
}

function sortListings(listings, sort) {
  const sorted = listings.slice();
  if (sort === "value") {
    sorted.sort((a, b) => Number(b.valueScore ?? 0) - Number(a.valueScore ?? 0) || Number(a.priceUsd || 0) - Number(b.priceUsd || 0));
  } else {
    sorted.sort(compareListingActivity);
  }
  return sorted;
}

function freshCount(listings, now = new Date()) {
  return listings.filter((item) => {
    const published = daysSince(item.publishedAt, now);
    const updated = daysSince(item.updatedAt, now);
    return (published !== null && published >= 0 && published <= 1) || (updated !== null && updated >= 0 && updated <= 1);
  }).length;
}

function listingsApiPayload(state, config, query = {}, now = new Date()) {
  const visible = visibleListings(state.listings || []);
  const filtered = sortListings(applyQueryFilters(visible, query), query.sort);
  const limit = numberParam(query.limit, 1, MAX_API_LIMIT) || DEFAULT_API_LIMIT;

  return {
    updatedAt: state.lastScan?.at || state.updatedAt || null,
    nextScanAt: state.nextScanAt || null,
    scanIntervalMinutes: config.scanIntervalMinutes,
    total: filtered.length,
    freshLast24h: freshCount(visible, now),
    locations: unique(visible.map((item) => item.location)).sort(),
    sources: sourceStatusEntries(state).map((entry) => ({
      label: entry.label,
      listings: entry.listings,
      ok: !entry.degraded && !entry.blocked && !entry.lastError,
    })),
    listings: filtered.slice(0, limit).map(publicListingView),
  };
}

module.exports = {
  listingsApiPayload,
  publicListingView,
};
