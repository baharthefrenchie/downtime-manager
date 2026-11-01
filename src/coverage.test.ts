/**
 * Unit tests for the coverage matching rules. Run with `npm test`
 * (Node's built-in test runner; Node 24 runs TypeScript directly).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildCoverageRows,
    isActiveDowntime,
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
