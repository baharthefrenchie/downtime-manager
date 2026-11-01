# oncall-downtime

This is a Datadog App scaffolded with `npm create @datadog/apps`.

Datadog Apps are React + TypeScript applications bundled by Vite and embedded in the Datadog product experience. Frontend code runs in the browser. Backend functions live in `*.backend.*` files and execute through Datadog's managed runtime.

## DRUIDS components

This app uses the published `@datadog/druids` package. In scaffolded apps, import components from `@datadog/druids/[category]/[Component]`; do not import private web-ui paths like `@druids/ui/...`.

- The scaffold imports `@datadog/druids/styles.css` at the React root and wraps the app in `DruidsEnvironmentWithThemeInput` (`@datadog/apps-frontend/druids/react`) below `DatadogAppProvider`. The environment follows the Datadog UI theme through the live `datadog.theme` input; `defaultThemePreference` in `src/main.tsx` only covers the first paint before the input claims. Keep that setup in place if you restructure the root. To keep DRUIDS' own cookie-based preference handling instead, render `DruidsEnvironment` from `@datadog/druids/layout/DruidsEnvironment`.
- Discover available components by browsing the installed package. Treat the `exports` map in `node_modules/@datadog/druids/package.json` as the source of truth for public entry points, and explore the corresponding category directories under `node_modules/@datadog/druids/dist` instead of relying on a hard-coded component list.
- After choosing an exported component, inspect its TypeScript definitions under `node_modules/@datadog/druids/dist/**/*.d.mts` before inventing props or imports. For icons, only use entry points that are present in the installed package.
- Start with the [DRUIDS docs](https://druids.datadoghq.com/), especially [Foundations](https://druids.datadoghq.com/foundations), [Spacing & Layout](https://druids.datadoghq.com/foundations/spacing-and-layout), [Typography](https://druids.datadoghq.com/foundations/typography), and [Components](https://druids.datadoghq.com/components). The docs cover the full internal DRUIDS library; the public `@datadog/druids` package exposes only a subset for Datadog Apps.
- Use the docs after confirming the local API to understand design intent, layout guidance, examples, and component selection tradeoffs.
- Prefer appropriate DRUIDS layout and typography components over ad hoc HTML wrappers or inline CSS. Use component props and design tokens for spacing, size, and variants.

## Datadog App frontend embedding

- The scaffold wraps the app in `DatadogAppProvider` from `@datadog/apps-frontend/embedding/react` at the React root. Keep that setup in place if you restructure the root; every `@datadog/apps-frontend` hook must be called below it.
- Read host-provided inputs with `useDatadogAppInput` from `@datadog/apps-frontend/inputs/react`, passing input schemas such as `datadogTheme` from `@datadog/apps-frontend/inputs/schema`. For details, read `docs/agents/runtime-context.md`.

- The DatadogAppProvider syncs all of your url parameters (`?<param>=<value>`) and all fragment identifier / anchor (`#<value>`) into the datadog url. Use these to allow for deep-linking of your apps at any state where its correct and best practice to do so.

## Read relevant guides

- For embedded Datadog app context, routing, navigation, browser storage, or parent-page constraints, read `docs/agents/runtime-context.md`.
- For writing backend functions in `*.backend.ts` or `*.backend.js` files, or for calling backend functions from frontend code, read `docs/agents/backend-functions.md`.
- For local development, auth, build, upload, or upload troubleshooting, read `docs/agents/build-upload-auth.md`.
- For GitHub Actions CI/CD setup, read `docs/agents/cicd.md`.
- For choosing between DDSQL and Action Catalog, configuring Connections, or querying app datastores, read `docs/agents/data.md`.
- For triggering or polling a Workflow Automation workflow from a backend function, read `docs/agents/workflow-automation.md`.
- For upgrading `@datadog/vite-plugin` or `@datadog/action-catalog`, read `docs/agents/upgrading.md`.

## General rules

- Route every external network request through a backend function that calls the generic HTTP action from `@datadog/action-catalog/http/http`. Never call `fetch` or use Node.js networking APIs to contact external services directly, including from a backend function.
- Do not hardcode API keys, app keys, OAuth tokens, passwords, or third-party credentials.
- Set the `name` and `description` fields in `datadog-app.config.json` to concise, user-facing values that describe the app.
- Each upload adds the `tags` in `datadog-app.config.json` to the app, plus `surface:<surface id>` tags the build adds for embedding inputs the app uses. Uploads never remove tags: removing one from the config leaves it on the app until someone removes it in the App Builder UI. Add a `surface:` tag yourself (for example `surface:datadog.dashboard`) when the app is meant for a surface whose inputs it doesn't read.
- Prefer the generated npm scripts in `package.json`; this scaffold uses npm.
- Never change `id` in `datadog-app.config.json`. It is this app's permanent identity, not the app's UUID from App Builder — changing it makes the next upload create a duplicate app.
- Before inventing package imports or component props, inspect installed package exports and TypeScript definitions.

## Broader Datadog Apps guidance

- For scaffolding a new app from scratch, use the Datadog Apps agent skill when it is available.
- Use Playwright when available for browser validation, including screenshots for visual design changes.
- Use the Datadog `pup` CLI (https://github.com/DataDog/pup) when available for Datadog API inspection and troubleshooting.
- Use Datadog MCP tools when available for Datadog-specific lookup, diagnostics, or API-backed workflows.

Primary docs: https://docs.datadoghq.com/actions/datadog_apps/
