import { useEffect, useMemo, useRef, useState } from 'react';

import { InputSearch } from '@datadog/druids/form/InputSearch';
import { Text } from '@datadog/druids/typography/Text';

import type { CoverageRow } from './coverage';
import { suggestionsFor, tagIndex, type Suggestion } from './search';

interface SearchBarProps {
    value: string;
    rows: CoverageRow[];
    onChange: (query: string) => void;
}

const DEBOUNCE_MS = 200;

/** The token being typed: everything after the last space outside quotes. */
function currentToken(text: string): { start: number; token: string } {
    let inQuotes = false;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') inQuotes = !inQuotes;
        else if (text[i] === ' ' && !inQuotes) start = i + 1;
    }
    return { start, token: text.slice(start) };
}

/**
 * Datadog-style search: free text on monitor names, `key:value` on tags (with
 * wildcards, `-`/`NOT`, `OR`), with key and value suggestions as you type.
 */
export function SearchBar({ value, rows, onChange }: SearchBarProps) {
    const [text, setText] = useState(value);
    const [isOpen, setIsOpen] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);

    // Follow outside changes (e.g. "Clear filters").
    const [lastValue, setLastValue] = useState(value);
    if (value !== lastValue) {
        setLastValue(value);
        if (value !== text) setText(value);
    }

    useEffect(() => {
        if (text === value) return undefined;
        const timer = window.setTimeout(() => onChange(text), DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [text, value, onChange]);

    const index = useMemo(() => tagIndex(rows), [rows]);
    const { start, token } = currentToken(text);
    const suggestions = useMemo<Suggestion[]>(
        () => (token && !/^(AND|OR|NOT)$/.test(token) ? suggestionsFor(token, index, rows) : []),
        [token, index, rows],
    );
    const showSuggestions = isOpen && suggestions.length > 0;

    const accept = (suggestion: Suggestion) => {
        const completesValue = !suggestion.insert.endsWith(':');
        const next = `${text.slice(0, start)}${suggestion.insert}${completesValue ? ' ' : ''}`;
        setText(next);
        setHighlighted(0);
        if (completesValue) onChange(next.trim());
        inputRef.current?.focus();
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (!showSuggestions) {
            if (event.key === 'ArrowDown') setIsOpen(true);
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlighted((i) => (i + 1) % suggestions.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            accept(suggestions[Math.min(highlighted, suggestions.length - 1)]);
        } else if (event.key === 'Escape') {
            setIsOpen(false);
        }
    };

    return (
        <div className="search-bar">
            <InputSearch
                ref={inputRef}
                size="sm"
                isFullWidth
                isMonospace
                value={text}
                spellCheck={false}
                autoComplete="off"
                aria-describedby="search-help"
                placeholder='Search monitors, or filter by tag: env:prod service:web-* -team:db "error rate"'
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setText(event.target.value);
                    setIsOpen(true);
                    setHighlighted(0);
                }}
                onFocus={() => setIsOpen(true)}
                onBlur={() => window.setTimeout(() => setIsOpen(false), 150)}
                onKeyDown={onKeyDown}
            />
            <span id="search-help" className="visually-hidden">
                Free text searches monitor names. Use key:value for tags, * as a wildcard, - or NOT to exclude, and OR
                between terms. Reserved keys: id, name, type, status, owner, creator, scope, downtime, message.
            </span>
            {showSuggestions && (
                <ul className="search-suggestions" role="listbox" aria-label="Search suggestions">
                    {suggestions.map((suggestion, i) => (
                        <li
                            key={suggestion.insert}
                            role="option"
                            aria-selected={i === highlighted}
                            className={i === highlighted ? 'is-highlighted' : undefined}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                accept(suggestion);
                            }}
                            onMouseEnter={() => setHighlighted(i)}
                        >
                            <Text size="sm" isMonospace hasEllipsis>
                                {suggestion.label}
                            </Text>
                            {suggestion.hint && (
                                <Text size="xs" variant="tertiary" hasEllipsis>
                                    {suggestion.hint}
                                </Text>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
