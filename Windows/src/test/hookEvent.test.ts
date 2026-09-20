import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { decodeHookEvent, encodeHookEvent, eventFromPayload, hookEventFromName, hookTimeoutSeconds, lockWaitLimitMs, projectDisplayName, recordHookEvent } from "../core/hookEvent";
import { eventLogPath } from "../core/paths";
import { makeSandbox } from "./support";

// 独立 Hook 脚本不经过编译, 直接按路径加载校验行格式一致
const standalone = require(path.join(__dirname, "..", "..", "hook", "record.js")) as {
    encodeEvent(event: unknown): string;
    eventFromPayload(payload: Record<string, unknown>): unknown;
};

test("事件名归一化忽略下划线与大小写", () => {
    assert.equal(hookEventFromName("session_start"), "SessionStart");
    assert.equal(hookEventFromName("SubagentStop"), "SubagentStop");
    assert.equal(hookEventFromName("unknown-event"), null);
});

test("终态事件超时为 3 秒, 等锁预算少 2 秒", () => {
    assert.equal(hookTimeoutSeconds("SessionEnd"), 3);
    assert.equal(hookTimeoutSeconds("Interrupt"), 3);
    assert.equal(hookTimeoutSeconds("PostToolUse"), 5);
    assert.equal(lockWaitLimitMs("SessionEnd"), 1000);
    assert.equal(lockWaitLimitMs("PostToolUse"), 3000);
});

test("事件行编码与解码往返一致", () => {
    const event = eventFromPayload({
        hook_event_name: "PostToolUse",
        timestamp: "2026-09-20 10:00:00.123",
        cwd: "C:\\work\\demo",
        tool_name: "shell",
        model: "gpt-5.6",
        session_id: "session-1",
        turn_id: "turn-1"
    });
    assert.ok(event);
    const line = encodeHookEvent(event);
    assert.ok(line.endsWith("\n"));
    const decoded = decodeHookEvent(line.trim());
    assert.ok(decoded);
    assert.equal(decoded.name, "PostToolUse");
    assert.equal(decoded.toolName, "shell");
    assert.equal(decoded.sessionId, "session-1");
    assert.equal(decoded.timestamp.getTime(), event.timestamp.getTime());
    assert.equal(projectDisplayName(decoded.directoryPath), "demo");
});

test("auto review 模型在缺少来源时归一化成 autoReview", () => {
    const decoded = decodeHookEvent(JSON.stringify({
        timestamp: "2026-09-20 10:00:00.000",
        event: "Stop",
        origin: null,
        model: "codex-auto-review"
    }));
    assert.equal(decoded?.origin, "autoReview");
});

test("独立 Hook 脚本与 TypeScript 编码结果一致", () => {
    const payload = {
        hook_event_name: "UserPromptSubmit",
        timestamp: "2026-09-20 08:30:00.500",
        cwd: "C:\\work\\demo",
        model: "gpt-5.6",
        session_id: "s",
        turn_id: "t"
    };
    const typed = eventFromPayload(payload);
    assert.ok(typed);
    assert.equal(standalone.encodeEvent(standalone.eventFromPayload(payload)), encodeHookEvent(typed));
});

test("记录事件按日期写入 JSONL", () => {
    const sandbox = makeSandbox("hook");
    try {
        const event = eventFromPayload({
            hook_event_name: "SessionStart",
            timestamp: "2026-09-20 11:00:00.000",
            session_id: "s1",
            cwd: "C:\\work\\demo"
        });
        assert.ok(event);
        assert.equal(recordHookEvent(event, { environment: sandbox.environment }), true);
        const target = eventLogPath("2026-09-20", sandbox.environment);
        const contents = fs.readFileSync(target, "utf8");
        assert.equal(contents.trim().split("\n").length, 1);
        assert.ok(contents.includes("\"event\":\"SessionStart\""));
        // 锁文件必须释放, 否则下一次写入会一直等待
        assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(target)), "stats.lock")), false);
    } finally {
        sandbox.dispose();
    }
});
