import {
    cancelDowntimeV2,
    getDowntimeV2,
    listDowntimesV2,
    listMonitorDowntimesV2,
    updateDowntime,
    type EnrichedDowntimeV2,
} from '@datadog/action-catalog/dd/downtime';
import { searchMonitors, type MonitorSearchResult } from '@datadog/action-catalog/dd/monitor';
import { getUser, type SimplifiedUser } from '@datadog/action-catalog/dd/users';

import {
    buildCoverageRows,
    isActiveDowntime,
    type DatadogDowntimeMatch,
    type LiveDowntime,
    type LiveMonitor,
    type LiveSnapshot,
    type UserSummary,
} from './coverage';
import { extensionSchedule } from './schedule';

const DOWNTIME_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// Full monitor objects are ~18 KB each and actions cap responses at 10 MB, so
// page through the slim monitor search results instead.
const MONITOR_PAGE_SIZE = 1000;
const MAX_MONITOR_PAGES = 50;
const MONITOR_PAGE_CONCURRENCY = 3;

function assertDowntimeId(downtimeId: unknown): string {
    if (typeof downtimeId !== 'string' || !DOWNTIME_ID_PATTERN.test(downtimeId)) {
        throw new Error('Invalid downtime id.');
    }
    return downtimeId;
}

/**
 * Action outputs can arrive as array-like objects (`{"0": …, "1": …}`) after
 * crossing the runtime bridge, so accept both shapes.
 */
function toArray<T>(value: unknown): T[] {
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

function slimMonitor(monitor: MonitorSearchResult): LiveMonitor | null {
    const id = Number(monitor.id);
    if (!Number.isInteger(id) || id <= 0) {
        return null;
    }
    return {
        id,
        name: monitor.name ?? `Monitor ${id}`,
        type: monitor.type ?? 'unknown',
        overallState: monitor.status ?? 'Unknown',
        tags: toArray<string>(monitor.tags),
        creatorName: monitor.creator?.name ?? null,
        creatorHandle: monitor.creator?.handle ?? null,
        creatorEmail: monitor.creator?.email ?? null,
    };
}

async function fetchMonitorPage(page: number) {
    const response = await searchMonitors({ inputs: { page, per_page: MONITOR_PAGE_SIZE } });
    return {
        monitors: toArray<MonitorSearchResult>(response?.monitors),
        pageCount: Number(response?.metadata?.page_count ?? 1),
    };
}

/** Lists every monitor in the org via paginated monitor search. */
async function listAllMonitors(): Promise<LiveMonitor[]> {
    const first = await fetchMonitorPage(0);
    const pageCount = Math.min(Math.max(first.pageCount, 1), MAX_MONITOR_PAGES);
    const pages: MonitorSearchResult[][] = [first.monitors];
    let next = 1;
    const worker = async () => {
        while (next < pageCount) {
            const page = next++;
            pages[page] = (await fetchMonitorPage(page)).monitors;
        }
    };
    await Promise.all(Array.from({ length: MONITOR_PAGE_CONCURRENCY }, worker));
    const byId = new Map<number, LiveMonitor>();
    pages.flat().forEach((raw) => {
        const monitor = raw ? slimMonitor(raw) : null;
        if (monitor) byId.set(monitor.id, monitor);
    });
    return [...byId.values()];
}

/**
 * Ids of every monitor Datadog itself reports as muted (`muted:true`). This is
 * the source of truth for "in maintenance": it includes monitors muted by
 * downtimes the downtime list API doesn't return, such as host auto-mutes.
 */
async function listDatadogMutedMonitorIds(): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 0; page < MAX_MONITOR_PAGES; page++) {
        const response = await searchMonitors({ inputs: { page, per_page: MONITOR_PAGE_SIZE, query: 'muted:true' } });
        const batch = toArray<MonitorSearchResult>(response?.monitors);
        batch.forEach((monitor) => {
            const id = Number(monitor?.id);
            if (Number.isInteger(id) && id > 0) ids.push(id);
        });
        if (batch.length < MONITOR_PAGE_SIZE) break;
    }
    return ids;
}

function toMonitorId(value: unknown): number | null {
    const id = Number(value);
    return value != null && Number.isInteger(id) && id > 0 ? id : null;
}

function slimDowntime(downtime: EnrichedDowntimeV2): LiveDowntime {
    const identifier = downtime.monitor_identifier;
    const schedule = downtime.schedule;
    let start: string | null = null;
    let end: string | null = null;
    let isRecurring = false;
    let timezone: string | null = null;
    if (schedule && 'recurrences' in schedule) {
        isRecurring = true;
        start = schedule.current_downtime?.start ?? null;
        end = schedule.current_downtime?.end ?? null;
        timezone = schedule.timezone ?? null;
    } else if (schedule) {
        start = schedule.start ?? null;
        end = schedule.end ?? null;
    }
    return {
        id: String(downtime.id),
        status: downtime.status ?? null,
        message: downtime.message ?? null,
        scope: downtime.scope ?? null,
        displayTimezone: downtime.display_timezone ?? timezone,
        monitorId: toMonitorId(identifier && 'monitor_id' in identifier ? identifier.monitor_id : null),
        monitorTags:
            identifier && 'monitor_tags' in identifier && Array.isArray(identifier.monitor_tags)
                ? identifier.monitor_tags
                : [],
        start,
        end,
        isRecurring,
        createdById: downtime.created_by?.id ?? null,
        created: downtime.created ?? null,
        url: downtime.url ?? null,
    };
}

const USER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const USER_BATCH_LIMIT = 50;
const USER_LOOKUP_CONCURRENCY = 2;

function isRateLimited(error: unknown): boolean {
    return /429|too many requests/i.test(error instanceof Error ? error.message : String(error));
}

function toUserSummary(userId: string, user: SimplifiedUser): UserSummary {
    const attributes = user.attributes;
    return {
        id: userId,
        name: attributes?.name || null,
        handle: attributes?.handle || null,
        email: attributes?.email || null,
    };
}

const RATE_LIMIT_ATTEMPTS = 4;

/**
 * Runs a call, backing off on HTTP 429 (1.5s, 3s, 4.5s). Returns null if it is still
 * rate-limited; other errors return null too, or are rethrown when requested.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>, rethrowOtherErrors = false): Promise<T | null> {
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

export interface ResolvedUsers {
    found: Record<string, UserSummary>;
    /** Ids Datadog no longer knows (e.g. deleted users); the frontend caches these too. */
    notFound: string[];
}

/**
 * Resolves up to 50 downtime-creator ids to names with a few concurrent
 * lookups. The frontend calls this in small batches for ids it hasn't cached,
 * so names fill in progressively and large orgs never page their whole user
 * directory (the Demo org has more than 10,000 users).
 */
export async function resolveUsers(userIds: string[]): Promise<ResolvedUsers> {
    const ids = [...new Set(Array.isArray(userIds) ? userIds : [])]
        .filter((id): id is string => typeof id === 'string' && USER_ID_PATTERN.test(id))
        .slice(0, USER_BATCH_LIMIT);
    const found: Record<string, UserSummary> = {};
    const notFound: string[] = [];
    let next = 0;
    const worker = async () => {
        while (next < ids.length) {
            const userId = ids[next++];
            try {
                const user = await withRateLimitRetry(() => getUser({ inputs: { user_id: userId } }), true);
                if (user) found[userId] = toUserSummary(userId, user);
            } catch {
                notFound.push(userId);
            }
        }
    };
    await Promise.all(Array.from({ length: USER_LOOKUP_CONCURRENCY }, worker));
    return { found, notFound };
}

/**
 * Loads live monitors and current downtimes, then trims the payload on the
 * server: only validated active downtimes and the monitors they cover are
 * returned (roughly a fifth of the org's monitors). The frontend re-runs the
 * same matching on this subset, so filters still operate on one dataset.
 */
export async function loadMaintenanceSnapshot(): Promise<LiveSnapshot> {
    const [monitors, downtimesResponse, datadogMutedIds] = await Promise.all([
        listAllMonitors(),
        listDowntimesV2({ inputs: { current_only: true, page_limit: 1000 } }),
        listDatadogMutedMonitorIds(),
    ]);
    const nowMs = Date.now();
    const downtimes = toArray<EnrichedDowntimeV2>(downtimesResponse?.downtimes)
        .map(slimDowntime)
        .filter((downtime) => isActiveDowntime(downtime, nowMs));
    const fetchedAt = new Date(nowMs).toISOString();
    const covered = buildCoverageRows({ monitors, downtimes, fetchedAt }, nowMs);
    const coveredDowntimeIds = new Set(covered.flatMap((row) => row.matches.map((m) => m.downtime.id)));
    // Keep covered monitors plus any monitor Datadog reports muted; the frontend
    // fetches Datadog's own downtime matches for the latter in the background.
    const keepIds = new Set([...covered.map((row) => row.monitor.id), ...datadogMutedIds]);

    return {
        monitors: monitors.filter((monitor) => keepIds.has(monitor.id)),
        downtimes: downtimes.filter((downtime) => coveredDowntimeIds.has(downtime.id)),
        datadogMutedIds,
        fetchedAt,
    };
}

/** Fetches the raw get-downtime action output for the detail modal. */
export async function fetchDowntimeDetail(downtimeId: string): Promise<EnrichedDowntimeV2> {
    return getDowntimeV2({ inputs: { downtime_id: assertDowntimeId(downtimeId) } });
}

/**
 * Cancels a downtime only after re-reading it live and confirming it is still
 * active, so a stale table row can't cancel an already-ended downtime.
 */
export async function cancelActiveDowntime(downtimeId: string): Promise<{ canceledId: string }> {
    const id = assertDowntimeId(downtimeId);
    const current = await getDowntimeV2({ inputs: { downtime_id: id } });
    if (current.status !== 'active') {
        throw new Error(
            `Downtime ${id} is no longer active (status: ${current.status ?? 'unknown'}).`,
        );
    }
    await cancelDowntimeV2({ inputs: { downtime_id: id } });
    return { canceledId: id };
}


const MAX_EXTENSION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Extends an active one-time downtime to a new end time. Re-reads the
 * downtime live first and refuses if it is no longer active, is recurring, is
 * open-ended, or if the new end would not push the current end later.
 */
export async function extendActiveDowntime(
    downtimeId: string,
    newEndIso: string,
): Promise<{ downtimeId: string; end: string }> {
    const id = assertDowntimeId(downtimeId);
    const newEndMs = typeof newEndIso === 'string' ? Date.parse(newEndIso) : NaN;
    const nowMs = Date.now();
    if (!Number.isFinite(newEndMs)) {
        throw new Error('Invalid new end time.');
    }
    if (newEndMs <= nowMs + 60_000) {
        throw new Error('The new end time must be at least one minute in the future.');
    }
    if (newEndMs > nowMs + MAX_EXTENSION_MS) {
        throw new Error('The new end time must be within one year from now.');
    }

    const current = await getDowntimeV2({ inputs: { downtime_id: id } });
    if (current.status !== 'active') {
        throw new Error(`Downtime ${id} is no longer active (status: ${current.status ?? 'unknown'}).`);
    }
    const schedule = current.schedule;
    if (schedule && 'recurrences' in schedule) {
        throw new Error('Recurring downtimes cannot be extended here. Edit the recurrence in Datadog.');
    }
    const currentEndMs = schedule?.end ? Date.parse(schedule.end) : NaN;
    if (!Number.isFinite(currentEndMs)) {
        throw new Error('This downtime has no end date, so there is nothing to extend.');
    }
    if (newEndMs <= currentEndMs) {
        throw new Error('The new end time must be later than the current end time.');
    }

    const end = new Date(newEndMs).toISOString();
    // Resend the current start unchanged: without it Datadog treats the update as "start now".
    await updateDowntime({ inputs: { downtime_id: id, id, schedule: extensionSchedule(schedule?.start, end) } });
    return { downtimeId: id, end };
}


/**
 * Asks Datadog which active downtimes it applies to a monitor. The detail
 * panel calls this on demand for monitors Datadog reports muted whose
 * downtimes aren't in the downtime list (for example host auto-mutes).
 */
export async function fetchDatadogMatches(monitorId: number, pageLimit = 100): Promise<DatadogDowntimeMatch[]> {
    const id = Number(monitorId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error('Invalid monitor id.');
    }
    const limit = Math.min(Math.max(Math.trunc(Number(pageLimit)) || 100, 1), 100);
    const response = await listMonitorDowntimesV2({ inputs: { monitor_id: id, page_limit: limit } });
    return toArray<{ id: string; scope?: string; groups?: string[]; start?: string; end?: string }>(
        response?.downtimeMatches,
    ).map((match) => ({
        id: String(match.id),
        scope: match.scope ?? null,
        groups: toArray<string>(match.groups),
        start: match.start ?? null,
        end: match.end ?? null,
    }));
}
