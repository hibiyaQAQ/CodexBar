import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { claudeDailyTokens, claudePlanLabel, loadClaudeState, readClaudeAccount, readClaudeQuotaCache, scanClaude } from "../core/claude";
import { makeSandbox, writeLines } from "./support";

function sessionPath(home: string): string {
    return path.join(home, ".claude", "projects", "demo", "session.jsonl");
}

const rows = [
    JSON.stringify({
        timestamp: "2026-09-20T01:00:00.000Z",
        type: "user",
        sessionId: "claude-session-1",
        cwd: "C:\\work\\demo",
        uuid: "u1",
        message: { content: "写点代码" }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:05.000Z",
        type: "assistant",
        sessionId: "claude-session-1",
        message: {
            id: "m1",
            model: "claude-opus-5",
            usage: {
                input_tokens: 800,
                output_tokens: 400,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 100
            },
            content: [{ type: "tool_use", id: "tool-1" }]
        }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:10.000Z",
        type: "user",
        sessionId: "claude-session-1",
        uuid: "u2",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:20.000Z",
        type: "system",
        subtype: "turn_duration",
        sessionId: "claude-session-1",
        uuid: "u3",
        durationMs: 45000
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:30.000Z",
        type: "assistant",
        sessionId: "claude-session-1",
        isSidechain: true,
        message: { id: "m2", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 } }
    })
];

test("Claude 会话统计 token, 轮次, 工具与子 Agent", () => {
    const sandbox = makeSandbox("claude");
    try {
        writeLines(sessionPath(sandbox.environment.home), rows);
        const state = scanClaude(loadClaudeState(sandbox.environment), {
            environment: sandbox.environment,
            now: new Date(2026, 8, 20, 12)
        });
        assert.equal(claudeDailyTokens(state)["2026-09-20"], 1215);
        const stats = state.stats["2026-09-20"];
        assert.ok(stats);
        // 工具结果不计入对话轮次
        assert.equal(stats.turns, 1);
        assert.equal(stats.tools, 1);
        assert.equal(stats.sessions, 1);
        assert.equal(stats.subagents, 1);
        assert.equal(state.longestTurnMsByDate["2026-09-20"], 45000);
        assert.equal(state.daily["2026-09-20"]?.cacheRead, 2000);
    } finally {
        sandbox.dispose();
    }
});

test("额度缓存解析出 5h 与 7d 两个窗口", () => {
    const sandbox = makeSandbox("claude");
    try {
        const cachePath = path.join(sandbox.environment.home, ".claude", "ccline", ".api_usage_cache.json");
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({
            cached_at: "2026-09-20T01:00:00.000Z",
            five_hour_utilization: 35,
            five_hour_resets_at: "2026-09-20T05:00:00.000Z",
            seven_day_utilization: 62,
            seven_day_resets_at: "2026-09-24T05:00:00.000Z"
        }), "utf8");
        const quota = readClaudeQuotaCache(sandbox.environment);
        assert.equal(quota?.windows.length, 2);
        assert.equal(quota?.windows[0]?.label, "5h");
        assert.equal(quota?.windows[0]?.remainingPercent, 65);
        assert.equal(quota?.windows[1]?.label, "7d");
        assert.equal(quota?.source, "ccline");
    } finally {
        sandbox.dispose();
    }
});

test("账户信息从 .claude.json 与凭据文件读取", () => {
    const sandbox = makeSandbox("claude");
    try {
        fs.writeFileSync(
            path.join(sandbox.environment.home, ".claude.json"),
            JSON.stringify({ oauthAccount: { emailAddress: "demo@example.com", organizationName: "Demo Org" } }),
            "utf8"
        );
        const credentials = path.join(sandbox.environment.home, ".claude", ".credentials.json");
        fs.mkdirSync(path.dirname(credentials), { recursive: true });
        fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { subscriptionType: "max20x" } }), "utf8");
        const account = readClaudeAccount(sandbox.environment);
        assert.equal(account?.email, "demo@example.com");
        assert.equal(account?.organization, "Demo Org");
        assert.equal(claudePlanLabel(account?.plan ?? null), "Max 20x");
    } finally {
        sandbox.dispose();
    }
});

test("没有任何 Claude 数据时返回 null", () => {
    const sandbox = makeSandbox("claude");
    try {
        assert.equal(readClaudeAccount(sandbox.environment), null);
        assert.equal(readClaudeQuotaCache(sandbox.environment), null);
    } finally {
        sandbox.dispose();
    }
});
