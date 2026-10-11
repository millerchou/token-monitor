'use strict';

const { CLIENTS } = require('./policy');
const { normalizeCurrency, resolveEffectiveRates } = require('../shared/currency');

const DEFAULTS = Object.freeze({
  refreshMs: 15000, glassOpacity: 92, glassBlur: 20, backgroundImageOpacity: 28,
  systemGlass: false, windowsBackdrop: 'acrylic', macBackdrop: 'vibrancy',
  reduceMotion: 'system', showLiveDot: true, showToolIcons: true, titleIconOnly: false,
  showCompactTotalTokens: false, showLiveTokenRate: false, liveTokenRateScope: 'all',
  compactTokenUnits: 'western', tokenRateMode: 'speed', heatmapMetric: 'cost',
  modelRankingMetric: 'tokens', homeActiveDaysWindow: 'all', sessionContextMetric: 'used',
  sessionTitlesEnabled: true, periodMonthMode: 'month', themeColors: {}, vendorColors: {},
  textSize: 'standard', interfaceFontFamily: '', displayFontFamily: '',
  clientDisplayOrder: '', hiddenClients: '', pinnedClients: '', viewDisplayOrder: '', hiddenViews: 'limits,status,device',
  homeModuleOrder: '', hiddenHomeModules: 'limits,device', homeLimitDisplayMode: 'text', allTimeSince: '2024-01-01',
  currency: 'USD', language: 'zh-CN', zoomFactor: 1, showTrayIcon: true,
  alwaysOnTop: false, trayMode: false, trayContent: 'tokens', hideAppIcon: false
});

const BOOL_KEYS = new Set(Object.keys(DEFAULTS).filter((key) => typeof DEFAULTS[key] === 'boolean'));
const TEXT_KEYS = new Set(Object.keys(DEFAULTS).filter((key) => typeof DEFAULTS[key] === 'string'));
const NUMBER_RANGES = Object.freeze({
  refreshMs: [5000, 60000], glassOpacity: [20, 100], glassBlur: [0, 64],
  backgroundImageOpacity: [0, 100], zoomFactor: [0.75, 2]
});

function normalizePreferences(input = {}, { rejectUnknown = false } = {}) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid preferences');
  for (const [key, value] of Object.entries(input)) {
    if (BOOL_KEYS.has(key)) result[key] = value === true;
    else if (TEXT_KEYS.has(key)) result[key] = String(value || '').slice(0, 256);
    else if (NUMBER_RANGES[key]) {
      const [min, max] = NUMBER_RANGES[key];
      if (Number.isFinite(Number(value))) result[key] = Math.max(min, Math.min(max, Number(value)));
    } else if (['themeColors', 'vendorColors'].includes(key) && value && typeof value === 'object') {
      result[key] = Object.fromEntries(Object.entries(value).filter(([name, color]) =>
        /^[a-zA-Z0-9_-]{1,64}$/.test(name) && /^#[0-9a-fA-F]{3,8}$/.test(String(color))));
    } else if (rejectUnknown) {
      throw new Error(`Local edition: setting '${key}' is unavailable`);
    }
  }
  if (result.currency) result.currency = normalizeCurrency(result.currency);
  return result;
}

function settingsForRenderer(preferences, publicData = {}) {
  const locale = ['en', 'zh-CN', 'zh-TW', 'ko', 'ja', 'pt-BR'].includes(preferences?.language) ? preferences.language : 'zh-CN';
  const lockedHidden = (value, locked) => [...new Set([...locked, ...String(value || '').split(',').map((id) => id.trim()).filter(Boolean)])].join(',');
  return {
    ...structuredClone(DEFAULTS), ...normalizePreferences(preferences),
    localOnly: true, locale,
    clients: CLIENTS.join(','), deviceId: 'local', hubMode: 'local', hubUrl: '', secret: '',
    hubHostSecret: '', windowBehavior: preferences?.alwaysOnTop ? 'floating' : 'normal',
    projectsEnabled: true, historyEnabled: true, sessionUsageArchiveEnabled: false,
    wslScanEnabled: false, exportAutoEnabled: false, exportDir: '',
    collectionMode: 'live', collectionIntervalMs: 300000,
    customScanPaths: {}, customModelPricing: [], modelAliases: {}, modelAliasGrouping: 'off',
    limitsEnabled: false, limitProviders: '', limitProviderOrder: '', limitAccountForms: [],
    codexManagedAccounts: [], antigravityManagedAccounts: [], mimoManagedAccounts: [],
    codexResetForecastEnabled: false, codexLocalUsageEnabled: false, codexDotsVisible: false,
    discordRpcEnabled: false, automaticAppUpdates: false, startAtLogin: false,
    subscriptions: [], subscriptionsOrphaned: { records: [] }, subscriptionsShared: false,
    floatingBubbleEnabled: false, edgeDockEnabled: false, windowToggleShortcut: '',
    hiddenViews: lockedHidden(preferences?.hiddenViews, ['limits', 'status', 'device']),
    hiddenHomeModules: lockedHidden(preferences?.hiddenHomeModules, ['limits', 'device']),
    hiddenServiceProviders: 'claude,openai,cursor,deepseek', serviceStatusRefreshMs: 0,
    showHomeLimitBars: false, showHomeLimitProviderNames: false,
    homeLimitProviderOrder: '', hiddenHomeLimitProviders: '',
    currencyRates: {}, currencyRatesEffective: resolveEffectiveRates(publicData.rates?.rates || {}, {}),
    currencyRateInfo: publicData.rates || null, publicDataStatus: publicData
  };
}

module.exports = { DEFAULTS, normalizePreferences, settingsForRenderer };
