const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { simpleParser } = require("mailparser");
const { parseListAmEmail } = require("./gmail");

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGES_PER_POLL = 50;

function ensureMailSpoolState(state) {
  state.mailSpool ||= {};
  state.mailSpool.totalMessages = Number(state.mailSpool.totalMessages || 0);
  state.mailSpool.totalListings = Number(state.mailSpool.totalListings || 0);
  state.mailSpool.rejectedMessages = Number(state.mailSpool.rejectedMessages || 0);
  state.mailSpool.failStreak = Number(state.mailSpool.failStreak || 0);
  state.mailSpool.queueDepth = Number(state.mailSpool.queueDepth || 0);
  return state.mailSpool;
}

function isMailSpoolConfigured(config) {
  return Boolean(config.mailSpoolEnabled && config.mailSpoolDir);
}

function publicMailSpoolHealth(config, state) {
  const spool = ensureMailSpoolState(state);
  return {
    enabled: Boolean(config.mailSpoolEnabled),
    configured: isMailSpoolConfigured(config),
    lastPollAt: spool.lastPollAt || null,
    lastSuccessAt: spool.lastSuccessAt || null,
    lastMessageAt: spool.lastMessageAt || null,
    lastListings: Number(spool.lastListings || 0),
    totalMessages: Number(spool.totalMessages || 0),
    totalListings: Number(spool.totalListings || 0),
    rejectedMessages: Number(spool.rejectedMessages || 0),
    queueDepth: Number(spool.queueDepth || 0),
    failStreak: Number(spool.failStreak || 0),
    lastError: spool.lastError || null,
  };
}

function senderAddresses(message) {
  return (message?.from?.value || [])
    .map((entry) => String(entry?.address || "").trim().toLowerCase())
    .filter(Boolean);
}

function authenticationResults(message) {
  const value = message?.headers?.get?.("authentication-results");
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}

function hasTrustedDkim(message, config) {
  const authservId = String(config.mailSpoolAuthservId || "").trim().toLowerCase();
  const domain = String(config.mailSpoolDkimDomain || "list.am").trim().toLowerCase();
  if (!authservId || !domain) return false;

  return authenticationResults(message).some((result) => {
    const normalized = result.toLowerCase().replace(/\s+/g, " ");
    const trustedResult = normalized.startsWith(`${authservId};`) || normalized.startsWith(`${authservId} `);
    const dkimPassed = /(?:^|[;\s])dkim=pass(?:[;\s]|$)/.test(normalized);
    const signedDomain = new RegExp(`header\\.(?:d|i)=@?${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[;\\s]|$)`).test(normalized);
    return trustedResult && dkimPassed && signedDomain;
  });
}

function senderAllowed(message, config) {
  const expected = String(config.gmailSender || "post@list.am").trim().toLowerCase();
  if (!expected || !senderAddresses(message).includes(expected)) return false;
  return !config.mailSpoolRequireDkim || hasTrustedDkim(message, config);
}

async function moveMessage(source, directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, path.basename(source));
  await fsp.rename(source, destination);
}

async function pruneDirectory(directory, retentionDays, now = Date.now()) {
  const maxAgeMs = Math.max(1, Number(retentionDays || 14)) * 86400000;
  let names = [];
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    const stat = await fsp.lstat(filePath).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > maxAgeMs) await fsp.unlink(filePath).catch(() => {});
  }));
}

class ListAmMailSpoolMonitor {
  constructor(config, state, hooks = {}) {
    this.config = config;
    this.state = state;
    this.logger = hooks.logger || console;
    this.onListings = hooks.onListings || (async () => {});
    this.onStateChange = hooks.onStateChange || (() => {});
    this.onHealth = hooks.onHealth || (() => {});
    this.parseMessage = hooks.parseMessage || simpleParser;
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  get incomingDir() {
    return path.join(this.config.mailSpoolDir, "incoming");
  }

  get processedDir() {
    return path.join(this.config.mailSpoolDir, "processed");
  }

  get rejectedDir() {
    return path.join(this.config.mailSpoolDir, "rejected");
  }

  async ensureDirectories() {
    for (const directory of [this.incomingDir, this.processedDir, this.rejectedDir]) {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      await fsp.chmod(directory, 0o700);
    }
  }

  async pollOnce() {
    if (!isMailSpoolConfigured(this.config)) return { messages: 0, listings: 0, disabled: true };
    if (this.running) return { messages: 0, listings: 0, busy: true };
    this.running = true;
    const spool = ensureMailSpoolState(this.state);
    spool.lastPollAt = new Date().toISOString();
    let messageCount = 0;
    let listingCount = 0;

    try {
      await this.ensureDirectories();
      const names = (await fsp.readdir(this.incomingDir))
        .filter((name) => name.endsWith(".eml"))
        .sort()
        .slice(0, MAX_MESSAGES_PER_POLL);
      spool.queueDepth = names.length;

      for (const name of names) {
        const filePath = path.join(this.incomingDir, name);
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MESSAGE_BYTES) {
          await moveMessage(filePath, this.rejectedDir);
          spool.rejectedMessages += 1;
          continue;
        }

        const raw = await fsp.readFile(filePath);
        const message = await this.parseMessage(raw);
        if (!senderAllowed(message, this.config)) {
          await moveMessage(filePath, this.rejectedDir);
          spool.rejectedMessages += 1;
          continue;
        }

        const listings = parseListAmEmail(message, this.config).map((item) => ({
          ...item,
          sourceChannel: "email",
        }));
        if (listings.length > 0) await this.onListings(listings, message);
        await moveMessage(filePath, this.processedDir);
        messageCount += 1;
        listingCount += listings.length;
        spool.totalMessages += 1;
        spool.totalListings += listings.length;
        spool.lastMessageAt = message.date ? new Date(message.date).toISOString() : new Date().toISOString();
        this.onStateChange();
      }

      spool.queueDepth = Math.max(0, spool.queueDepth - messageCount);
      spool.lastSuccessAt = new Date().toISOString();
      spool.lastListings = listingCount;
      spool.failStreak = 0;
      spool.lastError = null;
      this.onHealth({ ok: true, messages: messageCount, listings: listingCount });
      this.onStateChange();
      await Promise.all([
        pruneDirectory(this.processedDir, this.config.mailSpoolRetentionDays),
        pruneDirectory(this.rejectedDir, this.config.mailSpoolRetentionDays),
      ]);
      if (messageCount > 0) this.logger.log(`[mail-spool] processed ${messageCount} message(s), ${listingCount} listing(s)`);
      return { messages: messageCount, listings: listingCount };
    } catch (error) {
      spool.failStreak += 1;
      spool.lastError = String(error.message || error).slice(0, 240);
      this.onHealth({ ok: false, error: spool.lastError, messages: 0, listings: 0 });
      this.onStateChange();
      throw error;
    } finally {
      this.running = false;
    }
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      let nextDelay = Number(this.config.mailSpoolPollSeconds || 15) * 1000;
      try {
        await this.pollOnce();
      } catch (error) {
        nextDelay = Math.min(300000, Math.max(30000, nextDelay * 2));
        this.logger.warn(`[mail-spool] poll failed; retry scheduled: ${error.message}`);
      }
      this.schedule(nextDelay);
    }, Math.max(0, delayMs));
  }

  start() {
    if (!isMailSpoolConfigured(this.config)) return false;
    this.stopped = false;
    this.schedule(1000);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = {
  ListAmMailSpoolMonitor,
  ensureMailSpoolState,
  isMailSpoolConfigured,
  publicMailSpoolHealth,
  __test: {
    MAX_MESSAGE_BYTES,
    pruneDirectory,
    senderAddresses,
    senderAllowed,
    authenticationResults,
    hasTrustedDkim,
  },
};
