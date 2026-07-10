'use strict';

function parseRobotsTxt(value, userAgent = '*') {
  const groups = [];
  let current = null;
  for (const sourceLine of String(value || '').split(/\r?\n/)) {
    const line = sourceLine.replace(/#.*$/, '').trim();
    if (!line || !line.includes(':')) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const ruleValue = rest.join(':').trim();
    if (key === 'user-agent') {
      current = { agents: [ruleValue.toLowerCase()], rules: [], crawlDelay: null, sitemaps: [] };
      groups.push(current);
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.rules.push({ type: key, path: ruleValue });
    } else if (current && key === 'crawl-delay') {
      const delay = Number(ruleValue);
      current.crawlDelay = Number.isFinite(delay) ? delay : null;
    } else if (key === 'sitemap') {
      if (current) current.sitemaps.push(ruleValue);
      else groups.push({ agents: [], rules: [], crawlDelay: null, sitemaps: [ruleValue] });
    }
  }
  const requested = userAgent.toLowerCase();
  const matching = groups.filter((group) => group.agents.some((agent) => agent === '*' || requested.includes(agent)));
  const specific = matching.filter((group) => !group.agents.includes('*'));
  const selected = specific.length ? specific : matching;
  return {
    rules: selected.flatMap((group) => group.rules),
    crawlDelay: selected.map((group) => group.crawlDelay).find((delay) => delay !== null) ?? null,
    sitemaps: [...new Set(groups.flatMap((group) => group.sitemaps))],
  };
}

function robotsAllowsPath(policy, pathname) {
  const matching = policy.rules
    .filter((rule) => rule.path && pathname.startsWith(rule.path.replace(/\*.*$/, '')))
    .sort((left, right) => right.path.length - left.path.length);
  return matching.length === 0 || matching[0].type === 'allow';
}

module.exports = { parseRobotsTxt, robotsAllowsPath };
