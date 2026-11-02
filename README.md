# downtime-manager

**On-Call Maintenance Downtime Manager** is a [Datadog App](https://docs.datadoghq.com/actions/datadog_apps/)
(React + TypeScript, built with DRUIDS) that shows which monitors are currently muted by
active downtimes, using live data from the Datadog org it runs in.

## What it does

- **At a glance:** five summary tiles that double as one-click filters: *Muted monitors*,
  *Muted while alerting* (alerts that page nobody), *Ending within 24h*, *No end for 30+ days*
  (possibly forgotten) and *Active SLO corrections*.
- **Monitor-centric table:** one row per monitor covered by a validated active downtime
  (status `active`, start in the past or missing, end in the future or missing). Each row shows
  the monitor's state, what is muted and how (*All groups · by monitor ID*), when the downtime
  ends, related SLOs and the owner. Only the monitor state is a colored pill; an end time turns
  amber within the hour, and an open-ended downtime after 30 days. Click a row for details; the
  ⋯ menu opens the monitor or downtime in Datadog, or extends or cancels the downtime.
- **Direct vs tag/scope coverage:** matches downtimes by `monitor_identifier.monitor_id`, and by
  monitor tags / scope compared against the monitor's tags.
- **What is really muted:** *Whole monitor*, *Some groups*, or *Not muting*. Datadog's own list of
  muted monitors (`muted:true`) is the source of truth, so the *Muted monitors* count
  matches the Datadog Monitors page. Monitors muted by downtimes that the downtime list API doesn't
  return (such as host auto-mutes) are included; their downtimes load from Datadog when you inspect
  them. Monitors with an active downtime that mutes no current group are shown as *Not muting* and
  aren't counted.
- **When it ends:** filter by *Ends within 24h*, *Ends later*, *No end (recent)* or *No end for
  30+ days*. Open-ended downtimes show *No end* and how long they have run.
- **Side panel:** opens with what the downtime mutes and until when, with **Extend** and
  **Cancel downtime** beside it, then its details, the related SLOs and their corrections. IDs,
  the matching rule and the raw get-downtime JSON are under *Show technical details*. When several
  downtimes mute a monitor, switch between them at the top. Extend and cancel re-read the
  downtime live and refuse if it is no longer active.
- **Fast first load:** the monitors Datadog reports as muted appear in about a second, and their
  downtimes fill in a few seconds later (the downtime list is the slow part). Later visits start
  from the last data saved in the browser and refresh in the background; creator names are
  cached for a week.
- **Downtime and its SLO corrections together:** the extend and cancel dialogs list the SLO
  corrections linked to the downtime. A correction is linked when it is one-time, hasn't ended,
  its window overlaps the downtime's, and it either targets one of the downtime's related SLOs (by
  SLO or by tag query), or is the tag-based correction Datadog creates from the downtime editor
  (**Preview SLO Correction**), whose query is the downtime's monitor tags. Corrections that start
  or end within 15 minutes of the downtime (the same maintenance window, such as a whole-day
  correction for a downtime ending at midnight) are ticked by default; others that merely overlap
  are listed unticked, so a long-running correction only changes if you tick it. Extending moves
  each ticked correction to the same new end; canceling ends an active correction now, or deletes one that hasn't started. The
  downtime changes first, then each correction; the result lists what succeeded and what failed,
  and a failed correction never rolls back the downtime change. Recurring corrections are never
  changed here (the dialog says how many there are); edit them in Datadog.
- **Who changed it:** extending or canceling a downtime or SLO correction appends a line to its
  message or description, keeping the existing text, for example
  `Extended to 2026-11-02T18:00:00.000Z by Ada Lovelace (ada@example.com) via Downtime Manager at 2026-11-02T12:00:00.000Z`.
  The detail panel shows the latest one as **Last changed by**. See
  [Who changed what](#who-changed-what).
- **Search:** a Datadog-style search bar. Free text matches monitor names (or an ID), and `key:value`
  matches monitor tags, with `*` wildcards, `-` or `NOT` to exclude, and `OR` between terms (AND is
  the default). Reserved keys: `id`, `name`, `type`, `status`, `owner`, `creator`, `scope`,
  `downtime`, `message`; use `tag:key:value` for a tag that shares a reserved name. Keys and values
  are suggested as you type.
- **Filters:** what is muted, when it ends, downtime creator, *Has SLOs* and *Started between…*.
  Filters live in the URL, so filtered views are shareable. **Export** the filtered rows to CSV or
  JSON. On small screens the filters fold behind a *Filters* button.
- **Related SLOs:** for each monitor in maintenance, the SLOs it affects, each with its SLI, error
  budget and current corrections. How an SLO is related depends on its type:
  - **Monitor-based SLOs** are computed from their own monitors, so they are related only when they
    use a monitor the downtime mutes, whatever the downtime type. One built on other monitors isn't
    affected, even when its tags match.
  - **Count-based (metric) and time-slice SLOs** have no monitors, so they are related by tags: an
    SLO is related when it carries the downtime's **group scope**. A downtime on monitor tags
    `env:prod` with scope `project:gen2` relates every such SLO tagged `project:gen2`, whether or
    not it's tagged `env:prod`. `OR` scopes relate SLOs carrying either side, and excluded terms
    (`-project:x`, `NOT project:x`) are never required. When the scope is `*` (or only exclusions),
    the downtime's monitor tags are used instead. A downtime on a monitor ID relates them through
    its group scope too, as long as the scope names more than an environment (`env:dev` alone
    relates nothing); without a scope it relates none.
  - **Strict SLO matching** (toggle in the SLO corrections view, or `?slomatch=strict` in the URL)
    restores the narrower rule for count-based and time-slice SLOs: the SLO must carry every
    monitor tag and every scope term.
- **SLO corrections:** a view listing the active, scheduled and recurring corrections on those SLOs
  (including corrections that target SLOs by tag query), with how long they run and how long is
  left. One-time corrections can be **extended** (start kept, end moved) or **canceled**. Canceling
  an active correction ends it now, which keeps the time already excluded; deleting it would count
  that time against the SLO retroactively. A correction that hasn't started yet is deleted.
  Recurring corrections are edited in Datadog.
- **Dashboard-friendly:** the layout adapts from full screen down to a small dashboard widget.
  On a dashboard, the dashboard's **template variables** filter the monitors by tag, the way other
  widgets apply them: `$env` with prefix `env` set to `prod` keeps monitors tagged `env:prod`.
  A multi-value selection matches any of its values, and `*` means no filter. The active variables
  appear under the search bar ("From dashboard: …"), combined with your own search. Use
  **Ignore dashboard variables** to see every monitor in that widget.

## Permissions

A published Datadog app runs as its **author** (the account that deployed it), not as the person
viewing it ([App execution identity](https://docs.datadoghq.com/actions/app_builder/access_and_auth/#app-execution-identity)).
When CI deploys, the author is the owner of the application key in `DATADOG_APP_KEY`. That account
needs:

- **Monitors Read**: list monitors and downtimes.
- **Monitors Downtime** (`monitors_downtime`): cancel and extend downtimes.
- **User Access Read**: show downtime creators' names.
- **SLOs Read**: list SLOs and their corrections.
- **SLOs Corrections** (`slos_corrections`): extend and cancel SLO corrections, including the ones
  changed together with a downtime. Without it, the downtime still changes and each correction is
  reported as refused with this permission named.

A service account with exactly these permissions is the safest owner for the deploy key. Who can
open the app is controlled separately, in the app's permissions in App Builder.

### Who changed what

Because the app runs as its author, Datadog's Audit Trail attributes every extend and cancel to
that account (the deploy account), not to the person who clicked. The app therefore keeps its own
record: each extend or cancel appends a `… by <name> (<email>) via Downtime Manager at <time>` line
to the downtime message or SLO correction description.

- The identity comes from the Datadog Apps runtime on the backend
  (`getInitiatingUser()` from `@datadog/apps-backend/user`), not from the browser, so a viewer
  can't change it. It is validated and length-limited before it is written.
- Downtime messages support @-notifications, so the email's `@` is written as a lookalike
  character (`＠`) and the line never notifies anyone.
- A canceled downtime can't be edited, so the line is written first and the downtime is canceled
  next. If that cancel fails, the error says the message was already updated.
- A scheduled SLO correction that is canceled is deleted, so there is nothing left to record on.
- This is a convenience record, not an audit log: anyone who can edit the downtime in Datadog can
  edit or remove the line.

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
3. Add an environment variable `DATADOG_SITE` when the org isn't on `app.datadoghq.com`:
   - its site for orgs outside US1 (`datadoghq.eu`, `us3.datadoghq.com`, `us5.datadoghq.com`,
     `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com`);
   - its custom subdomain on that site when it has one, such as `demo.datadoghq.com` or
     `acme.datadoghq.eu`. The app is deployed to the site, and its links open the org's own host.
     Without it, links go to `app.<site>` unless the browser exposes the page the app is embedded in.
4. Add the environment to the repository variable `DATADOG_DEPLOY_TARGETS`, a JSON list such as
   `["datadog-production", "datadog-eu"]`. Without this variable only `datadog-production`
   (which uses the repository secrets) deploys.

Every push to `main` then deploys to each target. One org failing doesn't stop the others. To try
a new org first, run the workflow manually (**Actions → Datadog App → Run workflow**) with that
environment as `target`. Each org's links come from its own `DATADOG_SITE`, so one org's
subdomain never leaks into another's copy. The app keeps the same `id` everywhere; each org gets its own copy.

To deploy manually instead: `npm run upload` publishes live immediately to the org you're logged
into. Use `npx datadog-apps upload --org <org UUID>` or `--site <site>` to pick another org; run
`npx datadog-apps auth status` to list them. For an org with a custom subdomain, prefix the
command with `APP_LINK_SITE=<subdomain>.<site>` (for example `demo.datadoghq.com`) so links open
that host.

> Never change `id` in `datadog-app.config.json`. It is the app's permanent identity, and changing
> it makes the next upload create a duplicate app.
