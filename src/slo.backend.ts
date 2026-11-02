import {
    deleteSLOCorrection,
    getSLOCorrection,
    listSLOCorrection,
    searchSLO,
    updateSLOCorrection,
    type SearchServiceLevelObjective,
} from '@datadog/action-catalog/dd/slo';

import { initiatingActor, toArray, withRateLimitRetry } from './backendUtils';
import { actorLabel, appendChangeLine, changeLine } from './changeRecord';
import type { SloContext, SloCorrectionSummary, SloSummary } from './slo';

const SLO_PAGE_SIZE = 100;
const MAX_SLO_PAGES = 50;
const SLO_PAGE_CONCURRENCY = 3;
const CORRECTION_PAGE_SIZE = 1000;
const MAX_CORRECTION_PAGES = 10;
const CORRECTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_EXTENSION_MS = 365 * 24 * 60 * 60 * 1000;

function assertCorrectionId(correctionId: unknown): string {
    if (typeof correctionId !== 'string' || !CORRECTION_ID_PATTERN.test(correctionId)) {
        throw new Error('Invalid SLO correction id.');
    }
    return correctionId;
}

function slimSlo(raw: SearchServiceLevelObjective): SloSummary | null {
    const data = raw?.data;
    const attributes = data?.attributes;
    if (!data?.id || !attributes) return null;
    const overall = toArray<{ status?: number; error_budget_remaining?: number; target?: number; timeframe?: string }>(
        attributes.overall_status,
    )[0];
    return {
        id: String(data.id),
        name: attributes.name ?? `SLO ${data.id}`,
        type: attributes.slo_type ?? 'unknown',
        monitorIds: toArray<number>(attributes.monitor_ids).map(Number).filter((id) => Number.isInteger(id) && id > 0),
        tags: toArray<string>(attributes.all_tags),
        sli: overall?.status ?? attributes.status?.sli ?? null,
        errorBudgetRemaining: overall?.error_budget_remaining ?? attributes.status?.error_budget_remaining ?? null,
        target: overall?.target ?? toArray<{ target?: number }>(attributes.thresholds)[0]?.target ?? null,
        timeframe: overall?.timeframe ?? null,
    };
}

async function fetchSloPage(page: number) {
    const response = await withRateLimitRetry(
        () => searchSLO({ inputs: { page_number: page, page_size: SLO_PAGE_SIZE } }),
        true,
    );
    return {
        slos: toArray<SearchServiceLevelObjective>(response?.data?.attributes?.slos),
        lastPage: Number(response?.meta?.pagination?.last_number ?? 0),
    };
}

async function listAllSlos(): Promise<SloSummary[]> {
    const first = await fetchSloPage(0);
    const lastPage = Math.min(Math.max(first.lastPage, 0), MAX_SLO_PAGES - 1);
    const pages: SearchServiceLevelObjective[][] = [first.slos];
    let next = 1;
    const worker = async () => {
        while (next <= lastPage) {
            const page = next++;
            pages[page] = (await fetchSloPage(page)).slos;
        }
    };
    await Promise.all(Array.from({ length: SLO_PAGE_CONCURRENCY }, worker));
    const byId = new Map<string, SloSummary>();
    pages.flat().forEach((raw) => {
        const slo = slimSlo(raw);
        if (slo) byId.set(slo.id, slo);
    });
    return [...byId.values()];
}

// The action's typed output omits `slo_query` and models `creator` loosely; read both defensively.
type RawCorrection = {
    id?: string;
    attributes?: {
        slo_id?: string | null;
        slo_query?: string | null;
        category?: string;
        description?: string | null;
        start?: number | null;
        end?: number | null;
        duration?: number | null;
        rrule?: string | null;
        timezone?: string | null;
        creator?: { name?: string; handle?: string; data?: { attributes?: { name?: string; handle?: string } } } | null;
    };
};

function slimCorrection(raw: RawCorrection): SloCorrectionSummary | null {
    const attributes = raw?.attributes;
    if (!raw?.id || !attributes) return null;
    const creator = attributes.creator;
    const creatorAttributes = creator?.data?.attributes;
    return {
        id: String(raw.id),
        sloId: attributes.slo_id ?? null,
        sloQuery: attributes.slo_query ?? null,
        category: attributes.category ?? 'Other',
        description: attributes.description?.trim() || null,
        start: attributes.start ?? null,
        end: attributes.end ?? null,
        duration: attributes.duration ?? null,
        rrule: attributes.rrule ?? null,
        timezone: attributes.timezone ?? null,
        creator: creatorAttributes?.name || creatorAttributes?.handle || creator?.name || creator?.handle || null,
    };
}

async function listAllCorrections(): Promise<SloCorrectionSummary[]> {
    const corrections: SloCorrectionSummary[] = [];
    for (let page = 0; page < MAX_CORRECTION_PAGES; page++) {
        const response = await withRateLimitRetry(
            () => listSLOCorrection({ inputs: { limit: CORRECTION_PAGE_SIZE, offset: page * CORRECTION_PAGE_SIZE } }),
            true,
        );
        const batch = toArray<RawCorrection>(response?.data);
        batch.forEach((raw) => {
            const correction = slimCorrection(raw);
            if (correction) corrections.push(correction);
        });
        if (batch.length < CORRECTION_PAGE_SIZE) break;
    }
    return corrections;
}

/**
 * Loads the org's SLOs (slim) and SLO corrections. The frontend relates them to
 * monitors in maintenance; it loads this in parallel with the monitor snapshot.
 */
export async function loadSloContext(): Promise<SloContext> {
    const [slos, corrections] = await Promise.all([listAllSlos(), listAllCorrections()]);
    return { slos, corrections, fetchedAt: new Date().toISOString() };
}

async function readOneTimeCorrection(id: string) {
    const response = await getSLOCorrection({ inputs: { slo_correction_id: id } });
    const attributes = (response?.data?.attributes ?? {}) as RawCorrection['attributes'] & object;
    if (attributes.rrule) {
        throw new Error('Recurring SLO corrections must be edited in Datadog.');
    }
    const startMs = typeof attributes.start === 'number' ? attributes.start * 1000 : NaN;
    const endMs = typeof attributes.end === 'number' ? attributes.end * 1000 : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error("Couldn't read this correction's start and end times.");
    }
    return { startMs, endMs, description: typeof attributes.description === 'string' ? attributes.description : null };
}

/**
 * Extends a one-time SLO correction to a new end. Re-reads it live first; the
 * current start is resent unchanged with the new end.
 */
export async function extendSloCorrection(
    correctionId: string,
    newEndIso: string,
): Promise<{ correctionId: string; end: string; changedBy: string }> {
    const id = assertCorrectionId(correctionId);
    const newEndMs = typeof newEndIso === 'string' ? Date.parse(newEndIso) : NaN;
    const nowMs = Date.now();
    if (!Number.isFinite(newEndMs)) throw new Error('Invalid new end time.');
    if (newEndMs <= nowMs + 60_000) throw new Error('The new end time must be at least one minute in the future.');
    if (newEndMs > nowMs + MAX_EXTENSION_MS) throw new Error('The new end time must be within one year from now.');

    const { startMs, endMs, description } = await readOneTimeCorrection(id);
    if (endMs <= nowMs) throw new Error('This correction has already ended.');
    if (newEndMs <= endMs) throw new Error('The new end time must be later than the current end time.');

    const end = new Date(newEndMs).toISOString();
    const actor = await initiatingActor();
    await updateSLOCorrection({
        inputs: {
            slo_correction_id: id,
            description: appendChangeLine(description, changeLine('Extended', actor, new Date(nowMs).toISOString(), { end })),
            timeframe: { from: new Date(startMs).toISOString(), to: end },
        },
    });
    return { correctionId: id, end, changedBy: actorLabel(actor) };
}

/**
 * Cancels a one-time SLO correction. An active correction is ended now, which
 * keeps the time already excluded (deleting it would retroactively count that
 * time against the SLO). A correction that hasn't started yet is deleted.
 */
export async function cancelSloCorrection(
    correctionId: string,
): Promise<{ correctionId: string; action: 'ended' | 'deleted'; changedBy: string }> {
    const id = assertCorrectionId(correctionId);
    const nowMs = Date.now();
    const { startMs, endMs, description } = await readOneTimeCorrection(id);
    if (endMs <= nowMs) throw new Error('This correction has already ended.');
    const actor = await initiatingActor();
    if (startMs > nowMs) {
        // Deleted outright: there is no description left to record the change in.
        await deleteSLOCorrection({ inputs: { slo_correction_id: id } });
        return { correctionId: id, action: 'deleted', changedBy: actorLabel(actor) };
    }
    const nowIso = new Date(nowMs).toISOString();
    await updateSLOCorrection({
        inputs: {
            slo_correction_id: id,
            description: appendChangeLine(description, changeLine('Cancelled', actor, nowIso)),
            timeframe: { from: new Date(startMs).toISOString(), to: nowIso },
        },
    });
    return { correctionId: id, action: 'ended', changedBy: actorLabel(actor) };
}
