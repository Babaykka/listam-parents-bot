const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ListAmMailSpoolMonitor, publicMailSpoolHealth } = require("../src/mailSpool");
const { tempDataDir, testConfig } = require("../scripts/test_helpers");

function rawMessage(from = "post@list.am", authenticationResults = null) {
  const headers = [
    `From: List.am <${from}>`,
    "To: listam-bot@fizteh-reshit.online",
    "Subject: New apartments",
    "Message-ID: <mail-spool-1@example.com>",
    "Date: Fri, 10 Jul 2026 17:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ];
  if (authenticationResults) headers.push(`Authentication-Results: ${authenticationResults}`);
  return [
    ...headers,
    "",
    '<a href="https://www.list.am/item/23999999">Apartment $95,000, 72 sq.m., 3 rooms, 4/9 floor, Avan</a>',
  ].join("\r\n");
}

function spoolConfig() {
  const dataDir = tempDataDir("listam-mail-spool-");
  return testConfig({
    dataDir,
    mailSpoolEnabled: true,
    mailSpoolDir: path.join(dataDir, "mail-spool"),
    mailSpoolPollSeconds: 5,
    mailSpoolRetentionDays: 14,
    collectAllListings: true,
  });
}

test("mail drop writes an atomic private EML file", () => {
  const config = spoolConfig();
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "listam_mail_drop.js")], {
    input: rawMessage(),
    env: { ...process.env, DATA_DIR: config.dataDir },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const incoming = path.join(config.dataDir, "mail-spool", "incoming");
  const files = fs.readdirSync(incoming);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.eml$/);
  assert.equal(fs.statSync(path.join(incoming, files[0])).mode & 0o777, 0o600);
});

test("mail spool accepts List.am mail once and archives it", async () => {
  const config = spoolConfig();
  const incoming = path.join(config.mailSpoolDir, "incoming");
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(incoming, "001.eml"), rawMessage(), { mode: 0o600 });
  const state = {};
  const delivered = [];
  const monitor = new ListAmMailSpoolMonitor(config, state, {
    logger: { log() {}, warn() {} },
    onListings: async (items) => delivered.push(...items),
  });

  assert.deepEqual(await monitor.pollOnce(), { messages: 1, listings: 1 });
  assert.deepEqual(await monitor.pollOnce(), { messages: 0, listings: 0 });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, "23999999");
  assert.equal(delivered[0].sourceChannel, "email");
  assert.equal(state.mailSpool.totalMessages, 1);
  assert.equal(state.mailSpool.totalListings, 1);
  assert.equal(fs.readdirSync(path.join(config.mailSpoolDir, "processed")).length, 1);
  assert.equal(fs.readdirSync(incoming).length, 0);
  const health = publicMailSpoolHealth(config, state);
  assert.equal(health.configured, true);
  assert.equal(JSON.stringify(health).includes(config.mailSpoolDir), false);
});

test("mail spool rejects a spoofed sender without parsing listings", async () => {
  const config = spoolConfig();
  const incoming = path.join(config.mailSpoolDir, "incoming");
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(incoming, "spoof.eml"), rawMessage("attacker@example.com"), { mode: 0o600 });
  const state = {};
  const delivered = [];
  const monitor = new ListAmMailSpoolMonitor(config, state, {
    logger: { log() {}, warn() {} },
    onListings: async (items) => delivered.push(...items),
  });

  assert.deepEqual(await monitor.pollOnce(), { messages: 0, listings: 0 });
  assert.equal(delivered.length, 0);
  assert.equal(state.mailSpool.rejectedMessages, 1);
  assert.equal(fs.readdirSync(path.join(config.mailSpoolDir, "rejected")).length, 1);
});

test("mail spool requires a trusted List.am DKIM result when enabled", async () => {
  const config = { ...spoolConfig(), mailSpoolRequireDkim: true };
  const incoming = path.join(config.mailSpoolDir, "incoming");
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(path.join(incoming, "unsigned.eml"), rawMessage(), { mode: 0o600 });
  fs.writeFileSync(
    path.join(incoming, "signed.eml"),
    rawMessage("post@list.am", "fizteh-reshit.online; dkim=pass header.d=list.am header.s=default"),
    { mode: 0o600 }
  );

  const state = {};
  const delivered = [];
  const monitor = new ListAmMailSpoolMonitor(config, state, {
    logger: { log() {}, warn() {} },
    onListings: async (items) => delivered.push(...items),
  });

  assert.deepEqual(await monitor.pollOnce(), { messages: 1, listings: 1 });
  assert.equal(delivered.length, 1);
  assert.equal(state.mailSpool.rejectedMessages, 1);
  assert.equal(fs.readdirSync(path.join(config.mailSpoolDir, "processed")).length, 1);
  assert.equal(fs.readdirSync(path.join(config.mailSpoolDir, "rejected")).length, 1);
});

test("mail spool does not trust Authentication-Results from another host", async () => {
  const config = { ...spoolConfig(), mailSpoolRequireDkim: true };
  const incoming = path.join(config.mailSpoolDir, "incoming");
  fs.mkdirSync(incoming, { recursive: true });
  fs.writeFileSync(
    path.join(incoming, "forged.eml"),
    rawMessage("post@list.am", "attacker.example; dkim=pass header.d=list.am"),
    { mode: 0o600 }
  );

  const state = {};
  const monitor = new ListAmMailSpoolMonitor(config, state, { logger: { log() {}, warn() {} } });
  assert.deepEqual(await monitor.pollOnce(), { messages: 0, listings: 0 });
  assert.equal(state.mailSpool.rejectedMessages, 1);
});
