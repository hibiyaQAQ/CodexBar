import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock, ensureDirectory } from "./files";
import { PathEnvironment, currentEnvironment, dayKey, eventLogPath, localTimestamp, parseAnyTimestamp, storagePaths } from "./paths";

export const hookEventNames = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PreCompact",
    "PostCompact",
    "Stop",
    "Interrupt",
    "SubagentStart",
    "SubagentStop"
] as const;

export type HookEventName = (typeof hookEventNames)[number];

export const hookArgument = "--hook-event";

/// SessionEnd 与 Interrupt 在 Codex 中最多允许 3 秒, 其他事件沿用 5 秒
export function hookTimeoutSeconds(event: HookEventName | null): number {
    return event === "SessionEnd" || event === "Interrupt" ? 3 : 5;
}

/// 留出 2 秒在 Codex 杀掉子进程前主动收工, 避免写入中途留下半截坏行
export function lockWaitLimitMs(event: HookEventName | null): number {
    return Math.max(0, hookTimeoutSeconds(event) - 2) * 1000;
}

function normalizedName(value: string): string {
    return value.replace(/[_-]/g, "").toLowerCase();
}

export function hookEventFromName(value: string | null | undefined): HookEventName | null {
    if (!value) {
        return null;
    }
    const normalized = normalizedName(value);
    return hookEventNames.find(name => normalizedName(name) === normalized) ?? null;
}

export type EventOrigin = "main" | "autoReview" | "auxiliary" | "unknown";

export interface HookEventRecord {
    timestamp: Date;
    name: string;
    origin: EventOrigin;
    directoryPath: string | null;
    toolName: string | null;
    modelName: string | null;
    effort: string | null;
    permissionMode: string | null;
    approvalReviewer: string | null;
    sessionId: string | null;
    turnId: string | null;
    agentId: string | null;
}

const autoReviewModelName = "codex-auto-review";

function resolvedOrigin(origin: EventOrigin, modelName: string | null): EventOrigin {
    if (origin === "unknown" && modelName === autoReviewModelName) {
        return "autoReview";
    }
    return origin;
}

function trimmedString(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/// 写入 JSONL 时固定字段顺序, 与 macOS 版保持一致便于互读
export function encodeHookEvent(event: HookEventRecord): string {
    const fields: Array<[string, unknown]> = [
        ["timestamp", localTimestamp(event.timestamp)],
        ["event", event.name],
        ["origin", event.origin],
        ["model", event.modelName],
        ["effort", event.effort],
        ["permission", event.permissionMode],
        ["approval", event.approvalReviewer],
        ["session", event.sessionId],
        ["turn", event.turnId],
        ["agent", event.agentId],
        ["tool", event.toolName],
        ["cwd", event.directoryPath]
    ];
    const body = fields.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value ?? null)}`).join(",");
    return `{${body}}\n`;
}

export function decodeHookEvent(line: string): HookEventRecord | null {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
        return null;
    }
    const timestamp = parseAnyTimestamp(raw.timestamp);
    const name = trimmedString(raw.event);
    if (!timestamp || !name) {
        return null;
    }
    const modelName = trimmedString(raw.model);
    const rawOrigin = trimmedString(raw.origin);
    const origin: EventOrigin = rawOrigin === "main" || rawOrigin === "autoReview" || rawOrigin === "auxiliary"
        ? rawOrigin
        : "unknown";
    return {
        timestamp,
        name,
        origin: resolvedOrigin(origin, modelName),
        directoryPath: trimmedString(raw.cwd),
        toolName: trimmedString(raw.tool),
        modelName,
        effort: trimmedString(raw.effort),
        permissionMode: trimmedString(raw.permission),
        approvalReviewer: trimmedString(raw.approval),
        sessionId: trimmedString(raw.session),
        turnId: trimmedString(raw.turn),
        agentId: trimmedString(raw.agent)
    };
}

/// cwd 可能来自不同平台, 统一按两种分隔符取末段
export function projectDisplayName(directoryPath: string | null): string | null {
    if (!directoryPath) {
        return null;
    }
    const segments = directoryPath.replace(/[\\/]+$/, "").split(/[\\/]/);
    const base = segments[segments.length - 1] ?? "";
    return base.length > 0 ? base : directoryPath;
}

/// Hook 子进程从 stdin 读到的 payload 只取白名单字段
export function eventFromPayload(payload: Record<string, unknown>): HookEventRecord | null {
    const name = trimmedString(payload.hook_event_name);
    if (!name) {
        return null;
    }
    const timestamp = parseAnyTimestamp(payload.timestamp) ?? new Date();
    return {
        timestamp,
        name,
        origin: "unknown",
        directoryPath: trimmedString(payload.cwd) ?? process.cwd(),
        toolName: trimmedString(payload.tool_name),
        modelName: trimmedString(payload.model),
        effort: trimmedString(payload.effort) ?? trimmedString(payload.reasoning_effort),
        permissionMode: trimmedString(payload.permission_mode),
        approvalReviewer: trimmedString(payload.approval_reviewer),
        sessionId: trimmedString(payload.session_id),
        turnId: trimmedString(payload.turn_id),
        agentId: trimmedString(payload.agent_id)
    };
}

export interface RecordOptions {
    environment?: PathEnvironment;
    now?: Date;
}

/// 在锁内追加一行 JSONL, 写入失败静默返回不阻断 Codex
export function recordHookEvent(event: HookEventRecord, options: RecordOptions = {}): boolean {
    const environment = options.environment ?? currentEnvironment();
    const paths = storagePaths(environment);
    const key = dayKey(event.timestamp);
    const logPath = eventLogPath(key, environment);
    const hookEvent = hookEventFromName(event.name);
    const lock = acquireLock(paths.lockPath, lockWaitLimitMs(hookEvent));
    try {
        ensureDirectory(path.dirname(logPath));
        fs.appendFileSync(logPath, encodeHookEvent(event), { encoding: "utf8" });
        return true;
    } catch {
        return false;
    } finally {
        lock?.release();
    }
}
