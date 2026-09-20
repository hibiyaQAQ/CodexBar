import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { CodexBarService } from "../main/service";
import { containsAllCodexBarHooks, readHooksConfig } from "../core/hooksConfig";
import { encodeHookEvent, eventFromPayload } from "../core/hookEvent";
import { dataRoot, dayKey, eventLogPath, storagePaths } from "../core/paths";
import { Sandbox, makeSandbox } from "./support";

const hookInvocation = { executable: "C:\\Program Files\\CodexBar\\CodexBar.exe", args: [] };

/// app-server 替身覆盖账户, 额度, 用量与 Hook 校验四类请求
function installFakeCodex(sandbox: Sandbox): void {
    const binary = path.join(sandbox.root, "bin");
    fs.mkdirSync(binary, { recursive: true });
    const target = path.join(binary, "codex.exe");
    fs.writeFileSync(target, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
    let message;
    try {
        message = JSON.parse(line);
    } catch (error) {
        return;
    }
    if (message.id === undefined) {
        return;
    }
    const reply = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    switch (message.method) {
        case "initialize":
            reply({ userAgent: "codex_cli_rs/0.151.0 (x86_64-pc-windows-msvc)" });
            break;
        case "account/read":
            reply({ account: { type: "chatgpt", email: "demo@example.com", planType: "pro" } });
            break;
        case "account/rateLimits/read":
            reply({
                rateLimits: {
                    limitId: "codex",
                    limitName: "codex",
                    planType: "pro",
                    primary: { usedPercent: 25, resetsAt: 1800000000, windowDurationMins: 300 },
                    secondary: { usedPercent: 60, resetsAt: 1800600000, windowDurationMins: 10080 }
                },
                rateLimitResetCredits: { availableCount: 0, credits: [] }
            });
            break;
        case "account/usage/read":
            reply({
                summary: {
                    lifetimeTokens: 4500000,
                    peakDailyTokens: 250000,
                    currentStreakDays: 7,
                    longestStreakDays: 21,
                    longestRunningTurnSec: 3600
                },
                dailyUsageBuckets: [{ startDate: "2026-09-19", tokens: 120000 }]
            });
            break;
        case "config/read":
            reply({ config: { features: { hooks: true }, hooks: { state: {} } } });
            break;
        case "hooks/list":
            reply({
                data: [{
                    cwd: "C:\\\\work",
                    hooks: [{
                        eventName: "sessionStart",
                        command: "\\"C:\\\\Program Files\\\\CodexBar\\\\CodexBar.exe\\" --hook-event",
                        enabled: true,
                        sourcePath: "hooks.json",
                        trustStatus: "trusted",
                        key: "k1",
                        currentHash: "h1"
                    }],
                    warnings: [],
                    errors: []
                }]
            });
            break;
        case "config/batchWrite":
            reply({});
            break;
        default:
            process.stdout.write(JSON.stringify({ id: message.id, error: { message: "Method not found" } }) + "\\n");
    }
});
`, { encoding: "utf8", mode: 0o755 });
    // 替身脚本用 node 执行, PATH 里要保留真实解释器目录
    sandbox.environment.env.PATH = [binary, process.env.PATH ?? ""].join(path.delimiter);
}

function makeService(sandbox: Sandbox): CodexBarService {
    process.env.CODEXBAR_DATA_DIR = dataRoot(sandbox.environment);
    return new CodexBarService({ environment: sandbox.environment, hookInvocation, clientVersion: "1.0.0" });
}

test("刷新一轮得到账户, 额度, 用量与热力图", async () => {
    const sandbox = makeSandbox("service");
    try {
        installFakeCodex(sandbox);
        const service = makeService(sandbox);
        const snapshot = await service.refresh("test");
        service.dispose();

        assert.equal(snapshot.codex.state, "ok");
        assert.equal(snapshot.codex.accountLabel, "demo@example.com");
        assert.equal(snapshot.codex.planLabel, "pro");
        assert.equal(snapshot.codex.version, "0.151.0");
        assert.equal(snapshot.codex.limits.length, 1);
        assert.equal(snapshot.codex.limits[0]?.windows[0]?.label, "5h");
        assert.equal(snapshot.codex.limits[0]?.windows[0]?.remainingPercent, 75);
        assert.equal(snapshot.codex.limits[0]?.windows[1]?.label, "7d");
        assert.equal(snapshot.codex.lifetimeTokens, 4_500_000);
        assert.equal(snapshot.codex.peakDailyTokens, 250_000);
        assert.equal(snapshot.codex.currentStreakDays, 7);
        assert.equal(snapshot.codex.longestRunningTurnSec, 3600);
        assert.equal(snapshot.codex.heatmap.length, snapshot.settings.heatmapWeeks * 7);
        assert.equal(snapshot.codex.estimates.length, 2);
        assert.equal(snapshot.hook.enabled, false);
        assert.equal(snapshot.hook.supportsHooks, true);
    } finally {
        delete process.env.CODEXBAR_DATA_DIR;
        sandbox.dispose();
    }
});

test("找不到 codex 时仍然给出本机统计与提示", async () => {
    const sandbox = makeSandbox("service");
    try {
        const service = makeService(sandbox);
        const snapshot = await service.refresh("test");
        service.dispose();
        assert.equal(snapshot.codex.state, "executableNotFound");
        assert.ok(snapshot.codex.message?.includes("codex"));
        assert.ok(snapshot.codex.localStats);
        assert.equal(snapshot.codex.heatmap.length > 0, true);
    } finally {
        delete process.env.CODEXBAR_DATA_DIR;
        sandbox.dispose();
    }
});

test("开启 Hook 写入配置并在校验后标记生效", async () => {
    const sandbox = makeSandbox("service");
    try {
        installFakeCodex(sandbox);
        const service = makeService(sandbox);
        await service.refresh("test");
        const result = await service.setHookEnabled(true);
        assert.equal(result.ok, true);
        const config = readHooksConfig(sandbox.environment);
        assert.equal(containsAllCodexBarHooks(config, hookInvocation), true);

        const today = dayKey(new Date());
        const record = eventFromPayload({
            hook_event_name: "UserPromptSubmit",
            session_id: "s1",
            turn_id: "t1",
            cwd: "C:\\work\\demo"
        });
        assert.ok(record);
        fs.mkdirSync(storagePaths(sandbox.environment).eventsDirectory, { recursive: true });
        fs.writeFileSync(eventLogPath(today, sandbox.environment), encodeHookEvent(record), "utf8");

        const snapshot = await service.refresh("test");
        service.dispose();
        assert.equal(snapshot.hook.enabled, true);
        assert.equal(snapshot.hook.complete, true);
        assert.equal(snapshot.hook.verified, true);
        assert.equal(snapshot.hook.today?.turnCount, 1);
        assert.equal(snapshot.hook.totals.turns, 1);
        // Hook 开启后今天的方格可见
        assert.equal(snapshot.codex.heatmap.some(day => day?.startDate === today), true);
    } finally {
        delete process.env.CODEXBAR_DATA_DIR;
        sandbox.dispose();
    }
});

test("关闭 Hook 只移除自己的 handler", async () => {
    const sandbox = makeSandbox("service");
    try {
        installFakeCodex(sandbox);
        const service = makeService(sandbox);
        await service.refresh("test");
        await service.setHookEnabled(true);
        await service.setHookEnabled(false);
        service.dispose();
        const config = readHooksConfig(sandbox.environment);
        assert.equal(containsAllCodexBarHooks(config, hookInvocation), false);
        assert.equal(service.currentSettings().hookEnabled, false);
    } finally {
        delete process.env.CODEXBAR_DATA_DIR;
        sandbox.dispose();
    }
});

test("已开启但配置缺项时自动补齐", async () => {
    const sandbox = makeSandbox("service");
    try {
        installFakeCodex(sandbox);
        const service = makeService(sandbox);
        await service.refresh("test");
        await service.setHookEnabled(true);

        // 模拟用户手工删掉了其中一个事件
        const config = readHooksConfig(sandbox.environment) as { hooks: Record<string, unknown> };
        delete config.hooks.PostToolUse;
        const target = path.join(sandbox.environment.home, ".codex", "hooks.json");
        fs.writeFileSync(target, JSON.stringify(config), "utf8");
        assert.equal(containsAllCodexBarHooks(readHooksConfig(sandbox.environment), hookInvocation), false);

        const snapshot = await service.refresh("test");
        service.dispose();
        assert.equal(snapshot.hook.complete, true);
        assert.equal(containsAllCodexBarHooks(readHooksConfig(sandbox.environment), hookInvocation), true);
    } finally {
        delete process.env.CODEXBAR_DATA_DIR;
        sandbox.dispose();
    }
});
