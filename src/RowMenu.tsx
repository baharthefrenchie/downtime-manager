import type { ReactNode } from 'react';

import { Button } from '@datadog/druids/form/Button';
import { Popover } from '@datadog/druids/dialogs/Popover';
import { PopoverMenuItem } from '@datadog/druids/dialogs/PopoverMenuItem';
import { KebabHorizontalIcon } from '@datadog/druids/icons/KebabHorizontal';

export interface RowMenuItem {
    label: string;
    onSelect?: () => void;
    href?: string;
    level?: 'default' | 'danger';
    /** Why the item can't be used right now; the item is disabled when set. */
    disabledReason?: string | null;
    hasSeparatorTop?: boolean;
}

/**
 * A "⋯" menu for one table row. Clicks inside it don't reach the row, so
 * choosing an action never also opens the row's side panel.
 */
export function RowMenu({ label, items, handle }: { label: string; items: RowMenuItem[]; handle?: ReactNode }) {
    return (
        <span className="row-menu" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Popover
                handle={handle ?? <Button size="sm" isBorderless icon={KebabHorizontalIcon} ariaLabel={label} tooltip={label} />}
                placement="bottom-end"
                willCloseOnClick
                isPadded={false}
                stopPropagationOnHandleClick
            >
                {items.map((item) => (
                    <PopoverMenuItem
                        key={item.label}
                        label={item.label}
                        level={item.level}
                        href={item.disabledReason ? undefined : item.href}
                        isExternal={Boolean(item.href)}
                        isDisabled={Boolean(item.disabledReason)}
                        tooltip={item.disabledReason ?? undefined}
                        hasSeparatorTop={item.hasSeparatorTop}
                        action={item.onSelect && !item.disabledReason ? () => item.onSelect?.() : undefined}
                    />
                ))}
            </Popover>
        </span>
    );
}
