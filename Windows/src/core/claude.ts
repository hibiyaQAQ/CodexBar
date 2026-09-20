import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONLine, readJSONIfPresent, readLinesFrom, writeAtomic } from "./files";
import { PathEnvironment, claudeHome, currentEnvironment, dataRoot, dayKey, parseAnyTimestamp } from "./paths";
import { TokenTotals, emptyTotals } from "./rollouts";

const stateFileName = "claude-state.json";
const defaultBudgetMs = 8_000;

export interface ClaudeAccount {
    email: string | null;
    organization: string | null;
    plan: string | null;
    source: string | null;
}

export interface ClaudeQuotaWindow {
    label: string;
    usedPercent: number;
    remainingPercent: number;
    resetsAt: number | null;
}

export interface ClaudeQuota {
    observedAt: number;
    windows: ClaudeQuotaWindow[];
    source: string;
}

export interface ClaudeDailyStats {
    sessions: number;
    turns: number;
    tools: number;
    subagents: number;
    compactions: number;
}

interface ClaudeFileState {
    size: number;
    mtimeMs: number;
    offset: number;
    session: string | null;
    model: string | null;
}

export interface ClaudeState {
    schema: number;
    files: Record<string, ClaudeFileState>;
    daily: Record<string, TokenTotals>;
    stats: Record<string, ClaudeDailyStats>;
    sessionsByDate: Record<string, string[]>;
    longestTurnMsByDate: Record<string, number>;
    quota: ClaudeQuota | null;
    scanComplete: boolean;
    updatedAt: number;
}

function emptyStats(): ClaudeDailyStats {
    return { sessions: 0, turns: 0, tools: 0, subagents: 0, compactions: 0 };
}

function emptyState(): ClaudeState {
    return {
        schema: 1,
        files: {},
        daily: {},
        stats: {},
        sessionsByDate: {},
        longestTurnMsByDate: {},
        quota: null,
        scanComplete: false,
        updatedAt: 0
    };
}

function statePath(environment: PathEnvironment): string {
    return path.join(dataRoot(environment), stateFileName);
}

export function loadClaudeState(environment: PathEnvironment = currentEnvironment()): ClaudeState {
    const loaded = readJSONIfPresent<ClaudeState>(statePath(environment));
    if (!loaded || loaded.schema !== 1) {
        return emptyState();
    }
    return { ...emptyState(), ...loaded };
}

export function saveClaudeState(state: ClaudeState, environment: PathEnvironment = currentEnvironment()): void {
    writeAtomic(statePath(environment), JSON.stringify(state));
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function number(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/// Claude Code 把账号信息写在用户目录的 .claude.json 里, 订阅类型可能在凭据文件中
export function readClaudeAccount(environment: PathEnvironment = currentEnvironment()): ClaudeAccount | null {
    const home = claudeHome(environment);
    const candidates = [
        path.join(environment.home, ".claude.json"),
        path.join(home, ".claude.json"),
        path.join(home, "config.json")
    ];
    let email: string | null = null;
    let organization: string | null = null;
    let plan: string | null = null;
    let source: string | null = null;
    for (const candidate of candidates) {
        const config = readJSONIfPresent<Record<string, unknown>>(candidate, 4 * 1024 * 1024);
        if (!config) {
            continue;
        }
        const account = config.oauthAccount as Record<string, unknown> | undefined;
        email = email ?? text(account?.emailAddress) ?? text(config.email);
        organization = organization ?? text(account?.organizationName);
        plan = plan
            ?? text(config.subscriptionType)
            ?? text(account?.subscriptionType)
            ?? text((config.oauthAccount as Record<string, unknown>)?.organizationRole);
        if (email || organization || plan) {
            source = candidate;
            break;
        }
    }
    const credentials = readJSONIfPresent<Record<string, unknown>>(path.join(home, ".credentials.json"), 256 * 1024);
    const oauth = credentials?.claudeAiOauth as Record<string, unknown> | undefined;
    plan = plan ?? text(oauth?.subscriptionType);
    if (!email && !organization && !plan) {
        return null;
    }
    return { email, organization, plan, source };
}

export function claudePlanLabel(plan: string | null): string | null {
    if (!plan) {
        return null;
    }
    const normalized = plan.toLowerCase().replace(/[_-]/g, "");
    switch (normalized) {
        case "max":
            return "Max";
        case "max5x":
            return "Max 5x";
        case "max20x":
            return "Max 20x";
        case "pro":
            return "Pro";
        case "team":
            return "Team";
        case "enterprise":
            return "Enterprise";
        case "free":
            return "Free";
        default:
            return plan;
    }
}

function windowLabelFor(name: string): string {
    switch (name) {
        case "five_hour":
            return "5h";
        case "seven_day":
            return "7d";
        case "seven_day_opus":
            return "7d Opus";
        default:
            return name;
    }
}

function quotaWindowsFrom(limits: Record<string, unknown>): ClaudeQuotaWindow[] {
    const windows: ClaudeQuotaWindow[] = [];
    for (const [name, raw] of Object.entries(limits)) {
        if (!raw || typeof raw !== "object") {
            continue;
        }
        const window = raw as Record<string, unknown>;
        const used = window.used_percentage ?? window.used_percent ?? window.utilization;
        if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) {
            continue;
        }
        const reset = parseAnyTimestamp(window.resets_at ?? window.resetsAt);
        windows.push({
            label: windowLabelFor(name),
            usedPercent: used,
            remainingPercent: Math.max(0, Math.min(100, 100 - used)),
            resetsAt: reset ? Math.trunc(reset.getTime() / 1000) : null
        });
    }
    return windows;
}

function observeQuota(state: ClaudeState, windows: ClaudeQuotaWindow[], at: number, source: string): void {
    if (windows.length === 0) {
        return;
    }
    if (!state.quota || at >= state.quota.observedAt) {
        state.quota = { observedAt: at, windows, source };
    }
}

/// ccline 缓存是 Claude 额度的常见来源, 旧缓存的 resets_at 只属于七天窗口
export function readClaudeQuotaCache(environment: PathEnvironment = currentEnvironment()): ClaudeQuota | null {
    const cachePath = path.join(claudeHome(environment), "ccline", ".api_usage_cache.json");
    const value = readJSONIfPresent<Record<string, unknown>>(cachePath, 64 * 1024);
    if (!value) {
        return null;
    }
    const observed = parseAnyTimestamp(value.cached_at);
    if (!observed || observed.getTime() > Date.now() + 60_000) {
        return null;
    }
    const windows = quotaWindowsFrom({
        five_hour: { utilization: value.five_hour_utilization, resets_at: value.five_hour_resets_at },
        seven_day: {
            utilization: value.seven_day_utilization,
            resets_at: value.seven_day_resets_at ?? value.resets_at
        }
    });
    if (windows.length === 0) {
        return null;
    }
    return { observedAt: Math.trunc(observed.getTime() / 1000), windows, source: "ccline" };
}

function ensureDaily(state: ClaudeState, date: string): TokenTotals {
    const existing = state.daily[date];
    if (existing) {
        return existing;
    }
    const created = emptyTotals();
    state.daily[date] = created;
    return created;
}

function ensureStats(state: ClaudeState, date: string): ClaudeDailyStats {
    const existing = state.stats[date];
    if (existing) {
        return existing;
    }
    const created = emptyStats();
    state.stats[date] = created;
    return created;
}

function recordSession(state: ClaudeState, date: string, session: string | null): void {
    if (!session) {
        return;
    }
    const sessions = state.sessionsByDate[date] ?? [];
    if (!sessions.includes(session)) {
        sessions.push(session);
        state.sessionsByDate[date] = sessions;
        ensureStats(state, date).sessions = sessions.length;
    }
}

function consumeRow(state: ClaudeState, fileState: ClaudeFileState, row: Record<string, unknown>): void {
    const timestamp = parseAnyTimestamp(row.timestamp);
    if (!timestamp) {
        return;
    }
    const date = dayKey(timestamp);
    const session = text(row.sessionId) ?? text(row.session_id) ?? fileState.session;
    fileState.session = session;
    recordSession(state, date, session);

    if (row.rate_limits && typeof row.rate_limits === "object") {
        observeQuota(
            state,
            quotaWindowsFrom(row.rate_limits as Record<string, unknown>),
            Math.trunc(timestamp.getTime() / 1000),
            "session"
        );
    }

    const type = text(row.type);
    const message = row.message as Record<string, unknown> | undefined;
    if (type === "assistant" && message) {
        fileState.model = text(message.model) ?? fileState.model;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (usage) {
            const totals = ensureDaily(state, date);
            const input = number(usage.input_tokens);
            const output = number(usage.output_tokens);
            totals.input += input;
            totals.output += output;
            totals.cacheRead += number(usage.cache_read_input_tokens);
            totals.cacheWrite += number(usage.cache_creation_input_tokens);
            totals.total += input + output;
        }
        const content = message.content;
        if (Array.isArray(content)) {
            const tools = content.filter(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_use");
            if (tools.length > 0) {
                ensureStats(state, date).tools += tools.length;
            }
        }
    } else if (type === "user" && message && !row.isMeta) {
        const content = message.content;
        const isToolResult = Array.isArray(content)
            && content.some(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result");
        if (!isToolResult) {
            ensureStats(state, date).turns += 1;
        }
    } else if (type === "system" && text(row.subtype) === "compact_boundary") {
        ensureStats(state, date).compactions += 1;
    } else if (type === "system" && text(row.subtype) === "turn_duration") {
        const duration = number(row.durationMs);
        if (duration > 0) {
            state.longestTurnMsByDate[date] = Math.max(state.longestTurnMsByDate[date] ?? 0, duration);
        }
    }
    if (row.isSidechain === true) {
        ensureStats(state, date).subagents += 1;
    }
}

function collectFiles(root: string, out: string[], deadline: number): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }
    entries.sort((lhs, rhs) => rhs.name.localeCompare(lhs.name));
    for (const entry of entries) {
        if (Date.now() >= deadline) {
            return;
        }
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectFiles(full, out, deadline);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            out.push(full);
        }
    }
}

export interface ClaudeScanOptions {
    environment?: PathEnvironment;
    budgetMs?: number;
    now?: Date;
}

/// 增量扫描 Claude Code 会话日志, 与 Codex 侧保持同一套增量策略
export function scanClaude(state: ClaudeState, options: ClaudeScanOptions = {}): ClaudeState {
    const environment = options.environment ?? currentEnvironment();
    const now = options.now ?? new Date();
    const deadline = Date.now() + (options.budgetMs ?? defaultBudgetMs);
    const roots = [path.join(claudeHome(environment), "projects")];
    const files: string[] = [];
    for (const root of roots) {
        collectFiles(root, files, deadline);
    }
    let complete = true;
    for (const filePath of files) {
        if (Date.now() >= deadline) {
            complete = false;
            break;
        }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            continue;
        }
        const previous = state.files[filePath];
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
            continue;
        }
        const fileState: ClaudeFileState = previous && stat.size >= previous.offset
            ? previous
            : { size: 0, mtimeMs: 0, offset: 0, session: null, model: null };
        const { lines, offset } = readLinesFrom(filePath, fileState.offset);
        for (const line of lines) {
            const row = parseJSONLine<Record<string, unknown>>(line);
            if (row) {
                consumeRow(state, fileState, row);
            }
        }
        fileState.offset = offset;
        fileState.size = stat.size;
        fileState.mtimeMs = stat.mtimeMs;
        state.files[filePath] = fileState;
    }

    const cache = readClaudeQuotaCache(environment);
    if (cache) {
        observeQuota(state, cache.windows, cache.observedAt, cache.source);
    }

    const dayCutoff = dayKey(new Date(now.getTime() - 210 * 86_400_000));
    for (const date of Object.keys(state.daily)) {
        if (date < dayCutoff) {
            delete state.daily[date];
            delete state.stats[date];
            delete state.sessionsByDate[date];
            delete state.longestTurnMsByDate[date];
        }
    }
    for (const filePath of Object.keys(state.files)) {
        if (!fs.existsSync(filePath)) {
            delete state.files[filePath];
        }
    }
    state.scanComplete = complete;
    state.updatedAt = now.getTime();
    return state;
}

export function claudeDailyTokens(state: ClaudeState): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [date, totals] of Object.entries(state.daily)) {
        result[date] = totals.total;
    }
    return result;
}
