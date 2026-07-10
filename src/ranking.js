const { daysSince } = require("./listingFreshness");
const { clamp } = require("./utils");

const MIN_DISTRICT_SAMPLES = 3;

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function districtKey(item) {
  return `${item.kindKey}|${item.location || "?"}`;
}

function computeBaselines(listings) {
  const byDistrict = new Map();
  const byKind = new Map();

  for (const item of listings || []) {
    if (!item.pricePerSqm || item.duplicateOf) continue;
    const price = Number(item.pricePerSqm);
    if (!Number.isFinite(price) || price <= 0) continue;

    const districtList = byDistrict.get(districtKey(item)) || [];
    districtList.push(price);
    byDistrict.set(districtKey(item), districtList);

    const kindList = byKind.get(item.kindKey) || [];
    kindList.push(price);
    byKind.set(item.kindKey, kindList);
  }

  const district = new Map();
  for (const [key, values] of byDistrict) {
    if (values.length >= MIN_DISTRICT_SAMPLES) district.set(key, median(values));
  }
  const kind = new Map();
  for (const [key, values] of byKind) {
    kind.set(key, median(values));
  }

  return { district, kind };
}

function baselineFor(baselines, item) {
  if (!baselines) return null;
  return baselines.district.get(districtKey(item)) || baselines.kind.get(item.kindKey) || null;
}

function pricePerSqmDiscount(item, baselines) {
  const baseline = baselineFor(baselines, item);
  const price = Number(item.pricePerSqm || 0);
  if (!baseline || !price) return null;
  return 1 - price / baseline;
}

function freshnessDays(item, now) {
  const published = daysSince(item.publishedAt, now);
  const updated = daysSince(item.updatedAt, now);
  const changed = daysSince(item.changeDetectedAt, now);
  const candidates = [published, updated, changed].filter((value) => value !== null && value >= 0);
  return candidates.length ? Math.min(...candidates) : null;
}

function valueScore(item, baselines, now = new Date()) {
  let score = Number(item.qualityScore ?? 5);

  const discount = pricePerSqmDiscount(item, baselines);
  if (discount !== null) {
    if (discount >= 0.2) score += 2;
    else if (discount >= 0.1) score += 1.2;
    else if (discount >= 0) score += 0.4;
    else if (discount <= -0.2) score -= 1.2;
  }

  const fresh = freshnessDays(item, now);
  if (fresh !== null) {
    if (fresh <= 2) score += 1;
    else if (fresh <= 7) score += 0.5;
    else if (fresh > 60) score -= 0.5;
  }

  if (Number(item.areaSqm || 0) >= 70) score += 0.5;
  if (item.minutesToCenter !== null && item.minutesToCenter !== undefined && item.minutesToCenter <= 15) score += 0.3;

  return clamp(Math.round(score * 10) / 10, 0, 10);
}

function explainListing(item, baselines, now = new Date()) {
  const reasons = [];

  const discount = pricePerSqmDiscount(item, baselines);
  if (discount !== null && discount >= 0.08) {
    reasons.push(`цена за м² ниже средней по району примерно на ${Math.round(discount * 100)}%`);
  }

  const fresh = freshnessDays(item, now);
  if (fresh !== null && fresh <= 2) {
    const published = daysSince(item.publishedAt, now);
    reasons.push(published !== null && published <= 2 ? "свежее объявление" : "недавно обновлено");
  }

  if (item.kindKey === "house" && Number(item.landSqm || 0) >= 200) {
    reasons.push(`участок ${item.landSqm} м²`);
  } else if (Number(item.areaSqm || 0) >= 70) {
    reasons.push(`просторно: ${item.areaSqm} м²`);
  }

  if (item.condition === "ready") reasons.push("с ремонтом");
  if (item.elevator === true && Number(item.floor?.current || 0) >= 4) reasons.push("есть лифт");
  if (item.minutesToCenter !== null && item.minutesToCenter !== undefined && item.minutesToCenter <= 12) {
    reasons.push(`близко к центру: ${item.minutesToCenter} мин`);
  }

  return reasons.slice(0, 3);
}

function annotateListings(listings, now = new Date()) {
  const baselines = computeBaselines(listings);
  return (listings || []).map((item) => ({
    ...item,
    valueScore: valueScore(item, baselines, now),
    whyGood: item.duplicateOf ? [] : explainListing(item, baselines, now),
  }));
}

module.exports = {
  annotateListings,
  computeBaselines,
  explainListing,
  valueScore,
};
