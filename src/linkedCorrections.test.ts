import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTicked, selectedCorrectionIds, type LinkedCorrectionsState } from './linkedCorrections.ts';
import { correctionView, type LinkedCorrection, type SloCorrectionSummary } from './slo.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const nowS = NOW / 1000;

const item = (id: string, fit: LinkedCorrection['fit'], end = nowS + 3600): LinkedCorrection => {
    const correction: SloCorrectionSummary = {
        id,
        sloId: 'a',
        sloQuery: null,
        category: 'Scheduled Maintenance',
        description: null,
        start: nowS - 3600,
        end,
        duration: null,
        rrule: null,
        timezone: 'UTC',
        creator: null,
    };
    return { view: correctionView(correction, NOW), slos: [], reason: 'related-slo', fit };
};

describe('linked correction ticks', () => {
    const same = item('same', 'same-window');
    const overlap = item('overlap', 'overlaps');
    const state: LinkedCorrectionsState = { status: 'ready', corrections: { linked: [same, overlap], recurring: [] } };

    it('ticks same-window corrections and leaves overlapping ones unticked by default', () => {
        assert.equal(isTicked(same, new Set()), true);
        assert.equal(isTicked(overlap, new Set()), false);
        assert.deepEqual(selectedCorrectionIds(state, new Set(), 'cancel', 0), ['same']);
    });

    it('flips either default when the user toggles it', () => {
        assert.deepEqual(selectedCorrectionIds(state, new Set(['same', 'overlap']), 'cancel', 0), ['overlap']);
        assert.deepEqual(selectedCorrectionIds(state, new Set(['overlap']), 'cancel', 0), ['same', 'overlap']);
    });

    it("leaves out ticked corrections that can't move to the new end", () => {
        assert.deepEqual(selectedCorrectionIds(state, new Set(['overlap']), 'extend', NOW + 1800_000), []);
        assert.deepEqual(selectedCorrectionIds(state, new Set(['overlap']), 'extend', NOW + 7200_000), ['same', 'overlap']);
    });
});
