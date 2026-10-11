'use strict';

// The packaged --local-only-self-test uses synthetic data and a fresh temporary
// profile. It never reads the user's logs or invokes a provider account API.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app } = require('electron');
const { PUBLIC_URLS } = require('./policy');
const { CURRENCY_CODES } = require('../shared/currency');

async function fetchFixture(url) {
  if (url === PUBLIC_URLS.litellm) return { 'fixture-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
  if (url === PUBLIC_URLS.modelsDev) return { fixture: { models: { model: { cost: { input: 1, output: 2 } } } } };
  if (url === PUBLIC_URLS.openrouter) return { data: [{ id: 'fixture/model', pricing: { prompt: '0.000001', completion: '0.000002' } }] };
  return { date: new Date().toISOString().slice(0, 10), usd: Object.fromEntries(CURRENCY_CODES.map((code) => [code.toLowerCase(), code === 'CNY' ? 7 : 1])) };
}

async function runSelfTest(runApp, target) {
  const directory = target || fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-local-self-test-'));
  fs.mkdirSync(directory, { recursive: true });
  const errors = [];
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => { if (event.level === 'error' || event.level === 3) errors.push(event.message); });
  });
  app.disableHardwareAcceleration();
  const controller = await runApp({ dataDir: path.join(directory, 'data'), fetchJson: fetchFixture, probeOnly: true, show: false, tray: false });
  controller.win.showInactive();
  for (let tries = 0; tries < 80 && !controller.getState().isolation; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const flag of ['credentialDenied', 'networkDenied', 'executionDenied']) assert.equal(controller.getState().isolation?.[flag], true, flag);

  const stats = structuredClone(require('./fixture-statistics.json'));
  stats.updatedAt = new Date().toISOString();
  for (const device of stats.devices) { device.updatedAt = stats.updatedAt; device.receivedAt = stats.updatedAt; }
  controller.publishStats(stats, { daily: [{ date: stats.updatedAt.slice(0, 10), totalTokens: 100000, costUsd: 0.42 }], monthly: [] });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const rendered = await controller.win.webContents.executeJavaScript(`(async () => ({
    node: typeof require,
    tokensVisible: /100,000|100000|100K|10万|10\\.0万/.test(document.body.innerText),
    settings: await window.tokenMonitor.getSettings(),
    totalTokens: (await window.tokenMonitor.getStats()).periods.today.totalTokens,
    settingsCannotEnableAccounts: await window.tokenMonitor.updateSettings({limitsEnabled:true}).then(() => false, () => true),
    accountActionsDisabled: await window.tokenMonitor.codex.addAccount().then(() => false, () => true)
  }))()`);
  assert.equal(rendered.node, 'undefined');
  assert.equal(rendered.accountActionsDisabled, true);
  assert.equal(rendered.settingsCannotEnableAccounts, true);
  assert.equal(rendered.settings.limitsEnabled, false);
  assert.equal(rendered.totalTokens, 100000);
  assert.equal(rendered.tokensVisible, true, 'Fixture statistics are not visible');
  const remoteBlocked = await controller.win.webContents.executeJavaScript(`fetch('https://chatgpt.com/backend-api/wham/usage').then(() => false, () => true)`);
  assert.equal(remoteBlocked, true);
  const preferences = controller.win.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  fs.writeFileSync(path.join(directory, 'preview.png'), (await controller.win.webContents.capturePage()).toPNG());
  const unexpected = errors.filter((message) => !/Content Security Policy|Refused to connect|Failed to fetch|connect-src/.test(message));
  const result = { ok: unexpected.length === 0, isolation: controller.getState().isolation, remoteBlocked,
    accountActionsDisabled: rendered.accountActionsDisabled, settingsCannotEnableAccounts: rendered.settingsCannotEnableAccounts,
    chromiumSandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
    totalTokens: 100000, errors: unexpected, output: directory };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify(result));
  return result;
}

module.exports = { runSelfTest };
