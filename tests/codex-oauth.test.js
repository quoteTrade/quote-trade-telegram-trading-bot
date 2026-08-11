"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const EventEmitter = require("node:events");

const { stubRequire } = require("./helpers/module-stub");
const { makeTempDir, cleanupTempDirs } = require("./helpers/tmp");

/** Every spawn the code under test asked for, in order. */
const spawns = [];

/**
 * Fake `codex` child process.
 *
 * Two shapes, picked from argv by the stubbed `spawn` below:
 *
 *   - `app-server` (`codex login`): speaks the JSON-line app-server protocol.
 *     It answers `initialize`, then answers `account/login/start` with a
 *     device-code challenge, writes an `auth.json` into the per-owner
 *     `CODEX_HOME` handed to it, and finally pushes an
 *     `account/login/completed` notification — i.e. it fakes the user finishing
 *     the browser half of the OAuth flow.
 *   - `exec` (`codex exec`): records the prompt it receives on stdin, and on
 *     `stdin.end()` writes a plan JSON payload to the path given by
 *     `--output-last-message` before exiting 0.
 */
function makeProc(kind, options, args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = (text) => {
    if (kind === "app-server") {
      for (const line of String(text).split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          setImmediate(() =>
            proc.stdout.emit("data", `${JSON.stringify({ id: msg.id, result: { platformOs: "test" } })}\n`),
          );
        }
        if (msg.method === "account/login/start") {
          setImmediate(() => {
            proc.stdout.emit(
              "data",
              `${JSON.stringify({
                id: msg.id,
                result: {
                  type: "chatgptDeviceCode",
                  loginId: "login-123",
                  verificationUrl: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-1234",
                },
              })}\n`,
            );
            setImmediate(() => {
              fs.writeFileSync(
                path.join(options.env.CODEX_HOME, "auth.json"),
                JSON.stringify({ mode: "chatgpt", accessToken: "token-for-this-user" }),
                { mode: 0o600 },
              );
              proc.stdout.emit(
                "data",
                `${JSON.stringify({
                  method: "account/login/completed",
                  params: { loginId: "login-123", success: true, error: null },
                })}\n`,
              );
            });
          });
        }
      }
    } else if (kind === "exec") {
      proc.prompt = (proc.prompt || "") + String(text);
    }
  };
  proc.stdin.end = () => {
    if (kind === "exec") {
      const outIndex = args.indexOf("--output-last-message");
      const outputPath = args[outIndex + 1];
      fs.writeFileSync(
        outputPath,
        JSON.stringify({
          summary: "codex plan",
          commands: ["/limit BTC BUY 60000 0.01"],
          riskNotes: ["confirm first"],
        }),
        "utf8",
      );
      setImmediate(() => proc.emit("exit", 0));
    }
  };
  proc.kill = () => {
    proc.killed = true;
    setImmediate(() => proc.emit("exit", 0));
  };
  return proc;
}

// Installed before the `dist/` requires below: the modules under test capture
// `node:child_process` at load time.
const restoreRequire = stubRequire({
  "node:child_process": {
    spawn: (cmd, args, options) => {
      const kind = args[0] === "app-server" ? "app-server" : "exec";
      const proc = makeProc(kind, options, args);
      spawns.push({ cmd, args, options, proc, kind });
      return proc;
    },
  },
});

const stateDir = makeTempDir("qt-tg-codex-oauth-");

// The secret-looking values are sentinels: several cases assert that none of
// them reach the spawned codex process.
const envPatch = {
  QUOTE_TRADE_STATE_DIR: stateDir,
  TELEGRAM_BOT_TOKEN: "telegram-secret-that-must-not-reach-codex",
  TRADE_API_KEY: "quote-trade-key-that-must-not-reach-codex",
  TRADE_API_SECRET: "quote-trade-secret-that-must-not-reach-codex",
  OPENAI_API_KEY: "platform-key-that-must-not-reach-codex",
  CODEX_BIN: "codex-test-bin",
  CODEX_LOGIN_START_TIMEOUT_MS: "1000",
  CODEX_LOGIN_TIMEOUT_MS: "5000",
  CODEX_EXEC_TIMEOUT_MS: "1000",
};

const savedEnv = {};
for (const [key, value] of Object.entries(envPatch)) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

const { LlmConfigStore, LlmProviderClient, LlmStrategyPlanner, normalizeLlmProvider } = require("../dist/llm");
const {
  codexAuthFile,
  codexHomeForOwner,
  codexOAuthStatus,
  hasCodexOAuthSession,
  logoutCodexOAuth,
  startCodexOAuthLogin,
} = require("../dist/llm/codex-oauth");
const { userStateFile } = require("../dist/sessions/user-state");

after(restoreRequire);
after(cleanupTempDirs);
after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// One OAuth lifecycle, walked in order: provider normalisation ->
// unauthenticated -> login -> planning -> logout. The cases below run in
// declaration order and deliberately share the config store, the temp state
// directory and the `spawns` recorder, because each phase asserts against the
// state the previous phase left behind.
describe("codex OAuth lifecycle", () => {
  const config = new LlmConfigStore(userStateFile("alice", "llm-config.json"));
  const client = new LlmProviderClient();

  let challenge;
  let completion;
  let connection;
  let rawPlan;
  let execSpawn;

  describe("provider normalisation", () => {
    it('normalises "codex" to the codex-oauth provider', () => {
      assert.equal(normalizeLlmProvider("codex"), "codex-oauth");
    });

    it('normalises "openai-codex" to the codex-oauth provider', () => {
      assert.equal(normalizeLlmProvider("openai-codex"), "codex-oauth");
    });

    it('normalises "chatgpt-pro" to the codex-oauth provider', () => {
      assert.equal(normalizeLlmProvider("chatgpt-pro"), "codex-oauth");
    });
  });

  describe("a codex connection whose owner has not finished OAuth", () => {
    before(() => {
      config.setConnection({ ownerId: "alice", provider: "codex", model: "gpt-5-codex", makeDefault: true });
    });

    it("is not resolved as a plan connection", () => {
      assert.equal(
        config.resolvePlanConnections("alice", undefined, false).length,
        0,
        "codex must not resolve before this Telegram user finishes OAuth",
      );
    });

    it("is listed as disabled", () => {
      assert.equal(config.listRows("alice").find((row) => row.provider === "codex-oauth").enabled, false);
    });
  });

  describe("device-code login", () => {
    before(async () => {
      challenge = await startCodexOAuthLogin("alice", (result) => {
        completion = result;
      });
    });

    it("returns the user code from the codex login challenge", () => {
      assert.equal(challenge.userCode, "ABCD-1234");
    });

    it("reports a successful login once codex writes the auth file", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepStrictEqual(completion, { success: true, error: undefined });
    });

    it("records a session for the owner that logged in and for nobody else", () => {
      assert.equal(hasCodexOAuthSession("alice"), true);
      assert.equal(hasCodexOAuthSession("bob"), false);
    });

    it("keeps each owner auth file inside that owner codex home", () => {
      assert.ok(codexAuthFile("alice").startsWith(codexHomeForOwner("alice")));
      assert.notEqual(codexAuthFile("alice"), codexAuthFile("bob"));
    });

    it("reports the owner as connected", () => {
      assert.equal(codexOAuthStatus("alice").connected, true);
    });
  });

  describe("the codex config row once the session exists", () => {
    it("is enabled and sourced from oauth", () => {
      const row = config.listRows("alice").find((item) => item.provider === "codex-oauth");
      assert.equal(row.enabled, true);
      assert.equal(row.source, "oauth");
      assert.match(row.key, /connected/);
    });

    it("resolves a plan connection that carries no api key", () => {
      [connection] = config.resolvePlanConnections("alice", undefined, false);
      assert.equal(connection.provider, "codex-oauth");
      assert.equal(connection.model, "gpt-5-codex");
      assert.equal(connection.effectiveApiKey, undefined);
      assert.equal(connection.source, "oauth");
    });
  });

  describe("planning through codex exec", () => {
    before(async () => {
      rawPlan = await client.completePlan(connection, { systemPrompt: "system prompt", userPrompt: "user prompt" });
      execSpawn = spawns.find((spawn) => spawn.kind === "exec");
    });

    it("returns the commands codex wrote to the output file", () => {
      assert.equal(rawPlan.commands[0], "/limit BTC BUY 60000 0.01");
    });

    it("runs codex exec with an output schema, an output file and a read-only sandbox", () => {
      assert.ok(execSpawn, "codex exec should be used for codex-oauth planning");
      assert.ok(execSpawn.args.includes("--output-schema"));
      assert.ok(execSpawn.args.includes("--output-last-message"));
      assert.ok(execSpawn.args.includes("--sandbox"));
      assert.ok(execSpawn.args.includes("read-only"));
    });

    it("sends the prompt over stdin instead of argv", () => {
      assert.ok(execSpawn.args.includes("-"), "prompt must be sent over stdin");
      assert.equal(
        execSpawn.args.some((arg) => String(arg).includes("user prompt")),
        false,
        "prompt must not be placed in argv",
      );
      assert.match(execSpawn.proc.prompt, /user prompt/);
    });

    it("does not leak host secrets into the codex process environment", () => {
      assert.ok(
        execSpawn.options.env.PATH,
        "sanity: codex must still receive an environment, so the checks below are not vacuous",
      );
      assert.equal(execSpawn.options.env.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(execSpawn.options.env.TRADE_API_KEY, undefined);
      assert.equal(execSpawn.options.env.TRADE_API_SECRET, undefined);
      assert.equal(execSpawn.options.env.OPENAI_API_KEY, undefined);
    });

    it("points codex at the owner codex home", () => {
      assert.equal(execSpawn.options.env.CODEX_HOME, codexHomeForOwner("alice"));
    });

    it("turns a codex plan into a limit order action", async () => {
      const planner = new LlmStrategyPlanner(config, client);
      const plan = await planner.plan({
        ownerId: "alice",
        prompt: "buy btc",
        commandFormat: "telegram",
        allowFallback: false,
      });
      assert.equal(plan.provider, "codex-oauth");
      assert.equal(plan.actions[0].inputs[0].kind, "LIMIT");
    });
  });

  describe("logout", () => {
    // bob is logged in here, before alice logs out, on purpose. The original
    // suite asserted `hasCodexOAuthSession('bob') === false` after alice's
    // logout, but bob never had a session, so that check held no matter what
    // logout did -- it would have passed even if logout wiped every owner's
    // codex home. Seeding a real session for bob makes the case exercise the
    // per-owner isolation it claims to defend.
    before(async () => {
      await startCodexOAuthLogin("bob", () => {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        hasCodexOAuthSession("bob"),
        true,
        "precondition: bob must hold a codex session before alice logs out",
      );
    });

    it("removes the codex session for the owner", () => {
      assert.equal(logoutCodexOAuth("alice"), true);
      assert.equal(hasCodexOAuthSession("alice"), false);
    });

    it("stops resolving the codex provider for that owner", () => {
      assert.equal(
        config.resolvePlanConnections("alice", undefined, false).length,
        0,
        "logout should disable this user codex provider",
      );
    });

    it("keeps another Telegram user session intact", () => {
      assert.equal(hasCodexOAuthSession("bob"), true, "logout must not affect another Telegram user");
    });
  });
});
