# Token Monitor Local

This fork is a macOS edition of Token Monitor for **local Claude/Codex log statistics, public model prices and public exchange rates**. It retains the upstream renderer and usage collector so their local features and fixes can be merged from upstream.

## What runs

- `npm start` and the packaged app start `src/localOnly/main.js`. The upstream Electron account/sync/update composition root is not loaded or included in the local app.
- Main only handles an explicit IPC allowlist. It does not load provider account modules, read provider environment variables, invoke Keychain helpers, register account endpoints, start a Hub, sync to iCloud/Discord, or check/download upstream application updates.
- The renderer has Node integration off, Chromium sandboxing on, no network access and no file access outside application assets. Login/account actions have no backend handler. Existing account-list compatibility readouts return empty data in preload.
- The collector runs separately under macOS Seatbelt. It can read `.claude/projects`, `.claude/transcripts`, `.codex/sessions` and `.codex/archived_sessions`. Those sources are read-only. Other user data and credential files are denied, including symlinks whose targets are outside the read allowlist. Keychain files/services are denied. Network access, including loopback, is denied. Only the pinned scanner and the collector's Node/Electron runtime may be executed.
- Each collector launch first checks a **fake** credential canary, a denied loopback connection and a denied extra executable. If isolation fails, collection stops; there is no unrestricted fallback. Actual provider credentials are never used for this check.
- Collector environment variables are constructed from an allowlist. Provider tokens, `NODE_OPTIONS`, alternate provider homes and proxy credentials are not inherited. Provider settings and `.env` files are not imported.
- The native scanner SHA-256 must match `scripts/vendor/tokscale.json`. It reads public-price caches written by main, and cannot update prices or contact providers itself.

Seatbelt is applied only to the collector, preserving Electron's own Chromium sandbox. No firewall, proxy or Surge settings are required or changed. The system read allowlist includes macOS loader/cache paths and literal ancestor directories; a directory traversal grant does not grant access to its files.

## Allowed network requests

Only `src/localOnly/publicData.js` makes application network requests. It uses Node HTTPS with fixed GET requests, fixed non-secret headers, bounded responses and **no redirects**. Neither renderer data nor local usage influences the requested URLs.

| Purpose | Exact public resource |
| --- | --- |
| LiteLLM prices | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` |
| models.dev prices | `https://models.dev/api.json` |
| OpenRouter public model-list prices | `https://openrouter.ai/api/v1/models` |
| Exchange rates | `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json` |
| Exchange-rate fallback | `https://latest.currency-api.pages.dev/v1/currencies/usd.json` |

Prices refresh hourly; exchange rates refresh when the retained cache is at least one day old. A manual refresh is available in local settings and the tray menu. Failure preserves each last good cache and its original age. OpenRouter uses its public list prices; this edition does not issue per-model author-endpoint requests. Amounts are estimates, not account bills or remaining quota.

## Scope and storage

This build supports macOS on Apple Silicon or Intel with `sandbox-exec` available. Other operating systems fail closed until an equivalent isolation mechanism is implemented and tested. It currently collects the two local clients above; it does not implement remote-only usage sources, account limits, account switching, Dots traffic capture, device sync, Discord presence, service-status pages, widgets or upstream app updates.

Preferences and caches live separately in `~/Library/Application Support/Token Monitor Local/`. The app identifier is `com.millerchou.tokenmonitor.local`. It does not import the upstream app's settings, stored accounts or credentials. Disabling controls is not the enforcement boundary: edits to settings cannot enable these capabilities.

## Develop, verify and build

Use the Node version required by the upstream `package.json` and its lockfile. No extra dependencies were introduced for the local edition.

```sh
npm ci
npm run ensure:tokscale
npm run verify
npm run test:local-only
npm exec electron -- scripts/local-only-smoke.js tmp/local-only-smoke
local_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/token-monitor-local.XXXXXX")"
npm run pack -- --config.directories.output="$local_build_dir"
```

The smoke test uses fake prices, fake statistics and fake credentials. It checks the actual Electron renderer, account IPC denial and macOS collector isolation and saves a screenshot/result under its target directory. The macOS boundary test additionally checks read-only logs, credential symlinks and symlinks escaping outside the user's home. Never replace these tests with a real credential/API probe.

The built app also accepts `--local-only-self-test`. Run its executable from Terminal with that argument to verify the packaged renderer, pinned scanner and isolation using a fresh temporary profile. It prints the result directory and quits. This mode uses synthetic data; it never scans the user's logs. The offline-price fixture separately proves that a local log with 1,100 tokens costs exactly $1.20 under the supplied test prices while the native scanner has no network access.

`npm run pack` creates a locally ad-hoc signed app under `dist/local-only/`. It has no update feed or upstream widget helper. The already signed vendor scanner is preserved byte-for-byte so its runtime SHA-256 check remains meaningful. The build removes only FinderInfo/ResourceFork detritus from its generated bundle when needed for signing; it does not remove quarantine attributes or change system security settings. Local builds are not Apple-notarized distribution releases. Hub/agent and unsupported distribution commands are disabled in this fork. The upstream GitHub Actions files are retained for clean merges; this task does not enable or configure hosted CI, signing or deployment.

The command above overrides the default output directory with a unique system temporary directory. Use it when the checkout is inside iCloud-synced Documents: File Provider metadata can reappear between cleanup and signing. The signed app is under `$local_build_dir/mac-arm64/` on an Apple Silicon build. This changes only the build destination.

## Merge an upstream update

The fork's `main` holds the verified local edition. The upstream is `https://github.com/Javis603/token-monitor.git`. Use an update branch and merge; do not rebase or force-push.

1. Start from a clean local `main` and fetch `origin` and `upstream`. Select a specific release tag or commit. Do not overwrite `main` with GitHub's "sync fork" controls.
2. Create an update branch, then `git merge --no-commit --no-ff <upstream-ref>`. Preserve the local package entrypoint, disabled scripts, standard builder's local-config routing, local preload and `localOnly.js` renderer hook. Source launches have a preflight that validates the pinned scanner before the upstream preparation command; missing/changed binaries fail before any implicit download.
3. Review changes to the renderer/preload contract, usage collector, scanner pin and cache formats. Inspect the upstream modules imported by the privileged local main process. The audit manifest/test requires those modules to be reviewed if their content changes.
4. New IPC, network sources, log roots and executables are denied until explicitly reviewed. Do not resolve a conflict by allowing all requests, copying upstream settings into local preferences, bypassing the canary or starting the unrestricted collector. Remote/account-backed upstream features remain unavailable.
5. Run upstream verification, local policy/boundary tests, Electron smoke and packaged-app checks. Test failures or new paths must be understood before updating the audit manifest. A changed manifest is a review record, not a way to silence an unexplained failure.
6. Commit the reviewed merge, then fast-forward the fork's `main` after the checks pass. Build the local edition again and replace the previous local app. Never install an upstream binary over this build.

Pure renderer/collector improvements can often merge directly. New privileged APIs and platform integrations need a local adapter and additional validation; not every upstream feature is automatically compatible.
