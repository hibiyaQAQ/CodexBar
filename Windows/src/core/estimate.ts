import { readJSONIfPresent, writeAtomic } from "./files";
import { PathEnvironment, currentEnvironment, storagePaths } from "./paths";
import { QuotaLimitView, QuotaWindowView } from "./quota";
import { RolloutState, tokensInRange } from "./rollouts";

export interface ObservationPoint {
    at: number;
    usedPercent: number;
    tokens: number;
}

export interface ObservedWindow {
    key: string;
    kind: string;
    resetsAt: number;
    windowMinutes: number | null;
    points: ObservationPoint[];
}

export interface ObservationStore {
    schema: number;
    windows: Record<string, ObservedWindow>;
}

const maxWindows = 40;
const maxPointsPerWindow = 240;
/// 百分比变化太小时噪声占比过高, 估算结果不发布
const minimumPercentDelta = 1;

export function loadObservations(environment: PathEnvironment = currentEnvironment()): ObservationStore {
    const loaded = readJSONIfPresent<ObservationStore>(storagePaths(environment).observationsPath);
    if (!loaded || loaded.schema !== 1 || typeof loaded.windows !== "object") {
        return { schema: 1, windows: {} };
    }
    return loaded;
}

export function saveObservations(store: ObservationStore, environment: PathEnvironment = currentEnvironment()): void {
    writeAtomic(storagePaths(environment).observationsPath, JSON.stringify(store));
}

export function windowKey(limitId: string, window: QuotaWindowView): string | null {
    if (window.resetsAt === null) {
        return null;
    }
    return `${limitId}:${window.kind}:${window.resetsAt}`;
}

export function windowStartMs(window: QuotaWindowView): number | null {
    if (window.resetsAt === null || !window.windowDurationMins) {
        return null;
    }
    return (window.resetsAt - window.windowDurationMins * 60) * 1000;
}

export interface RecordOptions {
    limit: QuotaLimitView;
    rollouts: RolloutState;
    now?: Date;
}

/// 每次刷新把当前窗口的百分比与窗口内 token 合计记成一个观测点
export function recordObservations(store: ObservationStore, options: RecordOptions): ObservationStore {
    const now = (options.now ?? new Date()).getTime();
    for (const window of options.limit.windows) {
        const key = windowKey(options.limit.limitId, window);
        const start = windowStartMs(window);
        if (!key || start === null || window.usedPercent === null) {
            continue;
        }
        const tokens = tokensInRange(options.rollouts, start, now);
        const existing = store.windows[key] ?? {
            key,
            kind: window.kind,
            resetsAt: window.resetsAt as number,
            windowMinutes: window.windowDurationMins,
            points: []
        };
        const last = existing.points[existing.points.length - 1];
        // 同一百分比不重复记点, 但 token 变化仍然更新最后一个点
        if (last && last.usedPercent === window.usedPercent) {
            last.tokens = Math.max(last.tokens, tokens);
            last.at = now;
        } else {
            existing.points.push({ at: now, usedPercent: window.usedPercent, tokens });
        }
        if (existing.points.length > maxPointsPerWindow) {
            existing.points = existing.points.slice(-maxPointsPerWindow);
        }
        store.windows[key] = existing;
    }
    const keys = Object.keys(store.windows).sort((lhs, rhs) => {
        return (store.windows[rhs]?.resetsAt ?? 0) - (store.windows[lhs]?.resetsAt ?? 0);
    });
    for (const key of keys.slice(maxWindows)) {
        delete store.windows[key];
    }
    return store;
}

export type EstimateConfidence = "none" | "low" | "medium" | "high";

export interface WindowEstimate {
    kind: string;
    label: string;
    usedPercent: number | null;
    remainingPercent: number;
    resetsAt: number | null;
    /// 估算的窗口总额度, 单位是计费 token
    totalTokens: number | null;
    remainingTokens: number | null;
    usedTokens: number | null;
    confidence: EstimateConfidence;
    sampleCount: number;
    /// 历史窗口的中位数估算, 当前窗口样本不足时作为参考
    referenceTotalTokens: number | null;
}

function estimateFromWindow(observed: ObservedWindow | undefined): { total: number | null; confidence: EstimateConfidence; samples: number } {
    if (!observed || observed.points.length === 0) {
        return { total: null, confidence: "none", samples: 0 };
    }
    const points = observed.points;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const percentDelta = last.usedPercent - first.usedPercent;
    const tokenDelta = last.tokens - first.tokens;
    if (percentDelta >= minimumPercentDelta && tokenDelta > 0) {
        const total = (tokenDelta / percentDelta) * 100;
        const confidence: EstimateConfidence = percentDelta >= 20 ? "high" : percentDelta >= 5 ? "medium" : "low";
        return { total, confidence, samples: points.length };
    }
    // 没有跨观测差值时退回单点外推, 只有用量足够大才可信
    if (last.usedPercent >= 5 && last.tokens > 0) {
        return {
            total: (last.tokens / last.usedPercent) * 100,
            confidence: last.usedPercent >= 25 ? "medium" : "low",
            samples: points.length
        };
    }
    return { total: null, confidence: "none", samples: points.length };
}

function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? null;
    }
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/// 同类窗口的历史估算中位数, 用来在当前窗口样本不足时给出参考值
export function referenceTotal(store: ObservationStore, limitId: string, window: QuotaWindowView): number | null {
    const currentKey = windowKey(limitId, window);
    const totals: number[] = [];
    for (const observed of Object.values(store.windows)) {
        if (observed.key === currentKey || observed.kind !== window.kind) {
            continue;
        }
        if (window.windowDurationMins && observed.windowMinutes && observed.windowMinutes !== window.windowDurationMins) {
            continue;
        }
        const estimate = estimateFromWindow(observed);
        if (estimate.total !== null && estimate.confidence !== "low" && estimate.confidence !== "none") {
            totals.push(estimate.total);
        }
    }
    return median(totals);
}

export function estimateWindows(store: ObservationStore, limit: QuotaLimitView | null): WindowEstimate[] {
    if (!limit) {
        return [];
    }
    return limit.windows.map(window => {
        const key = windowKey(limit.limitId, window);
        const estimate = key ? estimateFromWindow(store.windows[key]) : { total: null, confidence: "none" as const, samples: 0 };
        const reference = referenceTotal(store, limit.limitId, window);
        const total = estimate.total ?? reference;
        const usedPercent = window.usedPercent;
        const usedTokens = total !== null && usedPercent !== null ? Math.round((total * usedPercent) / 100) : null;
        const remainingTokens = total !== null ? Math.round((total * window.remainingPercent) / 100) : null;
        return {
            kind: window.kind,
            label: window.label,
            usedPercent,
            remainingPercent: window.remainingPercent,
            resetsAt: window.resetsAt,
            totalTokens: total === null ? null : Math.round(total),
            remainingTokens,
            usedTokens,
            confidence: estimate.total !== null ? estimate.confidence : (reference !== null ? "low" : "none"),
            sampleCount: estimate.samples,
            referenceTotalTokens: reference === null ? null : Math.round(reference)
        };
    });
}
