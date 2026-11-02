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
    correctionFit,
    LINK_TOLERANCE_MS,
    linkedCorrections,
    linkedExtendBlockedReason,
    queryMatchesMonitorTags,
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

    it('relates count-based SLOs to a monitor-ID downtime by its group scope', () => {
        const [row] = rowsFor([monitor(2, ['project:gen2'])], [downtime('d', { monitorId: 2, scope: 'project:gen2' })]);
        assert.deepEqual(relatedSlos(row, [...customerSlos, slo('uses-2', { monitorIds: [2] })]).map((r) => r.slo.id), [
            'both',
            'scope-only',
            'uses-2',
        ]);
        // An environment alone doesn't say which service is affected.
        const envOnlySlo = slo('env-dev', { type: 'metric', tags: ['env:dev', 'service:a'] });
        const [envOnly] = rowsFor([monitor(4, ['env:dev'])], [downtime('d', { monitorId: 4, scope: 'env:dev' })]);
        assert.deepEqual(relatedSlos(envOnly, [envOnlySlo]), []);
        const [envAndService] = rowsFor([monitor(5, ['env:dev'])], [downtime('d', { monitorId: 5, scope: 'env:dev service:a' })]);
        assert.deepEqual(relatedSlos(envAndService, [envOnlySlo]).map((r) => r.slo.id), ['env-dev']);
        // A whole-monitor downtime on a monitor ID carries no tags: only SLOs built on the monitor.
        const [whole] = rowsFor([monitor(3, ['project:gen2'])], [downtime('d', { monitorId: 3 })]);
        assert.deepEqual(relatedSlos(whole, [...customerSlos, slo('uses-3', { monitorIds: [3] })]).map((r) => r.slo.id), ['uses-3']);
    });

    it('relates monitor-based SLOs only through their own monitors, whatever their tags', () => {
        // The SLO carries the scope and tags but is built on other monitors, so muting monitor 1 doesn't affect it.
        const otherMonitors = slo('other-monitors', { monitorIds: [8, 9], tags: ['project:gen2', 'env:prod'] });
        assert.deepEqual(relatedSlos(gen2(), [otherMonitors]), []);
        assert.deepEqual(relatedSlos(gen2(), [otherMonitors], 'strict'), []);
        const uses1 = slo('uses-1', { monitorIds: [1], tags: ['team:other'] });
        assert.deepEqual(relatedSlos(gen2(), [uses1]).map((r) => [r.slo.id, r.relation]), [['uses-1', 'Monitor-based SLO']]);
    });

    it('relates time-slice SLOs by tags like count-based ones', () => {
        const timeSlice = slo('ts', { type: 'time_slice', tags: ['project:gen2'] });
        assert.deepEqual(relatedSlos(gen2(), [timeSlice]).map((r) => [r.slo.id, r.relation]), [['ts', 'Shares downtime scope']]);
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
    const downtimeEndS = nowS + 3 * HOUR;
    const gen2Slo = slo('gen2', { type: 'metric', tags: ['project:gen2'] });
    const otherSlo = slo('other', { type: 'metric', tags: ['project:gen3'] });
    const at = (startMs: number | null, monitorTags: string[] = [], endMs: number | null = downtimeEndS * 1000) => ({
        startMs,
        endMs,
        monitorTags,
    });
    const linkedFits = (corrections: SloCorrectionSummary[], slos = [gen2Slo], downtime = at(downtimeStartS * 1000)) =>
        linkedCorrections(downtime, slos, slos, corrections, NOW).linked.map((l) => `${l.view.correction.id}:${l.fit}`);
    const linkedIds = (corrections: SloCorrectionSummary[], slos = [gen2Slo]) =>
        linkedCorrections(at(downtimeStartS * 1000), slos, slos, corrections, NOW).linked.map((l) => l.view.correction.id);

    it('puts corrections starting or ending within 15 minutes of the downtime in its window', () => {
        assert.equal(LINK_TOLERANCE_MS, 15 * 60_000);
        assert.deepEqual(
            linkedFits([
                correction('exact', { sloId: 'gen2', start: downtimeStartS }),
                correction('14m-early', { sloId: 'gen2', start: downtimeStartS - 14 * MIN }),
                correction('16m-late', { sloId: 'gen2', start: downtimeStartS + 16 * MIN }),
                correction('same-end', { sloId: 'gen2', start: downtimeStartS - 5 * HOUR, end: downtimeEndS + 10 * MIN }),
            ]),
            ['same-end:same-window', '14m-early:same-window', 'exact:same-window', '16m-late:overlaps'],
        );
    });

    it('links a whole-day correction to a downtime that ends with it (midnight to midnight)', () => {
        // The reported case: a 2-hour downtime from 20:02:54Z, and corrections from 22:00Z the day before to 22:00Z.
        const dtStart = Date.parse('2026-11-02T20:02:54Z');
        const dtEnd = Date.parse('2026-11-02T22:02:54Z');
        const day = { start: Date.parse('2026-11-01T22:00:00Z') / 1000, end: Date.parse('2026-11-02T22:00:00Z') / 1000 };
        const result = linkedCorrections(
            { startMs: dtStart, endMs: dtEnd, monitorTags: [] },
            [gen2Slo],
            [gen2Slo],
            [correction('day', { sloId: 'gen2', ...day })],
            dtStart + 4 * MIN * 1000,
        );
        assert.deepEqual(result.linked.map((l) => l.fit), ['same-window']);
    });

    it('lists corrections that only overlap the downtime, to be ticked by hand', () => {
        assert.deepEqual(
            linkedFits([correction('long', { sloId: 'gen2', start: downtimeStartS - 2 * HOUR, end: nowS + 10 * HOUR })]),
            ['long:overlaps'],
        );
        // An open-ended downtime overlaps every correction that hasn't ended.
        assert.deepEqual(
            linkedFits([correction('later', { sloId: 'gen2', start: nowS + 5 * HOUR, end: nowS + 6 * HOUR })], [gen2Slo], at(downtimeStartS * 1000, [], null)),
            ['later:overlaps'],
        );
    });

    it('skips corrections outside the downtime window', () => {
        assert.deepEqual(linkedIds([correction('after', { sloId: 'gen2', start: downtimeEndS, end: downtimeEndS + HOUR })]), []);
        assert.deepEqual(linkedIds([correction('ended', { sloId: 'gen2', start: downtimeStartS, end: nowS - 60 })]), []);
        assert.equal(correctionFit({ startMs: 1000, endMs: 2000 }, { startMs: 0, endMs: 1000 }), null);
        assert.equal(correctionFit({ startMs: 1000, endMs: 2000 }, { startMs: null, endMs: 1500 }), null);
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
        const result = linkedCorrections(at(downtimeStartS * 1000), [gen2Slo], [gen2Slo], [recurring], NOW);
        assert.deepEqual(result.linked, []);
        assert.deepEqual(result.recurring.map((r) => r.view.correction.id), ['weekly']);
    });

    it('links nothing when no correction matches', () => {
        assert.deepEqual(linkedIds([correction('c', { sloId: 'gen2', start: downtimeStartS })], [otherSlo]), []);
        assert.deepEqual(linkedIds([correction('c', { sloId: 'gen2', start: downtimeStartS })], []), []);
        // A downtime without a start can still overlap, but never shares a start.
        assert.deepEqual(
            linkedFits([correction('c', { sloId: 'gen2' })], [gen2Slo], at(null)),
            ['c:overlaps'],
        );
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

describe('corrections created from a downtime in Datadog', () => {
    const startS = nowS - HOUR;
    const tags = ['env:prod', 'service:web-store'];
    const countSlo = slo('count', { type: 'metric', tags: ['env:prod', 'service:web-store', 'team:shop'] });
    const fromDowntime = (overrides: Partial<SloCorrectionSummary> = {}) =>
        correction('dd', { sloId: null, sloQuery: 'service:web-store env:prod', start: startS, ...overrides });
    const link = (correctionList: SloCorrectionSummary[], related: SloSummary[] = []) =>
        linkedCorrections({ startMs: startS * 1000, endMs: nowS * 1000 + 3 * HOUR * 1000, monitorTags: tags }, related, [countSlo], correctionList, NOW).linked;

    it('matches a query equal to the monitor tags, in any order and case', () => {
        assert.equal(queryMatchesMonitorTags('service:web-store env:prod', tags), true);
        assert.equal(queryMatchesMonitorTags('ENV:prod AND service:web-store', tags), true);
        assert.equal(queryMatchesMonitorTags('env:prod', tags), false);
        assert.equal(queryMatchesMonitorTags('env:prod OR service:web-store', tags), false);
        assert.equal(queryMatchesMonitorTags('env:prod service:web-store -team:x', tags), false);
        assert.equal(queryMatchesMonitorTags('env:prod', ['*']), false);
    });

    it('links it even when the scope relates none of its SLOs, and lists the SLOs it matches', () => {
        const [item] = link([fromDowntime()]);
        assert.equal(item.reason, 'from-downtime');
        assert.deepEqual(item.slos.map((s) => s.id), ['count']);
    });

    it('ticks it only in the same window, and ignores other queries and single-SLO corrections', () => {
        assert.deepEqual(link([fromDowntime({ start: startS + 20 * 60 })]).map((l) => l.fit), ['overlaps']);
        assert.deepEqual(link([fromDowntime({ sloQuery: 'service:checkout env:prod' })]), []);
        assert.deepEqual(link([correction('by-id', { sloId: 'count', start: startS })]), []);
    });

    it('prefers the related-SLO reason when the correction also targets a related SLO', () => {
        const [item] = link([fromDowntime()], [countSlo]);
        assert.equal(item.reason, 'related-slo');
    });
});
