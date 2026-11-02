import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { actorLabel, appendChangeLine, changeLine, lastChange, sanitizeActor } from './changeRecord.ts';

const NOW = '2026-11-02T12:00:00.000Z';
const END = '2026-11-02T18:00:00.000Z';
const ada = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('change record', () => {
    it('validates and length-limits the identity', () => {
        assert.deepEqual(sanitizeActor(ada), ada);
        assert.deepEqual(sanitizeActor({ name: 'Ada\n[link](x) `<b>`', email: 'not an email' }), { name: 'Ada linkx b', email: null });
        assert.equal(sanitizeActor({ name: 'x'.repeat(500) }).name?.length, 80);
        assert.equal(sanitizeActor({ name: '@here', email: 42 }).name, 'here');
        assert.deepEqual(sanitizeActor(null), { name: null, email: null });
        assert.equal(actorLabel(sanitizeActor(null)), 'an unidentified user');
    });

    it('writes extend and cancel lines', () => {
        assert.equal(
            changeLine('Extended', ada, NOW, { end: END }),
            `Extended to ${END} by Ada Lovelace (ada@example.com) via Downtime Manager at ${NOW}`,
        );
        assert.equal(changeLine('Cancelled', ada, NOW), `Cancelled by Ada Lovelace (ada@example.com) via Downtime Manager at ${NOW}`);
    });

    it('never writes an @-notification into downtime messages', () => {
        const line = changeLine('Cancelled', ada, NOW, { avoidMentions: true });
        assert.equal(line.includes('@'), false);
        assert.equal(lastChange(line)?.by, 'Ada Lovelace (ada@example.com)');
    });

    it('keeps the existing text and reads back the latest change', () => {
        const first = appendChangeLine('Planned maintenance @team-sre', changeLine('Extended', ada, NOW, { end: END }));
        assert.match(first, /^Planned maintenance @team-sre\n\nExtended to /);
        const second = appendChangeLine(first, changeLine('Cancelled', { name: 'Grace', email: null }, END));
        assert.deepEqual(lastChange(first), { action: 'Extended', end: END, by: 'Ada Lovelace (ada@example.com)', at: NOW });
        assert.deepEqual(lastChange(second), { action: 'Cancelled', end: null, by: 'Grace', at: END });
        assert.equal(appendChangeLine(null, 'line'), 'line');
        assert.equal(lastChange('No change line here'), null);
    });
});
