/**
 * SLOs related to monitors in maintenance, and the SLO corrections (excluded
 * time windows) that apply to them. Pure logic; Datadog calls live in
 * slo.backend.ts.
 */
import { evaluateScope, parseScope, positiveTerms, tagMatches, toValidMs, type CoverageRow } from './coverage.ts';

export interface SloSummary {
    id: string;
    name: string;
    type: string;
    monitorIds: number[];
    tags: string[];
    /** Current SLI, in percent. */
    sli: number | null;
    /** Error budget remaining, in percent. */
    errorBudgetRemaining: number | null;
    target: number | null;
    timeframe: string | null;
}

export interface SloCorrectionSummary {
    id: string;
    /** Set when the correction targets one SLO. */
    sloId: string | null;
    /** Set when the correction targets every SLO matching a tag query (e.g. `service:web-store`). */
    sloQuery: string | null;
    category: string;
    description: string | null;
    /** Epoch seconds. */
    start: number | null;
    /** Epoch seconds; null for recurring corrections, which use `duration`. */
    end: number | null;
    /** Seconds per occurrence (recurring corrections). */
    duration: number | null;
    rrule: string | null;
    timezone: string | null;
    creator: string | null;
}

export interface SloContext {
    slos: SloSummary[];
    corrections: SloCorrectionSummary[];
    fetchedAt: string;
}

export type SloRelation = 'Monitor-based SLO' | 'Shares downtime scope' | 'Shares downtime tags';

/**
 * How tag/scope-based downtimes relate to SLOs:
 * - `scope` (default): an SLO carrying the downtime's group scope (its positive
 *   terms) is related; monitor tags aren't required. When the scope is `*` or
 *   only exclusions, the downtime's monitor tags are used instead.
 * - `strict`: the SLO must carry every monitor tag and satisfy the scope.
 */
export type SloMatchMode = 'scope' | 'strict';

export interface RelatedSlo {
    slo: SloSummary;
    relation: SloRelation;
    /** For tag relations: the downtime tags/scope terms the SLO carries. */
    matchedTags: string[];
}

export type CorrectionState = 'Active' | 'Scheduled' | 'Recurring' | 'Ended';

export interface CorrectionView {
    correction: SloCorrectionSummary;
    state: CorrectionState;
    startMs: number | null;
    endMs: number | null;
    /** How long it runs in total (one occurrence for recurring corrections). */
    durationMs: number | null;
}

function concreteTags(monitorTags: string[]): string[] {
    return monitorTags.map((tag) => tag.trim()).filter((tag) => tag && tag !== '*');
}

/**
 * Whether a tag/scope-based downtime relates to an SLO, and through which
 * tags. Negated scope terms are never required.
 */
function downtimeRelation(
    monitorTags: string[],
    scope: string | null,
    sloTags: string[],
    mode: SloMatchMode,
): Pick<RelatedSlo, 'relation' | 'matchedTags'> | null {
    const expr = parseScope(scope);
    const scopeTerms = positiveTerms(expr);
    const tags = concreteTags(monitorTags);
    const scopeOk = scopeTerms.length === 0 || evaluateScope(expr, sloTags, { ignoreNegations: true });
    const matchedScope = scopeTerms.filter((term) => tagMatches(term, sloTags));

    if (mode === 'scope' && scopeTerms.length > 0) {
        return scopeOk ? { relation: 'Shares downtime scope', matchedTags: matchedScope } : null;
    }
    // Strict mode, or a `*` scope: every monitor tag (and the scope, if any).
    if (tags.length === 0 && scopeTerms.length === 0) return null;
    if (!scopeOk || !tags.every((tag) => tagMatches(tag, sloTags))) return null;
    return { relation: 'Shares downtime tags', matchedTags: [...tags, ...matchedScope] };
}

/**
 * SLOs related to a monitor in maintenance:
 * - monitor-based SLOs that use the monitor (any coverage source);
 * - for tag/scope coverage, SLOs matching one of the downtimes that covers the
 *   monitor, by its group scope (default) or, in strict mode, by every monitor
 *   tag and the scope. See {@link SloMatchMode}.
 */
export function relatedSlos(row: CoverageRow, slos: SloSummary[], mode: SloMatchMode = 'scope'): RelatedSlo[] {
    const related = new Map<string, RelatedSlo>();
    for (const slo of slos) {
        if (slo.monitorIds.includes(row.monitor.id)) {
            related.set(slo.id, { slo, relation: 'Monitor-based SLO', matchedTags: [] });
        }
    }
    if (row.source !== 'Direct (monitor ID)') {
        for (const match of row.matches) {
            if (match.kind === 'direct' || match.downtime.isPlaceholder) continue;
            for (const slo of slos) {
                if (related.has(slo.id) || slo.tags.length === 0) continue;
                const relation = downtimeRelation(match.downtime.monitorTags, match.downtime.scope, slo.tags, mode);
                if (relation) related.set(slo.id, { slo, ...relation });
            }
        }
    }
    return [...related.values()].sort((a, b) => a.slo.name.localeCompare(b.slo.name));
}

/** Whether a correction applies to an SLO: by id, or by a tag query the SLO's tags satisfy. */
export function correctionAppliesTo(correction: SloCorrectionSummary, slo: SloSummary): boolean {
    if (correction.sloId) return correction.sloId === slo.id;
    const query = parseScope(correction.sloQuery);
    return positiveTerms(query).length > 0 && evaluateScope(query, slo.tags);
}

export function correctionView(correction: SloCorrectionSummary, nowMs: number): CorrectionView {
    const startMs = toValidMs(correction.start);
    const endMs = toValidMs(correction.end);
    if (correction.rrule) {
        return { correction, state: 'Recurring', startMs, endMs, durationMs: correction.duration ? correction.duration * 1000 : null };
    }
    const durationMs = startMs !== null && endMs !== null ? endMs - startMs : correction.duration ? correction.duration * 1000 : null;
    let state: CorrectionState = 'Active';
    if (startMs !== null && startMs > nowMs) state = 'Scheduled';
    else if (endMs !== null && endMs <= nowMs) state = 'Ended';
    return { correction, state, startMs, endMs, durationMs };
}

/** Active, scheduled and recurring corrections for an SLO, soonest-ending first. Ended ones are omitted. */
export function currentCorrections(slo: SloSummary, corrections: SloCorrectionSummary[], nowMs: number): CorrectionView[] {
    const rank: Record<CorrectionState, number> = { Active: 0, Scheduled: 1, Recurring: 2, Ended: 3 };
    return corrections
        .filter((correction) => correctionAppliesTo(correction, slo))
        .map((correction) => correctionView(correction, nowMs))
        .filter((view) => view.state !== 'Ended')
        .sort((a, b) => rank[a.state] - rank[b.state] || (a.endMs ?? Infinity) - (b.endMs ?? Infinity));
}

/** Why a correction can't be extended here, or null if it can. */
export function correctionExtendBlockedReason(view: CorrectionView): string | null {
    if (view.state === 'Recurring') return 'Recurring correction: edit its schedule in Datadog.';
    if (view.endMs === null) return "This correction has no end time, so there's nothing to extend.";
    return null;
}

/** Why a correction can't be canceled here, or null if it can. */
export function correctionCancelBlockedReason(view: CorrectionView): string | null {
    if (view.state === 'Recurring') return 'Recurring correction: edit or delete it in Datadog.';
    return null;
}
