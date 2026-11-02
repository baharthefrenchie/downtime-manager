/**
 * Helpers for the SLO corrections that change together with a downtime
 * (see linkedCorrections in slo.ts for the linking rule).
 */
import {
    correctionCancelBlockedReason,
    LINK_TOLERANCE_MS,
    linkedExtendBlockedReason,
    type DowntimeCorrections,
    type LinkedCorrection,
} from './slo.ts';

/** The SLO corrections linked to a downtime, or why they aren't known. */
export type LinkedCorrectionsState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; corrections: DowntimeCorrections };

/** Which linked corrections can change with the downtime, and why the others can't. */
export function linkedBlockedReason(item: LinkedCorrection, mode: 'extend' | 'cancel', newEndMs: number): string | null {
    return mode === 'extend' ? linkedExtendBlockedReason(item.view, newEndMs) : correctionCancelBlockedReason(item.view);
}

/** Corrections in the same window as the downtime are ticked until the user unticks them; overlapping ones aren't. */
export function isTicked(item: LinkedCorrection, toggled: Set<string>): boolean {
    return (item.fit === 'same-window') !== toggled.has(item.view.correction.id);
}

/** Ids of the ticked corrections that can change with the downtime. */
export function selectedCorrectionIds(
    state: LinkedCorrectionsState,
    toggled: Set<string>,
    mode: 'extend' | 'cancel',
    newEndMs: number,
): string[] {
    if (state.status !== 'ready') return [];
    return state.corrections.linked
        .filter((item) => isTicked(item, toggled) && !linkedBlockedReason(item, mode, newEndMs))
        .map((item) => item.view.correction.id);
}

/** Minutes in the same-window tolerance, for UI copy. */
export const LINK_TOLERANCE_MINUTES = LINK_TOLERANCE_MS / 60_000;

export function linkedCorrectionLabel(item: LinkedCorrection): string {
    const names = item.slos.map((slo) => slo.name);
    const query = item.view.correction.sloQuery;
    const sloPart =
        names.length === 0
            ? `SLOs matching ${query ?? 'its query'}`
            : names.length > 2
              ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
              : names.join(', ');
    return `${item.view.correction.category} correction on ${sloPart}`;
}
