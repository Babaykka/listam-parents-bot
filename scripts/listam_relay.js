// Scans List.am from this machine (where the site serves pages normally) and
// pushes the parsed listings to the production bot via POST /ingest/listings.
// The bot merges them into the regular pipeline: dedupe, freshness, notifications.
//
// Usage:
//   INGEST_TOKEN=... npm run relay              # single scan + push
//   RELAY_INTERVAL_MINUTES=15 npm run relay     # keep running, push every 15 min
//
// Env (can live in .env):
//   INGEST_TOKEN            - must match the bot's INGEST_TOKEN on Render (required)
//   RELAY_TARGET_URL        - bot base URL, default https://listam-parents-bot.onrender.com
//   RELAY_INTERVAL_MINUTES  - 0 (default) = run once; >0 = loop
//   RELAY_PAGES_PER_CATEGORY- List.am pages per category, default 2

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../src/config");
const { scanListAm } = require("../src/listam");

const baseConfig = loadConfig();
const PENDING_FILE = path.join(baseConfig.dataDir, "relay-pending.json");
const targetUrl = (process.env.RELAY_TARGET_URL || "https://listam-parents-bot.onrender.com").replace(/\/+$/, "");
const intervalMinutes = Number(process.env.RELAY_INTERVAL_MINUTES || 0);
const pagesPerCategory = Number(process.env.RELAY_PAGES_PER_CATEGORY || 2);

if (!process.env.INGEST_TOKEN) {
  console.error("INGEST_TOKEN is required. Copy it from the Render dashboard (service env vars) into .env");
  process.exit(1);
}

function relayScanConfig() {
  return {
    ...baseConfig,
    scanPagesPerCategory: Math.max(1, pagesPerCategory),
    scanPageWaitSeconds: Math.min(baseConfig.scanPageWaitSeconds, 45),
    challengeWaitSeconds: Math.min(baseConfig.challengeWaitSeconds, 30),
    headless: baseConfig.headless,
  };
}

async function pushListingsOnce(listings) {
  const response = await fetch(`${targetUrl}/ingest/listings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-token": process.env.INGEST_TOKEN,
    },
    body: JSON.stringify({ source: "listam", listings }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`ingest failed: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// The bot may be mid-deploy when we push; a successful List.am scan is too
// valuable to lose, so retry and keep a local pending buffer between runs.
async function pushListings(listings) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await pushListingsOnce(listings);
    } catch (error) {
      lastError = error;
      console.warn(`[relay] push attempt ${attempt} failed: ${error.message}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  throw lastError;
}

function savePending(listings) {
  fs.mkdirSync(baseConfig.dataDir, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify({ scannedAt: new Date().toISOString(), listings }));
}

function loadPending() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
    const ageMinutes = (Date.now() - Date.parse(data.scannedAt || "")) / 60000;
    if (!Number.isFinite(ageMinutes) || ageMinutes > Number(baseConfig.relayMaxAgeMinutes || 180)) return null;
    return Array.isArray(data.listings) && data.listings.length > 0 ? data.listings : null;
  } catch {
    return null;
  }
}

function clearPending() {
  fs.rmSync(PENDING_FILE, { force: true });
}

async function runOnce() {
  console.log(`[relay] scanning List.am locally (${pagesPerCategory} page(s) per category)`);
  const result = await scanListAm(relayScanConfig());
  console.log(`[relay] scanned: ${result.listings.length} listings, skipped pages: ${result.skipped.length}`);

  let listings = result.listings;
  if (listings.length > 0) {
    savePending(listings);
  } else {
    listings = loadPending() || [];
    if (listings.length > 0) console.log(`[relay] scan blocked, pushing ${listings.length} buffered listings from the previous successful scan`);
  }
  if (listings.length === 0) {
    console.log("[relay] nothing to push (List.am may be showing the browser check here too, will retry next run)");
    return;
  }

  const data = await pushListings(listings);
  clearPending();
  console.log(`[relay] pushed to ${targetUrl}: accepted ${data.accepted}, dropped ${data.dropped}`);
}

async function main() {
  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      console.error(`[relay] ${error.stack || error.message}`);
    }
    if (!(intervalMinutes > 0)) break;
    console.log(`[relay] next run in ${intervalMinutes} min`);
    await new Promise((resolve) => setTimeout(resolve, intervalMinutes * 60 * 1000));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
