'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function cleanGeneratedBundleMetadata(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const root = fs.realpathSync(context.appOutDir);
  const bundle = fs.realpathSync(path.join(root, 'Token Monitor Local.app'));
  if (!bundle.startsWith(root + path.sep)) throw new Error('Refusing to alter metadata outside the generated bundle');
  // iCloud/Finder metadata can make codesign reject otherwise valid binaries.
  // Remove only these build detritus attributes, never quarantine/security data.
  for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
    try { execFileSync('/usr/bin/xattr', ['-dr', attribute, bundle], { stdio: 'pipe' }); }
    catch (error) {
      if (!String(error.stderr || '').includes('No such xattr')) throw error;
    }
  }
};
