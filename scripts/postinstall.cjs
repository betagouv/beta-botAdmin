#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const { readFileSync, writeFileSync, unlinkSync, existsSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const sdkDir = join(root, 'node_modules', 'matrix-bot-sdk');
const tscBin = join(root, 'node_modules', '.bin', 'tsc');

// Build the SDK from TypeScript source if lib/ is missing
if (!existsSync(join(sdkDir, 'lib', 'index.js'))) {
  console.log('[postinstall] Building matrix-bot-sdk from source...');
  const tsconfig = JSON.parse(readFileSync(join(sdkDir, 'tsconfig.json'), 'utf8'));
  // Exclude test files and strip jest types so the build doesn't require @types/jest
  tsconfig.include = ['./src/**/*'];
  delete tsconfig.compilerOptions.types;
  const tmpConfig = join(sdkDir, 'tsconfig-build.json');
  writeFileSync(tmpConfig, JSON.stringify(tsconfig, null, 2));
  try {
    execSync(`node "${tscBin}" -p tsconfig-build.json --skipLibCheck`, {
      stdio: 'inherit',
      cwd: sdkDir,
    });
  } finally {
    try { unlinkSync(tmpConfig); } catch {}
  }
  console.log('[postinstall] matrix-bot-sdk built.');
}

// Download the platform-specific native crypto binary
require(join(root, 'node_modules', '@matrix-org', 'matrix-sdk-crypto-nodejs', 'download-lib.js'));
