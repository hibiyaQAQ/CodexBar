import * as fs from "node:fs";
import * as path from "node:path";

export interface FileStat {
    size: number;
    identifier: string;
}

export function statIfPresent(filePath: string): FileStat | null {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return null;
        }
        // Windows 没有稳定 inode, 用创建时间与文件号组合作为文件身份
        const identifier = `${stat.ino}:${Math.trunc(stat.birthtimeMs)}`;
        return { size: stat.size, identifier };
    } catch {
        return null;
    }
}

export function ensureDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true });
}

/// 写临时文件再重命名, 避免读取方看到半截内容
export function writeAtomic(filePath: string, contents: string): void {
    ensureDirectory(path.dirname(filePath));
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents, { encoding: "utf8" });
    fs.renameSync(temporary, filePath);
}

export function readTextIfPresent(filePath: string, limit = 0): string | null {
    try {
        if (limit <= 0) {
            return fs.readFileSync(filePath, "utf8");
        }
        const handle = fs.openSync(filePath, "r");
        try {
            const buffer = Buffer.alloc(limit);
            const read = fs.readSync(handle, buffer, 0, limit, 0);
            return buffer.subarray(0, read).toString("utf8");
        } finally {
            fs.closeSync(handle);
        }
    } catch {
        return null;
    }
}

export function readJSONIfPresent<T = unknown>(filePath: string, limit = 0): T | null {
    const text = readTextIfPresent(filePath, limit);
    if (text === null) {
        return null;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/// 从指定偏移增量读取完整行, 返回消费到的新偏移
export function readLinesFrom(filePath: string, offset: number): { lines: string[]; offset: number } {
    let handle: number | null = null;
    try {
        handle = fs.openSync(filePath, "r");
        const size = fs.fstatSync(handle).size;
        if (size <= offset) {
            return { lines: [], offset: Math.min(offset, size) };
        }
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, offset);
        const text = buffer.toString("utf8");
        const lastBreak = text.lastIndexOf("\n");
        if (lastBreak < 0) {
            // 尾行还没写完, 保持偏移等待下一轮
            return { lines: [], offset };
        }
        const complete = text.slice(0, lastBreak);
        const consumed = Buffer.byteLength(complete, "utf8") + 1;
        const lines = complete.split("\n").map(line => line.replace(/\r$/, "")).filter(line => line.length > 0);
        return { lines, offset: offset + consumed };
    } catch {
        return { lines: [], offset };
    } finally {
        if (handle !== null) {
            try {
                fs.closeSync(handle);
            } catch {
                // 关闭失败不影响本轮读取结果
            }
        }
    }
}

export function parseJSONLine<T = Record<string, unknown>>(line: string): T | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") {
        return null;
    }
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        return null;
    }
}

export interface LockHandle {
    release(): void;
}

/// Windows 没有 flock, 用独占创建的锁文件代替
/// 超过等待预算直接放弃, Hook 子进程不能为了锁拖慢 Codex
export function acquireLock(lockPath: string, waitLimitMs: number): LockHandle | null {
    ensureDirectory(path.dirname(lockPath));
    const deadline = Date.now() + Math.max(0, waitLimitMs);
    for (;;) {
        try {
            const handle = fs.openSync(lockPath, "wx");
            fs.writeSync(handle, String(process.pid));
            fs.closeSync(handle);
            return {
                release() {
                    try {
                        fs.unlinkSync(lockPath);
                    } catch {
                        // 锁文件已被清理时无需处理
                    }
                }
            };
        } catch {
            releaseStaleLock(lockPath);
            if (Date.now() >= deadline) {
                return null;
            }
            sleep(25);
        }
    }
}

/// 持锁进程崩溃会留下锁文件, 超过 30 秒按过期清理
function releaseStaleLock(lockPath: string): void {
    try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
            fs.unlinkSync(lockPath);
        }
    } catch {
        // 读不到锁文件说明它刚被释放
    }
}

function sleep(milliseconds: number): void {
    const shared = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}
