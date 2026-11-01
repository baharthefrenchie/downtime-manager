# Backend Functions

Backend functions are Datadog-managed server-side functions. They do not ship to the browser.

## File and export conventions

- Backend files match `*.backend.ts`, `*.backend.js`, `*.backend.tsx`, or `*.backend.jsx`.
- Export named async functions from backend files.
- Frontend code imports backend functions like normal ES modules.
- The Datadog Vite plugin rewrites backend imports into proxy calls at build time.

## Runtime behavior

- `npm run dev` runs each backend-function call in its own fresh Node process, the way production does. Nothing in memory carries over between calls, and logs appear in the dev server's terminal.
- `npm run dev:verify` routes the same backend functions through the real cloud path instead — the same sandboxed environment a deployed app uses — as a pre-publish parity check. Use it before publishing if local behavior needs to be confirmed against production.
- Deployed apps call backend functions through the embedded Datadog runtime bridge.

## Backend helper library

Datadog provides `@datadog/apps-backend`, a library of tools to make backend function development easier. Check it out when working on backend functions.

## Security rules

- Keep privileged Datadog API calls, third-party calls, and secret-dependent work in backend functions.
- Never hardcode API keys, app keys, OAuth tokens, passwords, private keys, or third-party credentials.
- Frontend code should not call Datadog APIs or other privileged services directly.
- Validate frontend inputs before using them in backend function calls.
- These rules hold under `npm run dev` too: each call's process blocks subprocesses but not raw network access, so the generic HTTP action described below is the only sanctioned outbound path.

## External network requests

All external network requests must use the generic HTTP action from `@datadog/action-catalog/http/http` in a backend function. Never call `fetch` or use Node.js networking APIs to contact an external service directly, including from a backend function.

```ts
// src/getExternalData.backend.ts
import { request } from '@datadog/action-catalog/http/http';

export async function getExternalData() {
    return request({
        inputs: {
            verb: 'GET',
            url: 'https://api.example.com/data',
            responseParsing: 'json',
            errorOnStatus: ['400-599'],
        },
    });
}
```

A connection is not required. Omit `connectionId` by default. Include it only when an existing Datadog HTTP connection contains authentication the request needs. Most users will not have one because a human must create it in the Datadog UI and copy its ID into the app. When a suitable connection does exist, pass its ID as `connectionId` alongside `inputs`.

## Action Catalog

Prefer `@datadog/action-catalog` for supported Datadog, cloud, SaaS, and HTTP workflows. Check the installed package exports before generating imports; do not invent subpaths.

```ts
// src/listHosts.backend.ts
import { listHosts, type ListHostsResponse } from '@datadog/action-catalog/dd/hosts';

export async function getHosts(filter?: string): Promise<ListHostsResponse> {
    return listHosts({
        inputs: {
            filter: filter ?? '*',
            count: 10,
            include_hosts_metadata: true,
        },
    });
}
```

```tsx
// src/App.tsx
import { useQuery } from '@tanstack/react-query';

import { getHosts } from './listHosts.backend';

function HostCount() {
    const hostsQuery = useQuery({
        queryKey: ['hosts', '*'],
        queryFn: () => getHosts('*'),
    });

    if (hostsQuery.isLoading) {
        return <span>Loading hosts...</span>;
    }

    if (hostsQuery.isError) {
        return <span>Unable to load hosts.</span>;
    }

    return <span>{hostsQuery.data?.host_list?.length ?? 0}</span>;
}
```

Always wrap backend function proxies before passing them to React Query or
another framework callback. Do not use `queryFn: getHosts`: React Query calls
its callback with a context object containing an `AbortSignal`, and the
embedded app bridge cannot structured-clone that object for a backend
invocation. Pass only the cloneable arguments the backend function declares:

```tsx
// Correct
queryFn: () => getHosts('*'),

// Incorrect
queryFn: getHosts,
```

The generated app wraps React in `QueryClientProvider` in `src/main.tsx`. Prefer React Query for backend function calls that need loading, error, caching, retry, refetch, or deduplication behavior.

## Broader data workflows

- For choosing between DDSQL and Action Catalog, configuring Connections, or querying app datastores, read `docs/agents/data.md`.
- For triggering or polling a Workflow Automation workflow, read `docs/agents/workflow-automation.md`.
