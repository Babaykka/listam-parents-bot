const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { load } = require("cheerio");
const { parseListAmItem } = require("./listam");
const { normalizeText, unique } = require("./utils");

const MAX_MESSAGES_PER_POLL = 50;
const MAX_LISTINGS_PER_MESSAGE = 100;
const MAX_PROCESSED_MESSAGE_IDS = 1000;

function normalizeAppPassword(value) {
  return String(value || "").replace(/\s+/g, "");
}

function isGmailConfigured(config) {
  return Boolean(config.gmailImapEnabled && config.gmailUser && normalizeAppPassword(config.gmailAppPassword));
}

function ensureGmailState(state) {
  state.gmail ||= {};
  state.gmail.lastUid = Number(state.gmail.lastUid || 0);
  state.gmail.uidValidity = state.gmail.uidValidity || null;
  state.gmail.processedMessageIds = Array.isArray(state.gmail.processedMessageIds) ? state.gmail.processedMessageIds : [];
  state.gmail.failStreak = Number(state.gmail.failStreak || 0);
  state.gmail.totalMessages = Number(state.gmail.totalMessages || 0);
  state.gmail.totalListings = Number(state.gmail.totalListings || 0);
  return state.gmail;
}

function canonicalListAmItemUrl(value) {
  let decoded = String(value || "").replace(/&amp;/g, "&").trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  const match = decoded.match(/https?:\/\/(?:www\.)?list\.am\/(?:ru|en|am|hy)?\/?item\/(\d+)/i)
    || decoded.match(/^\/(?:ru|en|am|hy)?\/?item\/(\d+)/i);
  return match ? `https://www.list.am/item/${match[1]}` : "";
}

function candidateId(candidate) {
  return canonicalListAmItemUrl(candidate?.href).match(/\/item\/(\d+)/)?.[1] || "";
}

function looksLikePrice(text) {
  return /(?:\$\s*[\d\s,.]+|€\s*[\d\s,.]+|[\d\s,.]+\s*(?:֏|AMD|դրամ|драм))/i.test(text);
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /^data:/i.test(raw)) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:/i, "https:");
  return null;
}

function bestCardContainer($, anchor) {
  let node = $(anchor);
  let best = node;
  for (let depth = 0; depth < 7; depth += 1) {
    const text = normalizeText(node.text());
    if (text.length >= 20 && text.length <= 1600 && looksLikePrice(text)) {
      best = node;
      break;
    }
    const parent = node.parent();
    if (!parent.length || parent.is("body") || parent.is("html")) break;
    node = parent;
  }
  return best;
}

function extractHtmlCandidates(html) {
  if (!html) return [];
  const $ = load(String(html));
  const byId = new Map();

  $("a[href]").each((_, anchor) => {
    const href = canonicalListAmItemUrl($(anchor).attr("href"));
    if (!href) return;
    const id = href.match(/\/item\/(\d+)/)?.[1];
    if (!id) return;

    const container = bestCardContainer($, anchor);
    const image = container.find("img").toArray().map((img) =>
      normalizeImageUrl(
        $(img).attr("data-src") ||
          $(img).attr("data-original") ||
          String($(img).attr("srcset") || "").split(",")[0].trim().split(/\s+/)[0] ||
          $(img).attr("src")
      )
    ).find(Boolean);
    const candidate = {
      href,
      text: normalizeText(container.text()),
      imageUrl: image || null,
    };
    const previous = byId.get(id);
    if (!previous || candidate.text.length > previous.text.length || (!previous.imageUrl && candidate.imageUrl)) {
      byId.set(id, { ...previous, ...candidate, imageUrl: candidate.imageUrl || previous?.imageUrl || null });
    }
  });

  return Array.from(byId.values());
}

function extractTextCandidates(text) {
  const value = String(text || "");
  const matches = Array.from(value.matchAll(/https?:\/\/(?:www\.)?list\.am\/(?:ru|en|am|hy)?\/?item\/\d+[^\s<>)\]]*/gi));
  const byId = new Map();
  for (const match of matches) {
    const href = canonicalListAmItemUrl(match[0]);
    const id = href.match(/\/item\/(\d+)/)?.[1];
    if (!id) continue;
    const start = Math.max(0, match.index - 500);
    const end = Math.min(value.length, match.index + match[0].length + 500);
    byId.set(id, { href, text: normalizeText(value.slice(start, end)), imageUrl: null });
  }
  return Array.from(byId.values());
}

function mergeCandidates(...groups) {
  const byId = new Map();
  for (const candidate of groups.flat()) {
    const id = candidateId(candidate);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, candidate);
      continue;
    }
    byId.set(id, {
      href: existing.href || candidate.href,
      text: candidate.text.length > existing.text.length ? candidate.text : existing.text,
      imageUrl: existing.imageUrl || candidate.imageUrl || null,
    });
  }
  return Array.from(byId.values());
}

function categoryOrder(config, text) {
  const haystack = String(text || "").toLowerCase();
  const apartment = /\b(?:apartment|flat)\b|квартир|բնակարան/.test(haystack);
  const house = /\b(?:house|home|villa|townhouse)\b|коттедж|дач|таунхаус|առանձնատուն/.test(haystack)
    || /(?:^|[^\p{L}])дом(?:а|ов)?(?:$|[^\p{L}])/u.test(haystack);
  const categories = config.categories || [];
  const preferred = apartment && !house ? "apartment" : house && !apartment ? "house" : null;
  if (!preferred) return categories;
  return [...categories.filter((item) => item.key === preferred), ...categories.filter((item) => item.key !== preferred)];
}

function parseListAmEmail(message, config) {
  const subject = normalizeText(message?.subject);
  const text = normalizeText(message?.text);
  const candidates = mergeCandidates(extractHtmlCandidates(message?.html), extractTextCandidates(text));
  const listings = [];

  for (const candidate of candidates.slice(0, MAX_LISTINGS_PER_MESSAGE)) {
    const parseText = normalizeText(candidate.text);
    for (const category of categoryOrder(config, `${parseText} ${subject}`)) {
      const item = parseListAmItem({ ...candidate, text: parseText }, category, config);
      if (!item) continue;
      item.sourceChannel = "gmail";
      item.emailReceivedAt = message?.date ? new Date(message.date).toISOString() : null;
      if (item.emailReceivedAt) item.scannedAt = item.emailReceivedAt;
      listings.push(item);
      break;
    }
  }

  const seen = new Set();
  return listings.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function publicGmailHealth(config, state, connected = false) {
  const gmail = ensureGmailState(state);
  return {
    enabled: Boolean(config.gmailImapEnabled),
    configured: isGmailConfigured(config),
    connected: Boolean(connected),
    lastPollAt: gmail.lastPollAt || null,
    lastSuccessAt: gmail.lastSuccessAt || null,
    lastMessageAt: gmail.lastMessageAt || null,
    lastListings: Number(gmail.lastListings || 0),
    totalListings: Number(gmail.totalListings || 0),
    failStreak: Number(gmail.failStreak || 0),
    lastError: gmail.lastError || null,
  };
}

function isGmailHealthy(config, state, now = new Date()) {
  if (!isGmailConfigured(config)) return false;
  const lastSuccess = Date.parse(state.gmail?.lastSuccessAt || "");
  if (!Number.isFinite(lastSuccess)) return false;
  const maxAgeMs = Math.max(5 * 60 * 1000, Number(config.gmailPollSeconds || 60) * 5 * 1000);
  return now.getTime() - lastSuccess <= maxAgeMs && Number(state.gmail?.failStreak || 0) < 3;
}

class GmailListAmMonitor {
  constructor(config, state, hooks = {}) {
    this.config = config;
    this.state = state;
    this.logger = hooks.logger || console;
    this.onListings = hooks.onListings || (async () => {});
    this.onStateChange = hooks.onStateChange || (() => {});
    this.onHealth = hooks.onHealth || (() => {});
    this.createClient = hooks.createClient || (() => new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: config.gmailUser,
        pass: normalizeAppPassword(config.gmailAppPassword),
      },
      logger: false,
      socketTimeout: Math.max(60_000, Number(config.gmailSocketTimeoutMs || 180_000)),
    }));
    this.parseMessage = hooks.parseMessage || simpleParser;
    this.client = null;
    this.timer = null;
    this.running = false;
    this.stopped = false;
  }

  get connected() {
    return Boolean(this.client?.usable);
  }

  async ensureClient() {
    if (this.connected) return this.client;
    if (this.client) this.client.close();
    this.client = this.createClient();
    this.client.on?.("error", (error) => this.logger.warn(`[gmail] connection issue: ${error.message}`));
    await this.client.connect();
    this.logger.log("[gmail] connected");
    return this.client;
  }

  async closeClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }

  async pollOnce() {
    if (!isGmailConfigured(this.config)) return { messages: 0, listings: 0, disabled: true };
    if (this.running) return { messages: 0, listings: 0, busy: true };
    this.running = true;
    const gmail = ensureGmailState(this.state);
    gmail.lastPollAt = new Date().toISOString();
    let lock;
    let messageCount = 0;
    let listingCount = 0;

    try {
      const client = await this.ensureClient();
      lock = await client.getMailboxLock(this.config.gmailMailbox || "INBOX", { readOnly: true });
      const uidValidity = String(client.mailbox?.uidValidity || "");
      if (gmail.uidValidity && uidValidity && gmail.uidValidity !== uidValidity) {
        gmail.lastUid = 0;
        gmail.processedMessageIds = [];
      }
      if (uidValidity) gmail.uidValidity = uidValidity;

      const uidNext = Number(client.mailbox?.uidNext || 0);
      let uids = [];
      if (!gmail.lastUid) {
        const since = new Date(Date.now() - Number(this.config.gmailLookbackDays || 14) * 86400000);
        uids = (await client.search({ from: this.config.gmailSender, since }, { uid: true })) || [];
      } else if (!uidNext || gmail.lastUid < uidNext - 1) {
        uids = (await client.search({ from: this.config.gmailSender, uid: `${gmail.lastUid + 1}:*` }, { uid: true })) || [];
      }

      const processed = new Set(gmail.processedMessageIds);
      const sortedUids = unique(uids.map(Number).filter(Number.isFinite)).sort((a, b) => a - b).slice(0, MAX_MESSAGES_PER_POLL);
      for (const uid of sortedUids) {
        const fetched = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true }, { uid: true });
        gmail.lastUid = Math.max(gmail.lastUid, uid);
        if (!fetched?.source) continue;

        const parsed = await this.parseMessage(fetched.source);
        const messageId = normalizeText(parsed.messageId || fetched.envelope?.messageId || `uid:${uid}`);
        if (processed.has(messageId)) continue;

        const listings = parseListAmEmail(parsed, this.config);
        if (listings.length > 0) await this.onListings(listings, parsed);
        processed.add(messageId);
        messageCount += 1;
        listingCount += listings.length;
        gmail.lastMessageAt = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();
        gmail.processedMessageIds = Array.from(processed).slice(-MAX_PROCESSED_MESSAGE_IDS);
        this.onStateChange();
      }

      gmail.lastSuccessAt = new Date().toISOString();
      gmail.lastError = null;
      gmail.failStreak = 0;
      gmail.lastListings = listingCount;
      gmail.totalMessages += messageCount;
      gmail.totalListings += listingCount;
      this.onHealth({ ok: true, messages: messageCount, listings: listingCount });
      this.onStateChange();
      if (messageCount > 0) this.logger.log(`[gmail] processed ${messageCount} message(s), ${listingCount} listing(s)`);
      return { messages: messageCount, listings: listingCount };
    } catch (error) {
      gmail.failStreak += 1;
      gmail.lastError = String(error.message || error).slice(0, 240);
      this.onHealth({ ok: false, error: gmail.lastError, messages: 0, listings: 0 });
      this.onStateChange();
      await this.closeClient();
      throw error;
    } finally {
      lock?.release();
      this.running = false;
    }
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      let nextDelay = Number(this.config.gmailPollSeconds || 60) * 1000;
      try {
        await this.pollOnce();
      } catch (error) {
        const failStreak = Number(this.state.gmail?.failStreak || 1);
        nextDelay = Math.min(
          Number(this.config.gmailRetryMaxSeconds || 900) * 1000,
          Math.max(30_000, 30_000 * 2 ** Math.min(failStreak - 1, 5))
        );
        this.logger.warn(`[gmail] poll failed; retry scheduled: ${error.message}`);
      }
      this.schedule(nextDelay);
    }, Math.max(0, delayMs));
  }

  start() {
    if (!isGmailConfigured(this.config)) return false;
    this.stopped = false;
    this.schedule(1000);
    return true;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.closeClient();
  }
}

module.exports = {
  GmailListAmMonitor,
  canonicalListAmItemUrl,
  ensureGmailState,
  isGmailConfigured,
  isGmailHealthy,
  parseListAmEmail,
  publicGmailHealth,
  __test: {
    categoryOrder,
    extractHtmlCandidates,
    extractTextCandidates,
    mergeCandidates,
    normalizeAppPassword,
  },
};
