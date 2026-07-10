const { compareListingActivity, nextSeenIds } = require("./listingFreshness");
const { mergeListings } = require("./listingStore");
const { normalizeText, unique } = require("./utils");

const MAX_INGEST_LISTINGS = 500;
const ALLOWED_SOURCES = new Set(["listam"]);

function cleanString(value, maxLength = 400) {
  return normalizeText(value).slice(0, maxLength);
}

function cleanNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function cleanIsoDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function cleanFloor(value) {
  if (!value || typeof value !== "object") return null;
  const current = cleanNumber(value.current, 0, 100);
  const total = cleanNumber(value.total, 0, 100);
  if (!current && !total) return null;
  return { current, total, label: cleanString(value.label, 12) || `${current || "?"}${total ? `/${total}` : ""}` };
}

function sanitizeIngestListing(raw, config) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id, 64);
  const url = cleanString(raw.url, 300);
  const priceUsd = cleanNumber(raw.priceUsd, 1000, 10000000);
  const kindKey = raw.kindKey === "house" ? "house" : raw.kindKey === "apartment" ? "apartment" : null;
  if (!id || !priceUsd || !kindKey) return null;
  if (!/^https:\/\/[\w.-]+\//i.test(url)) return null;

  const location = cleanString(raw.location, 60);
  if (location && !(location in config.minutesToCenter)) return null;
  if (config.requireKnownLocation && !location) return null;

  const areaSqm = cleanNumber(raw.areaSqm, 5, 10000);
  const publishedAt = cleanIsoDate(raw.publishedAt);
  const updatedAt = cleanIsoDate(raw.updatedAt);
  const imageUrl = cleanString(raw.imageUrl, 300);

  return {
    id,
    source: "listam",
    sourceLabel: "List.am",
    kind: kindKey === "house" ? "Дом" : "Квартира",
    kindKey,
    title: cleanString(raw.title, 200),
    url,
    imageUrl: /^https:\/\/[\w.-]+\//i.test(imageUrl) ? imageUrl : null,
    priceLabel: cleanString(raw.priceLabel, 60) || `$${Math.round(priceUsd).toLocaleString("en-US")}`,
    priceUsd: Math.round(priceUsd),
    areaSqm,
    pricePerSqm: areaSqm ? Math.round(priceUsd / areaSqm) : null,
    rooms: cleanNumber(raw.rooms, 1, 30),
    floor: cleanFloor(raw.floor),
    landSqm: cleanNumber(raw.landSqm, 1, 1000000),
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator: raw.elevator === true ? true : raw.elevator === false ? false : null,
    condition: ["ready", "partial", "needs_work"].includes(raw.condition) ? raw.condition : "unknown",
    publishedAt,
    publishedAtPrecision: publishedAt ? (raw.publishedAtPrecision === "date" ? "date" : "datetime") : null,
    updatedAt,
    updatedAtPrecision: updatedAt ? (raw.updatedAtPrecision === "date" ? "date" : "datetime") : null,
    rawText: cleanString(raw.rawText, 1200),
    qualityScore: cleanNumber(raw.qualityScore, 0, 10) ?? 5,
    scannedAt: cleanIsoDate(raw.scannedAt) || new Date().toISOString(),
    contactName: cleanString(raw.contactName, 40) || null,
    contactPhone: cleanString(raw.contactPhone, 40) || null,
  };
}

function sanitizeIngestPayload(payload, config) {
  const source = cleanString(payload?.source, 30) || "listam";
  if (!ALLOWED_SOURCES.has(source)) return { error: `unknown source: ${source}` };
  const mode = cleanString(payload?.mode, 20) || "live";
  if (!new Set(["live", "backfill"]).has(mode)) return { error: `unknown ingest mode: ${mode}` };
  const rawListings = Array.isArray(payload?.listings) ? payload.listings : null;
  if (!rawListings) return { error: "listings must be an array" };

  const maxPrice = Number(config.maxPriceUsd || 0);
  const listings = [];
  let dropped = 0;
  for (const raw of rawListings.slice(0, MAX_INGEST_LISTINGS)) {
    const item = sanitizeIngestListing(raw, config);
    if (!item || (maxPrice > 0 && item.priceUsd > maxPrice * 2)) {
      dropped += 1;
      continue;
    }
    listings.push(item);
  }
  dropped += Math.max(0, rawListings.length - MAX_INGEST_LISTINGS);

  return { source, mode, listings, dropped };
}

function storeBackfillListings(state, listings, config, now = new Date()) {
  const knownIds = new Set((state.listings || []).map((item) => String(item.id)));
  state.listings = mergeListings(state.listings || [], listings || [], config, now);
  state.seenIds = nextSeenIds(state.seenIds || [], listings || [], config.maxSeenIds);
  return {
    added: (listings || []).filter((item) => !knownIds.has(String(item.id))).length,
    catalogListings: state.listings.length,
  };
}

function storeRelayListings(state, source, listings, now = new Date()) {
  state.relay ||= {};
  state.relay[source] = {
    receivedAt: now.toISOString(),
    listings,
  };
}

// Presents fresh relayed List.am listings as a fallback source so the regular
// scan pipeline (dedupe, freshness, notify, health) applies unchanged.
function relayFallbackResult(state, config, now = new Date()) {
  const relay = state.relay?.listam;
  if (!relay?.listings?.length) return null;
  const ageMinutes = (now.getTime() - Date.parse(relay.receivedAt || "")) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0 || ageMinutes > Number(config.relayMaxAgeMinutes || 180)) return null;

  const listings = relay.listings.slice().sort(compareListingActivity);
  return {
    listings,
    skipped: [],
    scannedAt: relay.receivedAt,
    locations: unique(listings.map((item) => item.location)),
    blocked: false,
    durationMs: 0,
    sourceName: "listam_relay",
  };
}

module.exports = {
  MAX_INGEST_LISTINGS,
  relayFallbackResult,
  sanitizeIngestPayload,
  storeBackfillListings,
  storeRelayListings,
};
