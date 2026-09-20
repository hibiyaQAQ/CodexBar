import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONLine, readJSONIfPresent, readLinesFrom, writeAtomic } from "./files";
import { PathEnvironment, codexHome, currentEnvironment, dataRoot, dayKey, parseAnyTimestamp } from "./paths";

/// 本机 rollout 扫描状态, 与 daily 聚合分开存放
const stateFileName = "rollout-state.json";
const tokenEventRetentionDays = 14;
const defaultBudgetMs = 8_000;

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
}

export interface TokenEvent {
    at: number;
    tokens: number;
}

export interface QuotaObservation {
    at: number;
    windows: Array<{ name: string; usedPercent: number; resetsAt: number | null; windowMinutes: number | null }>;
}

interface FileState {
    size: number;
    mtimeMs: number;
    offset: number;
    session: string | null;
    model: string | null;
    project: string | null;
    totals: Record<string, number>;
    exactUsage: boolean;
}

export interface RolloutState {
    schema: number;
    files: Record<string, FileState>;
    daily: Record<string, TokenTotals>;
    longestTurnMsByDate: Record<string, number>;
    turnCountByDate: Record<string, number>;
    tokenEvents: TokenEvent[];
    quota: QuotaObservation | null;
    scanComplete: boolean;
    updatedAt: number;
}

export function emptyTotals(): TokenTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function emptyState(): RolloutState {
    return {
        schema: 1,
        files: {},
        daily: {},
        longestTurnMsByDate: {},
        turnCountByDate: {},
        tokenEvents: [],
        quota: null,
        scanComplete: false,
        updatedAt: 0
    };
}

function statePath(environment: PathEnvironment): string {
    return path.join(dataRoot(environment), stateFileName);
}

export function loadRolloutState(environment: PathEnvironment = currentEnvironment()): RolloutState {
    const loaded = readJSONIfPresent<RolloutState>(statePath(environment));
    if (!loaded || loaded.schema !== 1) {
        return emptyState();
    }
    return {
        ...emptyState(),
        ...loaded,
        files: loaded.files ?? {},
        daily: loaded.daily ?? {},
        longestTurnMsByDate: loaded.longestTurnMsByDate ?? {},
        turnCountByDate: loaded.turnCountByDate ?? {},
        tokenEvents: Array.isArray(loaded.tokenEvents) ? loaded.tokenEvents : []
    };
}

export function saveRolloutState(state: RolloutState, environment: PathEnvironment = currentEnvironment()): void {
    writeAtomic(statePath(environment), JSON.stringify(state));
}

function number(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function addTotals(target: TokenTotals, usage: Record<string, unknown>): number {
    const input = number(usage.input_tokens);
    const output = number(usage.output_tokens);
    const cacheRead = number(usage.cached_input_tokens);
    const cacheWrite = number(usage.cache_write_input_tokens);
    const reasoning = number(usage.reasoning_output_tokens);
    target.input += input;
    target.output += output;
    target.cacheRead += cacheRead;
    target.cacheWrite += cacheWrite;
    target.reasoning += reasoning;
    // 与 Codex 官方用量口径一致: 计费 token 不重复计入缓存读取
    const billed = input + output;
    target.total += billed;
    return billed;
}

function ensureDaily(state: RolloutState, date: string): TokenTotals {
    const existing = state.daily[date];
    if (existing) {
        return existing;
    }
    const created = emptyTotals();
    state.daily[date] = created;
    return created;
}

function observeQuota(state: RolloutState, limits: Record<string, unknown>, at: number): void {
    const windows: QuotaObservation["windows"] = [];
    for (const [name, raw] of Object.entries(limits)) {
        if (name !== "primary" && name !== "secondary") {
            continue;
        }
        if (!raw || typeof raw !== "object") {
            continue;
        }
        const window = raw as Record<string, unknown>;
        const used = window.used_percent ?? window.used_percentage ?? window.utilization;
        if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) {
            continue;
        }
        const minutes = number(window.window_minutes ?? window.window_duration_mins) || null;
        const resetsRaw = window.resets_at ?? window.resetsAt;
        const resets = parseAnyTimestamp(resetsRaw as never);
        windows.push({
            name,
            usedPercent: used,
            resetsAt: resets ? Math.trunc(resets.getTime() / 1000) : null,
            windowMinutes: minutes
        });
    }
    if (windows.length > 0 && (!state.quota || at >= state.quota.at)) {
        state.quota = { at, windows };
    }
}

function consumeRow(state: RolloutState, fileState: FileState, row: Record<string, unknown>): void {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") {
        return;
    }
    const body = payload as Record<string, unknown>;
    const rowType = typeof row.type === "string" ? row.type : "";
    const subType = typeof body.type === "string" ? body.type : "";
    const timestamp = parseAnyTimestamp(row.timestamp) ?? parseAnyTimestamp(body.timestamp);
    if (!timestamp) {
        return;
    }
    const date = dayKey(timestamp);
    const at = timestamp.getTime();

    if (rowType === "session_meta") {
        fileState.session = typeof body.id === "string" ? body.id : fileState.session;
        const cwd = typeof body.cwd === "string" ? body.cwd : null;
        fileState.project = cwd ? path.basename(cwd) : fileState.project;
        return;
    }
    if (rowType === "turn_context") {
        fileState.model = typeof body.model === "string" ? body.model : fileState.model;
        return;
    }
    if (rowType === "token_usage_record" && body.usage && typeof body.usage === "object" && body.response_id) {
        fileState.exactUsage = true;
        const billed = addTotals(ensureDaily(state, date), body.usage as Record<string, unknown>);
        if (billed > 0) {
            state.tokenEvents.push({ at, tokens: billed });
        }
        return;
    }
    if (rowType === "event_msg" && subType === "token_count") {
        const info = body.info;
        if (info && typeof info === "object") {
            const total = (info as Record<string, unknown>).total_token_usage;
            if (total && typeof total === "object" && !fileState.exactUsage) {
                const totals = total as Record<string, unknown>;
                const fields = [
                    "input_tokens",
                    "output_tokens",
                    "cached_input_tokens",
                    "cache_write_input_tokens",
                    "reasoning_output_tokens"
                ];
                const delta: Record<string, number> = {};
                let changed = false;
                for (const field of fields) {
                    const current = number(totals[field]);
                    const previous = fileState.totals[field] ?? 0;
                    const value = Math.max(0, current - previous);
                    delta[field] = value;
                    if (value > 0) {
                        changed = true;
                    }
                    fileState.totals[field] = Math.max(current, previous);
                }
                if (changed) {
                    const billed = addTotals(ensureDaily(state, date), delta);
                    if (billed > 0) {
                        state.tokenEvents.push({ at, tokens: billed });
                    }
                }
            }
        }
        const limits = body.rate_limits;
        if (limits && typeof limits === "object") {
            observeQuota(state, limits as Record<string, unknown>, Math.trunc(at / 1000));
        }
        return;
    }
    if (rowType === "event_msg" && subType === "task_complete") {
        const duration = number(body.duration_ms);
        if (duration > 0) {
            state.longestTurnMsByDate[date] = Math.max(state.longestTurnMsByDate[date] ?? 0, duration);
        }
        return;
    }
    if (rowType === "event_msg" && subType === "task_started") {
        state.turnCountByDate[date] = (state.turnCountByDate[date] ?? 0) + 1;
    }
}

function collectRolloutFiles(root: string, out: string[], budgetDeadline: number): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }
    // 目录名按日期递减, 先扫最新的会话
    entries.sort((lhs, rhs) => rhs.name.localeCompare(lhs.name));
    for (const entry of entries) {
        if (Date.now() >= budgetDeadline) {
            return;
        }
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectRolloutFiles(full, out, budgetDeadline);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            out.push(full);
        }
    }
}

export interface ScanOptions {
    environment?: PathEnvironment;
    budgetMs?: number;
    now?: Date;
}

/// 增量扫描本机 Codex 会话日志, 只提取 token, 时长与额度观测
export function scanRollouts(state: RolloutState, options: ScanOptions = {}): RolloutState {
    const environment = options.environment ?? currentEnvironment();
    const now = options.now ?? new Date();
    const deadline = Date.now() + (options.budgetMs ?? defaultBudgetMs);
    const home = codexHome(environment);
    const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
    const files: string[] = [];
    for (const root of roots) {
        collectRolloutFiles(root, files, deadline);
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
        // rollout 是追加写文件, 只有被整体替换时才从头重读
        // 这种情况下当天 token 可能重复累加一次, 换取实现上不必保留每个文件的分项贡献
        const fileState: FileState = previous && stat.size >= previous.offset
            ? previous
            : {
                size: 0,
                mtimeMs: 0,
                offset: 0,
                session: null,
                model: null,
                project: null,
                totals: {},
                exactUsage: false
            };
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

    // 只保留最近窗口估算需要的 token 事件, 其余按日聚合已经落盘
    const cutoff = now.getTime() - tokenEventRetentionDays * 86_400_000;
    state.tokenEvents = state.tokenEvents
        .filter(event => event.at >= cutoff)
        .sort((lhs, rhs) => lhs.at - rhs.at);
    const dayCutoff = dayKey(new Date(now.getTime() - 210 * 86_400_000));
    for (const date of Object.keys(state.daily)) {
        if (date < dayCutoff) {
            delete state.daily[date];
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

export function dailyTokensMap(state: RolloutState): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [date, totals] of Object.entries(state.daily)) {
        result[date] = totals.total;
    }
    return result;
}

/// 指定时间范围内的计费 token 合计, 供额度估算使用
export function tokensInRange(state: RolloutState, fromMs: number, toMs: number): number {
    return state.tokenEvents
        .filter(event => event.at >= fromMs && event.at <= toMs)
        .reduce((sum, event) => sum + event.tokens, 0);
}

export function longestTurnMs(state: RolloutState): number | null {
    const values = Object.values(state.longestTurnMsByDate);
    return values.length > 0 ? Math.max(...values) : null;
}
