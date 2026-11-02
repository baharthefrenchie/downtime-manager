import { useState, type ReactNode } from 'react';

import { Modal } from '@datadog/druids/dialogs/Modal';
import { Button } from '@datadog/druids/form/Button';
import { Checkbox } from '@datadog/druids/form/Checkbox';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { Text } from '@datadog/druids/typography/Text';

import type { CoverageRow, DowntimeMatch } from './coverage';
import { extendBlockedReason, formatEnd, formatRelative, formatStart } from './format';
import {
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
    unticked: Set<string>;
    onToggle: (correctionId: string, isTicked: boolean) => void;
}

/** "Also update these SLO corrections" checklist in the downtime extend and cancel dialogs. */
function LinkedCorrectionsList({ state, mode, newEndMs, unticked, onToggle }: LinkedCorrectionsListProps) {
    const heading = (
        <Text as="div" size="sm" weight="bold" marginTop="md" marginBottom="xxs">
            Linked SLO corrections
        </Text>
    );
    const scopeNote = (
        <Text as="p" size="xs" variant="tertiary" marginBottom="xs">
            One-time corrections on this downtime&apos;s related SLOs that start within 5 minutes of it. Recurring
            corrections are never changed here; edit them in Datadog.
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
    return (
        <>
            {heading}
            {scopeNote}
            {linked.length === 0 ? (
                <Text as="p" size="sm" variant="secondary">
                    No linked one-time SLO correction. Only the downtime will change.
                </Text>
            ) : (
                <div className="linked-corrections">
                    {linked.map((item) => {
                        const id = item.view.correction.id;
                        const blocked = linkedBlockedReason(item, mode, newEndMs);
                        const action =
                            mode === 'extend'
                                ? `Extend to ${formatEnd(newEndMs)}`
                                : item.view.state === 'Scheduled'
                                  ? "Delete (it hasn't started)"
                                  : 'End now';
                        return (
                            <Checkbox
                                key={id}
                                isChecked={!blocked && !unticked.has(id)}
                                isDisabled={Boolean(blocked)}
                                onChange={(event) => onToggle(id, event.target.checked)}
                                label={
                                    <span className="cell-stack">
                                        <Text size="sm">{linkedCorrectionLabel(item)}</Text>
                                        <Text size="xs" variant="tertiary">
                                            {item.view.state} · {formatStart(item.view.startMs)} → {formatEnd(item.view.endMs)} ·{' '}
                                            {blocked ?? action}
                                        </Text>
                                    </span>
                                }
                            />
                        );
                    })}
                </div>
            )}
            {recurring.length > 0 && (
                <Text as="p" size="xs" variant="tertiary" marginTop="xs">
                    {recurring.length} recurring correction{recurring.length === 1 ? '' : 's'} on these SLOs{' '}
                    {recurring.length === 1 ? "isn't" : "aren't"} changed.
                </Text>
            )}
            <Text as="p" size="xs" variant="tertiary" marginTop="xs">
                The downtime changes first, then each ticked correction. If a correction fails, the downtime change is
                kept and the result lists what failed.
            </Text>
        </>
    );
}

function useUnticked() {
    const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
    const toggle = (id: string, isTicked: boolean) =>
        setUnticked((previous) => {
            const next = new Set(previous);
            if (isTicked) next.delete(id);
            else next.add(id);
            return next;
        });
    return [unticked, toggle] as const;
}

interface CancelModalProps {
    target: { row: CoverageRow; match: DowntimeMatch };
    linked: LinkedCorrectionsState;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (downtimeId: string, correctionIds: string[]) => void;
}

export function CancelDowntimeModal({ target, linked, isPending, error, onClose, onConfirm }: CancelModalProps) {
    const [unticked, toggle] = useUnticked();
    const { row, match } = target;
    const otherMonitorsNote =
        match.kind === 'direct'
            ? 'This downtime targets only this monitor.'
            : 'This downtime is tag/scope-based and may also be muting other monitors. Canceling it un-mutes all of them.';

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            title="Cancel active downtime?"
            hasFooterSeparator
            footer={
                <div className="modal-footer-right">
                    <Button label="Keep downtime" onClick={onClose} isDisabled={isPending} />
                    <Button
                        level="danger"
                        isPrimary
                        label="Cancel downtime"
                        isLoading={isPending}
                        onClick={() => onConfirm(match.downtime.id, selectedCorrectionIds(linked, unticked, 'cancel', 0))}
                    />
                </div>
            }
        >
            <Text as="p" marginBottom="sm">
                You are about to cancel downtime <Text isMonospace as="span">{match.downtime.id}</Text> covering{' '}
                <Text weight="bold" as="span">
                    {row.monitor.name}
                </Text>
                . Alerts will resume notifying immediately.
            </Text>
            <MessageBox level="warning" marginBottom="sm">
                {otherMonitorsNote} Scope:{' '}
                <Text isMonospace as="span">
                    {match.downtime.scope || '*'}
                </Text> · Ends: {formatEnd(match.endMs)}
            </MessageBox>
            {row.matches.length > 1 && (
                <Text as="p" variant="secondary" size="sm" marginBottom="sm">
                    {row.matches.length - 1} other active downtime(s) also cover this monitor and will remain in effect.
                </Text>
            )}
            <LinkedCorrectionsList state={linked} mode="cancel" newEndMs={0} unticked={unticked} onToggle={toggle} />
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
                {subject} currently ends <Text weight="bold" as="span">{formatEnd(currentEndMs)}</Text> (
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
                            Or pick a new end (your local time)
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
    const [unticked, toggle] = useUnticked();
    const { row, match } = target;
    return (
        <ExtendEndModal
            title="Extend active downtime"
            subject={
                <>
                    Downtime <Text isMonospace as="span">{match.downtime.id}</Text> on{' '}
                    <Text weight="bold" as="span">
                        {row.monitor.name}
                    </Text>
                </>
            }
            currentEndMs={match.endMs}
            nowMs={nowMs}
            blockedReason={extendBlockedReason(match)}
            unchangedNote="The scope and start stay unchanged."
            confirmLabel="Extend downtime"
            isPending={isPending}
            error={error}
            onClose={onClose}
            onConfirm={(newEndIso) =>
                onConfirm(match.downtime.id, newEndIso, selectedCorrectionIds(linked, unticked, 'extend', Date.parse(newEndIso)))
            }
            renderExtra={(newEndMs) => (
                <LinkedCorrectionsList state={linked} mode="extend" newEndMs={newEndMs} unticked={unticked} onToggle={toggle} />
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
