import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { test } from "node:test";
import { encodeHookEvent, eventFromPayload } from "../core/hookEvent";
import { eventLogPath, storagePaths } from "../core/paths";
import { currentAggregationSchema, refreshWorkflow } from "../core/workflow";
import { Sandbox, makeSandbox } from "./support";

interface EventInput {
    event: string;
    at: string;
    session?: string;
    turn?: string;
    tool?: string;
    model?: string;
    cwd?: string;
    agent?: string;
}

function writeEvents(sandbox: Sandbox, date: string, events: EventInput[], append = false): void {
    const target = eventLogPath(date, sandbox.environment);
    const lines = events.map(input => {
        const record = eventFromPayload({
            hook_event_name: input.event,
            timestamp: `${date} ${input.at}`,
            session_id: input.session,
            turn_id: input.turn,
            tool_name: input.tool,
            model: input.model,
            agent_id: input.agent,
            cwd: input.cwd ?? "C:\\work\\demo"
        });
        assert.ok(record);
        return encodeHookEvent(record);
    }).join("");
    fs.mkdirSync(storagePaths(sandbox.environment).eventsDirectory, { recursive: true });
    if (append) {
        fs.appendFileSync(target, lines, "utf8");
    } else {
        fs.writeFileSync(target, lines, "utf8");
    }
}

test("聚合按事件类型统计并对会话与轮次去重", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2026-09-20";
        writeEvents(sandbox, date, [
            { event: "SessionStart", at: "09:00:00.000", session: "s1" },
            { event: "UserPromptSubmit", at: "09:00:01.000", session: "s1", turn: "t1", model: "gpt-5.6" },
            { event: "PreToolUse", at: "09:00:02.000", session: "s1", turn: "t1", tool: "shell" },
            { event: "PostToolUse", at: "09:00:03.000", session: "s1", turn: "t1", tool: "shell" },
            { event: "PermissionRequest", at: "09:00:04.000", session: "s1", turn: "t1" },
            { event: "SubagentStart", at: "09:00:05.000", session: "s1", turn: "t1", agent: "a1" },
            { event: "SubagentStop", at: "09:00:06.000", session: "s1", turn: "t1", agent: "a1" },
            { event: "Stop", at: "09:02:06.000", session: "s1", turn: "t1" },
            { event: "UserPromptSubmit", at: "09:03:00.000", session: "s1", turn: "t2" },
            { event: "Stop", at: "09:03:30.000", session: "s1", turn: "t2" },
            { event: "SessionEnd", at: "09:05:00.000", session: "s2" }
        ]);
        const result = refreshWorkflow({ environment: sandbox.environment, now: new Date(2026, 8, 20, 12) });
        const metrics = result.metrics.find(entry => entry.startDate === date);
        assert.ok(metrics);
        // SessionEnd 的 s2 不构成当日活跃会话
        assert.equal(metrics.sessionCount, 1);
        assert.equal(metrics.turnCount, 2);
        assert.equal(metrics.toolCallCount, 1);
        assert.equal(metrics.permissionRequestCount, 1);
        assert.equal(metrics.subagentCount, 1);
        assert.equal(metrics.eventCount, 11);
        assert.equal(metrics.mostUsedModel, "gpt-5.6");
        // 最长任务取同一 turn 的开始与终态差值
        assert.equal(metrics.longestTurnMs, 125_000);
        assert.deepEqual(Object.keys(metrics.projectCounts), ["demo"]);
    } finally {
        sandbox.dispose();
    }
});

test("增量追加只读取新行并保持去重", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2026-09-20";
        const now = new Date(2026, 8, 20, 12);
        writeEvents(sandbox, date, [
            { event: "SessionStart", at: "09:00:00.000", session: "s1" },
            { event: "UserPromptSubmit", at: "09:00:01.000", session: "s1", turn: "t1" }
        ]);
        const first = refreshWorkflow({ environment: sandbox.environment, now });
        assert.equal(first.metrics[0]?.turnCount, 1);
        writeEvents(sandbox, date, [
            { event: "PostToolUse", at: "09:01:00.000", session: "s1", turn: "t1", tool: "shell" },
            { event: "Stop", at: "09:01:30.000", session: "s1", turn: "t1" }
        ], true);
        const second = refreshWorkflow({ environment: sandbox.environment, now });
        const metrics = second.metrics[0];
        assert.ok(metrics);
        assert.equal(metrics.sessionCount, 1);
        assert.equal(metrics.turnCount, 1);
        assert.equal(metrics.toolCallCount, 1);
        assert.equal(metrics.eventCount, 4);
        assert.equal(metrics.longestTurnMs, 89_000);
        assert.deepEqual(second.rebuiltDates, []);
    } finally {
        sandbox.dispose();
    }
});

test("文件被重写时整日重建而不是继续追加", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2026-09-20";
        const now = new Date(2026, 8, 20, 12);
        writeEvents(sandbox, date, [
            { event: "SessionStart", at: "09:00:00.000", session: "s1" },
            { event: "UserPromptSubmit", at: "09:00:01.000", session: "s1", turn: "t1" },
            { event: "Stop", at: "09:00:09.000", session: "s1", turn: "t1" }
        ]);
        refreshWorkflow({ environment: sandbox.environment, now });
        writeEvents(sandbox, date, [
            { event: "SessionStart", at: "10:00:00.000", session: "s9" }
        ]);
        const result = refreshWorkflow({ environment: sandbox.environment, now });
        assert.deepEqual(result.rebuiltDates, [date]);
        assert.equal(result.metrics[0]?.eventCount, 1);
        assert.equal(result.metrics[0]?.sessionCount, 1);
    } finally {
        sandbox.dispose();
    }
});

test("聚合算法版本变化时从原始事件完整重建", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2026-09-20";
        const now = new Date(2026, 8, 20, 12);
        writeEvents(sandbox, date, [{ event: "SessionStart", at: "09:00:00.000", session: "s1" }]);
        refreshWorkflow({ environment: sandbox.environment, now });
        const maintenancePath = storagePaths(sandbox.environment).maintenancePath;
        const state = JSON.parse(fs.readFileSync(maintenancePath, "utf8"));
        assert.equal(state.aggregationSchema, currentAggregationSchema);
        state.aggregationSchema = currentAggregationSchema - 1;
        fs.writeFileSync(maintenancePath, JSON.stringify(state), "utf8");
        const result = refreshWorkflow({ environment: sandbox.environment, now });
        assert.deepEqual(result.rebuiltDates, [date]);
        assert.equal(result.metrics[0]?.eventCount, 1);
    } finally {
        sandbox.dispose();
    }
});

test("超过标识保留期的日期只保留去重计数", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2026-09-10";
        writeEvents(sandbox, date, [
            { event: "SessionStart", at: "09:00:00.000", session: "s1" },
            { event: "UserPromptSubmit", at: "09:00:01.000", session: "s1", turn: "t1" }
        ]);
        refreshWorkflow({ environment: sandbox.environment, now: new Date(2026, 8, 20, 12) });
        const daily = fs.readFileSync(storagePaths(sandbox.environment).dailyPath, "utf8").trim();
        const aggregate = JSON.parse(daily);
        assert.equal(aggregate.sessionIds, null);
        assert.equal(aggregate.turnIds, null);
        assert.equal(aggregate.sessionCount, 1);
        assert.equal(aggregate.turnCount, 1);
    } finally {
        sandbox.dispose();
    }
});

test("超过保留期的原始事件与聚合都被清理", () => {
    const sandbox = makeSandbox("workflow");
    try {
        const date = "2025-01-01";
        writeEvents(sandbox, date, [{ event: "SessionStart", at: "09:00:00.000", session: "s1" }]);
        const result = refreshWorkflow({ environment: sandbox.environment, now: new Date(2026, 8, 20, 12) });
        assert.equal(result.metrics.length, 0);
        assert.equal(fs.existsSync(eventLogPath(date, sandbox.environment)), false);
    } finally {
        sandbox.dispose();
    }
});
