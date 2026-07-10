const { clamp, normalizeText, unique } = require("./utils");
const { compareListingActivity } = require("./listingFreshness");

const BASE_URL = "https://banali.am";

const PRICE_BUCKETS = [
  { min: 0, max: 39999, value: "usd~lt_40000" },
  { min: 40000, max: 60000, value: "usd~gte_40000-lte_60000" },
  { min: 60001, max: 80000, value: "usd~gte_60001-lte_80000" },
  { min: 80001, max: 100000, value: "usd~gte_80001-lte_100000" },
  { min: 100001, max: 150000, value: "usd~gte_100001-lte_150000" },
  { min: 150001, max: 200000, value: "usd~gte_150001-lte_200000" },
  { min: 200001, max: Infinity, value: "usd~gte_200001" },
];

const LOCATION_ALIASES = [
  ["Center", "Kentron"],
  ["Centre", "Kentron"],
  ["Kentron", "Kentron"],
  ["Erebouni", "Erebuni"],
  ["Erebuni", "Erebuni"],
  ["Kanaker Zeytun", "Kanaker-Zeytun"],
  ["Kanaker-Zeytun", "Kanaker-Zeytun"],
  ["Kanaqer Zeytun", "Kanaker-Zeytun"],
  ["Kanaqer-Zeytun", "Kanaker-Zeytun"],
  ["Malatia Sebastia", "Malatia-Sebastia"],
  ["Malatia-Sebastia", "Malatia-Sebastia"],
  ["Nor Nork", "Nor Nork"],
  ["Nor-Nork", "Nor Nork"],
  ["Nork Marash", "Nork-Marash"],
  ["Nork-Marash", "Nork-Marash"],
  ["Verin Ptghni", "Verin Ptghni"],
  ["Ptghni", "Ptghni"],
];

function escapedRegex(value) {
  return String(value || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function flexibleLocationRegex(value) {
  const tokens = normalizeText(value)
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(escapedRegex);
  if (tokens.length === 0) return null;
  return new RegExp(`\\b${tokens.join("[-\\s]+")}\\b`, "i");
}

function parseNumber(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const number = parseNumber(item);
      if (number !== null) return number;
    }
    return null;
  }
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/\s+/g, "").replace(/,/g, "");
  const number = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function absoluteUrl(post) {
  const slug = post?.slug?.en || post?.slug?.ru || post?.slug?.hy || "";
  if (!slug) return `${BASE_URL}/en/sell`;
  return `${BASE_URL}/en/${String(slug).replace(/^\/+/, "")}`;
}

function imageUrl(post) {
  const raw = String(post?.image || "").trim();
  if (!raw) return null;
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
  return null;
}

function priceBucketsForConfig(config) {
  if (config.collectAllListings) return PRICE_BUCKETS.map((bucket) => bucket.value);
  const min = Number(config.minPriceUsd || 0);
  const max = Number(config.maxPriceUsd || 150000);
  return PRICE_BUCKETS.filter((bucket) => bucket.max >= min && bucket.min <= max).map((bucket) => bucket.value);
}

function parsePrice(post, config) {
  const priceFull = Array.isArray(post.priceFull) ? post.priceFull.find((item) => parseNumber(item?.price) !== null) : null;
  const amount = parseNumber(priceFull?.price ?? post.price);
  if (!amount) return null;

  const currency = String(priceFull?.currency || "").toUpperCase();
  if (currency === "840" || currency === "USD") {
    return {
      priceUsd: Math.round(amount),
      priceLabel: `$${Math.round(amount).toLocaleString("en-US")}`,
    };
  }

  if (currency === "051" || currency === "AMD" || currency === "\u058F" || amount > 1000000) {
    const amdPerUsd = Number(config.amdPerUsd || 390);
    if (amdPerUsd <= 0) return null;
    const priceUsd = Math.round(amount / amdPerUsd);
    return {
      priceUsd,
      priceLabel: `${Math.round(amount).toLocaleString("en-US")} AMD (~$${priceUsd.toLocaleString("en-US")})`,
    };
  }

  return {
    priceUsd: Math.round(amount),
    priceLabel: `$${Math.round(amount).toLocaleString("en-US")}`,
  };
}

function locationHaystack(post) {
  return normalizeText(
    [
      post?.slug?.en,
      post?.slug?.ru,
      post?.address,
      post?.district,
      post?.title,
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/[/_+]+/g, " ")
      .replace(/[-]+/g, " ")
  );
}

function parseLocation(post, config) {
  const haystack = locationHaystack(post);
  for (const [needle, location] of LOCATION_ALIASES) {
    const regex = flexibleLocationRegex(needle);
    if (regex?.test(haystack)) return location;
  }
  for (const location of config.defaultLocations) {
    const regex = flexibleLocationRegex(location);
    if (regex?.test(haystack)) return location;
  }
  return "";
}

function parseFloor(post, kindKey) {
  if (kindKey !== "apartment") return null;
  const current = parseNumber(post.floor);
  const total = parseNumber(post.buildingFloors);
  if (!current && !total) return null;
  const label = total ? `${current || "?"}/${total}` : String(current);
  return { current, total, label };
}

function flattenTokens(value) {
  if (!Array.isArray(value)) return [];
  return value.flat(Infinity).map((item) => String(item || "")).filter(Boolean);
}

function parseCondition(post) {
  const text = normalizeText([post.structureType, ...flattenTokens(post.heating)].join(" ")).toLowerCase();
  if (/needs|old|renovation_required|zero|shell/.test(text)) return "needs_work";
  if (/renovated|euro|designer/.test(text)) return "ready";
  return "unknown";
}

function qualityScore(item) {
  let score = 5;
  const text = item.rawText.toLowerCase();
  if (item.floor?.current === 1) score += 1.2;
  else if (item.floor?.current === 2) score += 0.7;
  else if (item.floor?.current >= 5 && item.kindKey === "apartment") score -= 0.5;
  if (item.condition === "ready") score += 0.8;
  if (item.condition === "needs_work") score -= 1;
  if (/heating_(central|individual|gas)|gas/.test(text)) score += 0.4;
  if (item.pricePerSqm && item.pricePerSqm < 1400) score += 0.4;
  return clamp(Math.round(score * 10) / 10, 0, 10);
}

function parsePost(post, config) {
  const kindKey = post.propertyType === "house" ? "house" : post.propertyType === "apartment" ? "apartment" : null;
  if (!kindKey) return null;
  if (!config.categories.some((category) => category.key === kindKey)) return null;
  if (post.deal && post.deal !== "sell") return null;

  const price = parsePrice(post, config);
  if (!price) return null;
  if (!config.collectAllListings && (price.priceUsd > config.maxPriceUsd || price.priceUsd < config.minPriceUsd)) return null;

  const location = parseLocation(post, config);
  if (config.requireKnownLocation && !location) return null;
  if (location && !(location in config.minutesToCenter)) return null;

  const areaSqm = parseNumber(post.area);
  const rooms = parseNumber(post.rooms);
  const floor = parseFloor(post, kindKey);
  const kind = kindKey === "house" ? "Дом" : "Квартира";
  const url = absoluteUrl(post);
  const publicCode = String(post.publicCode || post.id || "").trim();
  if (!publicCode) return null;

  const rawText = normalizeText(
    [
      post.title,
      post.address,
      post.district,
      post.slug?.en,
      post.structureType,
      ...flattenTokens(post.heating),
      `${areaSqm || ""} sqm`,
      `${rooms || ""} rooms`,
      floor?.label || "",
    ].join(" ")
  );
  const item = {
    id: `banali:${publicCode}`,
    source: "banali",
    sourceLabel: "Banali.am",
    kind,
    kindKey,
    title: normalizeText(`${rooms ? `${rooms} room ` : ""}${kindKey === "house" ? "house" : "apartment"}${areaSqm ? `, ${areaSqm} sq.m.` : ""} · ${location || post.district || post.address || publicCode}`),
    url,
    imageUrl: imageUrl(post),
    priceLabel: price.priceLabel,
    priceUsd: price.priceUsd,
    areaSqm,
    pricePerSqm: areaSqm ? Math.round(price.priceUsd / areaSqm) : null,
    rooms,
    floor,
    landSqm: null,
    location,
    minutesToCenter: location ? config.minutesToCenter[location] : null,
    elevator: null,
    condition: parseCondition(post),
    publishedAt: parseDate(post.publishedAt),
    publishedAtPrecision: post.publishedAt ? "datetime" : null,
    updatedAt: parseDate(post.updatedToTop),
    updatedAtPrecision: post.updatedToTop ? "datetime" : null,
    rawText,
    scannedAt: new Date().toISOString(),
  };
  item.qualityScore = qualityScore(item);
  return item;
}

async function fetchJson(url, options, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.navigationTimeoutMs || 75000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        ...(options?.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAmdPerUsd(config, logger = console) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/exchange-rates`, { method: "GET" }, config);
    const rate = Number(data?.rates?.USD?.Rate);
    return Number.isFinite(rate) && rate > 0 ? rate : Number(config.amdPerUsd || 390);
  } catch (error) {
    logger.warn(`[banali] exchange rate fallback: ${error.message}`);
    return Number(config.amdPerUsd || 390);
  }
}

function searchDefinitions(config) {
  const price = priceBucketsForConfig(config);
  const searches = [];
  for (const category of config.categories) {
    const propertyType = category.key === "house" ? "house" : category.key === "apartment" ? "apartment" : null;
    if (!propertyType) continue;
    const yerevanFilters = {
      deal: "sell",
      state_id: ["1"],
      property_type: [propertyType],
    };
    const nearbyFilters = {
      deal: "sell",
      property_type: [propertyType],
    };
    if (!config.collectAllListings) {
      yerevanFilters.price = price;
      nearbyFilters.price = price;
    }
    searches.push({
      category: category.key,
      scope: "yerevan",
      filters: yerevanFilters,
    });
    searches.push({
      category: category.key,
      scope: "nearby",
      filters: nearbyFilters,
    });
  }
  return searches;
}

async function fetchSearchPage(search, pageNo, config, logger = console) {
  logger.log(`[banali] ${search.category} ${search.scope} page ${pageNo}`);
  const data = await fetchJson(
    `${BASE_URL}/api/search/filter-posts?page=${pageNo}`,
    {
      method: "POST",
      body: JSON.stringify({
        params: {
          filters: search.filters,
          sortBy: "",
        },
      }),
    },
    config
  );
  const posts = data?.data?.posts?.data || [];
  return posts.map((post) => parsePost(post, config)).filter(Boolean);
}

async function runLimited(tasks, limit) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < tasks.length) {
      const taskIndex = index;
      index += 1;
      results[taskIndex] = await tasks[taskIndex]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanBanali(config, logger = console) {
  const amdPerUsd = await fetchAmdPerUsd(config, logger);
  const scanConfig = { ...config, amdPerUsd };
  const pages = Math.max(1, Number(config.banaliPagesPerCategory || 5));
  const concurrency = Math.max(1, Number(config.banaliConcurrency || 4));
  const listings = [];
  const skipped = [];
  const tasks = [];

  for (const search of searchDefinitions(scanConfig)) {
    for (let pageNo = 1; pageNo <= pages; pageNo += 1) {
      tasks.push(async () => {
        try {
          const pageListings = await fetchSearchPage(search, pageNo, scanConfig, logger);
          if (pageListings.length === 0) {
            skipped.push({ source: "banali", category: search.category, scope: search.scope, pageNo, title: "no matching listings" });
          }
          listings.push(...pageListings);
        } catch (error) {
          skipped.push({ source: "banali", category: search.category, scope: search.scope, pageNo, error: error.message });
          logger.warn(`[banali] error ${search.category} ${search.scope} page ${pageNo}: ${error.message}`);
        }
      });
    }
  }

  await runLimited(tasks, concurrency);

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
  scanBanali,
  __test: {
    parseLocation,
    parsePost,
    parsePrice,
    priceBucketsForConfig,
    searchDefinitions,
  },
};
