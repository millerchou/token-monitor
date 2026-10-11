'use strict';

// No update feed, no native widget/login helper and a distinct app identity.
// Upstream release/signing/deployment workflows are intentionally untouched.
const original = require('../package.json').build;
module.exports = {
  ...original,
  appId: 'com.millerchou.tokenmonitor.local',
  productName: 'Token Monitor Local',
  publish: null,
  directories: { output: 'dist/local-only' },
  files: [...original.files, 'src/localOnly/**/*', '!src/electron/main.js', '!src/electron/preload.js', '!src/hub/**/*'],
  extraMetadata: { main: 'src/localOnly/main.js' },
  afterPack: require('./local-only-after-pack'),
  mac: {
    ...original.mac, forceCodeSigning: false, identity: '-', target: ['dir'],
    // Keep the verified upstream scanner bytes and its existing signature.
    // Re-signing it would invalidate the runtime SHA-256 provenance check.
    signIgnore: ['node_modules/@tokscale/.*/bin/tokscale$'],
    artifactName: 'Token-Monitor-Local-${version}-${arch}.${ext}'
  }
};
