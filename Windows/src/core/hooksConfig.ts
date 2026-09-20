import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDirectory, readTextIfPresent, writeAtomic } from "./files";
import { HookEventName, hookArgument, hookEventNames, hookTimeoutSeconds } from "./hookEvent";
import { PathEnvironment, codexHome, currentEnvironment } from "./paths";

type JSONObject = Record<string, unknown>;

const hooksKey = "hooks";
const typeKey = "type";
const commandKey = "command";
const timeoutKey = "timeout";
const commandType = "command";

export function hooksConfigPath(environment: PathEnvironment = currentEnvironment()): string {
    return path.join(codexHome(environment), "hooks.json");
}

/// Windows 下命令行用双引号包裹, 内部双引号按 cmd 规则转义
export function quoteCommand(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

export interface HookInvocation {
    executable: string;
    args: string[];
}

export function hookCommandText(invocation: HookInvocation): string {
    const parts = [invocation.executable, ...invocation.args, hookArgument];
    return parts.map(part => (/[\s"]/.test(part) ? quoteCommand(part) : part)).join(" ");
}

/// 管理项身份只由可执行路径与 --hook-event 确定, 不看 type 字段
export function isCodexBarCommand(command: string, invocation: HookInvocation): boolean {
    const normalized = command.replace(/\//g, "\\").toLowerCase();
    const executable = invocation.executable.replace(/\//g, "\\").toLowerCase();
    const mentionsExecutable = normalized.includes(executable);
    const mentionsArguments = invocation.args.every(arg => normalized.includes(arg.replace(/\//g, "\\").toLowerCase()));
    return mentionsExecutable && mentionsArguments && normalized.includes(hookArgument);
}

function handlersOf(group: unknown): unknown[] | null {
    if (!group || typeof group !== "object") {
        return null;
    }
    const handlers = (group as JSONObject)[hooksKey];
    return Array.isArray(handlers) ? handlers : null;
}

function isCodexBarHandler(handler: unknown, invocation: HookInvocation): boolean {
    if (!handler || typeof handler !== "object") {
        return false;
    }
    const command = (handler as JSONObject)[commandKey];
    return typeof command === "string" && isCodexBarCommand(command, invocation);
}

function codexBarHandler(event: HookEventName, invocation: HookInvocation): JSONObject {
    return {
        [typeKey]: commandType,
        [commandKey]: hookCommandText(invocation),
        [timeoutKey]: hookTimeoutSeconds(event)
    };
}

function groupWithoutCodexBarHandlers(group: unknown, invocation: HookInvocation): unknown | null {
    const handlers = handlersOf(group);
    if (!handlers || !group || typeof group !== "object") {
        return group;
    }
    const filtered = handlers.filter(handler => !isCodexBarHandler(handler, invocation));
    if (filtered.length === 0) {
        return null;
    }
    return { ...(group as JSONObject), [hooksKey]: filtered };
}

/// 每个事件只保留一个标准独立 group, 不和用户已有 group 混写
function isCanonicalEvent(groups: unknown[], event: HookEventName, invocation: HookInvocation): boolean {
    const managedCount = groups.reduce((count: number, group) => {
        const handlers = handlersOf(group) ?? [];
        return count + handlers.filter(handler => isCodexBarHandler(handler, invocation)).length;
    }, 0);
    if (managedCount !== 1) {
        return false;
    }
    return groups.some(group => {
        const handlers = handlersOf(group);
        if (!handlers || handlers.length !== 1) {
            return false;
        }
        const handler = handlers[0];
        if (!isCodexBarHandler(handler, invocation)) {
            return false;
        }
        const timeout = (handler as JSONObject)[timeoutKey];
        return timeout === hookTimeoutSeconds(event);
    });
}

export function readHooksConfig(environment: PathEnvironment = currentEnvironment()): JSONObject {
    const text = readTextIfPresent(hooksConfigPath(environment));
    if (text === null) {
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JSONObject) : {};
    } catch (error) {
        // 读取失败不提供 Hook 装没装的信息, 交给调用方保留上次结论
        throw new Error(`hooks.json 解析失败: ${String(error)}`);
    }
}

export function containsAnyCodexBarHook(config: JSONObject, invocation: HookInvocation): boolean {
    const hooks = config[hooksKey];
    if (!hooks || typeof hooks !== "object") {
        return false;
    }
    return hookEventNames.some(event => {
        const groups = (hooks as JSONObject)[event];
        return Array.isArray(groups) && groups.some(group => (handlersOf(group) ?? []).some(handler => isCodexBarHandler(handler, invocation)));
    });
}

export function containsAllCodexBarHooks(config: JSONObject, invocation: HookInvocation): boolean {
    const hooks = config[hooksKey];
    if (!hooks || typeof hooks !== "object") {
        return false;
    }
    return hookEventNames.every(event => {
        const groups = (hooks as JSONObject)[event];
        return Array.isArray(groups) && isCanonicalEvent(groups, event, invocation);
    });
}

/// 写入时保留用户与其他应用已有的 handler, 只补齐或修正自己的那一条
export function installCodexBarHooks(config: JSONObject, invocation: HookInvocation): { config: JSONObject; repaired: HookEventName[] } {
    const hooks: JSONObject = { ...((config[hooksKey] as JSONObject) ?? {}) };
    const repaired: HookEventName[] = [];
    for (const event of hookEventNames) {
        const existing = hooks[event];
        const groups = Array.isArray(existing) ? [...existing] : [];
        if (isCanonicalEvent(groups, event, invocation)) {
            continue;
        }
        const cleaned = groups
            .map(group => groupWithoutCodexBarHandlers(group, invocation))
            .filter(group => group !== null);
        cleaned.push({ [hooksKey]: [codexBarHandler(event, invocation)] });
        hooks[event] = cleaned;
        repaired.push(event);
    }
    return { config: { ...config, [hooksKey]: hooks }, repaired };
}

export function removeCodexBarHooks(config: JSONObject, invocation: HookInvocation): JSONObject {
    const hooks = config[hooksKey];
    if (!hooks || typeof hooks !== "object") {
        return config;
    }
    const result: JSONObject = {};
    for (const [event, groups] of Object.entries(hooks as JSONObject)) {
        if (!Array.isArray(groups)) {
            result[event] = groups;
            continue;
        }
        const filtered = groups
            .map(group => groupWithoutCodexBarHandlers(group, invocation))
            .filter(group => group !== null);
        if (filtered.length > 0) {
            result[event] = filtered;
        }
    }
    const next = { ...config };
    if (Object.keys(result).length > 0) {
        next[hooksKey] = result;
    } else {
        delete next[hooksKey];
    }
    return next;
}

export function writeHooksConfig(config: JSONObject, environment: PathEnvironment = currentEnvironment()): void {
    const target = hooksConfigPath(environment);
    ensureDirectory(path.dirname(target));
    writeAtomic(target, `${JSON.stringify(config, null, 2)}\n`);
}

export function hooksConfigExists(environment: PathEnvironment = currentEnvironment()): boolean {
    try {
        return fs.statSync(hooksConfigPath(environment)).isFile();
    } catch {
        return false;
    }
}
