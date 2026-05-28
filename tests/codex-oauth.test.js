const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const Module = require('node:module');

process.env.QUOTE_TRADE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-codex-oauth-'));
process.env.TELEGRAM_BOT_TOKEN = 'telegram-secret-that-must-not-reach-codex';
process.env.TRADE_API_KEY = 'quote-trade-key-that-must-not-reach-codex';
process.env.TRADE_API_SECRET = 'quote-trade-secret-that-must-not-reach-codex';
process.env.OPENAI_API_KEY = 'platform-key-that-must-not-reach-codex';
process.env.CODEX_BIN = 'codex-test-bin';
process.env.CODEX_LOGIN_START_TIMEOUT_MS = '1000';
process.env.CODEX_LOGIN_TIMEOUT_MS = '5000';
process.env.CODEX_EXEC_TIMEOUT_MS = '1000';

const spawns = [];
const originalLoad = Module._load;

function makeProc(kind, options, args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = (text) => {
    if (kind === 'app-server') {
      for (const line of String(text).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() => proc.stdout.emit('data', JSON.stringify({ id: msg.id, result: { platformOs: 'test' } }) + '\n'));
        }
        if (msg.method === 'account/login/start') {
          setImmediate(() => {
            proc.stdout.emit('data', JSON.stringify({ id: msg.id, result: { type: 'chatgptDeviceCode', loginId: 'login-123', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } }) + '\n');
            setImmediate(() => {
              fs.writeFileSync(path.join(options.env.CODEX_HOME, 'auth.json'), JSON.stringify({ mode: 'chatgpt', accessToken: 'token-for-this-user' }), { mode: 0o600 });
              proc.stdout.emit('data', JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login-123', success: true, error: null } }) + '\n');
            });
          });
        }
      }
    } else if (kind === 'exec') {
      proc.prompt = (proc.prompt || '') + String(text);
    }
  };
  proc.stdin.end = () => {
    if (kind === 'exec') {
      const outIndex = args.indexOf('--output-last-message');
      const outputPath = args[outIndex + 1];
      fs.writeFileSync(outputPath, JSON.stringify({ summary: 'codex plan', commands: ['/limit BTC BUY 60000 0.01'], riskNotes: ['confirm first'] }), 'utf8');
      setImmediate(() => proc.emit('exit', 0));
    }
  };
  proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', 0)); };
  return proc;
}

Module._load = function(request, parent, isMain) {
  if (request === 'node:child_process') {
    return {
      spawn: (cmd, args, options) => {
        const kind = args[0] === 'app-server' ? 'app-server' : 'exec';
        const proc = makeProc(kind, options, args);
        spawns.push({ cmd, args, options, proc, kind });
        return proc;
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { LlmConfigStore, LlmProviderClient, LlmStrategyPlanner, normalizeLlmProvider } = require('../dist/llm');
const { codexAuthFile, codexHomeForOwner, codexOAuthStatus, hasCodexOAuthSession, logoutCodexOAuth, startCodexOAuthLogin } = require('../dist/llm/codex-oauth');
const { userStateFile } = require('../dist/sessions/user-state');

(async () => {
  assert.strictEqual(normalizeLlmProvider('codex'), 'codex-oauth');
  assert.strictEqual(normalizeLlmProvider('openai-codex'), 'codex-oauth');
  assert.strictEqual(normalizeLlmProvider('chatgpt-pro'), 'codex-oauth');

  const config = new LlmConfigStore(userStateFile('alice', 'llm-config.json'));
  config.setConnection({ ownerId: 'alice', provider: 'codex', model: 'gpt-5-codex', makeDefault: true });
  assert.strictEqual(config.resolvePlanConnections('alice', undefined, false).length, 0, 'codex must not resolve before this Telegram user finishes OAuth');
  assert.strictEqual(config.listRows('alice').find((row) => row.provider === 'codex-oauth').enabled, false);

  let completion;
  const challenge = await startCodexOAuthLogin('alice', (result) => { completion = result; });
  assert.strictEqual(challenge.userCode, 'ABCD-1234');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepStrictEqual(completion, { success: true, error: undefined });
  assert.strictEqual(hasCodexOAuthSession('alice'), true);
  assert.strictEqual(hasCodexOAuthSession('bob'), false);
  assert.ok(codexAuthFile('alice').startsWith(codexHomeForOwner('alice')));
  assert.notStrictEqual(codexAuthFile('alice'), codexAuthFile('bob'));
  assert.strictEqual(codexOAuthStatus('alice').connected, true);

  const row = config.listRows('alice').find((item) => item.provider === 'codex-oauth');
  assert.strictEqual(row.enabled, true);
  assert.strictEqual(row.source, 'oauth');
  assert.match(row.key, /connected/);

  const [connection] = config.resolvePlanConnections('alice', undefined, false);
  assert.strictEqual(connection.provider, 'codex-oauth');
  assert.strictEqual(connection.model, 'gpt-5-codex');
  assert.strictEqual(connection.effectiveApiKey, undefined);
  assert.strictEqual(connection.source, 'oauth');

  const client = new LlmProviderClient();
  const raw = await client.completePlan(connection, { systemPrompt: 'system prompt', userPrompt: 'user prompt' });
  assert.strictEqual(raw.commands[0], '/limit BTC BUY 60000 0.01');

  const execSpawn = spawns.find((spawn) => spawn.kind === 'exec');
  assert.ok(execSpawn, 'codex exec should be used for codex-oauth planning');
  assert.ok(execSpawn.args.includes('--output-schema'));
  assert.ok(execSpawn.args.includes('--output-last-message'));
  assert.ok(execSpawn.args.includes('--sandbox'));
  assert.ok(execSpawn.args.includes('read-only'));
  assert.ok(execSpawn.args.includes('-'), 'prompt must be sent over stdin');
  assert.strictEqual(execSpawn.args.some((arg) => String(arg).includes('user prompt')), false, 'prompt must not be placed in argv');
  assert.match(execSpawn.proc.prompt, /user prompt/);
  assert.strictEqual(execSpawn.options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.strictEqual(execSpawn.options.env.TRADE_API_KEY, undefined);
  assert.strictEqual(execSpawn.options.env.TRADE_API_SECRET, undefined);
  assert.strictEqual(execSpawn.options.env.OPENAI_API_KEY, undefined);
  assert.strictEqual(execSpawn.options.env.CODEX_HOME, codexHomeForOwner('alice'));

  const planner = new LlmStrategyPlanner(config, client);
  const plan = await planner.plan({ ownerId: 'alice', prompt: 'buy btc', commandFormat: 'telegram', allowFallback: false });
  assert.strictEqual(plan.provider, 'codex-oauth');
  assert.strictEqual(plan.actions[0].inputs[0].kind, 'LIMIT');

  assert.strictEqual(logoutCodexOAuth('alice'), true);
  assert.strictEqual(hasCodexOAuthSession('alice'), false);
  assert.strictEqual(config.resolvePlanConnections('alice', undefined, false).length, 0, 'logout should disable this user codex provider');
  assert.strictEqual(hasCodexOAuthSession('bob'), false, 'logout must not affect another Telegram user');

  Module._load = originalLoad;
  console.log('codex-oauth tests passed');
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exit(1);
});
