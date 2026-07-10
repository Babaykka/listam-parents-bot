'use strict';

function buildDiscoveryReport(config, groups) {
  return {
    generated_at: new Date().toISOString(),
    sources: Object.entries(config.sources).map(([name, source]) => ({
      name,
      status: source.status,
      access_method: source.access_method,
      base_url: source.base_url,
      robots_url: source.robots_url || null,
      terms_url: source.terms_url || null,
      reason: source.reason,
      feeds: (source.feeds || []).map((feed) => feed.url),
    })),
    facebook_groups: {
      configured: groups.length,
      statuses: groups.reduce((counts, group) => {
        counts[group.status] = (counts[group.status] || 0) + 1;
        return counts;
      }, {}),
      canonical_urls_resolved: groups.filter((group) => group.canonical_url).length,
      canonical_urls_unresolved: groups.filter((group) => !group.canonical_url).length,
    },
  };
}

module.exports = { buildDiscoveryReport };
