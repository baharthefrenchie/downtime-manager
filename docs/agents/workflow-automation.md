# Workflow Automation

Use this when a backend function needs to trigger a Datadog Workflow Automation workflow and poll for the result.

## Requirements

- Use a backend function, not frontend code. Backend functions can call `@datadog/action-catalog`.
- Use the generic HTTP action from `@datadog/action-catalog/http/http`.
- The HTTP action requires a Connection ID for an HTTP connection configured in your Datadog org. Find or create one at `https://app.datadoghq.com/actions/connections`.
- The target workflow must be published and must include an API trigger (`apiTrigger` in the workflow spec).
- Workflow inputs must match the workflow input schema exactly.

## Inspect the workflow first

Before wiring an app to a workflow, confirm its published shape:

```bash
workflow_id="<WORKFLOW_ID>"
curl -sS --fail-with-body \
  "https://api.datadoghq.com/api/v2/workflows/${workflow_id}" \
  -H "DD-API-KEY: ${DD_API_KEY}" \
  -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  -H "Accept: application/json" \
| jq "{
    id: .data.id,
    name: .data.attributes.name,
    published: .data.attributes.published,
    inputSchema: .data.attributes.spec.inputSchema,
    outputSchema: .data.attributes.spec.outputSchema,
    hasApiTrigger: any(.data.attributes.spec.triggers[]?; has(\"apiTrigger\"))
  }"
```

Confirm `published` is `true`, `hasApiTrigger` is `true`, and `inputSchema.parameters` matches the inputs the app will send.

## Trigger and poll pattern

Inputs go under `meta.payload`. Replace `YOUR_HTTP_CONNECTION_ID` with the ID from your Datadog org.

```ts
import { request } from '@datadog/action-catalog/http/http';

const DATADOG_HTTP_CONNECTION_ID = '<YOUR_HTTP_CONNECTION_ID>';
const DATADOG_API_BASE_URL = 'https://api.datadoghq.com';
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const INITIAL_POLL_DELAY_MS = 250;
const POLL_DELAY_MULTIPLIER = 1.05;

const jsonHeaders = [
    { key: 'Accept', value: ['application/json'] },
    { key: 'Content-Type', value: ['application/json'] },
];

type WorkflowInstanceResponse = {
    data?: {
        id?: string;
        attributes?: {
            endTimestamp?: string | null;
            outputs?: unknown;
            instanceStatus?: { detailsKind?: string; displayName?: string };
        };
    };
};

type WorkflowRunResult = {
    instanceId?: string;
    statusKind?: string;
    displayStatus?: string;
    outputs?: unknown;
    body: unknown;
};

function workflowInstancesUrl(workflowId: string) {
    return `${DATADOG_API_BASE_URL}/api/v2/workflows/${workflowId}/instances`;
}

function isRunningStatus(statusKind?: string) {
    return !statusKind || statusKind === 'IN_PROGRESS';
}

function toRunResult(body: unknown): WorkflowRunResult {
    const response = body as WorkflowInstanceResponse | undefined;
    return {
        instanceId: response?.data?.id,
        statusKind: response?.data?.attributes?.instanceStatus?.detailsKind,
        displayStatus: response?.data?.attributes?.instanceStatus?.displayName,
        outputs: response?.data?.attributes?.outputs,
        body,
    };
}

export async function triggerWorkflow(
    workflowId: string,
    payload: Record<string, unknown>,
): Promise<WorkflowRunResult> {
    const response = await request({
        connectionId: DATADOG_HTTP_CONNECTION_ID,
        inputs: {
            verb: 'POST',
            url: workflowInstancesUrl(workflowId),
            requestHeaders: jsonHeaders,
            responseParsing: 'json',
            errorOnStatus: ['400-599'],
            body: JSON.stringify({ meta: { payload } }),
        },
    });
    return toRunResult(response.body);
}

export async function pollWorkflowInstance(
    workflowId: string,
    instanceId: string,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<WorkflowRunResult> {
    const expiresAt = Date.now() + timeoutMs;
    let delay = INITIAL_POLL_DELAY_MS / POLL_DELAY_MULTIPLIER;

    while (Date.now() < expiresAt) {
        delay *= POLL_DELAY_MULTIPLIER;
        const jitter = delay * 0.4 * (Math.random() - 0.5);
        await new Promise<void>((resolve) => setTimeout(resolve, delay + jitter));

        const response = await request({
            connectionId: DATADOG_HTTP_CONNECTION_ID,
            inputs: {
                verb: 'GET',
                url: `${workflowInstancesUrl(workflowId)}/${instanceId}`,
                requestHeaders: jsonHeaders,
                responseParsing: 'json',
                errorOnStatus: ['400-599'],
            },
        });

        const result = toRunResult(response.body);
        if (!isRunningStatus(result.statusKind)) {
            return result;
        }
    }

    throw new Error(`Workflow instance ${instanceId} did not finish in time`);
}
```

Treat `statusKind === "SUCCEEDED"` as success. All other terminal statuses (`INSTANCE_ERROR`, `STEP_ERROR`, `CANCELED`) are failures — return the full response body so the caller can inspect `errorDetail` and partial outputs.

## Troubleshooting

- `input parameter not in workflow input schema`: update `meta.payload` keys to match `inputSchema.parameters`.
- `Expected trigger type TRIGGER_TYPE_API not found`: add and publish an API trigger on the workflow.
- 401/403: confirm `DD_API_KEY` and `DD_APP_KEY` are set with Actions API Access, and the app site matches the API host.
