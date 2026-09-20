import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { compareVersions, findOnPath, isVersionAtLeast, resolveCodexExecutable, serverVersionFromUserAgent, spawnDescription } from "../core/codexResolver";
import { makeSandbox } from "./support";

test("PATH 查找配合 PATHEXT 命中 codex.cmd", () => {
    const sandbox = makeSandbox("resolver");
    try {
        const binary = path.join(sandbox.root, "bin");
        fs.mkdirSync(binary, { recursive: true });
        fs.writeFileSync(path.join(binary, "codex.cmd"), "@echo off", "utf8");
        const environment = {
            ...sandbox.environment,
            env: { ...sandbox.environment.env, PATH: binary }
        };
        assert.equal(findOnPath("codex", environment), path.join(binary, "codex.cmd"));
        const resolved = resolveCodexExecutable({ environment });
        assert.equal(resolved?.source, "global");
        assert.equal(resolved?.executablePath, path.join(binary, "codex.cmd"));
    } finally {
        sandbox.dispose();
    }
});

test("手动指定的路径优先于 PATH", () => {
    const sandbox = makeSandbox("resolver");
    try {
        const manual = path.join(sandbox.root, "custom-codex.exe");
        fs.writeFileSync(manual, "", "utf8");
        const resolved = resolveCodexExecutable({ manualPath: manual, environment: sandbox.environment });
        assert.equal(resolved?.source, "manual");
        assert.equal(resolved?.executablePath, manual);
    } finally {
        sandbox.dispose();
    }
});

test("找不到可执行文件时返回 null", () => {
    const sandbox = makeSandbox("resolver");
    try {
        assert.equal(resolveCodexExecutable({ environment: sandbox.environment }), null);
    } finally {
        sandbox.dispose();
    }
});

test("批处理文件通过 cmd.exe 启动", () => {
    const description = spawnDescription("C:\\bin\\codex.cmd", ["app-server", "--listen", "stdio://"]);
    assert.equal(description.windowsVerbatimArguments, true);
    assert.equal(description.args[0], "/d");
    assert.equal(description.args[3], '"C:\\bin\\codex.cmd app-server --listen stdio://"');
    const direct = spawnDescription("C:\\bin\\codex.exe", ["app-server"]);
    assert.equal(direct.command, "C:\\bin\\codex.exe");
    assert.equal(direct.windowsVerbatimArguments, false);
});

test("版本比较只看前三段数字", () => {
    assert.equal(compareVersions("0.150.0", "0.145.0"), 1);
    assert.equal(compareVersions("0.145.0", "0.145.0"), 0);
    assert.equal(compareVersions("0.144.9", "0.145.0"), -1);
    assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), 0);
    assert.equal(isVersionAtLeast("0.150.1", "0.150.0"), true);
    assert.equal(isVersionAtLeast(null, "0.150.0"), null);
    assert.equal(isVersionAtLeast("unknown", "0.150.0"), null);
});

test("从 userAgent 第一个 token 取实际运行版本", () => {
    assert.equal(serverVersionFromUserAgent("codex_cli_rs/0.151.0 (x86_64-pc-windows-msvc)"), "0.151.0");
    assert.equal(serverVersionFromUserAgent("codex_cli_rs"), null);
    assert.equal(serverVersionFromUserAgent(null), null);
});
