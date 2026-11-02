import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { readCache, writeCache } from './cache';
import type { CoverageRow } from './coverage';
import {
    currentCorrections,
    relatedSlos,
    type CorrectionView,
    type RelatedSlo,
    type SloContext,
    type SloMatchMode,
} from './slo';
import { loadSloContext } from './slo.backend';

export const SLO_QUERY_KEY = ['slo-context'] as const;
const CACHE_MAX_AGE_MS = 6 * 60 * 60_000;
const REFRESH_MS = 5 * 60_000;

/** A current SLO correction and the related SLOs (of monitors in maintenance) it applies to. */
export interface CorrectionRow {
    view: CorrectionView;
    slos: RelatedSlo['slo'][];
    /** Monitors in maintenance whose related SLOs this correction covers. */
    monitorIds: number[];
}

/**
 * SLOs and SLO corrections, loaded in parallel with the monitor snapshot (and
 * cached per browser), related to the monitors in maintenance.
 */
export function useSloData(rows: CoverageRow[], nowMs: number, matchMode: SloMatchMode = 'scope') {
    const [cached] = useState(() => readCache<SloContext>('slo-context', CACHE_MAX_AGE_MS));
    const query = useQuery({
        queryKey: SLO_QUERY_KEY,
        queryFn: () => loadSloContext(),
        initialData: cached?.value,
        initialDataUpdatedAt: cached?.savedAt,
        refetchInterval: REFRESH_MS,
        staleTime: 60_000,
    });
    const context = query.data;
    useEffect(() => {
        if (context && query.dataUpdatedAt !== cached?.savedAt) writeCache('slo-context', context, query.dataUpdatedAt);
    }, [context, query.dataUpdatedAt, cached?.savedAt]);

    // Monitor id → related SLOs, for every monitor in maintenance.
    const relatedByMonitor = useMemo(() => {
        const map = new Map<number, RelatedSlo[]>();
        if (!context) return map;
        rows.forEach((row) => {
            const related = relatedSlos(row, context.slos, matchMode);
            if (related.length > 0) map.set(row.monitor.id, related);
        });
        return map;
    }, [rows, context, matchMode]);

    // SLO id → its current (active, scheduled, recurring) corrections.
    const correctionsBySlo = useMemo(() => {
        const map = new Map<string, CorrectionView[]>();
        if (!context) return map;
        const seen = new Set<string>();
        relatedByMonitor.forEach((related) =>
            related.forEach(({ slo }) => {
                if (seen.has(slo.id)) return;
                seen.add(slo.id);
                const current = currentCorrections(slo, context.corrections, nowMs);
                if (current.length > 0) map.set(slo.id, current);
            }),
        );
        return map;
    }, [context, relatedByMonitor, nowMs]);

    return {
        context,
        isLoading: query.isLoading,
        error: query.error,
        relatedByMonitor,
        correctionsBySlo,
    };
}

/** Correction rows for the given monitors (e.g. the filtered table), one per correction. */
export function correctionRowsFor(
    rows: CoverageRow[],
    relatedByMonitor: Map<number, RelatedSlo[]>,
    correctionsBySlo: Map<string, CorrectionView[]>,
): CorrectionRow[] {
    const byId = new Map<string, CorrectionRow>();
    rows.forEach((row) => {
        (relatedByMonitor.get(row.monitor.id) ?? []).forEach(({ slo }) => {
            (correctionsBySlo.get(slo.id) ?? []).forEach((view) => {
                const entry = byId.get(view.correction.id) ?? { view, slos: [], monitorIds: [] };
                if (!entry.slos.some((s) => s.id === slo.id)) entry.slos.push(slo);
                if (!entry.monitorIds.includes(row.monitor.id)) entry.monitorIds.push(row.monitor.id);
                byId.set(view.correction.id, entry);
            });
        });
    });
    const rank = { Active: 0, Scheduled: 1, Recurring: 2, Ended: 3 } as const;
    return [...byId.values()].sort(
        (a, b) => rank[a.view.state] - rank[b.view.state] || (a.view.endMs ?? Infinity) - (b.view.endMs ?? Infinity),
    );
}
