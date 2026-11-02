import { Text } from '@datadog/druids/typography/Text';

export interface SummaryTile {
    key: string;
    label: string;
    value: number | null;
    /** One short line under the number. */
    hint?: string;
    /** Color for the number when it is above zero. */
    tone?: 'default' | 'warning' | 'danger';
    isActive: boolean;
    /** What clicking the tile does, for screen readers and the tooltip. */
    actionLabel: string;
    onClick: () => void;
}

/** A row of counts that double as one-click filters for the table. */
export function SummaryTiles({ tiles, isCompact }: { tiles: SummaryTile[]; isCompact: boolean }) {
    return (
        <div className={`summary-tiles${isCompact ? ' summary-tiles--compact' : ''}`} role="group" aria-label="Summary">
            {tiles.map((tile) => (
                <button
                    key={tile.key}
                    type="button"
                    className={`surface summary-tile${tile.isActive ? ' is-active' : ''}`}
                    aria-pressed={tile.isActive}
                    title={tile.actionLabel}
                    onClick={tile.onClick}
                >
                    <Text as="span" size="xs" variant="secondary" hasEllipsis>
                        {tile.label}
                    </Text>
                    <Text
                        as="span"
                        size={isCompact ? 'lg' : 'xl'}
                        weight="bold"
                        variant={tile.value && tile.tone && tile.tone !== 'default' ? tile.tone : 'default'}
                    >
                        {tile.value === null ? '–' : tile.value.toLocaleString()}
                    </Text>
                    {tile.hint && !isCompact && (
                        <Text as="span" size="xs" variant="tertiary" hasEllipsis>
                            {tile.hint}
                        </Text>
                    )}
                </button>
            ))}
        </div>
    );
}
