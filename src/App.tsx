import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { Checkbox } from '@datadog/druids/form/Checkbox';
import { Select } from '@datadog/druids/form/Select';
import { SoftToggle } from '@datadog/druids/form/SoftToggle';
import { DownloadIcon } from '@datadog/druids/icons/Download';
import { RefreshIcon } from '@datadog/druids/icons/Refresh';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Table } from '@datadog/druids/table/Table';
import { Text } from '@datadog/druids/typography/Text';

import datadogLogo from './assets/datadog-logo.png';
import { readCache, writeCache } from './cache';
import {
    buildCoverageRows,
    type DatadogDowntimeMatch,
    type CoverageRow,
    type DowntimeMatch,
    type LiveSnapshot,
    type MaintenanceState,
    type WindowState,
} from './coverage';
import { downloadFile, formatEnd, formatRelative, friendlyError, toCsv, toExportRecords } from './format';
import { useDensity, useUrlFilters } from './hooks';
import { useMonitorColumns } from './monitorColumns';
import { RowMenu } from './RowMenu';
import { SummaryTiles, type SummaryTile } from './SummaryTiles';
import { useCreatorNames } from './useCreatorNames';
import type { CorrectionTarget } from './DowntimeModals';
import { linkedCorrectionLabel, type LinkedCorrectionsState } from './linkedCorrections';
import { downtimeRelatedSlos, linkedCorrections } from './slo';
import { cancelSloCorrection, extendSloCorrection } from './slo.backend';
import { SearchBar } from './SearchBar';
import { parseQuery, rowMatchesQuery, rowMatchesTemplateVariables, templateVariableFilters } from './search';
import { useDatadogAppInput } from '@datadog/apps-frontend/inputs/react';
import { datadogDashboard } from '@datadog/apps-frontend/inputs/schema';
import { SloCorrectionsView } from './SloCorrectionsView';
import { correctionRowsFor, SLO_QUERY_KEY, useSloData, type CorrectionRow } from './useSloData';
import {
    cancelActiveDowntime,
    extendActiveDowntime,
    loadMaintenanceSnapshot,
    loadMutedMonitors,
} from './maintenance.backend';

// Loaded on first use (and prefetched once the table is on screen) to keep the
// initial bundle small: nobody needs these to see which monitors are muted.
const loadLazyParts = () => import('./LazyParts');
const loadDateFilter = () => import('./DateFilter');
const DetailPanel = lazy(() => loadLazyParts().then((m) => ({ default: m.DetailPanel })));
const CancelDowntimeModal = lazy(() => loadLazyParts().then((m) => ({ default: m.CancelDowntimeModal })));
const ExtendDowntimeModal = lazy(() => loadLazyParts().then((m) => ({ default: m.ExtendDowntimeModal })));
const ExtendCorrectionModal = lazy(() => loadLazyParts().then((m) => ({ default: m.ExtendCorrectionModal })));
const CancelCorrectionModal = lazy(() => loadLazyParts().then((m) => ({ default: m.CancelCorrectionModal })));
const DateFilter = lazy(() => loadDateFilter().then((m) => ({ default: m.DateFilter })));

const DEFAULT_PAGE_SIZE = 25;
const SLO_CORRECTIONS_PERMISSION = '"SLOs Corrections" (slos_corrections)';
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

const SNAPSHOT_QUERY_KEY = ['maintenance-snapshot'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 5 * 60_000;
const ON_DEMAND_MATCHES_MAX_AGE_MS = 30 * 60_000;
const SNAPSHOT_CACHE_MAX_AGE_MS = 6 * 60 * 60_000;

type Option<T extends string> = { label: string; value: T };
type MaintenanceFilter = 'all' | MaintenanceState;
type WindowFilter = 'all' | WindowState;
type ActionTarget = { row: CoverageRow; match: DowntimeMatch };
/** The quick filter a summary tile applies. */
const ALERTING_QUERY = 'status:Alert';
type Toast = {
    level: 'success' | 'warning' | 'danger';
    title: string;
    message: string;
    /** Per-item results, for example each linked SLO correction. */
    details?: string[];
};
/** What happened to one linked SLO correction after its downtime changed. */
type CorrectionOutcome = { label: string; ok: boolean; detail: string };

const MAINTENANCE_OPTIONS: Option<MaintenanceFilter>[] = [
    { label: 'All', value: 'all' },
    { label: 'Whole monitor', value: 'Whole monitor' },
    { label: 'Some groups', value: 'Groups only' },
    { label: 'Not muting', value: 'Not muting' },
];

const WINDOW_OPTIONS: Option<WindowFilter>[] = [
    { label: 'Any end time', value: 'all' },
    { label: 'Ends within 24h', value: 'Ending soon' },
    { label: 'Ends later', value: 'Scheduled end' },
    { label: 'No end (recent)', value: 'Open-ended' },
    { label: 'No end for 30+ days', value: 'Stale' },
];

function isOneOf<T extends string>(value: string, options: Option<T>[]): value is T {
    return options.some((option) => option.value === value);
}

function App() {
    const queryClient = useQueryClient();
    const { ref: rootRef, density } = useDensity<HTMLDivElement>();
    const [filters, setFilters] = useUrlFilters();

    // Last-known data from this browser paints instantly; live data replaces it moments later.
    const [mountedAt] = useState(() => Date.now());
    const [cachedSnapshot] = useState(() => readCache<LiveSnapshot>('snapshot', SNAPSHOT_CACHE_MAX_AGE_MS));

    const snapshotQuery = useQuery({
        queryKey: SNAPSHOT_QUERY_KEY,
        queryFn: () => loadMaintenanceSnapshot(),
        initialData: cachedSnapshot?.value,
        initialDataUpdatedAt: cachedSnapshot?.savedAt,
        refetchInterval: REFRESH_MS,
        refetchOnWindowFocus: true,
        staleTime: 60_000,
    });
    // The fast first look for a first visit: the muted monitors in about a second, shown
    // while the full snapshot (whose downtime list takes several seconds) is loading.
    const previewQuery = useQuery({
        queryKey: ['muted-monitors-preview'],
        queryFn: () => loadMutedMonitors(),
        enabled: !snapshotQuery.data,
        staleTime: Infinity,
        retry: false,
    });
    const liveSnapshot = snapshotQuery.data;
    const isPreview = !liveSnapshot && Boolean(previewQuery.data);
    const snapshot = liveSnapshot ?? previewQuery.data;
    const dataUpdatedAt = liveSnapshot ? snapshotQuery.dataUpdatedAt : previewQuery.dataUpdatedAt;
    const isShowingSavedData = Boolean(cachedSnapshot) && dataUpdatedAt === cachedSnapshot?.savedAt;
    useEffect(() => {
        if (liveSnapshot && !isShowingSavedData) writeCache('snapshot', liveSnapshot, dataUpdatedAt);
    }, [liveSnapshot, dataUpdatedAt, isShowingSavedData]);


    // "Active" is evaluated against the moment the snapshot arrived.
    const baseRows = useMemo(
        () => (snapshot ? buildCoverageRows(snapshot, dataUpdatedAt) : []),
        [snapshot, dataUpdatedAt],
    );

    // Confirm scoped and tag/scope-based coverage with Datadog's own matcher (throttled, cached).
    // Downtimes Datadog applies to monitors whose downtime isn't in the downtime list (e.g. host
    // auto-mutes). Loaded on demand when such a monitor is inspected, cached per browser.
    const [verified, setVerified] = useState<Record<string, DatadogDowntimeMatch[]>>(
        () => readCache<Record<string, DatadogDowntimeMatch[]>>('datadog-matches-on-demand', ON_DEMAND_MATCHES_MAX_AGE_MS)?.value ?? {},
    );
    const onDatadogMatchesLoaded = useCallback((monitorId: number, matches: DatadogDowntimeMatch[]) => {
        setVerified((previous) => {
            const next = { ...previous, [String(monitorId)]: matches };
            writeCache('datadog-matches-on-demand', next);
            return next;
        });
    }, []);

    // Creator names: cached per browser, only missing ids are looked up (in batches),
    // the open monitor's first, then in table order.
    const creatorIds = useMemo(() => {
        const ids = new Set<string>();
        const add = (row: CoverageRow) => row.matches.forEach((m) => m.downtime.createdById && ids.add(m.downtime.createdById));
        const open = filters.monitor === null ? undefined : baseRows.find((row) => row.monitor.id === filters.monitor);
        if (open) add(open);
        baseRows.forEach(add);
        return [...ids];
    }, [baseRows, filters.monitor]);
    // Names for the rows at the top of the table resolve first.
    const { users, unknownIds } = useCreatorNames(creatorIds);

    const rows = useMemo(
        () => (snapshot ? buildCoverageRows(snapshot, dataUpdatedAt, users, verified, unknownIds) : []),
        [snapshot, dataUpdatedAt, users, verified, unknownIds],
    );

    // SLOs related to these monitors and their corrections (loaded in parallel, cached).
    const sloData = useSloData(rows, dataUpdatedAt, filters.strictSloMatch ? 'strict' : 'scope');
    const { relatedByMonitor, correctionsBySlo } = sloData;

    // ---- Filters (mirrored into the URL for shareable links) ----
    const maintenanceFilter: MaintenanceFilter = isOneOf(filters.state, MAINTENANCE_OPTIONS) ? filters.state : 'all';
    const windowFilter: WindowFilter = isOneOf(filters.window, WINDOW_OPTIONS) ? filters.window : 'all';
    const isDateFilterEnabled = filters.from !== null && filters.to !== null;
    const [defaultRange] = useState(() => ({ start: Date.now() - 7 * DAY_MS, end: Date.now() }));
    const rangeStart = isDateFilterEnabled ? (filters.from as number) : defaultRange.start;
    const rangeEnd = isDateFilterEnabled ? (filters.to as number) : defaultRange.end;

    const ownerOptions = useMemo(() => {
        const names = new Set<string>();
        rows.forEach((row) => {
            names.add(row.owner);
            row.downtimeCreators.forEach((creator) => names.add(creator));
        });
        return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ label: name, value: name }));
    }, [rows]);

    const parsedQuery = useMemo(() => parseQuery(filters.q), [filters.q]);

    // When embedded in a dashboard, its template variables filter monitors by tag
    // (prefix:value), like dashboard widgets. Outside a dashboard the input is
    // unavailable and nothing changes.
    const dashboardInput = useDatadogAppInput(datadogDashboard);
    const dashboardVariables = dashboardInput.status === 'ready' ? dashboardInput.fields.dashboard.templateVariables : undefined;
    const dashboardFilters = useMemo(() => templateVariableFilters(dashboardVariables), [dashboardVariables]);
    const activeDashboardFilters = useMemo(
        () => (filters.ignoreDashboardVariables ? [] : dashboardFilters),
        [filters.ignoreDashboardVariables, dashboardFilters],
    );
    const onQueryChange = useCallback((q: string) => setFilters({ q }), [setFilters]);

    const filteredRows = useMemo(
        () =>
            rows.filter((row) => {
                if (!rowMatchesQuery(row, parsedQuery)) return false;
                if (!rowMatchesTemplateVariables(row, activeDashboardFilters)) return false;
                if (
                    filters.owners.length > 0 &&
                    !filters.owners.includes(row.owner) &&
                    !row.downtimeCreators.some((creator) => filters.owners.includes(creator))
                ) {
                    return false;
                }
                if (maintenanceFilter !== 'all' && row.maintenanceState !== maintenanceFilter) return false;
                if (windowFilter !== 'all' && row.windowState !== windowFilter) return false;
                if (filters.withSlos && !relatedByMonitor.has(row.monitor.id)) return false;
                if (
                    isDateFilterEnabled &&
                    !row.matches.some((m) => m.startMs !== null && m.startMs >= rangeStart && m.startMs <= rangeEnd)
                ) {
                    return false;
                }
                return true;
            }),
        [
            rows,
            parsedQuery,
            activeDashboardFilters,
            filters.owners,
            filters.withSlos,
            relatedByMonitor,
            maintenanceFilter,
            windowFilter,
            isDateFilterEnabled,
            rangeStart,
            rangeEnd,
        ],
    );

    // Summary tiles count across every row (they are filters themselves). Monitors count when
    // they're actually muted, matching Datadog's own "muted" count.
    const summary = useMemo(() => {
        const downtimeIds = new Set<string>();
        const sloIds = new Set<string>();
        let monitors = 0;
        let alerting = 0;
        let endingSoon = 0;
        let stale = 0;
        rows.forEach((row) => {
            if (row.maintenanceState === 'Not muting') return;
            monitors += 1;
            if (/^alert$/i.test(row.monitor.overallState)) alerting += 1;
            if (row.windowState === 'Ending soon') endingSoon += 1;
            if (row.windowState === 'Stale') stale += 1;
            row.matches.forEach((m) => {
                if (!m.downtime.isPlaceholder) downtimeIds.add(m.downtime.id);
            });
            relatedByMonitor.get(row.monitor.id)?.forEach(({ slo }) => sloIds.add(slo.id));
        });
        return { monitors, alerting, endingSoon, stale, downtimes: downtimeIds.size, slos: sloIds.size };
    }, [rows, relatedByMonitor]);

    // Current SLO corrections on SLOs related to the filtered monitors.
    const correctionRows = useMemo(
        () => correctionRowsFor(filteredRows, relatedByMonitor, correctionsBySlo),
        [filteredRows, relatedByMonitor, correctionsBySlo],
    );
    const activeCorrections = useMemo(
        () => correctionRowsFor(rows, relatedByMonitor, correctionsBySlo).filter((row) => row.view.state === 'Active').length,
        [rows, relatedByMonitor, correctionsBySlo],
    );

    // Prefetch the lazily loaded panel, dialogs and date picker once data is on screen,
    // so the first click doesn't wait on a download.
    const hasData = Boolean(snapshot);
    useEffect(() => {
        if (!hasData) return;
        void loadLazyParts();
        void loadDateFilter();
    }, [hasData]);

    // ---- Detail panel (selected monitor lives in the URL as ?monitor=) ----
    const detailRow = useMemo(
        () => (filters.monitor === null ? null : (rows.find((row) => row.monitor.id === filters.monitor) ?? null)),
        [rows, filters.monitor],
    );
    const openDetail = useCallback((row: CoverageRow) => setFilters({ monitor: row.monitor.id }), [setFilters]);
    const closeDetail = useCallback(() => setFilters({ monitor: null }), [setFilters]);

    // ---- Cancel / extend ----
    const [cancelTarget, setCancelTarget] = useState<ActionTarget | null>(null);
    const [extendTarget, setExtendTarget] = useState<ActionTarget | null>(null);
    const [toast, setToast] = useState<Toast | null>(null);
    // Small screens fold the filters away behind a button.
    const [showFilters, setShowFilters] = useState(false);

    useEffect(() => {
        if (!toast) return undefined;
        // Results with per-item details (or failures) stay up longer.
        const timer = window.setTimeout(() => setToast(null), toast.details?.length || toast.level !== 'success' ? 20000 : 6000);
        return () => window.clearTimeout(timer);
    }, [toast]);

    const refreshAfterChange = async (downtimeId: string) => {
        await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
        await queryClient.invalidateQueries({ queryKey: ['downtime-detail', downtimeId] });
        await queryClient.invalidateQueries({ queryKey: ['datadog-matches'] });
    };

    const [correctionExtendTarget, setCorrectionExtendTarget] = useState<CorrectionTarget | null>(null);
    const [correctionCancelTarget, setCorrectionCancelTarget] = useState<CorrectionTarget | null>(null);
    const refreshSlos = () => queryClient.invalidateQueries({ queryKey: SLO_QUERY_KEY });

    // SLO corrections that change together with a downtime (one-time, overlapping it, on its related SLOs).
    const sloMatchMode = filters.strictSloMatch ? 'strict' : 'scope';
    const linkedFor = useCallback(
        (match: DowntimeMatch): LinkedCorrectionsState => {
            if (sloData.context) {
                const slos = downtimeRelatedSlos(match.downtime.id, rows, sloData.context.slos, sloMatchMode);
                return {
                    status: 'ready',
                    corrections: linkedCorrections(
                        { startMs: match.startMs, endMs: match.endMs, monitorTags: match.downtime.monitorTags },
                        slos,
                        sloData.context.slos,
                        sloData.context.corrections,
                        dataUpdatedAt,
                    ),
                };
            }
            if (sloData.error) {
                return { status: 'error', message: friendlyError(sloData.error, 'read SLOs', '"SLOs Read" (slos_read)') };
            }
            return { status: 'loading' };
        },
        [sloData.context, sloData.error, rows, sloMatchMode, dataUpdatedAt],
    );
    const correctionLabels = (match: DowntimeMatch) => {
        const state = linkedFor(match);
        const labels = new Map<string, string>();
        if (state.status === 'ready') {
            state.corrections.linked.forEach((item) => labels.set(item.view.correction.id, linkedCorrectionLabel(item)));
        }
        return labels;
    };

    /** Runs each correction change in turn, after the downtime; one failing doesn't stop the others. */
    const runCorrections = async (
        correctionIds: string[],
        labels: Map<string, string>,
        change: (correctionId: string) => Promise<string>,
    ): Promise<CorrectionOutcome[]> => {
        const outcomes: CorrectionOutcome[] = [];
        for (const correctionId of correctionIds) {
            const label = labels.get(correctionId) ?? `SLO correction ${correctionId}`;
            try {
                outcomes.push({ label, ok: true, detail: await change(correctionId) });
            } catch (error) {
                outcomes.push({ label, ok: false, detail: friendlyError(error, 'edit SLO corrections', SLO_CORRECTIONS_PERMISSION) });
            }
        }
        return outcomes;
    };
    const reportOutcomes = (title: string, message: string, outcomes: CorrectionOutcome[]) => {
        const failed = outcomes.filter((o) => !o.ok).length;
        setToast({
            level: failed ? 'warning' : 'success',
            title: failed ? `${title}; ${failed} of ${outcomes.length} SLO correction${outcomes.length === 1 ? '' : 's'} failed` : title,
            message: failed ? `${message} The downtime change was kept.` : message,
            details: outcomes.map((o) => `${o.ok ? '✓' : '✗'} ${o.label}: ${o.detail}`),
        });
    };

    const cancelMutation = useMutation({
        mutationFn: async ({ match, correctionIds }: { match: DowntimeMatch; correctionIds: string[] }) => {
            const labels = correctionLabels(match);
            // The downtime first: if it fails, no correction is touched.
            const result = await cancelActiveDowntime(match.downtime.id);
            const outcomes = await runCorrections(correctionIds, labels, async (id) => {
                const { action } = await cancelSloCorrection(id);
                return action === 'deleted' ? "deleted (it hadn't started)" : 'ended now';
            });
            return { ...result, outcomes };
        },
        onSuccess: async ({ canceledId, changedBy, outcomes }) => {
            reportOutcomes(
                'Downtime canceled',
                `Downtime ${canceledId} was canceled. Its message records it as cancelled by ${changedBy}.`,
                outcomes,
            );
            setCancelTarget(null);
            await refreshAfterChange(canceledId);
            if (outcomes.length) await refreshSlos();
        },
        onError: (error) =>
            setToast({ level: 'danger', title: 'Cancel failed', message: friendlyError(error, 'cancel downtimes') }),
    });

    const extendMutation = useMutation({
        mutationFn: async ({ match, newEndIso, correctionIds }: { match: DowntimeMatch; newEndIso: string; correctionIds: string[] }) => {
            const labels = correctionLabels(match);
            const result = await extendActiveDowntime(match.downtime.id, newEndIso);
            const outcomes = await runCorrections(correctionIds, labels, async (id) => {
                const { end } = await extendSloCorrection(id, result.end);
                return `extended to ${formatEnd(Date.parse(end))}`;
            });
            return { ...result, outcomes };
        },
        onSuccess: async ({ downtimeId, end, changedBy, outcomes }) => {
            reportOutcomes(
                'Downtime extended',
                `Downtime ${downtimeId} now ends ${formatEnd(Date.parse(end))}. Its message records it as extended by ${changedBy}.`,
                outcomes,
            );
            setExtendTarget(null);
            await refreshAfterChange(downtimeId);
            if (outcomes.length) await refreshSlos();
        },
        onError: (error) =>
            setToast({ level: 'danger', title: 'Extend failed', message: friendlyError(error, 'extend downtimes') }),
    });

    const resetCancel = cancelMutation.reset;
    const resetExtend = extendMutation.reset;
    const openCancel = useCallback(
        (row: CoverageRow, match: DowntimeMatch) => {
            resetCancel();
            setCancelTarget({ row, match });
        },
        [resetCancel],
    );
    const openExtend = useCallback(
        (row: CoverageRow, match: DowntimeMatch) => {
            resetExtend();
            setExtendTarget({ row, match });
        },
        [resetExtend],
    );

    // ---- SLO corrections: extend / cancel ----

    const extendCorrectionMutation = useMutation({
        mutationFn: ({ correctionId, newEndIso }: { correctionId: string; newEndIso: string }) =>
            extendSloCorrection(correctionId, newEndIso),
        onSuccess: async ({ end }) => {
            setToast({ level: 'success', title: 'SLO correction extended', message: `It now ends ${formatEnd(Date.parse(end))}.` });
            setCorrectionExtendTarget(null);
            await refreshSlos();
        },
        onError: (error) =>
            setToast({ level: 'danger', title: 'Extend failed', message: friendlyError(error, 'edit SLO corrections', SLO_CORRECTIONS_PERMISSION) }),
    });
    const cancelCorrectionMutation = useMutation({
        mutationFn: (correctionId: string) => cancelSloCorrection(correctionId),
        onSuccess: async ({ action }) => {
            setToast({
                level: 'success',
                title: action === 'deleted' ? 'SLO correction deleted' : 'SLO correction ended',
                message:
                    action === 'deleted'
                        ? 'The scheduled correction was deleted before it started.'
                        : 'The correction now ends at this moment; time already excluded stays excluded.',
            });
            setCorrectionCancelTarget(null);
            await refreshSlos();
        },
        onError: (error) =>
            setToast({ level: 'danger', title: 'Cancel failed', message: friendlyError(error, 'edit SLO corrections', SLO_CORRECTIONS_PERMISSION) }),
    });
    const resetExtendCorrection = extendCorrectionMutation.reset;
    const resetCancelCorrection = cancelCorrectionMutation.reset;
    const openExtendCorrection = useCallback(
        (target: CorrectionTarget) => {
            resetExtendCorrection();
            setCorrectionExtendTarget(target);
        },
        [resetExtendCorrection],
    );
    const openCancelCorrection = useCallback(
        (target: CorrectionTarget) => {
            resetCancelCorrection();
            setCorrectionCancelTarget(target);
        },
        [resetCancelCorrection],
    );
    const correctionTargetOf = (row: CorrectionRow): CorrectionTarget => ({
        view: row.view,
        sloName: row.slos[0]?.name ?? 'SLO',
    });

    // ---- Table ----
    const columns = useMonitorColumns({
        density,
        nowMs: dataUpdatedAt,
        relatedByMonitor,
        correctionsBySlo,
        isSloLoading: sloData.isLoading,
        onOpen: openDetail,
        onExtend: openExtend,
        onCancel: openCancel,
    });
    // Clicking anywhere on a row opens its side panel.
    const rowActions = useCallback(
        (row: { original: CoverageRow }) => ({ onClick: () => openDetail(row.original), 'aria-label': `Show details for ${row.original.monitor.name}` }),
        [openDetail],
    );

    // ---- Export ----
    const exportStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
    const relatedSloNames = () =>
        new Map([...relatedByMonitor].map(([monitorId, related]) => [monitorId, related.map(({ slo }) => slo.name)]));
    const exportCsv = () =>
        downloadFile(`maintenance-coverage-${exportStamp()}.csv`, toCsv(toExportRecords(filteredRows, relatedSloNames())), 'text/csv;charset=utf-8');
    const exportJson = () =>
        downloadFile(
            `maintenance-coverage-${exportStamp()}.json`,
            JSON.stringify(toExportRecords(filteredRows, relatedSloNames()), null, 2),
            'application/json',
        );

    const isNarrow = density === 'narrow';
    const isCompact = density === 'narrow' || density === 'medium';
    const hasFilters =
        filters.q.trim() !== '' ||
        filters.owners.length > 0 ||
        maintenanceFilter !== 'all' ||
        windowFilter !== 'all' ||
        isDateFilterEnabled ||
        filters.withSlos;
    const activeFilterCount =
        (filters.q.trim() ? 1 : 0) +
        (filters.owners.length > 0 ? 1 : 0) +
        (maintenanceFilter !== 'all' ? 1 : 0) +
        (windowFilter !== 'all' ? 1 : 0) +
        (isDateFilterEnabled ? 1 : 0) +
        (filters.withSlos ? 1 : 0);
    const clearFilters = () =>
        setFilters({ q: '', state: 'all', window: 'all', owners: [], from: null, to: null, withSlos: false });

    const statusText = isPreview
        ? 'Loading downtimes…'
        : isShowingSavedData && snapshotQuery.isFetching
          ? `Saved ${formatRelative(dataUpdatedAt, mountedAt) ?? ''} · updating…`
          : snapshotQuery.isFetching
            ? 'Updating…'
            : dataUpdatedAt > 0
              ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : '';

    const isQuery = (q: string) => filters.q.trim().toLowerCase() === q.toLowerCase();
    const showMonitors = (changes: Parameters<typeof setFilters>[0]) => setFilters({ view: 'monitors', ...changes });
    const tiles: SummaryTile[] = [
        {
            key: 'muted',
            label: 'Muted monitors',
            value: snapshot ? summary.monitors : null,
            hint: isPreview ? 'Loading downtimes…' : `${summary.downtimes.toLocaleString()} active downtimes`,
            isActive: filters.view === 'monitors' && !hasFilters,
            actionLabel: 'Show every muted monitor',
            onClick: () => {
                clearFilters();
                setFilters({ view: 'monitors' });
            },
        },
        {
            key: 'alerting',
            label: 'Muted while alerting',
            value: snapshot ? summary.alerting : null,
            hint: 'Alerts that page nobody',
            tone: 'danger',
            isActive: filters.view === 'monitors' && isQuery(ALERTING_QUERY),
            actionLabel: 'Show muted monitors that are alerting',
            onClick: () => showMonitors({ q: isQuery(ALERTING_QUERY) ? '' : ALERTING_QUERY }),
        },
        {
            key: 'ending',
            label: 'Ending within 24h',
            value: liveSnapshot ? summary.endingSoon : null,
            hint: 'Extend them if work is ongoing',
            tone: 'warning',
            isActive: filters.view === 'monitors' && windowFilter === 'Ending soon',
            actionLabel: 'Show downtimes ending within 24 hours',
            onClick: () => showMonitors({ window: windowFilter === 'Ending soon' ? 'all' : 'Ending soon' }),
        },
        {
            key: 'stale',
            label: 'No end for 30+ days',
            value: liveSnapshot ? summary.stale : null,
            hint: 'Possibly forgotten',
            tone: 'warning',
            isActive: filters.view === 'monitors' && windowFilter === 'Stale',
            actionLabel: 'Show downtimes with no end that started over 30 days ago',
            onClick: () => showMonitors({ window: windowFilter === 'Stale' ? 'all' : 'Stale' }),
        },
        {
            key: 'corrections',
            label: 'Active SLO corrections',
            value: sloData.isLoading ? null : activeCorrections,
            hint: sloData.isLoading ? 'Loading SLOs…' : `${summary.slos.toLocaleString()} related SLOs`,
            isActive: filters.view === 'corrections',
            actionLabel: 'Show SLO corrections on related SLOs',
            onClick: () => setFilters({ view: filters.view === 'corrections' ? 'monitors' : 'corrections' }),
        },
    ];

    return (
        <div ref={rootRef} className={`app app--${density}`}>
            {toast && (
                <div className="toast" role="status" aria-live="polite">
                    <MessageBox level={toast.level} title={toast.title} isDismissible onDismiss={() => setToast(null)}>
                        {toast.message}
                        {toast.details && toast.details.length > 0 && (
                            <ul className="toast-details">
                                {toast.details.map((line, index) => (
                                    <li key={index}>{line}</li>
                                ))}
                            </ul>
                        )}
                    </MessageBox>
                </div>
            )}

            <header className="header">
                <img src={datadogLogo} alt="" className="header-logo" />
                <div className="header-copy">
                    <Text as="h1" size={isNarrow ? 'md' : 'lg'} weight="bold" hasEllipsis>
                        On-Call Maintenance Downtime Manager
                    </Text>
                    {!isCompact && (
                        <Text as="p" size="sm" variant="secondary" hasEllipsis>
                            Monitors muted by active downtimes right now, and the SLOs they affect.
                        </Text>
                    )}
                </div>
                <div className="header-meta">
                    {!isNarrow && (
                        <Text size="xs" variant="tertiary" hasEllipsis title={dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toLocaleString() : undefined}>
                            {statusText}
                        </Text>
                    )}
                    <RowMenu
                        label="Export"
                        handle={
                            <Button
                                size="sm"
                                icon={DownloadIcon}
                                label={isCompact ? undefined : 'Export'}
                                ariaLabel="Export the filtered rows"
                                isDisabled={filteredRows.length === 0}
                            />
                        }
                        items={[
                            { label: `CSV (${filteredRows.length} rows)`, onSelect: exportCsv },
                            { label: `JSON (${filteredRows.length} rows)`, onSelect: exportJson },
                        ]}
                    />
                    <Button
                        size="sm"
                        icon={RefreshIcon}
                        label={isCompact ? undefined : 'Refresh'}
                        ariaLabel="Refresh live data"
                        tooltip={isCompact ? 'Refresh live data' : undefined}
                        isLoading={snapshotQuery.isFetching}
                        onClick={() => void snapshotQuery.refetch()}
                    />
                </div>
            </header>

            <SummaryTiles tiles={tiles} isCompact={isNarrow} />

            <section className="surface toolbar" aria-label="Filters">
                <div className="toolbar-search">
                    <SearchBar value={filters.q} rows={rows} onChange={onQueryChange} />
                    {isNarrow && (
                        <Button
                            size="sm"
                            label={activeFilterCount > (filters.q.trim() ? 1 : 0) ? `Filters (${activeFilterCount - (filters.q.trim() ? 1 : 0)})` : 'Filters'}
                            isActive={showFilters}
                            onClick={() => setShowFilters((value) => !value)}
                        />
                    )}
                </div>
                {dashboardFilters.length > 0 && (
                    <div className="dashboard-filters" aria-label="Dashboard template variables">
                        <Text size="xs" variant="secondary" weight="bold">
                            From dashboard:
                        </Text>
                        {dashboardFilters.map((filter) => (
                            <StatusPill
                                key={`${filter.name}-${filter.key}`}
                                isSoft
                                level={filters.ignoreDashboardVariables ? 'default' : 'in-progress'}
                                title={`Template variable $${filter.name}`}
                            >
                                {`${filter.key}:${filter.values.join(' OR ')}`}
                            </StatusPill>
                        ))}
                        <Checkbox
                            label="Ignore dashboard variables"
                            isChecked={filters.ignoreDashboardVariables}
                            onChange={(event) => setFilters({ ignoreDashboardVariables: event.target.checked })}
                        />
                    </div>
                )}
                {(!isNarrow || showFilters) && (
                <div className="toolbar-group">
                    {isNarrow ? (
                        <Select
                            size="sm"
                            minWidth="150px"
                            options={MAINTENANCE_OPTIONS.map((o) => (o.value === 'all' ? { ...o, label: 'Anything muted' } : o))}
                            value={maintenanceFilter}
                            onChange={(option: Option<MaintenanceFilter>) => setFilters({ state: option.value })}
                        />
                    ) : (
                        <SoftToggle
                            ariaLabel="What is muted"
                            options={MAINTENANCE_OPTIONS}
                            value={maintenanceFilter}
                            onChange={(value) => setFilters({ state: value })}
                        />
                    )}
                    <Select
                        size="sm"
                        minWidth={isNarrow ? '150px' : '180px'}
                        options={WINDOW_OPTIONS}
                        value={windowFilter}
                        onChange={(option: Option<WindowFilter>) => setFilters({ window: option.value })}
                    />
                    <Select
                        size="sm"
                        multi
                        clearable
                        minWidth="180px"
                        maxWidth="360px"
                        placeholder="Downtime created by anyone"
                        options={ownerOptions}
                        value={filters.owners}
                        onChange={(options: Option<string>[] | Option<string> | null) =>
                            setFilters({
                                owners: (Array.isArray(options) ? options : options ? [options] : []).map((o) => o.value),
                            })
                        }
                    />
                    <Checkbox
                        label="Has SLOs"
                        isChecked={filters.withSlos}
                        onChange={(event) => setFilters({ withSlos: event.target.checked })}
                    />
                    <Checkbox
                        label="Started between…"
                        isChecked={isDateFilterEnabled}
                        onChange={(event) =>
                            setFilters(
                                event.target.checked
                                    ? { from: defaultRange.start, to: defaultRange.end }
                                    : { from: null, to: null },
                            )
                        }
                    />
                    {isDateFilterEnabled && (
                        <Suspense fallback={null}>
                            <DateFilter
                                start={rangeStart}
                                end={rangeEnd}
                                onChange={(range) => setFilters({ from: range.start, to: range.end })}
                            />
                        </Suspense>
                    )}
                    {hasFilters && <Button size="sm" isNaked label="Clear filters" onClick={clearFilters} />}
                </div>
                )}
            </section>

            <section className="surface table-section" aria-label={filters.view === 'corrections' ? 'SLO corrections' : 'Muted monitors'}>
                <div className="table-heading">
                    <SoftToggle
                        ariaLabel="View"
                        options={[
                            { label: `Monitors (${filteredRows.length})`, value: 'monitors' },
                            { label: `SLO corrections (${correctionRows.length})`, value: 'corrections' },
                        ]}
                        value={filters.view}
                        onChange={(value) => setFilters({ view: value as 'monitors' | 'corrections' })}
                    />
                    <div className="table-heading-meta">
                        {filters.view === 'corrections' && (
                            <Checkbox
                                label={isNarrow ? 'Strict matching' : 'Strict SLO matching'}
                                isChecked={filters.strictSloMatch}
                                onChange={(event) => setFilters({ strictSloMatch: event.target.checked })}
                                title="Off: an SLO is related when it carries the downtime's group scope (for example project:gen2). On: it must carry every monitor tag and every scope term of the downtime."
                            />
                        )}
                        {!isNarrow && filters.view === 'monitors' && filteredRows.length !== rows.length && (
                            <Text size="sm" variant="secondary">
                                Showing {filteredRows.length} of {rows.length}
                            </Text>
                        )}
                    </div>
                </div>
                <div className="table-scroll">
                    {filters.view === 'corrections' ? (
                        <SloCorrectionsView
                            rows={correctionRows}
                            nowMs={dataUpdatedAt}
                            density={density}
                            isLoading={sloData.isLoading}
                            errorMessage={sloData.error ? friendlyError(sloData.error, 'read SLOs', '"SLOs Read" (slos_read)') : null}
                            onExtend={(row) => openExtendCorrection(correctionTargetOf(row))}
                            onCancel={(row) => openCancelCorrection(correctionTargetOf(row))}
                        />
                    ) : (
                    <Table<CoverageRow>
                        key={density}
                        aria-label="Muted monitors"
                        data={filteredRows}
                        columns={columns}
                        getRowId={(row: CoverageRow) => String(row.monitor.id)}
                        rowActions={rowActions}
                        isLoading={!snapshot && (snapshotQuery.isLoading || previewQuery.isLoading)}
                        stickyHeaders
                        isBorderless
                        size="sm"
                        sorting
                        pagination={{
                            pageSize: DEFAULT_PAGE_SIZE,
                            pageSizeOptions: PAGE_SIZE_OPTIONS,
                            hasPageSizeSelector: !isNarrow,
                        }}
                        emptyState={{
                            title:
                                rows.length === 0
                                    ? 'No monitors are in maintenance'
                                    : filters.q.trim()
                                      ? `No monitors match "${filters.q.trim()}"`
                                      : 'No monitors match these filters',
                            subtitle:
                                rows.length === 0
                                    ? 'No active downtime mutes a monitor in this org right now.'
                                    : 'Clear the filters to see every muted monitor.',
                        }}
                        errorState={{
                            isShown: snapshotQuery.isError,
                            title: "Couldn't load monitors and downtimes",
                            subtitle: snapshotQuery.isError ? friendlyError(snapshotQuery.error, 'read monitors') : undefined,
                        }}
                    />
                    )}
                </div>
            </section>

            <Suspense fallback={null}>
                {detailRow && (
                    <DetailPanel
                        key={`detail-${detailRow.monitor.id}`}
                        row={detailRow}
                        nowMs={dataUpdatedAt}
                        density={density}
                        onClose={closeDetail}
                        onCancel={openCancel}
                        onExtend={openExtend}
                        onDatadogMatchesLoaded={onDatadogMatchesLoaded}
                        relatedSlos={sloData.isLoading ? undefined : (relatedByMonitor.get(detailRow.monitor.id) ?? [])}
                        correctionsBySlo={correctionsBySlo}
                        onExtendCorrection={openExtendCorrection}
                        onCancelCorrection={openCancelCorrection}
                    />
                )}
                {cancelTarget && (
                    <CancelDowntimeModal
                        key={`cancel-${cancelTarget.match.downtime.id}`}
                        target={cancelTarget}
                        linked={linkedFor(cancelTarget.match)}
                        nowMs={dataUpdatedAt}
                        isPending={cancelMutation.isPending}
                        error={cancelMutation.error ? friendlyError(cancelMutation.error, 'cancel downtimes') : null}
                        onClose={() => setCancelTarget(null)}
                        onConfirm={(_downtimeId, correctionIds) =>
                            cancelMutation.mutate({ match: cancelTarget.match, correctionIds })
                        }
                    />
                )}
                {extendTarget && (
                    <ExtendDowntimeModal
                        key={`extend-${extendTarget.match.downtime.id}`}
                        target={extendTarget}
                        linked={linkedFor(extendTarget.match)}
                        nowMs={dataUpdatedAt}
                        isPending={extendMutation.isPending}
                        error={extendMutation.error ? friendlyError(extendMutation.error, 'extend downtimes') : null}
                        onClose={() => setExtendTarget(null)}
                        onConfirm={(_downtimeId, newEndIso, correctionIds) =>
                            extendMutation.mutate({ match: extendTarget.match, newEndIso, correctionIds })
                        }
                    />
                )}
                {correctionExtendTarget && (
                    <ExtendCorrectionModal
                        key={`extend-correction-${correctionExtendTarget.view.correction.id}`}
                        target={correctionExtendTarget}
                        nowMs={dataUpdatedAt}
                        isPending={extendCorrectionMutation.isPending}
                        error={
                            extendCorrectionMutation.error
                                ? friendlyError(extendCorrectionMutation.error, 'edit SLO corrections', SLO_CORRECTIONS_PERMISSION)
                                : null
                        }
                        onClose={() => setCorrectionExtendTarget(null)}
                        onConfirm={(correctionId, newEndIso) => extendCorrectionMutation.mutate({ correctionId, newEndIso })}
                    />
                )}
                {correctionCancelTarget && (
                    <CancelCorrectionModal
                        target={correctionCancelTarget}
                        isPending={cancelCorrectionMutation.isPending}
                        error={
                            cancelCorrectionMutation.error
                                ? friendlyError(cancelCorrectionMutation.error, 'edit SLO corrections', SLO_CORRECTIONS_PERMISSION)
                                : null
                        }
                        onClose={() => setCorrectionCancelTarget(null)}
                        onConfirm={(correctionId) => cancelCorrectionMutation.mutate(correctionId)}
                    />
                )}
            </Suspense>
        </div>
    );
}

export default App;
