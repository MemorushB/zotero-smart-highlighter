#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const bundledSidecarPath = path.join(rootDir, 'addon', 'bin', 'darwin-arm64', 'zph-reranker');
const buildScriptPath = path.join(rootDir, 'scripts', 'build-sidecar.sh');

function parseMode(argv) {
  const modeIndex = argv.indexOf('--mode');
  if (modeIndex === -1 || modeIndex === argv.length - 1) {
    return 'build';
  }

  return argv[modeIndex + 1];
}

function runSidecarBuild() {
  const result = spawnSync('bash', [buildScriptPath], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (!existsSync(bundledSidecarPath)) {
    console.error(
      `[sidecar] Sidecar build completed without producing ${bundledSidecarPath}. ` +
        'Check scripts/build-sidecar.sh and the Swift build output before continuing.'
    );
    process.exit(1);
  }
}

const mode = parseMode(process.argv.slice(2));
const isSupportedBuildHost = process.platform === 'darwin' && process.arch === 'arm64';
const hasBundledSidecar = existsSync(bundledSidecarPath);

if (isSupportedBuildHost) {
  runSidecarBuild();
  process.exit(0);
}

if (mode === 'release') {
  console.error(
    `[sidecar] Refusing to package a release on ${process.platform}/${process.arch}: ` +
      'a fresh darwin-arm64 sidecar cannot be built here. Run `npm run release` on Apple Silicon macOS.'
  );
  process.exit(1);
}

if (!hasBundledSidecar) {
  console.error(
    `[sidecar] Missing bundled sidecar at ${bundledSidecarPath}. ` +
      'Build on Apple Silicon macOS with `npm run build:sidecar` before packaging.'
  );
  process.exit(1);
}

console.log(
  `[sidecar] Skipping local sidecar rebuild on ${process.platform}/${process.arch}; ` +
    `reusing existing bundled binary at ${bundledSidecarPath}.`
);
