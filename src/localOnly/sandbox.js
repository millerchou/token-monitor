'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG_SUFFIXES = Object.freeze([
  '.claude/projects', '.claude/transcripts', '.codex/sessions', '.codex/archived_sessions'
]);

function quote(value) {
  if (/[\u0000-\u001f]/.test(value)) throw new Error('Invalid sandbox path');
  return JSON.stringify(value);
}

function canonicalDirectory(value) {
  const result = fs.realpathSync(value);
  if (!path.isAbsolute(result) || result === '/') throw new Error('Unsafe sandbox root');
  return result;
}

function createSandboxProfile({ homeDir, dataDir, appRoot, executable, scanner }) {
  const home = canonicalDirectory(homeDir);
  const data = canonicalDirectory(dataDir);
  const code = canonicalDirectory(appRoot);
  if ([home, code].includes(data) || home.startsWith(data + path.sep)) throw new Error('Unsafe data directory');
  // Do not resolve symlinked log roots into arbitrary extra read grants. Seatbelt
  // checks the target path, so a link to credentials remains outside this list.
  const logs = LOG_SUFFIXES.map((suffix) => path.join(home, suffix));
  const binary = fs.realpathSync(executable);
  const appBoundary = binary.indexOf('.app' + path.sep);
  const runtime = appBoundary >= 0 ? binary.slice(0, appBoundary + 4)
    : binary.startsWith('/opt/homebrew/') ? '/opt/homebrew' : path.dirname(binary);
  const readRoots = [...logs, data, code, runtime,
    '/System/Library', '/System/Cryptexes', '/System/Volumes/Preboot', '/private/preboot',
    '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin',
    '/dev', '/private/etc', '/private/var/db/dyld', '/private/var/db/timezone', '/Library/Apple',
    '/private/var/db/com.apple.security.cryptexd', '/private/var/db/com.apple.dyld', '/Library/Caches/com.apple.dyld'
  ];
  // dyld opens ancestor directories with openat before opening the cache.
  // Literal directory grants permit traversal/listing, never their descendants.
  const directories = new Set(['/']);
  for (const root of readRoots) {
    for (let parent = path.dirname(root); parent !== '/'; parent = path.dirname(parent)) directories.add(parent);
  }
  return `(version 1)
(allow default)
(deny network*)
(deny file-read-data
  (require-all
    ${readRoots.map((root) => `(require-not (subpath ${quote(root)}))`).join('\n    ')}
    ${[...directories].map((directory) => `(require-not (literal ${quote(directory)}))`).join('\n    ')}))
; The name checks also cover credentials placed inside an otherwise allowed root.
(deny file-read-data
  (regex #"/(auth|credentials|\\.credentials)\\.json$")
  (subpath ${quote(path.join(home, 'Library/Keychains'))})
  (subpath "/Library/Keychains")
  (subpath "/private/var/db/SystemKey"))
(deny mach-lookup
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.security.agent"))
(deny file-write* (require-all
  (require-not (subpath ${quote(data)}))
  (require-not (literal "/dev/null"))))
(deny process-exec (require-all
  (require-not (literal ${quote(fs.realpathSync(executable))}))
  (require-not (literal ${quote(fs.realpathSync(scanner))}))))
`;
}

function collectorEnvironment({ dataDir }) {
  // Construct from scratch: no inherited provider tokens, NODE_OPTIONS, proxy
  // credentials, alternate credential roots, user .env or CLI configuration.
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TMPDIR: path.join(dataDir, 'tmp'),
    ELECTRON_RUN_AS_NODE: '1',
    TOKSCALE_CONFIG_DIR: path.join(dataDir, 'tokscale'),
    TOKEN_MONITOR_SHARED_DIR: path.join(dataDir, 'collector'),
    TOKEN_MONITOR_WATCH_IN_PROCESS: '1',
    TOKEN_MONITOR_USAGE_WORKER: '0'
  };
}

module.exports = { LOG_SUFFIXES, createSandboxProfile, collectorEnvironment };
