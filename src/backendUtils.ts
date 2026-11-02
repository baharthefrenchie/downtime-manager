/**
 * Helpers shared by the backend functions (maintenance.backend.ts, slo.backend.ts).
 */
import { getInitiatingUser } from '@datadog/apps-backend/user';

import { sanitizeActor, type Actor } from './changeRecord';

/**
 * The person whose click started this backend call, as authenticated by the
 * Datadog Apps runtime (not the app author the call runs as). Read on the
 * backend rather than sent by the frontend, so it can't be forged. Validated
 * and length-limited before it is written anywhere.
 */
export async function initiatingActor(): Promise<Actor> {
    try {
        const user = await getInitiatingUser();
        return sanitizeActor({ name: user?.name, email: user?.email });
    } catch {
        return { name: null, email: null };
    }
}

/**
 * Action outputs can arrive as array-like objects (`{"0": …, "1": …}`) after
 * crossing the runtime bridge, so accept both shapes.
 */
export function toArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) {
        return value as T[];
    }
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .filter((key) => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => (value as Record<string, T>)[key]);
    }
    return [];
}

function isRateLimited(error: unknown): boolean {
    return /429|too many requests/i.test(error instanceof Error ? error.message : String(error));
}

const RATE_LIMIT_ATTEMPTS = 4;

/**
 * Runs a call, backing off on HTTP 429 (1.5s, 3s, 4.5s). Returns null if it is still
 * rate-limited; other errors return null too, or are rethrown when requested.
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>, rethrowOtherErrors = false): Promise<T | null> {
    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
        try {
            return await call();
        } catch (error) {
            if (!isRateLimited(error)) {
                if (rethrowOtherErrors) throw error;
                return null;
            }
            if (attempt === RATE_LIMIT_ATTEMPTS - 1) {
                return null;
            }
            await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        }
    }
    return null;
}
