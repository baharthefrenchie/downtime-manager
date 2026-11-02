import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCoverageRows, type LiveDowntime, type LiveMonitor } from './coverage.ts';
import { describeRrule } from './format.ts';
import {
    correctionAppliesTo,
    correctionCancelBlockedReason,
    correctionExtendBlockedReason,
    correctionView,
    currentCorrections,
    relatedSlos,
    type SloCorrectionSummary,
    type SloSummary,
} from './slo.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3600;
const nowS = NOW / 1000;

const monitor = (id: number, tags: string[] = []): LiveMonitor => ({
    id,
    name: `monitor ${id}`,
    type: 'metric alert',
    overallState: 'OK',
    tags,
    creatorName: null,
    creatorHandle: null,
    creatorEmail: null,
});

const downtime = (id: string, overrides: Partial<LiveDowntime>): LiveDowntime => ({
    id,
    status: 'active',
    message: null,
    scope: '*',
    displayTimezone: 'UTC',
    monitorId: null,
    monitorTags: [],
    start: new Date(NOW - 3_600_000).toISOString(),
    end: null,
    isRecurring: false,
    createdById: null,
    created: null,
    url: null,
    ...overrides,
});

const slo = (id: string, overrides: Partial<SloSummary> = {}): SloSummary => ({
    id,
    name: `SLO ${id}`,
    type: 'monitor',
    monitorIds: [],
    tags: [],
    sli: 99.9,
    errorBudgetRemaining: 50,
    target: 99,
    timeframe: '30d',
    ...overrides,
});

const correction = (id: string, overrides: Partial<SloCorrectionSummary> = {}): SloCorrectionSummary => ({
    id,
    sloId: 'a',
    sloQuery: null,
    category: 'Scheduled Maintenance',
    description: null,
    start: nowS - HOUR,
    end: nowS + HOUR,
    duration: null,
    rrule: null,
    timezone: 'UTC',
    creator: null,
    ...overrides,
});

const rowsFor = (monitors: LiveMonitor[], downtimes: LiveDowntime[]) =>
    buildCoverageRows({ monitors, downtimes, fetchedAt: new Date(NOW).toISOString() }, NOW);

describe('relatedSlos', () => {
    it('relates monitor-based SLOs that use the monitor, whatever the coverage source', () => {
        const [row] = rowsFor([monitor(1)], [downtime('d', { monitorId: 1 })]);
        const related = relatedSlos(row, [slo('a', { monitorIds: [1, 2] }), slo('b', { monitorIds: [3] })]);
        assert.deepEqual(related.map((r) => [r.slo.id, r.relation]), [['a', 'Monitor-based SLO']]);
    });

    it('relates SLOs by tags only when coverage is tag/scope-based, requiring every downtime term', () => {
        const slos = [
            slo('both', { type: 'metric', tags: ['service:api', 'env:prod'] }),
            slo('one', { type: 'metric', tags: ['service:api'] }),
        ];
        const [tagRow] = rowsFor([monitor(1, ['service:api', 'env:prod'])], [downtime('t', { monitorTags: ['service:api'], scope: 'env:prod' })]);
        assert.deepEqual(relatedSlos(tagRow, slos).map((r) => [r.slo.id, r.relation, r.matchedTags]), [
            ['both', 'Shares downtime tags', ['service:api', 'env:prod']],
        ]);

        const [directRow] = rowsFor([monitor(2, ['service:api', 'env:prod'])], [downtime('d', { monitorId: 2, scope: 'env:prod' })]);
        assert.deepEqual(relatedSlos(directRow, slos), []);
    });
});

describe('SLO corrections', () => {
    it('applies by SLO id, or by a tag query the SLO satisfies', () => {
        const target = slo('a', { tags: ['service:web-store', 'env:prod'] });
        assert.equal(correctionAppliesTo(correction('1'), target), true);
        assert.equal(correctionAppliesTo(correction('2', { sloId: 'other' }), target), false);
        assert.equal(correctionAppliesTo(correction('3', { sloId: null, sloQuery: 'service:web-store' }), target), true);
        assert.equal(correctionAppliesTo(correction('4', { sloId: null, sloQuery: 'service:checkout' }), target), false);
    });

    it('classifies active, scheduled, recurring and ended corrections with their duration', () => {
        const active = correctionView(correction('a'), NOW);
        assert.equal(active.state, 'Active');
        assert.equal(active.durationMs, 2 * HOUR * 1000);
        assert.equal(correctionView(correction('s', { start: nowS + HOUR, end: nowS + 2 * HOUR }), NOW).state, 'Scheduled');
        assert.equal(correctionView(correction('e', { start: nowS - 2 * HOUR, end: nowS - HOUR }), NOW).state, 'Ended');
        const recurring = correctionView(correction('r', { rrule: 'FREQ=WEEKLY;INTERVAL=1', end: null, duration: HOUR }), NOW);
        assert.equal(recurring.state, 'Recurring');
        assert.equal(recurring.durationMs, HOUR * 1000);
    });

    it('lists current corrections, active first, and leaves out ended ones', () => {
        const views = currentCorrections(
            slo('a'),
            [
                correction('scheduled', { start: nowS + HOUR, end: nowS + 2 * HOUR }),
                correction('ended', { start: nowS - 2 * HOUR, end: nowS - HOUR }),
                correction('active'),
            ],
            NOW,
        );
        assert.deepEqual(views.map((v) => v.correction.id), ['active', 'scheduled']);
    });

    it('only allows extending and canceling one-time corrections', () => {
        const recurring = correctionView(correction('r', { rrule: 'FREQ=DAILY', end: null, duration: HOUR }), NOW);
        assert.match(correctionExtendBlockedReason(recurring) ?? '', /Recurring/);
        assert.match(correctionCancelBlockedReason(recurring) ?? '', /Recurring/);
        const active = correctionView(correction('a'), NOW);
        assert.equal(correctionExtendBlockedReason(active), null);
        assert.equal(correctionCancelBlockedReason(active), null);
    });

    it('describes common recurrence rules', () => {
        assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=1'), 'weekly');
        assert.equal(describeRrule('FREQ=DAILY;INTERVAL=2'), 'every 2 days');
        assert.equal(describeRrule('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU'), 'weekly on MO,TU');
    });
});
