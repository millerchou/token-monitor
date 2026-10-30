'use strict';

// Keep the upstream charts and local-statistics UI, but remove controls that the
// local composition root cannot implement. Backend restrictions are independent
// of this presentation layer: unhiding an element never enables its endpoint.
(() => {
  // Keep WEEK independently selectable without replacing the upstream MONTH
  // slot and its optional rolling ranges. This runs before app.js binds tabs.
  const ranges = window.TokenMonitorFixedPeriodRanges;
  window.TokenMonitorFixedPeriodRanges = {
    ...ranges,
    slotForSelection: (period) => period === 'week' ? 'week' : ranges.slotForSelection(period)
  };
  const weekTab = document.createElement('button');
  weekTab.id = 'localWeekPeriodTab';
  weekTab.type = 'button';
  weekTab.className = 'tab';
  weekTab.dataset.period = 'week';
  weekTab.dataset.periodSlot = 'week';
  weekTab.textContent = 'WEEK';
  weekTab.title = '本周（周一 00:00 至今，本机时区）';
  document.getElementById('monthPeriodTab').before(weekTab);
  const catalog = window.TokenMonitorClientCatalog;
  window.TokenMonitorClientCatalog = {
    ...catalog,
    KNOWN_CLIENT_LIST: catalog.KNOWN_CLIENT_LIST.filter((client) => ['claude', 'codex'].includes(client.id))
  };
  const style = document.createElement('style');
  style.textContent = `
    .settings-group:has([data-settings-section="limits"]),
    .settings-group:has([data-settings-section="sync"]),
    .settings-group:has([data-settings-section="subscriptions"]),
    .settings-group:has([data-settings-section="window"]),
    #automaticAppUpdatesRow, #appUpdatePill, #appUpdatePopover,
    .settings-item:has(#discordRpcInput), .settings-item:has(#startAtLoginInput),
    .settings-item:has(#sessionUsageArchiveInput), .settings-export-block,
    .settings-item:has(#customScanPathsInput), #customPricingGroup, #modelAliasesGroup,
    #openConfigButton, #openTokscaleLinkButton, #aboutWebsiteButton, #aboutGithubButton,
    #appUpdateGroup, #codexLocalUsageGroup, #diagnosticsGroup,
    .app-update-settings, .settings-general-group .settings-subgroup:not(.settings-language-group),
    .background-image-setting, #modelAliasesAccountGroup, #customPricingAccountGroup,
    .settings-item:has(#sessionUsageArchiveInput), #sessionUsageArchiveStatus,
    .settings-item:has(#collectionCadenceInput), .settings-item:has(#collectionIntervalInput),
    .settings-item:has(#swapSettingsRefreshInput), #clearSessionUsageArchiveButton,
    #currencyRateRow .inline-options, #currencyRateManualField,
    #clientDisplayList input[data-preference="track"],
    .settings-actions:has(#clearSessionUsageArchiveButton),
    [data-view="limits"], [data-view="status"], [data-view="device"],
    [data-breakdown="limits"], [data-breakdown="status"], [data-breakdown="device"]
    { display: none !important; }
    .local-only-note { padding: 12px 16px; font: inherit; font-size: 12px; opacity: .8; }
    .title-controls { flex-basis: 200px; width: 200px; min-width: 200px; }
    .tabs { grid-template-columns: repeat(4, 1fr); }
    .tab-indicator { width: calc((100% - 12px) / 4); }
  `;
  document.head.append(style);
  for (const element of document.querySelectorAll('.app-title-text, .app-title-measure')) element.textContent = 'Token Monitor · 本地';
  const note = document.createElement('div');
  note.className = 'local-only-note';
  note.textContent = '本地版 · Claude / Codex 日志统计 · 仅更新公开价格与汇率';
  document.getElementById('settingsPanel')?.prepend(note);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'inline-link';
  refresh.textContent = '更新公开价格与汇率';
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try {
      const result = await window.tokenMonitor.refreshPublicData();
      const failed = result.rates?.error || Object.values(result.sources || {}).some((source) => source.error);
      refresh.textContent = failed ? '部分更新失败，保留可用缓存' : '公开数据更新完成';
    }
    catch (_) { refresh.textContent = '更新失败，保留本地缓存'; }
    finally { refresh.disabled = false; }
  });
  note.append(document.createElement('br'), refresh);
})();
