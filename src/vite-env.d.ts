/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Datadog site the app was built for (from DD_SITE or datadog-app.config.json). */
    readonly VITE_DATADOG_SITE: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
