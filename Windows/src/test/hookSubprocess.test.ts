import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { dataRoot, dayKey, eventLogPath } from "../core/paths";
import { makeSandbox } from "./support";

const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    turn_id: "turn-1",
    tool_name: "shell",
    model: "gpt-5.6",
    cwd: "C:\\work\\demo"
});

function runHook(script: string, dataDirectory: string): void {
    const result = spawnSync(process.execPath, [script, "--hook-event"], {
        input: payload,
        env: { ...process.env, CODEXBAR_DATA_DIR: dataDirectory },
        encoding: "utf8",
        timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
}

test("独立脚本以子进程方式写入当天事件文件", () => {
    const sandbox = makeSandbox("hooksub");
    try {
        const directory = dataRoot(sandbox.environment);
        runHook(path.join(__dirname, "..", "..", "hook", "record.js"), directory);
        const target = path.join(directory, "HookEvents", "events", `${dayKey(new Date())}.jsonl`);
        const contents = fs.readFileSync(target, "utf8").trim();
        assert.equal(contents.split("\n").length, 1);
        assert.ok(contents.includes("\"event\":\"PostToolUse\""));
        assert.ok(contents.includes("\"tool\":\"shell\""));
    } finally {
        sandbox.dispose();
    }
});

test("应用自身的 --hook-event 模式写入同样的行", async () => {
    const sandbox = makeSandbox("hooksub");
    try {
        const directory = dataRoot(sandbox.environment);
        const runner = path.join(sandbox.root, "runner.js");
        const hookModePath = path.join(__dirname, "..", "main", "hookMode.js").replace(/\\/g, "\\\\");
        fs.writeFileSync(runner, `const { handleHookEventIfRequested } = require("${hookModePath}");
handleHookEventIfRequested(process.argv).then(() => process.exit(0));
`, "utf8");
        runHook(runner, directory);
        const target = path.join(directory, "HookEvents", "events", `${dayKey(new Date())}.jsonl`);
        const contents = fs.readFileSync(target, "utf8").trim();
        assert.ok(contents.includes("\"event\":\"PostToolUse\""));
        assert.ok(contents.includes("\"session\":\"session-1\""));
    } finally {
        sandbox.dispose();
    }
});

test("应用主入口缺少 --hook-event 时不进入记录模式", () => {
    const sandbox = makeSandbox("hooksub");
    try {
        const directory = dataRoot(sandbox.environment);
        const runner = path.join(sandbox.root, "runner.js");
        const hookModePath = path.join(__dirname, "..", "main", "hookMode.js").replace(/\\/g, "\\\\");
        fs.writeFileSync(runner, `const { handleHookEventIfRequested } = require("${hookModePath}");
handleHookEventIfRequested(["node", "app"]).then(handled => process.exit(handled ? 1 : 0));
`, "utf8");
        const result = spawnSync(process.execPath, [runner], {
            input: payload,
            env: { ...process.env, CODEXBAR_DATA_DIR: directory },
            encoding: "utf8",
            timeout: 10_000
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(eventLogPath(dayKey(new Date()), sandbox.environment)), false);
    } finally {
        sandbox.dispose();
    }
});
