import { datadogVitePlugin } from '@datadog/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import packageJson from './package.json' with { type: 'json' };
import datadogAppConfig from './datadog-app.config.json' with { type: 'json' };

const { version } = packageJson;

const hasDatadogApiKeys = Boolean(
    (process.env.DD_API_KEY || process.env.DATADOG_API_KEY) &&
        (process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY),
);

export default defineConfig({
    base: './',
    build: {
        sourcemap: true,
        // The DRUIDS design system is ~1.3 MB minified and can't be split safely (see
        // below), so the limit sits just above it. App code is ~40 kB; anything else
        // growing past this still warns.
        chunkSizeWarningLimit: 1400,
        rolldownOptions: {
            output: {
                // Keep vendor code in separately cached chunks instead of one bundle.
                // DRUIDS must stay a single chunk: splitting it by size breaks its
                // module initialization order at runtime.
                codeSplitting: {
                    groups: [
                        { name: 'vendor-react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
                        { name: 'vendor-druids', test: /node_modules[\\/]@datadog[\\/]druids[\\/]/, priority: 20 },
                        { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
                    ],
                },
            },
        },
    },
    plugins: [
        react(),
        datadogVitePlugin({
            logLevel: 'info',
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
