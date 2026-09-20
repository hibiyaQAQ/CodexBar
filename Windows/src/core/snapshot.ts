import { ClaudeAccount, ClaudeDailyStats, ClaudeQuota } from "./claude";
import { WindowEstimate } from "./estimate";
import { HeatmapDay } from "./heatmap";
import { QuotaLimitView, RateLimitCredits } from "./quota";
import { AppSettings } from "./settings";
import { UsageStats } from "./stats";
import { DailyMetrics } from "./workflow";

export type CodexState =
    | "ok"
    | "notLoggedIn"
    | "executableNotFound"
    | "unsupportedVersion"
    | "error"
    | "loading";

export interface CodexSection {
    state: CodexState;
    message: string | null;
    executablePath: string | null;
    executableSource: string | null;
    version: string | null;
    accountLabel: string | null;
    planLabel: string | null;
    limits: QuotaLimitView[];
    credits: RateLimitCredits | null;
    resetCreditsAvailableCount: number | null;
    resetCreditExpirations: number[] | null;
    isRateLimitsStale: boolean;
    isUsageStale: boolean;
    /// 来自 app-server summary 的官方口径指标
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    longestRunningTurnSec: number | null;
    /// 本机 rollout 统计, app-server 缺字段时兜底
    localStats: UsageStats | null;
    localLongestTurnMs: number | null;
    localScanComplete: boolean;
    heatmap: Array<HeatmapDay | null>;
    heatmapMaximum: number;
    estimates: WindowEstimate[];
}

export interface HookSection {
    enabled: boolean;
    installed: boolean;
    complete: boolean;
    verified: boolean;
    supportsHooks: boolean;
    message: string | null;
    commandText: string | null;
    today: DailyMetrics | null;
    recent: DailyMetrics[];
    totals: {
        sessions: number;
        turns: number;
        tools: number;
        subagents: number;
        permissions: number;
        compactions: number;
        longestTurnMs: number | null;
    };
}

export interface ClaudeSection {
    available: boolean;
    account: ClaudeAccount | null;
    planLabel: string | null;
    quota: ClaudeQuota | null;
    stats: UsageStats | null;
    today: ClaudeDailyStats | null;
    longestTurnMs: number | null;
    heatmap: Array<HeatmapDay | null>;
    heatmapMaximum: number;
    scanComplete: boolean;
    message: string | null;
}

export interface AppSnapshot {
    generatedAt: number;
    refreshing: boolean;
    trigger: string;
    codex: CodexSection;
    hook: HookSection;
    claude: ClaudeSection;
    settings: AppSettings;
}

export function emptySnapshot(settings: AppSettings): AppSnapshot {
    return {
        generatedAt: 0,
        refreshing: true,
        trigger: "launch",
        codex: {
            state: "loading",
            message: null,
            executablePath: null,
            executableSource: null,
            version: null,
            accountLabel: null,
            planLabel: null,
            limits: [],
            credits: null,
            resetCreditsAvailableCount: null,
            resetCreditExpirations: null,
            isRateLimitsStale: false,
            isUsageStale: false,
            lifetimeTokens: null,
            peakDailyTokens: null,
            currentStreakDays: null,
            longestStreakDays: null,
            longestRunningTurnSec: null,
            localStats: null,
            localLongestTurnMs: null,
            localScanComplete: false,
            heatmap: [],
            heatmapMaximum: 0,
            estimates: []
        },
        hook: {
            enabled: settings.hookEnabled,
            installed: false,
            complete: false,
            verified: false,
            supportsHooks: false,
            message: null,
            commandText: null,
            today: null,
            recent: [],
            totals: { sessions: 0, turns: 0, tools: 0, subagents: 0, permissions: 0, compactions: 0, longestTurnMs: null }
        },
        claude: {
            available: false,
            account: null,
            planLabel: null,
            quota: null,
            stats: null,
            today: null,
            longestTurnMs: null,
            heatmap: [],
            heatmapMaximum: 0,
            scanComplete: false,
            message: null
        },
        settings
    };
}
