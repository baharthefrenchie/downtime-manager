import { DateRangePicker } from '@datadog/druids/time/DateRangePicker';

interface DateFilterProps {
    start: number;
    end: number;
    onChange: (range: { start: number; end: number }) => void;
}

/**
 * Downtime start-date filter. Kept in its own module so the date picker loads
 * only when the filter is turned on (it is a large part of the design system).
 */
export function DateFilter({ start, end, onChange }: DateFilterProps) {
    return (
        <DateRangePicker
            canPickFutureDates
            hasRewind={false}
            hasPlay={false}
            hasForward={false}
            timeFrame={{ start, end, paused: true }}
            setTimeFrame={(timeFrame) => onChange({ start: timeFrame.start, end: timeFrame.end })}
        />
    );
}
