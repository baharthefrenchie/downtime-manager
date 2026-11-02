import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCoverageRows, type LiveDowntime, type LiveMonitor } from './coverage.ts';
import {
    parseQuery,
    rowMatchesQuery,
    rowMatchesTemplateVariables,
    suggestionsFor,
    tagIndex,
    templateVariableFilters,
} from './search.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');

const monitor = (id: number, name: string, tags: string[], overallState = 'OK'): LiveMonitor => ({
    id,
    name,
    type: 'metric alert',
    overallState,
    tags,
    creatorName: 'Alice Smith',
    creatorHandle: 'alice@example.com',
    creatorEmail: null,
});

const downtime = (id: string, monitorId: number, scope = '*'): LiveDowntime => ({
    id,
    status: 'active',
    message: 'Planned database upgrade',
    scope,
    displayTimezone: 'UTC',
    monitorId,
    monitorTags: [],
    start: new Date(NOW - 3_600_000).toISOString(),
    end: null,
    isRecurring: false,
    createdById: null,
    created: null,
    url: null,
});

const rows = buildCoverageRows(
    {
        monitors: [
            monitor(1, 'Checkout latency is high', ['env:prod', 'service:web-store', 'team:payments']),
            monitor(2, 'Checkout error rate', ['env:staging', 'service:web-store'], 'Alert'),
            monitor(3, 'Disk filling up on db hosts', ['env:prod', 'service:db', 'team:storage'], 'No Data'),
        ],
        downtimes: [downtime('d1', 1), downtime('d2', 2, 'host:web-1'), downtime('d3', 3)],
        fetchedAt: new Date(NOW).toISOString(),
    },
    NOW,
);

const ids = (query: string) =>
    rows
        .filter((row) => rowMatchesQuery(row, parseQuery(query)))
        .map((row) => row.monitor.id)
        .sort();

describe('search', () => {
    it('matches everything for an empty query', () => {
        assert.deepEqual(ids(''), [1, 2, 3]);
        assert.deepEqual(ids('   '), [1, 2, 3]);
    });

    it('matches free text against names (every word) and exact monitor ids', () => {
        assert.deepEqual(ids('checkout'), [1, 2]);
        assert.deepEqual(ids('checkout latency'), [1]);
        assert.deepEqual(ids('"error rate"'), [2]);
        assert.deepEqual(ids('3'), [3]);
    });

    it('matches tags with exact values, wildcards and key presence, case-insensitively', () => {
        assert.deepEqual(ids('env:prod'), [1, 3]);
        assert.deepEqual(ids('ENV:Prod service:web-store'), [1]);
        assert.deepEqual(ids('service:web-*'), [1, 2]);
        assert.deepEqual(ids('team:*'), [1, 3]);
        assert.deepEqual(ids('-team:*'), [2]);
        assert.deepEqual(ids('env:pro'), []);
    });

    it('supports negation with - and NOT', () => {
        assert.deepEqual(ids('-env:staging'), [1, 3]);
        assert.deepEqual(ids('NOT env:staging'), [1, 3]);
        assert.deepEqual(ids('checkout -env:prod'), [2]);
    });

    it('supports OR between groups of AND terms', () => {
        assert.deepEqual(ids('team:storage OR status:alert'), [2, 3]);
        assert.deepEqual(ids('env:prod AND service:db OR env:staging'), [2, 3]);
    });

    it('supports reserved keys', () => {
        assert.deepEqual(ids('id:2'), [2]);
        assert.deepEqual(ids('status:"no data"'), [3]);
        assert.deepEqual(ids('status:nodata'), [3]);
        assert.deepEqual(ids('scope:web-1'), [2]);
        assert.deepEqual(ids('downtime:d3'), [3]);
        assert.deepEqual(ids('owner:alice'), [1, 2, 3]);
        assert.deepEqual(ids('message:upgrade name:disk'), [3]);
    });

    it('ignores an incomplete key:, and supports explicit tag: for reserved key names', () => {
        assert.deepEqual(ids('env:'), [1, 2, 3]);
        assert.deepEqual(ids('checkout env:'), [1, 2]);
        const typed = buildCoverageRows(
            {
                monitors: [monitor(7, 'Typed', ['type:batch'])],
                downtimes: [downtime('d7', 7)],
                fetchedAt: new Date(NOW).toISOString(),
            },
            NOW,
        );
        assert.equal(rowMatchesQuery(typed[0], parseQuery('tag:type:batch')), true);
        assert.equal(rowMatchesQuery(typed[0], parseQuery('type:batch')), false);
        const index = tagIndex(typed);
        const inserts = suggestionsFor('ty', index, typed).map((s) => s.insert);
        assert.deepEqual(inserts, ['type:', 'tag:type:']);
        assert.deepEqual(suggestionsFor('tag:type:b', index, typed).map((s) => s.insert), ['tag:type:batch']);
    });

    it('suggests keys, then values for the key being typed', () => {
        const index = tagIndex(rows);
        const keys = suggestionsFor('se', index, rows).map((s) => s.label);
        assert.ok(keys.includes('service:'));
        const values = suggestionsFor('env:', index, rows).map((s) => [s.label, s.hint]);
        assert.deepEqual(values[0], ['env:prod', '2 monitors']);
        assert.deepEqual(suggestionsFor('-team:st', index, rows).map((s) => s.insert), ['-team:storage']);
        assert.deepEqual(suggestionsFor('status:al', index, rows).map((s) => s.insert), ['status:Alert']);
    });
});

describe('dashboard template variables', () => {
    const tvIds = (variables: Parameters<typeof templateVariableFilters>[0]) => {
        const filters = templateVariableFilters(variables);
        return rows.filter((row) => rowMatchesTemplateVariables(row, filters)).map((row) => row.monitor.id).sort();
    };

    it('applies prefix:value like dashboard widgets do', () => {
        assert.deepEqual(tvIds([{ name: 'env', prefix: 'env', value: 'prod' }]), [1, 3]);
        assert.deepEqual(tvIds([{ name: 'env', prefix: 'env', value: 'prod' }, { name: 'svc', prefix: 'service', value: 'db' }]), [3]);
    });

    it('matches any of a multi-value selection, and supports wildcards', () => {
        assert.deepEqual(tvIds([{ name: 'team', prefix: 'team', value: 'payments', values: ['payments', 'storage'] }]), [1, 3]);
        assert.deepEqual(tvIds([{ name: 'svc', prefix: 'service', value: 'web-*' }]), [1, 2]);
    });

    it('treats * or an empty selection as no filter', () => {
        assert.deepEqual(tvIds([{ name: 'env', prefix: 'env', value: '*' }]), [1, 2, 3]);
        assert.deepEqual(tvIds([{ name: 'env', prefix: 'env', value: '' }]), [1, 2, 3]);
        assert.deepEqual(tvIds(undefined), [1, 2, 3]);
    });

    it('maps prefix-less variables only when the value is a full tag', () => {
        assert.deepEqual(tvIds([{ name: 'scope', value: 'env:staging' }]), [2]);
        assert.deepEqual(templateVariableFilters([{ name: 'free', value: 'prod' }]), []);
    });
});
