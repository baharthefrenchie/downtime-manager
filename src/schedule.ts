/**
 * Builds the schedule sent when extending a one-time downtime.
 *
 * Datadog treats a schedule update without `start` as "start now", which it
 * rejects for downtimes already in progress ("Start times of downtimes in
 * progress cannot be changed"). So the current start is resent exactly as
 * Datadog returned it, together with the new end.
 */
export function extensionSchedule(currentStart: string | null | undefined, newEndIso: string): { start: string; end: string } {
    if (!currentStart) {
        throw new Error("Couldn't read this downtime's start time, so it can't be extended safely.");
    }
    return { start: currentStart, end: newEndIso };
}
