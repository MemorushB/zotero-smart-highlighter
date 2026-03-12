declare const Zotero: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const IOUtils: any;
declare const Services: any;

const LOG_PREFIX = '[Smart Highlighter neural]';
const PLUGIN_DATA_DIR = 'zotero-pdf-highlighter';
const SIDECAR_BIN_DIR_NAME = 'bin';
const SIDECAR_BINARY_NAME = 'zph-reranker';
const SIDECAR_METADATA_NAME = `${SIDECAR_BINARY_NAME}.metadata.json`;
const SIDECAR_FETCH_TIMEOUT_MS = 10_000;

interface SidecarExtractionMetadata {
    bundledSha256?: unknown;
}

interface ResolvedAssetLocation {
    scheme: string;
    localPath: string | null;
}

interface BundledBinaryPayload {
    payload: Uint8Array;
    location: ResolvedAssetLocation;
    transport: 'file' | 'http';
    responseStatus: number | null;
}

export interface ExtractedSidecarBinary {
    binaryPath: string;
    metadataPath: string;
    bundledSha256: string;
}

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

function createUniqueSuffix(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getResponseStatus(response: { status?: unknown } | null | undefined): number | null {
    return typeof response?.status === 'number' ? response.status : null;
}

function getPayloadTag(value: unknown): string {
    return Object.prototype.toString.call(value);
}

function getPayloadConstructorName(value: unknown): string {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        return typeof value;
    }

    const constructorName = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof constructorName === 'string' && constructorName
        ? constructorName
        : 'unknown';
}

function isBinaryBufferPayload(value: unknown): value is ArrayBuffer | SharedArrayBuffer {
    const tag = getPayloadTag(value);
    return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

export function describeBinaryPayload(value: unknown): string {
    const constructorName = getPayloadConstructorName(value);
    const tag = getPayloadTag(value);
    const byteLength = ArrayBuffer.isView(value)
        ? value.byteLength
        : isBinaryBufferPayload(value)
            ? value.byteLength
            : null;

    return byteLength === null
        ? `${constructorName} ${tag}`
        : `${constructorName} ${tag} byteLength=${byteLength}`;
}

export function extractBinaryPayload(value: unknown, label: string): Uint8Array {
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (isBinaryBufferPayload(value)) {
        return new Uint8Array(value);
    }

    throw new Error(`${label}: unsupported binary response type ${describeBinaryPayload(value)}`);
}

async function computeSha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject?.subtle) {
        throw new Error('WebCrypto SHA-256 support is not available');
    }

    const binary = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const digestInput = new Uint8Array(binary.byteLength);
    digestInput.set(binary);
    const digest = await cryptoObject.subtle.digest('SHA-256', digestInput);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function resolveAssetLocation(uri: string): ResolvedAssetLocation {
    try {
        const parsedUri = Services?.io?.newURI?.(uri);
        const scheme = typeof parsedUri?.scheme === 'string' && parsedUri.scheme
            ? parsedUri.scheme
            : 'unknown';

        if (scheme !== 'file') {
            return { scheme, localPath: null };
        }

        const fileUrl = parsedUri?.QueryInterface?.(Components?.interfaces?.nsIFileURL);
        const localPath = typeof fileUrl?.file?.path === 'string' && fileUrl.file.path
            ? fileUrl.file.path
            : null;

        return { scheme, localPath };
    } catch {
        return {
            scheme: uri.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/)?.[1]?.toLowerCase() ?? 'unknown',
            localPath: null,
        };
    }
}

async function readBundledBinaryPayload(uri: string): Promise<BundledBinaryPayload> {
    const location = resolveAssetLocation(uri);

    if (location.scheme === 'file' && location.localPath) {
        logDebug(`Bundled sidecar local file path: ${location.localPath}`);

        if (!await IOUtils.exists(location.localPath)) {
            throw new Error(`Bundled sidecar file missing: ${location.localPath}`);
        }

        const payload = await IOUtils.read(location.localPath);
        logDebug(`Bundled sidecar payload ${describeBinaryPayload(payload)}`);

        const binaryPayload = extractBinaryPayload(payload, `Failed to read sidecar binary from ${location.localPath}`);
        if (!binaryPayload.byteLength) {
            throw new Error(`Bundled sidecar payload is empty: ${location.localPath}`);
        }

        return {
            payload: binaryPayload,
            location,
            transport: 'file',
            responseStatus: null,
        };
    }

    const response = await Zotero.HTTP.request('GET', uri, {
        responseType: 'arraybuffer',
        timeout: SIDECAR_FETCH_TIMEOUT_MS,
        successCodes: false,
    });
    const responseStatus = getResponseStatus(response);

    logDebug(`Bundled sidecar fetch transport=http scheme=${location.scheme} status=${responseStatus ?? 'unknown'}`);
    logDebug(`Bundled sidecar payload ${describeBinaryPayload(response?.response)}`);

    if (responseStatus !== 200 && !(location.scheme === 'file' && responseStatus === 0)) {
        throw new Error(`Failed to fetch sidecar binary: ${location.scheme} status ${responseStatus ?? 'unknown'}`);
    }

    const binaryPayload = extractBinaryPayload(
        response?.response,
        `Failed to fetch sidecar binary from ${uri}`
    );
    if (!binaryPayload.byteLength) {
        throw new Error(`Bundled sidecar payload is empty: ${uri}`);
    }

    return {
        payload: binaryPayload,
        location,
        transport: 'http',
        responseStatus,
    };
}

async function readSidecarExtractionMetadata(path: string): Promise<{ bundledSha256: string } | null> {
    try {
        if (!await IOUtils.exists(path)) {
            return null;
        }

        const rawContent = await IOUtils.readUTF8(path);
        const parsed = JSON.parse(rawContent) as SidecarExtractionMetadata;
        if (typeof parsed?.bundledSha256 !== 'string' || !parsed.bundledSha256) {
            return null;
        }

        return {
            bundledSha256: parsed.bundledSha256,
        };
    } catch {
        return null;
    }
}

async function writeSidecarExtractionMetadata(path: string, bundledSha256: string): Promise<void> {
    await IOUtils.writeUTF8(path, `${JSON.stringify({ bundledSha256 }, null, 2)}\n`);
}

async function replacePathAtomically(sourcePath: string, destinationPath: string): Promise<void> {
    const backupPath = `${destinationPath}.backup-${createUniqueSuffix()}`;
    const destinationExists = pathExists(destinationPath);

    try {
        if (destinationExists) {
            movePathAtomically(destinationPath, backupPath);
        }

        movePathAtomically(sourcePath, destinationPath);
        await IOUtils.remove(backupPath, {
            ignoreAbsent: true,
            recursive: true,
        });
    } catch (error) {
        if (!pathExists(destinationPath) && pathExists(backupPath)) {
            try {
                movePathAtomically(backupPath, destinationPath);
            } catch (rollbackError: any) {
                logDebug(`Failed to roll back sidecar binary swap: ${rollbackError?.message || rollbackError}`);
            }
        }

        throw error;
    }
}

async function makeExecutable(path: string): Promise<void> {
    const { Subprocess } = ChromeUtils.importESModule(
        'resource://gre/modules/Subprocess.sys.mjs'
    );
    const proc = await Subprocess.call({
        command: '/bin/chmod',
        arguments: ['+x', path],
        stderr: 'pipe',
    });
    const result = await proc.wait();
    const exitCode = Number((result as { exitCode?: unknown })?.exitCode ?? 0);
    if (exitCode !== 0) {
        throw new Error(`chmod +x failed for ${path} with exit code ${exitCode}`);
    }
}

export function getPluginDataRootForSidecar(): string {
    const dataDir = Zotero?.DataDirectory?.dir;
    if (!dataDir) {
        throw new Error('Zotero data directory not available');
    }

    return `${dataDir}/${PLUGIN_DATA_DIR}`;
}

export function getSidecarBinDir(): string {
    return `${getPluginDataRootForSidecar()}/${SIDECAR_BIN_DIR_NAME}`;
}

export function getSidecarBinPath(): string {
    return `${getSidecarBinDir()}/${SIDECAR_BINARY_NAME}`;
}

export function getExtractedSidecarMetadataPath(): string {
    return `${getSidecarBinDir()}/${SIDECAR_METADATA_NAME}`;
}

export function getBundledSidecarPath(rootURI: string): string {
    return `${rootURI}bin/darwin-arm64/${SIDECAR_BINARY_NAME}`;
}

export async function ensureExtractedSidecarBinary(rootURI: string): Promise<ExtractedSidecarBinary> {
    const binPath = getSidecarBinPath();
    const binDir = getSidecarBinDir();
    const metadataPath = getExtractedSidecarMetadataPath();
    await IOUtils.makeDirectory(binDir, { ignoreExisting: true });

    const bundledSidecarPath = getBundledSidecarPath(rootURI);
    logDebug(`Sidecar root URI: ${rootURI}`);
    logDebug(`Bundled sidecar URI: ${bundledSidecarPath}`);

    const bundledPayload = await readBundledBinaryPayload(bundledSidecarPath);
    logDebug(`Bundled sidecar scheme=${bundledPayload.location.scheme} transport=${bundledPayload.transport} status=${bundledPayload.responseStatus ?? 'n/a'}`);

    const bundledBinary = bundledPayload.payload;
    const bundledSha256 = await computeSha256Hex(bundledBinary);
    const extractedBinaryExists = await IOUtils.exists(binPath);
    const extractedMetadata = await readSidecarExtractionMetadata(metadataPath);

    if (extractedBinaryExists && extractedMetadata?.bundledSha256 === bundledSha256) {
        logDebug(`Sidecar hash comparison: extracted metadata matches bundled sha256 ${bundledSha256}`);
        await makeExecutable(binPath);
        return {
            binaryPath: binPath,
            metadataPath,
            bundledSha256,
        };
    }

    if (extractedBinaryExists) {
        try {
            const extractedBinary = await IOUtils.read(binPath);
            const extractedSha256 = await computeSha256Hex(extractedBinary);
            logDebug(`Sidecar hash comparison: extracted=${extractedSha256} bundled=${bundledSha256}`);
            if (extractedSha256 === bundledSha256) {
                await makeExecutable(binPath);
                await writeSidecarExtractionMetadata(metadataPath, bundledSha256);
                logDebug('Sidecar binary already matches bundled copy; refreshed extraction metadata');
                return {
                    binaryPath: binPath,
                    metadataPath,
                    bundledSha256,
                };
            }

            logDebug('Refreshing sidecar binary because extracted hash differs from bundled copy');
        } catch {
            logDebug('Refreshing sidecar binary because extracted hash could not be read');
        }
    } else {
        logDebug('Extracting sidecar binary because no extracted copy exists');
    }

    const tempPath = `${binPath}.tmp-${createUniqueSuffix()}`;
    try {
        await IOUtils.write(tempPath, bundledBinary);
        await replacePathAtomically(tempPath, binPath);
        await makeExecutable(binPath);
        await writeSidecarExtractionMetadata(metadataPath, bundledSha256);
        logDebug(`Sidecar binary write complete: ${binPath}`);
    } finally {
        await IOUtils.remove(tempPath, {
            ignoreAbsent: true,
            recursive: true,
        });
    }

    return {
        binaryPath: binPath,
        metadataPath,
        bundledSha256,
    };
}
