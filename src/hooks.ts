import { useCallback, useEffect, useRef, useState } from 'react';

/** Layout density based on the app's own width (it usually lives in a dashboard widget). */
export type Density = 'xl' | 'wide' | 'medium' | 'narrow';

function densityFor(width: number): Density {
    if (width >= 1560) return 'xl';
    if (width >= 1180) return 'wide';
    if (width >= 860) return 'medium';
    return 'narrow';
}

/** Tracks the width of an element and maps it to a layout density. */
export function useDensity<T extends HTMLElement>() {
    const ref = useRef<T | null>(null);
    const [density, setDensity] = useState<Density>(() => densityFor(window.innerWidth));

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width) setDensity(densityFor(width));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    return { ref, density };
}

export interface UrlFilters {
    state: string;
    window: string;
    owners: string[];
    from: number | null;
    to: number | null;
    monitor: number | null;
    /** Only monitors with related SLOs. */
    withSlos: boolean;
    view: 'monitors' | 'corrections';
}

function readUrlFilters(): UrlFilters {
    const params = new URLSearchParams(window.location.search);
    const num = (key: string) => {
        const value = Number(params.get(key));
        return Number.isFinite(value) && value > 0 ? value : null;
    };
    return {
        state: params.get('state') ?? 'all',
        window: params.get('window') ?? 'all',
        owners: params.getAll('owner'),
        from: num('from'),
        to: num('to'),
        monitor: num('monitor'),
        withSlos: params.get('slos') === '1',
        view: params.get('view') === 'corrections' ? 'corrections' : 'monitors',
    };
}

function writeUrlFilters(filters: UrlFilters): void {
    const params = new URLSearchParams();
    if (filters.state !== 'all') params.set('state', filters.state);
    if (filters.window !== 'all') params.set('window', filters.window);
    filters.owners.forEach((owner) => params.append('owner', owner));
    if (filters.from !== null && filters.to !== null) {
        params.set('from', String(Math.round(filters.from)));
        params.set('to', String(Math.round(filters.to)));
    }
    if (filters.monitor !== null) params.set('monitor', String(filters.monitor));
    if (filters.withSlos) params.set('slos', '1');
    if (filters.view === 'corrections') params.set('view', 'corrections');
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    try {
        window.history.replaceState(window.history.state, '', url);
    } catch {
        // History can be unavailable in some embedding contexts; filters still work in memory.
    }
}

/**
 * Filter state mirrored into the query string. The Datadog app provider syncs
 * the query string onto the host page URL, so filtered views are shareable.
 */
export function useUrlFilters() {
    const [filters, setFilters] = useState<UrlFilters>(readUrlFilters);

    const update = useCallback((patch: Partial<UrlFilters>) => {
        setFilters((previous) => {
            const next = { ...previous, ...patch };
            writeUrlFilters(next);
            return next;
        });
    }, []);

    return [filters, update] as const;
}
