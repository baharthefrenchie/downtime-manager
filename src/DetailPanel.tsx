import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { ClockIcon } from '@datadog/druids/icons/Clock';
import { ExternalLinkIcon } from '@datadog/druids/icons/ExternalLink';
import { TrashIcon } from '@datadog/druids/icons/Trash';
import { SidePanel } from '@datadog/druids/layout/SidePanel';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { StatusPill } from '@datadog/druids/pills/StatusPill';
import { Text } from '@datadog/druids/typography/Text';

import { lastChange } from './changeRecord';
import type { CoverageRow, DatadogDowntimeMatch, DowntimeMatch } from './coverage';
import {
    cancelBlockedReason,
    correctionStateLevel,
    correctionTiming,
    downtimeUrl,
    endsLabel,
    extendBlockedReason,
    formatDuration,
    formatEnd,
    formatPercent,
    formatRelative,
    formatStart,
    friendlyError,
    matchHowLabel,
    monitorStateLevel,
    monitorUrl,
    mutedScopeLabel,
    sloTypeLabel,
    sloUrl,
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

/** One label/value pair in a details list. */
function Detail({ label, children, isWide = false }: { label: string; children: ReactNode; isWide?: boolean }) {
    return (
        <div className={`detail${isWide ? ' detail--wide' : ''}`}>
            <Text as="dt" size="xs" variant="secondary">
                {label}
            </Text>
            <dd>{children}</dd>
        </div>
    );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
    return (
        <div className="panel-section-title">
            <Text as="h3" size="md" weight="bold">
                {children}
            </Text>
            {aside}
        </div>
    );
}

/** Short label for a downtime in the switcher: what it mutes, then when it ends. */
function switcherLabel(match: DowntimeMatch, nowMs: number): string {
    // The end comes first: long scopes often share a prefix, and the end is what tells them apart.
    const what = mutedScopeLabel(match);
    const ends = match.endMs === null ? 'No end' : `Ends ${formatRelative(match.endMs, nowMs)}`;
    return `${ends} · ${what.length > 40 ? `…${what.slice(-39)}` : what}`;
}

const SWITCHER_LIMIT = 6;

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

function CorrectionItem({
    view,
    sloName,
    nowMs,
    onExtend,
    onCancel,
}: {
    view: CorrectionView;
    sloName: string;
    nowMs: number;
    onExtend: (target: CorrectionTarget) => void;
    onCancel: (target: CorrectionTarget) => void;
}) {
    const target = { view, sloName };
    const extendBlocked = correctionExtendBlockedReason(view);
    const cancelBlocked = correctionCancelBlockedReason(view);
    const isRecurring = view.state === 'Recurring';
    return (
        <div className="slo-correction">
            <div className="slo-correction-head">
                <StatusPill isSoft level={correctionStateLevel(view.state)}>
                    {view.state}
                </StatusPill>
                <Text size="sm" hasEllipsis>
                    {view.correction.category}
                    {view.correction.description ? ` · ${view.correction.description}` : ''}
                </Text>
            </div>
            <Text as="div" size="xs" variant="tertiary">
                {correctionTiming(view, nowMs)}
                {!isRecurring && ` · ${formatStart(view.startMs)} → ${formatEnd(view.endMs)}`}
                {view.correction.sloQuery ? ` · on every SLO matching ${view.correction.sloQuery}` : ''}
            </Text>
            {isRecurring ? (
                <Text as="div" size="xs" variant="tertiary">
                    Recurring corrections are edited in Datadog.
                </Text>
            ) : (
                <div className="panel-actions">
                    <Button
                        size="sm"
                        icon={ClockIcon}
                        label="Extend"
                        isDisabled={Boolean(extendBlocked)}
                        tooltip={extendBlocked ?? undefined}
                        onClick={() => onExtend(target)}
                    />
                    <Button
                        size="sm"
                        level="danger"
                        label={view.state === 'Scheduled' ? 'Delete' : 'End now'}
                        isDisabled={Boolean(cancelBlocked)}
                        tooltip={cancelBlocked ?? undefined}
                        onClick={() => onCancel(target)}
                    />
                </div>
            )}
        </div>
    );
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
            <Text as="p" size="sm" variant="tertiary">
                No SLO uses this monitor or matches its downtime&apos;s tags.
            </Text>
        );
    }
    return (
        <div className="slo-list">
            {relatedSlos.map(({ slo, relation, matchedTags }) => {
                const corrections = correctionsBySlo.get(slo.id) ?? [];
                const why = relation === 'Monitor-based SLO' ? 'uses this monitor' : `matches ${matchedTags.join(', ') || 'the downtime'}`;
                return (
                    <div key={slo.id} className="slo-item">
                        <Button
                            isNaked
                            isTitleCased={false}
                            hasEllipsisWithTooltip
                            href={sloUrl(slo.id)}
                            isExternal
                            label={slo.name}
                        />
                        <Text as="div" size="xs" variant="tertiary">
                            {sloTypeLabel(slo.type)} · SLI {formatPercent(slo.sli)}
                            {slo.target !== null ? ` (target ${slo.target}%)` : ''} · {formatPercent(slo.errorBudgetRemaining, 1)} budget
                            left{slo.timeframe ? ` · ${slo.timeframe}` : ''} · {why}
                        </Text>
                        {corrections.map((view) => (
                            <CorrectionItem
                                key={view.correction.id}
                                view={view}
                                sloName={slo.name}
                                nowMs={nowMs}
                                onExtend={onExtendCorrection}
                                onCancel={onCancelCorrection}
                            />
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

/** Side panel for one monitor: what is muted, until when, what to do about it, and the SLOs it touches. */
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
    const [showTechnical, setShowTechnical] = useState(false);
    const match = row?.matches.find((m) => m.downtime.id === selectedId) ?? row?.primary ?? null;
    const isPlaceholder = Boolean(match?.downtime.isPlaceholder);
    const isLoading = Boolean(match?.downtime.isLoading);
    const downtimeId = match && !isPlaceholder ? match.downtime.id : null;

    // Monitors muted by downtimes outside the downtime list (e.g. host auto-mutes): ask Datadog
    // which downtimes apply, once, when the panel opens.
    const monitorId = row?.monitor.id ?? 0;
    const datadogMatchesQuery = useQuery({
        queryKey: ['datadog-matches', monitorId],
        queryFn: () => fetchDatadogMatches(monitorId),
        enabled: isPlaceholder && !isLoading && monitorId > 0,
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

    const raw = detailQuery.data;
    // The app's own record of who last extended or cancelled this downtime (Audit Trail shows the app's account).
    const change = lastChange(raw?.message ?? match?.downtime.message);
    const monitorLink = row ? monitorUrl(row.monitor.id) : null;
    const scope = (raw?.scope ?? match?.downtime.scope ?? '').trim();
    const message = (raw?.message ?? match?.downtime.message)?.trim();
    const what = match ? mutedScopeLabel(match) : '';
    const ends = match ? endsLabel(match, nowMs) : null;
    const extendBlocked = match ? extendBlockedReason(match) : null;
    const cancelBlocked = match ? cancelBlockedReason(match) : null;

    return (
        <SidePanel
            isOpen={Boolean(row && match)}
            isPortalized
            hasTransition
            width={density === 'narrow' ? '100vw' : 'min(560px, 92vw)'}
            onClose={onClose}
        >
            {row && match && (
                <div className="panel">
                    {/* Monitor */}
                    <div className="panel-head">
                        <Text as="h2" size="lg" weight="bold">
                            {row.monitor.name}
                        </Text>
                        <div className="panel-meta">
                            <StatusPill level={monitorStateLevel(row.monitor.overallState)}>{row.monitor.overallState}</StatusPill>
                            <Text size="sm" variant="secondary">
                                {row.monitor.type} · owned by {row.owner}
                            </Text>
                            {monitorLink && (
                                <Button size="sm" isNaked icon={ExternalLinkIcon} href={monitorLink} isExternal label="Open monitor" />
                            )}
                        </div>
                    </div>

                    {row.maintenanceState === 'Not muting' && (
                        <MessageBox level="warning" title="Not muting anything right now">
                            Datadog doesn&apos;t report this monitor as muted: its downtimes don&apos;t match any of its current
                            groups.
                        </MessageBox>
                    )}
                    {isPlaceholder && !isLoading && (
                        datadogMatchesQuery.isError ? (
                            <MessageBox level="warning" title="Couldn't load this monitor's downtimes">
                                {friendlyError(datadogMatchesQuery.error, 'read downtimes')}
                            </MessageBox>
                        ) : datadogMatchesQuery.data && datadogMatchesQuery.data.length === 0 ? (
                            <MessageBox level="warning">
                                Datadog no longer applies a downtime to this monitor. Refresh to update the table.
                            </MessageBox>
                        ) : (
                            <MessageBox>
                                Muted by a downtime outside the downtime list (for example a host auto-mute). Loading it from
                                Datadog…
                            </MessageBox>
                        )
                    )}

                    {/* Downtime */}
                    <section className="panel-section" aria-label="Downtime">
                        <SectionTitle
                            aside={
                                row.matches.length > 1 && (
                                    <Text size="sm" variant="secondary">
                                        {row.matches.length >= 100 ? '100+' : row.matches.length} downtimes mute this monitor
                                    </Text>
                                )
                            }
                        >
                            Downtime
                        </SectionTitle>
                        {row.matches.length > 1 && (
                            <div className="panel-actions downtime-switcher">
                                {(showAllDowntimes ? row.matches : row.matches.slice(0, SWITCHER_LIMIT)).map((m) => (
                                    <Button
                                        key={m.downtime.id}
                                        size="sm"
                                        isActive={m.downtime.id === match.downtime.id}
                                        hasEllipsisWithTooltip
                                        isTitleCased={false}
                                        label={switcherLabel(m, nowMs)}
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
                        )}

                        {isLoading ? (
                            <Text variant="tertiary">Loading downtimes…</Text>
                        ) : (
                            <div className="downtime-card">
                                <Text as="div" size="md" weight="bold" className="downtime-headline">
                                    {isPlaceholder ? (
                                        'Muting some groups'
                                    ) : what === 'All groups' ? (
                                        'Muting all groups'
                                    ) : (
                                        <>
                                            Muting <code className="inline-code">{what}</code>
                                        </>
                                    )}
                                </Text>
                                {ends && !isPlaceholder && (
                                    <Text as="div" size="sm" variant="secondary">
                                        {matchHowLabel(match)}
                                        {match.startMs !== null && ` · started ${formatRelative(match.startMs, nowMs)}`}
                                        {' · '}
                                        <Text as="span" size="sm" variant={ends.tone === 'tertiary' ? 'secondary' : ends.tone}>
                                            {match.endMs === null
                                                ? 'no end, runs until canceled'
                                                : `ends ${formatRelative(match.endMs, nowMs)} (${formatEnd(match.endMs)})`}
                                        </Text>
                                    </Text>
                                )}
                                <div className="panel-actions">
                                    <Button
                                        size="sm"
                                        level="featured"
                                        icon={ClockIcon}
                                        label="Extend"
                                        isDisabled={Boolean(extendBlocked)}
                                        tooltip={extendBlocked ?? undefined}
                                        onClick={() => onExtend(row, match)}
                                    />
                                    <Button
                                        size="sm"
                                        level="danger"
                                        icon={TrashIcon}
                                        label="Cancel downtime"
                                        isDisabled={Boolean(cancelBlocked)}
                                        tooltip={cancelBlocked ?? undefined}
                                        onClick={() => onCancel(row, match)}
                                    />
                                    {!isPlaceholder && (
                                        <Button
                                            size="sm"
                                            isNaked
                                            icon={ExternalLinkIcon}
                                            href={downtimeUrl(match.downtime.id)}
                                            isExternal
                                            label="Open downtime"
                                        />
                                    )}
                                </div>
                            </div>
                        )}

                        {!isPlaceholder && (
                            <dl className="details">
                                <Detail label="Started">
                                    <Text size="sm">{formatStart(match.startMs)}</Text>
                                </Detail>
                                <Detail label="Ends">
                                    <Text size="sm">{match.endMs === null ? 'No end' : formatEnd(match.endMs)}</Text>
                                </Detail>
                                <Detail label="Created by">
                                    <Text size="sm">{match.creatorLabel}</Text>
                                </Detail>
                                <Detail label="Timezone">
                                    <Text size="sm">{raw?.display_timezone ?? match.downtime.displayTimezone ?? 'UTC'}</Text>
                                </Detail>
                                {change && (
                                    <Detail label="Last changed" isWide>
                                        <Text size="sm">
                                            {change.action === 'Extended'
                                                ? `Extended${change.end ? ` to ${formatEnd(Date.parse(change.end))}` : ''}`
                                                : 'Cancelled'}{' '}
                                            by {change.by}, {formatStart(Date.parse(change.at))}
                                        </Text>
                                    </Detail>
                                )}
                                {scope && scope !== '*' && scope !== what && (
                                    <Detail label="Scope" isWide>
                                        <Text size="sm" isMonospace overflowWrap="anywhere">
                                            {scope}
                                        </Text>
                                    </Detail>
                                )}
                                {message && (
                                    <Detail label="Message" isWide>
                                        <Text as="p" size="sm" whiteSpace="pre-wrap" overflowWrap="anywhere">
                                            {message}
                                        </Text>
                                    </Detail>
                                )}
                            </dl>
                        )}
                    </section>

                    {/* SLOs */}
                    <section className="panel-section" aria-label="Related SLOs">
                        <SectionTitle>{`Related SLOs${relatedSlos?.length ? ` (${relatedSlos.length})` : ''}`}</SectionTitle>
                        <RelatedSlosSection
                            relatedSlos={relatedSlos}
                            correctionsBySlo={correctionsBySlo}
                            nowMs={nowMs}
                            onExtendCorrection={onExtendCorrection}
                            onCancelCorrection={onCancelCorrection}
                        />
                    </section>

                    {/* Technical details, folded away */}
                    {!isLoading && (
                        <section className="panel-section panel-section--quiet" aria-label="Technical details">
                            <Button
                                size="sm"
                                isNaked
                                isTitleCased={false}
                                label={showTechnical ? 'Hide technical details' : 'Show technical details'}
                                onClick={() => setShowTechnical((value) => !value)}
                            />
                            {showTechnical && (
                                <>
                                    <dl className="details">
                                        <Detail label="Monitor ID">
                                            <Text size="sm" isMonospace>
                                                {row.monitor.id}
                                            </Text>
                                        </Detail>
                                        {!isPlaceholder && (
                                            <Detail label="Downtime ID">
                                                <Text size="sm" isMonospace overflowWrap="anywhere">
                                                    {match.downtime.id}
                                                </Text>
                                            </Detail>
                                        )}
                                        <Detail label="Why it matches" isWide>
                                            <Text size="sm">{match.reason}</Text>
                                        </Detail>
                                        {match.startMs !== null && match.endMs !== null && (
                                            <Detail label="Length">
                                                <Text size="sm">{formatDuration(match.endMs - match.startMs)}</Text>
                                            </Detail>
                                        )}
                                        <Detail label="Datadog says">
                                            <Text size="sm">{row.maintenanceState === 'Not muting' ? 'Not muted' : 'Muted'}</Text>
                                        </Detail>
                                    </dl>
                                    {!isPlaceholder && (
                                        <>
                                            <Text as="div" size="xs" variant="secondary" marginBottom="xxs">
                                                Get-downtime response
                                            </Text>
                                            {detailQuery.isLoading && <Text variant="tertiary">Loading live downtime…</Text>}
                                            {detailQuery.isError && (
                                                <MessageBox level="danger" title="Couldn't load the downtime">
                                                    {friendlyError(detailQuery.error, 'read downtimes')}
                                                </MessageBox>
                                            )}
                                            {raw && (
                                                <Text as="pre" isMonospace size="xs" className="raw-json">
                                                    {JSON.stringify(raw, null, 2)}
                                                </Text>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </section>
                    )}
                </div>
            )}
        </SidePanel>
    );
}
