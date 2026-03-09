/**
 * Neural reranker sidecar manager for Apple Silicon Macs.
 *
 * Manages the lifecycle of a Swift sidecar process that runs a Core ML
 * cross-encoder model for highlight candidate reranking.
 *
 * Phase 3b: Plugin-side sidecar manager.
 */

declare const Zotero: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;

// -- Types ------------------------------------------------------------------

export type NeuralRerankerStatus =
    | 'not-supported'
    | 'model-not-downloaded'
    | 'ready'
    | 'disabled';

interface SidecarInfo {
    port: number;
    token: string;
}

interface SidecarJsonPayload {
    port?: unknown;
    token?: unknown;
}

interface HttpJsonResponse {
    status?: unknown;
    response?: unknown;
    responseText?: unknown;
}

// -- Constants --------------------------------------------------------------

const LOG_PREFIX = '[Smart Highlighter neural]';
const NEURAL_RERANKER_PREF_KEY = 'extensions.zotero-pdf-highlighter.neuralReranker';
const SIDECAR_BINARY_NAME = 'zph-reranker';
const SIDECAR_START_TIMEOUT_MS = 10_000;
const SIDECAR_REQUEST_TIMEOUT_MS = 8_000;
const SIDECAR_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const SIDECAR_HEALTH_POLL_INTERVAL_MS = 500;
const SIDECAR_MAX_RESTART_ATTEMPTS = 2;
const SIDECAR_DEFAULT_PORT = 23516;
const SIDECAR_PORT_RANGE = 5;
const SIDECAR_SHUTDOWN_TIMEOUT_MS = 3_000;
const SIDECAR_SHUTDOWN_GRACE_MS = 1_000;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;

const MODEL_DIR_NAME = 'models';
const MODEL_FILENAME = 'ms-marco-MiniLM-L6-v2.mlpackage';
const SIDECAR_JSON_FILENAME = 'sidecar.json';
const PLUGIN_DATA_DIR = 'zotero-pdf-highlighter';

// -- Platform Detection -----------------------------------------------------

export function isAppleSilicon(): boolean {
    try {
        const os = Services?.appinfo?.OS;
        const abi = Services?.appinfo?.XPCOMABI;
        if (os !== 'Darwin' || typeof abi !== 'string') {
            return false;
        }

        const arch = abi.split('-')[0];
        return arch === 'aarch64';
    } catch {
        return false;
    }
}

// -- Path Helpers -----------------------------------------------------------

function getPluginDataDir(): string {
    const dataDir = Zotero?.DataDirectory?.dir;
    if (!dataDir) {
        throw new Error('Zotero data directory not available');
    }

    return PathUtils.join(dataDir, PLUGIN_DATA_DIR);
}

function getModelDirectory(): string {
    return PathUtils.join(getPluginDataDir(), MODEL_DIR_NAME);
}

function getModelPath(): string {
    return PathUtils.join(getModelDirectory(), MODEL_FILENAME);
}

function getSidecarBinDir(): string {
    return PathUtils.join(getPluginDataDir(), 'bin');
}

function getSidecarBinPath(): string {
    return PathUtils.join(getSidecarBinDir(), SIDECAR_BINARY_NAME);
}

function getSidecarJsonPath(): string {
    return PathUtils.join(getPluginDataDir(), SIDECAR_JSON_FILENAME);
}

function getBundledSidecarPath(rootURI: string): string {
    return `${rootURI}bin/darwin-arm64/${SIDECAR_BINARY_NAME}`;
}

// -- Preference and Model Status -------------------------------------------

function getNeuralRerankerPreference(): string | null {
    try {
        const value = Zotero?.Prefs?.get?.(NEURAL_RERANKER_PREF_KEY, true);
        return typeof value === 'string' ? value : (value == null ? null : String(value));
    } catch {
        return null;
    }
}

export function isModelDownloaded(): boolean {
    try {
        const modelPath = getModelPath();
        const file = Components?.classes?.['@mozilla.org/file/local;1']
            ?.createInstance?.(Components?.interfaces?.nsIFile);
        if (!file) {
            return false;
        }

        file.initWithPath(modelPath);
        return file.exists();
    } catch {
        return false;
    }
}

export function getNeuralRerankerStatus(): NeuralRerankerStatus {
    if (!isAppleSilicon()) {
        return 'not-supported';
    }

    if (getNeuralRerankerPreference() === 'disabled') {
        return 'disabled';
    }

    try {
        return isModelDownloaded() ? 'ready' : 'model-not-downloaded';
    } catch {
        return 'model-not-downloaded';
    }
}

export function isNeuralRerankSupported(): boolean {
    return isAppleSilicon();
}

// -- Auth Token -------------------------------------------------------------

function generateAuthToken(): string {
    const cryptoObject = globalThis.crypto;
    if (!cryptoObject?.getRandomValues) {
        throw new Error('Secure random generator not available');
    }

    const bytes = new Uint8Array(32);
    cryptoObject.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// -- Parsing Helpers --------------------------------------------------------

function parseSidecarInfo(payload: SidecarJsonPayload, expectedToken: string): SidecarInfo | null {
    const port = payload?.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
        return null;
    }

    const token = payload?.token;
    if (typeof token !== 'string' || !token) {
        return null;
    }

    if (token !== expectedToken) {
        return null;
    }

    return {
        port,
        token,
    };
}

function getResponseStatus(response: HttpJsonResponse | null | undefined): number | null {
    return typeof response?.status === 'number' ? response.status : null;
}

function parseJsonResponse<T>(response: HttpJsonResponse | null | undefined): T | null {
    const rawResponse = response?.response;
    if (rawResponse && typeof rawResponse === 'object') {
        return rawResponse as T;
    }

    if (typeof rawResponse === 'string' && rawResponse.trim()) {
        return JSON.parse(rawResponse) as T;
    }

    if (typeof response?.responseText === 'string' && response.responseText.trim()) {
        return JSON.parse(response.responseText) as T;
    }

    return null;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logDebug(message: string): void {
    Zotero.debug(`${LOG_PREFIX} ${message}`);
}

// -- Sidecar Manager --------------------------------------------------------

export class SidecarManager {
    private proc: any = null;
    private sidecarInfo: SidecarInfo | null = null;
    private authToken = '';
    private restartCount = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private starting = false;
    private stopping = false;
    private readonly rootURI: string;

    constructor(rootURI: string) {
        this.rootURI = rootURI;
    }

    async ensureRunning(): Promise<void> {
        this.resetIdleTimer();

        if (this.sidecarInfo && await this.isHealthy()) {
            return;
        }

        if (this.starting) {
            await this.waitForStart();
            if (this.sidecarInfo && await this.isHealthy()) {
                return;
            }

            throw new Error('Sidecar failed to start (timeout)');
        }

        await this.start();
    }

    async start(): Promise<void> {
        if (this.starting) {
            return;
        }

        this.starting = true;
        this.stopping = false;

        try {
            await this.extractBinaryIfNeeded();

            this.authToken = generateAuthToken();
            this.sidecarInfo = null;

            const modelPath = getModelPath();
            const binPath = getSidecarBinPath();
            logDebug(`Starting sidecar: ${binPath}`);
            logDebug(`Model path: ${modelPath}`);

            const { Subprocess } = ChromeUtils.importESModule(
                'resource://gre/modules/Subprocess.sys.mjs'
            );

            this.proc = await Subprocess.call({
                command: binPath,
                arguments: [
                    '--model-path', modelPath,
                    '--auth-token', this.authToken,
                    '--port', String(SIDECAR_DEFAULT_PORT),
                    '--port-range', String(SIDECAR_PORT_RANGE),
                ],
                stderr: 'stdout',
            });

            await this.waitForHealthySidecar();
            this.restartCount = 0;
            logDebug('Sidecar ready');

            void this.monitorProcess();
        } catch (error: any) {
            await this.killProcess();
            this.proc = null;
            this.sidecarInfo = null;
            throw error;
        } finally {
            this.starting = false;
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.clearIdleTimer();

        const activeSidecarInfo = this.sidecarInfo;
        if (activeSidecarInfo) {
            try {
                await Zotero.HTTP.request('POST', `http://127.0.0.1:${activeSidecarInfo.port}/shutdown`, {
                    headers: {
                        Authorization: `Bearer ${activeSidecarInfo.token}`,
                    },
                    timeout: SIDECAR_SHUTDOWN_TIMEOUT_MS,
                    successCodes: false,
                });
            } catch {
                // Force kill below if graceful shutdown fails.
            }

            await delay(SIDECAR_SHUTDOWN_GRACE_MS);
        }

        await this.killProcess();
        this.proc = null;
        this.sidecarInfo = null;
        logDebug('Sidecar stopped');
    }

    async rerankCandidates(query: string, candidates: string[]): Promise<number[] | null> {
        if (!candidates.length) {
            return [];
        }

        try {
            await this.ensureRunning();
            if (!this.sidecarInfo) {
                logDebug('Sidecar not available for reranking');
                return null;
            }

            const response = await Zotero.HTTP.request('POST', `http://127.0.0.1:${this.sidecarInfo.port}/rerank`, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.sidecarInfo.token}`,
                },
                body: JSON.stringify({ query, candidates }),
                timeout: SIDECAR_REQUEST_TIMEOUT_MS,
                responseType: 'json',
                successCodes: false,
            });

            if (getResponseStatus(response) !== 200) {
                logDebug(`Rerank request failed: HTTP ${getResponseStatus(response) ?? 'unknown'}`);
                return null;
            }

            const parsedResponse = parseJsonResponse<{ scores?: unknown }>(response);
            if (!Array.isArray(parsedResponse?.scores) || !parsedResponse.scores.every(score => typeof score === 'number')) {
                logDebug('Invalid rerank response format');
                return null;
            }

            logDebug(`Reranked ${candidates.length} candidates`);
            return parsedResponse.scores;
        } catch (error: any) {
            logDebug(`Rerank failed: ${error?.message || error}`);
            return null;
        }
    }

    private async waitForStart(): Promise<void> {
        const deadline = Date.now() + SIDECAR_START_TIMEOUT_MS;
        while (this.starting && Date.now() < deadline) {
            await delay(SIDECAR_HEALTH_POLL_INTERVAL_MS);
        }
    }

    private async waitForHealthySidecar(): Promise<void> {
        const deadline = Date.now() + SIDECAR_START_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await delay(SIDECAR_HEALTH_POLL_INTERVAL_MS);
            await this.refreshSidecarInfoFromDisk();

            if (this.sidecarInfo && await this.isHealthy()) {
                return;
            }
        }

        throw new Error('Sidecar did not become healthy within timeout');
    }

    private async refreshSidecarInfoFromDisk(): Promise<void> {
        const jsonPath = getSidecarJsonPath();

        try {
            if (!await IOUtils.exists(jsonPath)) {
                return;
            }

            const rawContent = await IOUtils.readUTF8(jsonPath);
            const parsedPayload = JSON.parse(rawContent) as SidecarJsonPayload;
            const parsedSidecarInfo = parseSidecarInfo(parsedPayload, this.authToken);
            if (!parsedSidecarInfo) {
                return;
            }

            this.sidecarInfo = parsedSidecarInfo;
        } catch {
            // Keep polling until timeout.
        }
    }

    private async monitorProcess(): Promise<void> {
        if (!this.proc) {
            return;
        }

        try {
            await this.proc.wait();
        } catch {
            return;
        }

        const wasStopping = this.stopping;
        this.proc = null;
        this.sidecarInfo = null;

        if (wasStopping) {
            return;
        }

        logDebug('Sidecar process exited unexpectedly');
        if (this.restartCount >= SIDECAR_MAX_RESTART_ATTEMPTS) {
            return;
        }

        this.restartCount += 1;
        logDebug(`Restarting sidecar (attempt ${this.restartCount}/${SIDECAR_MAX_RESTART_ATTEMPTS})`);

        try {
            await this.start();
        } catch (error: any) {
            logDebug(`Sidecar restart failed: ${error?.message || error}`);
        }
    }

    private async isHealthy(): Promise<boolean> {
        const activeSidecarInfo = this.sidecarInfo;
        if (!activeSidecarInfo) {
            return false;
        }

        try {
            const response = await Zotero.HTTP.request('GET', `http://127.0.0.1:${activeSidecarInfo.port}/health`, {
                timeout: HEALTH_CHECK_TIMEOUT_MS,
                responseType: 'json',
                successCodes: false,
            });
            return getResponseStatus(response) === 200;
        } catch {
            return false;
        }
    }

    private async killProcess(): Promise<void> {
        if (!this.proc) {
            return;
        }

        try {
            this.proc.kill();
        } catch {
            // Process already exited.
        }
    }

    private async extractBinaryIfNeeded(): Promise<void> {
        const binPath = getSidecarBinPath();

        try {
            if (await IOUtils.exists(binPath)) {
                return;
            }
        } catch {
            // Continue and try to extract.
        }

        const binDir = getSidecarBinDir();
        await IOUtils.makeDirectory(binDir, { ignoreExisting: true });

        const bundledSidecarPath = getBundledSidecarPath(this.rootURI);
        logDebug(`Extracting sidecar binary from ${bundledSidecarPath}`);

        const response = await Zotero.HTTP.request('GET', bundledSidecarPath, {
            responseType: 'arraybuffer',
            timeout: SIDECAR_START_TIMEOUT_MS,
            successCodes: false,
        });
        if (getResponseStatus(response) !== 200 || !(response?.response instanceof ArrayBuffer)) {
            throw new Error(`Failed to fetch sidecar binary: HTTP ${getResponseStatus(response) ?? 'unknown'}`);
        }

        await IOUtils.write(binPath, new Uint8Array(response.response));

        const { Subprocess } = ChromeUtils.importESModule(
            'resource://gre/modules/Subprocess.sys.mjs'
        );
        await Subprocess.call({
            command: '/bin/chmod',
            arguments: ['+x', binPath],
        });

        logDebug('Sidecar binary extracted and made executable');
    }

    private resetIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            logDebug('Idle timeout, stopping sidecar');
            void this.stop();
        }, SIDECAR_IDLE_SHUTDOWN_MS);
    }

    private clearIdleTimer(): void {
        if (!this.idleTimer) {
            return;
        }

        clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }
}

// -- Neural Score Normalization --------------------------------------------

/**
 * Normalize raw cross-encoder logits to [0, 1] range.
 *
 * 1. Apply sigmoid to convert logits to probabilities
 * 2. Per-batch min-max normalization for consistent blending
 */
export function normalizeNeuralScores(rawLogits: number[]): number[] {
    if (!rawLogits.length) {
        return [];
    }

    const sigmoided = rawLogits.map(value => 1 / (1 + Math.exp(-value)));
    const minScore = Math.min(...sigmoided);
    const maxScore = Math.max(...sigmoided);
    const scoreRange = maxScore - minScore;

    if (scoreRange < 1e-8) {
        return sigmoided.map(() => 0.5);
    }

    return sigmoided.map(score => (score - minScore) / scoreRange);
}

// -- Singleton --------------------------------------------------------------

let sidecarManagerInstance: SidecarManager | null = null;

export function getSidecarManager(rootURI?: string): SidecarManager {
    if (!sidecarManagerInstance && rootURI) {
        sidecarManagerInstance = new SidecarManager(rootURI);
    }

    if (!sidecarManagerInstance) {
        throw new Error('SidecarManager not initialized');
    }

    return sidecarManagerInstance;
}

export function destroySidecarManager(): void {
    if (!sidecarManagerInstance) {
        return;
    }

    void sidecarManagerInstance.stop();
    sidecarManagerInstance = null;
}
