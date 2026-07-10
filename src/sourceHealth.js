const SOURCE_LABELS = {
  listam: "List.am",
  listam_feed: "List.am feed",
  listam_relay: "List.am (relay)",
  myrealty: "MyRealty",
  estate: "Estate.am",
  banali: "Banali.am",
};

const DEGRADED_AFTER_FAILS = 3;
// Sources that carry the bulk of listings; if all of them fail the bot is blind.
const CORE_SOURCES = ["banali", "myrealty"];

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function sourceFailed(summary) {
  if (summary.error) return true;
  if (summary.blocked) return true;
  return Number(summary.listings || 0) === 0 && Number(summary.skipped || 0) > 0;
}

function updateSourceHealth(state, sourceResults, now = new Date()) {
  state.scanHealth ||= {};
  state.scanHealth.sources ||= {};
  const nowIso = now.toISOString();

  for (const summary of sourceResults || []) {
    const entry = (state.scanHealth.sources[summary.source] ||= { failStreak: 0, lastSuccessAt: null, lastError: null });
    if (sourceFailed(summary)) {
      entry.failStreak = Number(entry.failStreak || 0) + 1;
      entry.lastError = summary.error || (summary.blocked ? "проверка браузера" : "нет данных");
    } else {
      entry.failStreak = 0;
      entry.lastSuccessAt = nowIso;
      entry.lastError = null;
    }
    entry.lastListings = Number(summary.listings || 0);
    entry.lastDurationMs = summary.durationMs || null;
    entry.updatedAt = nowIso;
  }

  return state.scanHealth.sources;
}

function isSourceDegraded(state, source) {
  return Number(state.scanHealth?.sources?.[source]?.failStreak || 0) >= DEGRADED_AFTER_FAILS;
}

function coreSourcesDown(state) {
  return CORE_SOURCES.every((source) => isSourceDegraded(state, source));
}

function sourceStatusEntries(state, options = {}) {
  const sources = state.scanHealth?.sources || {};
  const lastScanSources = state.lastScan?.sources || [];
  // By default show only sources that took part in the last scan (an expired
  // relay must not look permanently healthy); options.all keeps history for admins.
  const names =
    options.all || lastScanSources.length === 0
      ? new Set([...lastScanSources.map((item) => item.source), ...Object.keys(sources)])
      : new Set(lastScanSources.map((item) => item.source));

  return Array.from(names).map((source) => {
    const health = sources[source] || {};
    const currentScan = lastScanSources.find((item) => item.source === source);
    const scan = currentScan || {};
    const catalogListings = (state.listings || []).filter(
      (item) => !item.duplicateOf && item.source === source
    ).length;
    const lastScanListings = Number(scan.listings ?? health.lastListings ?? 0);
    return {
      source,
      label: sourceLabel(source),
      listings: catalogListings || lastScanListings,
      catalogListings,
      lastScanListings,
      durationMs: scan.durationMs ?? health.lastDurationMs ?? null,
      blocked: Boolean(scan.blocked),
      probeMode: scan.probeMode || null,
      failStreak: Number(health.failStreak || 0),
      degraded: Number(health.failStreak || 0) >= DEGRADED_AFTER_FAILS,
      stale: !currentScan && catalogListings > 0,
      lastError: health.lastError || scan.error || null,
      lastSuccessAt: health.lastSuccessAt || null,
    };
  });
}

const LISTAM_FAMILY = ["listam", "listam_relay", "listam_feed"];

function isListamListing(item) {
  if (LISTAM_FAMILY.includes(item.source)) return true;
  return /list\.am/i.test(String(item.url || ""));
}

// For end users: collapse the List.am direct scan + relay + feed into one
// "List.am" line. The direct scan is blocked on the server, but List.am is
// "working" for the user whenever there are browsable List.am listings in the
// catalog (delivered by the relay) — so we don't show a scary "идёт проверка"
// next to 67 real, listable List.am offers.
function mergedSourceEntries(state) {
  const entries = sourceStatusEntries(state);
  const allEntries = sourceStatusEntries(state, { all: true });
  const family = allEntries.filter((entry) => LISTAM_FAMILY.includes(entry.source));
  const others = entries.filter((entry) => !LISTAM_FAMILY.includes(entry.source));

  const catalogCount = (state.listings || []).filter((item) => !item.duplicateOf && isListamListing(item)).length;

  const merged = [];
  if (family.length > 0 || catalogCount > 0) {
    const currentFamily = (state.lastScan?.sources || []).filter((entry) => LISTAM_FAMILY.includes(entry.source));
    const scanCount = currentFamily.reduce((sum, entry) => sum + Number(entry.listings || 0), 0);
    const working = currentFamily.some(
      (entry) => Number(entry.listings || 0) > 0 && !entry.blocked && !entry.error
    );
    const direct = family.find((entry) => entry.source === "listam") || {};
    const relayReceivedAt = state.relay?.listam?.receivedAt || null;
    const successTimes = family
      .filter((entry) => entry.source !== "listam_relay" || !relayReceivedAt)
      .map((entry) => entry.lastSuccessAt)
      .concat(relayReceivedAt)
      .filter(Boolean)
      .sort();
    merged.push({
      source: "listam",
      label: "List.am",
      listings: catalogCount || scanCount,
      catalogListings: catalogCount,
      lastScanListings: scanCount,
      durationMs: null,
      blocked: Boolean(direct.blocked) && !working,
      probeMode: direct.probeMode || null,
      failStreak: working ? 0 : Number(direct.failStreak || 0),
      degraded: !working,
      stale: !working && catalogCount > 0,
      lastError: working ? null : direct.lastError || (direct.blocked ? "проверка браузера" : "нет свежих данных"),
      lastSuccessAt: successTimes.pop() || null,
    });
  }

  const order = ["listam", "banali", "myrealty", "estate"];
  return [...merged, ...others].sort(
    (a, b) => (order.indexOf(a.source) + 1 || 99) - (order.indexOf(b.source) + 1 || 99)
  );
}

module.exports = {
  CORE_SOURCES,
  DEGRADED_AFTER_FAILS,
  coreSourcesDown,
  isSourceDegraded,
  mergedSourceEntries,
  sourceFailed,
  sourceLabel,
  sourceStatusEntries,
  updateSourceHealth,
};
