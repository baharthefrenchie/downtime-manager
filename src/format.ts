import type { CoverageRow, DowntimeMatch, WindowState } from './coverage';

type PillLevel = 'default' | 'success' | 'warning' | 'danger' | 'in-progress';

/** True when the app runs inside a frame (the Datadog UI); errors on cross-origin access mean yes. */
export function isEmbeddedInFrame(): boolean {
    try {
        return window.self !== window.top;
    } catch {
        return true;
    }
}

// Datadog UI hosts: app.datadoghq.com, us3/us5/ap1/ap2 sites, custom org subdomains
// (e.g. demo.datadoghq.com), datadoghq.eu and the US1-FED site.
const DATADOG_UI_ORIGIN = /^https:\/\/([a-z0-9-]+\.)+(datadoghq\.com|datadoghq\.eu|ddog-gov\.com)$/;

/** True for origins of the Datadog web UI (and nothing that merely contains a Datadog domain). */
export function isDatadogUiOrigin(origin: string): boolean {
    return DATADOG_UI_ORIGIN.test(origin);
}

/** Origin of the Datadog page embedding this app, if it's a Datadog UI host. */
function embeddingDatadogOrigin(): string | null {
    if (!isEmbeddedInFrame()) return null;
    const candidates: string[] = [];
    try {
        const ancestors = window.location.ancestorOrigins;
        if (ancestors && ancestors.length > 0) candidates.push(ancestors[ancestors.length - 1]);
    } catch {
        // ancestorOrigins isn't available in every browser.
    }
    try {
        if (document.referrer) candidates.push(new URL(document.referrer).origin);
    } catch {
        // Malformed or empty referrer.
    }
    return candidates.find(isDatadogUiOrigin) ?? null;
}

/** Fallback when not embedded (local dev): the site the app was built for. */
function siteBaseUrl(): string {
    const site = (import.meta.env.VITE_DATADOG_SITE || 'datadoghq.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
    // datadoghq.com → app.datadoghq.com; us3.datadoghq.com stays as-is.
    const host = site.split('.').length > 2 ? site : `app.${site}`;
    return `https://${host}`;
}

/**
 * Base URL for links into Datadog. Uses the org the app is embedded in, so links
 * stay in the right org whichever org or site the app is deployed to.
 */
let baseUrl: string | null = null;
function datadogBaseUrl(): string {
    baseUrl ??= embeddingDatadogOrigin() ?? siteBaseUrl();
    return baseUrl;
}

/** Only returns a link for a real, positive integer monitor id. */
export function monitorUrl(monitorId: number): string | null {
    return Number.isInteger(monitorId) && monitorId > 0 ? `${datadogBaseUrl()}/monitors/${monitorId}` : null;
}

/** Link to a downtime in the org the app runs in (the API's own `url` always points at app.datadoghq.com). */
export function downtimeUrl(downtimeId: string): string {
    return `${datadogBaseUrl()}/monitors/downtimes?id=${encodeURIComponent(downtimeId)}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
});

export function formatStart(ms: number | null): string {
    return ms === null ? 'Not set' : DATE_FORMAT.format(ms);
}

/** Open-ended or invalid end dates render as `Indefinitely` (never 1970). */
export function formatEnd(ms: number | null): string {
    return ms === null ? 'Indefinitely' : DATE_FORMAT.format(ms);
}

export function monitorStateLevel(state: string): PillLevel {
    switch (state) {
        case 'Alert':
            return 'danger';
        case 'Warn':
            return 'warning';
        case 'OK':
            return 'success';
        default:
            return 'default';
    }
}

export function maintenanceLevel(row: CoverageRow): PillLevel {
    switch (row.maintenanceState) {
        case 'Whole monitor':
            return 'in-progress';
        case 'Groups only':
            return 'warning';
        default:
            return 'default';
    }
}

export const MAINTENANCE_HINTS: Record<CoverageRow['maintenanceState'], string> = {
    'Whole monitor': 'Every group of this monitor is muted.',
    'Groups only': 'Only groups matching the downtime scope are muted.',
    'Not muting':
        'Datadog applies none of these downtimes to this monitor right now (for example, no current group matches the scope).',
};

export function windowLevel(state: WindowState): PillLevel {
    switch (state) {
        case 'Ending soon':
            return 'warning';
        case 'Stale':
            return 'danger';
        case 'Scheduled end':
            return 'success';
        default:
            return 'default';
    }
}

/** Compact duration such as `2d 4h`, `3h 12m`, `5m`, `1y 8mo`. */
export function formatDuration(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days >= 365) {
        const years = Math.floor(days / 365);
        const months = Math.floor((days % 365) / 30);
        return months ? `${years}y ${months}mo` : `${years}y`;
    }
    if (days >= 30) return `${Math.floor(days / 30)}mo ${days % 30}d`;
    if (days >= 1) return `${days}d ${hours % 24}h`;
    if (hours >= 1) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

/** `in 2d 4h` for future times, `3d 1h ago` for past ones. */
export function formatRelative(ms: number | null, nowMs: number): string | null {
    if (ms === null) return null;
    return ms >= nowMs ? `in ${formatDuration(ms - nowMs)}` : `${formatDuration(nowMs - ms)} ago`;
}

export function windowDetail(match: DowntimeMatch, state: WindowState, nowMs: number): string {
    if (match.downtime.isPlaceholder) {
        return 'Inspect to load from Datadog';
    }
    if (match.endMs !== null) {
        return `Ends ${formatRelative(match.endMs, nowMs)}`;
    }
    const running = match.startMs !== null ? formatDuration(nowMs - match.startMs) : null;
    if (state === 'Stale') {
        return `No end date · running ${running}`;
    }
    return running ? `No end date · running ${running}` : 'No end date';
}

/** Human label for what the downtime silences: the whole monitor or specific groups. */
export function mutedScopeLabel(match: DowntimeMatch): string {
    if (match.downtime.isPlaceholder) {
        return 'Some groups (scope loads on inspect)';
    }
    const scope = match.downtime.scope?.trim();
    return match.coversAllGroups || !scope || scope === '*' ? 'All groups' : scope;
}

export function matchKindLabel(match: DowntimeMatch): string {
    switch (match.kind) {
        case 'direct':
            return 'Direct (monitor ID)';
        case 'tag':
            return 'Tag-based';
        case 'scope':
            return 'Scope-based';
    }
}

export function coverageSummary(row: CoverageRow): string {
    const count = row.matches.length;
    const direct = row.matches.filter((m) => m.kind === 'direct').length;
    const indirect = count - direct;
    const parts: string[] = [];
    if (direct) parts.push(`${direct} direct`);
    if (indirect) parts.push(`${indirect} tag/scope`);
    return `${count} active ${count === 1 ? 'downtime' : 'downtimes'} (${parts.join(', ')})`;
}

export interface ExportRecord {
    monitor_id: number;
    monitor_name: string;
    monitor_url: string | null;
    maintenance_state: string;
    muted_scope: string;
    window_state: string;
    coverage_source: string;
    monitor_state: string;
    monitor_type: string;
    downtime_coverage: string;
    owner: string;
    downtime_creators: string;
    latest_downtime_message: string;
    primary_downtime_id: string;
    primary_downtime_scope: string;
    downtime_start: string;
    downtime_end: string;
    all_active_downtime_ids: string;
}

export function toExportRecords(rows: CoverageRow[]): ExportRecord[] {
    return rows.map((row) => ({
        monitor_id: row.monitor.id,
        monitor_name: row.monitor.name,
        monitor_url: monitorUrl(row.monitor.id),
        maintenance_state: row.maintenanceState,
        muted_scope: mutedScopeLabel(row.primary),
        window_state: row.windowState,
        coverage_source: row.source,
        monitor_state: row.monitor.overallState,
        monitor_type: row.monitor.type,
        downtime_coverage: coverageSummary(row),
        owner: row.owner,
        downtime_creators: row.downtimeCreators.join('; '),
        latest_downtime_message: row.latestMessage ?? '',
        primary_downtime_id: row.primary.downtime.id,
        primary_downtime_scope: row.primary.downtime.scope ?? '*',
        downtime_start: row.primary.startMs === null ? '' : new Date(row.primary.startMs).toISOString(),
        downtime_end: row.primary.endMs === null ? 'Indefinitely' : new Date(row.primary.endMs).toISOString(),
        all_active_downtime_ids: row.matches.map((m) => m.downtime.id).join('; '),
    }));
}

function csvCell(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    // Neutralize spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(records: ExportRecord[]): string {
    if (records.length === 0) {
        return '';
    }
    const headers = Object.keys(records[0]) as (keyof ExportRecord)[];
    const lines = [headers.join(',')];
    for (const record of records) {
        lines.push(headers.map((header) => csvCell(record[header])).join(','));
    }
    return lines.join('\r\n');
}

function clickDownload(doc: Document, url: string, filename: string, label: string): void {
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.textContent = label;
    doc.body.appendChild(anchor);
    anchor.click();
}

/**
 * Triggers a file download. Datadog's app iframe sandbox may not grant
 * `allow-downloads`, so when embedded we open a same-origin popup (popups are
 * allowed to escape the sandbox) and start the download from there.
 */
export function downloadFile(filename: string, content: string, mimeType: string): void {
    const popup = isEmbeddedInFrame() ? window.open('', '_blank') : null;
    const target = (popup ?? window) as typeof window;
    const blob = new target.Blob([content], { type: mimeType });
    const url = target.URL.createObjectURL(blob);

    if (popup) {
        const doc = popup.document;
        doc.title = filename;
        doc.body.style.fontFamily = 'system-ui, sans-serif';
        doc.body.style.padding = '24px';
        const heading = doc.createElement('p');
        heading.textContent = `Your export "${filename}" is downloading. You can close this tab.`;
        doc.body.appendChild(heading);
        clickDownload(doc, url, filename, `Download ${filename} again`);
    } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
}

export const PLACEHOLDER_ACTION_HINT = "Inspect this monitor first to load its downtimes from Datadog.";

/** Why a downtime can't be canceled from this app, or null if it can. */
export function cancelBlockedReason(match: DowntimeMatch): string | null {
    return match.downtime.isPlaceholder ? PLACEHOLDER_ACTION_HINT : null;
}

/** Why a downtime can't be extended from this app, or null if it can. */
export function extendBlockedReason(match: DowntimeMatch): string | null {
    if (match.downtime.isPlaceholder) {
        return PLACEHOLDER_ACTION_HINT;
    }
    if (match.downtime.isRecurring) {
        return 'Recurring downtime: edit the recurrence in Datadog.';
    }
    if (match.endMs === null) {
        return 'No end date: this downtime already runs until canceled.';
    }
    return null;
}

function rawErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return 'Unknown error';
    }
}

/** Turns API failures into messages an on-call engineer can act on. */
export function friendlyError(error: unknown, action = 'complete this action'): string {
    const message = rawErrorMessage(error);
    if (/\b403\b|forbidden|not authorized|permission/i.test(message)) {
        // Published Datadog apps run as their author (the account whose keys deployed them),
        // not as the viewer, so the fix is on that account.
        return `Datadog denied permission to ${action}. This app runs as its author (the account that deployed it), so ask a Datadog admin to grant that account the "Monitors Downtime" (monitors_downtime) permission.`;
    }
    if (/\b401\b|unauthorized|authentication/i.test(message)) {
        return 'Your Datadog session expired. Reload the page and try again.';
    }
    if (/\b429\b|too many requests/i.test(message)) {
        return 'Datadog is rate-limiting requests right now. Wait a few seconds and try again.';
    }
    if (/\b404\b|not found/i.test(message)) {
        return 'This downtime no longer exists. Refresh to see the current state.';
    }
    return message;
}
