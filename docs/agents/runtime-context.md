# Runtime Context

Datadog Apps are embedded inside the Datadog UI. Treat this app as iframe-hosted browser code with Datadog-managed backend execution.

## Iframe embedding

- The app runs inside an iframe owned by the Datadog UI.
- The current App Builder iframe sandbox allows scripts, popups, popups escaping the sandbox, same-origin access, forms, and top navigation only by user activation.
- Do not assume app code can control, read, or directly navigate the parent Datadog page.
- Prefer hash-based routing for in-app routes. Avoid `BrowserRouter` and routers that depend on reliable top-level History API behavior.
- In-app links should use hash URLs such as `href="#/details"`.
- External URLs can open popups or top-level navigation only through browser-supported, user-initiated flows.
- Verify the current Datadog embedding sandbox before relying on a specific browser capability. Datadog controls the sandbox attributes and may change them.

## Frontend helper library

Datadog provides `@datadog/apps-frontend`, a library of React tools to make embedded frontend development easier.
The scaffold mounts `DatadogAppProvider` from `@datadog/apps-frontend/embedding/react` at the React root;
every `@datadog/apps-frontend` hook must be called below it. `useDatadogAppInput` from `@datadog/apps-frontend/inputs/react` reads typed inputs the host provides, with schemas such as `datadogTheme` in `@datadog/apps-frontend/inputs/schema`.
For DRUIDS apps, `DruidsEnvironmentWithThemeInput` from `@datadog/apps-frontend/druids/react` is a drop-in `DruidsEnvironment` that follows the live Datadog theme; the scaffold mounts it at the React root.
URL-backed deep links are installed by the same provider: when embedded, the app's query string and fragment stay mirrored in the host page URL, so the app's routes can be shared and restored from the parent link.
Check out this library for features, tools, utils and more

## Storage and cookies

- Browser storage is scoped to the app's origin and is not shared with the parent Datadog UI.
- Storage can differ between standalone local development and embedded runtime because modern browsers partition storage by top-level site and iframe origin.
- Third-party cookies are unreliable for durable app state.
- For durable server-side state, use backend functions and a Datadog-supported durable storage mechanism.

## Backend call transport

Frontend code imports backend functions like normal ES modules, but those imports are rewritten by the Datadog Vite plugin. The function body does not run in the browser.

- In local dev (`npm run dev`), each backend call runs in its own fresh Node process, the way production does.
- `npm run dev:verify` routes the same calls through the real cloud path instead, as a pre-publish parity check.
- In deployed apps, backend calls go through the Datadog iframe/runtime bridge.
- Do not build app logic that depends on which of these transports handles a given call — the contract (async function in, structured-cloneable result out) is the same across all three.

For backend implementation details, read `backend-functions.md`.
