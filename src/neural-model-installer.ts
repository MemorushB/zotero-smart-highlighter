declare const Zotero: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;

import { getCurrentPluginRootURI, getCurrentPluginVersion } from './plugin-runtime';
import {
    describeBinaryPayload,
    ensureExtractedSidecarBinary,
    extractBinaryPayload,
    getSidecarBinPath,
} from './sidecar-binary';

export interface NeuralModelAssetMetadata {
    modelId: string;
    assetVersion: string;
    releaseTag: string;
    assetFileName: string;
    downloadUrl: string;
    zipSha256: string;
    packageDirectoryName: string;
    vocabFileName: string;
    manifestFileName: string;
}

export interface BundledNeuralModelManifest {
    modelId: string;
    assetVersion: string;
    releaseTag: string;
    assetFileName: string;
    packageDirectoryName: string;
    vocabFileName: string;
    pluginMinVersion?: string;
}

export interface InstalledNeuralModelManifest extends BundledNeuralModelManifest {
    zipSha256: string;
    installedAt: string;
    sourceUrl: string;
    compiledAt?: string;
    compiledRelativePath?: string;
    compiledSourceZipSha256?: string;
    compiledSourcePackageDirectoryName?: string;
    compiledBySidecarVersion?: string;
    compiledByPluginVersion?: string;
    platform?: string;
    verifiedLoad?: boolean;
}

export interface NeuralModelInstallPaths {
    pluginDataRoot: string;
    modelsDirectory: string;
    rawModelPackagePath: string;
    modelPackagePath: string;
    compiledDirectory: string;
    compiledModelPath: string;
    vocabPath: string;
    manifestPath: string;
    sidecarMetadataPath: string;
    tempRoot: string;
}

export type NeuralModelInstallState =
    | 'not-supported'
    | 'unconfigured'
    | 'not-installed'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'compiling'
    | 'not-compiled'
    | 'installed'
    | 'corrupt'
    | 'incompatible'
    | 'failed';

export interface NeuralModelInstallStatus {
    state: NeuralModelInstallState;
    paths: NeuralModelInstallPaths;
    supportedAsset: NeuralModelAssetMetadata;
    manifest: InstalledNeuralModelManifest | null;
    isInstalledUsable: boolean;
    rawAssetsPresent: boolean;
    compiledAssetsPresent: boolean;
    missingEntries: string[];
    missingRawEntries: string[];
    missingCompiledEntries: string[];
    detail: string | null;
    error: string | null;
}

export type NeuralModelInstallStatusListener = (status: NeuralModelInstallStatus) => void;

interface ParsedPluginVersion {
    raw: string;
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

interface ValidationResult {
    manifest: InstalledNeuralModelManifest | null;
    rawAssetsPresent: boolean;
    compiledAssetsPresent: boolean;
    missingRawEntries: string[];
    missingCompiledEntries: string[];
    detail: string | null;
}

interface BundledRawValidationResult {
    bundledManifest: BundledNeuralModelManifest;
    paths: NeuralModelInstallPaths;
}

interface SidecarCompileJsonPayload {
    status?: unknown;
    mode?: unknown;
    version?: unknown;
    source_model_path?: unknown;
    compiled_model_path?: unknown;
    verified_load?: unknown;
}

interface SidecarValidateJsonPayload {
    status?: unknown;
    mode?: unknown;
    version?: unknown;
    compiled_model_path?: unknown;
    verified_load?: unknown;
}

interface SidecarCompileResult {
    version: string;
    compiledModelPath: string;
    verifiedLoad: boolean;
}

const LOG_PREFIX = '[Smart Highlighter neural]';
const PLUGIN_DATA_DIR = 'zotero-pdf-highlighter';
const MODEL_DIR_NAME = 'models';
const COMPILED_MODEL_DIR_NAME = 'compiled';
const MODEL_FILENAME = 'ms-marco-MiniLM-L6-v2.mlpackage';
const MODEL_VOCAB_FILENAME = 'vocab.txt';
const MODEL_MANIFEST_FILENAME = 'manifest.json';
const SIDECAR_JSON_FILENAME = 'sidecar.json';
const TEMP_DIR_NAME = 'tmp';
const MODEL_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const FILE_OPERATION_TIMEOUT_MS = 60 * 1000;
const UNZIP_TIMEOUT_MS = 2 * 60 * 1000;
const MODEL_COMPILE_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_VALIDATE_TIMEOUT_MS = 2 * 60 * 1000;
const MODEL_RELEASE_TAG = 'model-ms-marco-minilm-l6-v2-2026.03.10.1';
const MODEL_ASSET_FILENAME = 'zotero-smart-highlighter-model-ms-marco-MiniLM-L6-v2-2026.03.10.1.zip';
const MODEL_DOWNLOAD_URL = `https://github.com/MemorushB/zotero-smart-highlighter/releases/download/${MODEL_RELEASE_TAG}/${MODEL_ASSET_FILENAME}`;
const UNCONFIGURED_MODEL_ZIP_SHA256 = '__UNCONFIGURED_MODEL_ZIP_SHA256__';
const MODEL_ZIP_SHA256 = '24538066998f9c4bd52c27ac5761cc9358a8350965a68023f3bd1161c5509e87';

export const SUPPORTED_NEURAL_MODEL_ASSET: NeuralModelAssetMetadata = {
    modelId: 'ms-marco-MiniLM-L6-v2',
    assetVersion: '2026.03.10.1',
    releaseTag: MODEL_RELEASE_TAG,
    assetFileName: MODEL_ASSET_FILENAME,
    downloadUrl: MODEL_DOWNLOAD_URL,
    zipSha256: MODEL_ZIP_SHA256,
    packageDirectoryName: MODEL_FILENAME,
    vocabFileName: MODEL_VOCAB_FILENAME,
    manifestFileName: MODEL_MANIFEST_FILENAME,
};

export const CURRENT_NEURAL_MODEL_ASSET = SUPPORTED_NEURAL_MODEL_ASSET;

function logDebug(message: string): void {
    Zotero.debug(`${LOG_PREFIX} ${message}`);
}

function createNsIFile(path: string): any | null {
    const file = Components?.classes?.['@mozilla.org/file/local;1']
        ?.createInstance?.(Components?.interfaces?.nsIFile);
    if (!file) {
        return null;
    }

    file.initWithPath(path);
    return file;
}

function pathExists(path: string): boolean {
    try {
        return Boolean(createNsIFile(path)?.exists());
    } catch {
        return false;
    }
}

function isDirectoryPath(path: string): boolean {
    try {
        return Boolean(createNsIFile(path)?.isDirectory());
    } catch {
        return false;
    }
}

function isRegularFilePath(path: string): boolean {
    try {
        return Boolean(createNsIFile(path)?.isFile());
    } catch {
        return false;
    }
}

function listDirectoryEntries(path: string): string[] {
    try {
        const file = createNsIFile(path);
        if (!file?.exists() || !file.isDirectory()) {
            return [];
        }

        const entries: string[] = [];
        const directoryEntries = file.directoryEntries;
        while (directoryEntries?.hasMoreElements()) {
            const entry = directoryEntries.getNext();
            const entryFile = entry?.QueryInterface?.(Components?.interfaces?.nsIFile) ?? entry;
            if (typeof entryFile?.leafName === 'string' && entryFile.leafName) {
                entries.push(entryFile.leafName);
            }
        }

        return entries;
    } catch {
        return [];
    }
}

function readUtf8FileSync(path: string): string | null {
    try {
        const file = createNsIFile(path);
        if (!file?.exists() || !file.isFile()) {
            return null;
        }

        const inputStream = Components?.classes?.['@mozilla.org/network/file-input-stream;1']
            ?.createInstance?.(Components?.interfaces?.nsIFileInputStream);
        const converterStream = Components?.classes?.['@mozilla.org/intl/converter-input-stream;1']
            ?.createInstance?.(Components?.interfaces?.nsIConverterInputStream);
        if (!inputStream || !converterStream) {
            return null;
        }

        inputStream.init(file, 0x01, 0, 0);
        converterStream.init(
            inputStream,
            'UTF-8',
            0,
            Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER
        );

        const chunk = { value: '' };
        let content = '';
        while (converterStream.readString(0xffffffff, chunk) !== 0) {
            content += chunk.value;
        }

        converterStream.close();
        inputStream.close();
        return content;
    } catch {
        return null;
    }
}

function splitParentAndLeaf(path: string): { parentPath: string; leafName: string } {
    const lastSlashIndex = path.lastIndexOf('/');
    if (lastSlashIndex <= 0 || lastSlashIndex === path.length - 1) {
        throw new Error(`Cannot split path: ${path}`);
    }

    return {
        parentPath: path.slice(0, lastSlashIndex),
        leafName: path.slice(lastSlashIndex + 1),
    };
}

function getParentPath(path: string): string {
    return splitParentAndLeaf(path).parentPath;
}

function movePathAtomically(sourcePath: string, destinationPath: string): void {
    const sourceFile = createNsIFile(sourcePath);
    if (!sourceFile?.exists()) {
        throw new Error(`Cannot move missing path: ${sourcePath}`);
    }

    const { parentPath, leafName } = splitParentAndLeaf(destinationPath);
    const parentFile = createNsIFile(parentPath);
    if (!parentFile?.exists() || !parentFile.isDirectory()) {
        throw new Error(`Destination parent directory missing: ${parentPath}`);
    }

    sourceFile.moveTo(parentFile, leafName);
}

async function removePathIfPresent(path: string): Promise<void> {
    if (!pathExists(path)) {
        return;
    }

    await IOUtils.remove(path, {
        ignoreAbsent: true,
        recursive: true,
    });
}

function getResponseStatus(response: { status?: unknown } | null | undefined): number | null {
    return typeof response?.status === 'number' ? response.status : null;
}

function createUniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeSha256Hex(value: string): string | null {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) {
        return null;
    }

    return /^[a-f0-9]{64}$/.test(normalizedValue) ? normalizedValue : null;
}

function getCompiledModelDirectoryName(packageDirectoryName: string): string {
    const basename = packageDirectoryName.replace(/\.mlpackage$/i, '');
    return `${basename}.mlmodelc`;
}

function getCompiledRelativePath(packageDirectoryName: string): string {
    return `${COMPILED_MODEL_DIR_NAME}/${getCompiledModelDirectoryName(packageDirectoryName)}`;
}

function getCurrentPlatformIdentifier(): string {
    return 'darwin-arm64';
}

function createInstallStatus(
    state: NeuralModelInstallState,
    overrides: Partial<NeuralModelInstallStatus> = {}
): NeuralModelInstallStatus {
    return {
        state,
        paths: overrides.paths ?? getNeuralModelInstallPaths(),
        supportedAsset: CURRENT_NEURAL_MODEL_ASSET,
        manifest: overrides.manifest ?? null,
        isInstalledUsable: overrides.isInstalledUsable ?? state === 'installed',
        rawAssetsPresent: overrides.rawAssetsPresent ?? false,
        compiledAssetsPresent: overrides.compiledAssetsPresent ?? false,
        missingEntries: overrides.missingEntries ?? [],
        missingRawEntries: overrides.missingRawEntries ?? [],
        missingCompiledEntries: overrides.missingCompiledEntries ?? [],
        detail: overrides.detail ?? null,
        error: overrides.error ?? null,
    };
}

function emitStatus(
    onStatusChange: NeuralModelInstallStatusListener | undefined,
    status: NeuralModelInstallStatus
): NeuralModelInstallStatus {
    onStatusChange?.(status);
    return status;
}

function parseManifestFields(
    rawContent: string,
    requireInstallMetadata: boolean
): InstalledNeuralModelManifest | BundledNeuralModelManifest | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawContent);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const record = parsed as Record<string, unknown>;
    const requiredStringKeys = [
        'modelId',
        'assetVersion',
        'releaseTag',
        'assetFileName',
        'packageDirectoryName',
        'vocabFileName',
    ] as const;

    for (const key of requiredStringKeys) {
        if (typeof record[key] !== 'string' || !record[key]) {
            return null;
        }
    }

    if (record.pluginMinVersion !== undefined && (typeof record.pluginMinVersion !== 'string' || !record.pluginMinVersion)) {
        return null;
    }

    if (!requireInstallMetadata) {
        return {
            modelId: record.modelId as string,
            assetVersion: record.assetVersion as string,
            releaseTag: record.releaseTag as string,
            assetFileName: record.assetFileName as string,
            packageDirectoryName: record.packageDirectoryName as string,
            vocabFileName: record.vocabFileName as string,
            pluginMinVersion: record.pluginMinVersion as string | undefined,
        };
    }

    const requiredInstallKeys = ['zipSha256', 'installedAt', 'sourceUrl'] as const;
    for (const key of requiredInstallKeys) {
        if (typeof record[key] !== 'string' || !record[key]) {
            return null;
        }
    }

    if (record.compiledAt !== undefined && typeof record.compiledAt !== 'string') {
        return null;
    }
    if (record.compiledRelativePath !== undefined && typeof record.compiledRelativePath !== 'string') {
        return null;
    }
    if (record.compiledSourceZipSha256 !== undefined && typeof record.compiledSourceZipSha256 !== 'string') {
        return null;
    }
    if (record.compiledSourcePackageDirectoryName !== undefined && typeof record.compiledSourcePackageDirectoryName !== 'string') {
        return null;
    }
    if (record.compiledBySidecarVersion !== undefined && typeof record.compiledBySidecarVersion !== 'string') {
        return null;
    }
    if (record.compiledByPluginVersion !== undefined && typeof record.compiledByPluginVersion !== 'string') {
        return null;
    }
    if (record.platform !== undefined && typeof record.platform !== 'string') {
        return null;
    }
    if (record.verifiedLoad !== undefined && typeof record.verifiedLoad !== 'boolean') {
        return null;
    }

    return {
        modelId: record.modelId as string,
        assetVersion: record.assetVersion as string,
        releaseTag: record.releaseTag as string,
        assetFileName: record.assetFileName as string,
        packageDirectoryName: record.packageDirectoryName as string,
        vocabFileName: record.vocabFileName as string,
        zipSha256: record.zipSha256 as string,
        installedAt: record.installedAt as string,
        sourceUrl: record.sourceUrl as string,
        pluginMinVersion: record.pluginMinVersion as string | undefined,
        compiledAt: record.compiledAt as string | undefined,
        compiledRelativePath: record.compiledRelativePath as string | undefined,
        compiledSourceZipSha256: record.compiledSourceZipSha256 as string | undefined,
        compiledSourcePackageDirectoryName: record.compiledSourcePackageDirectoryName as string | undefined,
        compiledBySidecarVersion: record.compiledBySidecarVersion as string | undefined,
        compiledByPluginVersion: record.compiledByPluginVersion as string | undefined,
        platform: record.platform as string | undefined,
        verifiedLoad: record.verifiedLoad as boolean | undefined,
    };
}

function parsePluginVersion(version: string): ParsedPluginVersion | null {
    const normalizedVersion = version.trim();
    const match = normalizedVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) {
        return null;
    }

    return {
        raw: normalizedVersion,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split('.') : [],
    };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index += 1) {
        const leftIdentifier = left[index];
        const rightIdentifier = right[index];

        if (leftIdentifier === undefined) {
            return -1;
        }
        if (rightIdentifier === undefined) {
            return 1;
        }

        const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : null;
        const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : null;
        if (leftNumber !== null && rightNumber !== null) {
            if (leftNumber !== rightNumber) {
                return leftNumber - rightNumber;
            }
            continue;
        }
        if (leftNumber !== null) {
            return -1;
        }
        if (rightNumber !== null) {
            return 1;
        }
        if (leftIdentifier !== rightIdentifier) {
            return leftIdentifier < rightIdentifier ? -1 : 1;
        }
    }

    return 0;
}

function compareParsedPluginVersions(left: ParsedPluginVersion, right: ParsedPluginVersion): number {
    if (left.major !== right.major) {
        return left.major - right.major;
    }
    if (left.minor !== right.minor) {
        return left.minor - right.minor;
    }
    if (left.patch !== right.patch) {
        return left.patch - right.patch;
    }
    if (!left.prerelease.length && !right.prerelease.length) {
        return 0;
    }
    if (!left.prerelease.length) {
        return 1;
    }
    if (!right.prerelease.length) {
        return -1;
    }

    return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

function getPluginVersionCompatibilityIssue(pluginMinVersion: string | undefined): string | null {
    if (!pluginMinVersion) {
        return null;
    }

    const parsedRequiredVersion = parsePluginVersion(pluginMinVersion);
    if (!parsedRequiredVersion) {
        return `Model manifest pluginMinVersion ${pluginMinVersion} is not a valid semver version`;
    }

    const currentPluginVersion = getCurrentPluginVersion();
    if (!currentPluginVersion) {
        return `Model requires plugin >= ${pluginMinVersion}, but the current plugin version is unavailable at runtime`;
    }

    const parsedCurrentVersion = parsePluginVersion(currentPluginVersion);
    if (!parsedCurrentVersion) {
        return `Current plugin version ${currentPluginVersion} is not a valid semver version`;
    }

    if (compareParsedPluginVersions(parsedCurrentVersion, parsedRequiredVersion) < 0) {
        return `Model requires plugin >= ${pluginMinVersion}, but current plugin is ${currentPluginVersion}`;
    }

    return null;
}

function getBundledManifestCompatibilityIssue(manifest: BundledNeuralModelManifest): string | null {
    if (manifest.modelId !== CURRENT_NEURAL_MODEL_ASSET.modelId) {
        return `Installed modelId ${manifest.modelId} does not match supported modelId ${CURRENT_NEURAL_MODEL_ASSET.modelId}`;
    }
    if (manifest.assetVersion !== CURRENT_NEURAL_MODEL_ASSET.assetVersion) {
        return `Installed assetVersion ${manifest.assetVersion} does not match supported assetVersion ${CURRENT_NEURAL_MODEL_ASSET.assetVersion}`;
    }
    if (manifest.releaseTag !== CURRENT_NEURAL_MODEL_ASSET.releaseTag) {
        return `Installed releaseTag ${manifest.releaseTag} does not match supported releaseTag ${CURRENT_NEURAL_MODEL_ASSET.releaseTag}`;
    }
    if (manifest.assetFileName !== CURRENT_NEURAL_MODEL_ASSET.assetFileName) {
        return `Installed assetFileName ${manifest.assetFileName} does not match supported assetFileName ${CURRENT_NEURAL_MODEL_ASSET.assetFileName}`;
    }
    if (manifest.packageDirectoryName !== CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName) {
        return `Installed packageDirectoryName ${manifest.packageDirectoryName} does not match supported packageDirectoryName ${CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName}`;
    }
    if (manifest.vocabFileName !== CURRENT_NEURAL_MODEL_ASSET.vocabFileName) {
        return `Installed vocabFileName ${manifest.vocabFileName} does not match supported vocabFileName ${CURRENT_NEURAL_MODEL_ASSET.vocabFileName}`;
    }

    return getPluginVersionCompatibilityIssue(manifest.pluginMinVersion);
}

function getConfiguredModelZipSha256(): string | null {
    const normalizedZipSha256 = CURRENT_NEURAL_MODEL_ASSET.zipSha256.trim().toLowerCase();
    if (!normalizedZipSha256 || normalizedZipSha256 === UNCONFIGURED_MODEL_ZIP_SHA256.toLowerCase()) {
        return null;
    }

    return normalizeSha256Hex(normalizedZipSha256);
}

function hasConfiguredDownloadMetadata(): boolean {
    return getConfiguredModelZipSha256() !== null;
}

function getUnconfiguredModelDetail(): string {
    return `Neural model download metadata is not configured yet. Publish ${CURRENT_NEURAL_MODEL_ASSET.assetFileName} and set CURRENT_NEURAL_MODEL_ASSET.zipSha256 to a real SHA-256 value before enabling installs.`;
}

function assertConfiguredDownloadMetadata(): void {
    if (!hasConfiguredDownloadMetadata()) {
        throw new Error(getUnconfiguredModelDetail());
    }
}

async function computeSha256Hex(buffer: ArrayBuffer | ArrayBufferView): Promise<string> {
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject?.subtle) {
        throw new Error('WebCrypto SHA-256 support is not available');
    }

    const bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = await cryptoObject.subtle.digest('SHA-256', digestInput);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function unzipArchive(zipPath: string, destinationDirectory: string): Promise<void> {
    const result = await runSubprocessWithOutput('/usr/bin/unzip', ['-qq', zipPath, '-d', destinationDirectory], {
        timeoutMs: UNZIP_TIMEOUT_MS,
        timeoutLabel: 'unzip',
    });
    const exitCode = result.exitCode;
    if (exitCode !== 0) {
        throw new Error(`unzip exited with code ${exitCode}`);
    }
}

async function readPipeAsString(pipe: any): Promise<string> {
    if (!pipe || typeof pipe.readString !== 'function') {
        return '';
    }

    try {
        return await pipe.readString();
    } catch {
        return '';
    }
}

async function waitForProcessExit(proc: any): Promise<{ exitCode?: unknown }> {
    try {
        return await proc.wait();
    } catch {
        return {};
    }
}

async function killProcessAndWait(proc: any): Promise<void> {
    try {
        proc.kill();
    } catch {
        // Process already exited.
    }

    await waitForProcessExit(proc);
}

async function runSubprocessWithOutput(
    command: string,
    argumentsList: string[],
    options: { timeoutMs?: number; timeoutLabel?: string } = {}
): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}> {
    const { timeoutMs = FILE_OPERATION_TIMEOUT_MS, timeoutLabel = command } = options;
    const { Subprocess } = ChromeUtils.importESModule(
        'resource://gre/modules/Subprocess.sys.mjs'
    );
    const proc = await Subprocess.call({
        command,
        arguments: argumentsList,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    let didTimeout = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const waitForExit = Promise.race([
        waitForProcessExit(proc),
        new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                didTimeout = true;
                void killProcessAndWait(proc).finally(() => {
                    reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
                });
            }, timeoutMs);
        }),
    ]);

    try {
        const [stdout, stderr, result] = await Promise.all([
            readPipeAsString(proc.stdout),
            readPipeAsString(proc.stderr),
            waitForExit,
        ]);
        const exitCode = Number((result as { exitCode?: unknown })?.exitCode ?? 0);

        return { exitCode, stdout, stderr };
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }

        if (didTimeout) {
            await killProcessAndWait(proc);
        }
    }
}

async function copyPathToDirectory(sourcePath: string, destinationDirectory: string): Promise<void> {
    const result = await runSubprocessWithOutput('/bin/cp', ['-R', sourcePath, destinationDirectory], {
        timeoutMs: FILE_OPERATION_TIMEOUT_MS,
        timeoutLabel: 'copy',
    });
    if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim() || `cp exited with code ${result.exitCode}`;
        throw new Error(`Failed to copy ${sourcePath}: ${detail}`);
    }
}

async function invalidateSidecarRuntime(): Promise<void> {
    try {
        const sidecarModule = await import('./neural-reranker');
        if (typeof sidecarModule.shutdownSidecarManager === 'function') {
            await sidecarModule.shutdownSidecarManager();
            return;
        }
        sidecarModule.destroySidecarManager();
    } catch (error: any) {
        logDebug(`Failed to invalidate sidecar runtime: ${error?.message || error}`);
    }
}

export function isAppleSilicon(): boolean {
    try {
        const os = Services?.appinfo?.OS;
        const abi = Services?.appinfo?.XPCOMABI;
        if (os !== 'Darwin' || typeof abi !== 'string') {
            return false;
        }

        return abi.split('-')[0] === 'aarch64';
    } catch {
        return false;
    }
}

export function isNeuralRerankSupported(): boolean {
    return isAppleSilicon();
}

export function getPluginDataRoot(): string {
    const dataDir = Zotero?.DataDirectory?.dir;
    if (!dataDir) {
        throw new Error('Zotero data directory not available');
    }

    return PathUtils.join(dataDir, PLUGIN_DATA_DIR);
}

export function getModelsDirectory(): string {
    return PathUtils.join(getPluginDataRoot(), MODEL_DIR_NAME);
}

export function getModelPackagePath(): string {
    return PathUtils.join(getModelsDirectory(), CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName);
}

export function getCompiledModelsDirectory(): string {
    return PathUtils.join(getModelsDirectory(), COMPILED_MODEL_DIR_NAME);
}

export function getCompiledModelPath(): string {
    return PathUtils.join(getCompiledModelsDirectory(), getCompiledModelDirectoryName(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName));
}

export function getModelVocabPath(): string {
    return PathUtils.join(getModelsDirectory(), MODEL_VOCAB_FILENAME);
}

export function getModelManifestPath(): string {
    return PathUtils.join(getModelsDirectory(), MODEL_MANIFEST_FILENAME);
}

export function getSidecarMetadataPath(): string {
    return PathUtils.join(getPluginDataRoot(), SIDECAR_JSON_FILENAME);
}

function buildInstallPaths(modelsDirectory: string): NeuralModelInstallPaths {
    const pluginDataRoot = getParentPath(modelsDirectory);
    const rawModelPackagePath = PathUtils.join(modelsDirectory, CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName);
    const compiledDirectory = PathUtils.join(modelsDirectory, COMPILED_MODEL_DIR_NAME);
    const compiledModelDirectoryName = getCompiledModelDirectoryName(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName);
    return {
        pluginDataRoot,
        modelsDirectory,
        rawModelPackagePath,
        modelPackagePath: rawModelPackagePath,
        compiledDirectory,
        compiledModelPath: PathUtils.join(compiledDirectory, compiledModelDirectoryName),
        vocabPath: PathUtils.join(modelsDirectory, MODEL_VOCAB_FILENAME),
        manifestPath: PathUtils.join(modelsDirectory, MODEL_MANIFEST_FILENAME),
        sidecarMetadataPath: PathUtils.join(pluginDataRoot, SIDECAR_JSON_FILENAME),
        tempRoot: PathUtils.join(pluginDataRoot, TEMP_DIR_NAME),
    };
}

export function getNeuralModelInstallPaths(): NeuralModelInstallPaths {
    return buildInstallPaths(getModelsDirectory());
}

export function readInstalledModelManifest(): InstalledNeuralModelManifest | null {
    return readInstalledModelManifestFromPath(getModelManifestPath());
}

export function readInstalledModelManifestFromPath(path: string): InstalledNeuralModelManifest | null {
    const rawContent = readUtf8FileSync(path);
    if (!rawContent) {
        return null;
    }

    const parsed = parseManifestFields(rawContent, true);
    return parsed && 'installedAt' in parsed ? parsed : null;
}

export function readBundledModelManifestFromPath(path: string): BundledNeuralModelManifest | null {
    const rawContent = readUtf8FileSync(path);
    if (!rawContent) {
        return null;
    }

    const parsed = parseManifestFields(rawContent, false);
    return parsed && !('installedAt' in parsed) ? parsed : null;
}

export function getInstalledModelAssetVersion(): string | null {
    return readInstalledModelManifest()?.assetVersion ?? null;
}

function buildLocalManifest(
    bundledManifest: BundledNeuralModelManifest,
    zipSha256: string,
    compileResult: SidecarCompileResult | null
): InstalledNeuralModelManifest {
    const localManifest: InstalledNeuralModelManifest = {
        modelId: bundledManifest.modelId,
        assetVersion: bundledManifest.assetVersion,
        releaseTag: bundledManifest.releaseTag,
        assetFileName: bundledManifest.assetFileName,
        packageDirectoryName: bundledManifest.packageDirectoryName,
        vocabFileName: bundledManifest.vocabFileName,
        pluginMinVersion: bundledManifest.pluginMinVersion,
        zipSha256,
        sourceUrl: CURRENT_NEURAL_MODEL_ASSET.downloadUrl,
        installedAt: new Date().toISOString(),
    };

    if (!compileResult) {
        return localManifest;
    }

    const currentPluginVersion = getCurrentPluginVersion();
    const compiledRelativePath = getCompiledRelativePath(bundledManifest.packageDirectoryName);
    return {
        ...localManifest,
        compiledAt: new Date().toISOString(),
        compiledRelativePath,
        compiledSourceZipSha256: zipSha256,
        compiledSourcePackageDirectoryName: bundledManifest.packageDirectoryName,
        compiledBySidecarVersion: compileResult.version,
        compiledByPluginVersion: currentPluginVersion ?? 'unknown',
        platform: getCurrentPlatformIdentifier(),
        verifiedLoad: compileResult.verifiedLoad,
    };
}

function buildStatusFromValidation(
    state: NeuralModelInstallState,
    paths: NeuralModelInstallPaths,
    validation: ValidationResult
): NeuralModelInstallStatus {
    return createInstallStatus(state, {
        paths,
        manifest: validation.manifest,
        isInstalledUsable: state === 'installed',
        rawAssetsPresent: validation.rawAssetsPresent,
        compiledAssetsPresent: validation.compiledAssetsPresent,
        missingEntries: [...validation.missingRawEntries, ...validation.missingCompiledEntries],
        missingRawEntries: validation.missingRawEntries,
        missingCompiledEntries: validation.missingCompiledEntries,
        detail: validation.detail,
    });
}

function validateRawInstall(paths: NeuralModelInstallPaths): ValidationResult | NeuralModelInstallStatus {
    const missingRawEntries: string[] = [];
    if (!isDirectoryPath(paths.modelsDirectory)) {
        return createInstallStatus('not-installed', {
            paths,
            detail: 'Model directory is not installed',
        });
    }

    if (!isDirectoryPath(paths.rawModelPackagePath)) {
        missingRawEntries.push(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName);
    }
    if (!isRegularFilePath(paths.vocabPath)) {
        missingRawEntries.push(MODEL_VOCAB_FILENAME);
    }
    if (!isRegularFilePath(paths.manifestPath)) {
        missingRawEntries.push(MODEL_MANIFEST_FILENAME);
    }
    if (missingRawEntries.length > 0) {
        return createInstallStatus('corrupt', {
            paths,
            rawAssetsPresent: false,
            compiledAssetsPresent: isDirectoryPath(paths.compiledModelPath),
            missingEntries: missingRawEntries,
            missingRawEntries,
            detail: `Installed model is missing required raw entries: ${missingRawEntries.join(', ')}`,
        });
    }

    const manifest = readInstalledModelManifestFromPath(paths.manifestPath);
    if (!manifest) {
        return createInstallStatus('corrupt', {
            paths,
            rawAssetsPresent: true,
            compiledAssetsPresent: isDirectoryPath(paths.compiledModelPath),
            detail: 'Installed model manifest is missing required fields or is invalid JSON',
        });
    }

    const compatibilityIssue = getBundledManifestCompatibilityIssue(manifest);
    if (compatibilityIssue) {
        return createInstallStatus('incompatible', {
            paths,
            manifest,
            rawAssetsPresent: true,
            compiledAssetsPresent: isDirectoryPath(paths.compiledModelPath),
            detail: compatibilityIssue,
        });
    }

    const configuredZipSha256 = getConfiguredModelZipSha256();
    const installedZipSha256 = normalizeSha256Hex(manifest.zipSha256);
    if (!configuredZipSha256 || installedZipSha256 !== configuredZipSha256) {
        return createInstallStatus('incompatible', {
            paths,
            manifest,
            rawAssetsPresent: true,
            compiledAssetsPresent: isDirectoryPath(paths.compiledModelPath),
            detail: 'Installed zipSha256 does not match the supported model asset',
        });
    }

    return {
        manifest,
        rawAssetsPresent: true,
        compiledAssetsPresent: isDirectoryPath(paths.compiledModelPath),
        missingRawEntries,
        missingCompiledEntries: [],
        detail: 'Installed raw neural model asset is complete and compatible',
    };
}

function validateCompiledInstall(paths: NeuralModelInstallPaths, manifest: InstalledNeuralModelManifest): NeuralModelInstallStatus | ValidationResult {
    const missingCompiledEntries: string[] = [];
    if (!isDirectoryPath(paths.compiledDirectory)) {
        missingCompiledEntries.push(COMPILED_MODEL_DIR_NAME);
    }

    const compiledBundleExists = pathExists(paths.compiledModelPath);
    if (!compiledBundleExists) {
        missingCompiledEntries.push(getCompiledRelativePath(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName));
    }
    if (compiledBundleExists && !isDirectoryPath(paths.compiledModelPath)) {
        missingCompiledEntries.push(`${getCompiledRelativePath(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName)} (not a directory)`);
    }

    const compiledBundleIsDirectory = isDirectoryPath(paths.compiledModelPath);
    const compiledBundleEntries = compiledBundleIsDirectory ? listDirectoryEntries(paths.compiledModelPath) : [];
    if (compiledBundleIsDirectory && !compiledBundleEntries.length) {
        missingCompiledEntries.push(`${getCompiledRelativePath(CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName)} (empty bundle)`);
    }

    const expectedCompiledRelativePath = getCompiledRelativePath(manifest.packageDirectoryName);
    const compileMetadataIssues: string[] = [];
    if (!manifest.compiledAt) {
        compileMetadataIssues.push('compiledAt missing');
    }
    if (manifest.compiledRelativePath !== expectedCompiledRelativePath) {
        compileMetadataIssues.push(`compiledRelativePath must be ${expectedCompiledRelativePath}`);
    }
    if (normalizeSha256Hex(manifest.compiledSourceZipSha256 ?? '') !== normalizeSha256Hex(manifest.zipSha256)) {
        compileMetadataIssues.push('compiledSourceZipSha256 does not match zipSha256');
    }
    if (manifest.compiledSourcePackageDirectoryName !== manifest.packageDirectoryName) {
        compileMetadataIssues.push('compiledSourcePackageDirectoryName does not match packageDirectoryName');
    }
    if (!manifest.compiledBySidecarVersion) {
        compileMetadataIssues.push('compiledBySidecarVersion missing');
    }
    if (!manifest.compiledByPluginVersion) {
        compileMetadataIssues.push('compiledByPluginVersion missing');
    }
    if (manifest.platform !== getCurrentPlatformIdentifier()) {
        compileMetadataIssues.push(`platform must be ${getCurrentPlatformIdentifier()}`);
    }
    if (manifest.verifiedLoad !== true) {
        compileMetadataIssues.push('verifiedLoad must be true');
    }

    if (missingCompiledEntries.length > 0 || compileMetadataIssues.length > 0) {
        return createInstallStatus('not-compiled', {
            paths,
            manifest,
            rawAssetsPresent: true,
            compiledAssetsPresent: compiledBundleIsDirectory && compiledBundleEntries.length > 0,
            missingEntries: [...missingCompiledEntries],
            missingCompiledEntries,
            detail: missingCompiledEntries.length > 0
                ? `Compiled model is missing required entries: ${missingCompiledEntries.join(', ')}`
                : `Compiled model metadata is incomplete or stale: ${compileMetadataIssues.join('; ')}`,
        });
    }

    return {
        manifest,
        rawAssetsPresent: true,
        compiledAssetsPresent: true,
        missingRawEntries: [],
        missingCompiledEntries,
        detail: 'Installed neural model asset is complete and compatible',
    };
}

function validateInstallAtPath(modelsDirectory: string): NeuralModelInstallStatus {
    const paths = buildInstallPaths(modelsDirectory);
    const rawValidation = validateRawInstall(paths);
    if ('state' in rawValidation) {
        return rawValidation;
    }

    const compiledValidation = validateCompiledInstall(paths, rawValidation.manifest!);
    if ('state' in compiledValidation) {
        return compiledValidation;
    }

    return buildStatusFromValidation('installed', paths, compiledValidation);
}

function validateExtractedRawInstall(modelsDirectory: string): BundledRawValidationResult {
    const paths = buildInstallPaths(modelsDirectory);

    if (!isDirectoryPath(paths.rawModelPackagePath)) {
        throw new Error(`Extracted model asset is missing ${CURRENT_NEURAL_MODEL_ASSET.packageDirectoryName}`);
    }
    if (!isRegularFilePath(paths.vocabPath)) {
        throw new Error('Extracted model asset is missing vocab.txt');
    }
    if (!isRegularFilePath(paths.manifestPath)) {
        throw new Error('Extracted model asset is missing manifest.json');
    }

    const bundledManifest = readBundledModelManifestFromPath(paths.manifestPath);
    if (!bundledManifest) {
        throw new Error('Extracted model asset manifest is invalid');
    }

    const compatibilityIssue = getBundledManifestCompatibilityIssue(bundledManifest);
    if (compatibilityIssue) {
        throw new Error(compatibilityIssue);
    }

    return {
        bundledManifest,
        paths,
    };
}

function parseSidecarCompileResult(stdout: string): SidecarCompileResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error(`Sidecar compile mode returned invalid JSON: ${stdout.trim() || '(empty stdout)'}`);
    }

    const payload = parsed as SidecarCompileJsonPayload;
    if (payload.status !== 'ok') {
        throw new Error(`Sidecar compile mode returned non-ok status: ${String(payload.status ?? 'unknown')}`);
    }
    if (payload.mode !== 'compile') {
        throw new Error(`Sidecar compile mode returned unexpected mode: ${String(payload.mode ?? 'unknown')}`);
    }
    if (typeof payload.version !== 'string' || !payload.version) {
        throw new Error('Sidecar compile mode did not report a version');
    }
    if (typeof payload.source_model_path !== 'string' || !payload.source_model_path) {
        throw new Error('Sidecar compile mode did not report source_model_path');
    }
    if (typeof payload.compiled_model_path !== 'string' || !payload.compiled_model_path) {
        throw new Error('Sidecar compile mode did not report compiled_model_path');
    }
    if (payload.verified_load !== true) {
        throw new Error('Sidecar compile mode did not verify compiled model load');
    }

    return {
        version: payload.version,
        compiledModelPath: payload.compiled_model_path,
        verifiedLoad: true,
    };
}

function parseSidecarValidateResult(stdout: string): SidecarCompileResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error(`Sidecar validate mode returned invalid JSON: ${stdout.trim() || '(empty stdout)'}`);
    }

    const payload = parsed as SidecarValidateJsonPayload;
    if (payload.status !== 'ok') {
        throw new Error(`Sidecar validate mode returned non-ok status: ${String(payload.status ?? 'unknown')}`);
    }
    if (payload.mode !== 'validate') {
        throw new Error(`Sidecar validate mode returned unexpected mode: ${String(payload.mode ?? 'unknown')}`);
    }
    if (typeof payload.version !== 'string' || !payload.version) {
        throw new Error('Sidecar validate mode did not report a version');
    }
    if (typeof payload.compiled_model_path !== 'string' || !payload.compiled_model_path) {
        throw new Error('Sidecar validate mode did not report compiled_model_path');
    }
    if (payload.verified_load !== true) {
        throw new Error('Sidecar validate mode did not verify compiled model load');
    }

    return {
        version: payload.version,
        compiledModelPath: payload.compiled_model_path,
        verifiedLoad: true,
    };
}

async function validateCompiledModelLoad(paths: NeuralModelInstallPaths): Promise<SidecarCompileResult> {
    const currentPluginRootURI = getCurrentPluginRootURI();
    const extractedSidecarPath = getSidecarBinPath();
    const sidecarBinaryPath = currentPluginRootURI
        ? (await ensureExtractedSidecarBinary(currentPluginRootURI)).binaryPath
        : extractedSidecarPath;

    if (!isRegularFilePath(sidecarBinaryPath)) {
        throw new Error('Shared sidecar binary is unavailable for compiled model validation');
    }

    const result = await runSubprocessWithOutput(sidecarBinaryPath, [
        '--validate-model',
        '--compiled-model-path', paths.compiledModelPath,
    ], {
        timeoutMs: MODEL_VALIDATE_TIMEOUT_MS,
        timeoutLabel: 'compiled model validation',
    });
    if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim() || `validate exited with code ${result.exitCode}`;
        throw new Error(`Compiled model validation failed: ${detail}`);
    }

    const validatedModel = parseSidecarValidateResult(result.stdout);
    if (validatedModel.compiledModelPath !== paths.compiledModelPath) {
        throw new Error(`Compiled model validation returned unexpected path ${validatedModel.compiledModelPath}`);
    }

    return validatedModel;
}

async function compileModelInStaging(rootURI: string, paths: NeuralModelInstallPaths): Promise<SidecarCompileResult> {
    logDebug(`Preparing shared sidecar binary for compile orchestration under ${paths.modelsDirectory}`);
    const extractedSidecar = await ensureExtractedSidecarBinary(rootURI);
    await IOUtils.makeDirectory(paths.compiledDirectory, { ignoreExisting: true });
    await removePathIfPresent(paths.compiledModelPath);

    logDebug(`Compiling raw model ${paths.rawModelPackagePath} -> ${paths.compiledModelPath}`);
    const result = await runSubprocessWithOutput(
        extractedSidecar.binaryPath,
        [
            '--compile-model',
            '--source-model-path', paths.rawModelPackagePath,
            '--compiled-model-path', paths.compiledModelPath,
        ],
        {
            timeoutMs: MODEL_COMPILE_TIMEOUT_MS,
            timeoutLabel: 'Core ML compile',
        }
    );

    if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim() || `sidecar compile exited with code ${result.exitCode}`;
        throw new Error(`Core ML compile failed: ${detail}`);
    }

    const compileResult = parseSidecarCompileResult(result.stdout);
    if (compileResult.compiledModelPath !== paths.compiledModelPath) {
        throw new Error(`Sidecar compile reported unexpected compiled path ${compileResult.compiledModelPath}`);
    }

    logDebug(`Core ML compile completed with sidecar version ${compileResult.version}`);
    return compileResult;
}

async function writeInstalledManifest(path: string, manifest: InstalledNeuralModelManifest): Promise<void> {
    await IOUtils.writeUTF8(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function replaceInstalledModelsDirectory(stagingModelsDirectory: string, targetModelsDirectory: string): Promise<void> {
    const backupModelsDirectory = `${targetModelsDirectory}.backup-${createUniqueSuffix()}`;
    const targetExists = pathExists(targetModelsDirectory);

    try {
        if (targetExists) {
            movePathAtomically(targetModelsDirectory, backupModelsDirectory);
        }

        movePathAtomically(stagingModelsDirectory, targetModelsDirectory);
        await removePathIfPresent(backupModelsDirectory);
    } catch (error) {
        if (!pathExists(targetModelsDirectory) && pathExists(backupModelsDirectory)) {
            try {
                movePathAtomically(backupModelsDirectory, targetModelsDirectory);
            } catch (rollbackError: any) {
                logDebug(`Failed to roll back model install swap: ${rollbackError?.message || rollbackError}`);
            }
        }

        throw error;
    }
}

async function finalizeStagedInstall(
    stagingModelsDirectory: string,
    targetModelsDirectory: string
): Promise<NeuralModelInstallStatus> {
    const stagedValidationStatus = validateInstallAtPath(stagingModelsDirectory);
    if (stagedValidationStatus.state !== 'installed') {
        throw new Error(stagedValidationStatus.detail ?? 'Staged model asset failed validation');
    }

    await validateCompiledModelLoad(stagedValidationStatus.paths);

    await invalidateSidecarRuntime();
    logDebug(`Starting installed model directory replace into ${targetModelsDirectory}`);
    await replaceInstalledModelsDirectory(stagingModelsDirectory, targetModelsDirectory);
    logDebug(`Completed installed model directory replace into ${targetModelsDirectory}`);

    return getInstalledModelStatus();
}

async function stageExistingRawInstall(livePaths: NeuralModelInstallPaths, stagingModelsDirectory: string): Promise<void> {
    await IOUtils.makeDirectory(stagingModelsDirectory, { ignoreExisting: true });
    await copyPathToDirectory(livePaths.rawModelPackagePath, stagingModelsDirectory);
    await copyPathToDirectory(livePaths.vocabPath, stagingModelsDirectory);
    await copyPathToDirectory(livePaths.manifestPath, stagingModelsDirectory);
}

export function getInstalledModelStatus(): NeuralModelInstallStatus {
    if (!isNeuralRerankSupported()) {
        return createInstallStatus('not-supported', {
            detail: 'Neural reranker is only supported on Apple Silicon macOS',
        });
    }

    if (!hasConfiguredDownloadMetadata()) {
        return createInstallStatus('unconfigured', {
            detail: getUnconfiguredModelDetail(),
        });
    }

    return validateInstallAtPath(getModelsDirectory());
}

export async function downloadAndInstallModel(
    rootURI: string,
    onStatusChange?: NeuralModelInstallStatusListener
): Promise<NeuralModelInstallStatus> {
    const paths = getNeuralModelInstallPaths();
    const workingDirectory = PathUtils.join(paths.tempRoot, `model-install-${createUniqueSuffix()}`);
    const downloadedZipPath = PathUtils.join(workingDirectory, CURRENT_NEURAL_MODEL_ASSET.assetFileName);
    const stagingModelsDirectory = PathUtils.join(workingDirectory, MODEL_DIR_NAME);

    if (!isNeuralRerankSupported()) {
        return emitStatus(onStatusChange, createInstallStatus('not-supported', {
            paths,
            detail: 'Neural reranker is only supported on Apple Silicon macOS',
        }));
    }
    if (!hasConfiguredDownloadMetadata()) {
        return emitStatus(onStatusChange, createInstallStatus('unconfigured', {
            paths,
            detail: getUnconfiguredModelDetail(),
        }));
    }

    try {
        assertConfiguredDownloadMetadata();
        await IOUtils.makeDirectory(paths.pluginDataRoot, { ignoreExisting: true });
        await IOUtils.makeDirectory(paths.tempRoot, { ignoreExisting: true });
        await IOUtils.makeDirectory(workingDirectory, { ignoreExisting: true });

        emitStatus(onStatusChange, createInstallStatus('downloading', {
            paths,
            detail: `Downloading ${CURRENT_NEURAL_MODEL_ASSET.modelId} asset ${CURRENT_NEURAL_MODEL_ASSET.assetVersion}`,
        }));

        logDebug(`Starting model zip download from ${CURRENT_NEURAL_MODEL_ASSET.downloadUrl}`);
        const response = await Zotero.HTTP.request('GET', CURRENT_NEURAL_MODEL_ASSET.downloadUrl, {
            responseType: 'arraybuffer',
            timeout: MODEL_DOWNLOAD_TIMEOUT_MS,
            successCodes: false,
        });
        const responseStatus = getResponseStatus(response);
        logDebug(`Model zip GET resolved with status ${responseStatus ?? 'unknown'}`);
        if (responseStatus !== 200) {
            throw new Error(`Failed to download model zip: HTTP ${responseStatus ?? 'unknown'}`);
        }

        logDebug(`Model zip response payload ${describeBinaryPayload(response?.response)}`);
        const zipBytes = extractBinaryPayload(response?.response, 'Failed to download model zip: HTTP 200');
        await IOUtils.write(downloadedZipPath, zipBytes);
        logDebug(`Wrote downloaded model zip to ${downloadedZipPath} (${zipBytes.byteLength} bytes)`);

        emitStatus(onStatusChange, createInstallStatus('verifying', {
            paths,
            detail: 'Verifying model zip SHA-256',
        }));

        const configuredZipSha256 = getConfiguredModelZipSha256();
        if (!configuredZipSha256) {
            throw new Error(getUnconfiguredModelDetail());
        }

        const actualSha256 = await computeSha256Hex(zipBytes);
        const normalizedActualSha256 = normalizeSha256Hex(actualSha256);
        if (!normalizedActualSha256 || normalizedActualSha256 !== configuredZipSha256) {
            throw new Error(`Model zip SHA-256 mismatch: expected ${CURRENT_NEURAL_MODEL_ASSET.zipSha256}, got ${actualSha256}`);
        }
        logDebug(`Completed model zip SHA-256 verification: ${actualSha256}`);

        await IOUtils.makeDirectory(stagingModelsDirectory, { ignoreExisting: true });
        emitStatus(onStatusChange, createInstallStatus('extracting', {
            paths,
            detail: 'Extracting model asset into staging directory',
        }));

        await unzipArchive(downloadedZipPath, stagingModelsDirectory);
        const rawValidation = validateExtractedRawInstall(stagingModelsDirectory);
        logDebug(`Raw asset validation succeeded for ${rawValidation.paths.rawModelPackagePath}`);

        emitStatus(onStatusChange, createInstallStatus('compiling', {
            paths,
            rawAssetsPresent: true,
            detail: 'Compiling Core ML model for local runtime',
        }));

        const compileResult = await compileModelInStaging(rootURI, rawValidation.paths);
        const localManifest = buildLocalManifest(rawValidation.bundledManifest, normalizedActualSha256, compileResult);
        await writeInstalledManifest(rawValidation.paths.manifestPath, localManifest);

        const installedStatus = await finalizeStagedInstall(stagingModelsDirectory, paths.modelsDirectory);
        logDebug(`Installed neural model asset ${CURRENT_NEURAL_MODEL_ASSET.assetVersion}`);
        return emitStatus(onStatusChange, installedStatus);
    } catch (error: any) {
        const errorMessage = error?.message || String(error);
        logDebug(`Model install failed: ${errorMessage}`);
        return emitStatus(onStatusChange, createInstallStatus('failed', {
            paths,
            detail: 'Model install failed',
            error: errorMessage,
        }));
    } finally {
        await removePathIfPresent(workingDirectory);
    }
}

export async function compileExistingModel(
    rootURI: string,
    onStatusChange?: NeuralModelInstallStatusListener
): Promise<NeuralModelInstallStatus> {
    return recompileExistingModel(rootURI, false, onStatusChange);
}

export async function forceRecompileModel(
    rootURI: string,
    onStatusChange?: NeuralModelInstallStatusListener
): Promise<NeuralModelInstallStatus> {
    return recompileExistingModel(rootURI, true, onStatusChange);
}

async function recompileExistingModel(
    rootURI: string,
    forceRecompile: boolean,
    onStatusChange?: NeuralModelInstallStatusListener
): Promise<NeuralModelInstallStatus> {
    const liveStatus = getInstalledModelStatus();
    const livePaths = getNeuralModelInstallPaths();
    const workingDirectory = PathUtils.join(livePaths.tempRoot, `model-recompile-${createUniqueSuffix()}`);
    const stagingModelsDirectory = PathUtils.join(workingDirectory, MODEL_DIR_NAME);

    if (liveStatus.state === 'installed' && !forceRecompile) {
        return emitStatus(onStatusChange, liveStatus);
    }
    const canCompileExisting = liveStatus.state === 'not-compiled'
        || liveStatus.state === 'installed'
        || (liveStatus.state === 'failed' && liveStatus.rawAssetsPresent);
    if (!canCompileExisting) {
        return emitStatus(onStatusChange, liveStatus);
    }
    if (!liveStatus.manifest) {
        return emitStatus(onStatusChange, createInstallStatus('failed', {
            paths: livePaths,
            detail: 'Model compile failed',
            error: 'Installed raw manifest is unavailable',
        }));
    }

    try {
        await IOUtils.makeDirectory(livePaths.tempRoot, { ignoreExisting: true });
        await IOUtils.makeDirectory(workingDirectory, { ignoreExisting: true });

        emitStatus(onStatusChange, createInstallStatus('compiling', {
            paths: livePaths,
            manifest: liveStatus.manifest,
            rawAssetsPresent: true,
            compiledAssetsPresent: liveStatus.compiledAssetsPresent,
            detail: forceRecompile ? 'Recompiling Core ML model for local runtime' : 'Compiling existing local model for runtime',
        }));

        await stageExistingRawInstall(livePaths, stagingModelsDirectory);
        const rawValidation = validateExtractedRawInstall(stagingModelsDirectory);
        const zipSha256 = normalizeSha256Hex(liveStatus.manifest.zipSha256);
        if (!zipSha256) {
            throw new Error('Installed manifest zipSha256 is invalid');
        }

        const compileResult = await compileModelInStaging(rootURI, rawValidation.paths);
        const localManifest = buildLocalManifest(rawValidation.bundledManifest, zipSha256, compileResult);
        await writeInstalledManifest(rawValidation.paths.manifestPath, localManifest);

        const installedStatus = await finalizeStagedInstall(stagingModelsDirectory, livePaths.modelsDirectory);
        logDebug(forceRecompile ? 'Forced neural model recompile completed' : 'Neural model compile completed');
        return emitStatus(onStatusChange, installedStatus);
    } catch (error: any) {
        const errorMessage = error?.message || String(error);
        logDebug(`Model compile failed: ${errorMessage}`);
        return emitStatus(onStatusChange, createInstallStatus('failed', {
            paths: livePaths,
            manifest: liveStatus.manifest,
            rawAssetsPresent: liveStatus.rawAssetsPresent,
            compiledAssetsPresent: liveStatus.compiledAssetsPresent,
            detail: forceRecompile ? 'Model recompile failed' : 'Model compile failed',
            error: errorMessage,
        }));
    } finally {
        await removePathIfPresent(workingDirectory);
    }
}

export async function deleteInstalledModel(): Promise<NeuralModelInstallStatus> {
    const paths = getNeuralModelInstallPaths();

    await invalidateSidecarRuntime();
    await removePathIfPresent(paths.modelsDirectory);
    logDebug('Deleted installed neural model asset');

    if (!isNeuralRerankSupported()) {
        return createInstallStatus('not-supported', {
            paths,
            detail: 'Neural reranker is only supported on Apple Silicon macOS',
        });
    }

    return createInstallStatus('not-installed', {
        paths,
        detail: 'Installed neural model asset removed',
    });
}
