'use strict';

// A separate composition root keeps upstream account, updater, Hub, Discord,
// Keychain and CLI-login code out of the privileged main process entirely.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, session, nativeTheme, Tray, Menu, nativeImage, clipboard } = require('electron');
const { IPC_CHANNELS, CLIENTS, allowedRendererResource, localSessionRequest } = require('./policy');
const { DEFAULTS, normalizePreferences, settingsForRenderer } = require('./settings');
const { createPublicData, readJson, writeJson, REFRESH_MS } = require('./publicData');
const { startIsolatedCollector } = require('./runner');

const PRODUCT_NAME = 'Token Monitor Local';
const APP_VERSION = require('../../package.json').version;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

async function runApp(options = {}) {
  if (process.platform !== 'darwin') throw new Error('Local edition currently supports macOS only');
  app.setName(PRODUCT_NAME);
  const dataDir = options.dataDir || path.join(os.homedir(), 'Library', 'Application Support', PRODUCT_NAME);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', dataDir);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.enableSandbox();
  await app.whenReady();

  const indexPath = path.resolve(__dirname, '../electron/renderer/index.html');
  const pageUrl = pathToFileURL(indexPath).href;
  const settingsPath = path.join(dataDir, 'preferences.json');
  let preferences = { ...DEFAULTS, ...normalizePreferences(readJson(settingsPath, {})) };
  const publicData = createPublicData({ dataDir, ...(options.fetchJson ? { fetchJson: options.fetchJson } : {}) });
  const publicSession = session.defaultSession;
  publicSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  publicSession.setPermissionCheckHandler(() => false);
  publicSession.webRequest.onBeforeRequest((details, callback) => {
    // The UI is offline. The only network transport is publicData.js in main.
    callback({ cancel: !allowedRendererResource(details.url, [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../assets')]) });
  });
  publicSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] }
  }));
  publicSession.on('will-download', (event) => event.preventDefault());

  const win = new BrowserWindow({
    title: PRODUCT_NAME, width: 580, height: 820, minWidth: 420, minHeight: 500,
    show: options.show !== false, frame: false, transparent: false,
    backgroundColor: '#f5f4f0', alwaysOnTop: preferences.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: !app.isPackaged
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setZoomFactor(preferences.zoomFactor);

  let collector = null;
  let latest = null;
  let history = null;
  let connected = false;
  let isolation = null;
  let failure = '';
  let tray = null;
  let sequence = 0;
  const snapshots = new Map();
  const snapshotsLimit = 8;
  const currentSettings = () => settingsForRenderer(preferences, publicData.snapshot());
  const send = (channel, value) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
  };
  function showWindow() { win.show(); win.focus(); }
  function updateTray() {
    if (!tray) return;
    const total = Number(latest?.periods?.today?.totalTokens || 0);
    tray.setTitle(total >= 1e6 ? `${(total / 1e6).toFixed(1)}M` : total >= 1000 ? `${(total / 1000).toFixed(1)}K` : String(total));
    tray.setToolTip(`${PRODUCT_NAME} · Claude / Codex`);
  }
  if (options.tray !== false) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示本地统计', click: showWindow },
      { label: '刷新本地日志', click: () => collector?.refresh() },
      { label: '更新公开价格与汇率', click: () => { void refreshPublicData(true); } },
      { type: 'separator' }, { label: '退出', click: () => app.quit() }
    ]));
    tray.on('click', showWindow);
    updateTray();
  }

  function publishStats(stats, nextHistory) {
    if (!stats || typeof stats !== 'object') return;
    if (nextHistory) history = nextHistory;
    const stamp = { id: String(++sequence), source: 'local-only' };
    latest = { ...stats, snapshot: stamp, limits: { providers: [] } };
    snapshots.set(stamp.id, latest.periods?.allTime?.sessions || {});
    while (snapshots.size > snapshotsLimit) snapshots.delete(snapshots.keys().next().value);
    connected = true;
    failure = '';
    updateTray();
    send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'local', stats: latest, at: new Date().toISOString() } });
    send('stats:push', { event: 'status', data: { connected: true, mode: 'local' } });
    send('dashboard:historyChanged');
  }
  function onCollectorMessage(message) {
    if (message.type === 'boundary') isolation = message;
    if (message.type === 'stats') publishStats(message.stats, message.history);
    if (message.type === 'error') {
      failure = message.error;
      connected = false;
      send('stats:push', { event: 'status', data: { connected: false, mode: 'local', reason: failure } });
    }
    options.onCollectorMessage?.(message);
  }

  function assertSender(event) {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
      throw new Error('Local edition: IPC sender is not the local application');
    }
  }
  const registered = [];
  function handle(channel, fn) {
    if (!IPC_CHANNELS.includes(channel)) throw new Error(`Unreviewed IPC channel: ${channel}`);
    ipcMain.handle(channel, (event, ...args) => { assertSender(event); return fn(...args); });
    registered.push(channel);
  }
  function updatePreferences(patch) {
    preferences = { ...preferences, ...normalizePreferences(patch, { rejectUnknown: true }) };
    writeJson(settingsPath, normalizePreferences(preferences));
    win.setAlwaysOnTop(preferences.alwaysOnTop);
    win.webContents.setZoomFactor(preferences.zoomFactor);
    send('settings:push', currentSettings());
    return currentSettings();
  }
  function dashboardHistory() {
    const value = history || { daily: [], monthly: [] };
    return {
      ...value, deviceHistories: [{ deviceId: 'local', hostname: 'Local', ...value, history: value }],
      fixedPeriods: { historyTransportAvailable: Boolean(history) }
    };
  }
  async function refreshPublicData(force = false) {
    const result = await publicData.refresh({ force });
    send('settings:push', currentSettings());
    // A cache replacement needs a full scan, not just a watch delta.
    collector?.refresh();
    return result;
  }
  handle('settings:get', currentSettings);
  handle('settings:update', updatePreferences);
  handle('appearance:preview', (patch) => settingsForRenderer({ ...preferences, ...normalizePreferences(patch, { rejectUnknown: true }) }, publicData.snapshot()));
  handle('appearance:getBackgroundImage', () => null);
  handle('appearance:getNativeMaterial', () => ({ platform: 'darwin', supported: false, active: false }));
  handle('stats:get', (input) => { if (input?.force === true) collector?.refresh(); return latest; });
  handle('stats:allTimeSessions', (id) => snapshots.get(String(id)) || {});
  handle('session:getDetail', (args) => collector?.detail(localSessionRequest(latest, args)));
  handle('stream:status', () => ({ connected, mode: 'local', reason: failure || (connected ? '' : 'collecting') }));
  handle('dashboard:getHistory', dashboardHistory);
  handle('dashboard:open', () => { showWindow(); send('view:open', 'trends'); return true; });
  handle('usage:rescanClient', (client) => { if (!CLIENTS.includes(client)) throw new Error('Unsupported local client'); collector?.refresh(); return true; });
  handle('tray:setIcons', () => true);
  handle('clipboard:write', (text) => { if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid clipboard text'); clipboard.writeText(text); return true; });
  handle('app:getInfo', () => ({
    name: PRODUCT_NAME, version: `${APP_VERSION}-local.1`, platform: 'darwin',
    localOnly: true, systemDarkUi: nativeTheme.shouldUseDarkColors,
    loginItemSupported: false, loginItemOpenAtLogin: false, macWidgetSupported: false
  }));
  handle('tokscale:getStatus', () => ({ supported: true, current: { version: require('../../scripts/vendor/tokscale.json').baseVersion }, bundledBuild: { commit: require('../../scripts/vendor/tokscale.json').commit } }));
  // Compatibility readouts only: no account/sync/updater modules are imported.
  handle('appUpdate:getState', () => ({ currentVersion: APP_VERSION, hasUpdate: false, installSupported: false, localOnly: true }));
  handle('hub:getInfo', () => ({ mode: 'local', running: false, addresses: [] }));
  handle('hub:getBuildStatus', () => null);
  handle('syncContent:status', () => ({ supported: false, enabled: {}, error: 'unsupported' }));
  handle('publicData:refresh', () => refreshPublicData(true));
  const events = {
    'window:minimize': () => win.minimize(),
    'window:close': () => { if (tray) win.hide(); else app.quit(); },
    'window:contentReady': () => {},
    'window:viewState': () => {},
    'dashboard:ready': () => {},
    'dashboard:minimize': () => win.minimize(),
    'dashboard:close': () => win.hide()
  };
  for (const [channel, fn] of Object.entries(events)) {
    ipcMain.on(channel, (event) => { try { assertSender(event); fn(); } catch (_) {} });
  }
  win.on('show', () => send('window:visibility', true));
  win.on('hide', () => send('window:visibility', false));
  win.on('closed', () => app.quit());
  win.webContents.on('did-finish-load', () => {
    send('settings:push', currentSettings());
    if (latest) send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'local', stats: latest } });
  });
  await win.loadFile(indexPath);

  // A failed public request leaves cached data available; a failed isolation
  // check never falls back to an unrestricted collector.
  await refreshPublicData();
  try {
    collector = startIsolatedCollector({
      homeDir: os.homedir(), dataDir, version: APP_VERSION,
      probeOnly: options.probeOnly === true, onMessage: onCollectorMessage
    });
  } catch (_) {
    failure = '无法启动受限采集进程；未启用账号访问';
    send('stats:push', { event: 'status', data: { connected: false, mode: 'local', reason: failure } });
  }
  const timer = setInterval(() => { void refreshPublicData(); }, REFRESH_MS);
  timer.unref();
  function dispose() {
    clearInterval(timer);
    collector?.stop();
    tray?.destroy();
    for (const channel of registered) ipcMain.removeHandler(channel);
  }
  app.once('before-quit', dispose);
  return { win, publishStats, getState: () => ({ connected, failure, isolation, publicData: publicData.snapshot() }), dispose };
}

if (require.main === module) {
  const work = process.argv.includes('--local-only-self-test')
    ? require('./selfTest').runSelfTest(runApp).then(() => app.quit())
    : runApp();
  work.catch((error) => { console.error(`Token Monitor Local failed to start safely: ${error.message}`); app.exit(1); });
}

module.exports = { runApp, PRODUCT_NAME, CSP };
