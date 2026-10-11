'use strict';
const path = require('node:path');
const { app } = require('electron');
const { runApp } = require('../src/localOnly/main');
const { runSelfTest } = require('../src/localOnly/selfTest');
const target = path.resolve(process.argv[2] || 'tmp/local-only-smoke');
runSelfTest(runApp, target).then(() => app.quit(), (error) => { console.error(error.stack); app.exit(1); });
