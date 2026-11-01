import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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

import { windowStateOf, type CoverageRow, type DowntimeMatch } from './coverage';
import {
    downtimeUrl,
    extendBlockedReason,
    formatEnd,
    formatRelative,
    formatStart,
    friendlyError,
    MAINTENANCE_HINTS,
    maintenanceLevel,
    matchKindLabel,
    monitorStateLevel,
    monitorUrl,
    mutedScopeLabel,
    windowDetail,
    windowLevel,
} from './format';
import type { Density } from './hooks';
import { fetchDatadogMatches, fetchDowntimeDetail } from './maintenance.backend';

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

function DatadogConfirmation({ row }: { row: CoverageRow }) {
    const query = useQuery({
        queryKey: ['datadog-matches', row.monitor.id],
        queryFn: () => fetchDatadogMatches(row.monitor.id),
        staleTime: 60_000,
    });

    if (query.isLoading) {
        return <MessageBox>Checking with Datadog which downtimes it applies to this monitor…</MessageBox>;
    }
    if (query.isError) {
        return (
            <MessageBox level="warning" title="Couldn't confirm with Datadog">
                {friendlyError(query.error, 'read downtimes')}
            </MessageBox>
        );
    }

    const datadogIds = new Set((query.data ?? []).map((match) => match.id));
    const ours = row.matches.map((match) => match.downtime.id);
    const unconfirmed = ours.filter((id) => !datadogIds.has(id));
    const extra = [...datadogIds].filter((id) => !ours.includes(id));

    if (unconfirmed.length === 0 && extra.length === 0) {
        return (
            <MessageBox level="success">
                Confirmed: Datadog applies the same {ours.length} active {ours.length === 1 ? 'downtime' : 'downtimes'} to
                this monitor.
            </MessageBox>
        );
    }
    return (
        <MessageBox level="warning" title="Datadog sees this monitor differently">
            {unconfirmed.length > 0 && (
                <Text as="p">
                    Not applied by Datadog: {unconfirmed.join(', ')}. Tag/scope matching in this app is an estimate based on
                    the monitor's tags.
                </Text>
            )}
            {extra.length > 0 && <Text as="p">Also applied by Datadog: {extra.join(', ')}.</Text>}
        </MessageBox>
    );
}

interface DetailPanelProps {
    row: CoverageRow | null;
    nowMs: number;
    density: Density;
    onClose: () => void;
    onCancel: (row: CoverageRow, match: DowntimeMatch) => void;
    onExtend: (row: CoverageRow, match: DowntimeMatch) => void;
}

/** Datadog-style side panel with the selected monitor's active downtime details. */
export function DetailPanel({ row, nowMs, density, onClose, onCancel, onExtend }: DetailPanelProps) {
    const [selectedId, setSelectedId] = useState<string | null>(row ? row.primary.downtime.id : null);
    const match = row?.matches.find((m) => m.downtime.id === selectedId) ?? row?.primary ?? null;
    const downtimeId = match?.downtime.id ?? null;

    const detailQuery = useQuery({
        queryKey: ['downtime-detail', downtimeId],
        queryFn: () => fetchDowntimeDetail(downtimeId as string),
        enabled: Boolean(downtimeId),
    });

    const columns = density === 'narrow' ? 1 : 2;
    const raw = detailQuery.data;

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
                        <Button
                            size="sm"
                            href={downtimeUrl(match.downtime.id, raw?.url ?? match.downtime.url)}
                            isExternal
                            label="Open downtime"
                        />
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
                        {row.matches.length > 1 && (
                            <Spacing as="div" marginBottom="md">
                                <Text as="div" size="sm" variant="secondary" marginBottom="xs">
                                    {row.matches.length} active downtimes cover this monitor:
                                </Text>
                                <div className="panel-actions">
                                    {row.matches.map((m) => (
                                        <Button
                                            key={m.downtime.id}
                                            size="sm"
                                            isActive={m.downtime.id === match.downtime.id}
                                            label={`${matchKindLabel(m)} · ${formatEnd(m.endMs)}`}
                                            onClick={() => setSelectedId(m.downtime.id)}
                                        />
                                    ))}
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
                            <DatadogConfirmation row={row} />
                        </Spacing>
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
