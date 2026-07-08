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
    byId.set(item.id, {
      ...existing,
      ...item,
      discoveredAt: existing?.discoveredAt || nowIso,
      lastSeenAt: nowIso,
    });
  }

  return annotateListings(dedupeListings(Array.from(byId.values())), now)
    .sort(compareListingActivity)
    .slice(0, config.maxListingsCache);
}

// Duplicates stay in the cache for freshness tracking but must not reach users.
function visibleListings(listings) {
  return (listings || []).filter((item) => !item.duplicateOf);
}

module.exports = {
  mergeListings,
  visibleListings,
};
