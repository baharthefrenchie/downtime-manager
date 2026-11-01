import '@datadog/druids/styles.css';

import { DruidsEnvironmentWithThemeInput } from '@datadog/apps-frontend/druids/react';
import { DatadogAppProvider } from '@datadog/apps-frontend/embedding/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const queryClient = new QueryClient();
const appRoot = document.getElementById('app');
if (appRoot) {
    createRoot(appRoot).render(
        <StrictMode>
            <DatadogAppProvider>
                <QueryClientProvider client={queryClient}>
                    <DruidsEnvironmentWithThemeInput
                        backgroundColor="standard"
                        defaultThemePreference="light"
                    >
                        <App />
                    </DruidsEnvironmentWithThemeInput>
                </QueryClientProvider>
            </DatadogAppProvider>
        </StrictMode>,
    );
} else {
    console.error('Missing #app div for createRoot.');
}
