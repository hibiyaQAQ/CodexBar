import { eventFromPayload, hookArgument, recordHookEvent } from "../core/hookEvent";

/// Hook 子进程模式: 从 stdin 读 JSON payload, 写入本地 JSONL 后立即退出
/// 任何失败都静默返回, 优先保证不拖慢 Codex
export async function handleHookEventIfRequested(argv: string[]): Promise<boolean> {
    if (!argv.includes(hookArgument)) {
        return false;
    }
    try {
        const payload = await readStdinJSON(3_000);
        if (payload) {
            const event = eventFromPayload(payload);
            if (event) {
                recordHookEvent(event);
            }
        }
    } catch {
        // 写入失败静默吞掉, 不阻断 Codex
    }
    return true;
}

function readStdinJSON(timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
        if (process.stdin.isTTY) {
            resolve(null);
            return;
        }
        let text = "";
        let settled = false;
        const finish = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(text);
                resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
            } catch {
                resolve(null);
            }
        };
        const timer = setTimeout(finish, timeoutMs);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => {
            text += chunk;
            // payload 超出合理体积时按坏输入处理
            if (text.length > 4 * 1024 * 1024) {
                text = "";
                finish();
            }
        });
        process.stdin.on("end", finish);
        process.stdin.on("error", finish);
    });
}
