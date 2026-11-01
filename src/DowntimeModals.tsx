import { useState } from 'react';

import { Modal } from '@datadog/druids/dialogs/Modal';
import { Button } from '@datadog/druids/form/Button';
import { MessageBox } from '@datadog/druids/misc/MessageBox';
import { Text } from '@datadog/druids/typography/Text';

import type { CoverageRow, DowntimeMatch } from './coverage';
import { extendBlockedReason, formatEnd, formatRelative } from './format';

interface CancelModalProps {
    target: { row: CoverageRow; match: DowntimeMatch } | null;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (downtimeId: string) => void;
}

export function CancelDowntimeModal({ target, isPending, error, onClose, onConfirm }: CancelModalProps) {
    if (!target) {
        return null;
    }
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
                        onClick={() => onConfirm(match.downtime.id)}
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
            {error && (
                <MessageBox level="danger" title="Cancel failed">
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

interface ExtendModalProps {
    target: { row: CoverageRow; match: DowntimeMatch } | null;
    nowMs: number;
    isPending: boolean;
    error: string | null;
    onClose: () => void;
    onConfirm: (downtimeId: string, newEndIso: string) => void;
}

export function ExtendDowntimeModal({ target, nowMs, isPending, error, onClose, onConfirm }: ExtendModalProps) {
    const baseMs = target?.match.endMs ?? nowMs;
    const [newEndMs, setNewEndMs] = useState<number>(baseMs + EXTEND_PRESETS[0].ms);

    if (!target) {
        return null;
    }
    const { row, match } = target;
    const blocked = extendBlockedReason(match);
    const isValid = !blocked && Number.isFinite(newEndMs) && newEndMs > baseMs && newEndMs > nowMs + 60_000;

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            title="Extend active downtime"
            hasFooterSeparator
            footer={
                <div className="modal-footer-right">
                    <Button label="Close" onClick={onClose} isDisabled={isPending} />
                    <Button
                        isPrimary
                        label="Extend downtime"
                        isLoading={isPending}
                        isDisabled={!isValid}
                        onClick={() => onConfirm(match.downtime.id, new Date(newEndMs).toISOString())}
                    />
                </div>
            }
        >
            <Text as="p" marginBottom="sm">
                Downtime <Text isMonospace as="span">{match.downtime.id}</Text> on{' '}
                <Text weight="bold" as="span">
                    {row.monitor.name}
                </Text>{' '}
                currently ends <Text weight="bold" as="span">{formatEnd(match.endMs)}</Text> (
                {formatRelative(match.endMs, nowMs)}).
            </Text>
            {blocked ? (
                <MessageBox level="warning">{blocked}</MessageBox>
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
                            ? `New end: ${formatEnd(newEndMs)} (${formatRelative(newEndMs, nowMs)}). The scope and start stay unchanged.`
                            : 'Pick an end time later than the current end.'}
                    </MessageBox>
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
