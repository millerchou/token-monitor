'use strict';

// Source launches may validate the bundled scanner, but may never download a
// replacement implicitly. Dependency preparation is an explicit build step.
try {
  require('../src/localOnly/runner').scannerBinary();
} catch (_) {
  console.error('The pinned local scanner is not ready. Run npm run ensure:tokscale explicitly before starting this edition.');
  process.exitCode = 1;
}
