import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock, ensureDirectory, parseJSONLine, readLinesFrom, readTextIfPresent, statIfPresent, writeAtomic } from "./files";
import { HookEventName, HookEventRecord, decodeHookEvent, hookEventFromName, projectDisplayName } from "./hookEvent";
import { PathEnvironment, currentEnvironment, dayKey, dayKeyOffset, storagePaths } from "./paths";

/// 需要从原始事件重新计算的聚合规则变化时递增这个版本, 统一走完整重建
export const currentAggregationSchema = 1;

/// 原始事件与 daily 聚合都保留 210 天, 会话与轮次标识只保留 3 天
export const retentionDays = 210;
export const identifierRetentionDays = 3;

export interface DailyAggregate {
    date: string;
    eventCount: number | null;
    sessionStartCount: number | null;
    sessionEndCount: number | null;
    userPromptSubmitCount: number | null;
    stopCount: number | null;
    interruptCount: number | null;
    preToolUseCount: number | null;
    postToolUseCount: number | null;
    permissionRequestCount: number | null;
    preCompactCount: number | null;
    postCompactCount: number | null;
    subagentStartCount: number | null;
    subagentStopCount: number | null;
    sessionCount: number | null;
    turnCount: number | null;
    sessionIds: string[] | null;
    turnIds: string[] | null;
    projectCounts: Record<string, number>;
    modelCounts: Record<string, number>;
    longestTurnMs: number | null;
    openTurns: Record<string, number> | null;
}

export interface DailyMetrics {
    startDate: string;
    sessionCount: number;
    turnCount: number;
    toolCallCount: number;
    permissionRequestCount: number;
    contextCompactionCount: number;
    subagentCount: number;
    interruptCount: number | null;
    eventCount: number;
    longestTurnMs: number | null;
    modelCounts: Record<string, number>;
    projectCounts: Record<string, number>;
    mostUsedModel: string | null;
}

interface MaintenanceDay {
    offset: number;
    fileIdentifier: string | null;
}

export interface MaintenanceState {
    aggregationSchema: number;
    days: Record<string, MaintenanceDay>;
}

export function emptyAggregate(date: string): DailyAggregate {
    return {
        date,
        eventCount: 0,
        sessionStartCount: 0,
        sessionEndCount: 0,
        userPromptSubmitCount: 0,
        stopCount: 0,
        interruptCount: 0,
        preToolUseCount: 0,
        postToolUseCount: 0,
        permissionRequestCount: 0,
        preCompactCount: 0,
        postCompactCount: 0,
        subagentStartCount: 0,
        subagentStopCount: 0,
        sessionCount: null,
        turnCount: null,
        sessionIds: [],
        turnIds: [],
        projectCounts: {},
        modelCounts: {},
        longestTurnMs: null,
        openTurns: {}
    };
}

function increment(value: number | null): number {
    return (value ?? 0) + 1;
}

const countFieldByEvent: Record<HookEventName, keyof DailyAggregate> = {
    SessionStart: "sessionStartCount",
    SessionEnd: "sessionEndCount",
    UserPromptSubmit: "userPromptSubmitCount",
    Stop: "stopCount",
    Interrupt: "interruptCount",
    PreToolUse: "preToolUseCount",
    PostToolUse: "postToolUseCount",
    PermissionRequest: "permissionRequestCount",
    PreCompact: "preCompactCount",
    PostCompact: "postCompactCount",
    SubagentStart: "subagentStartCount",
    SubagentStop: "subagentStopCount"
};

/// 逐条累加原始事件, 会话与轮次先按集合去重, 落盘时才决定保留还是压缩
export function accumulate(aggregate: DailyAggregate, event: HookEventRecord): DailyAggregate {
    const result = aggregate;
    result.eventCount = increment(result.eventCount);
    const hookEvent = hookEventFromName(event.name);
    if (hookEvent) {
        const field = countFieldByEvent[hookEvent];
        (result[field] as number | null) = increment(result[field] as number | null);
    }
    // 终态事件不单独构成对应的当日活跃会话或轮次
    if (hookEvent !== "SessionEnd" && event.sessionId && result.sessionIds) {
        if (!result.sessionIds.includes(event.sessionId)) {
            result.sessionIds.push(event.sessionId);
        }
    }
    if (hookEvent !== "Stop" && hookEvent !== "Interrupt" && event.turnId && result.turnIds) {
        if (!result.turnIds.includes(event.turnId)) {
            result.turnIds.push(event.turnId);
        }
    }
    const project = projectDisplayName(event.directoryPath);
    if (project) {
        result.projectCounts[project] = (result.projectCounts[project] ?? 0) + 1;
    }
    if (event.modelName) {
        result.modelCounts[event.modelName] = (result.modelCounts[event.modelName] ?? 0) + 1;
    }
    recordTurnDuration(result, event, hookEvent);
    return result;
}

/// 任务时长按同一 turn 的开始与终态事件配对, 缺开始的终态不计入
function recordTurnDuration(
    aggregate: DailyAggregate,
    event: HookEventRecord,
    hookEvent: HookEventName | null
): void {
    if (!event.turnId || !aggregate.openTurns) {
        return;
    }
    const at = event.timestamp.getTime();
    if (hookEvent === "UserPromptSubmit") {
        if (aggregate.openTurns[event.turnId] === undefined) {
            aggregate.openTurns[event.turnId] = at;
        }
        return;
    }
    if (hookEvent !== "Stop" && hookEvent !== "Interrupt") {
        return;
    }
    const startedAt = aggregate.openTurns[event.turnId];
    if (startedAt === undefined) {
        return;
    }
    delete aggregate.openTurns[event.turnId];
    const duration = at - startedAt;
    if (duration <= 0) {
        return;
    }
    aggregate.longestTurnMs = Math.max(aggregate.longestTurnMs ?? 0, duration);
}

function resolvedCount(compacted: number | null, identifiers: string[] | null, fallback: number): number {
    if (compacted !== null && compacted > 0) {
        return compacted;
    }
    if (identifiers) {
        return new Set(identifiers).size;
    }
    return compacted === 0 ? 0 : fallback;
}

export function metricsFrom(aggregate: DailyAggregate): DailyMetrics {
    const modelCounts = aggregate.modelCounts ?? {};
    const mostUsedModel = Object.entries(modelCounts)
        .filter(([, count]) => count > 0)
        .sort((lhs, rhs) => (rhs[1] - lhs[1]) || lhs[0].localeCompare(rhs[0]))[0]?.[0] ?? null;
    return {
        startDate: aggregate.date,
        sessionCount: resolvedCount(aggregate.sessionCount, aggregate.sessionIds, aggregate.sessionStartCount ?? 0),
        turnCount: resolvedCount(aggregate.turnCount, aggregate.turnIds, aggregate.stopCount ?? 0),
        toolCallCount: Math.max(aggregate.preToolUseCount ?? 0, aggregate.postToolUseCount ?? 0),
        permissionRequestCount: aggregate.permissionRequestCount ?? 0,
        contextCompactionCount: Math.max(aggregate.preCompactCount ?? 0, aggregate.postCompactCount ?? 0),
        subagentCount: Math.max(aggregate.subagentStartCount ?? 0, aggregate.subagentStopCount ?? 0),
        interruptCount: aggregate.interruptCount,
        eventCount: aggregate.eventCount ?? 0,
        longestTurnMs: aggregate.longestTurnMs,
        modelCounts,
        projectCounts: aggregate.projectCounts ?? {},
        mostUsedModel
    };
}

/// 超过标识保留期的日期只留下去重后的计数, 不再保留原始 ID
export function finalize(aggregate: DailyAggregate, retainIdentifiers: boolean): DailyAggregate {
    if (retainIdentifiers) {
        aggregate.sessionIds = [...new Set(aggregate.sessionIds ?? [])].sort();
        aggregate.turnIds = [...new Set(aggregate.turnIds ?? [])].sort();
        return aggregate;
    }
    aggregate.sessionCount = resolvedCount(aggregate.sessionCount, aggregate.sessionIds, aggregate.sessionStartCount ?? 0);
    aggregate.turnCount = resolvedCount(aggregate.turnCount, aggregate.turnIds, aggregate.stopCount ?? 0);
    aggregate.sessionIds = null;
    aggregate.turnIds = null;
    aggregate.openTurns = null;
    return aggregate;
}

/// 已压缩的日期收到新事件时无法安全去重, 必须从原始 JSONL 完整重建
export function supportsIncremental(aggregate: DailyAggregate): boolean {
    return aggregate.sessionIds !== null && aggregate.turnIds !== null;
}

function loadMaintenance(filePath: string): MaintenanceState {
    const text = readTextIfPresent(filePath);
    if (!text) {
        return { aggregationSchema: currentAggregationSchema, days: {} };
    }
    try {
        const parsed = JSON.parse(text) as Partial<MaintenanceState>;
        return {
            aggregationSchema: typeof parsed.aggregationSchema === "number" ? parsed.aggregationSchema : 0,
            days: parsed.days && typeof parsed.days === "object" ? parsed.days : {}
        };
    } catch {
        return { aggregationSchema: 0, days: {} };
    }
}

function loadDaily(filePath: string): Map<string, DailyAggregate> {
    const result = new Map<string, DailyAggregate>();
    const text = readTextIfPresent(filePath);
    if (!text) {
        return result;
    }
    for (const line of text.split("\n")) {
        const parsed = parseJSONLine<DailyAggregate>(line);
        if (parsed && typeof parsed.date === "string") {
            parsed.projectCounts = parsed.projectCounts ?? {};
            parsed.modelCounts = parsed.modelCounts ?? {};
            result.set(parsed.date, parsed);
        }
    }
    return result;
}

function saveDaily(filePath: string, aggregates: Map<string, DailyAggregate>): void {
    const lines = [...aggregates.values()]
        .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
        .map(aggregate => JSON.stringify(aggregate));
    writeAtomic(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

function eventFileDates(directory: string): string[] {
    try {
        return fs.readdirSync(directory)
            .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
            .map(name => name.slice(0, 10))
            .sort();
    } catch {
        return [];
    }
}

export interface RefreshResult {
    metrics: DailyMetrics[];
    updatedDates: string[];
    rebuiltDates: string[];
}

export interface RefreshOptions {
    environment?: PathEnvironment;
    now?: Date;
}

/// 增量聚合入口: 按文件偏移续读, 文件身份变化或收缩时整日重建
export function refreshWorkflow(options: RefreshOptions = {}): RefreshResult {
    const environment = options.environment ?? currentEnvironment();
    const now = options.now ?? new Date();
    const paths = storagePaths(environment);
    ensureDirectory(paths.eventsDirectory);
    // 主进程同步执行, 等锁预算只留 2 秒
    // 拿不到锁也继续: 原始事件文件只被 Hook 子进程追加, 这里只读它并原子写自己的产物
    const lock = acquireLock(paths.lockPath, 2_000);
    try {
        const maintenance = loadMaintenance(paths.maintenancePath);
        const aggregates = loadDaily(paths.dailyPath);
        const schemaChanged = maintenance.aggregationSchema !== currentAggregationSchema;
        const identifierCutoff = dayKeyOffset(now, -identifierRetentionDays);
        const retentionCutoff = dayKeyOffset(now, -retentionDays);
        const updatedDates: string[] = [];
        const rebuiltDates: string[] = [];

        for (const date of eventFileDates(paths.eventsDirectory)) {
            const filePath = path.join(paths.eventsDirectory, `${date}.jsonl`);
            const stat = statIfPresent(filePath);
            if (!stat) {
                continue;
            }
            if (date < retentionCutoff) {
                try {
                    fs.unlinkSync(filePath);
                } catch {
                    // 清理失败时留到下一轮
                }
                aggregates.delete(date);
                delete maintenance.days[date];
                continue;
            }
            const day = maintenance.days[date];
            const existing = aggregates.get(date);
            const identifierChanged = !!day?.fileIdentifier && day.fileIdentifier !== stat.identifier;
            const shrank = !!day && stat.size < day.offset;
            const needsRebuild = schemaChanged
                || identifierChanged
                || shrank
                || !existing
                || !supportsIncremental(existing);
            let aggregate: DailyAggregate;
            let offset = 0;
            if (needsRebuild) {
                aggregate = emptyAggregate(date);
                rebuiltDates.push(date);
            } else {
                aggregate = existing as DailyAggregate;
                offset = day?.offset ?? 0;
            }
            if (!needsRebuild && offset >= stat.size) {
                continue;
            }
            const { lines, offset: nextOffset } = readLinesFrom(filePath, offset);
            if (lines.length === 0 && !needsRebuild) {
                maintenance.days[date] = { offset: nextOffset, fileIdentifier: stat.identifier };
                continue;
            }
            for (const line of lines) {
                const event = decodeHookEvent(line);
                if (event) {
                    accumulate(aggregate, event);
                }
            }
            const retainIdentifiers = date >= identifierCutoff;
            aggregates.set(date, finalize(aggregate, retainIdentifiers));
            maintenance.days[date] = { offset: nextOffset, fileIdentifier: stat.identifier };
            updatedDates.push(date);
        }

        // 超出标识保留期的历史日期在此压缩, 之后只保留去重计数
        for (const [date, aggregate] of aggregates) {
            if (date < retentionCutoff) {
                aggregates.delete(date);
                delete maintenance.days[date];
                continue;
            }
            if (date < identifierCutoff && supportsIncremental(aggregate)) {
                aggregates.set(date, finalize(aggregate, false));
            }
        }

        maintenance.aggregationSchema = currentAggregationSchema;
        saveDaily(paths.dailyPath, aggregates);
        writeAtomic(paths.maintenancePath, `${JSON.stringify(maintenance, null, 2)}\n`);

        const metrics = [...aggregates.values()]
            .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
            .map(metricsFrom);
        return { metrics, updatedDates, rebuiltDates };
    } finally {
        lock?.release();
    }
}

export function metricsByDate(metrics: DailyMetrics[]): Map<string, DailyMetrics> {
    return new Map(metrics.map(entry => [entry.startDate, entry]));
}

export function emptyMetrics(startDate: string): DailyMetrics {
    return {
        startDate,
        sessionCount: 0,
        turnCount: 0,
        toolCallCount: 0,
        permissionRequestCount: 0,
        contextCompactionCount: 0,
        subagentCount: 0,
        interruptCount: null,
        eventCount: 0,
        longestTurnMs: null,
        modelCounts: {},
        projectCounts: {},
        mostUsedModel: null
    };
}

export function todayKey(now = new Date()): string {
    return dayKey(now);
}
