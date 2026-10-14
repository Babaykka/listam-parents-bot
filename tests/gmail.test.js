const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GmailListAmMonitor,
  canonicalListAmItemUrl,
  isGmailConfigured,
  isGmailHealthy,
  parseListAmEmail,
  publicGmailHealth,
  __test,
} = require("../src/gmail");
const { testConfig } = require("../scripts/test_helpers");

function gmailConfig(overrides = {}) {
  return testConfig({
    gmailImapEnabled: true,
    gmailUser: "alerts@example.com",
    gmailAppPassword: "abcd efgh ijkl mnop",
    gmailSender: "post@list.am",
    gmailMailbox: "INBOX",
    ...overrides,
  });
}

test("canonicalizes direct and encoded List.am item links", () => {
  assert.equal(canonicalListAmItemUrl("https://www.list.am/ru/item/23999999?from=email"), "https://www.list.am/item/23999999");
  assert.equal(
    canonicalListAmItemUrl("https://tracking.list.am/click?url=https%3A%2F%2Fwww.list.am%2Fam%2Fitem%2F23888888"),
    "https://www.list.am/item/23888888"
  );
  assert.equal(canonicalListAmItemUrl("https://example.com/item/1"), "");
});

test("parses Russian List.am saved-search cards", () => {
  const html = `
    <html><body><table><tr><td>
      <a href="https://www.list.am/ru/item/23999999?from=email">
        <img src="https://s.list.am/f/1/test.webp">
        Квартира $95,000, 72 кв.м., 3 комн., 4/9 эт., Аван, с ремонтом
      </a>
    </td></tr></table></body></html>`;
  const items = parseListAmEmail(
    { subject: "Новые квартиры", html, text: "", date: new Date("2026-07-10T17:00:00Z") },
    gmailConfig()
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "23999999");
  assert.equal(items[0].kindKey, "apartment");
  assert.equal(items[0].priceUsd, 95000);
  assert.equal(items[0].areaSqm, 72);
  assert.equal(items[0].rooms, 3);
  assert.equal(items[0].floor.label, "4/9");
  assert.equal(items[0].location, "Avan");
  assert.equal(items[0].condition, "ready");
  assert.equal(items[0].sourceChannel, "gmail");
  assert.equal(items[0].imageUrl, "https://s.list.am/f/1/test.webp");
});

test("parses Armenian saved-search text and AMD price", () => {
  const html = `
    <a href="https://www.list.am/am/item/23888888">
      Բնակարան 37,000,000 ֏, 80 ք.մ., 3 սենյակ, 2/9 հարկ, Զովունի
    </a>`;
  const items = parseListAmEmail({ subject: "Նոր բնակարաններ", html, date: new Date("2026-07-10T17:00:00Z") }, gmailConfig());

  assert.equal(items.length, 1);
  assert.equal(items[0].kindKey, "apartment");
  assert.equal(items[0].priceUsd, Math.round(37000000 / 390));
  assert.equal(items[0].areaSqm, 80);
  assert.equal(items[0].rooms, 3);
  assert.equal(items[0].location, "Zovuni");
});

test("uses the Russian saved-search subject to classify houses", () => {
  const html = '<a href="https://www.list.am/ru/item/23777777">$110,000, 120 кв.м., 4 комн., Абовян</a>';
  const items = parseListAmEmail({ subject: "Новые дома", html, date: new Date("2026-07-10T17:00:00Z") }, gmailConfig());
  assert.equal(items.length, 1);
  assert.equal(items[0].kindKey, "house");
  assert.equal(items[0].location, "Abovyan");
});

test("parses image-only cards from the current List.am digest format", () => {
  const html = `
    <table><tr><td>
      <div>Продажа › Квартиры</div>
      <div>Цена: до $120,000; Общая площадь: от 70 кв.м.</div>
      <a href="https://www.list.am/item/23976563?ld_src=11"><img src="https://img.list.am/g/100/example.jpg"></a>
      <a href="https://www.list.am/item/23976605?ld_src=11"><img src="https://img.list.am/g/101/example.jpg"></a>
      <a href="https://www.list.am/category/60?srt=3">Просмотреть</a>
    </td></tr></table>`;
  const items = parseListAmEmail(
    { subject: "Новые объявления", html, date: new Date("2026-07-12T11:24:07Z") },
    gmailConfig()
  );

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.id), ["23976563", "23976605"]);
  assert.equal(items[0].kindKey, "apartment");
  assert.equal(items[0].detailsPending, true);
  assert.equal(items[0].priceUsd, null);
  assert.equal(items[0].priceLabel, "Цена и параметры на List.am");
  assert.equal(items[0].imageUrl, "https://img.list.am/g/100/example.jpg");
  assert.deepEqual(items[0].sourceFilterHints, { maxPriceUsd: 120000, minAreaSqm: 70 });
  assert.equal(items[0].publishedAt, null);
  assert.equal(items[0].emailReceivedAt, "2026-07-12T11:24:07.000Z");
});

test("requires an app password and never exposes it through health", () => {
  const config = gmailConfig();
  assert.equal(isGmailConfigured(config), true);
  assert.equal(__test.normalizeAppPassword(config.gmailAppPassword), "abcdefghijklmnop");
  assert.equal(isGmailConfigured({ ...config, gmailAppPassword: "" }), false);

  const state = { gmail: { lastSuccessAt: new Date().toISOString(), failStreak: 0 } };
  const health = publicGmailHealth(config, state, true);
  assert.equal(health.connected, true);
  assert.equal(isGmailHealthy(config, state), true);
  assert.equal(JSON.stringify(health).includes("abcdefghijklmnop"), false);
  assert.equal(JSON.stringify(health).includes("alerts@example.com"), false);
});

test("monitor checkpoints Gmail UIDs and does not ingest a message twice", async () => {
  const config = gmailConfig();
  const state = {};
  const delivered = [];
  let searches = 0;

  const fakeClient = {
    usable: false,
    mailbox: { uidValidity: 77n, uidNext: 43 },
    on() {},
    async connect() { this.usable = true; },
    async getMailboxLock() { return { release() {} }; },
    async search() { searches += 1; return [42]; },
    async fetchOne() { return { source: Buffer.from("raw"), envelope: { messageId: "mail-42" } }; },
    async logout() { this.usable = false; },
    close() { this.usable = false; },
  };

  const monitor = new GmailListAmMonitor(config, state, {
    logger: { log() {}, warn() {} },
    createClient: () => fakeClient,
    parseMessage: async () => ({
      messageId: "mail-42",
      subject: "Новые квартиры",
      date: new Date("2026-07-10T17:00:00Z"),
      html: '<a href="https://www.list.am/item/23999999">Квартира $95,000, 72 кв.м., 3 комн., Аван</a>',
    }),
    onListings: async (items) => delivered.push(...items),
  });

  const first = await monitor.pollOnce();
  const second = await monitor.pollOnce();

  assert.deepEqual(first, { messages: 1, listings: 1 });
  assert.deepEqual(second, { messages: 0, listings: 0 });
  assert.equal(searches, 1);
  assert.equal(delivered.length, 1);
  assert.equal(state.gmail.lastUid, 42);
  assert.deepEqual(state.gmail.processedMessageIds, ["mail-42"]);
  assert.equal(state.gmail.totalMessages, 1);
  assert.equal(state.gmail.totalListings, 1);
  await monitor.stop();
});
