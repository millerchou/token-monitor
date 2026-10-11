'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { PUBLIC_URLS, assertPublicUrl, allowedRendererResource, localSessionRequest, IPC_CHANNELS } = require('../../src/localOnly/policy');
const { normalizePreferences, settingsForRenderer } = require('../../src/localOnly/settings');
const { fetchPublicJson, normalizeLiteLlm, normalizeModelsDev, normalizeOpenRouter, createPublicData } = require('../../src/localOnly/publicData');
const { collectorEnvironment } = require('../../src/localOnly/sandbox');

test('only exact public resources are allowed; account paths and URL tricks fail closed', () => {
  for (const url of Object.values(PUBLIC_URLS)) assert.equal(assertPublicUrl(url), url);
  const blocked = [
    'https://api.anthropic.com/api/oauth/usage', 'https://chatgpt.com/backend-api/wham/usage',
    'https://openrouter.ai/api/v1/key', 'https://auth.openai.com/oauth/token',
    'http://models.dev/api.json', 'https://models.dev:443/api.json',
    'https://models.dev/api.json?token=fake', 'https://models.dev/api.json#fragment',
    'https://user:fake@models.dev/api.json', 'https://models.dev.evil.example/api.json',
    'https://models.dev/%61pi.json', 'https://models.dev/x/../api.json',
    'https://codex-resets.com/api/v1/status', 'https://github.com/Javis603/token-monitor/releases/latest'
  ];
  for (const url of blocked) assert.throws(() => assertPublicUrl(url));
});

function responseRequest(status, value, record) {
  return (url, options, callback) => {
    record.push({ url, options });
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => req.emit('error', error);
    queueMicrotask(() => {
      const response = Readable.from([Buffer.from(JSON.stringify(value))]);
      response.statusCode = status;
      response.headers = { location: 'https://api.anthropic.com/api/oauth/usage' };
      callback(response);
    });
    return req;
  };
}

test('public downloader sends no credential headers and never follows redirects', async () => {
  const requests = [];
  assert.deepEqual(await fetchPublicJson(PUBLIC_URLS.modelsDev, { request: responseRequest(200, { ok: true }, requests) }), { ok: true });
  assert.equal(requests[0].options.method, 'GET');
  assert.deepEqual(Object.keys(requests[0].options.headers).sort(), ['accept', 'user-agent']);
  await assert.rejects(fetchPublicJson(PUBLIC_URLS.modelsDev, { request: responseRequest(302, {}, requests) }), /redirects are refused/);
  assert.equal(requests.length, 2);
  let called = false;
  assert.throws(() => fetchPublicJson('https://chatgpt.com/backend-api/wham/usage', { request: () => { called = true; } }));
  assert.equal(called, false);
});

test('untrusted saved settings and IPC patches cannot enable accounts or change destinations', () => {
  const hostile = { limitsEnabled: true, limitProviders: 'claude,codex', hubMode: 'client', hubUrl: 'https://example.test', claudeWebCookie: 'fake', codexManagedAccounts: [{ accessToken: 'fake' }], automaticAppUpdates: true };
  assert.deepEqual(normalizePreferences(hostile), {});
  assert.throws(() => normalizePreferences(hostile, { rejectUnknown: true }));
  const projected = settingsForRenderer(hostile);
  assert.equal(projected.limitsEnabled, false);
  assert.equal(projected.limitProviders, '');
  assert.equal(projected.hubMode, 'local');
  assert.equal(projected.hubUrl, '');
  assert.equal(projected.automaticAppUpdates, false);
  assert.deepEqual(projected.codexManagedAccounts, []);
  assert.equal('claudeWebCookie' in projected, false);
  assert.equal(IPC_CHANNELS.some((channel) => /^(codex:|claude:|limits:|cursor:|copilot:)/.test(channel)), false);
});

test('collector environment does not inherit secrets, runtime injection or proxy credentials', () => {
  const result = collectorEnvironment({ homeDir: '/Users/example', dataDir: '/tmp/token-monitor-test' });
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'TOKEN_MONITOR_HUB_URL']) assert.equal(key in result, false);
  assert.equal(result.TOKEN_MONITOR_WATCH_IN_PROCESS, '1');
});

test('renderer file URLs cannot read credentials or follow symlinks outside app assets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-renderer-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets'); fs.mkdirSync(assets);
  const script = path.join(assets, 'main.js'); fs.writeFileSync(script, '/* fixture */');
  const secret = path.join(root, 'auth.json'); fs.writeFileSync(secret, 'fake');
  const link = path.join(assets, 'escape.js'); fs.symlinkSync(secret, link);
  assert.equal(allowedRendererResource(pathToFileURL(script).href, [assets]), true);
  assert.equal(allowedRendererResource(pathToFileURL(secret).href, [assets]), false);
  assert.equal(allowedRendererResource(pathToFileURL(link).href, [assets]), false);
  assert.equal(allowedRendererResource('https://models.dev/api.json', [assets]), false);
});

test('session detail accepts upstream sessionId rows but refuses forged paths, clients and prices', () => {
  const { normalizePeriod } = require('../../src/shared/usage');
  const today = normalizePeriod({ sessions: { 'claude:fixture-session': { client: 'claude', sessionId: 'fixture-session', totalTokens: 10, costUsd: 0.1 } } });
  const stats = { periods: { today } };
  assert.deepEqual(localSessionRequest(stats, { client: 'claude', sessionId: 'fixture-session', period: 'today', sessionCost: 999 }),
    { client: 'claude', sessionId: 'fixture-session', period: 'today', sessionCost: 0.1 });
  for (const args of [
    { client: 'codex', sessionId: 'fixture-session', period: 'today' },
    { client: 'claude', sessionId: 'unobserved', period: 'today' },
    { client: 'claude', sessionId: '../auth.json', period: 'today' }
  ]) assert.throws(() => localSessionRequest(stats, args));
});

test('public prices preserve units, cache tiers, zero prices and reject invalid values', () => {
  const litellm = normalizeLiteLlm({ model: { input_cost_per_token: 1e-6, output_cost_per_token: 0, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost_above_1hr: 2e-6, input_cost_per_token_above_200k_tokens: 2e-6, irrelevant: 'discard', bad: -1 } });
  assert.equal(litellm.model.cache_read_input_token_cost, 1e-7);
  assert.equal(litellm.model.cache_creation_input_token_cost_above_1hr, 2e-6);
  assert.equal(litellm.model.output_cost_per_token, 0);
  assert.equal('irrelevant' in litellm.model, false);
  const models = normalizeModelsDev({ vendor: { models: { a: { cost: { input: 2, output: 4, cache_read: 0.2 } }, bad: { cost: { input: -1, output: 1 } } } } });
  assert.equal(models['vendor/a'].input_cost_per_token, 2e-6);
  assert.ok(Math.abs(models['vendor/a'].cache_read_input_token_cost - 2e-7) < 1e-20);
  assert.equal(models['vendor/bad'], undefined);
  assert.equal(normalizeOpenRouter({ data: [{ id: 'vendor/a', pricing: { prompt: '0.000002', completion: '0.000004' } }] })['vendor/a'].input_cost_per_token, 2e-6);
});

test('failed refreshes preserve the last good public cache and its age', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-public-data-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fails = false;
  const data = createPublicData({ dataDir: directory, now: () => 1234000, fetchJson: async (url) => {
    if (fails) throw new Error('offline');
    if (url === PUBLIC_URLS.litellm) return { model: { input_cost_per_token: 1e-6 } };
    if (url === PUBLIC_URLS.modelsDev) return { vendor: { models: { a: { cost: { input: 1, output: 2 } } } } };
    if (url === PUBLIC_URLS.openrouter) return { data: [{ id: 'a', pricing: { prompt: '0', completion: '0' } }] };
    throw new Error('no rates in this fixture');
  } });
  await data.refresh();
  const cached = fs.readFileSync(path.join(directory, 'tokscale/cache/pricing-litellm.json'), 'utf8');
  fails = true;
  await data.refresh({ force: true });
  assert.equal(fs.readFileSync(path.join(directory, 'tokscale/cache/pricing-litellm.json'), 'utf8'), cached);
  assert.equal(data.snapshot().sources.litellm.updatedAt, 1234000);
  assert.equal(data.snapshot().sources.litellm.error, 'offline');
});

test('the installed composition root cannot silently revert to upstream account code', () => {
  const root = path.resolve(__dirname, '../..');
  const pkg = require('../../package.json');
  assert.equal(pkg.main, 'src/localOnly/main.js');
  for (const script of ['hub', 'agent', 'agent:once']) assert.match(pkg.scripts[script], /local-only-disabled/);
  const visited = new Set();
  function walk(file) {
    if (visited.has(file) || path.extname(file) === '.json') return;
    visited.add(file);
    assert.doesNotMatch(file, /(?:credentialStore|\/providers\/.*\/(?:auth|limits|login)|\/electron\/main\.js)/);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = match[1];
      assert.doesNotMatch(name, /^(?:electron-updater|dotenv|@xhayper\/discord-rpc)$/);
      if (name.startsWith('.')) walk(require.resolve(path.resolve(path.dirname(file), name)));
    }
  }
  walk(path.join(root, pkg.main));
  assert.ok(visited.size > 5);
  const audit = require('../../src/localOnly/upstream-audit.json');
  const privilegedUpstreamFiles = [...visited].map((file) => path.relative(root, file))
    .filter((file) => !file.startsWith('src/localOnly/')).sort();
  assert.deepEqual(privilegedUpstreamFiles, Object.keys(audit.privilegedUpstreamFiles).sort(), 'A new privileged upstream dependency needs review');
  for (const [file, digest] of Object.entries(audit.privilegedUpstreamFiles)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), digest, `${file} changed: review it before updating the audit manifest`);
  }
  const builder = require('../../scripts/local-only-builder');
  assert.equal(builder.publish, null);
  assert.equal(builder.appId, 'com.millerchou.tokenmonitor.local');
  assert.equal(require('../../scripts/electron-builder.config').appId, builder.appId);
  for (const entry of ['start', 'widget', 'dev']) assert.match(pkg.scripts[`pre${entry}`], /local-only-check-scanner/);
  for (const entry of ['pack:mac:widget', 'dist:mac:widget', 'build:mac-widget']) assert.match(pkg.scripts[`pre${entry}`], /local-only-disabled/);
});
