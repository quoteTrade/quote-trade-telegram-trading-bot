"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { makeTempDir, cleanupTempDirs } = require("./helpers/tmp");

// The on-disk stores resolve their state directory at require time, so point it
// somewhere throwaway before anything loads.
process.env.QUOTE_TRADE_STATE_DIR = makeTempDir("qt-tg-module-load-");

after(cleanupTempDirs);

const distRoot = path.join(__dirname, "..", "dist");

// `dist/bot.js` needs a token at module scope, because the token doubles as the
// session encryption material. It no longer connects to anything on import: the
// long-poll lives behind `require.main === module`.
process.env.TELEGRAM_BOT_TOKEN = "module-load-test-token";

/** Every compiled module we ship, relative to dist/, in stable order. */
function shippedModules(dir = distRoot, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...shippedModules(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".js")) found.push(rel);
  }
  return found;
}

const modules = shippedModules();

/**
 * Importing a shipped module must not throw and must not do work.
 *
 * This is the guard for import-time regressions: a circular require, top-level
 * code that needs an env var nobody set, or a module that opens a socket or
 * starts a timer as a side effect of being loaded.
 */
describe("shipped modules", () => {
  it("finds every compiled module", () => {
    assert.ok(modules.length > 0, "dist/ must be built before the suite runs");
    assert.ok(modules.includes("bot.js"), "the bot entry point must be present");
  });

  for (const rel of modules) {
    it(`imports ${rel} without throwing`, () => {
      const loaded = require(path.join(distRoot, rel));
      assert.equal(typeof loaded, "object", "a CommonJS module must expose an exports object");
    });
  }
});
