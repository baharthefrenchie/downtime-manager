import { useEffect, useMemo, useRef, useState } from 'react';

import { readCache, writeCache } from './cache';
import type { UserSummary } from './coverage';
import { resolveUsers } from './maintenance.backend';

const NAMES_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const UNKNOWN_MAX_AGE_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 50;

/**
 * Resolves downtime-creator ids to names. Known names come from this
 * browser's cache instantly; only missing ids are looked up, in batches, in
 * the order given (table order, so visible rows resolve first). While
 * `isPaused` is true only the first batch runs, leaving rate-limit headroom
 * for higher-priority calls.
 */
export function useCreatorNames(userIds: string[], isPaused = false) {
    const [users, setUsers] = useState<Record<string, UserSummary>>(
        () => readCache<Record<string, UserSummary>>('user-names', NAMES_MAX_AGE_MS)?.value ?? {},
    );
    const [unknown, setUnknown] = useState<Record<string, true>>(
        () => readCache<Record<string, true>>('user-unknown', UNKNOWN_MAX_AGE_MS)?.value ?? {},
    );
    const [inFlight, setInFlight] = useState<Set<string>>(() => new Set());

    // Latest maps for the async loop without re-triggering it on every batch.
    const usersRef = useRef(users);
    const unknownRef = useRef(unknown);
    const pausedRef = useRef(isPaused);
    const resumeRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        usersRef.current = users;
        unknownRef.current = unknown;
    }, [users, unknown]);
    useEffect(() => {
        pausedRef.current = isPaused;
        if (!isPaused) resumeRef.current?.();
    }, [isPaused]);

    // Keep the caller's order (table order); only dedupe.
    const idsKey = useMemo(() => [...new Set(userIds)].join(','), [userIds]);

    useEffect(() => {
        const missing = idsKey
            .split(',')
            .filter((id) => id && !usersRef.current[id] && !unknownRef.current[id]);
        if (missing.length === 0) return undefined;

        let cancelled = false;
        const run = async () => {
            setInFlight(new Set(missing));
            for (let i = 0; i < missing.length && !cancelled; i += BATCH_SIZE) {
                if (i > 0 && pausedRef.current) {
                    await new Promise<void>((resolve) => (resumeRef.current = resolve));
                    resumeRef.current = null;
                    if (cancelled) return;
                }
                const batch = missing.slice(i, i + BATCH_SIZE);
                try {
                    const { found, notFound } = await resolveUsers(batch);
                    if (cancelled) return;
                    setUsers((previous) => {
                        const next = { ...previous, ...found };
                        writeCache('user-names', next);
                        return next;
                    });
                    if (notFound.length > 0) {
                        setUnknown((previous) => {
                            const next = { ...previous };
                            notFound.forEach((id) => (next[id] = true));
                            writeCache('user-unknown', next);
                            return next;
                        });
                    }
                } catch {
                    // A failed batch leaves its ids unresolved; the next refresh retries them.
                }
                setInFlight((previous) => {
                    const next = new Set(previous);
                    batch.forEach((id) => next.delete(id));
                    return next;
                });
            }
        };
        void run();
        return () => {
            cancelled = true;
            resumeRef.current?.();
        };
    }, [idsKey]);

    return { users, resolvingIds: inFlight };
}
