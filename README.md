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
- **Related SLOs:** for each monitor in maintenance, the SLOs it affects. These are monitor-based
  SLOs that use the monitor and, when coverage is tag/scope-based, SLOs carrying every tag and scope
  term of the downtime. Each shows its SLI, error budget and current corrections.
- **SLO corrections:** a view listing the active, scheduled and recurring corrections on those SLOs
  (including corrections that target SLOs by tag query), with how long they run and how long is
  left. One-time corrections can be **extended** (start kept, end moved) or **canceled**. Canceling
  an active correction ends it now, which keeps the time already excluded; deleting it would count
  that time against the SLO retroactively. A correction that hasn't started yet is deleted.
  Recurring corrections are edited in Datadog.
- **Dashboard-friendly:** the layout adapts from full screen down to a small dashboard widget.

## Permissions

A published Datadog app runs as its **author** (the account that deployed it), not as the person
viewing it ([App execution identity](https://docs.datadoghq.com/actions/app_builder/access_and_auth/#app-execution-identity)).
When CI deploys, the author is the owner of the application key in `DATADOG_APP_KEY`. That account
needs:

- **Monitors Read**: list monitors and downtimes.
- **Monitors Downtime** (`monitors_downtime`): cancel and extend downtimes.
- **User Access Read**: show downtime creators' names.
- **SLOs Read**: list SLOs and their corrections.
- **SLOs Corrections** (`slos_corrections`): extend and cancel SLO corrections.

A service account with exactly these permissions is the safest owner for the deploy key. Who can
open the app is controlled separately, in the app's permissions in App Builder.

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

The key's owner must have edit access to the app in App Builder, and becomes the identity the app
runs as (see [Permissions](#permissions)).

### Deploying to more than one Datadog org

Each org is a GitHub environment (**Settings → Environments**) holding that org's keys:

1. Create an environment, for example `datadog-eu`.
2. Add `DATADOG_API_KEY` and `DATADOG_APP_KEY` environment secrets, created in that org. The
   application key needs the **Actions API Access** and **Apps** scopes.
3. For orgs outside US1, add an environment variable `DATADOG_SITE` (`datadoghq.eu`,
   `us3.datadoghq.com`, `us5.datadoghq.com`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`).
4. Add the environment to the repository variable `DATADOG_DEPLOY_TARGETS`, a JSON list such as
   `["datadog-production", "datadog-eu"]`. Without this variable only `datadog-production`
   (which uses the repository secrets) deploys.

Every push to `main` then deploys to each target. One org failing doesn't stop the others. To try
a new org first, run the workflow manually (**Actions → Datadog App → Run workflow**) with that
environment as `target`. Links inside the app point at the org it's embedded in, so they work in
every org. The app keeps the same `id` everywhere; each org gets its own copy.

To deploy manually instead: `npm run upload` publishes live immediately to the org you're logged
into. Use `npx datadog-apps upload --org <org UUID>` or `--site <site>` to pick another org; run
`npx datadog-apps auth status` to list them.

> Never change `id` in `datadog-app.config.json`. It is the app's permanent identity, and changing
> it makes the next upload create a duplicate app.
