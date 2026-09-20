#!/usr/bin/env node
"use strict";

/**
 * CodexBar 的 Hook 子进程记录器, 零依赖以便任何 Node 直接执行
 * 行格式与 src/core/hookEvent.ts 的 encodeHookEvent 保持一致
 * 任何失败都静默退出, 不能阻断 Codex
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const terminalEvents = ["SessionEnd", "Interrupt"];

function padded(value, length) {
    return String(Math.abs(value)).padStart(length, "0");
}

function dayKey(date) {
    return padded(date.getFullYear(), 4) + "-" + padded(date.getMonth() + 1, 2) + "-" + padded(date.getDate(), 2);
}

function localTimestamp(date) {
    const time = padded(date.getHours(), 2) + ":" + padded(date.getMinutes(), 2) + ":" + padded(date.getSeconds(), 2);
    return dayKey(date) + " " + time + "." + padded(date.getMilliseconds(), 3);
}

function trimmed(value) {
    if (typeof value !== "string") {
        return null;
    }
    const text = value.trim();
    return text.length > 0 ? text : null;
}

function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const seconds = value > 1e12 ? value / 1000 : value;
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    const text = value.trim();
    if (text.includes("T") || text.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(text)) {
        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(text);
    if (!match) {
        return null;
    }
    return new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
        Number((match[7] || "0").padEnd(3, "0"))
    );
}

function dataRoot() {
    const override = trimmed(process.env.CODEXBAR_DATA_DIR);
    if (override) {
        return path.resolve(override);
    }
    const appData = trimmed(process.env.APPDATA) || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "CodexBar-yatotm");
}

function encodeEvent(event) {
    const fields = [
        ["timestamp", localTimestamp(event.timestamp)],
        ["event", event.name],
        ["origin", event.origin],
        ["model", event.modelName],
        ["effort", event.effort],
        ["permission", event.permissionMode],
        ["approval", event.approvalReviewer],
        ["session", event.sessionId],
        ["turn", event.turnId],
        ["agent", event.agentId],
        ["tool", event.toolName],
        ["cwd", event.directoryPath]
    ];
    const body = fields
        .map(entry => JSON.stringify(entry[0]) + ":" + JSON.stringify(entry[1] === undefined ? null : entry[1]))
        .join(",");
    return "{" + body + "}\n";
}

function eventFromPayload(payload) {
    const name = trimmed(payload.hook_event_name);
    if (!name) {
        return null;
    }
    return {
        timestamp: parseTimestamp(payload.timestamp) || new Date(),
        name: name,
        origin: "unknown",
        directoryPath: trimmed(payload.cwd) || process.cwd(),
        toolName: trimmed(payload.tool_name),
        modelName: trimmed(payload.model),
        effort: trimmed(payload.effort) || trimmed(payload.reasoning_effort),
        permissionMode: trimmed(payload.permission_mode),
        approvalReviewer: trimmed(payload.approval_reviewer),
        sessionId: trimmed(payload.session_id),
        turnId: trimmed(payload.turn_id),
        agentId: trimmed(payload.agent_id)
    };
}

function lockWaitLimitMs(name) {
    const timeout = terminalEvents.indexOf(name) >= 0 ? 3 : 5;
    return Math.max(0, timeout - 2) * 1000;
}

function sleep(milliseconds) {
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function acquireLock(lockPath, waitLimitMs) {
    const deadline = Date.now() + Math.max(0, waitLimitMs);
    for (;;) {
        try {
            const handle = fs.openSync(lockPath, "wx");
            fs.writeSync(handle, String(process.pid));
            fs.closeSync(handle);
            return true;
        } catch (error) {
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 30000) {
                    fs.unlinkSync(lockPath);
                }
            } catch (ignored) {
                // 锁文件刚被释放
            }
            if (Date.now() >= deadline) {
                return false;
            }
            sleep(25);
        }
    }
}

function record(event) {
    const root = dataRoot();
    const hookEvents = path.join(root, "HookEvents");
    const eventsDirectory = path.join(hookEvents, "events");
    const lockPath = path.join(hookEvents, "stats.lock");
    fs.mkdirSync(eventsDirectory, { recursive: true });
    const locked = acquireLock(lockPath, lockWaitLimitMs(event.name));
    try {
        fs.appendFileSync(path.join(eventsDirectory, dayKey(event.timestamp) + ".jsonl"), encodeEvent(event), {
            encoding: "utf8"
        });
    } finally {
        if (locked) {
            try {
                fs.unlinkSync(lockPath);
            } catch (ignored) {
                // 锁文件已被清理
            }
        }
    }
}

function readStdin(callback) {
    if (process.stdin.isTTY) {
        callback(null);
        return;
    }
    let text = "";
    let settled = false;
    const finish = () => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timer);
        try {
            const parsed = JSON.parse(text);
            callback(parsed && typeof parsed === "object" ? parsed : null);
        } catch (error) {
            callback(null);
        }
    };
    const timer = setTimeout(finish, 2500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
        text += chunk;
        if (text.length > 4 * 1024 * 1024) {
            text = "";
            finish();
        }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
}

function main() {
    readStdin(payload => {
        try {
            if (payload) {
                const event = eventFromPayload(payload);
                if (event) {
                    record(event);
                }
            }
        } catch (error) {
            // 写入失败静默退出
        }
        process.exit(0);
    });
}

module.exports = { encodeEvent: encodeEvent, eventFromPayload: eventFromPayload, dataRoot: dataRoot, dayKey: dayKey };

if (require.main === module) {
    main();
}
