import { datadogVitePlugin } from '@datadog/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import packageJson from './package.json' with { type: 'json' };
import datadogAppConfig from './datadog-app.config.json' with { type: 'json' };

const { version } = packageJson;

// The site to build and upload for: DD_SITE (set per deploy target in CI) wins over the config file.
const datadogSite = process.env.DD_SITE || process.env.DATADOG_SITE || datadogAppConfig.datadogSite;

// The site for in-app links, which may carry the org's subdomain (demo.datadoghq.com).
// The datadog-apps CLI resets DD_SITE/DATADOG_SITE to the bare site before building, so
// CI passes the full value as APP_LINK_SITE too (derived from the DATADOG_SITE variable).
const linkSite = process.env.APP_LINK_SITE || datadogSite;

const hasDatadogApiKeys = Boolean(
    (process.env.DD_API_KEY || process.env.DATADOG_API_KEY) &&
        (process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY),
);

export default defineConfig({
    base: './',
    define: {
        'import.meta.env.VITE_DATADOG_SITE': JSON.stringify(linkSite),
    },
    build: {
        sourcemap: true,
        // One main bundle: the DRUIDS design system alone is ~1.3 MB minified and splitting
        // it apart breaks its module initialization order. Library-only chunks would also
        // trigger Error Tracking's "not in the tracked files" source-map warning. The limit
        // sits just above the bundle so growth in app code (~40 kB) still warns.
        chunkSizeWarningLimit: 1600,
    },
    plugins: [
        react(),
        datadogVitePlugin({
            logLevel: 'info',
            auth: {
                site: datadogSite,
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
