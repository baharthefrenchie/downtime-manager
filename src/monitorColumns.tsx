import { useMemo } from 'react';

import { StatusPill } from '@datadog/druids/pills/StatusPill';
import type { TableColumn } from '@datadog/druids/table/Table';
import { Text } from '@datadog/druids/typography/Text';

import type { CoverageRow, DowntimeMatch } from './coverage';
import {
    cancelBlockedReason,
    downtimeSetBy,
    downtimeUrl,
    endsLabel,
    extendBlockedReason,
    MAINTENANCE_HINTS,
    monitorStateLevel,
    monitorUrl,
    mutedLabel,
} from './format';
import type { Density } from './hooks';
import { RowMenu, type RowMenuItem } from './RowMenu';
import type { CorrectionView, RelatedSlo } from './slo';

type Cell = { row: { original: CoverageRow } };

/** Columns shown at each layout density, in display order. */
const COLUMNS_BY_DENSITY: Record<Density, string[]> = {
    xl: ['monitor', 'monitorState', 'muted', 'ends', 'slos', 'owner', 'message', 'actions'],
    wide: ['monitor', 'monitorState', 'muted', 'ends', 'slos', 'owner', 'actions'],
    medium: ['monitor', 'monitorState', 'muted', 'ends', 'actions'],
    narrow: ['monitor', 'ends', 'actions'],
};

interface MonitorColumnsOptions {
    density: Density;
    nowMs: number;
    relatedByMonitor: Map<number, RelatedSlo[]>;
    correctionsBySlo: Map<string, CorrectionView[]>;
    isSloLoading: boolean;
    onOpen: (row: CoverageRow) => void;
    onExtend: (row: CoverageRow, match: DowntimeMatch) => void;
    onCancel: (row: CoverageRow, match: DowntimeMatch) => void;
}

/** The monitor table's columns: one quiet line of facts per row, color only where it needs attention. */
export function useMonitorColumns({
    density,
    nowMs,
    relatedByMonitor,
    correctionsBySlo,
    isSloLoading,
    onOpen,
    onExtend,
    onCancel,
}: MonitorColumnsOptions): TableColumn<CoverageRow>[] {
    return useMemo(() => {
        const isNarrow = density === 'narrow';
        const all: Record<string, TableColumn<CoverageRow>> = {
            monitor: {
                id: 'monitor',
                Header: 'Monitor',
                accessor: (row: CoverageRow) => row.monitor.name,
                width: isNarrow ? 160 : 300,
                Cell: ({ row }: Cell) => {
                    const { monitor } = row.original;
                    return (
                        <div className="cell-stack">
                            <Text hasEllipsis title={`${monitor.name}\nID ${monitor.id} · ${monitor.type}`}>
                                {monitor.name}
                            </Text>
                            {isNarrow && (
                                <StatusPill isSoft level={monitorStateLevel(monitor.overallState)}>
                                    {monitor.overallState}
                                </StatusPill>
                            )}
                        </div>
                    );
                },
            },
            monitorState: {
                id: 'monitorState',
                Header: 'State',
                accessor: (row: CoverageRow) => row.monitor.overallState,
                width: 90,
                Cell: ({ row }: Cell) => (
                    <StatusPill level={monitorStateLevel(row.original.monitor.overallState)}>
                        {row.original.monitor.overallState}
                    </StatusPill>
                ),
            },
            muted: {
                id: 'muted',
                Header: 'Muted',
                // Sorts by what is muted; the cell also shows how.
                accessor: (row: CoverageRow) => `${row.maintenanceState} ${mutedLabel(row).what}`,
                width: 220,
                Cell: ({ row }: Cell) => {
                    const { what, isScope, how } = mutedLabel(row.original);
                    const notMuting = row.original.maintenanceState === 'Not muting';
                    return (
                        <div className="cell-stack">
                            {notMuting ? (
                                <StatusPill isSoft level="warning" title={MAINTENANCE_HINTS['Not muting']}>
                                    Not muting
                                </StatusPill>
                            ) : (
                                <Text
                                    size="sm"
                                    isMonospace={isScope}
                                    variant={row.original.primary.downtime.isLoading ? 'tertiary' : 'default'}
                                    hasEllipsis
                                    title={MAINTENANCE_HINTS[row.original.maintenanceState]}
                                >
                                    {what}
                                </Text>
                            )}
                            {(how || notMuting) && (
                                <Text size="xs" variant="tertiary" hasEllipsis title={row.original.primary.reason}>
                                    {notMuting ? `${what} · ${how}` : how}
                                </Text>
                            )}
                        </div>
                    );
                },
            },
            ends: {
                id: 'ends',
                Header: 'Ends',
                accessor: (row: CoverageRow) => row.primary.endMs ?? Number.MAX_SAFE_INTEGER,
                width: isNarrow ? 110 : 150,
                Cell: ({ row }: Cell) => {
                    const { text, title, tone } = endsLabel(row.original.primary, nowMs);
                    return (
                        <Text size="sm" variant={tone} title={title} hasEllipsis>
                            {text}
                        </Text>
                    );
                },
            },
            slos: {
                id: 'slos',
                Header: 'SLOs',
                accessor: (row: CoverageRow) => relatedByMonitor.get(row.monitor.id)?.length ?? 0,
                width: 130,
                Cell: ({ row }: Cell) => {
                    const related = relatedByMonitor.get(row.original.monitor.id) ?? [];
                    if (related.length === 0) {
                        return (
                            <Text size="sm" variant="tertiary">
                                {isSloLoading ? 'Loading…' : '—'}
                            </Text>
                        );
                    }
                    const corrections = related.flatMap(({ slo }) => correctionsBySlo.get(slo.id) ?? []);
                    const active = corrections.filter((view) => view.state === 'Active').length;
                    return (
                        <div className="cell-stack">
                            <Text size="sm">{`${related.length} ${related.length === 1 ? 'SLO' : 'SLOs'}`}</Text>
                            {corrections.length > 0 && (
                                <Text size="xs" variant="tertiary" hasEllipsis>
                                    {active > 0
                                        ? `${active} active correction${active === 1 ? '' : 's'}`
                                        : `${corrections.length} correction${corrections.length === 1 ? '' : 's'}`}
                                </Text>
                            )}
                        </div>
                    );
                },
            },
            owner: {
                id: 'owner',
                Header: 'Owner',
                // Includes the downtime creators so the cell redraws when their names resolve.
                accessor: (row: CoverageRow) => `${row.owner} ${row.downtimeCreators.join(',')}`,
                width: 170,
                Cell: ({ row }: Cell) => {
                    const setBy = downtimeSetBy(row.original);
                    return (
                        <div className="cell-stack">
                            <Text size="sm" hasEllipsis title={row.original.owner}>
                                {row.original.owner}
                            </Text>
                            {setBy && (
                                <Text size="xs" variant="tertiary" hasEllipsis title={setBy}>
                                    {setBy}
                                </Text>
                            )}
                        </div>
                    );
                },
            },
            message: {
                id: 'message',
                Header: 'Message',
                accessor: (row: CoverageRow) => row.latestMessage ?? '',
                width: 220,
                Cell: ({ row }: Cell) => (
                    <Text size="sm" hasEllipsis title={row.original.latestMessage ?? ''} variant={row.original.latestMessage ? 'default' : 'tertiary'}>
                        {row.original.latestMessage ?? '—'}
                    </Text>
                ),
            },
            actions: {
                id: 'actions',
                Header: '',
                disableSortBy: true,
                width: 48,
                Cell: ({ row }: Cell) => {
                    const { primary, monitor } = row.original;
                    const url = monitorUrl(monitor.id);
                    const hasDowntime = !primary.downtime.isPlaceholder;
                    const items: RowMenuItem[] = [
                        { label: 'View details', onSelect: () => onOpen(row.original) },
                        ...(url ? [{ label: 'Open monitor in Datadog', href: url }] : []),
                        ...(hasDowntime ? [{ label: 'Open downtime in Datadog', href: downtimeUrl(primary.downtime.id) }] : []),
                        {
                            label: 'Extend downtime…',
                            onSelect: () => onExtend(row.original, primary),
                            disabledReason: extendBlockedReason(primary),
                            hasSeparatorTop: true,
                        },
                        {
                            label: 'Cancel downtime…',
                            level: 'danger',
                            onSelect: () => onCancel(row.original, primary),
                            disabledReason: cancelBlockedReason(primary),
                        },
                    ];
                    return <RowMenu label={`Actions for ${monitor.name}`} items={items} />;
                },
            },
        };
        return COLUMNS_BY_DENSITY[density].map((id) => all[id]);
    }, [density, nowMs, relatedByMonitor, correctionsBySlo, isSloLoading, onOpen, onExtend, onCancel]);
}
