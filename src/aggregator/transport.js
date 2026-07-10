'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assertAllowedUrl } = require('./canonical');
const { HttpStatusError, SecurityChallengeError } = require('./errors');

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - now);
}

function looksLikeSecurityChallenge(body, contentType = '') {
  if (!/text\/html/i.test(contentType)) return false;
  const sample = String(body || '').slice(0, 100000).toLowerCase();
  return sample.includes('just a moment')
    || sample.includes('cf-chl-')
    || sample.includes('captcha')
    || sample.includes('security challenge')
    || sample.includes('verify you are human');
}

class HttpTransport {
  constructor(options) {
    this.allowedDomains = options.allowedDomains;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.retries = options.retries ?? 2;
    this.delayMs = options.delayMs ?? 0;
    this.cacheDirectory = options.cacheDirectory || null;
    this.cacheTtlMs = options.cacheTtlMs ?? 300000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.lastRequestAt = 0;
    this.userAgent = options.userAgent || 'ArmeniaRealEstateAggregator/1.0';
  }

  cachePath(url) {
    const digest = crypto.createHash('sha256').update(url).digest('hex');
    return path.join(this.cacheDirectory, `${digest}.json`);
  }

  async readCache(url) {
    if (!this.cacheDirectory) return null;
    try {
      return JSON.parse(await fs.readFile(this.cachePath(url), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeCache(url, response) {
    if (!this.cacheDirectory) return;
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const payload = {
      url: response.url,
      body: response.body,
      contentType: response.contentType,
      etag: response.etag,
      lastModified: response.lastModified,
      fetchedAt: new Date(this.now()).toISOString(),
    };
    await fs.writeFile(this.cachePath(url), JSON.stringify(payload), { mode: 0o600 });
  }

  async waitForRateLimit() {
    const elapsed = this.now() - this.lastRequestAt;
    if (this.lastRequestAt && elapsed < this.delayMs) await this.sleep(this.delayMs - elapsed);
    this.lastRequestAt = this.now();
  }

  async fetchFollowingAllowedRedirects(url, options) {
    let current = assertAllowedUrl(url, this.allowedDomains).toString();
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await this.waitForRateLimit();
      const response = await this.fetchImpl(current, { ...options, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) throw new HttpStatusError('Redirect response did not include Location.', response.status, current, false);
      current = assertAllowedUrl(new URL(location, current).toString(), this.allowedDomains).toString();
    }
    throw new HttpStatusError('Too many redirects.', 310, current, false);
  }

  async getText(url, options = {}) {
    const checkedUrl = assertAllowedUrl(url, this.allowedDomains).toString();
    const cached = options.cache === false ? null : await this.readCache(checkedUrl);
    if (cached && this.now() - Date.parse(cached.fetchedAt) < this.cacheTtlMs) {
      return { ...cached, status: 200, fromCache: true };
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      const headers = {
        Accept: options.accept || '*/*',
        'User-Agent': this.userAgent,
        ...(options.headers || {}),
      };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
      try {
        const response = await this.fetchFollowingAllowedRedirects(checkedUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.status === 304 && cached) {
          cached.fetchedAt = new Date(this.now()).toISOString();
          await this.writeCache(checkedUrl, cached);
          return { ...cached, status: 200, fromCache: true };
        }
        if (response.status === 401 || response.status === 403) {
          throw new SecurityChallengeError(`Access stopped with HTTP ${response.status}.`, response.url || checkedUrl);
        }
        if (response.status === 429 || response.status >= 500) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
          throw new HttpStatusError(
            `Temporary HTTP ${response.status} from ${checkedUrl}.`,
            response.status,
            response.url || checkedUrl,
            true,
            retryAfterMs,
          );
        }
        if (!response.ok) {
          throw new HttpStatusError(
            `Permanent HTTP ${response.status} from ${checkedUrl}.`,
            response.status,
            response.url || checkedUrl,
            false,
          );
        }
        const length = Number(response.headers.get('content-length') || 0);
        if (length > this.maxResponseBytes) {
          throw new HttpStatusError(`Response exceeds ${this.maxResponseBytes} bytes.`, 413, checkedUrl, false);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > this.maxResponseBytes) {
          throw new HttpStatusError(`Response exceeds ${this.maxResponseBytes} bytes.`, 413, checkedUrl, false);
        }
        const body = buffer.toString('utf8');
        const contentType = response.headers.get('content-type') || '';
        if (looksLikeSecurityChallenge(body, contentType)) {
          throw new SecurityChallengeError('A CAPTCHA or security challenge was detected; collection stopped.', response.url || checkedUrl);
        }
        const result = {
          url: response.url || checkedUrl,
          status: response.status,
          body,
          contentType,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          fetchedAt: new Date(this.now()).toISOString(),
          fromCache: false,
        };
        if (options.cache !== false) await this.writeCache(checkedUrl, result);
        return result;
      } catch (error) {
        clearTimeout(timeout);
        const normalized = error.name === 'AbortError'
          ? new HttpStatusError(`Request timed out after ${options.timeoutMs ?? this.timeoutMs} ms.`, 408, checkedUrl, true)
          : error;
        lastError = normalized;
        if (!normalized.retriable || attempt >= this.retries) throw normalized;
        const backoff = normalized.retryAfterMs ?? Math.round((250 * (2 ** attempt)) + this.random() * 200);
        await this.sleep(backoff);
      }
    }
    throw lastError;
  }

  async getJson(url, options = {}) {
    const response = await this.getText(url, { ...options, accept: 'application/json' });
    return { ...response, data: JSON.parse(response.body) };
  }
}

module.exports = { HttpTransport, looksLikeSecurityChallenge, parseRetryAfter };
