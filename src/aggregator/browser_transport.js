'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium: defaultChromium } = require('playwright');
const { assertAllowedUrl } = require('./canonical');
const { SecurityChallengeError } = require('./errors');
const { looksLikeSecurityChallenge } = require('./transport');

class BrowserTransport {
  constructor(options) {
    this.allowedDomains = options.allowedDomains;
    this.headless = options.headless ?? true;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.storageStatePath = options.storageStatePath || null;
    this.diagnosticsDirectory = options.diagnosticsDirectory || null;
    this.blockResourceTypes = new Set(options.blockResourceTypes || []);
    this.chromium = options.chromium || defaultChromium;
    this.browser = null;
    this.context = null;
  }

  async ensureContext() {
    if (this.context) return this.context;
    this.browser = await this.chromium.launch({ headless: this.headless });
    const contextOptions = {};
    if (this.storageStatePath && fs.existsSync(this.storageStatePath)) {
      contextOptions.storageState = this.storageStatePath;
    }
    this.context = await this.browser.newContext(contextOptions);
    this.context.setDefaultTimeout(this.timeoutMs);
    if (this.blockResourceTypes.size) {
      await this.context.route('**/*', async (route) => {
        if (this.blockResourceTypes.has(route.request().resourceType())) await route.abort();
        else await route.continue();
      });
    }
    if (this.diagnosticsDirectory) {
      fs.mkdirSync(this.diagnosticsDirectory, { recursive: true });
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    return this.context;
  }

  async open(url, options = {}) {
    const checked = assertAllowedUrl(url, this.allowedDomains).toString();
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(checked, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? this.timeoutMs });
      assertAllowedUrl(page.url(), this.allowedDomains);
      if (options.waitFor) await page.locator(options.waitFor).waitFor({ state: 'visible' });
      const title = await page.title();
      const html = await page.content();
      if (looksLikeSecurityChallenge(`${title}\n${html}`, 'text/html')) {
        throw new SecurityChallengeError('A browser security challenge was detected; collection stopped.', page.url());
      }
      if (options.screenshotPath) {
        const screenshotPath = path.resolve(options.screenshotPath);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }
      return { page, url: page.url(), title, html };
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  async saveStorageState() {
    if (!this.context || !this.storageStatePath) return null;
    const target = path.resolve(this.storageStatePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.context.storageState({ path: target });
    fs.chmodSync(target, 0o600);
    return target;
  }

  async close() {
    if (this.context && this.diagnosticsDirectory) {
      const tracePath = path.join(this.diagnosticsDirectory, `trace-${Date.now()}.zip`);
      await this.context.tracing.stop({ path: tracePath });
    }
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.context = null;
    this.browser = null;
  }
}

module.exports = { BrowserTransport };
