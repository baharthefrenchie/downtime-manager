import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { Checkbox } from '@datadog/druids/form/Checkbox';
import { Select } from '@datadog/druids/form/Select';
import { SoftToggle } from '@datadog/druids/form/SoftToggle';
import { ClockIcon } from '@datadog/druids/icons/Clock';
import { DownloadIcon } from '@datadog/druids/icons/Download';
import { ExternalLinkIcon } from '@datadog/druids/icons/ExternalLink';
import { EyeIcon } from '@datadog/druids/icons/Eye';
import { RefreshIcon } from '@datadog/druids/icons/Refresh';
import { TrashIcon } from '@datadog/druids/icons/Trash';
import { Grid } from '@datadog/druids/layout/Grid';
import { CalloutValue } from '@datadog/druids/measures/CalloutValue';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Table, type TableColumn } from '@datadog/druids/table/Table';
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
import {
    coverageSummary,
    cancelBlockedReason,
    downloadFile,
    extendBlockedReason,
    formatEnd,
    formatRelative,
    formatStart,
    friendlyError,
    MAINTENANCE_HINTS,
    maintenanceLevel,
    monitorStateLevel,
    monitorUrl,
    mutedScopeLabel,
    toCsv,
    toExportRecords,
    windowDetail,
    windowLevel,
} from './format';
import { useDensity, useUrlFilters, type Density } from './hooks';
import { useCreatorNames } from './useCreatorNames';
import type { CorrectionTarget } from './DowntimeModals';
import { cancelSloCorrection, extendSloCorrection } from './slo.backend';
import { SearchBar } from './SearchBar';
import { parseQuery, rowMatchesQuery } from './search';
import { SloCorrectionsView } from './SloCorrectionsView';
import { correctionRowsFor, SLO_QUERY_KEY, useSloData, type CorrectionRow } from './useSloData';
import {
    cancelActiveDowntime,
    extendActiveDowntime,
    loadMaintenanceSnapshot,
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
type Toast = { level: 'success' | 'danger'; title: string; message: string };
type Cell = { row: { original: CoverageRow } };

const MAINTENANCE_OPTIONS: Option<MaintenanceFilter>[] = [
    { label: 'All', value: 'all' },
    { label: 'Whole monitor', value: 'Whole monitor' },
    { label: 'Groups only', value: 'Groups only' },
    { label: 'Not muting', value: 'Not muting' },
];

const WINDOW_OPTIONS: Option<WindowFilter>[] = [
    { label: 'Any window', value: 'all' },
    { label: 'Ending soon (< 24h)', value: 'Ending soon' },
    { label: 'Has a scheduled end', value: 'Scheduled end' },
    { label: 'Open-ended (recent)', value: 'Open-ended' },
    { label: 'Stale (open-ended > 30d)', value: 'Stale' },
];

/** Columns shown at each layout density, in display order. */
const COLUMNS_BY_DENSITY: Record<Density, string[]> = {
    xl: ['monitor', 'monitorState', 'maintenanceState', 'source', 'window', 'slos', 'owner', 'message', 'start', 'end', 'actions'],
    wide: ['monitor', 'monitorState', 'maintenanceState', 'source', 'window', 'slos', 'owner', 'actions'],
    medium: ['monitor', 'monitorState', 'status', 'end', 'actions'],
    narrow: ['monitor', 'status', 'actions'],
};

const MONITOR_COLUMN_WIDTH: Record<Density, number> = { xl: 300, wide: 280, medium: 260, narrow: 140 };

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
    const { data: snapshot, dataUpdatedAt } = snapshotQuery;
    const isShowingSavedData = Boolean(cachedSnapshot) && dataUpdatedAt === cachedSnapshot?.savedAt;
    useEffect(() => {
        if (snapshot && !isShowingSavedData) writeCache('snapshot', snapshot, dataUpdatedAt);
    }, [snapshot, dataUpdatedAt, isShowingSavedData]);


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

    // Creator names: cached per browser, only missing ids are looked up (in batches).
    const creatorIds = useMemo(() => {
        const ids = new Set<string>();
        baseRows.forEach((row) => row.matches.forEach((m) => m.downtime.createdById && ids.add(m.downtime.createdById)));
        return [...ids];
    }, [baseRows]);
    // Names for the rows at the top of the table resolve first.
    const { users, resolvingIds } = useCreatorNames(creatorIds);

    const rows = useMemo(
        () => (snapshot ? buildCoverageRows(snapshot, dataUpdatedAt, users, verified, resolvingIds) : []),
        [snapshot, dataUpdatedAt, users, verified, resolvingIds],
    );

    // SLOs related to these monitors and their corrections (loaded in parallel, cached).
    const sloData = useSloData(rows, dataUpdatedAt);
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
    const onQueryChange = useCallback((q: string) => setFilters({ q }), [setFilters]);

    const filteredRows = useMemo(
        () =>
            rows.filter((row) => {
                if (!rowMatchesQuery(row, parsedQuery)) return false;
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

    // Cards count monitors that are actually muted, matching Datadog's own "muted" count;
    // "Not muting" rows stay in the table but aren't counted.
    const summary = useMemo(() => {
        const downtimeIds = new Set<string>();
        const owners = new Set<string>();
        const sloIds = new Set<string>();
        let monitors = 0;
        filteredRows.forEach((row) => {
            if (row.maintenanceState === 'Not muting') return;
            monitors += 1;
            row.matches.forEach((m) => {
                if (!m.downtime.isPlaceholder) downtimeIds.add(m.downtime.id);
            });
            owners.add(row.owner);
            relatedByMonitor.get(row.monitor.id)?.forEach(({ slo }) => sloIds.add(slo.id));
        });
        return { monitors, downtimes: downtimeIds.size, owners: owners.size, slos: sloIds.size };
    }, [filteredRows, relatedByMonitor]);

    // Current SLO corrections on SLOs related to the filtered monitors.
    const correctionRows = useMemo(
        () => correctionRowsFor(filteredRows, relatedByMonitor, correctionsBySlo),
        [filteredRows, relatedByMonitor, correctionsBySlo],
    );
    const activeCorrections = correctionRows.filter((row) => row.view.state === 'Active').length;

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

    useEffect(() => {
        if (!toast) return undefined;
        const timer = window.setTimeout(() => setToast(null), 6000);
        return () => window.clearTimeout(timer);
    }, [toast]);

    const refreshAfterChange = async (downtimeId: string) => {
        await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
        await queryClient.invalidateQueries({ queryKey: ['downtime-detail', downtimeId] });
        await queryClient.invalidateQueries({ queryKey: ['datadog-matches'] });
    };

    const cancelMutation = useMutation({
        mutationFn: (downtimeId: string) => cancelActiveDowntime(downtimeId),
        onSuccess: async ({ canceledId }) => {
            setToast({ level: 'success', title: 'Downtime canceled', message: `Downtime ${canceledId} was canceled.` });
            setCancelTarget(null);
            await refreshAfterChange(canceledId);
        },
        onError: (error) =>
            setToast({ level: 'danger', title: 'Cancel failed', message: friendlyError(error, 'cancel downtimes') }),
    });

    const extendMutation = useMutation({
        mutationFn: ({ downtimeId, newEndIso }: { downtimeId: string; newEndIso: string }) =>
            extendActiveDowntime(downtimeId, newEndIso),
        onSuccess: async ({ downtimeId, end }) => {
            setToast({
                level: 'success',
                title: 'Downtime extended',
                message: `Downtime ${downtimeId} now ends ${formatEnd(Date.parse(end))}.`,
            });
            setExtendTarget(null);
            await refreshAfterChange(downtimeId);
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
    const [correctionExtendTarget, setCorrectionExtendTarget] = useState<CorrectionTarget | null>(null);
    const [correctionCancelTarget, setCorrectionCancelTarget] = useState<CorrectionTarget | null>(null);
    const refreshSlos = () => queryClient.invalidateQueries({ queryKey: SLO_QUERY_KEY });

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
    const allColumns = useMemo<Record<string, TableColumn<CoverageRow>>>(
        () => ({
            monitor: {
                id: 'monitor',
                Header: 'Monitor',
                accessor: (row: CoverageRow) => row.monitor.name,
                width: MONITOR_COLUMN_WIDTH[density],
                Cell: ({ row }: Cell) => {
                    const { monitor } = row.original;
                    return (
                        <div className="cell-stack">
                            <Button
                                isNaked
                                hasEllipsisWithTooltip
                                label={monitor.name}
                                ariaLabel={`Show downtime details for ${monitor.name}`}
                                onClick={() => openDetail(row.original)}
                            />
                            <Text size="xs" variant="tertiary" hasEllipsis>
                                ID {monitor.id} · {monitor.type}
                            </Text>
                        </div>
                    );
                },
            },
            monitorState: {
                id: 'monitorState',
                Header: 'Monitor State',
                accessor: (row: CoverageRow) => row.monitor.overallState,
                width: 120,
                Cell: ({ row }: Cell) => (
                    <StatusPill level={monitorStateLevel(row.original.monitor.overallState)}>
                        {row.original.monitor.overallState}
                    </StatusPill>
                ),
            },
            maintenanceState: {
                id: 'maintenanceState',
                Header: 'Maintenance State',
                accessor: (row: CoverageRow) => row.maintenanceState,
                width: 190,
                Cell: ({ row }: Cell) => {
                    const scope = mutedScopeLabel(row.original.primary);
                    return (
                        <div className="cell-stack">
                            <StatusPill
                                level={maintenanceLevel(row.original)}
                                title={MAINTENANCE_HINTS[row.original.maintenanceState]}
                            >
                                {row.original.maintenanceState}
                            </StatusPill>
                            <Text size="xs" variant="tertiary" isMonospace hasEllipsis title={scope}>
                                {scope}
                            </Text>
                        </div>
                    );
                },
            },
            // Narrow layouts combine maintenance state and window into one column.
            status: {
                id: 'status',
                Header: 'Status',
                accessor: (row: CoverageRow) => row.maintenanceState,
                width: density === 'narrow' ? 130 : 170,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <StatusPill
                            level={maintenanceLevel(row.original)}
                            title={MAINTENANCE_HINTS[row.original.maintenanceState]}
                        >
                            {row.original.maintenanceState}
                        </StatusPill>
                        <StatusPill isSoft level={windowLevel(row.original.windowState)}>
                            {row.original.windowState}
                        </StatusPill>
                    </div>
                ),
            },
            source: {
                id: 'source',
                Header: 'Coverage Source',
                accessor: (row: CoverageRow) => row.source,
                width: 180,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <StatusPill isSoft level={row.original.source === 'Tag/Scope-based' ? 'default' : 'success'}>
                            {row.original.source}
                        </StatusPill>
                        <Text size="xs" variant="tertiary" hasEllipsis title={row.original.primary.reason}>
                            {coverageSummary(row.original)}
                        </Text>
                    </div>
                ),
            },
            window: {
                id: 'window',
                Header: 'Window',
                accessor: (row: CoverageRow) => row.windowState,
                width: 170,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <StatusPill level={windowLevel(row.original.windowState)}>{row.original.windowState}</StatusPill>
                        <Text size="xs" variant="tertiary" hasEllipsis>
                            {windowDetail(row.original.primary, row.original.windowState, dataUpdatedAt)}
                        </Text>
                    </div>
                ),
            },
            slos: {
                id: 'slos',
                Header: 'Related SLOs',
                accessor: (row: CoverageRow) => relatedByMonitor.get(row.monitor.id)?.length ?? 0,
                width: 150,
                Cell: ({ row }: Cell) => {
                    const related = relatedByMonitor.get(row.original.monitor.id) ?? [];
                    if (related.length === 0) {
                        return (
                            <Text size="sm" variant="tertiary">
                                {sloData.isLoading ? 'Loading…' : '—'}
                            </Text>
                        );
                    }
                    const corrections = related.flatMap(({ slo }) => correctionsBySlo.get(slo.id) ?? []);
                    const active = corrections.filter((view) => view.state === 'Active').length;
                    return (
                        <div className="cell-stack">
                            <Button
                                isNaked
                                isTitleCased={false}
                                label={`${related.length} ${related.length === 1 ? 'SLO' : 'SLOs'}`}
                                ariaLabel={`Show related SLOs for ${row.original.monitor.name}`}
                                onClick={() => openDetail(row.original)}
                            />
                            <Text size="xs" variant="tertiary" hasEllipsis>
                                {corrections.length === 0
                                    ? 'No current corrections'
                                    : `${corrections.length} correction${corrections.length === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}`}
                            </Text>
                        </div>
                    );
                },
            },
            owner: {
                id: 'owner',
                Header: 'Owner',
                accessor: (row: CoverageRow) => row.owner,
                width: 160,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <Text hasEllipsis title={row.original.owner}>
                            {row.original.owner}
                        </Text>
                        <Text size="xs" variant="tertiary" hasEllipsis title={row.original.downtimeCreators.join(', ')}>
                            Downtime by {row.original.downtimeCreators.join(', ')}
                        </Text>
                    </div>
                ),
            },
            message: {
                id: 'message',
                Header: 'Latest Downtime Message',
                accessor: (row: CoverageRow) => row.latestMessage ?? '',
                width: 220,
                Cell: ({ row }: Cell) => (
                    <Text
                        hasEllipsis
                        title={row.original.latestMessage ?? ''}
                        variant={row.original.latestMessage ? 'default' : 'tertiary'}
                    >
                        {row.original.latestMessage ?? 'No message'}
                    </Text>
                ),
            },
            start: {
                id: 'start',
                Header: 'Downtime Start',
                accessor: (row: CoverageRow) => row.primary.startMs ?? 0,
                width: 160,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <Text>{formatStart(row.original.primary.startMs)}</Text>
                        <Text size="xs" variant="tertiary">
                            {formatRelative(row.original.primary.startMs, dataUpdatedAt) ?? ''}
                        </Text>
                    </div>
                ),
            },
            end: {
                id: 'end',
                Header: 'Downtime End',
                accessor: (row: CoverageRow) => row.primary.endMs ?? Number.MAX_SAFE_INTEGER,
                width: 160,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <Text variant={row.original.primary.endMs === null ? 'warning' : 'default'}>
                            {formatEnd(row.original.primary.endMs)}
                        </Text>
                        <Text size="xs" variant="tertiary">
                            {formatRelative(row.original.primary.endMs, dataUpdatedAt) ?? 'Runs until canceled'}
                        </Text>
                    </div>
                ),
            },
            actions: {
                id: 'actions',
                Header: '',
                disableSortBy: true,
                width: density === 'narrow' ? 100 : 132,
                Cell: ({ row }: Cell) => {
                    const { primary, monitor } = row.original;
                    const extendBlocked = extendBlockedReason(primary);
                    const url = monitorUrl(monitor.id);
                    return (
                        <div className="row-actions">
                            <Button
                                size="sm"
                                isBorderless
                                icon={EyeIcon}
                                ariaLabel="Inspect downtime"
                                tooltip="Inspect downtime"
                                onClick={() => openDetail(row.original)}
                            />
                            {url && density !== 'narrow' && (
                                <Button
                                    size="sm"
                                    isBorderless
                                    icon={ExternalLinkIcon}
                                    href={url}
                                    isExternal
                                    ariaLabel="Open monitor in Datadog"
                                    tooltip="Open monitor in Datadog"
                                />
                            )}
                            <Button
                                size="sm"
                                isBorderless
                                icon={ClockIcon}
                                ariaLabel="Extend downtime"
                                tooltip={extendBlocked ?? 'Extend downtime'}
                                isDisabled={Boolean(extendBlocked)}
                                onClick={() => openExtend(row.original, primary)}
                            />
                            <Button
                                size="sm"
                                isBorderless
                                level="danger"
                                icon={TrashIcon}
                                ariaLabel="Cancel downtime"
                                tooltip={cancelBlockedReason(primary) ?? 'Cancel downtime'}
                                isDisabled={Boolean(cancelBlockedReason(primary))}
                                onClick={() => openCancel(row.original, primary)}
                            />
                        </div>
                    );
                },
            },
        }),
        [density, dataUpdatedAt, openDetail, openCancel, openExtend, relatedByMonitor, correctionsBySlo, sloData.isLoading],
    );
    // Column widths are relative weights (DRUIDS lays columns out as `fr`), so each density
    // shows only the columns that fit and the table always fills the container width.
    const columns = useMemo(() => COLUMNS_BY_DENSITY[density].map((id) => allColumns[id]), [allColumns, density]);

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

    return (
        <div ref={rootRef} className={`app app--${density}`}>
            {toast && (
                <div className="toast" role="status" aria-live="polite">
                    <MessageBox level={toast.level} title={toast.title} isDismissible onDismiss={() => setToast(null)}>
                        {toast.message}
                    </MessageBox>
                </div>
            )}

            <header className="surface header">
                <img src={datadogLogo} alt="Datadog" className="header-logo" />
                <div className="header-copy">
                    <Text as="h1" size={isNarrow ? 'md' : 'lg'} weight="bold" hasEllipsis>
                        On-Call Maintenance Downtime Manager
                    </Text>
                    {!isNarrow && (
                        <Text as="p" size="sm" variant="secondary">
                            Monitors muted right now by active downtimes — directly by monitor ID or by tags and scope,
                            for the whole monitor or only some groups — and the SLOs they affect. Inspect, extend, or
                            cancel downtimes and SLO corrections safely.
                        </Text>
                    )}
                </div>
                <div className="header-meta">
                    {isShowingSavedData && snapshotQuery.isFetching ? (
                        <StatusPill isSoft level="in-progress" title="Showing your last saved data while live data loads">
                            {isCompact ? 'Updating' : `Saved ${formatRelative(dataUpdatedAt, mountedAt) ?? ''} · updating`}
                        </StatusPill>
                    ) : (
                        !isCompact &&
                        dataUpdatedAt > 0 && (
                            <Text size="xs" variant="tertiary">
                                Live · updated {new Date(dataUpdatedAt).toLocaleTimeString()}
                            </Text>
                        )
                    )}
                    <Button
                        size="sm"
                        icon={DownloadIcon}
                        label={isCompact ? undefined : 'CSV'}
                        ariaLabel="Export CSV"
                        tooltip="Export the filtered rows as CSV"
                        isDisabled={filteredRows.length === 0}
                        onClick={exportCsv}
                    />
                    <Button
                        size="sm"
                        icon={DownloadIcon}
                        label={isCompact ? undefined : 'JSON'}
                        ariaLabel="Export JSON"
                        tooltip="Export the filtered rows as JSON"
                        isDisabled={filteredRows.length === 0}
                        onClick={exportJson}
                    />
                    <Button
                        size="sm"
                        icon={RefreshIcon}
                        label={isNarrow ? undefined : 'Refresh'}
                        ariaLabel="Refresh live data"
                        tooltip={isNarrow ? 'Refresh live data' : undefined}
                        isLoading={snapshotQuery.isFetching}
                        onClick={() => void snapshotQuery.refetch()}
                    />
                </div>
            </header>

            <Grid minWidth={isNarrow ? 96 : 180} gap="sm" isFullWidth className="summary">
                <CalloutValue
                    className="surface"
                    size={isNarrow ? 'sm' : 'md'}
                    label={isNarrow ? 'Muted' : 'Monitors in Maintenance'}
                    value={summary.monitors}
                    isLoading={snapshotQuery.isLoading}
                />
                <CalloutValue
                    className="surface"
                    size={isNarrow ? 'sm' : 'md'}
                    label={isNarrow ? 'Downtimes' : 'Downtime Windows'}
                    value={summary.downtimes}
                    isLoading={snapshotQuery.isLoading}
                />
                <CalloutValue
                    className="surface"
                    size={isNarrow ? 'sm' : 'md'}
                    label={isNarrow ? 'Owners' : 'Owners in Scope'}
                    value={summary.owners}
                    isLoading={snapshotQuery.isLoading}
                />
                <CalloutValue
                    className="surface"
                    size={isNarrow ? 'sm' : 'md'}
                    label={isNarrow ? 'SLOs' : 'Related SLOs'}
                    value={summary.slos}
                    additionalText={activeCorrections > 0 ? `${activeCorrections} active correction${activeCorrections === 1 ? '' : 's'}` : undefined}
                    isLoading={snapshotQuery.isLoading || sloData.isLoading}
                />
            </Grid>

            <section className="surface toolbar" aria-label="Filters">
                <SearchBar value={filters.q} rows={rows} onChange={onQueryChange} />
                <div className="toolbar-group">
                    {isNarrow ? (
                        <Select
                            size="sm"
                            minWidth="150px"
                            options={MAINTENANCE_OPTIONS.map((o) => (o.value === 'all' ? { ...o, label: 'Any state' } : o))}
                            value={maintenanceFilter}
                            onChange={(option: Option<MaintenanceFilter>) => setFilters({ state: option.value })}
                        />
                    ) : (
                        <SoftToggle
                            ariaLabel="Maintenance state"
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
                        placeholder="All Creators"
                        options={ownerOptions}
                        value={filters.owners}
                        onChange={(options: Option<string>[] | Option<string> | null) =>
                            setFilters({
                                owners: (Array.isArray(options) ? options : options ? [options] : []).map((o) => o.value),
                            })
                        }
                    />
                    <Checkbox
                        label="With related SLOs"
                        isChecked={filters.withSlos}
                        onChange={(event) => setFilters({ withSlos: event.target.checked })}
                    />
                    <Checkbox
                        label="Start date"
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
                    {hasFilters && (
                        <Button
                            size="sm"
                            isNaked
                            label="Clear filters"
                            onClick={() =>
                                setFilters({
                                    q: '',
                                    state: 'all',
                                    window: 'all',
                                    owners: [],
                                    from: null,
                                    to: null,
                                    withSlos: false,
                                })
                            }
                        />
                    )}
                </div>
            </section>

            <section className="surface table-section" aria-label="Maintenance Monitor Coverage">
                <div className="table-heading">
                    <Text as="h2" size="md" weight="bold">
                        {filters.view === 'corrections' ? 'SLO Corrections' : 'Maintenance Monitor Coverage'}
                    </Text>
                    <div className="table-heading-meta">
                        <SoftToggle
                            ariaLabel="View"
                            options={[
                                { label: isNarrow ? 'Monitors' : `Monitors (${filteredRows.length})`, value: 'monitors' },
                                { label: isNarrow ? 'SLO corrections' : `SLO corrections (${correctionRows.length})`, value: 'corrections' },
                            ]}
                            value={filters.view}
                            onChange={(value) => setFilters({ view: value as 'monitors' | 'corrections' })}
                        />
                        {!isNarrow && filters.view === 'monitors' && (
                            <Text size="sm" variant="secondary">
                                {filteredRows.length} of {rows.length} monitors
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
                        aria-label="Maintenance Monitor Coverage"
                        data={filteredRows}
                        columns={columns}
                        getRowId={(row: CoverageRow) => String(row.monitor.id)}
                        isLoading={snapshotQuery.isLoading}
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
                                    ? 'No validated active downtime currently covers a monitor in this org.'
                                    : 'Clear the filters to see every covered monitor.',
                        }}
                        errorState={{
                            isShown: snapshotQuery.isError,
                            title: 'Unable to load live monitors and downtimes',
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
                        target={cancelTarget}
                        isPending={cancelMutation.isPending}
                        error={cancelMutation.error ? friendlyError(cancelMutation.error, 'cancel downtimes') : null}
                        onClose={() => setCancelTarget(null)}
                        onConfirm={(downtimeId) => cancelMutation.mutate(downtimeId)}
                    />
                )}
                {extendTarget && (
                    <ExtendDowntimeModal
                        key={`extend-${extendTarget.match.downtime.id}`}
                        target={extendTarget}
                        nowMs={dataUpdatedAt}
                        isPending={extendMutation.isPending}
                        error={extendMutation.error ? friendlyError(extendMutation.error, 'extend downtimes') : null}
                        onClose={() => setExtendTarget(null)}
                        onConfirm={(downtimeId, newEndIso) => extendMutation.mutate({ downtimeId, newEndIso })}
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
