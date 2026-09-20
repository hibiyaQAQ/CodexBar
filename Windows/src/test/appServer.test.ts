import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { AppServerSession } from "../core/appServer";
import { CodexError } from "../core/errors";
import { makeSandbox } from "./support";

/// 造一个最小 app-server 替身, 只回应本测试关心的方法
function fakeServer(root: string, options: { version: string; account: unknown }): string {
    const target = path.join(root, "fake-codex.js");
    const script = `#!/usr/bin/env node
const readline = require("node:readline");
// stdout 混入无关日志行, 用来验证只消费 id 匹配的响应
process.stdout.write("startup log line that is not json\\n");
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
            reply({ userAgent: "codex_cli_rs/${options.version} (x86_64-pc-windows-msvc)" });
            break;
        case "account/read":
            reply(${JSON.stringify(options.account)});
            break;
        case "account/rateLimits/read":
            reply({ rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 20, resetsAt: 1800000000, windowDurationMins: 300 } } });
            break;
        default:
            process.stdout.write(JSON.stringify({ id: message.id, error: { message: "Method not found" } }) + "\\n");
    }
});
`;
    fs.writeFileSync(target, script, { encoding: "utf8", mode: 0o755 });
    return target;
}

test("握手读取版本与账户并消费混杂日志行", async () => {
    const sandbox = makeSandbox("appserver");
    try {
        const executable = fakeServer(sandbox.root, {
            version: "0.151.0",
            account: { account: { type: "chatgpt", email: "demo@example.com", planType: "pro" } }
        });
        const session = AppServerSession.launch(executable, { timeoutMs: 5000 });
        try {
            const handshake = await session.initializeAccount("1.0.0");
            assert.equal(handshake.version, "0.151.0");
            assert.equal(handshake.account.account?.email, "demo@example.com");
            const limits = await session.request<{ rateLimits: { planType: string } }>("account/rateLimits/read");
            assert.equal(limits.rateLimits.planType, "pro");
        } finally {
            session.close();
        }
    } finally {
        sandbox.dispose();
    }
});

test("版本低于要求时直接失败", async () => {
    const sandbox = makeSandbox("appserver");
    try {
        const executable = fakeServer(sandbox.root, {
            version: "0.140.0",
            account: { account: { type: "chatgpt" } }
        });
        const session = AppServerSession.launch(executable, { timeoutMs: 5000 });
        try {
            await assert.rejects(
                () => session.initializeAccount("1.0.0"),
                (error: unknown) => CodexError.isKind(error, "unsupportedVersion")
            );
        } finally {
            session.close();
        }
    } finally {
        sandbox.dispose();
    }
});

test("账户为空时报未登录", async () => {
    const sandbox = makeSandbox("appserver");
    try {
        const executable = fakeServer(sandbox.root, { version: "0.151.0", account: { account: null } });
        const session = AppServerSession.launch(executable, { timeoutMs: 5000 });
        try {
            await assert.rejects(
                () => session.initializeAccount("1.0.0"),
                (error: unknown) => CodexError.isKind(error, "notLoggedIn")
            );
        } finally {
            session.close();
        }
    } finally {
        sandbox.dispose();
    }
});

test("未知方法只尝试一次, 之后直接拒绝", async () => {
    const sandbox = makeSandbox("appserver");
    try {
        const executable = fakeServer(sandbox.root, {
            version: "0.151.0",
            account: { account: { type: "chatgpt" } }
        });
        const session = AppServerSession.launch(executable, { timeoutMs: 5000 });
        try {
            await session.initializeAccount("1.0.0");
            await assert.rejects(
                () => session.request("hooks/list", { cwds: [] }),
                (error: unknown) => CodexError.isKind(error, "unsupportedMethod")
            );
            await assert.rejects(
                () => session.request("hooks/list", { cwds: [] }),
                (error: unknown) => CodexError.isKind(error, "unsupportedMethod")
            );
        } finally {
            session.close();
        }
    } finally {
        sandbox.dispose();
    }
});

test("连接关闭后请求立即失败", async () => {
    const sandbox = makeSandbox("appserver");
    try {
        const executable = fakeServer(sandbox.root, {
            version: "0.151.0",
            account: { account: { type: "chatgpt" } }
        });
        const session = AppServerSession.launch(executable, { timeoutMs: 5000 });
        await session.initializeAccount("1.0.0");
        session.close();
        await assert.rejects(
            () => session.request("account/read", { refreshToken: false }),
            (error: unknown) => CodexError.isKind(error, "connectionClosed")
        );
    } finally {
        sandbox.dispose();
    }
});
