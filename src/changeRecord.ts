/**
 * The app's own record of who extended or cancelled a downtime or SLO
 * correction. A published app runs as its author, so Audit Trail shows the
 * deploy account; this line, appended to the downtime message or correction
 * description, names the person who clicked. Pure logic, shared by the
 * backend (writing) and the frontend (reading).
 */

export interface Actor {
    name: string | null;
    email: string | null;
}

export type ChangeAction = 'Extended' | 'Cancelled';

export interface ChangeRecord {
    action: ChangeAction;
    /** New end, for extensions. */
    end: string | null;
    by: string;
    at: string;
}

const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 120;
const APP_NAME = 'Downtime Manager';
// Fullwidth commercial at: reads like "@" but isn't Datadog's @-notification syntax.
const SAFE_AT = '\uFF20';

/** Strips control characters and markup, collapses whitespace and limits length. */
function cleanText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const cleaned = value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, ' ')
        .replace(/[<>[\]()`*_#|\\{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned ? cleaned.slice(0, maxLength).trim() : null;
}

/** Validates and length-limits a user identity before it is written anywhere. */
export function sanitizeActor(raw: { name?: unknown; email?: unknown } | null | undefined): Actor {
    const name = cleanText(raw?.name, MAX_NAME_LENGTH)?.replace(/@/g, '') || null;
    const email = cleanText(raw?.email, MAX_EMAIL_LENGTH);
    const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    return { name, email: validEmail };
}

/** "Name (email)", or whichever is known. */
export function actorLabel(actor: Actor): string {
    if (actor.name && actor.email && actor.name !== actor.email) return `${actor.name} (${actor.email})`;
    return actor.name || actor.email || 'an unidentified user';
}

/**
 * The line appended to a message or description, for example:
 * `Extended to 2026-11-02T18:00:00.000Z by Ada Lovelace (ada@example.com) via Downtime Manager at 2026-11-02T12:00:00.000Z`.
 * With `avoidMentions` (downtime messages, which support @-notifications), the
 * email's "@" is written as a lookalike so the line never notifies anyone.
 */
export function changeLine(
    action: ChangeAction,
    actor: Actor,
    nowIso: string,
    options: { end?: string; avoidMentions?: boolean } = {},
): string {
    const by = options.avoidMentions ? actorLabel(actor).replace(/@/g, SAFE_AT) : actorLabel(actor);
    const what = action === 'Extended' && options.end ? `Extended to ${options.end}` : action;
    return `${what} by ${by} via ${APP_NAME} at ${nowIso}`;
}

/** Keeps the existing text and appends the line on its own paragraph. */
export function appendChangeLine(existing: string | null | undefined, line: string): string {
    const text = (existing ?? '').trimEnd();
    return text ? `${text}\n\n${line}` : line;
}

const LINE_PATTERN = new RegExp(
    `^(Extended to (\\S+)|Extended|Cancelled) by (.+) via ${APP_NAME} at (\\S+)\\s*$`,
    'gm',
);

/** The most recent change line in a message or description, if any. */
export function lastChange(text: string | null | undefined): ChangeRecord | null {
    if (!text) return null;
    let last: ChangeRecord | null = null;
    for (const match of text.matchAll(LINE_PATTERN)) {
        last = {
            action: match[1].startsWith('Extended') ? 'Extended' : 'Cancelled',
            end: match[2] ?? null,
            by: match[3].replace(new RegExp(SAFE_AT, 'g'), '@'),
            at: match[4],
        };
    }
    return last;
}
