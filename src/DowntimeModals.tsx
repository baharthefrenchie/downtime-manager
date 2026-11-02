import { useState, type ReactNode } from 'react';

import { Modal } from '@datadog/druids/dialogs/Modal';
import { Button } from '@datadog/druids/form/Button';
import { Checkbox } from '@datadog/druids/form/Checkbox';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { Text } from '@datadog/druids/typography/Text';

import type { CoverageRow, DowntimeMatch } from './coverage';
import {
    correctionTiming,
    extendBlockedReason,
    formatEnd,
    formatRelative,
    formatStart,
    matchHowLabel,
    mutedScopeLabel,
} from './format';
import {
    isTicked,
    LINK_TOLERANCE_MINUTES,
    linkedBlockedReason,
    linkedCorrectionLabel,
    selectedCorrectionIds,
    type LinkedCorrectionsState,
} from './linkedCorrections';
import { correctionExtendBlockedReason, type CorrectionView } from './slo';

interface LinkedCorrectionsListProps {
    state: LinkedCorrectionsState;
    mode: 'extend' | 'cancel';
    /** The downtime's new end (extend only). */
    newEndMs: number;
    nowMs: number;
    /** Corrections whose tick the user flipped from the default. */
    toggled: Set<string>;
    onToggle: (correctionId: string) => void;
}

/** "Also update these SLO corrections" checklist in the downtime extend and cancel dialogs. */
function LinkedCorrectionsList({ state, mode, newEndMs, nowMs, toggled, onToggle }: LinkedCorrectionsListProps) {
    const heading = (
        <Text as="div" size="sm" weight="bold" marginTop="md" marginBottom="xxs">
            {mode === 'extend' ? 'Also extend SLO corrections' : 'Also end SLO corrections'}
        </Text>
    );
    if (state.status === 'loading') {
        return (
            <>
                {heading}
                <Text variant="tertiary" size="sm">Loading SLO corrections…</Text>
            </>
        );
    }
    if (state.status === 'error') {
        return (
            <>
                {heading}
                <MessageBox level="warning">
                    Couldn&apos;t load SLO corrections, so only the downtime will change. {state.message}
                </MessageBox>
            </>
        );
    }
    const { linked, recurring } = state.corrections;
    const rule =
        `One-time corrections on this downtime's related SLOs (or created by Datadog from its monitor tags) whose window ` +
        `overlaps it. Those that start or end within ${LINK_TOLERANCE_MINUTES} minutes of the downtime are ticked. ` +
        'Recurring corrections are never changed here.';
    return (
        <>
            {heading}
            {linked.length === 0 ? (
                <Text as="p" size="sm" variant="secondary" title={rule}>
                    None of this downtime&apos;s SLOs has a correction during it, so only the downtime changes.
                </Text>
            ) : (
                <>
                    <Text as="p" size="xs" variant="tertiary" marginBottom="xs" title={rule}>
                        Corrections that start or end with this downtime are ticked. Tick others to change them too.
                    </Text>
                    <div className="linked-corrections">
                        {linked.map((item) => {
                            const id = item.view.correction.id;
                            const blocked = linkedBlockedReason(item, mode, newEndMs);
                            const action =
                                mode === 'extend'
                                    ? `extends to ${formatEnd(newEndMs)}`
                                    : item.view.state === 'Scheduled'
                                      ? "deleted (it hasn't started)"
                                      : 'ends now';
                            const notes = [
                                item.view.state === 'Active' ? correctionTiming(item.view, nowMs) : item.view.state,
                                item.fit === 'overlaps' ? 'only overlaps this downtime' : null,
                                item.reason === 'from-downtime' ? "created from this downtime's tags" : null,
                                blocked ?? action,
                            ].filter(Boolean);
                            return (
                                <Checkbox
                                    key={id}
                                    isChecked={!blocked && isTicked(item, toggled)}
                                    isDisabled={Boolean(blocked)}
                                    onChange={() => onToggle(id)}
                                    label={
                                        <span className="cell-stack">
                                            <Text size="sm">{linkedCorrectionLabel(item)}</Text>
                                            <Text size="xs" variant="tertiary">
                                                {notes.join(' · ')}
                                            </Text>
                                        </span>
                                    }
                                />
                            );
                        })}
                    </div>
                </>
            )}
            <Text as="p" size="xs" variant="tertiary" marginTop="xs">
                {recurring.length > 0 &&
                    `${recurring.length} recurring correction${recurring.length === 1 ? '' : 's'} on these SLOs ${recurring.length === 1 ? "isn't" : "aren't"} changed. `}
                {linked.length > 0 && 'The downtime changes first; if a correction then fails, the result says which.'}
            </Text>
        </>
    );
}

function useToggled() {
    const [toggled, setToggled] = useState<Set<string>>(() => new Set());
    const toggle = (id: string) =>
        setToggled((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    return [toggled, toggle] as const;
}

interface CancelModalProps {
    target: { row: CoverageRow; match: DowntimeMatch };
    linked: LinkedCorrectionsState;
    nowMs: number;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (downtimeId: string, correctionIds: string[]) => void;
}

export function CancelDowntimeModal({ target, linked, nowMs, isPending, error, onClose, onConfirm }: CancelModalProps) {
    const [toggled, toggle] = useToggled();
    const { row, match } = target;
    const what = mutedScopeLabel(match);
    const others = row.matches.length - 1;

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            title="Cancel this downtime?"
            hasFooterSeparator
            footer={
                <div className="modal-footer-right">
                    <Button label="Keep downtime" onClick={onClose} isDisabled={isPending} />
                    <Button
                        level="danger"
                        isPrimary
                        label="Cancel downtime"
                        isLoading={isPending}
                        onClick={() => onConfirm(match.downtime.id, selectedCorrectionIds(linked, toggled, 'cancel', 0))}
                    />
                </div>
            }
        >
            <Text as="p" marginBottom="xs">
                Alerts from{' '}
                <Text weight="bold" as="span">
                    {row.monitor.name}
                </Text>{' '}
                start notifying again right away
                {others > 0 ? `, except where ${others === 1 ? 'its other downtime still mutes' : `its ${others} other downtimes still mute`} it` : ''}.
            </Text>
            <Text as="p" size="sm" variant="secondary" marginBottom="sm">
                This downtime mutes{' '}
                {what === 'All groups' ? 'all groups' : <Text isMonospace as="span" size="sm">{what}</Text>}{' '}
                {matchHowLabel(match).replace(/^By/, 'by')} and {match.endMs === null ? 'has no end' : `ends ${formatEnd(match.endMs)}`}.
            </Text>
            {match.kind !== 'direct' && (
                <MessageBox level="warning" marginBottom="sm">
                    It mutes monitors by tags or scope, so it may also mute other monitors. Canceling it unmutes all of
                    them.
                </MessageBox>
            )}
            <LinkedCorrectionsList state={linked} mode="cancel" newEndMs={0} nowMs={nowMs} toggled={toggled} onToggle={toggle} />
            {error && (
                <MessageBox level="danger" title="Cancel failed" marginTop="sm">
                    {error}
                </MessageBox>
            )}
        </Modal>
    );
}

const EXTEND_PRESETS: { label: string; ms: number }[] = [
    { label: '+1 hour', ms: 60 * 60 * 1000 },
    { label: '+4 hours', ms: 4 * 60 * 60 * 1000 },
    { label: '+1 day', ms: 24 * 60 * 60 * 1000 },
    { label: '+3 days', ms: 3 * 24 * 60 * 60 * 1000 },
    { label: '+1 week', ms: 7 * 24 * 60 * 60 * 1000 },
];

function toLocalInputValue(ms: number): string {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ExtendEndModalProps {
    title: string;
    /** What is being extended, shown above the presets. */
    subject: ReactNode;
    currentEndMs: number | null;
    nowMs: number;
    blockedReason: string | null;
    /** What the update leaves alone, e.g. "The scope and start stay unchanged." */
    unchangedNote: string;
    confirmLabel: string;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (newEndIso: string) => void;
    /** Shown under the new end, for example the linked SLO corrections. */
    renderExtra?: (newEndMs: number) => ReactNode;
}

/** Shared "move the end later" dialog for downtimes and SLO corrections. */
export function ExtendEndModal({
    title,
    subject,
    currentEndMs,
    nowMs,
    blockedReason,
    unchangedNote,
    confirmLabel,
    isPending,
    error,
    onClose,
    onConfirm,
    renderExtra,
}: ExtendEndModalProps) {
    const baseMs = currentEndMs ?? nowMs;
    const [newEndMs, setNewEndMs] = useState<number>(baseMs + EXTEND_PRESETS[0].ms);
    const isValid = !blockedReason && Number.isFinite(newEndMs) && newEndMs > baseMs && newEndMs > nowMs + 60_000;

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            title={title}
            hasFooterSeparator
            footer={
                <div className="modal-footer-right">
                    <Button label="Close" onClick={onClose} isDisabled={isPending} />
                    <Button
                        isPrimary
                        label={confirmLabel}
                        isLoading={isPending}
                        isDisabled={!isValid}
                        onClick={() => onConfirm(new Date(newEndMs).toISOString())}
                    />
                </div>
            }
        >
            <Text as="p" marginBottom="sm">
                {subject} ends <Text weight="bold" as="span">{formatEnd(currentEndMs)}</Text> (
                {formatRelative(currentEndMs, nowMs)}).
            </Text>
            {blockedReason ? (
                <MessageBox level="warning">{blockedReason}</MessageBox>
            ) : (
                <>
                    <div className="match-list extend-presets">
                        {EXTEND_PRESETS.map((preset) => (
                            <Button
                                key={preset.label}
                                size="sm"
                                label={preset.label}
                                isActive={newEndMs === baseMs + preset.ms}
                                onClick={() => setNewEndMs(baseMs + preset.ms)}
                            />
                        ))}
                    </div>
                    <label className="extend-custom">
                        <Text size="sm" variant="secondary">
                            Or pick the new end (your local time)
                        </Text>
                        <input
                            type="datetime-local"
                            className="datetime-input"
                            value={toLocalInputValue(newEndMs)}
                            min={toLocalInputValue(Math.max(baseMs, nowMs) + 60_000)}
                            onChange={(event) => setNewEndMs(new Date(event.target.value).getTime())}
                        />
                    </label>
                    <MessageBox level={isValid ? 'default' : 'danger'} marginTop="sm">
                        {isValid
                            ? `New end: ${formatEnd(newEndMs)} (${formatRelative(newEndMs, nowMs)}). ${unchangedNote}`
                            : 'Pick an end time later than the current end.'}
                    </MessageBox>
                    {renderExtra?.(newEndMs)}
                </>
            )}
            {error && (
                <MessageBox level="danger" title="Extend failed" marginTop="sm">
                    {error}
                </MessageBox>
            )}
        </Modal>
    );
}

interface ExtendModalProps {
    target: { row: CoverageRow; match: DowntimeMatch };
    linked: LinkedCorrectionsState;
    nowMs: number;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (downtimeId: string, newEndIso: string, correctionIds: string[]) => void;
}

export function ExtendDowntimeModal({ target, linked, nowMs, isPending, error, onClose, onConfirm }: ExtendModalProps) {
    const [toggled, toggle] = useToggled();
    const { row, match } = target;
    return (
        <ExtendEndModal
            title="Extend downtime"
            subject={
                <>
                    The downtime on{' '}
                    <Text weight="bold" as="span">
                        {row.monitor.name}
                    </Text>
                </>
            }
            currentEndMs={match.endMs}
            nowMs={nowMs}
            blockedReason={extendBlockedReason(match)}
            unchangedNote="What it mutes and when it started stay the same."
            confirmLabel="Extend downtime"
            isPending={isPending}
            error={error}
            onClose={onClose}
            onConfirm={(newEndIso) =>
                onConfirm(match.downtime.id, newEndIso, selectedCorrectionIds(linked, toggled, 'extend', Date.parse(newEndIso)))
            }
            renderExtra={(newEndMs) => (
                <LinkedCorrectionsList state={linked} mode="extend" newEndMs={newEndMs} nowMs={nowMs} toggled={toggled} onToggle={toggle} />
            )}
        />
    );
}

export type CorrectionTarget = { view: CorrectionView; sloName: string };

interface ExtendCorrectionModalProps {
    target: CorrectionTarget;
    nowMs: number;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (correctionId: string, newEndIso: string) => void;
}

export function ExtendCorrectionModal({ target, nowMs, isPending, error, onClose, onConfirm }: ExtendCorrectionModalProps) {
    const { view, sloName } = target;
    return (
        <ExtendEndModal
            title="Extend SLO correction"
            subject={
                <>
                    The {view.correction.category} correction on{' '}
                    <Text weight="bold" as="span">
                        {sloName}
                    </Text>
                </>
            }
            currentEndMs={view.endMs}
            nowMs={nowMs}
            blockedReason={correctionExtendBlockedReason(view)}
            unchangedNote="The start stays unchanged."
            confirmLabel="Extend correction"
            isPending={isPending}
            error={error}
            onClose={onClose}
            onConfirm={(newEndIso) => onConfirm(view.correction.id, newEndIso)}
        />
    );
}

interface CancelCorrectionModalProps {
    target: CorrectionTarget;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (correctionId: string) => void;
}

export function CancelCorrectionModal({ target, isPending, error, onClose, onConfirm }: CancelCorrectionModalProps) {
    const { view, sloName } = target;
    const isScheduled = view.state === 'Scheduled';
    const appliesTo = view.correction.sloQuery ? `every SLO matching \`${view.correction.sloQuery}\`` : sloName;
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            title={isScheduled ? 'Delete scheduled SLO correction?' : 'End SLO correction now?'}
            hasFooterSeparator
            footer={
                <div className="modal-footer-right">
                    <Button label="Keep correction" onClick={onClose} isDisabled={isPending} />
                    <Button
                        level="danger"
                        isPrimary
                        label={isScheduled ? 'Delete correction' : 'End correction now'}
                        isLoading={isPending}
                        onClick={() => onConfirm(view.correction.id)}
                    />
                </div>
            }
        >
            <Text as="p" marginBottom="sm">
                {view.correction.category} correction on{' '}
                <Text weight="bold" as="span">
                    {appliesTo}
                </Text>
                , {formatStart(view.startMs)} → {formatEnd(view.endMs)}.
            </Text>
            <MessageBox level="warning" marginBottom="sm">
                {isScheduled
                    ? "It hasn't started yet, so it will be deleted. Nothing has been excluded from the SLO."
                    : 'Its end moves to now, so the SLO stops excluding time from this moment. The time already excluded stays excluded.'}
                {view.correction.sloQuery && ' This correction applies to every SLO matching its query, not only this one.'}
            </MessageBox>
            {error && (
                <MessageBox level="danger" title="Cancel failed">
                    {error}
                </MessageBox>
            )}
        </Modal>
    );
}
