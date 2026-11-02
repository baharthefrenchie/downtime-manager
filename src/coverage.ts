/**
 * Shared types plus the pure matching logic that turns live monitors and
 * downtimes into monitor-centric coverage rows.
 */
import { evaluateScope, parseScope, positiveTerms, tagMatches, type ScopeExpr } from './scope.ts';

export { evaluateScope, parseScope, positiveTerms, tagMatches, type ScopeExpr } from './scope.ts';

export interface LiveMonitor {
    id: number;
    name: string;
    type: string;
    overallState: string;
    tags: string[];
    creatorName: string | null;
    creatorHandle: string | null;
    creatorEmail: string | null;
}

export interface LiveDowntime {
    id: string;
    status: string | null;
    message: string | null;
    scope: string | null;
    displayTimezone: string | null;
    monitorId: number | null;
    monitorTags: string[];
    start: string | null;
    end: string | null;
    isRecurring: boolean;
    createdById: string | null;
    created: string | null;
    url: string | null;
    /**
     * True when this downtime was learned from Datadog's per-monitor matching
     * rather than the downtime list (for example host auto-mutes, which the
     * list API omits). Only id, scope and schedule are known up front.
     */
    fromDatadogMatch?: boolean;
    /**
     * Stand-in for a monitor Datadog reports muted whose downtime isn't in the
     * downtime list yet; the real downtimes load when its details are opened.
     */
    isPlaceholder?: boolean;
    /** A placeholder shown while the downtime list is still loading. */
    isLoading?: boolean;
}

/** One downtime Datadog itself applies to a monitor (from its downtime-matching API). */
export interface DatadogDowntimeMatch {
    id: string;
    scope: string | null;
    groups: string[];
    start: string | null;
    end: string | null;
}

export interface UserSummary {
    id: string;
    name: string | null;
    handle: string | null;
    email: string | null;
}

export interface LiveSnapshot {
    monitors: LiveMonitor[];
    downtimes: LiveDowntime[];
    /** Monitors Datadog reports as muted (`muted:true`): the source of truth for "in maintenance". */
    datadogMutedIds?: number[];
    fetchedAt: string;
    /** The fast first look: muted monitors only, their downtimes still loading. */
    isPreview?: boolean;
}

/** How a downtime reaches a monitor. */
export type MatchKind = 'direct' | 'tag' | 'scope';

export interface DowntimeMatch {
    downtime: LiveDowntime;
    kind: MatchKind;
    /** True when every group of the monitor is muted (scope `*` or scope satisfied by monitor tags). */
    coversAllGroups: boolean;
    startMs: number | null;
    endMs: number | null;
    creatorLabel: string;
    reason: string;
}

export type CoverageSource = 'Direct (monitor ID)' | 'Tag/Scope-based' | 'Direct + Tag/Scope';
/** Whether the whole monitor is silenced or only some of its groups. */
export type MaintenanceState = 'Whole monitor' | 'Groups only' | 'Not muting';

/** Where the primary downtime's window stands relative to now. */
export type WindowState = 'Ending soon' | 'Scheduled end' | 'Open-ended' | 'Stale' | 'Unknown';

export const ENDING_SOON_MS = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function windowStateOf(match: Pick<DowntimeMatch, 'startMs' | 'endMs'>, nowMs: number): WindowState {
    if (match.endMs !== null) {
        return match.endMs - nowMs <= ENDING_SOON_MS ? 'Ending soon' : 'Scheduled end';
    }
    return match.startMs !== null && nowMs - match.startMs > STALE_AFTER_MS ? 'Stale' : 'Open-ended';
}

export interface CoverageRow {
    monitor: LiveMonitor;
    matches: DowntimeMatch[];
    primary: DowntimeMatch;
    source: CoverageSource;
    maintenanceState: MaintenanceState;
    windowState: WindowState;
    owner: string;
    downtimeCreators: string[];
    latestMessage: string | null;
}

// Anything before 2000-01-01 is treated as a missing/placeholder value (e.g. epoch 0 → 1970).
const MIN_VALID_MS = Date.UTC(2000, 0, 1);

export function toValidMs(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    let ms: number;
    if (typeof value === 'number') {
        ms = value < 1e12 ? value * 1000 : value;
    } else if (/^\d+$/.test(value)) {
        const n = Number(value);
        ms = n < 1e12 ? n * 1000 : n;
    } else {
        ms = Date.parse(value);
    }
    if (!Number.isFinite(ms) || ms < MIN_VALID_MS) {
        return null;
    }
    return ms;
}

/**
 * Validated active check: status is `active`, start is in the past or
 * missing, and end is in the future or missing.
 */
export function isActiveDowntime(downtime: LiveDowntime, nowMs: number): boolean {
    if (downtime.status !== 'active') {
        return false;
    }
    const startMs = toValidMs(downtime.start);
    const endMs = toValidMs(downtime.end);
    if (startMs !== null && startMs > nowMs) {
        return false;
    }
    if (endMs !== null && endMs <= nowMs) {
        return false;
    }
    return true;
}

function isWildcardOnly(tags: string[]): boolean {
    return tags.length === 0 || tags.every((tag) => tag.trim() === '*');
}

/** Positive tag terms in a downtime scope such as `env:prod AND (service:api OR service:web)`. */
export function positiveScopeTerms(scope: string | null): string[] {
    return positiveTerms(parseScope(scope));
}

/**
 * True when the scope selects every group: `*`, empty, or only exclusions
 * (such as `-host:a`), which Datadog treats as every group but those.
 */
function isAllGroupsScope(scope: string | null): boolean {
    return positiveScopeTerms(scope).length === 0;
}

export function userLabel(user: UserSummary | undefined, fallbackId: string | null): string {
    if (user) {
        if (user.name && user.handle && user.name !== user.handle) {
            return `${user.name} (${user.handle})`;
        }
        return user.name || user.handle || user.email || 'Unknown user';
    }
    return fallbackId ? 'Unknown user' : 'Unknown';
}

export function monitorOwner(monitor: LiveMonitor): string {
    return monitor.creatorName || monitor.creatorHandle || monitor.creatorEmail || 'Unknown owner';
}

/** A downtime with its scope parsed once, for matching against every monitor. */
interface PreparedDowntime {
    downtime: LiveDowntime;
    expr: ScopeExpr;
    allGroups: boolean;
    wildcardTags: boolean;
}

function prepareDowntime(downtime: LiveDowntime): PreparedDowntime {
    const expr = parseScope(downtime.scope);
    return {
        downtime,
        expr,
        allGroups: positiveTerms(expr).length === 0,
        wildcardTags: isWildcardOnly(downtime.monitorTags),
    };
}

function matchDowntime(
    monitor: LiveMonitor,
    prepared: PreparedDowntime,
): Pick<DowntimeMatch, 'kind' | 'coversAllGroups' | 'reason'> | null {
    const { downtime, allGroups } = prepared;
    // The monitor's own tags satisfy the scope, so every group of the monitor is in scope.
    const scopeOnTags = () => !allGroups && evaluateScope(prepared.expr, monitor.tags);

    // 1. Direct: monitor_identifier.monitor_id
    if (downtime.monitorId !== null) {
        if (downtime.monitorId !== monitor.id) {
            return null;
        }
        return {
            kind: 'direct',
            coversAllGroups: allGroups || scopeOnTags(),
            reason: `monitor_identifier.monitor_id = ${monitor.id}`,
        };
    }

    // 2. Tag-based: every downtime monitor tag must be present on the monitor.
    if (!prepared.wildcardTags) {
        const allTagsMatch = downtime.monitorTags.every((tag) => tagMatches(tag, monitor.tags));
        if (!allTagsMatch) {
            return null;
        }
        return {
            kind: 'tag',
            coversAllGroups: allGroups || scopeOnTags(),
            reason: `monitor tags [${downtime.monitorTags.join(', ')}] all present on monitor`,
        };
    }

    // 3. Scope-based: wildcard monitor tags, targeting by scope.
    if (allGroups) {
        return {
            kind: 'scope',
            coversAllGroups: true,
            reason: 'monitor tags `*` with scope `*` (org-wide downtime)',
        };
    }
    if (scopeOnTags()) {
        return {
            kind: 'scope',
            coversAllGroups: true,
            reason: `scope \`${downtime.scope}\` matches monitor tags`,
        };
    }
    return null;
}

function maintenanceStateOf(matches: DowntimeMatch[], isMutedByDatadog: boolean | undefined): MaintenanceState {
    // Datadog doesn't report the monitor as muted: its downtimes mute nothing right now
    // (for example, no current group matches their scope).
    if (isMutedByDatadog === false) {
        return 'Not muting';
    }
    return matches.some((m) => m.coversAllGroups) ? 'Whole monitor' : 'Groups only';
}

function downtimeFromDatadogMatch(match: DatadogDowntimeMatch): LiveDowntime {
    return {
        id: match.id,
        status: 'active',
        message: null,
        scope: match.scope,
        displayTimezone: null,
        monitorId: null,
        monitorTags: ['*'],
        start: match.start,
        end: match.end,
        isRecurring: false,
        createdById: null,
        created: null,
        url: null,
        fromDatadogMatch: true,
    };
}

function placeholderDowntime(monitorId: number, isLoading: boolean): LiveDowntime {
    return {
        id: `datadog-muted-${monitorId}`,
        status: 'active',
        message: null,
        scope: null,
        displayTimezone: null,
        monitorId: null,
        monitorTags: ['*'],
        start: null,
        end: null,
        isRecurring: false,
        createdById: null,
        created: null,
        url: null,
        fromDatadogMatch: true,
        isPlaceholder: true,
        isLoading,
    };
}

/** True when a row stands in for a Datadog-muted monitor whose downtimes haven't loaded yet. */
export function isPlaceholderRow(row: Pick<CoverageRow, 'primary'>): boolean {
    return Boolean(row.primary.downtime.isPlaceholder);
}


const KIND_RANK: Record<MatchKind, number> = { direct: 0, tag: 1, scope: 2 };

/** Most relevant first: direct > tag > scope, then full coverage, then most recently started. */
function compareMatches(a: DowntimeMatch, b: DowntimeMatch): number {
    return (
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        Number(b.coversAllGroups) - Number(a.coversAllGroups) ||
        (b.startMs ?? 0) - (a.startMs ?? 0)
    );
}

export function buildCoverageRows(
    snapshot: LiveSnapshot,
    nowMs: number,
    users?: Record<string, UserSummary>,
    /**
     * Monitor id → downtimes Datadog itself applies (from its downtime-matching API),
     * fetched for muted monitors the downtime list can't explain.
     */
    verified?: Record<string, DatadogDowntimeMatch[]>,
    /** Creator ids Datadog says don't exist (deleted users); every other unknown id is still resolving. */
    unknownIds?: Set<string>,
): CoverageRow[] {
    const activeDowntimes = snapshot.downtimes.filter((downtime) => isActiveDowntime(downtime, nowMs));
    const rows: CoverageRow[] = [];

    const creatorLabelOf = (downtime: LiveDowntime) => {
        if (downtime.isLoading) return 'Loading…';
        if (downtime.fromDatadogMatch) return 'Not in downtime list';
        const id = downtime.createdById;
        if (!id) return 'Unknown';
        if (users?.[id]) return userLabel(users[id], id);
        return unknownIds?.has(id) ? 'Unknown user' : 'Resolving…';
    };
    const toMatch = (downtime: LiveDowntime, match: Pick<DowntimeMatch, 'kind' | 'coversAllGroups' | 'reason'>) => ({
        ...match,
        downtime,
        startMs: toValidMs(downtime.start),
        endMs: toValidMs(downtime.end),
        creatorLabel: creatorLabelOf(downtime),
    });

    const datadogMuted = snapshot.datadogMutedIds ? new Set(snapshot.datadogMutedIds) : null;

    // Direct downtimes only ever match their own monitor, so index them by monitor id;
    // tag and scope downtimes are checked against every monitor. Order is kept, so
    // matches come out exactly as a full scan would produce them.
    const byMonitorId = new Map<number, { index: number; prepared: PreparedDowntime }[]>();
    const indirect: { index: number; prepared: PreparedDowntime }[] = [];
    activeDowntimes.forEach((downtime, index) => {
        const entry = { index, prepared: prepareDowntime(downtime) };
        if (downtime.monitorId !== null) {
            const list = byMonitorId.get(downtime.monitorId) ?? [];
            list.push(entry);
            byMonitorId.set(downtime.monitorId, list);
        } else {
            indirect.push(entry);
        }
    });

    for (const monitor of snapshot.monitors) {
        const matches: DowntimeMatch[] = [];
        const direct = byMonitorId.get(monitor.id) ?? [];
        const candidates = direct.length === 0 ? indirect : [...direct, ...indirect].sort((a, b) => a.index - b.index);
        for (const { prepared } of candidates) {
            const match = matchDowntime(monitor, prepared);
            if (match) matches.push(toMatch(prepared.downtime, match));
        }
        // Downtimes Datadog applies that the downtime list doesn't include (e.g. host auto-mutes).
        const datadogMatches = verified?.[String(monitor.id)];
        datadogMatches?.forEach((datadogMatch) => {
            if (matches.some((m) => m.downtime.id === datadogMatch.id)) return;
            const downtime = downtimeFromDatadogMatch(datadogMatch);
            if (!isActiveDowntime(downtime, nowMs)) return;
            const groups = datadogMatch.groups.filter((group) => group && group !== 'None');
            matches.push(
                toMatch(downtime, {
                    kind: 'scope',
                    coversAllGroups: isAllGroupsScope(datadogMatch.scope),
                    reason: `Datadog applies scope \`${datadogMatch.scope ?? '*'}\`${groups.length ? ` to ${groups.slice(0, 3).join(', ')}${groups.length > 3 ? '…' : ''}` : ''}`,
                }),
            );
        });
        // Datadog reports the monitor muted, but its downtime isn't in the downtime list
        // (e.g. a host auto-mute): show it now, load the real downtimes on demand.
        if (matches.length === 0 && datadogMuted?.has(monitor.id)) {
            matches.push(
                toMatch(placeholderDowntime(monitor.id, Boolean(snapshot.isPreview)), {
                    kind: 'scope',
                    coversAllGroups: false,
                    reason: snapshot.isPreview
                        ? 'Downtimes are still loading'
                        : 'Muted by a downtime outside the downtime list, such as a host auto-mute',
                }),
            );
        }
        if (matches.length === 0) {
            continue;
        }
        matches.sort(compareMatches);
        const hasDirect = matches.some((m) => m.kind === 'direct');
        const hasIndirect = matches.some((m) => m.kind !== 'direct');
        const latest = [...matches].sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0))[0];
        rows.push({
            monitor,
            matches,
            primary: matches[0],
            source: hasDirect && hasIndirect ? 'Direct + Tag/Scope' : hasDirect ? 'Direct (monitor ID)' : 'Tag/Scope-based',
            maintenanceState: maintenanceStateOf(matches, datadogMuted ? datadogMuted.has(monitor.id) : undefined),
            windowState: matches[0].downtime.isPlaceholder ? 'Unknown' : windowStateOf(matches[0], nowMs),
            owner: monitorOwner(monitor),
            downtimeCreators: [...new Set(matches.map((m) => m.creatorLabel))],
            latestMessage: latest.downtime.message?.trim() || null,
        });
    }

    return rows.sort(
        (a, b) => (b.primary.startMs ?? 0) - (a.primary.startMs ?? 0) || a.monitor.name.localeCompare(b.monitor.name),
    );
}
