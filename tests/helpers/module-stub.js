"use strict";

const Module = require("node:module");

/**
 * Replace what `require(id)` returns, for the ids given in `stubs`.
 *
 * Returns a `restore()` that puts the original loader back. Pair every call
 * with `after(restore)` so a stub can never leak past the file that installed
 * it.
 *
 * Why `Module._load` and not something public:
 *
 *   - `require.cache` seeding cannot stub Node builtins (`node:child_process`),
 *     because builtins are never placed in the CJS cache.
 *   - `node:test`'s `mock.module()` is still experimental and needs
 *     `--experimental-test-module-mocks`, which we do not want to require in CI.
 *
 * So this is the one deliberate use of a private API in the suite, wrapped in a
 * single seam instead of being re-implemented in every test file.
 *
 * Ordering matters: the modules under test capture their dependencies at load
 * time (`const axios = require('axios')` runs once, when the module is first
 * required). Install stubs at file scope *before* requiring anything out of
 * `dist/`, otherwise the real dependency is already captured.
 *
 * @param {Record<string, unknown>} stubs Map of module id -> replacement exports.
 * @returns {() => void} Restores the original module loader.
 */
function stubRequire(stubs) {
  const originalLoad = Module._load;

  Module._load = function load(request, ...rest) {
    if (Object.hasOwn(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, ...rest);
  };

  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    Module._load = originalLoad;
  };
}

module.exports = { stubRequire };
