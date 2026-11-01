# Upgrading

## Primary packages

- `@datadog/vite-plugin`: Vite integration for local development, build, and deploy.
- `@datadog/action-catalog`: typed Action Catalog client for backend functions.
- `@datadog/apps-backend`: Datadog-provided helpers for backend function development.
- `@datadog/apps-frontend`: Datadog-provided helpers and utils for apps, such as getting input context from the page!

Preserve the existing package manager and lockfile style.

## Before upgrading

Check release notes before changing versions:

```bash
npm view @datadog/vite-plugin version repository.url homepage
npm view @datadog/action-catalog version repository.url homepage
npm view @datadog/apps-backend version repository.url homepage
npm view @datadog/apps-frontend version repository.url homepage
```

Inspect the current app:

```bash
npm outdated @datadog/vite-plugin @datadog/action-catalog @datadog/apps-backend @datadog/apps-frontend
npm ls @datadog/vite-plugin @datadog/action-catalog @datadog/apps-backend @datadog/apps-frontend
```

## Upgrade

```bash
npm install @datadog/action-catalog@latest
npm install @datadog/apps-backend@latest
npm install @datadog/apps-frontend@latest
npm install -D @datadog/vite-plugin@latest
```

After upgrading, verify:

- `datadog-app.config.json` app definition and configuration fields (`datadogSite`, `id`, `name`, `description`, `selfService`, `permissions`, `tags`) and `vite.config.ts` Datadog plugin config.
- `package.json` scripts — check for the `dev`, `build`, and `upload` scripts that run the `datadog-apps` CLI, and for `@datadog/apps-cli` in `devDependencies`.
- Backend function imports from `@datadog/action-catalog/...`.
- Frontend embedding and input imports from `@datadog/apps-frontend/...`.
- Project-local instructions in `AGENTS.md`.

## Compare against a fresh scaffold

To pull in changes from the latest scaffolder without guessing:

```bash
tmp_dir="$(mktemp -d)"
npm create @datadog/apps@latest -- "$tmp_dir/base-app" --template vite-react -y --skip-post-scaffold
diff -ru "$tmp_dir/base-app/package.json" package.json
diff -ru "$tmp_dir/base-app/datadog-app.config.json" datadog-app.config.json
diff -ru "$tmp_dir/base-app/vite.config.ts" vite.config.ts
diff -ru "$tmp_dir/base-app/src" src
```

Port only the specific changes needed. Do not replace the app wholesale.

**Preserve your existing `id`** — the fresh scaffold generates a new random `id` in `datadog-app.config.json`. Do not copy it into your project; keep your existing `id` to avoid creating a duplicate app on the next upload.

## Verify

```bash
npm run typecheck
npm run lint
npm run build
```
