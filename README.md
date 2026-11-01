# downtime-manager

An app to help on-callers and managers manage downtime.

**On-Call Maintenance Downtime Manager** is a [Datadog App](https://docs.datadoghq.com/actions/datadog_apps/)
(React + TypeScript, built with DRUIDS) that shows which monitors are currently muted by
active downtimes, using live data from the Datadog org it runs in.

## What it does

- **Monitor-centric table:** one row per monitor covered by a validated active downtime
  (status `active`, start in the past or missing, end in the future or missing).
- **Direct vs tag/scope coverage:** matches downtimes by `monitor_identifier.monitor_id`, and by
  monitor tags / scope compared against the monitor's tags.
- **What is really muted:** *Whole monitor*, *Groups only*, or *Not muting*. Datadog's own list of
  muted monitors (`muted:true`) is the source of truth, so the "Monitors in Maintenance" count
  matches the Datadog Monitors page. Monitors muted by downtimes that the downtime list API doesn't
  return (such as host auto-mutes) are included; their downtimes load from Datadog when you inspect
  them. Monitors with an active downtime that mutes no current group are shown as *Not muting* and
  aren't counted.
- **Window state:** *Ending soon* (< 24h), *Scheduled end*, *Open-ended*, *Stale* (open-ended > 30d),
  with relative times. Open-ended downtimes show *Indefinitely*.
- **Actions:** inspect (side panel with raw get-downtime JSON), **extend** and **cancel**. Both
  re-read the downtime live and refuse if it is no longer active.
- **Filters:** maintenance state, window, owner/creator, and downtime start date. Filters live in the
  URL, so filtered views are shareable. Export the filtered rows to CSV or JSON.
- **Dashboard-friendly:** the layout adapts from full screen down to a small dashboard widget.

Viewers need Datadog permission to read monitors and downtimes. Cancel and extend also require
the **Monitors Downtime** (`monitors_downtime`) permission.

## Development

Requires Node.js 24 (the Datadog Apps backend runtime version). Node 22.18+ also works.

```bash
npm install
npm run dev          # local dev server; signs in to Datadog with OAuth on first run
npm run dev:verify   # same, but backend functions run in Datadog's cloud runtime
npm run typecheck
npm run lint
npm test             # unit tests for the coverage matching rules
npm run build        # production build, uploads nothing
```

Backend functions live in `src/maintenance.backend.ts` and call Datadog through
`@datadog/action-catalog`. Matching rules live in `src/coverage.ts`, with tests in
`src/coverage.test.ts`.

## Deployment

`.github/workflows/datadog-app.yml` does the following:

- **Pull requests:** typecheck, lint, unit tests and a production build. No secrets needed.
- **Pushes to `main`:** the same checks, then build, upload and **publish live** with
  `DataDog/apps-github-action`.

The deploy job needs these repository secrets, created in the Datadog org the app is published to:

| Secret | Value |
|---|---|
| `DATADOG_API_KEY` | A Datadog API key |
| `DATADOG_APP_KEY` | A Datadog application key with the **Actions API Access** and **Apps** scopes |

The key's owner must have edit access to the app in App Builder. Deploys run in the
`datadog-production` GitHub environment; add required reviewers there to gate releases.

To deploy manually instead: `npm run upload`. This publishes live immediately.

> Never change `id` in `datadog-app.config.json`. It is the app's permanent identity, and changing
> it makes the next upload create a duplicate app.
