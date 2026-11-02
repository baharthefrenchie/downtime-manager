import { useMemo } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { ClockIcon } from '@datadog/druids/icons/Clock';
import { ExternalLinkIcon } from '@datadog/druids/icons/ExternalLink';
import { TrashIcon } from '@datadog/druids/icons/Trash';
import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Table, type TableColumn } from '@datadog/druids/table/Table';
import { Text } from '@datadog/druids/typography/Text';

import { correctionStateLevel, correctionTiming, formatEnd, formatStart, sloUrl } from './format';
import type { Density } from './hooks';
import { correctionCancelBlockedReason, correctionExtendBlockedReason } from './slo';
import type { CorrectionRow } from './useSloData';

type Cell = { row: { original: CorrectionRow } };

const COLUMNS_BY_DENSITY: Record<Density, string[]> = {
    xl: ['slo', 'category', 'state', 'start', 'end', 'creator', 'monitors', 'actions'],
    wide: ['slo', 'category', 'state', 'start', 'end', 'monitors', 'actions'],
    medium: ['slo', 'state', 'end', 'actions'],
    narrow: ['slo', 'state', 'actions'],
};

interface SloCorrectionsViewProps {
    rows: CorrectionRow[];
    nowMs: number;
    density: Density;
    isLoading: boolean;
    errorMessage: string | null;
    onExtend: (row: CorrectionRow) => void;
    onCancel: (row: CorrectionRow) => void;
}

/** SLO corrections on SLOs related to the monitors in maintenance, with extend and cancel. */
export function SloCorrectionsView({ rows, nowMs, density, isLoading, errorMessage, onExtend, onCancel }: SloCorrectionsViewProps) {
    const allColumns = useMemo<Record<string, TableColumn<CorrectionRow>>>(
        () => ({
            slo: {
                id: 'slo',
                Header: 'SLO',
                accessor: (row: CorrectionRow) => row.slos[0]?.name ?? '',
                width: density === 'narrow' ? 150 : 280,
                Cell: ({ row }: Cell) => {
                    const [first, ...others] = row.original.slos;
                    const query = row.original.view.correction.sloQuery;
                    return (
                        <div className="cell-stack">
                            <Button
                                isNaked
                                hasEllipsisWithTooltip
                                isTitleCased={false}
                                href={first ? sloUrl(first.id) : undefined}
                                isExternal
                                label={first?.name ?? 'SLO'}
                            />
                            <Text size="xs" variant="tertiary" hasEllipsis title={query ?? undefined}>
                                {query ? `All SLOs matching ${query}` : first?.type ? `${first.type} SLO` : ''}
                                {others.length > 0 ? ` · +${others.length} more related` : ''}
                            </Text>
                        </div>
                    );
                },
            },
            category: {
                id: 'category',
                Header: 'Category',
                accessor: (row: CorrectionRow) => row.view.correction.category,
                width: 200,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <Text>{row.original.view.correction.category}</Text>
                        <Text size="xs" variant="tertiary" hasEllipsis title={row.original.view.correction.description ?? ''}>
                            {row.original.view.correction.description ?? 'No description'}
                        </Text>
                    </div>
                ),
            },
            state: {
                id: 'state',
                Header: 'State',
                accessor: (row: CorrectionRow) => row.view.state,
                width: density === 'narrow' ? 140 : 210,
                Cell: ({ row }: Cell) => (
                    <div className="cell-stack">
                        <StatusPill level={correctionStateLevel(row.original.view.state)}>{row.original.view.state}</StatusPill>
                        <Text size="xs" variant="tertiary" hasEllipsis>
                            {correctionTiming(row.original.view, nowMs)}
                        </Text>
                    </div>
                ),
            },
            start: {
                id: 'start',
                Header: 'Start',
                accessor: (row: CorrectionRow) => row.view.startMs ?? 0,
                width: 160,
                Cell: ({ row }: Cell) => <Text>{formatStart(row.original.view.startMs)}</Text>,
            },
            end: {
                id: 'end',
                Header: 'End',
                accessor: (row: CorrectionRow) => row.view.endMs ?? Number.MAX_SAFE_INTEGER,
                width: 160,
                Cell: ({ row }: Cell) => (
                    <Text>{row.original.view.state === 'Recurring' ? 'Repeats' : formatEnd(row.original.view.endMs)}</Text>
                ),
            },
            creator: {
                id: 'creator',
                Header: 'Created by',
                accessor: (row: CorrectionRow) => row.view.correction.creator ?? '',
                width: 160,
                Cell: ({ row }: Cell) => <Text hasEllipsis>{row.original.view.correction.creator ?? 'Unknown'}</Text>,
            },
            monitors: {
                id: 'monitors',
                Header: 'Muted monitors',
                accessor: (row: CorrectionRow) => row.monitorIds.length,
                width: 120,
                Cell: ({ row }: Cell) => <Text>{row.original.monitorIds.length}</Text>,
            },
            actions: {
                id: 'actions',
                Header: '',
                disableSortBy: true,
                width: 110,
                Cell: ({ row }: Cell) => {
                    const extendBlocked = correctionExtendBlockedReason(row.original.view);
                    const cancelBlocked = correctionCancelBlockedReason(row.original.view);
                    const first = row.original.slos[0];
                    return (
                        <div className="row-actions">
                            {first && density !== 'narrow' && (
                                <Button
                                    size="sm"
                                    isBorderless
                                    icon={ExternalLinkIcon}
                                    href={sloUrl(first.id)}
                                    isExternal
                                    ariaLabel="Open SLO in Datadog"
                                    tooltip="Open SLO in Datadog"
                                />
                            )}
                            <Button
                                size="sm"
                                isBorderless
                                icon={ClockIcon}
                                ariaLabel="Extend correction"
                                tooltip={extendBlocked ?? 'Extend correction'}
                                isDisabled={Boolean(extendBlocked)}
                                onClick={() => onExtend(row.original)}
                            />
                            <Button
                                size="sm"
                                isBorderless
                                level="danger"
                                icon={TrashIcon}
                                ariaLabel="Cancel correction"
                                tooltip={
                                    cancelBlocked ??
                                    (row.original.view.state === 'Scheduled' ? 'Delete scheduled correction' : 'End correction now')
                                }
                                isDisabled={Boolean(cancelBlocked)}
                                onClick={() => onCancel(row.original)}
                            />
                        </div>
                    );
                },
            },
        }),
        [density, nowMs, onExtend, onCancel],
    );
    const columns = useMemo(() => COLUMNS_BY_DENSITY[density].map((id) => allColumns[id]), [allColumns, density]);

    return (
        <Table<CorrectionRow>
            key={density}
            aria-label="SLO corrections"
            data={rows}
            columns={columns}
            getRowId={(row: CorrectionRow) => row.view.correction.id}
            isLoading={isLoading}
            stickyHeaders
            isBorderless
            size="sm"
            sorting
            emptyState={{
                title: 'No current SLO corrections',
                subtitle:
                    'None of the SLOs related to these monitors has an active, scheduled or recurring correction.',
            }}
            errorState={{
                isShown: Boolean(errorMessage),
                title: 'Unable to load SLOs and corrections',
                subtitle: errorMessage ?? undefined,
            }}
        />
    );
}
