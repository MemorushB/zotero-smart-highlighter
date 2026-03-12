/**
 * Neural reranker sidecar manager for Apple Silicon Macs.
 *
 * Manages the lifecycle of a Swift sidecar process that runs a Core ML
 * cross-encoder model for highlight candidate reranking.
 *
 * Phase 3b: Plugin-side sidecar manager.
 */

declare const Zotero: any;
declare const ChromeUtils: any;
declare const IOUtils: any;

import {
    getCompiledModelPath,
    getInstalledModelStatus,
    getModelVocabPath,
    getPluginDataRoot,
    getSidecarMetadataPath,
    isAppleSilicon,
} from "./neural-model-installer";
import { ensureExtractedSidecarBinary } from "./sidecar-binary";
import { getCanonicalPref } from "./preferences";

// -- Types ------------------------------------------------------------------

export type NeuralRerankerStatus =
    | 'not-supported'
    | 'model-unconfigured'
    | 'model-not-downloaded'
    | 'model-not-compiled'
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

interface SidecarHealthResponse {
    status?: unknown;
    model_loaded?: unknown;
    version?: unknown;
    startup_stage?: unknown;
    startup_error?: unknown;
}

interface SidecarHealthSnapshot {
    reachable: boolean;
    httpStatus: number | null;
    status: string | null;
    modelLoaded: boolean;
    version: string | null;
    startupStage: string | null;
    startupError: string | null;
}

// -- Constants --------------------------------------------------------------

const LOG_PREFIX = '[Smart Highlighter neural]';
const NEURAL_RERANKER_PREF_KEY = 'extensions.zotero-pdf-highlighter.neuralReranker';
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

// -- Preference and Model Status -------------------------------------------

function getNeuralRerankerPreference(): boolean {
    try {
        return getCanonicalPref('neuralReranker');
    } catch {
        const value = Zotero?.Prefs?.get?.(NEURAL_RERANKER_PREF_KEY, true);
        if (typeof value === 'boolean') {
            return value;
        }

        if (typeof value === 'string') {
            const normalizedValue = value.trim().toLowerCase();
            if (normalizedValue === 'true') {
                return true;
            }

            if (normalizedValue === 'false') {
                return false;
            }
        }

        return true;
    }
}

export function isModelDownloaded(): boolean {
    return getInstalledModelStatus().state === 'installed';
}

export function getNeuralRerankerStatus(): NeuralRerankerStatus {
    const installStatus = getInstalledModelStatus();

    if (!isAppleSilicon()) {
        return 'not-supported';
    }

    if (!getNeuralRerankerPreference()) {
        return 'disabled';
    }

    if (installStatus.state === 'unconfigured') {
        return 'model-unconfigured';
    }

    if (installStatus.state === 'not-compiled') {
        return 'model-not-compiled';
    }

    return installStatus.state === 'installed' ? 'ready' : 'model-not-downloaded';
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

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmedValue = value.trim();
    return trimmedValue ? trimmedValue : null;
}

function createUnreachableHealthSnapshot(): SidecarHealthSnapshot {
    return {
        reachable: false,
        httpStatus: null,
        status: null,
        modelLoaded: false,
        version: null,
        startupStage: null,
        startupError: null,
    };
}

function parseHealthSnapshot(response: HttpJsonResponse | null | undefined): SidecarHealthSnapshot {
    const httpStatus = getResponseStatus(response);
    const parsedResponse = parseJsonResponse<SidecarHealthResponse>(response);

    return {
        reachable: true,
        httpStatus,
        status: normalizeOptionalString(parsedResponse?.status),
        modelLoaded: parsedResponse?.model_loaded === true,
        version: normalizeOptionalString(parsedResponse?.version),
        startupStage: normalizeOptionalString(parsedResponse?.startup_stage),
        startupError: normalizeOptionalString(parsedResponse?.startup_error),
    };
}

function getHealthSnapshotSignature(snapshot: SidecarHealthSnapshot): string {
    return [
        snapshot.reachable ? 'reachable' : 'unreachable',
        snapshot.httpStatus ?? 'null',
        snapshot.modelLoaded ? 'loaded' : 'not-loaded',
        snapshot.startupStage ?? 'null',
        snapshot.startupError ?? 'null',
    ].join('|');
}

function describeHealthSnapshot(snapshot: SidecarHealthSnapshot): string {
    const details = [
        `reachable=${snapshot.reachable ? 'yes' : 'no'}`,
        `http=${snapshot.httpStatus ?? 'unknown'}`,
        `modelLoaded=${snapshot.modelLoaded ? 'true' : 'false'}`,
    ];

    if (snapshot.startupStage) {
        details.push(`stage=${snapshot.startupStage}`);
    }

    if (snapshot.startupError) {
        details.push(`error=${snapshot.startupError}`);
    }

    return details.join(', ');
}

function isDefinitiveStartupFailure(snapshot: SidecarHealthSnapshot): boolean {
    return snapshot.startupStage === 'load_model_failed' || snapshot.startupError !== null;
}

function getStartupFailureMessage(snapshot: SidecarHealthSnapshot): string {
    const stage = snapshot.startupStage ?? 'unknown';
    const error = snapshot.startupError ?? 'unknown startup failure';
    return `stage=${stage}, error=${error}`;
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
    private lastHealthSnapshotSignature: string | null = null;
    private lastStartupFailureMessage: string | null = null;

    constructor(rootURI: string) {
        this.rootURI = rootURI;
    }

    async ensureRunning(): Promise<void> {
        this.resetIdleTimer();

        if (this.sidecarInfo) {
            const healthSnapshot = await this.readHealthSnapshot();
            this.logHealthSnapshotIfChanged(healthSnapshot);
            if (healthSnapshot.modelLoaded) {
                return;
            }

            logDebug(`Restarting unhealthy sidecar before reuse: ${describeHealthSnapshot(healthSnapshot)}`);
            if (isDefinitiveStartupFailure(healthSnapshot)) {
                this.lastStartupFailureMessage = `Sidecar startup failed: ${getStartupFailureMessage(healthSnapshot)}`;
            }

            await this.stop();
        }

        if (this.starting) {
            await this.waitForStart();
            if (this.sidecarInfo) {
                const healthSnapshot = await this.readHealthSnapshot();
                this.logHealthSnapshotIfChanged(healthSnapshot);
                if (healthSnapshot.modelLoaded) {
                    return;
                }
            }

            throw new Error(this.lastStartupFailureMessage ?? 'Sidecar failed to start (timeout)');
        }

        await this.start();
    }

    async start(): Promise<void> {
        if (this.starting) {
            return;
        }

        const installStatus = getInstalledModelStatus();
        if (installStatus.state !== 'installed') {
            throw new Error(installStatus.detail ?? 'Neural reranker model install is incomplete');
        }

        this.starting = true;
        this.stopping = false;
        this.lastStartupFailureMessage = null;
        logDebug(`Sidecar startup install status: state=${installStatus.state}, usable=${installStatus.isInstalledUsable}`);
        logDebug('Model install validation succeeded');

        try {
            const extractedSidecar = await ensureExtractedSidecarBinary(this.rootURI);

            this.authToken = generateAuthToken();
            this.sidecarInfo = null;

            const modelPath = getCompiledModelPath();
            const vocabPath = getModelVocabPath();
            const pluginDataRoot = getPluginDataRoot();
            const binPath = extractedSidecar.binaryPath;
            logDebug(`Starting sidecar: ${binPath}`);
            logDebug(`Model path: ${modelPath}`);
            logDebug(`Vocab path: ${vocabPath}`);
            logDebug(`Plugin data root: ${pluginDataRoot}`);

            const { Subprocess } = ChromeUtils.importESModule(
                'resource://gre/modules/Subprocess.sys.mjs'
            );

            this.proc = await Subprocess.call({
                command: binPath,
                arguments: [
                    '--model-path', modelPath,
                    '--vocab-path', vocabPath,
                    '--plugin-data-root', pluginDataRoot,
                    '--auth-token', this.authToken,
                    '--port', String(SIDECAR_DEFAULT_PORT),
                    '--port-range', String(SIDECAR_PORT_RANGE),
                ],
                stderr: 'stdout',
            });

            this.lastHealthSnapshotSignature = null;
            logDebug('Sidecar process launched; waiting for health snapshot');
            await this.waitForHealthySidecar();
            this.restartCount = 0;
            this.lastStartupFailureMessage = null;
            logDebug('Sidecar ready');

            void this.monitorProcess();
        } catch (error: any) {
            this.lastStartupFailureMessage = error?.message || String(error);
            logDebug(`Sidecar startup failed after install validation: ${this.lastStartupFailureMessage}`);
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
        await this.removeSidecarMetadata();
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

            if (parsedResponse.scores.length !== candidates.length) {
                logDebug(`Invalid rerank response format: expected ${candidates.length} scores but received ${parsedResponse.scores.length}`);
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

            if (!this.sidecarInfo) {
                continue;
            }

            const healthSnapshot = await this.readHealthSnapshot();
            this.logHealthSnapshotIfChanged(healthSnapshot);

            if (healthSnapshot.modelLoaded) {
                return;
            }

            if (!isDefinitiveStartupFailure(healthSnapshot)) {
                continue;
            }

            const failureMessage = getStartupFailureMessage(healthSnapshot);
            logDebug(`Sidecar startup failed definitively: ${failureMessage}`);
            await this.killProcess();
            this.proc = null;
            this.sidecarInfo = null;
            throw new Error(`Sidecar startup failed: ${failureMessage}`);
        }

        throw new Error('Sidecar did not become healthy within timeout');
    }

    private async refreshSidecarInfoFromDisk(): Promise<void> {
        const jsonPath = getSidecarMetadataPath();

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

    private async readHealthSnapshot(): Promise<SidecarHealthSnapshot> {
        const activeSidecarInfo = this.sidecarInfo;
        if (!activeSidecarInfo) {
            return createUnreachableHealthSnapshot();
        }

        try {
            const response = await Zotero.HTTP.request('GET', `http://127.0.0.1:${activeSidecarInfo.port}/health`, {
                timeout: HEALTH_CHECK_TIMEOUT_MS,
                responseType: 'json',
                successCodes: false,
            });
            return parseHealthSnapshot(response);
        } catch {
            return createUnreachableHealthSnapshot();
        }
    }

    private logHealthSnapshotIfChanged(snapshot: SidecarHealthSnapshot): void {
        const signature = getHealthSnapshotSignature(snapshot);
        if (signature === this.lastHealthSnapshotSignature) {
            return;
        }

        this.lastHealthSnapshotSignature = signature;

        if (!snapshot.reachable) {
            logDebug('Sidecar health snapshot unavailable');
            return;
        }

        if (snapshot.httpStatus !== 200) {
            logDebug(`Sidecar health request returned HTTP ${snapshot.httpStatus ?? 'unknown'}`);
            return;
        }

        if (snapshot.modelLoaded) {
            logDebug(`Sidecar health snapshot: ${describeHealthSnapshot(snapshot)}`);
            return;
        }

        if (isDefinitiveStartupFailure(snapshot)) {
            logDebug(`Sidecar health snapshot indicates startup failure: ${describeHealthSnapshot(snapshot)}`);
            return;
        }

        logDebug(`Sidecar health snapshot seen with model_loaded=false: ${describeHealthSnapshot(snapshot)}`);
    }

    private async killProcess(): Promise<void> {
        const activeProcess = this.proc;
        if (!activeProcess) {
            return;
        }

        try {
            activeProcess.kill();
        } catch {
            // Process already exited.
        }

        try {
            await activeProcess.wait();
        } catch {
            // Process exit observation failed after shutdown/kill.
        }
    }

    private async removeSidecarMetadata(): Promise<void> {
        try {
            await IOUtils.remove(getSidecarMetadataPath(), {
                ignoreAbsent: true,
            });
        } catch (error: any) {
            logDebug(`Failed to remove sidecar metadata: ${error?.message || error}`);
        }
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
    void shutdownSidecarManager();
}

export async function shutdownSidecarManager(): Promise<void> {
    if (!sidecarManagerInstance) {
        try {
            await IOUtils.remove(getSidecarMetadataPath(), {
                ignoreAbsent: true,
            });
        } catch {
            // Best-effort cleanup only.
        }
        return;
    }

    const activeManager = sidecarManagerInstance;
    sidecarManagerInstance = null;
    await activeManager.stop();
}
