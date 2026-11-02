/**
 * Unit tests for the coverage matching rules. Run with `npm test`
 * (Node's built-in test runner; Node 24 runs TypeScript directly).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildCoverageRows,
    evaluateScope,
    isActiveDowntime,
    parseScope,
    positiveScopeTerms,
    toValidMs,
    isPlaceholderRow,
    windowStateOf,
    type DatadogDowntimeMatch,
    type LiveDowntime,
    type LiveMonitor,
    type LiveSnapshot,
} from './coverage.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function monitor(id: number, tags: string[] = []): LiveMonitor {
    return {
        id,
        name: `monitor ${id}`,
        type: 'metric alert',
        overallState: 'OK',
        tags,
        creatorName: 'Alice',
        creatorHandle: 'alice@example.com',
        creatorEmail: null,
    };
}

function downtime(id: string, overrides: Partial<LiveDowntime> = {}): LiveDowntime {
    return {
        id,
        status: 'active',
        message: null,
        scope: '*',
        displayTimezone: 'UTC',
        monitorId: null,
        monitorTags: [],
        start: new Date(NOW - 2 * HOUR).toISOString(),
        end: null,
        isRecurring: false,
        createdById: null,
        created: null,
        url: null,
        ...overrides,
    };
}

function rows(monitors: LiveMonitor[], downtimes: LiveDowntime[], verified?: Record<string, DatadogDowntimeMatch[]>) {
    const snapshot: LiveSnapshot = { monitors, downtimes, fetchedAt: new Date(NOW).toISOString() };
    return buildCoverageRows(snapshot, NOW, {}, verified);
}

describe('isActiveDowntime', () => {
    it('requires status active, a past-or-missing start and a future-or-missing end', () => {
        assert.equal(isActiveDowntime(downtime('a'), NOW), true);
        assert.equal(isActiveDowntime(downtime('b', { start: null }), NOW), true);
        assert.equal(isActiveDowntime(downtime('c', { status: 'canceled' }), NOW), false);
        assert.equal(isActiveDowntime(downtime('d', { status: 'scheduled' }), NOW), false);
        assert.equal(isActiveDowntime(downtime('e', { status: 'ended' }), NOW), false);
        assert.equal(isActiveDowntime(downtime('f', { start: new Date(NOW + HOUR).toISOString() }), NOW), false);
        assert.equal(isActiveDowntime(downtime('g', { end: new Date(NOW - HOUR).toISOString() }), NOW), false);
    });
});

describe('toValidMs', () => {
    it('treats epoch-zero / pre-2000 values as missing (no 1970 end dates)', () => {
        assert.equal(toValidMs('1970-01-01T00:00:00Z'), null);
        assert.equal(toValidMs(0), null);
        assert.equal(toValidMs(''), null);
        assert.equal(toValidMs(null), null);
    });
    it('accepts ISO strings and epoch seconds or milliseconds', () => {
        assert.equal(toValidMs('2026-11-01T12:00:00Z'), NOW);
        assert.equal(toValidMs(NOW / 1000), NOW);
        assert.equal(toValidMs(NOW), NOW);
    });
});

describe('buildCoverageRows', () => {
    it('matches downtimes directly by monitor id', () => {
        const [row, ...rest] = rows([monitor(1), monitor(2)], [downtime('d1', { monitorId: 1 })]);
        assert.equal(rest.length, 0);
        assert.equal(row.monitor.id, 1);
        assert.equal(row.source, 'Direct (monitor ID)');
        assert.equal(row.maintenanceState, 'Whole monitor');
    });

    it('matches by monitor tags only when every downtime tag is on the monitor', () => {
        const result = rows(
            [monitor(1, ['service:api', 'env:prod']), monitor(2, ['service:api'])],
            [downtime('t1', { monitorTags: ['service:api', 'env:prod'] })],
        );
        assert.deepEqual(
            result.map((r) => r.monitor.id),
            [1],
        );
        assert.equal(result[0].source, 'Tag/Scope-based');
    });

    it('matches wildcard monitor tags by scope against monitor tags', () => {
        const result = rows(
            [monitor(1, ['env:staging']), monitor(2, ['env:prod'])],
            [downtime('s1', { monitorTags: ['*'], scope: 'env:staging' })],
        );
        assert.deepEqual(
            result.map((r) => r.monitor.id),
            [1],
        );
    });

    it('excludes monitors whose only downtimes are ended, canceled or not started yet', () => {
        const result = rows(
            [monitor(1)],
            [
                downtime('ended', { monitorId: 1, end: new Date(NOW - HOUR).toISOString() }),
                downtime('canceled', { monitorId: 1, status: 'canceled' }),
                downtime('future', { monitorId: 1, start: new Date(NOW + HOUR).toISOString() }),
                downtime('scheduled', { monitorId: 1, status: 'scheduled' }),
            ],
        );
        assert.equal(result.length, 0);
    });

    it('marks group-scoped direct downtimes as Groups only', () => {
        const [row] = rows([monitor(1)], [downtime('g1', { monitorId: 1, scope: 'host:a' })]);
        assert.equal(row.maintenanceState, 'Groups only');
    });

    it('marks rows Not muting when Datadog does not report the monitor as muted', () => {
        const scoped = [downtime('g1', { monitorId: 1, scope: 'host:a' })];
        const base = { monitors: [monitor(1)], downtimes: scoped, fetchedAt: new Date(NOW).toISOString() };
        const [notMuted] = buildCoverageRows({ ...base, datadogMutedIds: [] }, NOW);
        assert.equal(notMuted.maintenanceState, 'Not muting');
        const [muted] = buildCoverageRows({ ...base, datadogMutedIds: [1] }, NOW);
        assert.equal(muted.maintenanceState, 'Groups only');
    });

    it('shows Datadog-muted monitors without a listed downtime, then fills in their downtimes', () => {
        const snapshot: LiveSnapshot = {
            monitors: [monitor(1), monitor(2)],
            downtimes: [],
            datadogMutedIds: [1],
            fetchedAt: new Date(NOW).toISOString(),
        };
        const [placeholder, ...none] = buildCoverageRows(snapshot, NOW);
        assert.equal(none.length, 0);
        assert.equal(placeholder.monitor.id, 1);
        assert.equal(isPlaceholderRow(placeholder), true);
        assert.equal(placeholder.windowState, 'Unknown');
        assert.equal(placeholder.maintenanceState, 'Groups only');

        const auto = { id: 'auto1', scope: 'host:"i-123"', groups: ['host:i-123'], start: new Date(NOW - DAY).toISOString(), end: null };
        const [row] = buildCoverageRows(snapshot, NOW, {}, { '1': [auto] });
        assert.equal(isPlaceholderRow(row), false);
        assert.equal(row.primary.downtime.id, 'auto1');
        assert.equal(row.primary.downtime.fromDatadogMatch, true);
        assert.equal(row.windowState, 'Open-ended');
    });

    it('prefers the direct downtime as the primary when several match', () => {
        const [row] = rows(
            [monitor(1, ['team:db'])],
            [downtime('tag', { monitorTags: ['team:db'] }), downtime('direct', { monitorId: 1 })],
        );
        assert.equal(row.primary.downtime.id, 'direct');
        assert.equal(row.source, 'Direct + Tag/Scope');
        assert.equal(row.matches.length, 2);
    });
});

describe('windowStateOf', () => {
    it('classifies ending soon, scheduled end, open-ended and stale windows', () => {
        assert.equal(windowStateOf({ startMs: NOW - HOUR, endMs: NOW + HOUR }, NOW), 'Ending soon');
        assert.equal(windowStateOf({ startMs: NOW - HOUR, endMs: NOW + 3 * DAY }, NOW), 'Scheduled end');
        assert.equal(windowStateOf({ startMs: NOW - DAY, endMs: null }, NOW), 'Open-ended');
        assert.equal(windowStateOf({ startMs: NOW - 60 * DAY, endMs: null }, NOW), 'Stale');
    });
});

describe('downtime scope parser', () => {
    const satisfied = (scope: string, tags: string[]) => evaluateScope(parseScope(scope), tags);

    it('A OR B is satisfied when only B is present', () => {
        assert.equal(satisfied('service:api OR service:web', ['service:web']), true);
        assert.equal(satisfied('service:api OR service:web', ['service:db']), false);
    });

    it('(A OR B) AND C needs C and one of A or B', () => {
        const scope = '(service:api OR service:web) AND env:prod';
        assert.equal(satisfied(scope, ['service:web', 'env:prod']), true);
        assert.equal(satisfied(scope, ['service:web']), false);
        assert.equal(satisfied(scope, ['env:prod']), false);
        // Implicit AND between terms behaves the same.
        assert.equal(satisfied('(service:api OR service:web) env:prod', ['service:api', 'env:prod']), true);
    });

    it('A AND -B is satisfied when A is present and no tag matches B', () => {
        assert.equal(satisfied('env:prod AND -host:canary', ['env:prod', 'host:web-1']), true);
        assert.equal(satisfied('env:prod AND -host:canary', ['env:prod', 'host:canary']), false);
        assert.equal(satisfied('env:prod -host:canary*', ['env:prod', 'host:canary-2']), false);
    });

    it('NOT A is satisfied when no tag matches A', () => {
        assert.equal(satisfied('NOT env:staging', ['env:prod']), true);
        assert.equal(satisfied('NOT env:staging', ['env:staging']), false);
        assert.equal(satisfied('!env:staging', ['env:staging']), false);
    });

    it('handles nested parentheses', () => {
        const scope = 'env:prod AND ((service:api AND region:us) OR (service:web AND NOT region:eu))';
        assert.equal(satisfied(scope, ['env:prod', 'service:api', 'region:us']), true);
        assert.equal(satisfied(scope, ['env:prod', 'service:web', 'region:us']), true);
        assert.equal(satisfied(scope, ['env:prod', 'service:web', 'region:eu']), false);
        assert.equal(satisfied(scope, ['env:prod', 'service:api', 'region:eu']), false);
    });

    it('treats * alone (or an empty scope) as every group', () => {
        assert.deepEqual(parseScope('*'), { type: 'all' });
        assert.deepEqual(parseScope(''), { type: 'all' });
        assert.equal(satisfied('*', []), true);
    });

    it('lists only positive terms, with wildcards, quotes and commas', () => {
        assert.deepEqual(positiveScopeTerms('env:prod AND (service:api OR service:web) -host:a NOT team:db'), [
            'env:prod',
            'service:api',
            'service:web',
        ]);
        assert.deepEqual(positiveScopeTerms('host:"i-123",service:web-*'), ['host:i-123', 'service:web-*']);
        assert.deepEqual(positiveScopeTerms('-host:a'), []);
    });
});

describe('buildCoverageRows with OR and NOT scopes', () => {
    it('counts A OR B as whole-monitor coverage when the monitor has only B', () => {
        const [row] = rows([monitor(1, ['service:web'])], [downtime('d', { monitorId: 1, scope: 'service:api OR service:web' })]);
        assert.equal(row.maintenanceState, 'Whole monitor');
        const [scoped] = rows([monitor(2, ['service:web'])], [downtime('s', { monitorTags: ['*'], scope: 'service:api OR service:web' })]);
        assert.equal(scoped.monitor.id, 2);
        assert.equal(scoped.maintenanceState, 'Whole monitor');
    });

    it('requires C for (A OR B) AND C', () => {
        const scope = '(service:api OR service:web) AND env:prod';
        const result = rows(
            [monitor(1, ['service:web', 'env:prod']), monitor(2, ['service:web'])],
            [downtime('s', { monitorTags: ['*'], scope })],
        );
        assert.deepEqual(result.map((r) => r.monitor.id), [1]);
        const [direct] = rows([monitor(3, ['service:web'])], [downtime('d', { monitorId: 3, scope })]);
        assert.equal(direct.maintenanceState, 'Groups only');
    });

    it('A AND -B covers the whole monitor only when the monitor lacks B', () => {
        const scope = 'env:prod AND -host:canary';
        const [clean] = rows([monitor(1, ['env:prod'])], [downtime('d', { monitorId: 1, scope })]);
        assert.equal(clean.maintenanceState, 'Whole monitor');
        const [excluded] = rows([monitor(2, ['env:prod', 'host:canary'])], [downtime('d', { monitorId: 2, scope })]);
        assert.equal(excluded.maintenanceState, 'Groups only');
    });

    it('counts a scope with only negated terms as all groups, as before', () => {
        for (const scope of ['-host:a', 'NOT host:a', '-host:a -host:b']) {
            const [row] = rows([monitor(1)], [downtime('d', { monitorId: 1, scope })]);
            assert.equal(row.maintenanceState, 'Whole monitor', scope);
        }
    });
});

describe('fast matching', () => {
    it('matches the same downtimes with direct ones indexed by monitor id, in the original order', () => {
        const monitors = [monitor(1, ['env:prod', 'service:web']), monitor(2, ['env:prod']), monitor(3, ['env:dev'])];
        const downtimes = [
            downtime('scope', { scope: 'service:web' }),
            downtime('direct-1', { monitorId: 1 }),
            downtime('tags', { monitorTags: ['env:prod'] }),
            downtime('direct-2', { monitorId: 2, scope: 'host:a' }),
            downtime('wildcard', { monitorTags: ['env:pr*'] }),
        ];
        const byMonitor = Object.fromEntries(rows(monitors, downtimes).map((row) => [row.monitor.id, row.matches.map((m) => m.downtime.id)]));
        assert.deepEqual(byMonitor[1], ['direct-1', 'tags', 'wildcard', 'scope']);
        assert.deepEqual(byMonitor[2], ['direct-2', 'tags', 'wildcard']);
        assert.equal(byMonitor[3], undefined);
    });

    it('matches tags case-insensitively, with and without wildcards', () => {
        const [row] = rows([monitor(1, ['Env:Prod'])], [downtime('a', { monitorTags: ['env:prod'] }), downtime('b', { monitorTags: ['ENV:p?od'] })]);
        assert.deepEqual(row.matches.map((m) => m.downtime.id).sort(), ['a', 'b']);
    });
});

describe('creator names', () => {
    const snapshot = (createdById: string | null): LiveSnapshot => ({
        monitors: [monitor(1)],
        downtimes: [downtime('d', { monitorId: 1, createdById })],
        fetchedAt: new Date(NOW).toISOString(),
    });
    const label = (createdById: string | null, users = {}, unknown = new Set<string>()) =>
        buildCoverageRows(snapshot(createdById), NOW, users, undefined, unknown)[0].primary.creatorLabel;

    it('says "Resolving…" until Datadog has answered, and "Unknown user" only for users it says are gone', () => {
        assert.equal(label('u1'), 'Resolving…');
        assert.equal(label('u1', {}, new Set(['u1'])), 'Unknown user');
        assert.equal(label('u1', { u1: { id: 'u1', name: 'Bo', handle: 'bo@x.io', email: null } }), 'Bo (bo@x.io)');
        assert.equal(label(null), 'Unknown');
    });
});

describe('the fast first look (preview)', () => {
    it('shows muted monitors as loading until their downtimes arrive', () => {
        const [row] = buildCoverageRows(
            { monitors: [monitor(1)], downtimes: [], datadogMutedIds: [1], fetchedAt: new Date(NOW).toISOString(), isPreview: true },
            NOW,
        );
        assert.equal(row.primary.downtime.isLoading, true);
        assert.equal(row.primary.creatorLabel, 'Loading…');
        assert.equal(isPlaceholderRow(row), true);
    });
});
