#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const dataDir = process.env.DATA_DIR || "/var/lib/listam-bot";
const incomingDir = process.env.LISTAM_MAIL_SPOOL_DIR || path.join(dataDir, "mail-spool", "incoming");
const chunks = [];
let bytes = 0;
let rejected = false;

process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > MAX_MESSAGE_BYTES) {
    rejected = true;
    return;
  }
  chunks.push(chunk);
});

process.stdin.on("end", () => {
  if (rejected || bytes === 0) {
    process.exitCode = 65;
    return;
  }

  fs.mkdirSync(incomingDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(incomingDir, 0o700);
  const id = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const temporary = path.join(incomingDir, `.${id}.tmp`);
  const destination = path.join(incomingDir, `${id}.eml`);
  fs.writeFileSync(temporary, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
});

process.stdin.on("error", () => {
  process.exitCode = 75;
});
