# Build, Auth, And Upload

This scaffold uses npm. Prefer the scripts in `package.json` over ad hoc commands.

## Scripts

- `npm run dev` — start the dev server through `datadog-apps`, which resolves Datadog credentials for it.
- `npm run build` — local production build. Does not upload anything.
- `npm run upload` — build, upload, and publish the app live.
- `npm run cli` — open the `datadog-apps` command menu (a plain command listing in non-interactive contexts).
- `npm run typecheck` — TypeScript check without emitting files. Use this for credential-free validation.
- `npm run lint` / `npm run lint:fix` — run ESLint.

## App identity (do not change)

- `id` in `datadog-app.config.json` is this app's permanent identity. It was generated once when the project was scaffolded.
- Every upload updates the app that matches this identifier. **Never change it** — changing it makes the next upload create a brand-new duplicate app instead of updating the existing one.

## Auth

Apps use **OAuth by default**. On first `npm run dev`, the `datadog-apps` CLI opens a browser window for Datadog login and stores the token on this machine in `credentials.json` — under `$DD_APPS_CONFIG_DIR` or `$DATADOG_APPS_CONFIG_DIR` if set, else `$XDG_CONFIG_HOME/datadog-apps` (when absolute), else `~/.config/datadog-apps`. Treat that file as a secret; `npx datadog-apps auth logout` revokes and clears it. No credentials needed in advance.

**API key fallback** — use when OAuth isn't available (headless CI, restricted networks). The `datadog-apps` CLI reads credentials from the environment, not from `.env.local`, so export both keys before running `npm run dev`, `npm run build`, or `npm run upload`:

```bash
export DD_API_KEY="<YOUR_API_KEY>"
export DD_APP_KEY="<YOUR_APPLICATION_KEY>"
```

Keys are at:
- API keys: `https://app.datadoghq.com/organization-settings/api-keys`
- Application keys: `https://app.datadoghq.com/organization-settings/application-keys` — the key needs **two scopes**: **Actions API Access** and **Apps**

Do not ask users to paste key values into the conversation; point them at the pages above.

## Non-US1 site

Set `datadogSite` in `datadog-app.config.json` so local dev and uploads target the right site:

```json
{ "datadogSite": "<YOUR_DATADOG_SITE>" }
```

## Upload

Build, upload, and publish in one command:

```bash
npm run upload
```

With API keys (CI environments):

```bash
export DD_API_KEY="<YOUR_API_KEY>"
export DD_APP_KEY="<YOUR_APPLICATION_KEY>"
npm run upload
```

A successful upload prints a Datadog URL for the app.

**Older scaffolded projects** — if the `upload` script is missing, add it to `package.json` and install the CLI it runs:

```json
{ "scripts": { "upload": "npx datadog-apps upload" } }
```

```bash
npm install -D @datadog/apps-cli
```

## Troubleshooting

**401 / missing authentication token / credentials not configured**

- OAuth: if the browser window didn't open, the environment may not support it. Fall back to API keys.
- API keys: verify `DD_API_KEY` and `DD_APP_KEY` are set and the application key has both **Actions API Access** and **Apps** scopes.
- Check `datadogSite` in `datadog-app.config.json` matches the credentials' Datadog site.

**403 "you do not have access to this app" on upload**

The application key needs both scopes enabled — not just one:

1. **Actions API Access** — required for backend function execution.
2. **Apps** (or **App Builder**) — required for uploading and publishing.

Go to `https://app.datadoghq.com/organization-settings/application-keys`, confirm both scopes, or create a new key with both.

**Build succeeds but nothing goes live**

- Use `npm run upload`, not `npm run build`, when the intent is to publish. `npm run build` builds locally and uploads nothing.
- Confirm `dryRun` in `vite.config.ts` is not `true`.

**Build fails with missing credentials**

- `npm run build` is a local build and needs no credentials; if it fails, read the error from Vite or the Datadog Vite plugin.
- It can also fail before Vite starts, with the CLI's own error, when the first site it finds (`DATADOG_SITE`, then `DD_SITE`, then `datadogSite` in `datadog-app.config.json`) is not a known Datadog site, or when it reads that file and cannot parse it as a JSON object.
- For credential-free validation, prefer `npm run typecheck`.

**Node or scaffolding errors**

- Check `package.json` `engines.node` for the supported Node.js versions.
- Use Volta, nvm, or fnm to switch versions. Prefer a current Node 22 release when debugging.

**Datadog site mismatch**

- Inspect `datadog-app.config.json` for the configured site and confirm CI uses the same value.
