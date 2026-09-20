import * as fs from "node:fs";
import * as path from "node:path";
import { HookInvocation } from "../core/hooksConfig";
import { findOnPath } from "../core/codexResolver";
import { PathEnvironment, currentEnvironment } from "../core/paths";

export interface InvocationContext {
    isPackaged: boolean;
    appPath: string;
    resourcesPath: string;
    execPath: string;
    environment?: PathEnvironment;
}

function existingFile(candidate: string): string | null {
    try {
        return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
        return null;
    }
}

/// 独立 Hook 脚本随包发布, 打包后放在 resources 下便于 node 直接执行
export function hookScriptPath(context: InvocationContext): string | null {
    const candidates = context.isPackaged
        ? [path.join(context.resourcesPath, "hook", "record.js")]
        : [path.join(context.appPath, "hook", "record.js"), path.join(process.cwd(), "hook", "record.js")];
    for (const candidate of candidates) {
        const found = existingFile(candidate);
        if (found) {
            return found;
        }
    }
    return null;
}

/// Hook 子进程优先用 node 跑独立脚本, 启动成本远低于拉起整个应用
/// 没有 node 时回退到应用自身的 --hook-event 模式
export function hookInvocation(context: InvocationContext): HookInvocation {
    const environment = context.environment ?? currentEnvironment();
    const script = hookScriptPath(context);
    if (script) {
        const node = findOnPath("node", environment);
        if (node) {
            return { executable: node, args: [script] };
        }
    }
    if (context.isPackaged) {
        return { executable: context.execPath, args: [] };
    }
    return { executable: context.execPath, args: [context.appPath] };
}
