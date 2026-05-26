
const assert = require('assert');
const os = require('os');
const path = require('path');
const { parsePlanCommands, LlmStrategyPlanner, LlmDraftStore, LlmConfigStore, LlmProviderClient, isLlmDraftExpired } = require('../dist/llm');
function fakeConnection(provider, model) { return { ownerId: 'default', provider, model, apiKeyEnv: 'TEST_KEY', enabled: true, useAsFallback: true, createdAt: 0, updatedAt: 0, displayName: provider, protocol: 'openai-chat', effectiveApiKey: 'test', effectiveBaseUrl: 'https://example.test/v1', keySource: 'env', freeFallbackCandidate: false, source: 'env' }; }
(async () => {
  const cliActions = parsePlanCommands(['trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01', 'trigger:oco --symbol BTC --side SELL --take-profit 65000 --stop-loss 58000 --stop-limit 57950 --close-position'], { format: 'cli', defaultPaymentCurrency: 'USD' });
  assert.equal(cliActions.length, 2); assert.equal(cliActions[0].inputs[0].kind, 'LIMIT'); assert.equal(cliActions[0].inputs[0].side, 'BUY'); assert.equal(cliActions[0].inputs[0].quantity, 0.01); assert.equal(cliActions[1].action, 'oco'); assert.equal(cliActions[1].inputs[1].kind, 'STOP_LIMIT');
  const tgActions = parsePlanCommands(['/limit BTC BUY 60000 0.01', '/oco BTC SELL 65000 58000 close 57950'], { format: 'telegram', defaultPaymentCurrency: 'USD' });
  assert.equal(tgActions[0].inputs[0].quantity, 0.01); assert.equal(tgActions[1].inputs[0].closePosition, true);
  assert.throws(() => parsePlanCommands(['trigger:limit --symbol BTC --side BUY --price 60000 --source last --quantity 0.01'], { format: 'cli' }), /last\/mid\/mark|unsupported/i);
  assert.throws(() => parsePlanCommands(['trigger:limit --symbol BTC --side BUY --price 60000'], { format: 'cli' }), /explicit size/i);
  assert.throws(() => parsePlanCommands(['trigger:market --symbol BTC --side BUY --quantity 1'], { format: 'cli' }), /Unsupported/i);
  let calls = 0;
  const planner = new LlmStrategyPlanner({ resolvePlanConnections: () => [fakeConnection('openai', 'bad-model'), fakeConnection('gemini', 'good-model')] }, { completePlan: async (connection) => { calls += 1; if (connection.model === 'bad-model') return { summary: 'bad', commands: ['trigger:limit --symbol BTC --side BUY --price 60000'], riskNotes: [] }; return { summary: 'good', commands: ['trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01'], riskNotes: ['review before confirming'] }; } });
  const plan = await planner.plan({ prompt: 'buy btc on pullback', commandFormat: 'cli', defaultPaymentCurrency: 'USD' });
  assert.equal(calls, 2); assert.equal(plan.provider, 'gemini'); assert.equal(plan.actions[0].inputs[0].triggerPrice, 60000);
  const config = new LlmConfigStore(path.join(os.tmpdir(), `llm-config-${Date.now()}-${Math.random()}.json`));
  const rows = config.listRows('default');
  const ovhRow = rows.find((row) => row.provider === 'ovhcloud');
  assert.equal(ovhRow.enabled, true); assert.equal(ovhRow.source, 'anonymous'); assert.match(ovhRow.key, /anonymous/);
  const defaultConnections = config.resolvePlanConnections('default');
  assert.equal(defaultConnections[0].provider, 'ovhcloud'); assert.equal(defaultConnections[0].effectiveApiKey, undefined); assert.equal(defaultConnections[0].source, 'anonymous');
  const ovhClient = new LlmProviderClient(async (url, body, options) => {
    assert.match(url, /oai\.endpoints\.kepler\.ai\.cloud\.ovh\.net\/v1\/chat\/completions/);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(body.model, 'Meta-Llama-3_3-70B-Instruct');
    assert.equal(body.response_format.type, 'json_schema');
    return { data: { choices: [{ message: { content: JSON.stringify({ summary: 'ok', commands: ['trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01'], riskNotes: [] }) } }] } };
  });
  const ovhRaw = await ovhClient.completePlan(defaultConnections[0], { systemPrompt: 'system', userPrompt: 'user' });
  assert.equal(ovhRaw.commands[0], 'trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01');
  const drafts = new LlmDraftStore(path.join(os.tmpdir(), `llm-drafts-${Date.now()}-${Math.random()}.json`));
  const draft = drafts.add({ ownerId: 'u1', prompt: 'x', provider: 'openai', model: 'm', format: 'cli', summary: 's', commands: ['trigger:limit --symbol BTC --side BUY --price 60000 --quantity 0.01'], riskNotes: [] });
  assert.equal(drafts.get(draft.id, 'u1').status, 'PENDING');
  assert.equal(isLlmDraftExpired(draft, 1000, draft.createdAt + 500), false, 'fresh LLM drafts should remain confirmable');
  assert.equal(isLlmDraftExpired(draft, 1000, draft.createdAt + 1001), true, 'old LLM drafts should expire before order confirmation');
  const claimed = drafts.claimPending(draft.id, 'u1', 60_000);
  assert.equal(claimed.status, 'CONFIRMING', 'claimPending should reserve a draft before creating orders');
  assert.throws(() => drafts.claimPending(draft.id, 'u1', 60_000), /CONFIRMING/, 'double-confirming the same LLM draft should be rejected');
  drafts.mark(draft.id, 'CONFIRMED', 'u1'); assert.equal(drafts.get(draft.id, 'u1').status, 'CONFIRMED');
  console.log('llm-planner tests passed');
})();
