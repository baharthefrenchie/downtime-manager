import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extensionSchedule } from './schedule.ts';

describe('extensionSchedule', () => {
    it('resends the current start exactly as Datadog returned it, with the new end', () => {
        assert.deepEqual(extensionSchedule('2026-10-30T20:18:41.228000+00:00', '2026-12-03T20:56:00.000Z'), {
            start: '2026-10-30T20:18:41.228000+00:00',
            end: '2026-12-03T20:56:00.000Z',
        });
    });

    it('refuses to build a schedule without the current start', () => {
        assert.throws(() => extensionSchedule(null, '2026-12-03T20:56:00.000Z'), /start time/);
        assert.throws(() => extensionSchedule(undefined, '2026-12-03T20:56:00.000Z'), /start time/);
    });
});
