import { AccountReadResponse, AppServerSession, CodexAccount } from "../core/appServer";
import { CodexError } from "../core/errors";
import {
    ClaudeState,
    claudeDailyTokens,
    claudePlanLabel,
    loadClaudeState,
    readClaudeAccount,
    saveClaudeState,
    scanClaude
} from "../core/claude";
import {
    ObservationStore,
    estimateWindows,
    loadObservations,
    recordObservations,
    saveObservations
} from "../core/estimate";
import { buildHeatmap, heatmapMaximum } from "../core/heatmap";
import { HookInvocation, containsAllCodexBarHooks, containsAnyCodexBarHook, hookCommandText, installCodexBarHooks, readHooksConfig, removeCodexBarHooks, writeHooksConfig } from "../core/hooksConfig";
import { isVersionAtLeast, minimumHookCodexVersion, resolveCodexExecutable } from "../core/codexResolver";
import { log } from "../core/log";
import { PathEnvironment, currentEnvironment, dayKey } from "../core/paths";
import {
    AccountRateLimitsResponse,
    AccountUsageResponse,
    QuotaSnapshot,
    buildQuotaSnapshot,
    codexLimit
} from "../core/quota";
import { RolloutState, dailyTokensMap, loadRolloutState, longestTurnMs, saveRolloutState, scanRollouts } from "../core/rollouts";
import { AppSettings, loadSettings, saveSettings } from "../core/settings";
import { computeUsageStats } from "../core/stats";
import { AppSnapshot, CodexSection, ClaudeSection, HookSection, emptySnapshot } from "../core/snapshot";
import { DailyMetrics, emptyMetrics, refreshWorkflow } from "../core/workflow";

const connectionMaxAgeMs = 60 * 60 * 1000;

export interface ServiceOptions {
    environment?: PathEnvironment;
    hookInvocation: HookInvocation;
    clientVersion?: string;
}

interface HookTrustEntry {
    key: string;
    trustedHash: string;
}

interface HooksListResponse {
    data: Array<{
        cwd: string;
        hooks: Array<{
            eventName: string;
            command?: string | null;
            enabled: boolean;
            sourcePath: string;
            trustStatus: string;
            key?: string | null;
            currentHash?: string | null;
        }>;
        warnings: string[];
        errors: Array<{ path: string; message: string }>;
    }>;
}

interface ConfigReadResponse {
    config?: {
        features?: { hooks?: boolean; codex_hooks?: boolean };
        hooks?: { state?: Record<string, { trusted_hash?: string }> };
    };
}

/// 三条数据链路的装配点: app-server 额度, 本机会话统计与 Hook 聚合
export class CodexBarService {
    private readonly environment: PathEnvironment;
    private readonly hookInvocation: HookInvocation;
    private readonly clientVersion: string;
    private settings: AppSettings;
    private session: AppServerSession | null = null;
    private sessionOpenedAt = 0;
    private accountResponse: AccountReadResponse | null = null;
    private cachedRateLimits: AccountRateLimitsResponse | null = null;
    private cachedUsage: AccountUsageResponse | null = null;
    private cachedAccountKey: string | null = null;
    private rollouts: RolloutState;
    private claude: ClaudeState;
    private observations: ObservationStore;
    private snapshot: AppSnapshot;
    private refreshing = false;
    private hookVerified = false;
    private hookMessage: string | null = null;

    constructor(options: ServiceOptions) {
        this.environment = options.environment ?? currentEnvironment();
        this.hookInvocation = options.hookInvocation;
        this.clientVersion = options.clientVersion ?? "1.0.0";
        this.settings = loadSettings(this.environment);
        this.rollouts = loadRolloutState(this.environment);
        this.claude = loadClaudeState(this.environment);
        this.observations = loadObservations(this.environment);
        this.snapshot = emptySnapshot(this.settings);
    }

    currentSnapshot(): AppSnapshot {
        return this.snapshot;
    }

    currentSettings(): AppSettings {
        return this.settings;
    }

    updateSettings(partial: Partial<AppSettings>): AppSettings {
        this.settings = { ...this.settings, ...partial };
        saveSettings(this.settings, this.environment);
        log("settings", "notice", "设置已变更", {
            keys: Object.keys(partial).join(",")
        });
        this.snapshot = { ...this.snapshot, settings: this.settings };
        return this.settings;
    }

    dispose(): void {
        this.closeSession("dispose");
    }

    private closeSession(reason: string): void {
        if (this.session) {
            log("codex", "notice", "app-server 连接已关闭", { reason });
            this.session.close();
        }
        this.session = null;
        this.sessionOpenedAt = 0;
    }

    /// 连接最长复用 1 小时, 让后台升级的 codex 有机会生效
    private async readySession(): Promise<AppServerSession> {
        const now = Date.now();
        if (this.session && !this.session.isClosed && now - this.sessionOpenedAt < connectionMaxAgeMs) {
            return this.session;
        }
        this.closeSession(this.session ? "expired" : "absent");
        const executable = resolveCodexExecutable({
            manualPath: this.settings.codexExecutablePath,
            environment: this.environment
        });
        if (!executable) {
            throw new CodexError("executableNotFound", "未找到 codex 可执行文件");
        }
        const session = AppServerSession.launch(executable.executablePath, {
            environment: this.environment.env,
            clientVersion: this.clientVersion
        });
        try {
            const handshake = await session.initializeAccount(this.clientVersion);
            this.accountResponse = handshake.account;
            this.session = session;
            this.sessionOpenedAt = now;
            log("codex", "notice", "app-server 连接完成", {
                source: executable.source,
                version: handshake.version
            });
            return session;
        } catch (error) {
            session.close();
            throw error;
        }
    }

    private accountKey(account: CodexAccount): string {
        return `${account.type}:${account.email ?? ""}`;
    }

    private async readSupplemental(): Promise<{
        rateLimits: AccountRateLimitsResponse | null;
        usage: AccountUsageResponse | null;
        rateLimitsStale: boolean;
        usageStale: boolean;
    }> {
        const session = await this.readySession();
        const account = this.accountResponse?.account;
        if (account) {
            const key = this.accountKey(account);
            if (this.cachedAccountKey && this.cachedAccountKey !== key) {
                // 账号变化时整体丢弃缓存避免串号
                this.cachedRateLimits = null;
                this.cachedUsage = null;
                log("codex", "notice", "额度缓存已丢弃", { reason: "accountChanged" });
            }
            this.cachedAccountKey = key;
        }
        let rateLimits = this.cachedRateLimits;
        let usage = this.cachedUsage;
        let rateLimitsStale = false;
        let usageStale = false;
        try {
            rateLimits = await session.request<AccountRateLimitsResponse>("account/rateLimits/read");
            this.cachedRateLimits = rateLimits;
        } catch (error) {
            rateLimitsStale = this.cachedRateLimits !== null;
            log("codex", "error", "额度读取失败", { stage: "rateLimits", detail: describe(error) });
            if (!this.cachedRateLimits) {
                rateLimits = null;
            }
        }
        try {
            usage = await session.request<AccountUsageResponse>("account/usage/read");
            this.cachedUsage = usage;
        } catch (error) {
            usageStale = this.cachedUsage !== null;
            log("codex", "error", "用量读取失败", { stage: "usage", detail: describe(error) });
            if (!this.cachedUsage) {
                usage = null;
            }
        }
        return { rateLimits, usage, rateLimitsStale, usageStale };
    }

    /// 刷新一轮全部数据, 任何一条链路失败都不阻断其他链路
    async refresh(trigger: string): Promise<AppSnapshot> {
        if (this.refreshing) {
            return this.snapshot;
        }
        this.refreshing = true;
        const startedAt = Date.now();
        const now = new Date();
        try {
            const codex = await this.buildCodexSection(trigger, now);
            const workflow = this.refreshWorkflowMetrics();
            const hook = await this.buildHookSection(workflow, now);
            const claude = this.buildClaudeSection(now);
            const heatmapDays = buildHeatmap({
                usage: codex.usage,
                workflowMetrics: workflow,
                showsWorkflow: hook.enabled && hook.complete,
                columnCount: this.settings.heatmapWeeks,
                today: now,
                localTokensByDate: this.settings.scanLocalSessions ? dailyTokensMap(this.rollouts) : null
            });
            const section: CodexSection = {
                ...codex.section,
                heatmap: heatmapDays,
                heatmapMaximum: heatmapMaximum(heatmapDays)
            };
            this.snapshot = {
                generatedAt: Date.now(),
                refreshing: false,
                trigger,
                codex: section,
                hook,
                claude,
                settings: this.settings
            };
            log("app", "notice", "刷新完成", {
                trigger,
                state: section.state,
                limits: section.limits.length,
                hook: hook.enabled ? (hook.complete ? "complete" : "incomplete") : "off",
                elapsed: `${Date.now() - startedAt}ms`
            });
            return this.snapshot;
        } finally {
            this.refreshing = false;
        }
    }

    private async buildCodexSection(
        trigger: string,
        now: Date
    ): Promise<{ section: CodexSection; usage: QuotaSnapshot["usage"] }> {
        const base = emptySnapshot(this.settings).codex;
        if (this.settings.scanLocalSessions) {
            try {
                this.rollouts = scanRollouts(this.rollouts, { environment: this.environment, now });
                saveRolloutState(this.rollouts, this.environment);
            } catch (error) {
                log("codex", "error", "本机会话扫描失败", { detail: describe(error) });
            }
        }
        const localTokens = this.settings.scanLocalSessions ? dailyTokensMap(this.rollouts) : {};
        const localStats = computeUsageStats(localTokens, now);
        const executable = resolveCodexExecutable({
            manualPath: this.settings.codexExecutablePath,
            environment: this.environment
        });
        base.executablePath = executable?.executablePath ?? null;
        base.executableSource = executable?.source ?? null;
        base.localStats = localStats;
        base.localLongestTurnMs = longestTurnMs(this.rollouts);
        base.localScanComplete = this.rollouts.scanComplete;

        let snapshot: QuotaSnapshot | null = null;
        try {
            const supplemental = await this.readSupplemental();
            const account = this.accountResponse?.account;
            if (!account) {
                throw new CodexError("notLoggedIn", "Codex 尚未登录");
            }
            snapshot = buildQuotaSnapshot({
                account,
                rateLimits: supplemental.rateLimits,
                usage: supplemental.usage,
                isRateLimitsStale: supplemental.rateLimitsStale,
                isUsageStale: supplemental.usageStale,
                generatedAt: now.getTime()
            });
        } catch (error) {
            this.closeSession("failure");
            const section = { ...base, ...describeFailure(error) };
            log("codex", "error", "额度刷新失败", { trigger, detail: describe(error) });
            return { section, usage: null };
        }

        const limit = codexLimit(snapshot);
        if (limit && this.settings.scanLocalSessions) {
            try {
                this.observations = recordObservations(this.observations, {
                    limit,
                    rollouts: this.rollouts,
                    now
                });
                saveObservations(this.observations, this.environment);
            } catch (error) {
                log("estimate", "error", "额度观测写入失败", { detail: describe(error) });
            }
        }
        const section: CodexSection = {
            ...base,
            state: "ok",
            message: null,
            version: this.session?.serverVersion ?? null,
            accountLabel: snapshot.accountLabel,
            planLabel: snapshot.planLabel,
            limits: snapshot.limits,
            credits: snapshot.credits,
            resetCreditsAvailableCount: snapshot.resetCreditsAvailableCount,
            resetCreditExpirations: snapshot.resetCreditExpirations,
            isRateLimitsStale: snapshot.isRateLimitsStale,
            isUsageStale: snapshot.isUsageStale,
            lifetimeTokens: snapshot.usage?.summary.lifetimeTokens ?? null,
            peakDailyTokens: snapshot.usage?.summary.peakDailyTokens ?? null,
            currentStreakDays: snapshot.usage?.summary.currentStreakDays ?? null,
            longestStreakDays: snapshot.usage?.summary.longestStreakDays ?? null,
            longestRunningTurnSec: snapshot.usage?.summary.longestRunningTurnSec ?? null,
            estimates: estimateWindows(this.observations, limit)
        };
        return { section, usage: snapshot.usage };
    }

    private refreshWorkflowMetrics(): DailyMetrics[] {
        try {
            const result = refreshWorkflow({ environment: this.environment });
            if (result.rebuiltDates.length > 0) {
                log("workflow", "notice", "事件汇总完成", {
                    rebuilt: result.rebuiltDates.length,
                    updated: result.updatedDates.length
                });
            }
            return result.metrics;
        } catch (error) {
            log("workflow", "error", "事件汇总失败", { detail: describe(error) });
            return [];
        }
    }

    private async buildHookSection(metrics: DailyMetrics[], now: Date): Promise<HookSection> {
        const commandText = hookCommandText(this.hookInvocation);
        let installed = false;
        let complete = false;
        let configReadable = true;
        let message = this.hookMessage;
        try {
            const config = readHooksConfig(this.environment);
            installed = containsAnyCodexBarHook(config, this.hookInvocation);
            complete = containsAllCodexBarHooks(config, this.hookInvocation);
            // 已开启但配置缺项时自愈, 常见于安装路径或 node 位置发生变化
            if (this.settings.hookEnabled && !complete) {
                const { config: next, repaired } = installCodexBarHooks(config, this.hookInvocation);
                writeHooksConfig(next, this.environment);
                installed = true;
                complete = true;
                log("hooks", "notice", "Hook 配置已补齐", { events: repaired.length });
            }
        } catch (error) {
            // 读取失败不提供 Hook 装没装的信息, 保留上次结论
            configReadable = false;
            message = "hooks.json 无法读取, 保留上次状态";
            log("hooks", "error", "Hook 配置读取失败", { detail: describe(error) });
        }
        const supportsHooks = isVersionAtLeast(this.session?.serverVersion ?? null, minimumHookCodexVersion) === true;
        if (this.settings.hookEnabled && complete && supportsHooks && configReadable) {
            const verification = await this.verifyHooks();
            this.hookVerified = verification.verified;
            this.hookMessage = verification.message;
            message = verification.message ?? message;
        } else if (!this.settings.hookEnabled) {
            this.hookVerified = false;
        }
        const todayKey = dayKey(now);
        const today = metrics.find(entry => entry.startDate === todayKey) ?? emptyMetrics(todayKey);
        const recent = metrics.slice(-30);
        const totals = metrics.reduce(
            (sum, entry) => ({
                sessions: sum.sessions + entry.sessionCount,
                turns: sum.turns + entry.turnCount,
                tools: sum.tools + entry.toolCallCount,
                subagents: sum.subagents + entry.subagentCount,
                permissions: sum.permissions + entry.permissionRequestCount,
                compactions: sum.compactions + entry.contextCompactionCount,
                longestTurnMs: Math.max(sum.longestTurnMs ?? 0, entry.longestTurnMs ?? 0) || null
            }),
            { sessions: 0, turns: 0, tools: 0, subagents: 0, permissions: 0, compactions: 0, longestTurnMs: null as number | null }
        );
        return {
            enabled: this.settings.hookEnabled,
            installed,
            complete,
            verified: this.hookVerified,
            supportsHooks,
            message,
            commandText,
            today,
            recent,
            totals
        };
    }

    private buildClaudeSection(now: Date): ClaudeSection {
        const base = emptySnapshot(this.settings).claude;
        if (!this.settings.showsClaude) {
            return base;
        }
        if (this.settings.scanLocalSessions) {
            try {
                this.claude = scanClaude(this.claude, { environment: this.environment, now });
                saveClaudeState(this.claude, this.environment);
            } catch (error) {
                log("claude", "error", "Claude 会话扫描失败", { detail: describe(error) });
            }
        }
        const account = readClaudeAccount(this.environment);
        const tokens = claudeDailyTokens(this.claude);
        const stats = computeUsageStats(tokens, now);
        const todayKey = dayKey(now);
        const heatmap = buildHeatmap({
            usage: null,
            workflowMetrics: [],
            showsWorkflow: false,
            columnCount: this.settings.heatmapWeeks,
            today: now,
            localTokensByDate: tokens
        });
        const longest = Object.values(this.claude.longestTurnMsByDate);
        return {
            ...base,
            available: account !== null || Object.keys(tokens).length > 0 || this.claude.quota !== null,
            account,
            planLabel: claudePlanLabel(account?.plan ?? null),
            quota: this.claude.quota,
            stats,
            today: this.claude.stats[todayKey] ?? null,
            longestTurnMs: longest.length > 0 ? Math.max(...longest) : null,
            heatmap,
            heatmapMaximum: heatmapMaximum(heatmap),
            scanComplete: this.claude.scanComplete,
            message: Object.keys(tokens).length === 0 ? "未找到 Claude Code 会话日志" : null
        };
    }

    /// 全局禁用要排在 hooks/list 之前判, 否则会把用户引去翻本来就完好的配置
    private async verifyHooks(): Promise<{ verified: boolean; message: string | null }> {
        try {
            const session = await this.readySession();
            const config = await session.request<ConfigReadResponse>("config/read", { includeLayers: false });
            const features = config?.config?.features;
            if (features && (features.hooks === false || features.codex_hooks === false)) {
                return { verified: false, message: "Codex 已全局禁用 Hook" };
            }
            const list = await session.request<HooksListResponse>("hooks/list", {
                cwds: [this.environment.home]
            });
            const entries = list?.data?.flatMap(entry => entry.hooks) ?? [];
            const ours = entries.filter(hook => hook.command && hook.command.includes("--hook-event"));
            if (ours.length === 0) {
                return { verified: false, message: "Codex 未加载 CodexBar Hook" };
            }
            const untrusted = ours.filter(hook => ["untrusted", "modified"].includes(hook.trustStatus.toLowerCase()));
            if (untrusted.length > 0) {
                const trusted = await this.trustHooks(session, untrusted
                    .filter(hook => hook.key && hook.currentHash)
                    .map(hook => ({ key: hook.key as string, trustedHash: hook.currentHash as string })));
                if (!trusted) {
                    return { verified: false, message: "Hook 需要在 Codex 中确认信任" };
                }
            }
            const disabled = ours.filter(hook => !hook.enabled);
            if (disabled.length > 0) {
                return { verified: false, message: "部分 Hook 已被 Codex 停用" };
            }
            return { verified: true, message: null };
        } catch (error) {
            if (CodexError.isKind(error, "unsupportedMethod")) {
                return { verified: false, message: "当前 Codex 不支持 hooks/list 校验" };
            }
            log("hooks", "error", "Hook 校验失败", { detail: describe(error) });
            return { verified: this.hookVerified, message: this.hookMessage };
        }
    }

    private async trustHooks(session: AppServerSession, entries: HookTrustEntry[]): Promise<boolean> {
        if (entries.length === 0) {
            return false;
        }
        const value: Record<string, Record<string, string>> = {};
        for (const entry of entries) {
            value[entry.key] = { trusted_hash: entry.trustedHash };
        }
        try {
            await session.request("config/batchWrite", {
                edits: [{ keyPath: "hooks.state", value, mergeStrategy: "upsert" }],
                reloadUserConfig: true
            });
            log("hooks", "notice", "Hook 信任状态已写入", { count: entries.length });
            return true;
        } catch (error) {
            log("hooks", "error", "Hook 信任写入失败", { detail: describe(error) });
            return false;
        }
    }

    /// Hook 开关: 开启时写入配置并校验, 关闭时只移除自己的 handler
    async setHookEnabled(enabled: boolean): Promise<{ ok: boolean; message: string | null }> {
        try {
            if (enabled) {
                const session = await this.readySession();
                if (isVersionAtLeast(session.serverVersion, minimumHookCodexVersion) !== true) {
                    const message = `启用 Hook 需要 Codex ${minimumHookCodexVersion} 或更高版本`;
                    this.hookMessage = message;
                    return { ok: false, message };
                }
                const config = readHooksConfig(this.environment);
                const { config: next, repaired } = installCodexBarHooks(config, this.hookInvocation);
                writeHooksConfig(next, this.environment);
                log("hooks", "notice", "Hook 配置已写入", { events: repaired.length });
                this.updateSettings({ hookEnabled: true });
                const verification = await this.verifyHooks();
                this.hookVerified = verification.verified;
                this.hookMessage = verification.message;
                return { ok: true, message: verification.message };
            }
            const config = readHooksConfig(this.environment);
            writeHooksConfig(removeCodexBarHooks(config, this.hookInvocation), this.environment);
            this.updateSettings({ hookEnabled: false });
            this.hookVerified = false;
            this.hookMessage = null;
            log("hooks", "notice", "Hook 配置已移除", {});
            return { ok: true, message: null };
        } catch (error) {
            const message = `Hook 配置失败: ${describe(error)}`;
            this.hookMessage = message;
            log("hooks", "error", "Hook 开关处理失败", { enabled, detail: describe(error) });
            return { ok: false, message };
        }
    }
}

function describe(error: unknown): string {
    if (error instanceof CodexError) {
        return error.detail ? `${error.message} (${error.detail})` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

function describeFailure(error: unknown): Partial<CodexSection> {
    if (CodexError.isKind(error, "executableNotFound")) {
        return { state: "executableNotFound", message: "未找到 codex 可执行文件, 请安装 Codex CLI 或在设置中指定路径" };
    }
    if (CodexError.isKind(error, "notLoggedIn")) {
        return { state: "notLoggedIn", message: "Codex 尚未登录, 请先运行 codex login" };
    }
    if (CodexError.isKind(error, "unsupportedVersion")) {
        return { state: "unsupportedVersion", message: describe(error) };
    }
    return { state: "error", message: describe(error) };
}
