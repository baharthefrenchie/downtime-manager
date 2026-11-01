/**
 * Per-viewer browser cache used only to paint the last known data instantly
 * while fresh data loads. It is never the source of truth: every cached value
 * is refetched live, and the app works normally when storage is unavailable
 * (private windows, blocked site data, iframe partitioning).
 */

const PREFIX = 'oncall-downtime:v1:';

interface Entry<T> {
    savedAt: number;
    value: T;
}

export interface Cached<T> {
    value: T;
    savedAt: number;
}

export function readCache<T>(key: string, maxAgeMs: number): Cached<T> | undefined {
    try {
        const raw = window.localStorage.getItem(PREFIX + key);
        if (!raw) return undefined;
        const entry = JSON.parse(raw) as Entry<T>;
        if (!entry || typeof entry.savedAt !== 'number' || Date.now() - entry.savedAt > maxAgeMs) {
            return undefined;
        }
        return { value: entry.value, savedAt: entry.savedAt };
    } catch {
        return undefined;
    }
}

export function writeCache<T>(key: string, value: T, savedAt: number = Date.now()): void {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt, value } satisfies Entry<T>));
    } catch {
        // Quota exceeded or storage blocked: caching is best-effort.
    }
}
