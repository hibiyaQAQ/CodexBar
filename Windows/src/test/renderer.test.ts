import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { buildHeatmap } from "../core/heatmap";
import { emptySnapshot } from "../core/snapshot";
import { defaultSettings } from "../core/settings";
import { emptyMetrics } from "../core/workflow";
import { AppSnapshot } from "../core/snapshot";

function sampleSnapshot(): AppSnapshot {
    const snapshot = emptySnapshot({ ...defaultSettings, hookEnabled: true });
    const today = new Date(2026, 8, 20);
    const metrics = {
        ...emptyMetrics("2026-09-20"),
        sessionCount: 3,
        turnCount: 12,
        toolCallCount: 40,
        subagentCount: 2,
        permissionRequestCount: 1,
        longestTurnMs: 720_000,
        modelCounts: { "gpt-5.6": 12 },
        mostUsedModel: "gpt-5.6"
    };
    const heatmap = buildHeatmap({
        usage: null,
        workflowMetrics: [metrics],
        showsWorkflow: true,
        columnCount: 30,
        today,
        localTokensByDate: { "2026-09-19": 120_000, "2026-09-20": 45_000 }
    });
    snapshot.generatedAt = today.getTime();
    snapshot.refreshing = false;
    snapshot.codex = {
        ...snapshot.codex,
        state: "ok",
        accountLabel: "demo@example.com",
        planLabel: "pro",
        version: "0.151.0",
        executableSource: "global",
        limits: [{
            limitId: "codex",
            title: "Codex",
            windows: [
                {
                    kind: "primary",
                    label: "5h",
                    windowDurationMins: 300,
                    usedPercent: 25,
                    remainingPercent: 75,
                    resetsAt: Math.trunc(today.getTime() / 1000) + 3600,
                    hasData: true
                },
                {
                    kind: "secondary",
                    label: "7d",
                    windowDurationMins: 10080,
                    usedPercent: 60,
                    remainingPercent: 40,
                    resetsAt: Math.trunc(today.getTime() / 1000) + 86_400,
                    hasData: true
                }
            ]
        }],
        lifetimeTokens: 4_500_000,
        peakDailyTokens: 250_000,
        currentStreakDays: 7,
        longestStreakDays: 21,
        longestRunningTurnSec: 3600,
        heatmap,
        heatmapMaximum: 120_000,
        estimates: [{
            kind: "primary",
            label: "5h",
            usedPercent: 25,
            remainingPercent: 75,
            resetsAt: null,
            totalTokens: 1_000_000,
            remainingTokens: 750_000,
            usedTokens: 250_000,
            confidence: "high",
            sampleCount: 9,
            referenceTotalTokens: 980_000
        }]
    };
    snapshot.hook = {
        ...snapshot.hook,
        enabled: true,
        installed: true,
        complete: true,
        verified: true,
        supportsHooks: true,
        today: metrics,
        recent: [metrics],
        totals: { sessions: 30, turns: 120, tools: 400, subagents: 20, permissions: 10, compactions: 5, longestTurnMs: 900_000 }
    };
    snapshot.claude = {
        ...snapshot.claude,
        available: true,
        account: { email: "demo@example.com", organization: "Demo Org", plan: "max20x", source: null },
        planLabel: "Max 20x",
        quota: {
            observedAt: Math.trunc(today.getTime() / 1000),
            source: "ccline",
            windows: [{ label: "5h", usedPercent: 35, remainingPercent: 65, resetsAt: null }]
        },
        stats: {
            lifetimeTokens: 900_000,
            peakDailyTokens: 90_000,
            peakDate: "2026-09-18",
            currentStreakDays: 4,
            longestStreakDays: 9,
            activeDays: 30
        },
        today: { sessions: 2, turns: 8, tools: 15, subagents: 1, compactions: 0 },
        longestTurnMs: 300_000,
        heatmap,
        heatmapMaximum: 120_000,
        scanComplete: true
    };
    return snapshot;
}

async function mountPanel(snapshot: AppSnapshot): Promise<JSDOM> {
    const rendererDirectory = path.join(__dirname, "..", "renderer");
    const html = fs.readFileSync(path.join(rendererDirectory, "index.html"), "utf8");
    const script = fs.readFileSync(path.join(rendererDirectory, "renderer.js"), "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    const api = {
        getSnapshot: () => Promise.resolve(snapshot),
        refresh: () => Promise.resolve(snapshot),
        updateSettings: () => Promise.resolve(snapshot),
        setHookEnabled: () => Promise.resolve({ ok: true, message: null }),
        openDataFolder: () => Promise.resolve(),
        quit: () => Promise.resolve(),
        onSnapshot: () => undefined
    };
    (dom.window as unknown as { codexbar: unknown }).codexbar = api;
    dom.window.eval(script);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    // 首个快照通过 Promise 回填, 等一轮微任务
    await new Promise(resolve => setTimeout(resolve, 10));
    return dom;
}

test("主面板渲染账户, 额度, 估算与统计", async () => {
    const dom = await mountPanel(sampleSnapshot());
    const text = dom.window.document.getElementById("tab-codex")?.textContent ?? "";
    assert.ok(text.includes("demo@example.com"));
    assert.ok(text.includes("pro"));
    assert.ok(text.includes("5h"));
    assert.ok(text.includes("剩余 75%"));
    assert.ok(text.includes("7d"));
    assert.ok(text.includes("剩余 40%"));
    assert.ok(text.includes("4.50M"));
    assert.ok(text.includes("250.0K"));
    assert.ok(text.includes("7 天"));
    assert.ok(text.includes("1h 0m"));
    assert.ok(text.includes("1.00M"));
    assert.ok(text.includes("样本充足"));
    assert.equal(dom.window.document.getElementById("status-text")?.textContent, "Codex 已连接 · Hook 已启用");
});

test("热力图渲染 30 列并支持点击查看当日明细", async () => {
    const dom = await mountPanel(sampleSnapshot());
    const document = dom.window.document;
    const columns = document.querySelectorAll("#tab-codex .heat-column");
    assert.equal(columns.length, 30);
    const cells = document.querySelectorAll("#tab-codex .heat-cell:not(.empty)");
    assert.ok(cells.length > 200);
    const target = Array.from(cells).find(cell => (cell as HTMLElement).title.startsWith("2026-09-20"));
    assert.ok(target);
    (target as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const detail = document.querySelector("#tab-codex .detail")?.textContent ?? "";
    assert.ok(detail.includes("2026-09-20 明细"));
    assert.ok(detail.includes("会话"));
    assert.ok(detail.includes("12"));
    assert.ok(detail.includes("子 Agent"));
    assert.ok(detail.includes("gpt-5.6"));
});

test("Claude 页展示账户, 额度与统计", async () => {
    const dom = await mountPanel(sampleSnapshot());
    const text = dom.window.document.getElementById("tab-claude")?.textContent ?? "";
    assert.ok(text.includes("Max 20x"));
    assert.ok(text.includes("Demo Org"));
    assert.ok(text.includes("剩余 65%"));
    assert.ok(text.includes("900.0K"));
    assert.ok(text.includes("5m 0s"));
});

test("未登录时给出提示并保留本机统计", async () => {
    const snapshot = sampleSnapshot();
    snapshot.codex = {
        ...snapshot.codex,
        state: "notLoggedIn",
        message: "Codex 尚未登录, 请先运行 codex login",
        limits: [],
        accountLabel: null,
        planLabel: null
    };
    const dom = await mountPanel(snapshot);
    const text = dom.window.document.getElementById("tab-codex")?.textContent ?? "";
    assert.ok(text.includes("Codex 尚未登录"));
    assert.ok(text.includes("暂无额度数据"));
    assert.equal(dom.window.document.getElementById("status-text")?.textContent, "Codex 未登录");
});

test("设置页列出全部开关", async () => {
    const dom = await mountPanel(sampleSnapshot());
    const text = dom.window.document.getElementById("tab-settings")?.textContent ?? "";
    for (const label of ["刷新间隔", "热力图周数", "codex 路径", "显示 Claude", "扫描本机会话", "开机自动启动", "打开数据目录"]) {
        assert.ok(text.includes(label), `缺少设置项 ${label}`);
    }
});
