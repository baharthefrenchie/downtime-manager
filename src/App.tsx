import { useQuery } from '@tanstack/react-query';
import { Button } from '@datadog/druids/form/Button';
import { Grid } from '@datadog/druids/layout/Grid';
import { GridItem } from '@datadog/druids/layout/GridItem';
import { Spacing } from '@datadog/druids/layout/Spacing';
import { Text } from '@datadog/druids/typography/Text';

import { getGreeting } from './getGreeting.backend';

function App() {
    const { data: greeting, isLoading, isError } = useQuery({
        queryKey: ['greeting'],
        queryFn: () => getGreeting("oncall-downtime"),
    });

    let greetingText: string;
    if (isLoading) {
        greetingText = 'Calling a backend function…';
    } else if (isError) {
        greetingText = 'Unable to load greeting.';
    } else {
        greetingText = greeting ?? '';
    }

    return (
        <Spacing as="main" padding="lg">
            <Grid columns={1} gap="lg" isFullWidth>
                <GridItem>
                    <Spacing as="section" padding="lg">
                        <Text as="h1" size="xl" weight="bold" marginBottom="sm">
                            Welcome to oncall-downtime
                        </Text>
                        <Text as="p" size="md" variant="secondary" marginBottom="md">
                            Your Datadog App is ready. Build your experience with
                            DRUIDS components, Datadog backend functions, and the
                            app upload workflow.
                        </Text>
                        <Text as="p" size="md" marginBottom="md">
                            {greetingText}
                        </Text>
                        <Button
                            href="https://docs.datadoghq.com/actions/datadog_apps/"
                            isExternal
                            isPrimary
                            label="Open Datadog Apps docs"
                        />
                    </Spacing>
                </GridItem>
            </Grid>
        </Spacing>
    );
}

export default App;
