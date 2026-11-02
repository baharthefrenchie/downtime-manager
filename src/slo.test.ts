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
    downtimeRelatedSlos,
    LINK_START_TOLERANCE_MS,
    linkedCorrections,
    linkedExtendBlockedReason,
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

    // The customer's pattern: By Monitor Tags downtime [env:prod] with group scope project:gen2.
    const gen2 = () => rowsFor([monitor(1, ['env:prod', 'project:gen2'])], [downtime('t', { monitorTags: ['env:prod'], scope: 'project:gen2' })])[0];
    const customerSlos = [
        slo('scope-only', { type: 'metric', tags: ['project:gen2', 'team:sre'] }),
        slo('both', { type: 'metric', tags: ['project:gen2', 'env:prod'] }),
        slo('tags-only', { type: 'metric', tags: ['env:prod'] }),
        slo('other', { type: 'metric', tags: ['project:gen3', 'env:prod'] }),
    ];

    it('relates SLOs that carry the group scope, without requiring the monitor tags (default)', () => {
        assert.deepEqual(relatedSlos(gen2(), customerSlos).map((r) => [r.slo.id, r.relation, r.matchedTags]), [
            ['both', 'Shares downtime scope', ['project:gen2']],
            ['scope-only', 'Shares downtime scope', ['project:gen2']],
        ]);
    });

    it('strict mode requires every monitor tag and every scope term', () => {
        assert.deepEqual(relatedSlos(gen2(), customerSlos, 'strict').map((r) => [r.slo.id, r.relation, r.matchedTags]), [
            ['both', 'Shares downtime tags', ['env:prod', 'project:gen2']],
        ]);
    });

    it('falls back to the monitor tags when the scope is * or empty', () => {
        for (const scope of ['*', '', null]) {
            const [row] = rowsFor([monitor(1, ['env:prod'])], [downtime('t', { monitorTags: ['env:prod'], scope })]);
            assert.deepEqual(relatedSlos(row, customerSlos).map((r) => [r.slo.id, r.relation]), [
                ['both', 'Shares downtime tags'],
                ['other', 'Shares downtime tags'],
                ['tags-only', 'Shares downtime tags'],
            ], String(scope));
        }
    });

    it('never requires a negated scope term', () => {
        for (const scope of ['project:gen2 -project:x', 'project:gen2 AND NOT project:x']) {
            const [row] = rowsFor([monitor(1, ['env:prod', 'project:gen2'])], [downtime('t', { monitorTags: ['env:prod'], scope })]);
            assert.deepEqual(relatedSlos(row, customerSlos).map((r) => [r.slo.id, r.matchedTags]), [
                ['both', ['project:gen2']],
                ['scope-only', ['project:gen2']],
            ], scope);
        }
    });

    it('relates an SLO carrying either side of an OR scope', () => {
        const [row] = rowsFor([monitor(1, ['project:gen3'])], [downtime('t', { monitorTags: ['*'], scope: 'project:gen2 OR project:gen3' })]);
        assert.deepEqual(relatedSlos(row, customerSlos).map((r) => r.slo.id), ['both', 'other', 'scope-only']);
    });

    it('only relates monitor-based SLOs for direct downtimes', () => {
        const [row] = rowsFor([monitor(2, ['project:gen2'])], [downtime('d', { monitorId: 2, scope: 'project:gen2' })]);
        assert.deepEqual(relatedSlos(row, [...customerSlos, slo('uses-2', { monitorIds: [2] })]).map((r) => r.slo.id), ['uses-2']);
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

describe('corrections linked to a downtime', () => {
    const MIN = 60;
    const downtimeStartS = nowS - HOUR;
    const gen2Slo = slo('gen2', { type: 'metric', tags: ['project:gen2'] });
    const otherSlo = slo('other', { type: 'metric', tags: ['project:gen3'] });
    const linkedIds = (corrections: SloCorrectionSummary[], slos = [gen2Slo]) =>
        linkedCorrections(downtimeStartS * 1000, slos, corrections, NOW).linked.map((l) => l.view.correction.id);

    it('links one-time corrections starting within 5 minutes of the downtime', () => {
        assert.equal(LINK_START_TOLERANCE_MS, 5 * 60_000);
        assert.deepEqual(
            linkedIds([
                correction('exact', { sloId: 'gen2', start: downtimeStartS }),
                correction('4m-early', { sloId: 'gen2', start: downtimeStartS - 4 * MIN }),
                correction('5m-late', { sloId: 'gen2', start: downtimeStartS + 5 * MIN }),
                correction('6m-late', { sloId: 'gen2', start: downtimeStartS + 6 * MIN }),
                correction('1h-early', { sloId: 'gen2', start: downtimeStartS - HOUR }),
            ]),
            ['4m-early', 'exact', '5m-late'],
        );
    });

    it('matches by SLO id or by a tag query on the related SLOs', () => {
        assert.deepEqual(
            linkedIds([
                correction('by-query', { sloId: null, sloQuery: 'project:gen2', start: downtimeStartS }),
                correction('wrong-query', { sloId: null, sloQuery: 'project:gen3', start: downtimeStartS }),
                correction('wrong-slo', { sloId: 'other', start: downtimeStartS }),
            ]),
            ['by-query'],
        );
    });

    it('never links recurring corrections, but reports them', () => {
        const recurring = correction('weekly', { sloId: 'gen2', start: downtimeStartS, end: null, duration: HOUR, rrule: 'FREQ=WEEKLY' });
        const result = linkedCorrections(downtimeStartS * 1000, [gen2Slo], [recurring], NOW);
        assert.deepEqual(result.linked, []);
        assert.deepEqual(result.recurring.map((r) => r.view.correction.id), ['weekly']);
    });

    it('links nothing when no correction matches', () => {
        assert.deepEqual(linkedIds([correction('ended', { sloId: 'gen2', start: downtimeStartS, end: nowS - 60 })]), []);
        assert.deepEqual(linkedIds([correction('c', { sloId: 'gen2', start: downtimeStartS })], [otherSlo]), []);
        assert.deepEqual(linkedIds([correction('c', { sloId: 'gen2', start: downtimeStartS })], []), []);
        assert.deepEqual(linkedCorrections(null, [gen2Slo], [correction('c', { sloId: 'gen2' })], NOW).linked, []);
    });

    it('uses the SLOs related through that downtime only', () => {
        const rows = rowsFor(
            [monitor(1, ['env:prod', 'project:gen2']), monitor(2, ['env:staging'])],
            [downtime('t', { monitorTags: ['env:prod'], scope: 'project:gen2' }), downtime('d', { monitorId: 2 })],
        );
        const slos = [gen2Slo, otherSlo, slo('uses-2', { monitorIds: [2] })];
        assert.deepEqual(downtimeRelatedSlos('t', rows, slos).map((s) => s.id), ['gen2']);
        assert.deepEqual(downtimeRelatedSlos('d', rows, slos).map((s) => s.id), ['uses-2']);
    });

    it("won't move a correction's end earlier when extending with the downtime", () => {
        const view = correctionView(correction('c', { start: downtimeStartS, end: nowS + 2 * HOUR }), NOW);
        assert.equal(linkedExtendBlockedReason(view, NOW + 3 * HOUR * 1000), null);
        assert.match(linkedExtendBlockedReason(view, NOW + HOUR * 1000) ?? '', /Already ends/);
    });
});
