const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { configureTelegram, handleTelegramUpdate, notifySubscribers, __test: telegramTest } = require("../src/telegram");
const { activeSubscribers, readState, writeState } = require("../src/state");
const freshnessTest = require("../src/listingFreshness");
const { __test: listamTest } = require("../src/listam");
const { __test: myrealtyTest } = require("../src/myrealty");
const { createFakeTelegram, listing, telegramError, testConfig, update } = require("./test_helpers");

async function main() {
  const fake = createFakeTelegram();
  const config = testConfig({ telegramApi: fake.api, telegramBatchSize: 2 });
  const renderYaml = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
  assert.equal(config.myrealtyPagesPerCategory, 5);
  assert.match(renderYaml, /key: MYREALTY_PAGES_PER_CATEGORY\s*\n\s*value: "5"/);
  const state = readState(config);
  state.listings = [
    listing(100001, { kindKey: "apartment", location: "Avan", priceUsd: 90000, rooms: 2 }),
    listing(100002, { kindKey: "apartment", location: "Nor Nork", priceUsd: 105000, rooms: 3 }),
    listing(100003, { kindKey: "house", location: "Abovyan", priceUsd: 115000, rooms: 4, landSqm: 250, floor: null }),
  ];
  state.scanHealth = { blockedStreak: 2, lastIssueAlertAt: null, lastRecoveryAlertAt: null };
  state.nextScanAt = new Date(Date.now() + 30 * 60000).toISOString();
  writeState(config, state);

  await configureTelegram(config, state);
  assert.equal(state.bot.username, "test_listam_bot");
  assert(fake.calls.some((call) => call.method === "setMyCommands"));

  const parsed = listamTest.parseItem(
    {
      href: "https://www.list.am/item/987654",
      text: "$95,000 2 room apartment, 70 sq.m., 2/9 floor Elevator Available major renovation Avan, Yerevan Posted Today 14:30",
    },
    config.categories.find((category) => category.key === "apartment"),
    config
  );
  assert.equal(parsed.id, "987654");
  assert.equal(parsed.priceUsd, 95000);
  assert.equal(parsed.areaSqm, 70);
  assert.equal(parsed.rooms, 2);
  assert.equal(parsed.floor.current, 2);
  assert.equal(parsed.location, "Avan");
  assert.equal(parsed.condition, "ready");
  assert.equal(parsed.url, "https://www.list.am/item/987654");
  assert(parsed.publishedAt, "publishedAt should be parsed from listing text");
  assert.equal(parsed.publishedAtPrecision, "datetime");
  const publishedWithTime = listamTest.parsePublishedDate("Posted Today 14:30", new Date("2026-06-20T08:00:00.000Z"));
  assert.deepEqual(publishedWithTime, { iso: "2026-06-20T10:30:00.000Z", precision: "datetime" });
  const publishedDateOnly = listamTest.parsePublishedDate("Posted 20 Jun 2026", new Date("2026-06-20T08:00:00.000Z"));
  assert.deepEqual(publishedDateOnly, { iso: "2026-06-19T20:00:00.000Z", precision: "date" });
  assert.equal(telegramTest.listingUrl({ id: "123456", url: "https://www.list.am/en/en/item/123456" }), "https://www.list.am/item/123456");
  assert.match(telegramTest.listingLine({ ...listing(123456), url: "https://www.list.am/en/en/item/123456" }), /href="https:\/\/www\.list\.am\/item\/123456"/);
  assert.match(telegramTest.listingLine({ ...listing(123457), publishedAt: parsed.publishedAt }), /опубликовано/);
  assert.equal(
    telegramTest.listingDateDetail({ publishedAt: publishedDateOnly.iso, publishedAtPrecision: publishedDateOnly.precision }),
    "опубликовано 20.06.2026"
  );
  assert.match(telegramTest.listingLine({ ...listing(123458), publishedAt: null }), /найдено ботом/);

  const myrealtyCard = myrealtyTest.parseCard(
    {
      href: "https://myrealty.am/en/3-bedroom/apartment-for-sale/Droi+St/Kanaqer-Zeytun/Yerevan/160778",
      idFromHref: "160778",
      html: `
        <div class="item-list-id"><span>ID 160778</span></div>
        <div class="item-type show-on-list"><span>FOR SALE</span></div>
        <div class="item-property-type"><i></i>Apartment</div>
        <div class="item-price"><i></i>128,000</div>
        <div class="item-date"><label>Added in</label><i></i> 13.04.2026</div>
        <div class="item-date"><label>Edited in</label><i></i> 24.06.2026</div>
        <div class="item-address"><i></i> Droi St, Kanaqer-Zeytun, Yerevan</div>
        <div class="item-sqm"><span>72</span><label>SQ. M.</label></div>
        <div class="item-rooms"><span>3</span><label>Room</label></div>
        <div class="item-floor"><span>4/5</span><label>Floor</label></div>
        <div class="item-short-text-info">newly renovated, heating</div>
      `,
    },
    { ...config, maxPriceUsd: 130000 }
  );
  assert.equal(myrealtyCard.id, "myrealty:160778");
  assert.equal(myrealtyCard.sourceLabel, "MyRealty");
  assert.equal(myrealtyCard.location, "Kanaker-Zeytun");
  assert.equal(myrealtyCard.priceUsd, 128000);
  assert(myrealtyCard.publishedAt, "MyRealty Added in date should be parsed");
  assert(myrealtyCard.updatedAt, "MyRealty Edited in date should be parsed");
  assert.equal(telegramTest.listingUrl(myrealtyCard), "https://myrealty.am/en/3-bedroom/apartment-for-sale/Droi+St/Kanaqer-Zeytun/Yerevan/160778");
  assert.match(telegramTest.listingLine(myrealtyCard), /MyRealty/);
  assert.doesNotMatch(telegramTest.listingLine(myrealtyCard), /sq\.m\.|качество/i);
  assert.match(telegramTest.listingLine(myrealtyCard), /Параметры: 72 м² · 3 комн\. · 4\/5 эт\./);
  assert.match(
    telegramTest.listingDateDetail(myrealtyCard),
    /обновлено 24\.06\.2026, опубликовано 13\.04\.2026/
  );
  assert.equal(
    telegramTest.shouldNotifyListing(config, myrealtyCard, new Date("2026-06-24T12:00:00.000Z")),
    true
  );
  assert.equal(
    telegramTest.shouldNotifyListing(
      config,
      { ...myrealtyCard, updatedAt: null, updatedAtPrecision: null },
      new Date("2026-06-24T12:00:00.000Z")
    ),
    false
  );
  assert.equal(freshnessTest.isSeenListing(config, new Set([myrealtyCard.id]), myrealtyCard, new Date("2026-06-24T12:00:00.000Z")), false);
  assert.equal(
    freshnessTest.isSeenListing(config, new Set([freshnessTest.listingSeenKey(myrealtyCard)]), myrealtyCard, new Date("2026-06-24T12:00:00.000Z")),
    true
  );
  const migratedSeen = freshnessTest.nextSeenIds([myrealtyCard.id], [myrealtyCard], 100);
  assert(!migratedSeen.includes(myrealtyCard.id));
  assert(migratedSeen.includes(freshnessTest.listingSeenKey(myrealtyCard)));

  await handleTelegramUpdate(config, state, update("/start", 101));
  assert.equal(activeSubscribers(state, config).length, 1);
  assert(fake.messages.some((message) => /Что делает этот бот/.test(message.text)));

  await handleTelegramUpdate(config, state, update("/budget 100000", 101));
  await handleTelegramUpdate(config, state, update("/rooms 2-3", 101));
  await handleTelegramUpdate(config, state, update("/areas Avan, Nor Nork", 101));
  await handleTelegramUpdate(config, state, update("/types apartment", 101));
  const subscriber = state.subscribers.find((item) => String(item.id) === "101");
  assert.equal(subscriber.filters.maxPriceUsd, 100000);
  assert.equal(subscriber.filters.minRooms, 2);
  assert.equal(subscriber.filters.maxRooms, 3);
  assert.deepEqual(subscriber.filters.locations, ["Avan", "Nor Nork"]);
  assert.deepEqual(subscriber.filters.categories, ["apartment"]);

  const beforeLatest = fake.messages.length;
  await handleTelegramUpdate(config, state, update("/latest", 101));
  const latestMessages = fake.messages.slice(beforeLatest).map((message) => message.text).join("\n");
  assert.match(latestMessages, /Последние подходящие варианты/);
  assert.match(latestMessages, /Район: Avan/);
  assert.match(latestMessages, /Параметры: 70 м² · 2 комн\./);
  assert.match(latestMessages, /Открыть объявление/);
  assert.doesNotMatch(latestMessages, /Район: Abovyan/);

  state.lastUserScanAt = null;
  let naturalScanCount = 0;
  const beforeNaturalLatest = fake.messages.length;
  await handleTelegramUpdate(config, state, update("отправь все новые публикации", 101), {
    scanNow: () => {
      naturalScanCount += 1;
    },
  });
  const naturalLatestMessages = fake.messages.slice(beforeNaturalLatest).map((message) => message.text).join("\n");
  assert.equal(naturalScanCount, 1);
  assert.match(naturalLatestMessages, /Последние подходящие варианты/);
  assert.match(naturalLatestMessages, /Район: Avan/);
  assert.match(naturalLatestMessages, /Параллельно запускаю проверку List\.am/);
  assert.doesNotMatch(naturalLatestMessages, /Я помогу настроить/);
  state.lastUserScanAt = null;

  await handleTelegramUpdate(config, state, update("привет как пользоваться тобой?", 101));
  assert.match(fake.messages.at(-1).text, /бот для поиска недвижимости/i);

  const compactFilterText = telegramTest.filtersText(config, {
    ...subscriber.filters,
    maxPriceUsd: 120000,
    minAreaSqm: 70,
    maxAreaSqm: null,
    minQualityScore: 0,
    keywords: [],
    excludeKeywords: [],
  });
  assert.match(compactFilterText, /Площадь: от 70 м²/);
  assert.doesNotMatch(compactFilterText, /Комнаты: любой|Ключевые слова: нет|Мин\. качество: 0\/10/);

  config.aiFiltersEnabled = true;
  config.openaiApiKey = "test-openai-key";
  let originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: "completed",
      output_text: JSON.stringify({
        action: "update",
        confidence: 0.9,
        summary: "Только варианты от 70 м²",
        reply: "",
        clear: [],
        patch: {
          minPriceUsd: null,
          maxPriceUsd: null,
          minRooms: null,
          maxRooms: null,
          minAreaSqm: 70,
          maxAreaSqm: 70,
          minLandSqm: null,
          maxLandSqm: null,
          maxPricePerSqm: null,
          minFloor: null,
          maxFloor: null,
          maxDistanceMinutes: null,
          minQualityScore: null,
          locations: null,
          categories: null,
          elevator: "keep",
          condition: "keep",
          keywords: null,
          excludeKeywords: null,
        },
      }),
    }),
  });
  try {
    await handleTelegramUpdate(config, state, update("отправь только публикации 70квм +", 101));
  } finally {
    global.fetch = originalFetch;
    config.aiFiltersEnabled = false;
    config.openaiApiKey = "";
  }
  assert.equal(subscriber.pendingAiFilters.filters.minAreaSqm, 70);
  assert.equal(subscriber.pendingAiFilters.filters.maxAreaSqm, null);
  assert.match(fake.messages.at(-1).text, /Площадь: от 70 м²/);
  assert.doesNotMatch(fake.messages.at(-1).text, /Площадь: 70 м²/);
  delete subscriber.pendingAiFilters;

  subscriber.pendingAiFilters = {
    sourceText: "квартиры и дома от 70 м2 до 130к, Аван",
    summary: "Квартиры и дома от 70 м² до 130000 USD в Avan",
    filters: {
      ...subscriber.filters,
      maxPriceUsd: 130000,
      minAreaSqm: 70,
      locations: ["Avan"],
      categories: ["apartment", "house"],
    },
    createdAt: new Date().toISOString(),
  };
  config.aiFiltersEnabled = true;
  config.openaiApiKey = "test-openai-key";
  originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const requestBody = JSON.parse(init.body);
    const userPayload = JSON.parse(requestBody.input.find((item) => item.role === "user").content);
    assert.equal(userPayload.filterContext.source, "pending");
    assert.equal(userPayload.currentFilters.maxPriceUsd, 130000);
    assert.equal(userPayload.currentFilters.minAreaSqm, 70);
    assert.deepEqual(userPayload.currentFilters.locations, ["Avan"]);
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        output_text: JSON.stringify({
          action: "update",
          confidence: 0.9,
          summary: "Добавить Zovuni к уже выбранным районам",
          reply: "",
          clear: [],
          patch: {
            minPriceUsd: null,
            maxPriceUsd: null,
            minRooms: null,
            maxRooms: null,
            minAreaSqm: null,
            maxAreaSqm: null,
            minLandSqm: null,
            maxLandSqm: null,
            maxPricePerSqm: null,
            minFloor: null,
            maxFloor: null,
            maxDistanceMinutes: null,
            minQualityScore: null,
            locations: ["Zovuni"],
            categories: null,
            elevator: "keep",
            condition: "keep",
            keywords: null,
            excludeKeywords: null,
          },
        }),
      }),
    };
  };
  try {
    await handleTelegramUpdate(config, state, update("Зовуни добавь", 101));
  } finally {
    global.fetch = originalFetch;
    config.aiFiltersEnabled = false;
    config.openaiApiKey = "";
  }
  assert.equal(subscriber.pendingAiFilters.filters.maxPriceUsd, 130000);
  assert.equal(subscriber.pendingAiFilters.filters.minAreaSqm, 70);
  assert.deepEqual(subscriber.pendingAiFilters.filters.locations, ["Avan", "Zovuni"]);

  let manualScanCount = 0;
  const hooks = { scanNow: () => { manualScanCount += 1; } };
  await handleTelegramUpdate(config, state, update("/scan", 101), hooks);
  await handleTelegramUpdate(config, state, update("/scan", 101), hooks);
  assert.equal(manualScanCount, 1);
  assert.match(fake.messages.at(-1).text, /Скан уже запускали недавно/);

  await handleTelegramUpdate(config, state, update("/status", 101));
  assert.match(fake.messages.at(-1).text, /Бот работает/);
  assert.match(fake.messages.at(-1).text, /проверку браузера/);

  await handleTelegramUpdate(config, state, update("/stop", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").active, false);
  await handleTelegramUpdate(config, state, update("/start", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").active, true);

  await handleTelegramUpdate(config, state, update("/start", 202));
  state.subscribers.find((item) => String(item.id) === "202").filters = {
    ...subscriber.filters,
    categories: ["house"],
    locations: ["Abovyan"],
    maxPriceUsd: 120000,
    minRooms: null,
    maxRooms: null,
  };

  const beforeNotify = fake.messages.length;
  await notifySubscribers(config, state, [
    listing(200001, { kindKey: "apartment", location: "Avan", priceUsd: 95000, rooms: 2 }),
    listing(200002, { kindKey: "house", location: "Abovyan", priceUsd: 110000, rooms: 4, landSqm: 300, floor: null }),
  ]);
  const notificationText = fake.messages.slice(beforeNotify).map((message) => `${message.chat_id}:${message.text}`).join("\n");
  assert.match(notificationText, /101:[\s\S]*Район: Avan/);
  assert.match(notificationText, /202:[\s\S]*Район: Abovyan/);
  assert.match(notificationText, /Новые и обновленные варианты/);

  const beforeOldNotify = fake.messages.length;
  await notifySubscribers(config, state, [
    listing(210001, {
      kindKey: "apartment",
      location: "Avan",
      priceUsd: 95000,
      rooms: 2,
      publishedAt: "2026-04-13T20:00:00.000Z",
      publishedAtPrecision: "date",
      updatedAt: null,
      updatedAtPrecision: null,
    }),
  ]);
  assert.equal(fake.messages.length, beforeOldNotify);

  await handleTelegramUpdate(config, state, update("/start", 303));
  fake.failSend = (body) => (String(body.chat_id) === "303" ? telegramError(403, "Forbidden: bot was blocked by the user", 403) : null);
  await notifySubscribers(config, state, [listing(300001, { kindKey: "apartment", location: "Avan", priceUsd: 90000 })]);
  assert.equal(state.subscribers.find((item) => String(item.id) === "303").active, false);

  assert(fake.actions.length > 0);
  console.log("full bot test passed", JSON.stringify({ subscribers: state.subscribers.length, messages: fake.messages.length, actions: fake.actions.length }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
