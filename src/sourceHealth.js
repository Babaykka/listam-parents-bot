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

function sourceStatusEntries(state) {
  const sources = state.scanHealth?.sources || {};
  const lastScanSources = state.lastScan?.sources || [];
  const names = new Set([...lastScanSources.map((item) => item.source), ...Object.keys(sources)]);

  return Array.from(names).map((source) => {
    const health = sources[source] || {};
    const scan = lastScanSources.find((item) => item.source === source) || {};
    return {
      source,
      label: sourceLabel(source),
      listings: Number(scan.listings ?? health.lastListings ?? 0),
      durationMs: scan.durationMs ?? health.lastDurationMs ?? null,
      blocked: Boolean(scan.blocked),
      probeMode: scan.probeMode || null,
      failStreak: Number(health.failStreak || 0),
      degraded: Number(health.failStreak || 0) >= DEGRADED_AFTER_FAILS,
      lastError: health.lastError || scan.error || null,
      lastSuccessAt: health.lastSuccessAt || null,
    };
  });
}

module.exports = {
  CORE_SOURCES,
  DEGRADED_AFTER_FAILS,
  coreSourcesDown,
  isSourceDegraded,
  sourceFailed,
  sourceLabel,
  sourceStatusEntries,
  updateSourceHealth,
};
