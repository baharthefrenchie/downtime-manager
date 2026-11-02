/**
 * Helpers for the SLO corrections that change together with a downtime
 * (see linkedCorrections in slo.ts for the linking rule).
 */
import {
    correctionCancelBlockedReason,
    linkedExtendBlockedReason,
    type DowntimeCorrections,
    type LinkedCorrection,
} from './slo';

/** The SLO corrections linked to a downtime, or why they aren't known. */
export type LinkedCorrectionsState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; corrections: DowntimeCorrections };

/** Which linked corrections can change with the downtime, and why the others can't. */
export function linkedBlockedReason(item: LinkedCorrection, mode: 'extend' | 'cancel', newEndMs: number): string | null {
    return mode === 'extend' ? linkedExtendBlockedReason(item.view, newEndMs) : correctionCancelBlockedReason(item.view);
}

/** Ids of the ticked corrections that can change with the downtime. */
export function selectedCorrectionIds(
    state: LinkedCorrectionsState,
    unticked: Set<string>,
    mode: 'extend' | 'cancel',
    newEndMs: number,
): string[] {
    if (state.status !== 'ready') return [];
    return state.corrections.linked
        .filter((item) => !unticked.has(item.view.correction.id) && !linkedBlockedReason(item, mode, newEndMs))
        .map((item) => item.view.correction.id);
}

export function linkedCorrectionLabel(item: LinkedCorrection): string {
    const names = item.slos.map((slo) => slo.name);
    const sloPart = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', ');
    return `${item.view.correction.category} correction on ${sloPart}`;
}
