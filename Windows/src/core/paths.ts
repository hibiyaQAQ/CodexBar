import * as os from "node:os";
import * as path from "node:path";

/// Windows 上的目录解析统一收在这里, 其他模块不再直接拼环境变量
/// 便于测试注入自定义 env 与 home
export interface PathEnvironment {
    env: NodeJS.ProcessEnv;
    home: string;
}

export function currentEnvironment(): PathEnvironment {
    return { env: process.env, home: os.homedir() };
}

function nonEmpty(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/// Codex 配置目录: 优先 CODEX_HOME, 回退用户目录下的 .codex
export function codexHome(environment: PathEnvironment = currentEnvironment()): string {
    const override = nonEmpty(environment.env.CODEX_HOME);
    return override ? path.resolve(override) : path.join(environment.home, ".codex");
}

/// Claude 配置目录: 优先 CLAUDE_CONFIG_DIR, 回退用户目录下的 .claude
export function claudeHome(environment: PathEnvironment = currentEnvironment()): string {
    const override = nonEmpty(environment.env.CLAUDE_CONFIG_DIR);
    return override ? path.resolve(override) : path.join(environment.home, ".claude");
}

/// 本机数据根目录, 与 macOS 版的 Application Support 目录同名便于迁移
export function dataRoot(environment: PathEnvironment = currentEnvironment()): string {
    const override = nonEmpty(environment.env.CODEXBAR_DATA_DIR);
    if (override) {
        return path.resolve(override);
    }
    const appData = nonEmpty(environment.env.APPDATA)
        ?? path.join(environment.home, "AppData", "Roaming");
    return path.join(appData, "CodexBar-yatotm");
}

export interface StoragePaths {
    root: string;
    hookEvents: string;
    eventsDirectory: string;
    dailyPath: string;
    maintenancePath: string;
    lockPath: string;
    settingsPath: string;
    observationsPath: string;
    logPath: string;
}

export function storagePaths(environment: PathEnvironment = currentEnvironment()): StoragePaths {
    const root = dataRoot(environment);
    const hookEvents = path.join(root, "HookEvents");
    return {
        root,
        hookEvents,
        eventsDirectory: path.join(hookEvents, "events"),
        dailyPath: path.join(hookEvents, "daily.jsonl"),
        maintenancePath: path.join(hookEvents, "maintenance.json"),
        lockPath: path.join(hookEvents, "stats.lock"),
        settingsPath: path.join(root, "settings.json"),
        observationsPath: path.join(root, "quota-observations.json"),
        logPath: path.join(root, "codexbar.log")
    };
}

export function eventLogPath(dateKey: string, environment: PathEnvironment = currentEnvironment()): string {
    return path.join(storagePaths(environment).eventsDirectory, `${dateKey}.jsonl`);
}

function padded(value: number, length: number): string {
    return String(Math.abs(value)).padStart(length, "0");
}

/// yyyy-MM-dd 本地日期键, 热力图与按日聚合共用
export function dayKey(date: Date): string {
    return `${padded(date.getFullYear(), 4)}-${padded(date.getMonth() + 1, 2)}-${padded(date.getDate(), 2)}`;
}

/// yyyy-MM-dd HH:mm:ss.SSS 本机时间串, 与 macOS 版 Hook 行格式一致
export function localTimestamp(date: Date): string {
    const day = dayKey(date);
    const time = `${padded(date.getHours(), 2)}:${padded(date.getMinutes(), 2)}:${padded(date.getSeconds(), 2)}`;
    return `${day} ${time}.${padded(date.getMilliseconds(), 3)}`;
}

export function parseLocalTimestamp(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(value.trim());
    if (!match) {
        return null;
    }
    const [, year, month, day, hour, minute, second, fraction] = match;
    const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number((fraction ?? "0").padEnd(3, "0"))
    );
    return Number.isNaN(date.getTime()) ? null : date;
}

/// ISO8601 或本机时间串都可能出现在原始日志里, 解析失败返回 null
export function parseAnyTimestamp(value: unknown): Date | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        const seconds = value > 1e12 ? value / 1000 : value;
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    const text = value.trim();
    if (text.includes("T") || text.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(text)) {
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    return parseLocalTimestamp(text);
}

export function dayKeyOffset(date: Date, days: number): string {
    const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
    return dayKey(shifted);
}
