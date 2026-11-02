/**
 * SLOs related to monitors in maintenance, and the SLO corrections (excluded
 * time windows) that apply to them. Pure logic; Datadog calls live in
 * slo.backend.ts.
 */
import { evaluateScope, parseScope, positiveTerms, tagMatches, toValidMs, type CoverageRow, type ScopeExpr } from './coverage.ts';

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
 * Monitor-based SLOs are computed from their own monitors, so a downtime only
 * affects them through those monitors. Count-based (`metric`) and time-slice
 * SLOs have no monitors and are related by tags.
 */
export function isMonitorBasedSlo(slo: Pick<SloSummary, 'type'>): boolean {
    return slo.type === 'monitor';
}

/**
 * How downtimes relate to count-based and time-slice SLOs:
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
    /**
     * For downtimes on a monitor ID, whose scope only filters groups: an
     * environment alone (`env:dev`) says nothing about the service affected,
     * so at least one other term is required.
     */
    requireNonEnvTerm = false,
): Pick<RelatedSlo, 'relation' | 'matchedTags'> | null {
    const expr = parseScope(scope);
    const scopeTerms = positiveTerms(expr);
    const tags = concreteTags(monitorTags);
    if (requireNonEnvTerm && [...tags, ...scopeTerms].every((term) => /^env:/i.test(term))) return null;
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
 * SLOs related to a monitor in maintenance, by SLO type:
 * - monitor-based SLOs: only those that use the monitor (whatever the downtime
 *   type). One built on other monitors isn't affected, even if its tags match;
 * - count-based and time-slice SLOs: those matching one of the downtimes that
 *   covers the monitor, by its group scope (default) or, in strict mode, by
 *   every monitor tag and the scope. See {@link SloMatchMode}. This includes
 *   downtimes on a monitor ID with a group scope, as long as the scope names
 *   more than an environment; a whole-monitor downtime on a monitor ID carries
 *   no tags, so it relates no count-based SLO.
 */
export function relatedSlos(row: CoverageRow, slos: SloSummary[], mode: SloMatchMode = 'scope'): RelatedSlo[] {
    const related = new Map<string, RelatedSlo>();
    for (const slo of slos) {
        if (isMonitorBasedSlo(slo)) {
            if (slo.monitorIds.includes(row.monitor.id)) {
                related.set(slo.id, { slo, relation: 'Monitor-based SLO', matchedTags: [] });
            }
            continue;
        }
        if (slo.tags.length === 0) continue;
        for (const match of row.matches) {
            if (match.downtime.isPlaceholder) continue;
            const relation = downtimeRelation(
                match.downtime.monitorTags,
                match.downtime.scope,
                slo.tags,
                mode,
                match.kind === 'direct',
            );
            if (relation) {
                related.set(slo.id, { slo, ...relation });
                break;
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

/** How close a correction's start must be to the downtime's start to count as its correction. */
export const LINK_START_TOLERANCE_MS = 5 * 60_000;

export interface LinkedCorrection {
    view: CorrectionView;
    /** The SLOs this correction applies to (the downtime's related SLOs, or every SLO its query matches). */
    slos: SloSummary[];
    /**
     * `related-slo`: it targets one of the downtime's related SLOs.
     * `from-downtime`: a tag-based correction whose query is the downtime's
     * monitor tags, as Datadog creates from the downtime editor.
     */
    reason: 'related-slo' | 'from-downtime';
}

/** The parts of a downtime that link corrections to it. */
export interface DowntimeForLinking {
    startMs: number | null;
    monitorTags: string[];
}

/**
 * True when a tag query is exactly the downtime's monitor tags (any order,
 * case-insensitive), which is how Datadog fills in a correction created from
 * the downtime editor ("Preview SLO Correction").
 */
export function queryMatchesMonitorTags(query: string | null, monitorTags: string[]): boolean {
    const tags = concreteTags(monitorTags).map((tag) => tag.toLowerCase());
    if (!query || tags.length === 0) return false;
    const expr = parseScope(query);
    const onlyAnd = (node: ScopeExpr): boolean =>
        node.type === 'term' || (node.type === 'and' && node.children.every(onlyAnd));
    if (!onlyAnd(expr)) return false;
    const terms = new Set(positiveTerms(expr).map((term) => term.toLowerCase()));
    return terms.size === new Set(tags).size && tags.every((tag) => terms.has(tag));
}

export interface DowntimeCorrections {
    /** One-time corrections that start with the downtime (within 5 minutes) on its related SLOs. */
    linked: LinkedCorrection[];
    /** Recurring corrections on the same SLOs: out of scope, edited in Datadog. */
    recurring: LinkedCorrection[];
}

/**
 * SLOs related through one downtime: for every monitor it covers, the SLOs
 * related through that downtime alone (same rules and mode as {@link relatedSlos}).
 */
export function downtimeRelatedSlos(
    downtimeId: string,
    rows: CoverageRow[],
    slos: SloSummary[],
    mode: SloMatchMode = 'scope',
): SloSummary[] {
    const byId = new Map<string, SloSummary>();
    for (const row of rows) {
        const match = row.matches.find((m) => m.downtime.id === downtimeId);
        if (!match || match.downtime.isPlaceholder) continue;
        const only: CoverageRow = {
            ...row,
            matches: [match],
            primary: match,
            source: match.kind === 'direct' ? 'Direct (monitor ID)' : 'Tag/Scope-based',
        };
        relatedSlos(only, slos, mode).forEach(({ slo }) => byId.set(slo.id, slo));
    }
    return [...byId.values()];
}

/**
 * The SLO corrections linked to a downtime: one-time corrections, not ended,
 * whose start is within {@link LINK_START_TOLERANCE_MS} of the downtime's
 * start, and that either
 * - target one of the downtime's related SLOs (by id or tag query), or
 * - are tag-based with the downtime's monitor tags as their query (created
 *   from the downtime in Datadog), whichever SLOs that query matches.
 * Recurring corrections that would match are returned separately and never
 * changed.
 */
export function linkedCorrections(
    downtime: DowntimeForLinking,
    downtimeSlos: SloSummary[],
    allSlos: SloSummary[],
    corrections: SloCorrectionSummary[],
    nowMs: number,
): DowntimeCorrections {
    const linked: LinkedCorrection[] = [];
    const recurring: LinkedCorrection[] = [];
    for (const correction of corrections) {
        let reason: LinkedCorrection['reason'] = 'related-slo';
        let slos = downtimeSlos.filter((slo) => correctionAppliesTo(correction, slo));
        if (slos.length === 0) {
            if (correction.sloId || !queryMatchesMonitorTags(correction.sloQuery, downtime.monitorTags)) continue;
            reason = 'from-downtime';
            slos = allSlos.filter((slo) => correctionAppliesTo(correction, slo));
        }
        const view = correctionView(correction, nowMs);
        if (view.state === 'Recurring') {
            recurring.push({ view, slos, reason });
            continue;
        }
        if (view.state === 'Ended' || downtime.startMs === null || view.startMs === null) continue;
        if (Math.abs(view.startMs - downtime.startMs) <= LINK_START_TOLERANCE_MS) linked.push({ view, slos, reason });
    }
    const byStart = (a: LinkedCorrection, b: LinkedCorrection) => (a.view.startMs ?? 0) - (b.view.startMs ?? 0);
    return { linked: linked.sort(byStart), recurring: recurring.sort(byStart) };
}

/** Why a linked correction can't be moved to `newEndMs` with its downtime, or null if it can. */
export function linkedExtendBlockedReason(view: CorrectionView, newEndMs: number): string | null {
    const blocked = correctionExtendBlockedReason(view);
    if (blocked) return blocked;
    if (view.endMs !== null && view.endMs >= newEndMs) return 'Already ends at or after the new end.';
    return null;
}
