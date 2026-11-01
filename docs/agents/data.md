# Data Access

Backend functions have two primary data access paths: DDSQL and Action Catalog.

## Choosing a path

| Situation | Use |
| --- | --- |
| Read from Datadog-visible data (logs, metrics, hosts, spans, etc.) and need filtering, projection, joins, aggregation, or pagination | DDSQL |
| Mutation — create, update, delete, trigger, invoke, send | Action Catalog |
| Product workflow that maps to an existing typed action | Action Catalog |
| Simple single-record read where the typed action response is exactly what the UI needs | Action Catalog |
| External system or integration that is not DDSQL-visible | Action Catalog |
| Read from an app datastore | DDSQL (prefer for queries) or datastore actions (for simple reads/writes) |

## DDSQL

DDSQL-visible datasets include logs, APM spans, RUM events, hosts, containers, services, cloud inventory, audit trail, CI pipelines, and more. Check the [DDSQL Data Directory](https://docs.datadoghq.com/ddsql_reference/data_directory/) for the full list.

Before writing queries:

- Confirm the table name, columns, and types with a small bounded probe before writing app code.
- Verify the exact DDSQL execution API or action import against installed package exports — do not invent subpaths.
- Use fixed SQL templates. Do not accept raw frontend SQL or raw `ORDER BY` fields.
- Clamp limits and use `LIMIT` in all list queries.

### App datastores

Datastores are queryable via DDSQL. Confirm the datastore ID and column schema with a bounded probe first:

```sql
SELECT key, summary, status
FROM dd.actions_datastores(
  id => '<datastore-id>',
  columns => ARRAY ['key', 'summary', 'status']
) AS (
  key VARCHAR,
  summary VARCHAR,
  status VARCHAR
)
WHERE status = 'Open'
ORDER BY key
LIMIT 100;
```

For writes and deletes, use datastore actions from `@datadog/action-catalog` directly.

Public docs: [Datastores](https://docs.datadoghq.com/actions/datastores/), [DDSQL Reference](https://docs.datadoghq.com/ddsql_reference/)

## Connections

Connections are optional, reusable auth configuration for Action Catalog actions that need credentials (custom HTTP, integrations without a Datadog tile, etc.).

- The generic HTTP action from `@datadog/action-catalog/http/http` does not require a connection. Omit `connectionId` by default.
- Include `connectionId` only when an existing HTTP connection contains authentication the request needs.
- Find or create connections at `https://app.datadoghq.com/actions/connections`.
- Copy the Connection ID from the connection details — treat it as configuration, not a secret.
- Do not ask users to paste API keys, passwords, OAuth secrets, or private keys into an AI conversation.
- Have a human create or update connections in the Datadog UI. Most users will not already have a suitable connection because it must be created manually and its ID copied into the app.

Integrations such as GitHub, Jira, Slack, PagerDuty, and Statuspage may inherit credentials from their Datadog integration tile and may not need an explicit connection.

Public docs: [Connections](https://docs.datadoghq.com/actions/connections/), [Action Catalog](https://docs.datadoghq.com/actions/action_interface/)
