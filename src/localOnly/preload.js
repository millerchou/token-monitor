'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = {
  getSettings: 'settings:get', updateSettings: 'settings:update',
  getStats: 'stats:get', getAllTimeSessions: 'stats:allTimeSessions', getSessionDetail: 'session:getDetail',
  getStreamStatus: 'stream:status', getDashboardHistory: 'dashboard:getHistory', openDashboard: 'dashboard:open',
  getAppInfo: 'app:getInfo', previewAppearance: 'appearance:preview',
  getBackgroundImage: 'appearance:getBackgroundImage', getNativeMaterialState: 'appearance:getNativeMaterial',
  getTokscaleStatus: 'tokscale:getStatus', setTrayIcons: 'tray:setIcons', copyText: 'clipboard:write',
  rescanClient: 'usage:rescanClient', getAppUpdateState: 'appUpdate:getState',
  getHubInfo: 'hub:getInfo', getHubBuildStatus: 'hub:getBuildStatus', getSyncContentStatus: 'syncContent:status',
  refreshPublicData: 'publicData:refresh'
};
const events = {
  onStatsPush: 'stats:push', onSettingsPush: 'settings:push', onWindowVisibilityPush: 'window:visibility',
  onSystemUiThemePush: 'theme:systemUi', onNativeMaterialState: 'appearance:nativeMaterial',
  onDashboardHistoryChanged: 'dashboard:historyChanged', onOpenSettings: 'settings:open', onOpenView: 'view:open'
};
const bridge = Object.fromEntries(Object.entries(methods).map(([method, channel]) => [method, (...args) => ipcRenderer.invoke(channel, ...args)]));
for (const [method, channel] of Object.entries(events)) {
  bridge[method] = (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
const disabled = () => Promise.reject(new Error('This capability is disabled in Token Monitor Local'));
const noEvents = () => () => {};
const emptyAccounts = () => Promise.resolve([]);
const emptyProfiles = () => Promise.resolve({});

// The unchanged renderer can ask for account lists while constructing hidden
// settings panels. These compatibility functions have no IPC or secret inputs.
bridge.codex = { accounts: emptyAccounts, addAccount: disabled, selectWorkspace: disabled, cancelLogin: disabled,
  removeAccount: disabled, setAccountEnabled: disabled, switchSystemAccount: disabled, refreshAccountLimits: disabled,
  onActiveAccount: noEvents, onLoginStatus: noEvents };
bridge.antigravity = { accounts: emptyAccounts, addAccount: disabled, cancelLogin: disabled, removeAccount: disabled, setAccountEnabled: disabled, onAccounts: noEvents };
bridge.mimo = { accounts: emptyAccounts, addAccount: disabled, openConsole: disabled, removeAccount: disabled, setAccountEnabled: disabled, onAccounts: noEvents };
bridge.cursor = { status: () => Promise.resolve({ loggedIn: false, accounts: [] }), loginManual: disabled, logout: disabled, setAccountEnabled: disabled };
bridge.opencode = { status: () => Promise.resolve({ loggedIn: false }), getProfiles: emptyProfiles, saveCookie: disabled, logout: disabled,
  saveProfile: disabled, deleteProfile: disabled, renameProfile: disabled, removeCredential: disabled, moveCredential: disabled, setProfileEnabled: disabled, setAmbientEnabled: disabled };
bridge.openrouter = { getProfiles: emptyProfiles, saveProfile: disabled, deleteProfile: disabled, renameProfile: disabled, setProfileEnabled: disabled };
bridge.thirdparty = { getProfiles: emptyProfiles, saveProfile: disabled, deleteProfile: disabled, renameProfile: disabled, setProfileEnabled: disabled };
bridge.limitsAccounts = { saveCredential: disabled, listOrganizationChoices: disabled, clearCredential: disabled };
bridge.copilot = { signIn: disabled, cancelSignIn: disabled, onLoginStatus: noEvents };
for (const name of ['openExternal', 'openUserData', 'generateDiagnosticReport', 'clearSessionUsageArchive',
  'saveSubscriptions', 'adoptOrphanedSubscriptions', 'discardOrphanedSubscriptions', 'lookupModelPricing',
  'chooseBackgroundImage', 'clearBackgroundImage', 'deleteDevice', 'getServiceStatus', 'getCodexResetForecast',
  'previewSyncContent', 'configureSyncContent', 'retrySyncContentCleanup', 'regenerateHubSecret',
  'clientSources', 'pickCustomScanPath', 'revealClientSource', 'revealClientSyncLock', 'repairClientSyncLock',
  'exportNow', 'pickExportDir', 'checkAppUpdateNow', 'downloadAppUpdate', 'installAppUpdate', 'dismissAppUpdate',
  'expandFloatingBubble', 'moveFloatingBubble', 'peekFloatingBubble', 'collapseFloatingBubbleIfIdle', 'setFloatingBubbleCollapsedSize']) bridge[name] = disabled;
for (const name of ['onSyncContentPush', 'onHubPush', 'onAppUpdatePush', 'onFloatingBubbleState']) bridge[name] = noEvents;
bridge.minimize = () => ipcRenderer.send('window:minimize');
bridge.close = () => ipcRenderer.send('window:close');
bridge.signalContentReady = () => ipcRenderer.send('window:contentReady');
bridge.setViewState = () => {};
bridge.dashboard = { ready: () => {}, minimize: bridge.minimize, close: bridge.close };
contextBridge.exposeInMainWorld('tokenMonitor', bridge);
