/**
 * Datadog-style search over monitors in maintenance.
 *
 * Syntax (case-insensitive, like Datadog search bars):
 * - `checkout latency`        free text: every word must appear in the monitor name (or equal its ID)
 * - `"checkout latency"`      quoted phrase
 * - `env:prod`                monitor tag; values accept `*` wildcards (`service:web-*`), `env:*` = has the key
 * - `-env:staging`, `NOT …`   negation
 * - `a b`, `a AND b`          all terms must match (AND is the default)
 * - `a OR b`                  either side matches (OR binds looser than AND, no parentheses)
 * - reserved keys: id, name, type, status, owner, creator, scope, downtime, message
 * - `tag:type:foo`             explicit tag, for tags whose key is also a reserved key
 * - `env:` with no value yet is ignored (use `env:*` for "has the tag")
 */
import type { CoverageRow } from './coverage';

export const RESERVED_KEYS = ['id', 'name', 'type', 'status', 'owner', 'creator', 'scope', 'downtime', 'message'] as const;
type ReservedKey = (typeof RESERVED_KEYS)[number];

export const RESERVED_KEY_HINTS: Record<ReservedKey, string> = {
    id: 'Monitor ID',
    name: 'Monitor name',
    type: 'Monitor type, e.g. metric alert',
    status: 'Monitor state: OK, Alert, Warn, No Data…',
    owner: 'Monitor owner',
    creator: 'Downtime creator',
    scope: 'Downtime scope',
    downtime: 'Downtime ID',
    message: 'Downtime message',
};

const TAG_PREFIX = 'tag\u0000';

export interface SearchTerm {
    /** Lowercased key, or null for free text. */
    key: string | null;
    /** Lowercased value (may contain `*`). */
    value: string;
    negated: boolean;
}

/** OR of AND-groups. An empty query has no groups and matches everything. */
export type ParsedQuery = SearchTerm[][];

function tokenize(query: string): string[] {
    const tokens: string[] = [];
    const pattern = /(-?)((?:[^\s"]*"[^"]*"?)+[^\s"]*|[^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
        tokens.push(match[1] + match[2]);
    }
    return tokens;
}

function unquote(value: string): string {
    return value.replace(/"/g, '');
}

function toTerm(token: string, negated: boolean): SearchTerm | null {
    let raw = token;
    let isNegated = negated;
    if (raw.startsWith('-') && raw.length > 1) {
        isNegated = !isNegated;
        raw = raw.slice(1);
    }
    // A colon outside quotes splits key and value: `env:prod`, `service:"web store"`.
    const colon = raw.indexOf(':');
    const quote = raw.indexOf('"');
    if (colon > 0 && (quote === -1 || colon < quote)) {
        let key = raw.slice(0, colon).toLowerCase();
        let value = unquote(raw.slice(colon + 1)).toLowerCase();
        // `tag:key:value` forces a tag match, even when `key` is a reserved key.
        if (key === 'tag') {
            const inner = value.indexOf(':');
            if (inner <= 0) return null;
            key = `${TAG_PREFIX}${value.slice(0, inner)}`;
            value = value.slice(inner + 1);
        }
        // An incomplete `key:` (still being typed) doesn't filter yet.
        if (!value) return null;
        return { key, value, negated: isNegated };
    }
    const value = unquote(raw).toLowerCase();
    return value ? { key: null, value, negated: isNegated } : null;
}

export function parseQuery(query: string): ParsedQuery {
    const groups: ParsedQuery = [[]];
    let negateNext = false;
    for (const token of tokenize(query.trim())) {
        if (token === 'OR' || token === '||') {
            if (groups[groups.length - 1].length > 0) groups.push([]);
            negateNext = false;
            continue;
        }
        if (token === 'AND' || token === '&&') continue;
        if (token === 'NOT' || token === '!') {
            negateNext = !negateNext;
            continue;
        }
        const term = toTerm(token, negateNext);
        negateNext = false;
        if (term) groups[groups.length - 1].push(term);
    }
    return groups.filter((group) => group.length > 0);
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/** Exact (or wildcard) match on one value, case-insensitive. */
function valueMatches(pattern: string, candidate: string): boolean {
    return pattern.includes('*') ? globToRegExp(pattern).test(candidate) : candidate.toLowerCase() === pattern;
}

/** Substring match (wildcards allowed), case-insensitive. */
function textContains(pattern: string, text: string): boolean {
    const haystack = text.toLowerCase();
    if (!pattern.includes('*')) return haystack.includes(pattern);
    return globToRegExp(`*${pattern}*`).test(haystack);
}

function tagMatches(key: string, value: string, tags: string[]): boolean {
    return tags.some((tag) => {
        const colon = tag.indexOf(':');
        const tagKey = (colon === -1 ? tag : tag.slice(0, colon)).toLowerCase();
        const tagValue = colon === -1 ? '' : tag.slice(colon + 1);
        if (tagKey !== key) return false;
        return value === '*' || valueMatches(value, tagValue);
    });
}

function termMatchesRow(term: SearchTerm, row: CoverageRow): boolean {
    const { monitor } = row;
    const { key, value } = term;
    if (key === null) {
        return String(monitor.id) === value || textContains(value, monitor.name);
    }
    if (key.startsWith(TAG_PREFIX)) {
        return tagMatches(key.slice(TAG_PREFIX.length), value, monitor.tags);
    }
    switch (key as ReservedKey) {
        case 'id':
            return valueMatches(value, String(monitor.id));
        case 'name':
            return textContains(value, monitor.name);
        case 'type':
            return textContains(value, monitor.type);
        case 'status':
            return valueMatches(value, monitor.overallState) || valueMatches(value, monitor.overallState.replace(/\s+/g, ''));
        case 'owner':
            return textContains(value, row.owner);
        case 'creator':
            return row.downtimeCreators.some((creator) => textContains(value, creator));
        case 'scope':
            return row.matches.some((match) => textContains(value, match.downtime.scope ?? '*'));
        case 'downtime':
            return row.matches.some((match) => valueMatches(value, match.downtime.id));
        case 'message':
            return row.matches.some((match) => textContains(value, match.downtime.message ?? ''));
        default:
            return tagMatches(key, value, monitor.tags);
    }
}

export function rowMatchesQuery(row: CoverageRow, query: ParsedQuery): boolean {
    if (query.length === 0) return true;
    return query.some((group) => group.every((term) => termMatchesRow(term, row) !== term.negated));
}

export interface Suggestion {
    /** Text that replaces the token being typed. */
    insert: string;
    label: string;
    hint?: string;
}

/** Tag key → values (with counts) across the given monitors. */
export function tagIndex(rows: CoverageRow[]): Map<string, Map<string, number>> {
    const index = new Map<string, Map<string, number>>();
    rows.forEach((row) =>
        row.monitor.tags.forEach((tag) => {
            const colon = tag.indexOf(':');
            if (colon <= 0) return;
            const key = tag.slice(0, colon).toLowerCase();
            const value = tag.slice(colon + 1);
            const values = index.get(key) ?? new Map<string, number>();
            values.set(value, (values.get(value) ?? 0) + 1);
            index.set(key, values);
        }),
    );
    return index;
}

const quoteIfNeeded = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value);

/**
 * Suggestions for the token being typed (the text after the last space):
 * keys while typing a key, then that key's values after the colon.
 */
export function suggestionsFor(
    token: string,
    tags: Map<string, Map<string, number>>,
    rows: CoverageRow[],
    limit = 8,
): Suggestion[] {
    const negation = token.startsWith('-') ? '-' : '';
    const bare = negation ? token.slice(1) : token;
    const explicitTag = bare.toLowerCase().startsWith('tag:');
    const body = explicitTag ? bare.slice(4) : bare;
    const colon = body.indexOf(':');
    if (colon > 0) {
        const key = body.slice(0, colon).toLowerCase();
        const typed = unquote(body.slice(colon + 1)).toLowerCase();
        const insertKey = explicitTag ? `tag:${key}` : key;
        let values: [string, number][] = [];
        if (!explicitTag && (key === 'status' || key === 'type' || key === 'owner')) {
            const counts = new Map<string, number>();
            rows.forEach((row) => {
                const value = key === 'status' ? row.monitor.overallState : key === 'type' ? row.monitor.type : row.owner;
                counts.set(value, (counts.get(value) ?? 0) + 1);
            });
            values = [...counts];
        } else if (explicitTag || !(RESERVED_KEYS as readonly string[]).includes(key)) {
            values = [...(tags.get(key) ?? new Map<string, number>())];
        }
        return values
            .filter(([value]) => value.toLowerCase().includes(typed))
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, limit)
            .map(([value, count]) => ({
                insert: `${negation}${insertKey}:${quoteIfNeeded(value)}`,
                label: `${insertKey}:${value}`,
                hint: `${count} monitor${count === 1 ? '' : 's'}`,
            }));
    }
    const typed = bare.toLowerCase();
    const reserved = RESERVED_KEYS.filter((key) => key.startsWith(typed)).map((key) => ({
        insert: `${negation}${key}:`,
        label: `${key}:`,
        hint: RESERVED_KEY_HINTS[key],
    }));
    const isReserved = (key: string) => (RESERVED_KEYS as readonly string[]).includes(key);
    const tagKeys = [...tags]
        .filter(([key]) => key.startsWith(typed))
        .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
        // A tag named like a reserved key is offered as `tag:key:` so both stay reachable.
        .map(([key, values]) => {
            const prefix = isReserved(key) ? `tag:${key}:` : `${key}:`;
            return { insert: `${negation}${prefix}`, label: prefix, hint: `tag · ${values.size} values` };
        });
    const seen = new Set<string>();
    return [...reserved, ...tagKeys].filter((s) => !seen.has(s.insert) && seen.add(s.insert)).slice(0, limit);
}

/** A dashboard template variable, as the `datadog.dashboard` input provides it. */
export interface DashboardTemplateVariable {
    name: string;
    value: string;
    values?: string[];
    prefix?: string;
    default?: string;
}

/** One active template-variable filter: the monitor needs `key:<any of values>`. */
export interface TemplateVariableFilter {
    name: string;
    key: string;
    values: string[];
}

/**
 * Turns dashboard template variables into tag filters, the way dashboard widgets
 * apply them: `prefix:value`, any of a multi-value selection. `*` or an empty
 * selection means "no filter". A variable without a prefix applies only when its
 * value is a full `key:value` tag.
 */
export function templateVariableFilters(variables: DashboardTemplateVariable[] | undefined): TemplateVariableFilter[] {
    const filters: TemplateVariableFilter[] = [];
    for (const variable of variables ?? []) {
        const selected = (variable.values?.length ? variable.values : [variable.value])
            .map((value) => (value ?? '').trim())
            .filter(Boolean);
        if (selected.length === 0 || selected.includes('*')) continue;
        const prefix = variable.prefix?.trim();
        if (prefix) {
            filters.push({ name: variable.name, key: prefix.toLowerCase(), values: selected.map((v) => v.toLowerCase()) });
            continue;
        }
        // No prefix: only full `key:value` selections can be mapped to monitor tags.
        const byKey = new Map<string, string[]>();
        selected.forEach((value) => {
            const colon = value.indexOf(':');
            if (colon <= 0) return;
            const key = value.slice(0, colon).toLowerCase();
            byKey.set(key, [...(byKey.get(key) ?? []), value.slice(colon + 1).toLowerCase()]);
        });
        byKey.forEach((values, key) => filters.push({ name: variable.name, key, values }));
    }
    return filters;
}

/** A monitor matches when, for every filter, it has the tag key with one of the selected values. */
export function rowMatchesTemplateVariables(row: CoverageRow, filters: TemplateVariableFilter[]): boolean {
    return filters.every((filter) => filter.values.some((value) => tagMatches(filter.key, value, row.monitor.tags)));
}
