import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { friendlyError, isDatadogUiOrigin } from './format.ts';

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
