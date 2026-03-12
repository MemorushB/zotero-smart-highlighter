let currentPluginVersion: string | null = null;
let currentPluginRootURI: string | null = null;

export function setCurrentPluginVersion(version: string): void {
    const normalizedVersion = version.trim();
    currentPluginVersion = normalizedVersion || null;
}

export function getCurrentPluginVersion(): string | null {
    return currentPluginVersion;
}

export function setCurrentPluginRootURI(rootURI: string): void {
    const normalizedRootURI = rootURI.trim();
    currentPluginRootURI = normalizedRootURI || null;
}

export function getCurrentPluginRootURI(): string | null {
    return currentPluginRootURI;
}

export function clearCurrentPluginVersion(): void {
    currentPluginVersion = null;
    currentPluginRootURI = null;
}
