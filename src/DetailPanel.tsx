import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { ClockIcon } from '@datadog/druids/icons/Clock';
import { TrashIcon } from '@datadog/druids/icons/Trash';
import { Grid } from '@datadog/druids/layout/Grid';
import { GridItem } from '@datadog/druids/layout/GridItem';
import { HorizontalSeparator } from '@datadog/druids/layout/HorizontalSeparator';
import { SidePanel } from '@datadog/druids/layout/SidePanel';
import { Spacing } from '@datadog/druids/layout/Spacing';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Text } from '@datadog/druids/typography/Text';

import { lastChange } from './changeRecord';
import { windowStateOf, type CoverageRow, type DatadogDowntimeMatch, type DowntimeMatch } from './coverage';
import {
    cancelBlockedReason,
    correctionStateLevel,
    correctionTiming,
    downtimeUrl,
    extendBlockedReason,
    formatEnd,
    formatRelative,
    formatPercent,
    formatStart,
    friendlyError,
    MAINTENANCE_HINTS,
    maintenanceLevel,
    matchKindLabel,
    monitorStateLevel,
    monitorUrl,
    mutedScopeLabel,
    sloTypeLabel,
    sloUrl,
    windowDetail,
    windowLevel,
} from './format';
import type { Density } from './hooks';
import type { CorrectionTarget } from './DowntimeModals';
import { fetchDatadogMatches, fetchDowntimeDetail } from './maintenance.backend';
import {
    correctionCancelBlockedReason,
    correctionExtendBlockedReason,
    type CorrectionView,
    type RelatedSlo,
} from './slo';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <GridItem>
            <Text as="div" size="xs" variant="tertiary" weight="bold" textTransform="uppercase" marginBottom="xxs">
                {label}
            </Text>
            {children}
        </GridItem>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Spacing as="section" paddingY="md">
            <Text as="h3" size="md" weight="bold" marginBottom="sm">
                {title}
            </Text>
            {children}
        </Spacing>
    );
}

/**
 * What Datadog itself says about this monitor. Uses Datadog's muted-monitor list
 * from the snapshot, so it needs no extra request.
 */
function DatadogStatus({ row }: { row: CoverageRow }) {
    if (row.maintenanceState === 'Not muting') {
        return (
            <MessageBox level="warning" title="Not muting anything right now">
                Datadog doesn't report this monitor as muted: its downtimes don't match any current group.
            </MessageBox>
        );
    }
    const fromOutsideList = row.matches.some((match) => match.downtime.fromDatadogMatch);
    return (
        <MessageBox level="success">
            Datadog reports this monitor as muted.
            {fromOutsideList && ' Its downtimes come from outside the downtime list, such as host auto-mutes.'}
        </MessageBox>
    );
}

const SWITCHER_LIMIT = 6;

/** Short label for a downtime in the switcher: what it targets, then when it ends. */
function switcherLabel(match: DowntimeMatch): string {
    const scope = match.downtime.scope?.trim();
    const target = match.kind === 'direct' ? 'Monitor ID' : scope && scope !== '*' ? scope : matchKindLabel(match);
    return `${target.length > 42 ? `${target.slice(0, 41)}…` : target} · ${match.endMs === null ? 'no end' : formatEnd(match.endMs)}`;
}

interface DetailPanelProps {
    row: CoverageRow | null;
    nowMs: number;
    density: Density;
    onClose: () => void;
    onCancel: (row: CoverageRow, match: DowntimeMatch) => void;
    onExtend: (row: CoverageRow, match: DowntimeMatch) => void;
    /** Receives Datadog's downtimes for a monitor whose downtime isn't in the downtime list. */
    onDatadogMatchesLoaded: (monitorId: number, matches: DatadogDowntimeMatch[]) => void;
    /** SLOs related to this monitor; undefined while SLOs are loading. */
    relatedSlos: RelatedSlo[] | undefined;
    correctionsBySlo: Map<string, CorrectionView[]>;
    onExtendCorrection: (target: CorrectionTarget) => void;
    onCancelCorrection: (target: CorrectionTarget) => void;
}

function RelatedSlosSection({
    relatedSlos,
    correctionsBySlo,
    nowMs,
    onExtendCorrection,
    onCancelCorrection,
}: Pick<DetailPanelProps, 'relatedSlos' | 'correctionsBySlo' | 'nowMs' | 'onExtendCorrection' | 'onCancelCorrection'>) {
    if (relatedSlos === undefined) {
        return <Text variant="tertiary">Loading SLOs…</Text>;
    }
    if (relatedSlos.length === 0) {
        return (
            <Text variant="tertiary">
                No monitor-based SLO uses this monitor, and no count-based or time-slice SLO carries the scope or tags
                of the downtime that covers it.
            </Text>
        );
    }
    return (
        <div className="slo-list">
            {relatedSlos.map(({ slo, relation, matchedTags }) => {
                const corrections = correctionsBySlo.get(slo.id) ?? [];
                return (
                    <div key={slo.id} className="slo-item">
                        <div className="slo-item-head">
                            <Button isNaked isTitleCased={false} hasEllipsisWithTooltip href={sloUrl(slo.id)} isExternal label={slo.name} />
                            <StatusPill isSoft level={relation === 'Monitor-based SLO' ? 'success' : 'default'}>
                                {relation}
                            </StatusPill>
                        </div>
                        <Text as="div" size="xs" variant="tertiary">
                            {sloTypeLabel(slo.type)} SLO · SLI {formatPercent(slo.sli)}
                            {slo.target !== null ? ` (target ${slo.target}%)` : ''} · error budget{' '}
                            {formatPercent(slo.errorBudgetRemaining, 1)}
                            {slo.timeframe ? ` · ${slo.timeframe}` : ''}
                            {matchedTags.length > 0 ? ` · tags ${matchedTags.join(', ')}` : ''}
                        </Text>
                        {corrections.length === 0 ? (
                            <Text as="div" size="xs" variant="tertiary" marginTop="xxs">
                                No current corrections.
                            </Text>
                        ) : (
                            corrections.map((view) => {
                                const extendBlocked = correctionExtendBlockedReason(view);
                                const cancelBlocked = correctionCancelBlockedReason(view);
                                const target = { view, sloName: slo.name };
                                return (
                                    <div key={view.correction.id} className="slo-correction">
                                        <div className="slo-item-head">
                                            <StatusPill level={correctionStateLevel(view.state)}>{view.state}</StatusPill>
                                            <Text size="sm">{view.correction.category}</Text>
                                        </div>
                                        <Text as="div" size="xs" variant="tertiary">
                                            {correctionTiming(view, nowMs)}
                                            {view.state !== 'Recurring' &&
                                                ` · ${formatStart(view.startMs)} → ${formatEnd(view.endMs)}`}
                                            {view.correction.description ? ` · ${view.correction.description}` : ''}
                                            {view.correction.sloQuery ? ` · applies to SLOs matching ${view.correction.sloQuery}` : ''}
                                        </Text>
                                        <div className="panel-actions">
                                            <Button
                                                size="sm"
                                                icon={ClockIcon}
                                                label="Extend"
                                                isDisabled={Boolean(extendBlocked)}
                                                tooltip={extendBlocked ?? undefined}
                                                onClick={() => onExtendCorrection(target)}
                                            />
                                            <Button
                                                size="sm"
                                                level="danger"
                                                icon={TrashIcon}
                                                label={view.state === 'Scheduled' ? 'Delete' : 'End now'}
                                                isDisabled={Boolean(cancelBlocked)}
                                                tooltip={cancelBlocked ?? undefined}
                                                onClick={() => onCancelCorrection(target)}
                                            />
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** Datadog-style side panel with the selected monitor's active downtime details. */
export function DetailPanel({
    row,
    nowMs,
    density,
    onClose,
    onCancel,
    onExtend,
    onDatadogMatchesLoaded,
    relatedSlos,
    correctionsBySlo,
    onExtendCorrection,
    onCancelCorrection,
}: DetailPanelProps) {
    const [selectedId, setSelectedId] = useState<string | null>(row ? row.primary.downtime.id : null);
    const [showAllDowntimes, setShowAllDowntimes] = useState(false);
    const match = row?.matches.find((m) => m.downtime.id === selectedId) ?? row?.primary ?? null;
    const isPlaceholder = Boolean(match?.downtime.isPlaceholder);
    const downtimeId = match && !isPlaceholder ? match.downtime.id : null;

    // Monitors muted by downtimes outside the downtime list (e.g. host auto-mutes): ask Datadog
    // which downtimes apply, once, when the panel opens.
    const monitorId = row?.monitor.id ?? 0;
    const datadogMatchesQuery = useQuery({
        queryKey: ['datadog-matches', monitorId],
        queryFn: () => fetchDatadogMatches(monitorId),
        enabled: isPlaceholder && monitorId > 0,
        staleTime: 5 * 60_000,
    });
    useEffect(() => {
        if (datadogMatchesQuery.data && monitorId > 0) onDatadogMatchesLoaded(monitorId, datadogMatchesQuery.data);
    }, [datadogMatchesQuery.data, monitorId, onDatadogMatchesLoaded]);

    const detailQuery = useQuery({
        queryKey: ['downtime-detail', downtimeId],
        queryFn: () => fetchDowntimeDetail(downtimeId as string),
        enabled: Boolean(downtimeId),
    });

    const columns = density === 'narrow' ? 1 : 2;
    const raw = detailQuery.data;
    // The app's own record of who last extended or cancelled this downtime (Audit Trail shows the app's account).
    const change = lastChange(raw?.message ?? match?.downtime.message);

    return (
        <SidePanel
            isOpen={Boolean(row && match)}
            isPortalized
            hasTransition
            width={density === 'narrow' ? '100vw' : 'min(600px, 92vw)'}
            onClose={onClose}
        >
            {row && match && (
                <Spacing as="div" padding="lg">
                    <Text as="div" size="xs" variant="tertiary" weight="bold" textTransform="uppercase">
                        Active downtime
                    </Text>
                    <Text as="h2" size="lg" weight="bold" marginBottom="xs">
                        {row.monitor.name}
                    </Text>
                    <div className="panel-actions">
                        {monitorUrl(row.monitor.id) && (
                            <Button size="sm" href={monitorUrl(row.monitor.id) ?? undefined} isExternal label="Open monitor" />
                        )}
                        {!isPlaceholder && (
                            <Button
                                size="sm"
                                href={downtimeUrl(match.downtime.id)}
                                isExternal
                                label="Open downtime"
                            />
                        )}
                        <Button
                            size="sm"
                            icon={ClockIcon}
                            label="Extend"
                            isDisabled={Boolean(extendBlockedReason(match))}
                            tooltip={extendBlockedReason(match) ?? undefined}
                            onClick={() => onExtend(row, match)}
                        />
                        <Button
                            size="sm"
                            level="danger"
                            icon={TrashIcon}
                            label="Cancel downtime"
                            isDisabled={Boolean(cancelBlockedReason(match))}
                            tooltip={cancelBlockedReason(match) ?? undefined}
                            onClick={() => onCancel(row, match)}
                        />
                    </div>

                    <Section title="Monitor">
                        <Grid columns={columns} gap="md">
                            <Field label="Monitor ID">
                                <Text isMonospace>{row.monitor.id}</Text>
                            </Field>
                            <Field label="Monitor type">
                                <Text>{row.monitor.type}</Text>
                            </Field>
                            <Field label="Monitor state">
                                <StatusPill level={monitorStateLevel(row.monitor.overallState)}>
                                    {row.monitor.overallState}
                                </StatusPill>
                            </Field>
                            <Field label="Owner">
                                <Text>{row.owner}</Text>
                            </Field>
                        </Grid>
                    </Section>
                    <HorizontalSeparator />

                    <Section title="Downtime">
                        {isPlaceholder && (
                            <Spacing as="div" marginBottom="md">
                                {datadogMatchesQuery.isError ? (
                                    <MessageBox level="warning" title="Couldn't load this monitor's downtimes">
                                        {friendlyError(datadogMatchesQuery.error, 'read downtimes')}
                                    </MessageBox>
                                ) : datadogMatchesQuery.data && datadogMatchesQuery.data.length === 0 ? (
                                    <MessageBox level="warning">
                                        Datadog no longer applies a downtime to this monitor. Refresh to update the table.
                                    </MessageBox>
                                ) : (
                                    <MessageBox>
                                        This monitor is muted by a downtime outside the downtime list (for example a host
                                        auto-mute). Loading it from Datadog…
                                    </MessageBox>
                                )}
                            </Spacing>
                        )}
                        {row.matches.length > 1 && (
                            <Spacing as="div" marginBottom="md">
                                <Text as="div" size="sm" variant="secondary" marginBottom="xs">
                                    {row.matches.length >= 100 ? '100+' : row.matches.length} active downtimes cover this
                                    monitor:
                                </Text>
                                <div className="panel-actions">
                                    {(showAllDowntimes ? row.matches : row.matches.slice(0, SWITCHER_LIMIT)).map((m) => (
                                        <Button
                                            key={m.downtime.id}
                                            size="sm"
                                            isActive={m.downtime.id === match.downtime.id}
                                            hasEllipsisWithTooltip
                                            isTitleCased={false}
                                            label={switcherLabel(m)}
                                            onClick={() => setSelectedId(m.downtime.id)}
                                        />
                                    ))}
                                    {row.matches.length > SWITCHER_LIMIT && (
                                        <Button
                                            size="sm"
                                            isNaked
                                            label={showAllDowntimes ? 'Show fewer' : `Show all ${row.matches.length}`}
                                            onClick={() => setShowAllDowntimes((value) => !value)}
                                        />
                                    )}
                                </div>
                            </Spacing>
                        )}
                        <Grid columns={columns} gap="md">
                            <Field label="Coverage">
                                <StatusPill isSoft level={match.kind === 'direct' ? 'success' : 'default'}>
                                    {matchKindLabel(match)}
                                </StatusPill>
                                <Text as="div" size="xs" variant="tertiary" marginTop="xxs">
                                    {match.reason}
                                </Text>
                            </Field>
                            <Field label="What is muted">
                                <StatusPill level={maintenanceLevel(row)} title={MAINTENANCE_HINTS[row.maintenanceState]}>
                                    {row.maintenanceState}
                                </StatusPill>
                                <Text as="div" size="xs" variant="tertiary" isMonospace marginTop="xxs">
                                    {mutedScopeLabel(match)}
                                </Text>
                            </Field>
                            <Field label="Window">
                                <StatusPill level={windowLevel(windowStateOf(match, nowMs))}>
                                    {windowStateOf(match, nowMs)}
                                </StatusPill>
                                <Text as="div" size="xs" variant="tertiary" marginTop="xxs">
                                    {windowDetail(match, windowStateOf(match, nowMs), nowMs)}
                                </Text>
                            </Field>
                            <Field label="Downtime ID">
                                <Text isMonospace size="sm">
                                    {match.downtime.id}
                                </Text>
                            </Field>
                            <Field label="Start">
                                <Text>{formatStart(match.startMs)}</Text>
                                <Text as="div" size="xs" variant="tertiary">
                                    {formatRelative(match.startMs, nowMs) ?? ''}
                                </Text>
                            </Field>
                            <Field label="End">
                                <Text variant={match.endMs === null ? 'warning' : 'default'}>{formatEnd(match.endMs)}</Text>
                                <Text as="div" size="xs" variant="tertiary">
                                    {formatRelative(match.endMs, nowMs) ?? 'Runs until canceled'}
                                </Text>
                            </Field>
                            <Field label="Timezone">
                                <Text>{raw?.display_timezone ?? match.downtime.displayTimezone ?? 'UTC'}</Text>
                            </Field>
                            <Field label="Created by">
                                <Text>{match.creatorLabel}</Text>
                            </Field>
                            {change && (
                                <Field label="Last changed by">
                                    <Text as="div">{change.by}</Text>
                                    <Text as="div" size="xs" variant="tertiary">
                                        {change.action === 'Extended'
                                            ? `Extended${change.end ? ` to ${formatEnd(Date.parse(change.end))}` : ''}`
                                            : 'Cancelled'}{' '}
                                        via Downtime Manager, {formatStart(Date.parse(change.at))}
                                    </Text>
                                </Field>
                            )}
                            <GridItem colSpan="all">
                                <Text as="div" size="xs" variant="tertiary" weight="bold" textTransform="uppercase" marginBottom="xxs">
                                    Scope
                                </Text>
                                <Text isMonospace size="sm" overflowWrap="anywhere">
                                    {raw?.scope ?? match.downtime.scope ?? '*'}
                                </Text>
                            </GridItem>
                            <GridItem colSpan="all">
                                <Text as="div" size="xs" variant="tertiary" weight="bold" textTransform="uppercase" marginBottom="xxs">
                                    Message
                                </Text>
                                <Text as="p" whiteSpace="pre-wrap" overflowWrap="anywhere">
                                    {(raw?.message ?? match.downtime.message)?.trim() || 'No message'}
                                </Text>
                            </GridItem>
                        </Grid>
                        <Spacing as="div" marginTop="md">
                            <DatadogStatus row={row} />
                        </Spacing>
                    </Section>
                    <HorizontalSeparator />

                    <Section title={`Related SLOs${relatedSlos?.length ? ` (${relatedSlos.length})` : ''}`}>
                        <RelatedSlosSection
                            relatedSlos={relatedSlos}
                            correctionsBySlo={correctionsBySlo}
                            nowMs={nowMs}
                            onExtendCorrection={onExtendCorrection}
                            onCancelCorrection={onCancelCorrection}
                        />
                    </Section>
                    <HorizontalSeparator />

                    <Section title="Raw JSON (get downtime)">
                        {detailQuery.isLoading && <Text variant="tertiary">Loading live downtime…</Text>}
                        {detailQuery.isError && (
                            <MessageBox level="danger" title="Unable to load downtime">
                                {friendlyError(detailQuery.error, 'read downtimes')}
                            </MessageBox>
                        )}
                        {raw && (
                            <Text as="pre" isMonospace size="xs" className="raw-json">
                                {JSON.stringify(raw, null, 2)}
                            </Text>
                        )}
                    </Section>
                </Spacing>
            )}
        </SidePanel>
    );
}
