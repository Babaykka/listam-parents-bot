const SOURCE_PRIORITY = ["listam", "listam_feed", "banali", "myrealty", "estate"];

function listingSourceKey(item) {
  if (item?.source) return String(item.source);
  if (/list\.am/i.test(String(item?.url || ""))) return "listam";
  return "";
}

function priceSimilar(a, b) {
  const priceA = Number(a.priceUsd || 0);
  const priceB = Number(b.priceUsd || 0);
  if (!priceA || !priceB) return false;
  return Math.abs(priceA - priceB) <= Math.max(2000, 0.03 * Math.max(priceA, priceB));
}

function areaSimilar(a, b) {
  const areaA = Number(a.areaSqm || 0);
  const areaB = Number(b.areaSqm || 0);
  if (!areaA || !areaB) return null;
  return Math.abs(areaA - areaB) <= Math.max(3, 0.05 * Math.max(areaA, areaB));
}

function isLikelyDuplicate(a, b) {
  const sourceA = listingSourceKey(a);
  const sourceB = listingSourceKey(b);
  if (!sourceA || !sourceB || sourceA === sourceB) return false;
  if (a.kindKey !== b.kindKey) return false;
  if (a.location && b.location && a.location !== b.location) return false;
  if (!priceSimilar(a, b)) return false;
  if (areaSimilar(a, b) !== true) return false;

  const roomsA = Number(a.rooms || 0);
  const roomsB = Number(b.rooms || 0);
  if (roomsA && roomsB && roomsA !== roomsB) return false;

  const floorA = Number(a.floor?.current || 0);
  const floorB = Number(b.floor?.current || 0);
  if (floorA && floorB && floorA !== floorB) return false;

  // Same district + similar price/area is not enough to merge two listings;
  // require a structural match (rooms or floor) known on both sides.
  const confirmations = [
    roomsA && roomsB && roomsA === roomsB,
    floorA && floorB && floorA === floorB,
  ].filter(Boolean).length;
  return confirmations >= 1;
}

function sourcePriority(item) {
  const index = SOURCE_PRIORITY.indexOf(listingSourceKey(item));
  return index === -1 ? SOURCE_PRIORITY.length : index;
}

function canonicalPreference(a, b) {
  const discoveredA = String(a.discoveredAt || a.scannedAt || "");
  const discoveredB = String(b.discoveredAt || b.scannedAt || "");
  return (
    discoveredA.localeCompare(discoveredB) ||
    sourcePriority(a) - sourcePriority(b) ||
    String(a.id).localeCompare(String(b.id))
  );
}

const FILLABLE_FIELDS = ["areaSqm", "rooms", "floor", "landSqm", "elevator", "pricePerSqm", "minutesToCenter"];

function fillMissingFields(canonical, duplicate) {
  for (const field of FILLABLE_FIELDS) {
    if (canonical[field] === null || canonical[field] === undefined) {
      if (duplicate[field] !== null && duplicate[field] !== undefined) canonical[field] = duplicate[field];
    }
  }
  if (!canonical.location && duplicate.location) {
    canonical.location = duplicate.location;
    canonical.minutesToCenter = duplicate.minutesToCenter;
  }
}

// Marks likely cross-source duplicates: the earliest-discovered listing stays
// canonical (so a re-found copy never re-notifies), later copies get duplicateOf
// and canonical collects alsoSources for display.
function dedupeListings(listings) {
  const items = (listings || []).map((item) => {
    const next = { ...item };
    delete next.duplicateOf;
    delete next.alsoSources;
    return next;
  });

  const byKind = new Map();
  for (const item of items.slice().sort(canonicalPreference)) {
    const bucket = byKind.get(item.kindKey) || [];
    const canonical = bucket.find((candidate) => isLikelyDuplicate(candidate, item));
    if (canonical) {
      item.duplicateOf = canonical.id;
      canonical.alsoSources ||= [];
      const label = item.sourceLabel || listingSourceKey(item) || "другой источник";
      if (!canonical.alsoSources.some((entry) => entry.label === label)) {
        canonical.alsoSources.push({ label, url: item.url || "" });
      }
      fillMissingFields(canonical, item);
    } else {
      bucket.push(item);
      byKind.set(item.kindKey, bucket);
    }
  }

  return items;
}

module.exports = {
  dedupeListings,
  isLikelyDuplicate,
  listingSourceKey,
};
