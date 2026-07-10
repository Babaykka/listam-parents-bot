const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { configureTelegram, handleTelegramUpdate, notifySubscribers, __test: telegramTest } = require("../src/telegram");
const { activeSubscribers, readState, writeState } = require("../src/state");
const freshnessTest = require("../src/listingFreshness");
const { __test: banaliTest } = require("../src/banali");
const { dedupeListings, isLikelyDuplicate } = require("../src/dedupe");
const { mergeListings, priceDropPercent, visibleListings } = require("../src/listingStore");
const { computeBaselines, explainListing, valueScore } = require("../src/ranking");
const { coreSourcesDown, isSourceDegraded, mergedSourceEntries, sourceStatusEntries, updateSourceHealth } = require("../src/sourceHealth");
const { relayFallbackResult, sanitizeIngestPayload, storeRelayListings } = require("../src/ingest");
const { listingsApiPayload, publicListingView, shortDescription } = require("../src/api");
const { localizeDescription } = require("../src/localize");
const { __test: estateTest } = require("../src/estate");
const { looksLikeListingPost, parseForwardedListing } = require("../src/forwarded");
const { extractOgImage, isBackfillEligible } = require("../src/imageBackfill");
const { __test: listamFeedTest } = require("../src/listamFeed");
const { __test: listamTest } = require("../src/listam");
const { __test: myrealtyTest } = require("../src/myrealty");
const { callbackUpdate, createFakeTelegram, listing, telegramError, testConfig, update } = require("./test_helpers");

async function main() {
  const fake = createFakeTelegram();
  const config = testConfig({ telegramApi: fake.api, telegramBatchSize: 2 });
  const renderYaml = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
  assert.equal(config.myrealtyPagesPerCategory, 5);
  assert.equal(config.estateFallbackEnabled, true);
  assert.equal(config.banaliFallbackEnabled, true);
  assert.equal(config.banaliPagesPerCategory, 5);
  assert.equal(config.listamQuickChallengeWaitSeconds, 1);
  assert.deepEqual(config.listamFeedUrls, []);
  assert.match(renderYaml, /key: MYREALTY_PAGES_PER_CATEGORY\s*\n\s*value: "7"/);
  assert.match(renderYaml, /key: ESTATE_FALLBACK_ENABLED\s*\n\s*value: "true"/);
  assert.match(renderYaml, /key: BANALI_FALLBACK_ENABLED\s*\n\s*value: "true"/);
  assert.match(renderYaml, /key: BANALI_PAGES_PER_CATEGORY\s*\n\s*value: "8"/);
  assert.match(renderYaml, /key: LISTAM_QUICK_CHALLENGE_MAX_SECONDS\s*\n\s*value: "8"/);
  assert.match(renderYaml, /key: LISTAM_FEED_URLS\s*\n\s*value: ""/);
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
  const commandsCall = fake.calls.find((call) => call.method === "setMyCommands");
  assert(commandsCall);
  const menuCommands = commandsCall.body.commands.map((entry) => entry.command);
  assert(menuCommands.length <= 9, `menu must stay minimal, got ${menuCommands.length}`);
  assert(menuCommands.includes("app"));
  assert(menuCommands.includes("add"));
  assert(!menuCommands.includes("budget"), "manual filter commands must be hidden from the menu");

  const parsed = listamTest.parseItem(
    {
      href: "https://www.list.am/item/987654",
      text: "$95,000 2 room apartment, 70 sq.m., 2/9 floor Elevator Available major renovation Avan, Yerevan Posted Today 14:30",
      imageUrl: "http://s.list.am/f/123/12345678.webp",
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
  assert.equal(parsed.imageUrl, "https://s.list.am/f/123/12345678.webp", "thumbnail must be kept and upgraded to https");
  assert.equal(listamTest.normalizeImageUrl("//s.list.am/f/1/2.webp"), "https://s.list.am/f/1/2.webp", "protocol-relative thumbnails must resolve to https");
  assert.equal(listamTest.normalizeImageUrl("http://img.list.am/a/b.jpg"), "https://img.list.am/a/b.jpg");
  assert.equal(listamTest.normalizeImageUrl("data:image/gif;base64,AAAA"), null, "placeholder data URIs must be dropped");
  assert.equal(listamTest.normalizeImageUrl(""), null);
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

  const feedJsonItems = listamFeedTest.parseFeedText(
    JSON.stringify({
      listings: [
        {
          id: "765432",
          title: "$99,000 3 room apartment, 75 sq.m., 2/9 floor Elevator Available Avan, Yerevan Posted Today 10:00",
        },
      ],
    }),
    config
  );
  assert.equal(feedJsonItems.length, 1);
  assert.equal(feedJsonItems[0].id, "765432");
  assert.equal(feedJsonItems[0].sourceLabel, "List.am");
  assert.equal(feedJsonItems[0].location, "Avan");
  assert.equal(feedJsonItems[0].areaSqm, 75);

  const feedXmlItems = listamFeedTest.parseFeedText(
    `
      <rss><channel><item>
        <link>https://www.list.am/item/765433</link>
        <title><![CDATA[$115,000 4 room house, 120 sq.m., Abovyan, Kotayk Posted Yesterday 16:20]]></title>
        <description><![CDATA[individual heating, natural gas]]></description>
      </item></channel></rss>
    `,
    config
  );
  assert.equal(feedXmlItems.length, 1);
  assert.equal(feedXmlItems[0].id, "765433");
  assert.equal(feedXmlItems[0].kindKey, "house");
  assert.equal(feedXmlItems[0].location, "Abovyan");

  const myrealtyBlocks = myrealtyTest.cardBlocks(`
    <a href="https://myrealty.am/en/x/160778" target="_blank" class="image"><div class="thumb-image">
      <img src="https://myrealty.am/site/assets/images/no-img.jpg" class="no-img" alt="">
      <img data-src="https://myrealty.am/images/a5/73/photo_600x460.jpeg" class="thumb-img" alt="x">
    </div></a>
    <figcaption class="figure-caption d-flex flex-column">card body</figcaption>
  `);
  assert.equal(myrealtyBlocks.length, 1);
  assert.equal(myrealtyBlocks[0].imageUrl, "https://myrealty.am/images/a5/73/photo_600x460.jpeg");

  const myrealtyCard = myrealtyTest.parseCard(
    {
      href: "https://myrealty.am/en/3-bedroom/apartment-for-sale/Droi+St/Kanaqer-Zeytun/Yerevan/160778",
      idFromHref: "160778",
      imageUrl: "https://myrealty.am/images/a5/73/photo_600x460.jpeg",
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
  assert.equal(myrealtyCard.imageUrl, "https://myrealty.am/images/a5/73/photo_600x460.jpeg");
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

  const estateCard = estateTest.parseEntry(
    `
      <id>http://www.estate.am/en/3-rooms-apartment-sale-in-zovuni-d122999</id>
      <title><![CDATA[Apartment, 3 room, Zovuni, Kotayk - 46,800,000 Դ]]></title>
      <updated>2026-07-01T10:15:00+04:00</updated>
      <link rel="alternate" href="http://www.estate.am/en/3-rooms-apartment-sale-in-zovuni-d122999"/>
      <summary><![CDATA[Zovuni, 72 m2, floor 3/9, 3 room, 46,800,000 Դ]]></summary>
      <content type="html"><![CDATA[<img src="/media/cache/photo/uploads/1.jpg" alt=""/> The apartment has been completely renovated. The building is equipped with an elevator.]]></content>
    `,
    config
  );
  assert.equal(estateCard.id, "estate:122999");
  assert.equal(estateCard.sourceLabel, "Estate.am");
  assert.equal(estateCard.location, "Zovuni");
  assert.equal(estateCard.priceUsd, 120000);
  assert.equal(estateCard.areaSqm, 72);
  assert.equal(estateCard.rooms, 3);
  assert.equal(estateCard.floor.label, "3/9");
  assert.equal(estateCard.condition, "ready");
  assert.equal(estateCard.elevator, true);
  assert.equal(estateCard.imageUrl, "https://www.estate.am/media/cache/photo/uploads/1.jpg");
  assert.equal(telegramTest.listingUrl(estateCard), "https://www.estate.am/en/3-rooms-apartment-sale-in-zovuni-d122999");
  assert.match(telegramTest.listingLine(estateCard), /Estate\.am/);
  assert.match(telegramTest.listingDateDetail(estateCard), /обновлено 01\.07\.2026/);
  const expensiveEstateXml = `
      <id>https://www.estate.am/en/apartment-d123000</id>
      <title>Apartment, 3 room, Arabkir, Yerevan - 300,000 $</title>
      <updated>2026-07-01T10:15:00+04:00</updated>
      <link rel="alternate" href="https://www.estate.am/en/apartment-d123000"/>
      <summary>Yerevan, Arabkir, 90 m2, floor 3/9, 3 room, 300,000 $</summary>
    `;
  const expensiveEstate = estateTest.parseEntry(expensiveEstateXml, { ...config, estateCollectAll: true });
  assert(expensiveEstate, "complete Estate RSS mode keeps listings above the default subscriber budget");
  assert.equal(
    telegramTest.matchesSubscriber(config, { filters: {} }, expensiveEstate),
    false,
    "subscriber budget still filters an expensive listing after collection"
  );
  assert.equal(
    estateTest.parseEntry(expensiveEstateXml, { ...config, estateCollectAll: false }),
    null,
    "legacy filtered mode still enforces the scanner budget"
  );

  const banaliHouse = banaliTest.parsePost(
    {
      id: "42e6a13e-bcc8-47c3-997a-c3d1ca203c04",
      deal: "sell",
      publicCode: "H47316",
      propertyType: "house",
      price: ["45000000"],
      priceFull: [{ price: "45000000", currency: "051" }],
      publishedAt: "2026-05-06T07:18:25.000000Z",
      updatedToTop: "2026-06-30T05:00:01.000000Z",
      address: "Yerevan, Arabkir",
      district: "Arabkir",
      rooms: ["3"],
      floor: [null],
      buildingFloors: "1",
      area: ["81"],
      heating: [["heating_central"]],
      structureType: "new_building",
      image: "/storage/entity_media/84281b43/16945224181.jpg",
      slug: { en: "sell/house/3-rooms/Yerevan/Arabkir/-H47316" },
    },
    config
  );
  assert.equal(banaliHouse.id, "banali:H47316");
  assert.equal(banaliHouse.sourceLabel, "Banali.am");
  assert.equal(banaliHouse.location, "Arabkir");
  assert.equal(banaliHouse.priceUsd, 115385);
  assert.equal(banaliHouse.areaSqm, 81);
  assert.equal(banaliHouse.rooms, 3);
  assert.equal(banaliHouse.floor, null);
  assert.equal(banaliHouse.imageUrl, "https://banali.am/storage/entity_media/84281b43/16945224181.jpg");
  assert.equal(telegramTest.listingUrl(banaliHouse), "https://banali.am/en/sell/house/3-rooms/Yerevan/Arabkir/-H47316");
  assert.match(telegramTest.listingLine(banaliHouse), /Banali\.am/);
  assert.match(
    telegramTest.listingDateDetail(banaliHouse),
    /обновлено 30\.06\.2026, 09:00, опубликовано 06\.05\.2026, 11:18/
  );

  const banaliSuburb = banaliTest.parsePost(
    {
      id: "7c2",
      deal: "sell",
      publicCode: "H46520",
      propertyType: "house",
      price: ["110000"],
      priceFull: [{ price: "110000", currency: "840" }],
      publishedAt: "2026-03-13T11:29:33.000000Z",
      updatedToTop: "2026-06-29T07:10:55.000000Z",
      address: "Kotayk, Zovuni",
      district: "Zovuni",
      rooms: ["5"],
      area: ["132"],
      slug: { en: "sell/house/5-rooms/Kotayk/Zovuni/-H46520" },
    },
    config
  );
  assert.equal(banaliSuburb.id, "banali:H46520");
  assert.equal(banaliSuburb.location, "Zovuni");
  assert.equal(banaliSuburb.priceUsd, 110000);
  assert.equal(banaliSuburb.minutesToCenter, 24);
  assert.deepEqual(
    banaliTest.priceBucketsForConfig({ minPriceUsd: 0, maxPriceUsd: 120000 }),
    ["usd~lt_40000", "usd~gte_40000-lte_60000", "usd~gte_60001-lte_80000", "usd~gte_80001-lte_100000", "usd~gte_100001-lte_150000"]
  );

  const banaliOriginal = listing("banali:D100", {
    kindKey: "apartment",
    location: "Avan",
    priceUsd: 95000,
    areaSqm: 72,
    rooms: 3,
    url: "https://banali.am/en/sell/apartment/D100",
    discoveredAt: "2026-07-01T10:00:00.000Z",
  });
  banaliOriginal.source = "banali";
  banaliOriginal.sourceLabel = "Banali.am";
  const myrealtyCopy = listing("myrealty:200", {
    kindKey: "apartment",
    location: "Avan",
    priceUsd: 96500,
    areaSqm: 71,
    rooms: 3,
    url: "https://myrealty.am/en/apartment/200",
    discoveredAt: "2026-07-05T10:00:00.000Z",
  });
  myrealtyCopy.source = "myrealty";
  myrealtyCopy.sourceLabel = "MyRealty";
  const differentListing = listing("myrealty:201", {
    kindKey: "apartment",
    location: "Avan",
    priceUsd: 95500,
    areaSqm: 55,
    rooms: 2,
    url: "https://myrealty.am/en/apartment/201",
    discoveredAt: "2026-07-05T11:00:00.000Z",
  });
  differentListing.source = "myrealty";

  assert.equal(isLikelyDuplicate(banaliOriginal, myrealtyCopy), true);
  assert.equal(isLikelyDuplicate(banaliOriginal, differentListing), false);
  assert.equal(isLikelyDuplicate(banaliOriginal, { ...myrealtyCopy, source: "banali" }), false, "same source is never fuzzy-deduped");

  const deduped = dedupeListings([banaliOriginal, myrealtyCopy, differentListing]);
  const dedupedById = new Map(deduped.map((item) => [item.id, item]));
  assert.equal(dedupedById.get("banali:D100").duplicateOf, undefined);
  assert.equal(dedupedById.get("myrealty:200").duplicateOf, "banali:D100");
  assert.equal(dedupedById.get("myrealty:201").duplicateOf, undefined);
  assert.deepEqual(
    dedupedById.get("banali:D100").alsoSources.map((entry) => entry.label),
    ["MyRealty"]
  );
  assert.equal(visibleListings(deduped).length, 2);
  assert.match(telegramTest.listingLine(dedupedById.get("banali:D100")), /Также на: MyRealty/);

  // A photo captured on an earlier scan survives a later scan that missed it.
  const withPhoto = { ...listing(940001, { location: "Avan" }), imageUrl: "https://s.list.am/f/1/2.webp" };
  const withoutPhoto = { ...listing(940001, { location: "Avan" }), imageUrl: null };
  const keptPhoto = mergeListings([withPhoto], [withoutPhoto], config).find((item) => item.id === "940001");
  assert.equal(keptPhoto.imageUrl, "https://s.list.am/f/1/2.webp", "existing photo must survive a photo-less re-scan");

  // Image backfill: og:image extraction + source eligibility.
  assert.equal(
    extractOgImage('<meta property="og:image" content="https://myrealty.am/images/cc/32/photo_600x460.jpeg" />'),
    "https://myrealty.am/images/cc/32/photo_600x460.jpeg"
  );
  assert.equal(extractOgImage('<meta property="og:image" content="">'), null, "empty og:image (Banali SPA) yields nothing");
  assert.equal(extractOgImage('<meta property="og:image" content="https://x.am/assets/no-img.jpg">'), null, "placeholder images rejected");
  assert.equal(isBackfillEligible({ url: "https://myrealty.am/en/x/1", imageUrl: null }), true);
  assert.equal(isBackfillEligible({ url: "https://myrealty.am/en/x/1", imageUrl: "https://a/b.jpg" }), false, "already has an image");
  assert.equal(isBackfillEligible({ url: "https://www.list.am/item/1", imageUrl: null }), false, "List.am detail is Cloudflare-blocked, not backfilled");
  assert.equal(isBackfillEligible({ url: "https://banali.am/en/x", imageUrl: null }), false, "Banali is a SPA with no og:image");

  // Price drop is detected across scans and surfaced.
  const priced0 = { ...listing(950001, { priceUsd: 100000, location: "Avan" }) };
  const priced1 = { ...listing(950001, { priceUsd: 88000, location: "Avan" }) };
  const dropped = mergeListings([priced0], [priced1], config).find((item) => item.id === "950001");
  assert.equal(dropped.previousPriceUsd, 100000);
  assert.equal(priceDropPercent(dropped), 12);
  // A tiny drop below the threshold is ignored.
  assert.equal(priceDropPercent({ previousPriceUsd: 100000, priceUsd: 99000 }), null);
  // The drop marker survives a subsequent unchanged-price scan.
  const stillDropped = mergeListings([dropped], [{ ...listing(950001, { priceUsd: 88000, location: "Avan" }) }], config).find((item) => item.id === "950001");
  assert.equal(priceDropPercent(stillDropped), 12);
  assert.match(telegramTest.listingLine(dropped), /цена снижена на 12%/);

  const mergedCache = mergeListings([banaliOriginal], [myrealtyCopy], config);
  const mergedCopy = mergedCache.find((item) => item.id === "myrealty:200");
  assert.equal(mergedCopy.duplicateOf, "banali:D100", "later-found cross-source copy must be marked as duplicate");
  const defaultView = telegramTest.matchingListings(config, { filters: {} }, mergedCache, 10, "latest");
  assert.equal(defaultView.some((item) => item.id === "myrealty:200"), false, "duplicates must not reach listing output");
  assert.equal(defaultView.some((item) => item.id === "banali:D100"), true);
  const banaliHiddenView = telegramTest.matchingListings(config, { filters: { excludeSources: ["banali"] } }, mergedCache, 10, "latest");
  assert.equal(banaliHiddenView.some((item) => item.id === "banali:D100"), false);
  assert.equal(
    banaliHiddenView.some((item) => item.id === "myrealty:200"),
    true,
    "when the canonical source is hidden, the duplicate must represent the group"
  );

  const dupNotifyState = {
    listings: mergedCache,
    subscribers: [
      { id: "701", active: true, filters: { excludeSources: ["banali"] } },
      { id: "702", active: true, filters: {} },
    ],
  };
  const beforeDupNotify = fake.messages.length;
  await notifySubscribers(config, dupNotifyState, [mergedCache.find((item) => item.id === "myrealty:200")]);
  const dupNotifyMessages = fake.messages.slice(beforeDupNotify);
  assert.equal(
    dupNotifyMessages.some((message) => String(message.chat_id) === "701" && /myrealty\.am/.test(message.text)),
    true,
    "subscriber hiding the canonical source must still get the duplicate"
  );
  assert.equal(
    dupNotifyMessages.some((message) => String(message.chat_id) === "702"),
    false,
    "subscriber who already receives the canonical must not get the duplicate"
  );

  const healthState = { scanHealth: {} };
  const failingScan = [
    { source: "listam", listings: 0, skipped: 2, blocked: true, error: null, durationMs: 20000 },
    { source: "estate", listings: 0, skipped: 4, blocked: false, error: null, durationMs: 100 },
    { source: "banali", listings: 0, skipped: 8, blocked: false, error: "HTTP 500", durationMs: 900 },
    { source: "myrealty", listings: 0, skipped: 10, blocked: false, error: "fetch failed", durationMs: 400 },
  ];
  for (let round = 0; round < 3; round += 1) updateSourceHealth(healthState, failingScan, new Date("2026-07-08T10:00:00.000Z"));
  assert.equal(isSourceDegraded(healthState, "estate"), true);
  assert.equal(isSourceDegraded(healthState, "banali"), true);
  assert.equal(coreSourcesDown(healthState), true);
  updateSourceHealth(
    healthState,
    [
      { source: "banali", listings: 80, skipped: 0, blocked: false, error: null, durationMs: 800 },
      { source: "myrealty", listings: 12, skipped: 0, blocked: false, error: null, durationMs: 9000 },
    ],
    new Date("2026-07-08T10:05:00.000Z")
  );
  assert.equal(coreSourcesDown(healthState), false);
  assert.equal(healthState.scanHealth.sources.banali.failStreak, 0);
  assert.equal(healthState.scanHealth.sources.estate.failStreak, 3);
  const statusEntries = sourceStatusEntries(healthState);
  const estateEntry = statusEntries.find((entry) => entry.source === "estate");
  assert.equal(estateEntry.degraded, true);
  assert.equal(estateEntry.label, "Estate.am");

  // When List.am is blocked directly but the relay delivered listings, users
  // must see one healthy "List.am" line, not a scary "недоступен".
  const relayHealthy = {
    lastScan: {
      at: "2026-07-08T10:00:00.000Z",
      sources: [
        { source: "listam", listings: 0, blocked: true, error: null },
        { source: "listam_relay", listings: 67, blocked: false, error: null },
        { source: "banali", listings: 83, blocked: false, error: null },
      ],
    },
    scanHealth: {
      sources: {
        listam: { failStreak: 40, lastError: "проверка браузера" },
        listam_relay: { failStreak: 0, lastListings: 67, lastSuccessAt: "2026-07-08T10:00:00.000Z" },
        banali: { failStreak: 0, lastListings: 83 },
      },
    },
  };
  const merged = mergedSourceEntries(relayHealthy);
  const listamMerged = merged.find((entry) => entry.source === "listam");
  assert(listamMerged, "merged view must have a single List.am entry");
  assert.equal(listamMerged.degraded, false, "List.am must read as working when the relay delivers");
  assert.equal(listamMerged.listings, 67);
  assert.equal(merged.filter((entry) => entry.label.startsWith("List.am")).length, 1, "no duplicate List.am rows");
  assert(!merged.some((entry) => entry.source === "listam_relay"), "relay is folded into List.am");
  const blockedNoRelay = mergedSourceEntries({
    lastScan: { at: "2026-07-08T10:00:00.000Z", sources: [{ source: "listam", listings: 0, blocked: true }] },
    scanHealth: { sources: { listam: { failStreak: 40, lastError: "проверка браузера" } } },
  });
  assert.equal(blockedNoRelay.find((entry) => entry.source === "listam").degraded, true, "without any List.am data the source is honestly degraded");

  // Direct scan blocked and relay data expired: cached cards remain browsable,
  // but status must say that fresh data is unavailable.
  const blockedButCached = mergedSourceEntries({
    listings: [
      { id: "23000001", source: "listam", url: "https://www.list.am/item/23000001" },
      { id: "23000002", source: "listam", url: "https://www.list.am/item/23000002" },
      { id: "banali:1", source: "banali", url: "https://banali.am/x", duplicateOf: undefined },
    ],
    lastScan: { at: "2026-07-08T10:00:00.000Z", sources: [{ source: "listam", listings: 0, blocked: true }] },
    scanHealth: { sources: { listam: { failStreak: 40, lastError: "проверка браузера" } } },
  });
  const listamCached = blockedButCached.find((entry) => entry.source === "listam");
  assert.equal(listamCached.degraded, true, "cached List.am cards must not hide a stale source");
  assert.equal(listamCached.stale, true);
  assert.equal(listamCached.listings, 2);
  assert.equal(estateTest.alternateHostUrl("https://www.estate.am/en/feed.rss"), "https://estate.am/en/feed.rss");
  assert.equal(estateTest.alternateHostUrl("https://estate.am/en/feed.rss"), "https://www.estate.am/en/feed.rss");

  const ingestResult = sanitizeIngestPayload(
    {
      source: "listam",
      listings: [
        {
          id: "22979765",
          kindKey: "apartment",
          priceUsd: 95000,
          priceLabel: "$95,000",
          url: "https://www.list.am/item/22979765",
          title: "2 room apartment",
          areaSqm: 70,
          rooms: 2,
          floor: { current: 2, total: 9, label: "2/9" },
          location: "Avan",
          condition: "ready",
          elevator: true,
          publishedAt: "2026-07-08T09:00:00.000Z",
          publishedAtPrecision: "datetime",
          rawText: "renovated elevator",
          qualityScore: 7,
          imageUrl: "https://s.list.am/f/123/12345678.webp",
          injected: "<script>alert(1)</script>",
        },
        { id: "bad-price", kindKey: "apartment", priceUsd: 10, url: "https://www.list.am/item/2" },
        { id: "3", kindKey: "office", priceUsd: 90000, url: "https://www.list.am/item/3" },
        { id: "4", kindKey: "apartment", priceUsd: 90000, url: "http://insecure.example.com/item/4", location: "Avan" },
        { id: "5", kindKey: "apartment", priceUsd: 90000, url: "https://www.list.am/item/5", location: "Атлантида" },
      ],
    },
    config
  );
  assert.equal(ingestResult.listings.length, 1);
  assert.equal(ingestResult.dropped, 4);
  assert.equal(ingestResult.listings[0].id, "22979765");
  assert.equal(ingestResult.listings[0].source, "listam");
  assert.equal(ingestResult.listings[0].minutesToCenter, 20);
  assert.equal(ingestResult.listings[0].injected, undefined, "unknown fields must be stripped");
  assert.equal(ingestResult.listings[0].pricePerSqm, Math.round(95000 / 70));
  assert.equal(ingestResult.listings[0].imageUrl, "https://s.list.am/f/123/12345678.webp");
  assert.equal(
    sanitizeIngestPayload(
      { source: "listam", listings: [{ id: "9", kindKey: "apartment", priceUsd: 90000, url: "https://www.list.am/item/9", location: "Avan", imageUrl: "http://insecure.example/1.jpg" }] },
      config
    ).listings[0].imageUrl,
    null,
    "non-https images must be dropped"
  );
  assert.match(sanitizeIngestPayload({ source: "evil", listings: [] }, config).error, /unknown source/);
  assert.match(sanitizeIngestPayload({ source: "listam", listings: "no" }, config).error, /array/);

  const relayState = {};
  storeRelayListings(relayState, "listam", ingestResult.listings, new Date("2026-07-08T10:00:00.000Z"));
  const relayFresh = relayFallbackResult(relayState, config, new Date("2026-07-08T11:00:00.000Z"));
  assert.equal(relayFresh.sourceName, "listam_relay");
  assert.equal(relayFresh.listings.length, 1);
  assert.deepEqual(relayFresh.locations, ["Avan"]);
  assert.equal(relayFallbackResult(relayState, config, new Date("2026-07-08T14:00:00.000Z")), null, "stale relay data must expire");
  assert.equal(relayFallbackResult({}, config, new Date()), null);
  assert.match(renderYaml, /key: INGEST_TOKEN\s*\n\s*generateValue: true/);
  assert.match(renderYaml, /key: RELAY_MAX_AGE_MINUTES\s*\n\s*value: "180"/);

  const rankingNow = new Date("2026-07-08T12:00:00.000Z");
  const districtSample = [
    listing("r1", { location: "Avan", areaSqm: 70, priceUsd: 70000, pricePerSqm: 1000, publishedAt: "2026-07-08T09:00:00.000Z", discoveredAt: "2026-07-08T09:10:00.000Z" }),
    listing("r2", { location: "Avan", areaSqm: 70, priceUsd: 91000, pricePerSqm: 1300, discoveredAt: "2026-07-01T09:00:00.000Z" }),
    listing("r3", { location: "Avan", areaSqm: 70, priceUsd: 98000, pricePerSqm: 1400, discoveredAt: "2026-07-01T09:00:00.000Z" }),
    listing("r4", { location: "Avan", areaSqm: 70, priceUsd: 105000, pricePerSqm: 1500, discoveredAt: "2026-07-01T09:00:00.000Z" }),
  ];
  const baselines = computeBaselines(districtSample);
  assert.equal(baselines.district.get("apartment|Avan"), 1350);
  const bargainReasons = explainListing(districtSample[0], baselines, rankingNow);
  assert.match(bargainReasons[0], /цена за м² ниже средней по району примерно на 26%/);
  assert(bargainReasons.includes("свежее объявление"));
  assert(valueScore(districtSample[0], baselines, rankingNow) > valueScore(districtSample[3], baselines, rankingNow));

  const annotatedCache = mergeListings([], districtSample, config, rankingNow);
  const annotatedBargain = annotatedCache.find((item) => item.id === "r1");
  assert(annotatedBargain.valueScore >= 7, `bargain valueScore should be high, got ${annotatedBargain.valueScore}`);
  assert(annotatedBargain.whyGood.length >= 2);
  assert.match(telegramTest.listingLine(annotatedBargain), /Почему интересно:/);
  const annotatedRegular = annotatedCache.find((item) => item.id === "r4");
  assert.doesNotMatch(telegramTest.listingLine({ ...annotatedRegular, whyGood: [] }), /Почему интересно:/);
  const topListings = telegramTest.matchingListings(config, { filters: {} }, annotatedCache, 4, "top");
  assert.equal(topListings[0].id, "r1", "top mode must put the best-value listing first");

  const apiState = {
    listings: mergeListings([banaliOriginal, differentListing], districtSample, config, rankingNow),
    lastScan: { at: "2026-07-08T11:55:00.000Z", sources: [{ source: "banali", listings: 5, blocked: false }] },
    nextScanAt: "2026-07-08T12:05:00.000Z",
    scanHealth: { sources: { banali: { failStreak: 0, lastListings: 5 } } },
    subscribers: [{ id: "999", active: true, filters: { secret: true } }],
  };
  const apiPayload = listingsApiPayload(apiState, config, {}, rankingNow);
  assert(apiPayload.total >= 5);
  const banaliSourceView = apiPayload.sources.find((entry) => entry.label === "Banali.am");
  assert(banaliSourceView && banaliSourceView.ok, "Banali source present and healthy");
  assert.equal(banaliSourceView.lastScanListings, 5);
  assert.equal(banaliSourceView.catalogListings, banaliSourceView.listings);
  assert.equal(apiPayload.sources[0].label, "List.am", "List.am is listed first when the catalog has List.am offers");
  assert(apiPayload.locations.includes("Avan"));
  assert.doesNotMatch(JSON.stringify(apiPayload), /subscribers|secret|rawText/, "public API must not leak subscriber data or raw text");
  const apartmentsOnly = listingsApiPayload(apiState, config, { kind: "apartment", minArea: 70, maxPrice: 100000, sort: "value" }, rankingNow);
  assert(apartmentsOnly.listings.length >= 1);
  assert(apartmentsOnly.listings.every((item) => item.kindKey === "apartment" && item.areaSqm >= 70 && item.priceUsd <= 100000));
  assert.equal(apartmentsOnly.listings[0].id, "r1", "value sort must put the bargain first");
  assert.equal(listingsApiPayload(apiState, config, { limit: 2 }, rankingNow).listings.length, 2);
  const apiView = publicListingView({ ...banaliOriginal, rawText: "secret raw", imageUrl: "https://banali.am/storage/x.jpg", floor: { current: 2, total: 9, label: "2/9" }, contactName: "Ани", contactPhone: "+374 10 111222" });
  assert.equal(apiView.rawText, undefined);
  assert.equal(apiView.floorLabel, "2/9");
  assert.equal(apiView.sourceLabel, "Banali.am");
  assert.equal(apiView.imageUrl, "https://banali.am/storage/x.jpg");
  assert.equal(apiView.contactName, "Ани");
  assert.equal(apiView.contactPhone, "+374 10 111222");

  // English source blurbs are rendered in Russian and never leak PII.
  const localizedDesc = shortDescription({ rawText: "$95,000 newly renovated 2 room apartment near the park, call +374 91 234567 or owner@mail.ru https://list.am/item/1" });
  assert.match(localizedDesc, /ремонт/i, "English blurb must be localized to Russian");
  assert.doesNotMatch(localizedDesc, /\+?374|@|https?:|\$|newly|apartment/i, "localized description must never leak price/phone/email/URL or English");
  // The List.am agency/street pattern from the screenshot → clean Russian.
  assert.equal(
    localizeDescription("Agency apartment on Zoravar Andranik Street in Malatia-Sebastia, Malatia-Sebastia"),
    "От агентства · ул. Zoravar Andranik",
    "List.am agency blurb becomes a Russian description"
  );
  assert.equal(localizeDescription("Квартира с ремонтом"), "", "already-Russian text defers to the normal cleanup");
  assert.equal(shortDescription({ rawText: "Avan" }), null, "too-short text yields no description");
  assert.equal(
    shortDescription({ description: "Просторная светлая квартира с новым ремонтом и мебелью в тихом районе рядом со школой и супермаркетом, есть парковка и кладовая комната для хранения вещей жильцов" }).endsWith("…"),
    true,
    "long descriptions are truncated with an ellipsis"
  );
  assert.equal(apiPayload.listings[0].description !== undefined, true, "API listings expose a description field");

  const webappHtml = fs.readFileSync(path.join(__dirname, "..", "src", "webapp.html"), "utf8");
  assert.match(webappHtml, /api\/listings/);
  assert.match(webappHtml, /telegram-web-app\.js/);
  assert.match(webappHtml, /loading="lazy"/, "listing photos must lazy-load");
  assert.match(webappHtml, /\/img\?u=/, "photos must load through the same-origin proxy");
  assert.match(webappHtml, /dom_favorites_v1/, "favorites persist in localStorage");
  assert.match(webappHtml, /data-fav-id/, "cards carry a favorite toggle");
  assert.match(webappHtml, /id="sortSel"/, "catalog has a sort control");
  assert.match(webappHtml, /class="desc"/, "cards render a short description");
  assert.match(webappHtml, /id="search"/, "catalog has a search box");
  assert.match(webappHtml, /contact-phone/, "cards render a tappable contact phone");

  await handleTelegramUpdate(config, state, update("/start", 101));
  assert.equal(activeSubscribers(state, config).length, 1);
  assert(fake.messages.some((message) => /Что делает этот бот/.test(message.text)));
  const startKeyboard = fake.messages.find((message) => /Что делает этот бот/.test(message.text)).reply_markup.keyboard;
  assert.equal(startKeyboard.length, 2, "reply keyboard must be compact");
  assert.equal(startKeyboard.flat().length, 4);
  config.publicUrl = "https://listam-parents-bot.onrender.com";
  const beforePrivateStart = fake.messages.length;
  await handleTelegramUpdate(config, state, update("/tour", 101));
  const privateKeyboard = fake.messages.slice(beforePrivateStart).find((message) => message.reply_markup?.keyboard)?.reply_markup.keyboard;
  assert.equal(privateKeyboard[0][0].web_app.url, "https://listam-parents-bot.onrender.com/app", "private chats get a direct catalog button");
  config.publicUrl = "";
  // /budget still works even though it left the menu
  await handleTelegramUpdate(config, state, update("/budget 111000", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").filters.maxPriceUsd, 111000);

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
  assert.match(latestMessages, /Выгодные по цене за м²/, "old listings without dates fall into the value section");
  assert.match(latestMessages, /Район: Avan/);
  assert.match(latestMessages, /Параметры: 70 м² · 2 комн\./);
  assert.match(latestMessages, /Открыть объявление/);
  assert.doesNotMatch(latestMessages, /Район: Abovyan/);
  const latestKeyboardMessage = fake.messages.at(-1);
  assert(latestKeyboardMessage.reply_markup?.inline_keyboard?.length >= 3, "/latest must attach inline buttons");
  assert.match(JSON.stringify(latestKeyboardMessage.reply_markup), /latest:more/);
  assert(subscriber.latestSession?.shownIds?.length >= 1, "/latest must remember what it already showed");

  const freshSectionNow = new Date("2026-07-08T12:00:00.000Z");
  const groupedSections = telegramTest.groupLatestSections(
    config,
    [
      listing(910001, { publishedAt: "2026-07-08T09:00:00.000Z", discoveredAt: "2026-07-08T09:05:00.000Z" }),
      listing(910002, { publishedAt: "2026-05-01T09:00:00.000Z", updatedAt: "2026-07-07T09:00:00.000Z", discoveredAt: "2026-05-01T09:05:00.000Z" }),
      listing(910003, { discoveredAt: "2026-06-01T09:00:00.000Z" }),
    ],
    freshSectionNow
  );
  assert.deepEqual(
    groupedSections.map((section) => [section.key, section.items.length]),
    [["fresh", 1], ["raised", 1], ["value", 1]]
  );

  const beforeExhaustedMore = fake.messages.length;
  await handleTelegramUpdate(config, state, callbackUpdate("latest:more", 101));
  assert(fake.calls.some((call) => call.method === "answerCallbackQuery"), "callback queries must be answered");
  assert.equal(fake.messages.length, beforeExhaustedMore, "everything was already shown, no repeats allowed");
  assert.match(fake.calls.at(-1).body.text || "", /Больше подходящих вариантов пока нет/);

  subscriber.latestSession = null;
  const beforeMoreCallback = fake.messages.length;
  await handleTelegramUpdate(config, state, callbackUpdate("latest:more", 101));
  const moreMessages = fake.messages.slice(beforeMoreCallback).map((message) => message.text).join("\n");
  assert.match(moreMessages, /Ещё варианты/);

  await handleTelegramUpdate(config, state, callbackUpdate("flt:minarea:70", 101));
  assert.equal(subscriber.filters.minAreaSqm, 70);
  assert.match(fake.messages.at(-1).text, /Фильтр обновлён: площадь от 70 м²/);
  subscriber.filters.minAreaSqm = null;

  await handleTelegramUpdate(config, state, callbackUpdate("src:menu", 101));
  assert.match(fake.messages.at(-1).text, /Какие источники показывать/);
  assert.match(JSON.stringify(fake.messages.at(-1).reply_markup), /src:toggle:banali/);

  await handleTelegramUpdate(config, state, callbackUpdate("src:toggle:banali", 101, { messageId: 77 }));
  assert.deepEqual(subscriber.filters.excludeSources, ["banali"]);
  assert(fake.calls.some((call) => call.method === "editMessageReplyMarkup" && call.body.message_id === 77));
  const banaliItem = listing(920001, { location: "Avan", priceUsd: 90000, rooms: 2 });
  banaliItem.source = "banali";
  assert.equal(telegramTest.matchesSubscriber(config, subscriber, banaliItem), false, "excluded source must be filtered out");
  assert.match(telegramTest.filtersText(config, subscriber.filters), /Скрытые источники: Banali\.am/);
  await handleTelegramUpdate(config, state, callbackUpdate("src:toggle:banali", 101, { messageId: 77 }));
  assert.deepEqual(subscriber.filters.excludeSources, []);
  assert.equal(telegramTest.matchesSubscriber(config, subscriber, banaliItem), true);

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
  assert.match(naturalLatestMessages, /Параллельно запускаю проверку источников/);
  assert.doesNotMatch(naturalLatestMessages, /Я помогу настроить/);
  state.lastUserScanAt = null;

  await handleTelegramUpdate(config, state, update("привет как пользоваться тобой?", 101));
  assert.match(fake.messages.at(-1).text, /бот для поиска недвижимости/i);

  // Forwarded Facebook-group post ingest.
  const fbPost = "Продается квартира в районе Аван, 2 комнаты, 68 кв.м, 5/9 этаж, с ремонтом. Цена $95000. Тел +374 91 234567";
  assert.equal(looksLikeListingPost(fbPost), true);
  assert.equal(looksLikeListingPost("дом до 120к без агентств"), false, "short filter requests are not treated as posts");
  const fbListing = parseForwardedListing(fbPost, config, { fromId: 101, messageId: 5 });
  assert.equal(fbListing.source, "facebook");
  assert.equal(fbListing.kindKey, "apartment");
  assert.equal(fbListing.priceUsd, 95000);
  assert.equal(fbListing.areaSqm, 68);
  assert.equal(fbListing.rooms, 2);
  assert.equal(fbListing.location, "Avan");
  assert.equal(fbListing.condition, "ready");
  assert.equal(fbListing.contactPhone, "+374 91 234567", "phone must be parsed from the post");
  // Name comes from the Telegram forward header when present.
  const fbWithName = parseForwardedListing(fbPost, config, { fromId: 101, messageId: 7, contactName: "Армен Петросян" });
  assert.equal(fbWithName.contactName, "Армен Петросян");
  assert.match(telegramTest.listingLine(fbWithName), /Контакт: <a href="tel:\+37491234567">Армен Петросян, \+374 91 234567<\/a>/);
  // Name from a labelled line in the text when no forward header.
  const labelled = parseForwardedListing("Квартира Аван, 70 кв.м, $90000. Контакт: Гагик, 091 445566", config, { fromId: 101, messageId: 8 });
  assert.equal(labelled.contactName, "Гагик");
  assert.equal(labelled.contactPhone, "+374 91 445566");
  const amdPost = "Дом Зовуни, 4 комнаты, 140 кв.м, участок. 46 800 000 драм. Отличное состояние.";
  const amdListing = parseForwardedListing(amdPost, config, { fromId: 101, messageId: 6 });
  assert.equal(amdListing.kindKey, "house");
  assert.equal(amdListing.location, "Zovuni");
  assert(amdListing.priceUsd > 100000 && amdListing.priceUsd < 130000, `AMD converted, got ${amdListing.priceUsd}`);
  assert.equal(parseForwardedListing("Просто болтовня без цены и без квартир", config, {}), null);
  // Armenian-language post (common in FB groups): units in Armenian.
  const hyPost = parseForwardedListing("Բնակարան Կենտրոն, 2 սենյակ, 60 քմ, 3/5 հարկ, 110.000 USD", config, { fromId: 1, messageId: 9 });
  assert.equal(hyPost.location, "Kentron");
  assert.equal(hyPost.areaSqm, 60);
  assert.equal(hyPost.rooms, 2);
  assert.equal(hyPost.floor.label, "3/5");

  // Forwarding a post to the bot adds it to the catalog via the addListings hook,
  // taking the contact name from the Telegram forward header.
  const added = [];
  const fwdUpdate = update(fbPost, 101);
  fwdUpdate.message.forward_date = 1;
  fwdUpdate.message.forward_from = { first_name: "Сурен", last_name: "Акопян" };
  await handleTelegramUpdate(config, state, fwdUpdate, { addListings: (items) => { added.push(...items); return true; } });
  assert.equal(added.length, 1, "forwarded post must be handed to addListings");
  assert.equal(added[0].source, "facebook");
  assert.equal(added[0].contactName, "Сурен Акопян", "contact name taken from forward header");
  assert.equal(added[0].contactPhone, "+374 91 234567");
  assert.match(fake.messages.at(-1).text, /Добавил объявление в каталог/);
  assert.match(fake.messages.at(-1).text, /Контакт: <a href="tel:/);

  // /add command with inline text.
  const addedViaCmd = [];
  await handleTelegramUpdate(config, state, update("/add Квартира Нор Норк, 3 комнаты, 80 м², $110000, ремонт", 101), {
    addListings: (items) => { addedViaCmd.push(...items); return true; },
  });
  assert.equal(addedViaCmd.length, 1);
  assert.equal(addedViaCmd[0].location, "Nor Nork");
  await handleTelegramUpdate(config, state, update("/add", 101), { addListings: () => true });
  assert.match(fake.messages.at(-1).text, /перешл|Facebook/i);

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
  // Cached cards remain available, but without a current successful scan the
  // status must not imply that List.am is updating normally.
  assert.match(fake.messages.at(-1).text, /⚠️ List\.am/);
  assert.match(fake.messages.at(-1).text, /в каталоге 3 объявления; свежие данные не получены/);

  config.publicUrl = "https://listam-parents-bot.onrender.com";
  await handleTelegramUpdate(config, state, update("/app", 101));
  const appMessage = fake.messages.at(-1);
  assert.equal(appMessage.reply_markup.inline_keyboard[0][0].web_app.url, "https://listam-parents-bot.onrender.com/app");
  config.publicUrl = "";

  await handleTelegramUpdate(config, state, update("/admin_status", 101));
  assert.match(fake.messages.at(-1).text, /только администратору/);

  config.adminChatIds = new Set(["909"]);
  await handleTelegramUpdate(config, state, update("/admin", 909));
  assert.match(fake.messages.at(-1).text, /Команды администратора/);

  await handleTelegramUpdate(config, state, update("/admin_status", 909));
  assert.match(fake.messages.at(-1).text, /Админ-статус/);
  assert.match(fake.messages.at(-1).text, /Кеш объявлений/);

  await handleTelegramUpdate(config, state, update("/admin_sources", 909));
  assert.match(fake.messages.at(-1).text, /скан не выполнялся|Источники/);

  let adminScanCount = 0;
  state.scanHealth.lastListamFullProbeAt = "2026-07-08T00:00:00.000Z";
  await handleTelegramUpdate(config, state, update("/admin_rescan", 909), { scanNow: () => { adminScanCount += 1; } });
  assert.equal(adminScanCount, 1);
  assert.equal(state.scanHealth.lastListamFullProbeAt, null, "admin rescan must force a full List.am probe");

  await handleTelegramUpdate(config, state, update("/admin_broadcast Тест рассылки <b>", 909));
  assert.match(fake.messages.at(-1).text, /Черновик рассылки/);
  assert(state.pendingAdminBroadcast?.text.includes("Тест рассылки"));
  const beforeBroadcast = fake.messages.length;
  await handleTelegramUpdate(config, state, update("/admin_broadcast_send", 909));
  const broadcastMessages = fake.messages.slice(beforeBroadcast);
  assert(broadcastMessages.some((message) => /Тест рассылки/.test(message.text) && /&lt;b&gt;/.test(message.text)), "broadcast must be HTML-escaped");
  assert.match(fake.messages.at(-1).text, /Рассылка отправлена/);
  assert.equal(state.pendingAdminBroadcast, undefined);

  await handleTelegramUpdate(config, state, update("/admin_debug 100001", 909));
  assert.match(fake.messages.at(-1).text, /<pre>/);
  assert.match(fake.messages.at(-1).text, /100001/);
  await handleTelegramUpdate(config, state, update("/admin_debug missing-id-xyz", 909));
  assert.match(fake.messages.at(-1).text, /не найдено/);
  config.adminChatIds = new Set();

  await handleTelegramUpdate(config, state, update("/stop", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").active, false);
  // A stopped user browsing with read-only commands must stay unsubscribed.
  await handleTelegramUpdate(config, state, update("/status", 101));
  await handleTelegramUpdate(config, state, update("/latest", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").active, false, "/stop must stick until /start");
  await handleTelegramUpdate(config, state, update("/start", 101));
  assert.equal(state.subscribers.find((item) => String(item.id) === "101").active, true);

  // chunkListings must not infinite-loop if batch size is misconfigured to 0.
  assert.equal(telegramTest.chunkListings("t", [listing(1), listing(2)], { ...config, telegramBatchSize: 0 }).length, 1);

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
