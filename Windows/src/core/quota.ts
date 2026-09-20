import { CodexAccount } from "./appServer";
import { dayKey } from "./paths";

export type QuotaWindowKind = "primary" | "secondary";

export interface RateLimitWindow {
    usedPercent?: number | null;
    resetsAt?: number | null;
    windowDurationMins?: number | null;
}

export interface RateLimitSnapshot {
    limitId?: string | null;
    limitName?: string | null;
    planType?: string | null;
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    credits?: RateLimitCredits | null;
}

export interface RateLimitCredits {
    balance?: string | null;
    hasCredits: boolean;
    unlimited: boolean;
}

export interface RateLimitResetCredit {
    id: string;
    status: string;
    resetType: string;
    expiresAt?: number | null;
}

export interface RateLimitResetCreditsSummary {
    availableCount: number;
    credits?: RateLimitResetCredit[] | null;
}

export interface AccountRateLimitsResponse {
    rateLimits: RateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
    rateLimitResetCredits?: RateLimitResetCreditsSummary | null;
}

export interface UsageSummary {
    currentStreakDays?: number | null;
    lifetimeTokens?: number | null;
    longestRunningTurnSec?: number | null;
    longestStreakDays?: number | null;
    peakDailyTokens?: number | null;
}

export interface DailyUsageBucket {
    startDate: string;
    tokens: number;
}

export interface AccountUsageResponse {
    summary: UsageSummary;
    dailyUsageBuckets?: DailyUsageBucket[] | null;
}

export interface QuotaWindowView {
    kind: QuotaWindowKind;
    label: string;
    windowDurationMins: number | null;
    usedPercent: number | null;
    remainingPercent: number;
    resetsAt: number | null;
    hasData: boolean;
}

export interface QuotaLimitView {
    limitId: string;
    title: string;
    windows: QuotaWindowView[];
}

export interface UsageView {
    summary: UsageSummary;
    tokensByDate: Record<string, number> | null;
    hasDailyBuckets: boolean;
}

export interface QuotaSnapshot {
    account: CodexAccount;
    accountLabel: string;
    planLabel: string | null;
    credits: RateLimitCredits | null;
    resetCreditsAvailableCount: number | null;
    resetCreditExpirations: number[] | null;
    generatedAt: number;
    limits: QuotaLimitView[];
    usage: UsageView | null;
    isRateLimitsStale: boolean;
    isUsageStale: boolean;
}

function capitalized(value: string): string {
    return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/// 窗口时长转成 5h 或 7d 这类短标签, 缺时长时回退为窗口
export function windowLabel(minutes: number | null | undefined): string {
    if (!minutes || minutes <= 0) {
        return "窗口";
    }
    if (minutes % 1440 === 0) {
        return `${minutes / 1440}d`;
    }
    if (minutes % 60 === 0) {
        return `${minutes / 60}h`;
    }
    return `${minutes}m`;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function windowView(kind: QuotaWindowKind, window: RateLimitWindow | null | undefined): QuotaWindowView | null {
    if (!window) {
        return null;
    }
    const usedPercent = numberOrNull(window.usedPercent);
    const windowDurationMins = numberOrNull(window.windowDurationMins);
    return {
        kind,
        label: windowLabel(windowDurationMins),
        windowDurationMins,
        usedPercent,
        remainingPercent: usedPercent === null ? 0 : Math.max(0, Math.min(100, 100 - usedPercent)),
        resetsAt: numberOrNull(window.resetsAt),
        hasData: usedPercent !== null
    };
}

function limitView(limitId: string, snapshot: RateLimitSnapshot): QuotaLimitView | null {
    const windows = [windowView("primary", snapshot.primary), windowView("secondary", snapshot.secondary)]
        .filter((value): value is QuotaWindowView => value !== null);
    if (windows.length === 0) {
        return null;
    }
    const name = snapshot.limitName?.trim();
    return {
        limitId,
        title: capitalized(name && name.length > 0 ? name : limitId),
        windows
    };
}

/// 展示顺序: 顶层 rateLimits 指向的主 limit 置顶, 其余按名称排序
function orderedSnapshots(response: AccountRateLimitsResponse): Array<[string, RateLimitSnapshot]> {
    const primaryLimitId = response.rateLimits?.limitId ?? "codex";
    const byLimitId = response.rateLimitsByLimitId;
    if (!byLimitId || Object.keys(byLimitId).length === 0) {
        return [[primaryLimitId, response.rateLimits]];
    }
    return Object.entries(byLimitId).sort((lhs, rhs) => {
        const lhsPrimary = lhs[0] === primaryLimitId;
        const rhsPrimary = rhs[0] === primaryLimitId;
        if (lhsPrimary !== rhsPrimary) {
            return lhsPrimary ? -1 : 1;
        }
        const lhsName = lhs[1].limitName ?? lhs[0];
        const rhsName = rhs[1].limitName ?? rhs[0];
        const order = lhsName.localeCompare(rhsName, "en");
        return order !== 0 ? order : lhs[0].localeCompare(rhs[0], "en");
    });
}

export function accountDisplayName(account: CodexAccount): string {
    const email = account.email?.trim();
    if (email) {
        return email;
    }
    switch (account.type) {
        case "apiKey":
            return "API Key";
        case "chatgpt":
            return "ChatGPT";
        case "amazonBedrock":
            return "Amazon Bedrock";
        default:
            return account.type;
    }
}

export function usageView(response: AccountUsageResponse | null): UsageView | null {
    if (!response) {
        return null;
    }
    const buckets = response.dailyUsageBuckets;
    let tokensByDate: Record<string, number> | null = null;
    if (Array.isArray(buckets)) {
        tokensByDate = {};
        for (const bucket of buckets) {
            if (!bucket || typeof bucket.startDate !== "string") {
                continue;
            }
            const tokens = numberOrNull(bucket.tokens) ?? 0;
            tokensByDate[bucket.startDate] = (tokensByDate[bucket.startDate] ?? 0) + tokens;
        }
    }
    return {
        summary: response.summary ?? {},
        tokensByDate,
        hasDailyBuckets: tokensByDate !== null
    };
}

export function availableResetExpirations(
    summary: RateLimitResetCreditsSummary | null | undefined,
    nowSeconds: number
): number[] | null {
    if (!summary || summary.availableCount <= 0 || !Array.isArray(summary.credits)) {
        return null;
    }
    const dates = summary.credits
        .filter(credit => credit?.status === "available" && numberOrNull(credit.expiresAt) !== null)
        .map(credit => credit.expiresAt as number)
        .filter(value => value > nowSeconds)
        .sort((lhs, rhs) => lhs - rhs);
    return dates.length > 0 ? dates : null;
}

export interface BuildSnapshotInput {
    account: CodexAccount;
    rateLimits: AccountRateLimitsResponse | null;
    usage: AccountUsageResponse | null;
    isRateLimitsStale?: boolean;
    isUsageStale?: boolean;
    generatedAt?: number;
}

/// rateLimits 与 usage 都可能缺失, 账户有效就生成快照让 UI 显示暂无数据
export function buildQuotaSnapshot(input: BuildSnapshotInput): QuotaSnapshot {
    const generatedAt = input.generatedAt ?? Date.now();
    const limits = input.rateLimits
        ? orderedSnapshots(input.rateLimits)
            .map(([limitId, snapshot]) => limitView(limitId, snapshot))
            .filter((value): value is QuotaLimitView => value !== null)
        : [];
    const primaryLimitId = input.rateLimits?.rateLimits?.limitId ?? "codex";
    const credits = input.rateLimits
        ? (input.rateLimits.rateLimitsByLimitId?.[primaryLimitId]?.credits ?? input.rateLimits.rateLimits?.credits ?? null)
        : null;
    return {
        account: input.account,
        accountLabel: accountDisplayName(input.account),
        planLabel: input.account.planType ?? input.rateLimits?.rateLimits?.planType ?? null,
        credits,
        resetCreditsAvailableCount: input.rateLimits?.rateLimitResetCredits?.availableCount ?? null,
        resetCreditExpirations: availableResetExpirations(
            input.rateLimits?.rateLimitResetCredits,
            Math.trunc(generatedAt / 1000)
        ),
        generatedAt,
        limits,
        usage: usageView(input.usage),
        isRateLimitsStale: input.isRateLimitsStale ?? false,
        isUsageStale: input.isUsageStale ?? false
    };
}

export function tokenCountOn(usage: UsageView | null, date: Date): number | null {
    if (!usage?.tokensByDate) {
        return null;
    }
    const key = dayKey(date);
    return usage.tokensByDate[key] ?? null;
}

/// 找出 codex 主 limit, 菜单与估算都以它为准
export function codexLimit(snapshot: QuotaSnapshot | null): QuotaLimitView | null {
    if (!snapshot) {
        return null;
    }
    return snapshot.limits.find(limit => limit.limitId.toLowerCase() === "codex") ?? snapshot.limits[0] ?? null;
}
