/**
 * A small parser for Datadog downtime scopes (and SLO correction queries),
 * such as `env:prod AND (service:api OR service:web) -host:canary`.
 *
 * Supported: `AND`, `OR`, `NOT`, a leading `-` (or `!`), parentheses, implicit
 * AND between terms, commas (the legacy AND separator), `*` and `?`
 * wildcards, and quoted values (`host:"i-123"`). Pure logic, no Datadog calls.
 */

export type ScopeExpr =
    /** `*` or an empty scope: every group. */
    | { type: 'all' }
    | { type: 'term'; pattern: string }
    | { type: 'not'; expr: ScopeExpr }
    | { type: 'and'; children: ScopeExpr[] }
    | { type: 'or'; children: ScopeExpr[] };

type Token = { kind: '(' | ')' | 'AND' | 'OR' | 'NOT' } | { kind: 'term'; text: string };

function tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
        const char = input[i];
        if (/\s|,/.test(char)) {
            // A comma is the legacy AND separator.
            if (char === ',') tokens.push({ kind: 'AND' });
            i++;
            continue;
        }
        if (char === '(' || char === ')') {
            tokens.push({ kind: char });
            i++;
            continue;
        }
        // A leading - or ! negates the next term or group.
        if ((char === '-' || char === '!') && i + 1 < input.length && !/\s/.test(input[i + 1])) {
            tokens.push({ kind: 'NOT' });
            i++;
            continue;
        }
        let text = '';
        let inQuotes = false;
        while (i < input.length) {
            const c = input[i];
            if (c === '"') {
                inQuotes = !inQuotes;
                i++;
                continue;
            }
            if (!inQuotes && (/\s|,/.test(c) || c === '(' || c === ')')) break;
            text += c;
            i++;
        }
        const upper = text.toUpperCase();
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ kind: upper });
        else if (text) tokens.push({ kind: 'term', text });
    }
    return tokens;
}

function simplify(type: 'and' | 'or', children: ScopeExpr[]): ScopeExpr {
    const flat = children.flatMap((child) => (child.type === type ? child.children : [child]));
    if (flat.length === 1) return flat[0];
    return { type, children: flat };
}

/**
 * Parses a scope into a boolean expression. Never throws: unbalanced
 * parentheses are tolerated, and an empty scope or `*` means every group.
 */
export function parseScope(scope: string | null | undefined): ScopeExpr {
    const tokens = tokenize(scope ?? '');
    let pos = 0;
    const peek = () => tokens[pos];

    // or := and (OR and)*
    const parseOr = (): ScopeExpr | null => {
        const children: ScopeExpr[] = [];
        const first = parseAnd();
        if (first) children.push(first);
        while (peek()?.kind === 'OR') {
            pos++;
            const next = parseAnd();
            if (next) children.push(next);
        }
        return children.length ? simplify('or', children) : null;
    };
    // and := unary ((AND)? unary)*
    const parseAnd = (): ScopeExpr | null => {
        const children: ScopeExpr[] = [];
        while (pos < tokens.length) {
            const token = peek();
            if (token.kind === 'OR' || token.kind === ')') break;
            if (token.kind === 'AND') {
                pos++;
                continue;
            }
            const unary = parseUnary();
            if (unary) children.push(unary);
        }
        return children.length ? simplify('and', children) : null;
    };
    // unary := NOT unary | '(' or ')' | term
    const parseUnary = (): ScopeExpr | null => {
        const token = tokens[pos++];
        if (!token) return null;
        if (token.kind === 'NOT') {
            const inner = parseUnary();
            return inner ? { type: 'not', expr: inner } : null;
        }
        if (token.kind === '(') {
            const inner = parseOr();
            if (peek()?.kind === ')') pos++;
            return inner;
        }
        if (token.kind === 'term') {
            return token.text === '*' ? { type: 'all' } : { type: 'term', pattern: token.text };
        }
        return null;
    };

    const parts: ScopeExpr[] = [];
    while (pos < tokens.length) {
        const expr = parseOr();
        if (expr) parts.push(expr);
        // Skip a stray `)` so the rest of the scope still parses.
        if (peek()?.kind === ')') pos++;
    }
    return parts.length === 0 ? { type: 'all' } : simplify('and', parts);
}

// Matching runs for every monitor × downtime pair, so each pattern is compiled once.
const PATTERN_CACHE_LIMIT = 5000;
const patternCache = new Map<string, RegExp | string>();

/** A case-insensitive matcher for a tag pattern: a plain string when it has no wildcard. */
function compilePattern(pattern: string): RegExp | string {
    let compiled = patternCache.get(pattern);
    if (compiled === undefined) {
        const clean = pattern.trim().replace(/"/g, '');
        if (/[*?]/.test(clean)) {
            const escaped = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            compiled = new RegExp(`^${escaped}$`, 'i');
        } else {
            compiled = clean.toLowerCase();
        }
        if (patternCache.size >= PATTERN_CACHE_LIMIT) patternCache.clear();
        patternCache.set(pattern, compiled);
    }
    return compiled;
}

/** Whether any tag matches a `key:value` pattern (with `*`/`?` wildcards, case-insensitive). */
export function tagMatches(pattern: string, tags: string[]): boolean {
    const compiled = compilePattern(pattern);
    return typeof compiled === 'string'
        ? tags.some((tag) => tag.trim().toLowerCase() === compiled)
        : tags.some((tag) => compiled.test(tag.trim()));
}

export interface EvaluateOptions {
    /**
     * Treat negated parts as satisfied instead of evaluating them. Used to
     * relate SLOs to a scope: an excluded tag is never required.
     */
    ignoreNegations?: boolean;
}

/**
 * Evaluates a scope against a set of tags. A negated term is satisfied when
 * no tag matches it; `*` is always satisfied.
 */
export function evaluateScope(expr: ScopeExpr, tags: string[], options: EvaluateOptions = {}): boolean {
    switch (expr.type) {
        case 'all':
            return true;
        case 'term':
            return tagMatches(expr.pattern, tags);
        case 'not':
            return options.ignoreNegations ? true : !evaluateScope(expr.expr, tags, options);
        case 'and':
            return expr.children.every((child) => evaluateScope(child, tags, options));
        case 'or':
            return expr.children.some((child) => evaluateScope(child, tags, options));
    }
}

/** Terms that appear outside any negation, in order and without duplicates. */
export function positiveTerms(expr: ScopeExpr): string[] {
    const terms: string[] = [];
    const walk = (node: ScopeExpr, negated: boolean) => {
        if (node.type === 'term') {
            if (!negated && !terms.includes(node.pattern)) terms.push(node.pattern);
        } else if (node.type === 'not') {
            walk(node.expr, !negated);
        } else if (node.type === 'and' || node.type === 'or') {
            node.children.forEach((child) => walk(child, negated));
        }
    };
    walk(expr, false);
    return terms;
}
