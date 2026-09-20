import { strict as assert } from "node:assert";
import { test } from "node:test";
import { containsAllCodexBarHooks, containsAnyCodexBarHook, hookCommandText, installCodexBarHooks, isCodexBarCommand, readHooksConfig, removeCodexBarHooks, writeHooksConfig } from "../core/hooksConfig";
import { hookEventNames } from "../core/hookEvent";
import { makeSandbox } from "./support";

const invocation = { executable: "C:\\Program Files\\CodexBar\\CodexBar.exe", args: [] };
const nodeInvocation = { executable: "C:\\nodejs\\node.exe", args: ["C:\\app\\hook\\record.js"] };

test("命令文本对带空格的路径加引号", () => {
    assert.equal(hookCommandText(invocation), '"C:\\Program Files\\CodexBar\\CodexBar.exe" --hook-event');
    assert.equal(hookCommandText(nodeInvocation), 'C:\\nodejs\\node.exe C:\\app\\hook\\record.js --hook-event');
});

test("识别自己的 handler 时要求路径与参数同时命中", () => {
    assert.equal(isCodexBarCommand(hookCommandText(invocation), invocation), true);
    assert.equal(isCodexBarCommand('"C:\\Program Files\\CodexBar\\CodexBar.exe" --other', invocation), false);
    assert.equal(isCodexBarCommand("other.exe --hook-event", invocation), false);
    // 大小写与斜杠方向不同也要认出同一路径
    assert.equal(isCodexBarCommand('"c:/program files/codexbar/codexbar.exe" --hook-event', invocation), true);
});

test("写入时保留用户与其他应用的 handler", () => {
    const original = {
        hooks: {
            SessionStart: [
                { hooks: [{ type: "command", command: "my-own-script.cmd", timeout: 10 }] }
            ],
            PostToolUse: [
                { matcher: "shell", hooks: [{ type: "command", command: "other-app.exe --watch" }] }
            ]
        },
        unrelated: { keep: true }
    };
    const { config, repaired } = installCodexBarHooks(original, invocation);
    assert.equal(repaired.length, hookEventNames.length);
    assert.equal(containsAllCodexBarHooks(config, invocation), true);
    const sessionGroups = (config.hooks as Record<string, unknown[]>).SessionStart ?? [];
    assert.equal(sessionGroups.length, 2);
    assert.equal(JSON.stringify(sessionGroups[0]).includes("my-own-script.cmd"), true);
    const postGroups = (config.hooks as Record<string, unknown[]>).PostToolUse ?? [];
    assert.equal(JSON.stringify(postGroups[0]).includes("other-app.exe"), true);
    assert.equal(config.unrelated !== undefined, true);
});

test("重复写入保持幂等", () => {
    const first = installCodexBarHooks({}, invocation);
    const second = installCodexBarHooks(first.config, invocation);
    assert.deepEqual(second.repaired, []);
    assert.deepEqual(second.config, first.config);
});

test("超时按事件写入, 终态事件是 3 秒", () => {
    const { config } = installCodexBarHooks({}, invocation);
    const hooks = config.hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
    assert.equal(hooks.SessionEnd?.[0]?.hooks[0]?.timeout, 3);
    assert.equal(hooks.Interrupt?.[0]?.hooks[0]?.timeout, 3);
    assert.equal(hooks.PostToolUse?.[0]?.hooks[0]?.timeout, 5);
});

test("移除只删除自己的 handler", () => {
    const original = {
        hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "keep-me.exe" }] }]
        }
    };
    const installed = installCodexBarHooks(original, invocation).config;
    const removed = removeCodexBarHooks(installed, invocation);
    assert.equal(containsAnyCodexBarHook(removed, invocation), false);
    const groups = (removed.hooks as Record<string, unknown[]>).SessionStart ?? [];
    assert.equal(groups.length, 1);
    assert.equal(JSON.stringify(groups[0]).includes("keep-me.exe"), true);
});

test("配置读写落到 Codex 目录下的 hooks.json", () => {
    const sandbox = makeSandbox("hooks");
    try {
        assert.deepEqual(readHooksConfig(sandbox.environment), {});
        const { config } = installCodexBarHooks({}, invocation);
        writeHooksConfig(config, sandbox.environment);
        const loaded = readHooksConfig(sandbox.environment);
        assert.equal(containsAllCodexBarHooks(loaded, invocation), true);
    } finally {
        sandbox.dispose();
    }
});

test("损坏的 hooks.json 抛错而不是当成未安装", () => {
    const sandbox = makeSandbox("hooks");
    try {
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        const target = path.join(sandbox.environment.home, ".codex", "hooks.json");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "{ broken", "utf8");
        assert.throws(() => readHooksConfig(sandbox.environment));
    } finally {
        sandbox.dispose();
    }
});
