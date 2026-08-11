"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const created = [];

/**
 * Create a throwaway directory that `cleanupTempDirs()` will remove.
 *
 * The stores under test persist to disk, so every case needs its own directory
 * to stay independent of the others.
 *
 * @param {string} [prefix]
 * @returns {string} Absolute path to the new directory.
 */
function makeTempDir(prefix = "qt-cli-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Path to `name` inside a fresh temp directory. The file itself is not created,
 * which is what the on-disk stores expect.
 *
 * @param {string} name
 * @param {string} [prefix]
 * @returns {string}
 */
function tempFile(name, prefix) {
  return path.join(makeTempDir(prefix), name);
}

/** Remove every directory handed out by `makeTempDir`/`tempFile`. */
function cleanupTempDirs() {
  while (created.length > 0) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
}

module.exports = { makeTempDir, tempFile, cleanupTempDirs };
