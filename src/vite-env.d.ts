/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * Datadog site the app was built for, possibly with the org's subdomain
     * (from APP_LINK_SITE, DD_SITE or datadog-app.config.json).
     */
    readonly VITE_DATADOG_SITE: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
