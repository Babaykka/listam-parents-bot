const { dedupeListings } = require("./dedupe");
const { compareListingActivity } = require("./listingFreshness");
const { annotateListings } = require("./ranking");

function mergeListings(previous, scanned, config, now = new Date()) {
  const nowIso = now.toISOString();
  const byId = new Map();

  for (const item of previous || []) {
    byId.set(item.id, {
      ...item,
      qualityScore: item.qualityScore ?? item["parent" + "Score"] ?? 0,
    });
  }

  for (const item of scanned || []) {
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
    .sort(compareListingActivity)
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
  mergeListings,
  priceDropPercent,
  visibleListings,
};
