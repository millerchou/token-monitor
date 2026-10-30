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
  const now = new Date();
  stats.updatedAt = now.toISOString();
  const keyAt = (offset) => new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + offset)).toISOString().slice(0, 10);
  const elapsedWeekDays = (now.getDay() + 6) % 7;
  const todayKey = keyAt(0);
  const weekStart = keyAt(-elapsedWeekDays);
  for (const device of stats.devices) {
    device.updatedAt = stats.updatedAt;
    device.receivedAt = stats.updatedAt;
    device.periodWindows = {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      today: { key: todayKey, endsAt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString() }
    };
  }
  const day = (date, tokens, cost) => ({ date, tokens, cost,
    perClient: { claude: { tokens, cost } }, perModel: { 'claude-sonnet-4-6': { tokens, cost } } });
  const daily = [day(keyAt(-elapsedWeekDays - 1), 900000, 90)];
  for (let offset = -elapsedWeekDays; offset < 0; offset++) daily.push(day(keyAt(offset), 1000, 0.01));
  // Today's stale historical row must be replaced by the live 100,000 tokens.
  daily.push(day(todayKey, 1, 0));
  controller.publishStats(stats, { daily, monthly: [] });
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
  const remoteBlocked = await controller.win.webContents.executeJavaScript(`fetch('https://token-monitor-network-probe.invalid/').then(() => false, () => true)`);
  assert.equal(remoteBlocked, true);
  await controller.win.webContents.executeJavaScript(`document.getElementById('localWeekPeriodTab').click()`);
  let week;
  for (let tries = 0; tries < 80; tries++) {
    week = await controller.win.webContents.executeJavaScript(`({
      selection: state.period, status: state.fixedPeriodSnapshot?.status,
      range: state.fixedPeriodSnapshot?.range, totalTokens: state.fixedPeriodSnapshot?.period?.totalTokens,
      costUsd: state.fixedPeriodSnapshot?.period?.costUsd,
      tabs: [...document.querySelectorAll('.tab')].map(tab => tab.textContent),
      activeTabs: [...document.querySelectorAll('.tab.active')].map(tab => tab.textContent)
    })`);
    if (week.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(week.selection, 'week');
  assert.equal(week.status, 'ready', 'Weekly local history is unavailable');
  assert.deepEqual(week.tabs, ['DAY', 'WEEK', 'MONTH', 'TOTAL']);
  assert.deepEqual(week.activeTabs, ['WEEK']);
  assert.deepEqual(week.range, { start: weekStart, end: todayKey });
  assert.equal(week.totalTokens, 100000 + elapsedWeekDays * 1000);
  assert.ok(Math.abs(week.costUsd - (0.42 + elapsedWeekDays * 0.01)) < 1e-9);
  await controller.win.webContents.executeJavaScript(`window.tokenMonitor.updateSettings({periodMonthMode:'week'})`);
  await controller.win.webContents.executeJavaScript(`document.getElementById('monthPeriodTab').click()`);
  const monthSelection = await controller.win.webContents.executeJavaScript(`state.period`);
  assert.equal(monthSelection, 'month', 'MONTH remains independently selectable after WEEK');
  await controller.win.webContents.executeJavaScript(`document.getElementById('localWeekPeriodTab').click()`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
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
    totalTokens: 100000, week, monthSelection, errors: unexpected, output: directory };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(unexpected, []);
  console.log(JSON.stringify(result));
  return result;
}

module.exports = { runSelfTest };
