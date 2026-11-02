import { useMemo } from 'react';

import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Table, type TableColumn } from '@datadog/druids/table/Table';
import { Text } from '@datadog/druids/typography/Text';

import { correctionStateLevel, correctionTiming, formatEnd, formatStart, sloTypeLabel, sloUrl } from './format';
import type { Density } from './hooks';
import { RowMenu } from './RowMenu';
import { correctionCancelBlockedReason, correctionExtendBlockedReason } from './slo';
import type { CorrectionRow } from './useSloData';

type Cell = { row: { original: CorrectionRow } };

const COLUMNS_BY_DENSITY: Record<Density, string[]> = {
    xl: ['slo', 'category', 'state', 'when', 'creator', 'monitors', 'actions'],
    wide: ['slo', 'category', 'state', 'when', 'monitors', 'actions'],
    medium: ['slo', 'state', 'when', 'actions'],
    narrow: ['slo', 'when', 'actions'],
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
                width: density === 'narrow' ? 160 : 280,
                Cell: ({ row }: Cell) => {
                    const [first, ...others] = row.original.slos;
                    const query = row.original.view.correction.sloQuery;
                    return (
                        <div className="cell-stack">
                            <Text size="sm" hasEllipsis title={first?.name}>
                                {first?.name ?? 'SLO'}
                            </Text>
                            <Text size="xs" variant="tertiary" hasEllipsis title={query ?? undefined}>
                                {query ? `Every SLO matching ${query}` : first?.type ? `${sloTypeLabel(first.type)} SLO` : ''}
                                {others.length > 0 ? ` · +${others.length} more` : ''}
                            </Text>
                        </div>
                    );
                },
            },
            category: {
                id: 'category',
                Header: 'Correction',
                accessor: (row: CorrectionRow) => row.view.correction.category,
                width: 220,
                Cell: ({ row }: Cell) => {
                    const description = row.original.view.correction.description;
                    return (
                        <div className="cell-stack">
                            <Text size="sm">{row.original.view.correction.category}</Text>
                            {description && (
                                <Text size="xs" variant="tertiary" hasEllipsis title={description}>
                                    {description}
                                </Text>
                            )}
                        </div>
                    );
                },
            },
            state: {
                id: 'state',
                Header: 'State',
                accessor: (row: CorrectionRow) => row.view.state,
                width: 110,
                Cell: ({ row }: Cell) => (
                    <StatusPill isSoft={row.original.view.state !== 'Active'} level={correctionStateLevel(row.original.view.state)}>
                        {row.original.view.state}
                    </StatusPill>
                ),
            },
            when: {
                id: 'when',
                Header: 'When',
                accessor: (row: CorrectionRow) => row.view.endMs ?? Number.MAX_SAFE_INTEGER,
                width: 230,
                Cell: ({ row }: Cell) => {
                    const { view } = row.original;
                    const dates =
                        view.state === 'Recurring'
                            ? `since ${formatStart(view.startMs)}`
                            : `${formatStart(view.startMs)} → ${formatEnd(view.endMs)}`;
                    return (
                        <div className="cell-stack">
                            <Text size="sm" hasEllipsis>
                                {correctionTiming(view, nowMs)}
                            </Text>
                            {density !== 'narrow' && (
                                <Text size="xs" variant="tertiary" hasEllipsis title={dates}>
                                    {dates}
                                </Text>
                            )}
                        </div>
                    );
                },
            },
            creator: {
                id: 'creator',
                Header: 'Created by',
                accessor: (row: CorrectionRow) => row.view.correction.creator ?? '',
                width: 160,
                Cell: ({ row }: Cell) => (
                    <Text size="sm" hasEllipsis>
                        {row.original.view.correction.creator ?? '—'}
                    </Text>
                ),
            },
            monitors: {
                id: 'monitors',
                Header: 'Muted monitors',
                accessor: (row: CorrectionRow) => row.monitorIds.length,
                width: 120,
                Cell: ({ row }: Cell) => <Text size="sm">{row.original.monitorIds.length}</Text>,
            },
            actions: {
                id: 'actions',
                Header: '',
                disableSortBy: true,
                width: 48,
                Cell: ({ row }: Cell) => {
                    const { view, slos } = row.original;
                    const first = slos[0];
                    return (
                        <RowMenu
                            label={`Actions for the ${view.correction.category} correction`}
                            items={[
                                ...(first ? [{ label: 'Open SLO in Datadog', href: sloUrl(first.id) }] : []),
                                {
                                    label: 'Extend correction…',
                                    onSelect: () => onExtend(row.original),
                                    disabledReason: correctionExtendBlockedReason(view),
                                    hasSeparatorTop: true,
                                },
                                {
                                    label: view.state === 'Scheduled' ? 'Delete correction…' : 'End correction now…',
                                    level: 'danger',
                                    onSelect: () => onCancel(row.original),
                                    disabledReason: correctionCancelBlockedReason(view),
                                },
                            ]}
                        />
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
                title: 'No SLO corrections right now',
                subtitle: 'None of the SLOs related to these monitors has an active, scheduled or recurring correction.',
            }}
            errorState={{
                isShown: Boolean(errorMessage),
                title: 'Unable to load SLOs and corrections',
                subtitle: errorMessage ?? undefined,
            }}
        />
    );
}
