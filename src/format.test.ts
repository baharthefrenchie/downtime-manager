import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { downtimeSetBy, endsLabel, friendlyError, isDatadogUiOrigin, mutedLabel, siteUiOrigin } from './format.ts';

describe('isDatadogUiOrigin', () => {
    it('accepts Datadog UI hosts on every site, including custom org subdomains', () => {
        for (const origin of [
            'https://app.datadoghq.com',
            'https://demo.datadoghq.com',
            'https://us3.datadoghq.com',
            'https://us5.datadoghq.com',
            'https://ap1.datadoghq.com',
            'https://app.datadoghq.eu',
            'https://app.ddog-gov.com',
        ]) {
            assert.equal(isDatadogUiOrigin(origin), true, origin);
        }
    });
    it('rejects lookalikes and non-HTTPS origins', () => {
        for (const origin of [
            'https://datadoghq.com.evil.example',
            'https://evil-datadoghq.com',
            'http://app.datadoghq.com',
            'https://app.datadoghq.com:8443',
            'https://localhost:5173',
        ]) {
            assert.equal(isDatadogUiOrigin(origin), false, origin);
        }
    });
});

describe('friendlyError', () => {
    it('explains that permission errors are about the app author identity', () => {
        const message = friendlyError(new Error('HTTP 403 Forbidden'), 'cancel downtimes');
        assert.match(message, /permission/i);
        assert.match(message, /author/i);
    });
});

describe('friendlyError with partial failures', () => {
    it('keeps what already happened and makes the reason friendly', () => {
        const message = friendlyError(
            new Error('The downtime message now records the cancellation, but canceling downtime abc failed, so it is still active. Reason: 403 Forbidden'),
            'cancel downtimes',
        );
        assert.match(message, /^The downtime message now records the cancellation, but canceling downtime abc failed, so it is still active\. Datadog denied permission to cancel downtimes/);
    });
});

describe('siteUiOrigin', () => {
    const origin = (site: string | undefined) => siteUiOrigin(site).origin;

    it('maps each Datadog site to its default host', () => {
        assert.equal(origin(undefined), 'https://app.datadoghq.com');
        assert.equal(origin('datadoghq.com'), 'https://app.datadoghq.com');
        assert.equal(origin('datadoghq.eu'), 'https://app.datadoghq.eu');
        assert.equal(origin('us3.datadoghq.com'), 'https://us3.datadoghq.com');
        assert.equal(origin('ap1.datadoghq.com'), 'https://ap1.datadoghq.com');
        assert.equal(origin('ddog-gov.com'), 'https://app.ddog-gov.com');
        assert.equal(siteUiOrigin('us5.datadoghq.com').isOrgSubdomain, false);
    });

    it("uses an org's custom subdomain on any site", () => {
        assert.deepEqual(siteUiOrigin('demo.datadoghq.com'), { origin: 'https://demo.datadoghq.com', isOrgSubdomain: true });
        assert.deepEqual(siteUiOrigin(' https://Acme.datadoghq.eu/ '), { origin: 'https://acme.datadoghq.eu', isOrgSubdomain: true });
        assert.deepEqual(siteUiOrigin('acme.us3.datadoghq.com'), { origin: 'https://acme.us3.datadoghq.com', isOrgSubdomain: true });
        assert.deepEqual(siteUiOrigin('app.datadoghq.com'), { origin: 'https://app.datadoghq.com', isOrgSubdomain: false });
    });

    it('never links outside Datadog', () => {
        for (const site of ['evil.example.com', 'datadoghq.com.evil.example', 'a.b.datadoghq.com', '-x.datadoghq.com']) {
            assert.deepEqual(siteUiOrigin(site), { origin: 'https://app.datadoghq.com', isOrgSubdomain: false }, site);
        }
    });
});

describe('plain-language table labels', () => {
    const NOW = Date.parse('2026-11-01T12:00:00Z');
    const H = 3_600_000;
    const match = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'direct',
            coversAllGroups: true,
            reason: '',
            startMs: NOW - H,
            endMs: NOW + 2 * H,
            creatorLabel: 'Bo',
            downtime: { id: 'd', scope: '*', isRecurring: false, monitorTags: [] },
            ...overrides,
        }) as unknown as Parameters<typeof endsLabel>[0];

    it('colors an end time only within the hour, and an open end only after 30 days', () => {
        assert.deepEqual(
            [endsLabel(match(), NOW).tone, endsLabel(match({ endMs: NOW + 30 * 60_000 }), NOW).tone],
            ['default', 'warning'],
        );
        assert.equal(endsLabel(match({ endMs: null, startMs: NOW - 2 * 24 * H }), NOW).tone, 'tertiary');
        assert.equal(endsLabel(match({ endMs: null, startMs: NOW - 40 * 24 * H }), NOW).tone, 'warning');
        assert.match(endsLabel(match({ endMs: null }), NOW).text, /^No end/);
    });

    it('describes what is muted and how', () => {
        const row = (overrides: Record<string, unknown>) =>
            ({ source: 'Direct (monitor ID)', matches: [match()], primary: match(), maintenanceState: 'Whole monitor', ...overrides }) as unknown as Parameters<typeof mutedLabel>[0];
        assert.deepEqual(mutedLabel(row({})), { what: 'All groups', isScope: false, how: 'by monitor ID' });
        const scoped = match({ kind: 'tag', coversAllGroups: false, downtime: { id: 'x', scope: 'host:a', monitorTags: ['env:prod'] } });
        assert.deepEqual(mutedLabel(row({ source: 'Tag/Scope-based', primary: scoped, matches: [scoped, match()] })), {
            what: 'host:a',
            isScope: true,
            how: 'by monitor tags · 2 downtimes',
        });
    });

    it('names downtime creators only when they are not the owner', () => {
        const row = (owner: string, downtimeCreators: string[]) => ({ owner, downtimeCreators }) as unknown as Parameters<typeof downtimeSetBy>[0];
        assert.equal(downtimeSetBy(row('Bo', ['Bo (bo@x.io)'])), null);
        assert.equal(downtimeSetBy(row('Bo', ['Resolving…'])), null);
        assert.equal(downtimeSetBy(row('Bo', ['Unknown (not in the downtime list)'])), null);
        assert.equal(downtimeSetBy(row('Bo', ['Al (al@x.io)'])), 'Downtime by Al (al@x.io)');
    });
});
