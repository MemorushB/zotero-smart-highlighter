#!/usr/bin/env node

import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceSidecarPath = path.join(rootDir, 'addon', 'bin', 'darwin-arm64', 'zph-reranker');
const targetSidecarPath = path.join(rootDir, '.scaffold', 'build', 'addon', 'bin', 'darwin-arm64', 'zph-reranker');

async function main() {
  try {
    await stat(sourceSidecarPath);
  } catch {
    throw new Error(`Bundled sidecar source missing: ${sourceSidecarPath}`);
  }

  await mkdir(path.dirname(targetSidecarPath), { recursive: true });
  await copyFile(sourceSidecarPath, targetSidecarPath);
  await chmod(targetSidecarPath, 0o755);

  console.log(`[sidecar] Synced bundled sidecar to ${targetSidecarPath}.`);
}

main().catch((error) => {
  console.error(`[sidecar] ${error.message}`);
  process.exit(1);
});
