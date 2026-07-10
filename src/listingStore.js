const { dedupeListings } = require("./dedupe");
const { compareListingStorageActivity } = require("./listingFreshness");
const { annotateListings } = require("./ranking");

const MATERIAL_FIELDS = [
  ["priceUsd", (item) => item.priceUsd],
  ["areaSqm", (item) => item.areaSqm],
  ["rooms", (item) => item.rooms],
  ["floor", (item) => item.floor?.current],
  ["floorsTotal", (item) => item.floor?.total],
  ["landSqm", (item) => item.landSqm],
  ["location", (item) => item.location],
];

function comparableValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  return text ? text : null;
}

function latestDateValue(current, previous) {
  const currentTime = Date.parse(current || "");
  const previousTime = Date.parse(previous || "");
  if (Number.isFinite(currentTime) && Number.isFinite(previousTime)) {
    return currentTime >= previousTime ? current : previous;
  }
  if (Number.isFinite(currentTime)) return current;
  if (Number.isFinite(previousTime)) return previous;
  return null;
}

function materialListingChanges(previous, current) {
  if (!previous || !current) return [];
  const changes = [];
  for (const [field, read] of MATERIAL_FIELDS) {
    const before = comparableValue(read(previous));
    const after = comparableValue(read(current));
    // Missing -> known is parser enrichment, not proof that the seller edited
    // the listing. Only compare values that were present in both snapshots.
    if (before !== null && after !== null && before !== after) changes.push(field);
  }
  return changes;
}

function annotateListingChanges(previous, scanned, now = new Date()) {
  const previousById = new Map((previous || []).map((item) => [String(item.id || ""), item]));
  const nowIso = now.toISOString();

  return (scanned || []).map((item) => {
    const existing = previousById.get(String(item.id || ""));
    if (!existing) return item;

    const changes = materialListingChanges(existing, item);
    const incomingUpdateTime = Date.parse(item.updatedAt || "");
    const existingUpdateTime = Date.parse(existing.updatedAt || "");
    const sourceUpdateAdvanced =
      Number.isFinite(incomingUpdateTime) &&
      (!Number.isFinite(existingUpdateTime) || incomingUpdateTime > existingUpdateTime);
    const updatedAt = latestDateValue(item.updatedAt, existing.updatedAt);
    const next = {
      ...item,
      // A partial card or email must not erase dates learned earlier.
      publishedAt: item.publishedAt || existing.publishedAt || null,
      publishedAtPrecision: item.publishedAt
        ? item.publishedAtPrecision || null
        : existing.publishedAtPrecision || null,
      updatedAt,
      updatedAtPrecision:
        updatedAt && updatedAt === item.updatedAt ? item.updatedAtPrecision || null : existing.updatedAtPrecision || null,
      changeDetectedAt: item.changeDetectedAt || existing.changeDetectedAt || null,
      changedFields: item.changedFields || existing.changedFields || [],
    };

    // Prefer the site's own update timestamp. When it is missing or unchanged,
    // a material field difference is still reliable evidence of a new version.
    if (changes.length > 0 && !sourceUpdateAdvanced) {
      next.changeDetectedAt = nowIso;
      next.changedFields = changes;
    }
    return next;
  });
}

function mergeListings(previous, scanned, config, now = new Date()) {
  const nowIso = now.toISOString();
  const byId = new Map();

  for (const item of previous || []) {
    byId.set(item.id, {
      ...item,
      qualityScore: item.qualityScore ?? item["parent" + "Score"] ?? 0,
    });
  }

  for (const item of annotateListingChanges(previous, scanned, now)) {
    const existing = byId.get(item.id);
    const prevPrice = Number(existing?.priceUsd || 0);
    const newPrice = Number(item.priceUsd || 0);
    let priceDrop = {};
    if (existing && prevPrice > 0 && newPrice > 0 && newPrice < prevPrice) {
      // Price fell this scan — remember what it dropped from.
      priceDrop = { previousPriceUsd: prevPrice, priceChangedAt: nowIso };
    } else if (existing?.previousPriceUsd && newPrice === prevPrice) {
      // Price unchanged — keep the earlier drop marker.
      priceDrop = { previousPriceUsd: existing.previousPriceUsd, priceChangedAt: existing.priceChangedAt };
    }
    byId.set(item.id, {
      ...existing,
      ...item,
      ...priceDrop,
      // Keep a photo we captured earlier if this scan didn't return one (lazy
      // images aren't always caught), so cards don't lose their picture.
      imageUrl: item.imageUrl || existing?.imageUrl || null,
      discoveredAt: existing?.discoveredAt || nowIso,
      lastSeenAt: nowIso,
    });
  }

  return annotateListings(dedupeListings(Array.from(byId.values())), now)
    .sort(compareListingStorageActivity)
    .slice(0, config.maxListingsCache);
}

// Percent price drop vs the last recorded higher price, or null.
function priceDropPercent(item) {
  const from = Number(item?.previousPriceUsd || 0);
  const to = Number(item?.priceUsd || 0);
  if (from <= 0 || to <= 0 || to >= from) return null;
  const pct = Math.round((1 - to / from) * 100);
  return pct >= 3 ? pct : null;
}

// Duplicates stay in the cache for freshness tracking but must not reach users.
function visibleListings(listings) {
  return (listings || []).filter((item) => !item.duplicateOf);
}

module.exports = {
  annotateListingChanges,
  materialListingChanges,
  mergeListings,
  priceDropPercent,
  visibleListings,
};
