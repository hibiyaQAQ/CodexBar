import { strict as assert } from "node:assert";
import * as path from "node:path";
import { test } from "node:test";
import { dailyTokensMap, loadRolloutState, longestTurnMs, saveRolloutState, scanRollouts, tokensInRange } from "../core/rollouts";
import { appendLines, makeSandbox, writeLines } from "./support";

function rolloutPath(home: string): string {
    return path.join(home, ".codex", "sessions", "2026", "09", "20", "rollout-demo.jsonl");
}

const baseRows = [
    JSON.stringify({
        timestamp: "2026-09-20T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1", cwd: "C:\\work\\demo" }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.6", turn_id: "turn-1", auth_mode: "chatgpt" }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:00:02.000Z",
        type: "event_msg",
        payload: {
            type: "token_count",
            info: {
                total_token_usage: {
                    input_tokens: 1000,
                    output_tokens: 200,
                    cached_input_tokens: 500,
                    total_tokens: 1700
                }
            },
            rate_limits: {
                primary: { used_percent: 12.5, resets_at: "2026-09-20T06:00:00.000Z", window_minutes: 300 },
                secondary: { used_percent: 40, resets_at: "2026-09-25T06:00:00.000Z", window_minutes: 10080 }
            }
        }
    }),
    JSON.stringify({
        timestamp: "2026-09-20T01:05:00.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 125000 }
    })
];

test("rollout 扫描累计当日 token 并记录额度观测", () => {
    const sandbox = makeSandbox("rollouts");
    try {
        writeLines(rolloutPath(sandbox.environment.home), baseRows);
        const state = scanRollouts(loadRolloutState(sandbox.environment), {
            environment: sandbox.environment,
            now: new Date(2026, 8, 20, 12)
        });
        const daily = dailyTokensMap(state);
        // 计费 token 只计入输入与输出
        assert.equal(daily["2026-09-20"], 1200);
        assert.equal(longestTurnMs(state), 125000);
        assert.equal(state.quota?.windows.length, 2);
        assert.equal(state.quota?.windows[0]?.usedPercent, 12.5);
        assert.equal(state.quota?.windows[0]?.windowMinutes, 300);
        assert.equal(state.tokenEvents.length, 1);
        assert.equal(state.scanComplete, true);
    } finally {
        sandbox.dispose();
    }
});

test("累计计数只累加增量, 不重复计入历史总量", () => {
    const sandbox = makeSandbox("rollouts");
    try {
        const target = rolloutPath(sandbox.environment.home);
        writeLines(target, baseRows);
        const now = new Date(2026, 8, 20, 12);
        let state = scanRollouts(loadRolloutState(sandbox.environment), { environment: sandbox.environment, now });
        saveRolloutState(state, sandbox.environment);
        appendLines(target, [
            JSON.stringify({
                timestamp: "2026-09-20T02:00:00.000Z",
                type: "event_msg",
                payload: {
                    type: "token_count",
                    info: {
                        total_token_usage: {
                            input_tokens: 1500,
                            output_tokens: 300,
                            cached_input_tokens: 900,
                            total_tokens: 2700
                        }
                    }
                }
            })
        ]);
        state = scanRollouts(loadRolloutState(sandbox.environment), { environment: sandbox.environment, now });
        assert.equal(dailyTokensMap(state)["2026-09-20"], 1800);
        assert.equal(state.tokenEvents.length, 2);
    } finally {
        sandbox.dispose();
    }
});

test("按时间范围求和只统计窗口内的 token", () => {
    const sandbox = makeSandbox("rollouts");
    try {
        writeLines(rolloutPath(sandbox.environment.home), baseRows);
        const state = scanRollouts(loadRolloutState(sandbox.environment), {
            environment: sandbox.environment,
            now: new Date(2026, 8, 20, 12)
        });
        const at = Date.UTC(2026, 8, 20, 1, 0, 2);
        assert.equal(tokensInRange(state, at - 1000, at + 1000), 1200);
        assert.equal(tokensInRange(state, at + 2000, at + 5000), 0);
    } finally {
        sandbox.dispose();
    }
});
