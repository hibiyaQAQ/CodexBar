import * as fs from "node:fs";
import { ensureDirectory } from "./files";
import { PathEnvironment, currentEnvironment, localTimestamp, storagePaths } from "./paths";

export type LogCategory = "app" | "codex" | "hooks" | "workflow" | "claude" | "settings" | "estimate";

export type LogLevel = "notice" | "error";

const maxBytes = 2 * 1024 * 1024;
const memory: string[] = [];
const memoryLimit = 500;

function logPath(environment: PathEnvironment): string {
    return storagePaths(environment).logPath;
}

/// 文案骨架是 <主体><动作>: 字段=值; 字段=值
/// 只使用 notice 与 error 两个级别
export function log(
    category: LogCategory,
    level: LogLevel,
    message: string,
    fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
    const detail = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
    const line = `${localTimestamp(new Date())} [${level}] [${category}] ${message}${detail ? `: ${detail}` : ""}`;
    memory.push(line);
    if (memory.length > memoryLimit) {
        memory.shift();
    }
    if (level === "error") {
        console.error(line);
    } else {
        console.log(line);
    }
    appendToFile(line);
}

function appendToFile(line: string): void {
    try {
        const environment = currentEnvironment();
        const target = logPath(environment);
        ensureDirectory(storagePaths(environment).root);
        rotateIfNeeded(target);
        fs.appendFileSync(target, `${line}\n`, { encoding: "utf8" });
    } catch {
        // 日志写入失败不影响主流程
    }
}

function rotateIfNeeded(target: string): void {
    try {
        if (fs.statSync(target).size > maxBytes) {
            fs.renameSync(target, `${target}.1`);
        }
    } catch {
        // 文件不存在时无需轮转
    }
}

export function recentLogLines(): string[] {
    return [...memory];
}
