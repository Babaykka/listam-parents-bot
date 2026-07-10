// Fills in missing listing photos by fetching the listing's detail page and
// reading its og:image. Only for sources whose detail pages are reachable from
// the server AND expose og:image (MyRealty, Estate). List.am detail pages are
// Cloudflare-blocked from the server (relay handles those); Banali is a SPA with
// an empty og:image, so both are skipped here.
const BACKFILL_HOSTS = /(^|\.)(myrealty\.am|estate\.am)$/i;

function isBackfillEligible(item) {
  if (item.imageUrl || item.duplicateOf) return false;
  try {
    return BACKFILL_HOSTS.test(new URL(item.url).hostname);
  } catch {
    return false;
  }
}

function extractOgImage(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const url = match && match[1] && match[1].trim();
    if (url && /^https:\/\//i.test(url) && !/no-img|placeholder|logo|default/i.test(url)) return url;
  }
  return null;
}

async function fetchOgImage(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(20000, config.navigationTimeoutMs || 20000));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) return null;
    return extractOgImage(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches og:image for up to `limit` photo-less listings and returns id -> url.
// Bounded per cycle so coverage fills in over a few scans without hammering.
async function backfillImages(listings, config, options = {}, logger = console) {
  const limit = Math.max(0, Number(options.limit ?? 12));
  if (limit === 0) return {};
  const targets = (listings || []).filter(isBackfillEligible).slice(0, limit);
  const found = {};
  for (const item of targets) {
    const imageUrl = await fetchOgImage(item.url, config);
    if (imageUrl) {
      found[item.id] = imageUrl;
      logger.log(`[backfill] image for ${item.id}`);
    }
  }
  return found;
}

module.exports = {
  backfillImages,
  extractOgImage,
  isBackfillEligible,
};
