import { useEffect, useMemo, useRef, useState } from 'react';

import { readCache, writeCache } from './cache';
import type { UserSummary } from './coverage';
import { resolveUsers } from './maintenance.backend';

const NAMES_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const UNKNOWN_MAX_AGE_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 25;
// Datadog's users API allows few calls per minute; spacing batches avoids 429 bursts.
const PAUSE_BETWEEN_BATCHES_MS = 4000;
// Lookups that were rate-limited (neither found nor unknown) are retried this many times.
const MAX_ATTEMPTS = 3;

/**
 * Resolves downtime-creator ids to names. Known names come from this
 * browser's cache instantly; only missing ids are looked up, in small spaced
 * batches, in the order given (table order, so the first rows resolve first).
 */
export function useCreatorNames(userIds: string[]) {
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
    useEffect(() => {
        usersRef.current = users;
        unknownRef.current = unknown;
    }, [users, unknown]);

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
            const queue = [...missing];
            const attempts = new Map<string, number>();
            let isFirstBatch = true;
            while (queue.length > 0 && !cancelled) {
                if (!isFirstBatch) {
                    await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_BATCHES_MS));
                    if (cancelled) return;
                }
                isFirstBatch = false;
                const batch = queue.splice(0, BATCH_SIZE);
                let done = batch;
                try {
                    const { found, notFound } = await resolveUsers(batch);
                    if (cancelled) return;
                    // Neither found nor unknown means the lookup was rate-limited: retry it later.
                    const retry = batch.filter((id) => !found[id] && !notFound.includes(id));
                    retry.forEach((id) => {
                        const tries = (attempts.get(id) ?? 0) + 1;
                        attempts.set(id, tries);
                        if (tries < MAX_ATTEMPTS) queue.push(id);
                    });
                    done = batch.filter((id) => !queue.includes(id));
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
                    done.forEach((id) => next.delete(id));
                    return next;
                });
            }
        };
        void run();
        return () => {
            cancelled = true;
        };
    }, [idsKey]);

    return { users, resolvingIds: inFlight };
}
