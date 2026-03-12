#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, stat, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const ensureSidecarBuildScriptPath = path.join(rootDir, 'scripts', 'ensure-sidecar-build.mjs');
const sourceSidecarPath = path.join(rootDir, 'addon', 'bin', 'darwin-arm64', 'zph-reranker');
const targetSidecarPath = path.join(rootDir, '.scaffold', 'build', 'addon', 'bin', 'darwin-arm64', 'zph-reranker');

async function syncBundledSidecar() {
  try {
    await stat(sourceSidecarPath);
  } catch {
    throw new Error(`Bundled sidecar source missing: ${sourceSidecarPath}`);
  }

  await mkdir(path.dirname(targetSidecarPath), { recursive: true });
  await copyFile(sourceSidecarPath, targetSidecarPath);
  await chmod(targetSidecarPath, 0o755);
}

function runEnsureSidecarBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ensureSidecarBuildScriptPath, '--mode', 'start'], {
      cwd: rootDir,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Sidecar preflight terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Sidecar preflight failed with exit code ${code ?? 1}`));
        return;
      }

      resolve();
    });

    child.on('error', reject);
  });
}

async function main() {
  await runEnsureSidecarBuild();

  const child = spawn('zotero-plugin', ['serve'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  void syncBundledSidecar().catch((error) => {
    console.error(`[sidecar] ${error.message}`);
  });

  const syncInterval = setInterval(() => {
    void syncBundledSidecar().catch((error) => {
      console.error(`[sidecar] ${error.message}`);
    });
  }, 1000);

  child.on('exit', (code, signal) => {
    clearInterval(syncInterval);

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });

  child.on('error', (error) => {
    clearInterval(syncInterval);
    console.error(`[sidecar] ${error.message}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(`[sidecar] ${error.message}`);
  process.exit(1);
});
