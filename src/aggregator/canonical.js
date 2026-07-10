'use strict';

const { AccessBoundaryError } = require('./errors');

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'ld_src',
  'mibextid',
  'ref',
  'refsrc',
  'source',
]);

function isAllowedHostname(hostname, allowedDomains) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return allowedDomains.some((entry) => {
    const allowed = entry.toLowerCase().replace(/\.$/, '');
    if (allowed.startsWith('*.')) {
      return normalized.endsWith(allowed.slice(1)) && normalized !== allowed.slice(2);
    }
    return normalized === allowed;
  });
}

function assertAllowedUrl(value, allowedDomains) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AccessBoundaryError(`Invalid URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AccessBoundaryError(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AccessBoundaryError('URLs containing credentials are not allowed.');
  }
  if (!isAllowedHostname(url.hostname, allowedDomains)) {
    throw new AccessBoundaryError(`Domain ${url.hostname} is outside the source allowlist.`);
  }
  return url;
}

function canonicalizeUrl(value, allowedDomains = null) {
  const url = allowedDomains ? assertAllowedUrl(value, allowedDomains) : new URL(value);
  url.protocol = 'https:';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

module.exports = { assertAllowedUrl, canonicalizeUrl, isAllowedHostname };
