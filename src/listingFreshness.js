function daysSince(value, now = new Date()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return (now.getTime() - time) / 86400000;
}

function listingVersionValue(item) {
  const timestamps = [item?.updatedAt, item?.publishedAt, item?.changeDetectedAt]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : "";
}

function listingSeenKey(item) {
  const id = String(item?.id || "").trim();
  if (!id) return "";
  const version = listingVersionValue(item);
  return version ? `${id}@${version}` : id;
}

function isRecentUpdatedListing(config, item, now = new Date()) {
  const sourceUpdatedAt = item?.updatedAt && item.updatedAt !== item.publishedAt ? item.updatedAt : null;
  const updateTimes = [sourceUpdatedAt, item?.changeDetectedAt]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  if (updateTimes.length === 0) return false;
  const updatedDays = (now.getTime() - Math.max(...updateTimes)) / 86400000;
  return updatedDays !== null && updatedDays >= 0 && updatedDays <= Number(config.notifyUpdatedWithinDays ?? 14);
}

function shouldNotifyListing(config, item, now = new Date()) {
  if (isRecentUpdatedListing(config, item, now)) return true;

  const publishedDays = daysSince(item.publishedAt, now);
  if (publishedDays !== null && publishedDays >= 0 && publishedDays <= Number(config.notifyPublishedWithinDays ?? 30)) return true;

  return !item.publishedAt && !item.updatedAt && !item.changeDetectedAt;
}

function isSeenListing(config, seenSet, item, now = new Date()) {
  const id = String(item?.id || "").trim();
  const key = listingSeenKey(item);
  if (key && seenSet.has(key)) return true;
  if (!id || !seenSet.has(id)) return false;

  return !isRecentUpdatedListing(config, item, now);
}

function nextSeenIds(previousSeen, listings, maxSeenIds) {
  const currentIds = new Set((listings || []).map((item) => String(item.id || "")).filter(Boolean));
  const retained = [];

  for (const rawKey of previousSeen || []) {
    const key = String(rawKey || "");
    if (!key || currentIds.has(key)) continue;
    retained.push(key);
  }

  const currentKeys = (listings || []).map(listingSeenKey).filter(Boolean);
  return Array.from(new Set([...retained, ...currentKeys])).slice(-maxSeenIds);
}

function sourceActivityTimestamp(item) {
  const timestamps = [item?.updatedAt, item?.publishedAt, item?.changeDetectedAt]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

// "Fresh" is deliberately simple for users: the publication date wins. When
// a source does not expose it, use when the bot first added the listing.
function listingFreshnessTimestamp(item) {
  const published = Date.parse(item?.publishedAt || "");
  if (Number.isFinite(published)) return published;
  const discovered = Date.parse(item?.discoveredAt || item?.scannedAt || "");
  return Number.isFinite(discovered) ? discovered : null;
}

function listingActivityValue(item) {
  const timestamp = listingFreshnessTimestamp(item);
  return timestamp === null ? "" : new Date(timestamp).toISOString();
}

function compareListingActivity(a, b) {
  const aTime = listingFreshnessTimestamp(a);
  const bTime = listingFreshnessTimestamp(b);
  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  if (aTime !== bTime) return Number(bTime || 0) - Number(aTime || 0);
  return Number(a.priceUsd || 0) - Number(b.priceUsd || 0);
}

// Cache retention also considers source updates and detected changes so an
// important revised listing is not evicted even though the UI sorts simply.
function compareListingStorageActivity(a, b) {
  const aTime = (sourceActivityTimestamp(a) ?? Date.parse(a?.discoveredAt || a?.scannedAt || "")) || 0;
  const bTime = (sourceActivityTimestamp(b) ?? Date.parse(b?.discoveredAt || b?.scannedAt || "")) || 0;
  return bTime - aTime || Number(a.priceUsd || 0) - Number(b.priceUsd || 0);
}

module.exports = {
  compareListingActivity,
  compareListingStorageActivity,
  daysSince,
  isSeenListing,
  listingActivityValue,
  listingFreshnessTimestamp,
  listingSeenKey,
  nextSeenIds,
  shouldNotifyListing,
};
