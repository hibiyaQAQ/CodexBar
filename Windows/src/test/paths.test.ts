import { strict as assert } from "node:assert";
import * as path from "node:path";
import { test } from "node:test";
import { claudeHome, codexHome, dataRoot, dayKey, dayKeyOffset, localTimestamp, parseAnyTimestamp, parseLocalTimestamp, storagePaths } from "../core/paths";
import { makeSandbox } from "./support";

test("Codex 目录优先使用 CODEX_HOME", () => {
    const sandbox = makeSandbox("paths");
    try {
        assert.equal(codexHome(sandbox.environment), path.join(sandbox.environment.home, ".codex"));
        const override = { ...sandbox.environment, env: { ...sandbox.environment.env, CODEX_HOME: path.join(sandbox.root, "custom") } };
        assert.equal(codexHome(override), path.join(sandbox.root, "custom"));
    } finally {
        sandbox.dispose();
    }
});

test("Claude 目录优先使用 CLAUDE_CONFIG_DIR", () => {
    const sandbox = makeSandbox("paths");
    try {
        assert.equal(claudeHome(sandbox.environment), path.join(sandbox.environment.home, ".claude"));
        const override = { ...sandbox.environment, env: { ...sandbox.environment.env, CLAUDE_CONFIG_DIR: path.join(sandbox.root, "cc") } };
        assert.equal(claudeHome(override), path.join(sandbox.root, "cc"));
    } finally {
        sandbox.dispose();
    }
});

test("数据目录跟随 APPDATA 并包含全部存储项", () => {
    const sandbox = makeSandbox("paths");
    try {
        const root = dataRoot(sandbox.environment);
        assert.equal(root, path.join(sandbox.root, "AppData", "CodexBar-yatotm"));
        const paths = storagePaths(sandbox.environment);
        assert.equal(paths.eventsDirectory, path.join(root, "HookEvents", "events"));
        assert.equal(paths.dailyPath, path.join(root, "HookEvents", "daily.jsonl"));
        assert.equal(paths.lockPath, path.join(root, "HookEvents", "stats.lock"));
    } finally {
        sandbox.dispose();
    }
});

test("本机时间串可以往返解析", () => {
    const date = new Date(2026, 8, 20, 9, 5, 3, 40);
    const text = localTimestamp(date);
    assert.equal(text, "2026-09-20 09:05:03.040");
    assert.equal(parseLocalTimestamp(text)?.getTime(), date.getTime());
    assert.equal(dayKey(date), "2026-09-20");
    assert.equal(dayKeyOffset(date, -1), "2026-09-19");
});

test("ISO8601 与秒级时间戳都能解析", () => {
    assert.equal(parseAnyTimestamp("2026-09-20T01:02:03Z")?.toISOString(), "2026-09-20T01:02:03.000Z");
    assert.equal(parseAnyTimestamp(1_758_326_400)?.getTime(), 1_758_326_400_000);
    assert.equal(parseAnyTimestamp("not a date"), null);
});
