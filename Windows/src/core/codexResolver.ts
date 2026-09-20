import * as fs from "node:fs";
import * as path from "node:path";
import { PathEnvironment, currentEnvironment } from "./paths";

export type CodexExecutableSource = "global" | "bundled" | "manual";

export interface CodexExecutable {
    source: CodexExecutableSource;
    executablePath: string;
}

export interface SpawnDescription {
    command: string;
    args: string[];
    windowsVerbatimArguments: boolean;
}

const executableNames = ["codex"];

/// npm 全局安装会生成 codex.cmd, 原生安装是 codex.exe
/// 默认扩展名列表覆盖 PATHEXT 缺失的情况
function pathExtensions(environment: PathEnvironment): string[] {
    const raw = environment.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    const extensions = raw.split(";").map(value => value.trim()).filter(value => value.length > 0);
    return extensions.length > 0 ? extensions : [".EXE", ".CMD"];
}

function isExecutableFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/// 与 where.exe 同样的查找顺序: 逐个 PATH 目录配合 PATHEXT
export function findOnPath(
    name: string,
    environment: PathEnvironment = currentEnvironment()
): string | null {
    const searchPath = environment.env.PATH ?? environment.env.Path ?? "";
    const directories = searchPath.split(path.delimiter).map(value => value.trim()).filter(Boolean);
    const extensions = pathExtensions(environment);
    for (const directory of directories) {
        const base = path.join(directory, name);
        if (path.extname(base) && isExecutableFile(base)) {
            return base;
        }
        for (const extension of extensions) {
            const candidate = base + extension.toLowerCase();
            if (isExecutableFile(candidate)) {
                return candidate;
            }
            const upper = base + extension.toUpperCase();
            if (isExecutableFile(upper)) {
                return upper;
            }
        }
    }
    return null;
}

/// ChatGPT 桌面端与 Codex 桌面端在 Windows 上的内置可执行文件候选位置
export function bundledCandidates(environment: PathEnvironment = currentEnvironment()): string[] {
    const localAppData = environment.env.LOCALAPPDATA ?? path.join(environment.home, "AppData", "Local");
    const programFiles = environment.env.ProgramFiles ?? "C:\\Program Files";
    return [
        path.join(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
        path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
        path.join(programFiles, "ChatGPT", "resources", "codex.exe"),
        path.join(programFiles, "Codex", "resources", "codex.exe")
    ];
}

export interface ResolveOptions {
    manualPath?: string | null;
    environment?: PathEnvironment;
}

/// 解析优先级与 macOS 版保持一致: 手动指定优先, 其次 PATH, 最后内置安装
export function resolveCodexExecutable(options: ResolveOptions = {}): CodexExecutable | null {
    const environment = options.environment ?? currentEnvironment();
    const manual = options.manualPath?.trim();
    if (manual && isExecutableFile(manual)) {
        return { source: "manual", executablePath: manual };
    }
    for (const name of executableNames) {
        const found = findOnPath(name, environment);
        if (found) {
            return { source: "global", executablePath: found };
        }
    }
    const bundled = bundledCandidates(environment).find(isExecutableFile);
    return bundled ? { source: "bundled", executablePath: bundled } : null;
}

export function quoteWindowsArgument(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/// .cmd 与 .bat 必须经 cmd.exe 启动, 直接 spawn 会失败
export function spawnDescription(executablePath: string, args: string[]): SpawnDescription {
    const extension = path.extname(executablePath).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
        const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
        const line = [executablePath, ...args].map(quoteWindowsArgument).join(" ");
        return {
            command: comSpec,
            args: ["/d", "/s", "/c", `"${line}"`],
            windowsVerbatimArguments: true
        };
    }
    return { command: executablePath, args, windowsVerbatimArguments: false };
}

export const appServerArguments = ["app-server", "--listen", "stdio://"];

/// 版本比较只取前三段数字, 预发布后缀不参与判断
export function compareVersions(lhs: string, rhs: string): number {
    const parse = (value: string): number[] => {
        const core = value.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
        return core.split(".").map(part => Number.parseInt(part, 10)).map(part => (Number.isFinite(part) ? part : 0));
    };
    const left = parse(lhs);
    const right = parse(rhs);
    for (let index = 0; index < 3; index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference < 0 ? -1 : 1;
        }
    }
    return 0;
}

export function isVersionAtLeast(version: string | null, minimum: string): boolean | null {
    if (!version || !/^\d+(\.\d+)*/.test(version.trim().replace(/^v/i, ""))) {
        return null;
    }
    return compareVersions(version, minimum) >= 0;
}

/// 账户主链路的最低版本, Hook 链路另有更高要求
export const minimumCodexVersion = "0.145.0";
export const minimumHookCodexVersion = "0.150.0";

/// userAgent 首个 token 中 "/" 之后的部分才是实际运行版本
export function serverVersionFromUserAgent(userAgent: string | null | undefined): string | null {
    const firstToken = userAgent?.trim().split(/\s+/)[0];
    if (!firstToken) {
        return null;
    }
    const slashIndex = firstToken.indexOf("/");
    if (slashIndex < 0) {
        return null;
    }
    const version = firstToken.slice(slashIndex + 1);
    return version.length > 0 ? version : null;
}
