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

const { loadConfig } = require("../src/config");
const { scanListAm } = require("../src/listam");

const baseConfig = loadConfig();
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

async function pushListings(listings) {
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

async function runOnce() {
  console.log(`[relay] scanning List.am locally (${pagesPerCategory} page(s) per category)`);
  const result = await scanListAm(relayScanConfig());
  console.log(`[relay] scanned: ${result.listings.length} listings, skipped pages: ${result.skipped.length}`);
  if (result.listings.length === 0) {
    console.log("[relay] nothing to push (List.am may be showing the browser check here too, will retry next run)");
    return;
  }
  const data = await pushListings(result.listings);
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
