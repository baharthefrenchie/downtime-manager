import { datadogVitePlugin } from '@datadog/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { version } from './package.json';
import datadogAppConfig from './datadog-app.config.json';

const hasDatadogApiKeys = Boolean(
    (process.env.DD_API_KEY || process.env.DATADOG_API_KEY) &&
        (process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY),
);

export default defineConfig({
    base: './',
    build: {
        sourcemap: true,
    },
    plugins: [
        react(),
        datadogVitePlugin({
            logLevel: 'debug',
            auth: {
                site: process.env.DD_SITE || datadogAppConfig.datadogSite,
                apiKey: process.env.DD_API_KEY,
                appKey: process.env.DD_APP_KEY,
            },
            apps: {
                enable: true,
                // `id` is this app's permanent identity — do NOT change it,
                // and do NOT set it to the app's UUID from App Builder.
                identifier: datadogAppConfig.id,
                name: datadogAppConfig.name,
                // Optional in datadog-app.config.json, so read it without assuming the key exists.
                tags: (datadogAppConfig as { tags?: string[] }).tags,
                authOverrides: {
                    method: hasDatadogApiKeys ? 'apiKey' : 'oauth',
                },
            },
            errorTracking: {
                enable: hasDatadogApiKeys,
                sourcemaps: {
                    minifiedPathPrefix: '/',
                    service: datadogAppConfig.name,
                    releaseVersion: version,
                },
            },
            metadata: {
                name: datadogAppConfig.name,
            },
            metrics: {
                enable: hasDatadogApiKeys,
            },
        }),
    ],
});
