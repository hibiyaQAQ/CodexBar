import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { CodexError, classifyServerError } from "./errors";
import {
    appServerArguments,
    isVersionAtLeast,
    minimumCodexVersion,
    serverVersionFromUserAgent,
    spawnDescription
} from "./codexResolver";

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: NodeJS.Timeout;
    method: string;
}

export interface AppServerOptions {
    timeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    clientVersion?: string;
}

const defaultTimeoutMs = 20_000;

/// app-server stdio JSON-RPC 的薄封装
/// stdout 可能混有无关日志行, 只消费 id 匹配的响应
export class AppServerSession {
    readonly executablePath: string;
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly timeoutMs: number;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly unsupportedMethods = new Set<string>();
    private buffer = "";
    private nextId = 1;
    private closed = false;
    private closeReason: CodexError | null = null;
    serverVersion: string | null = null;

    private constructor(child: ChildProcessWithoutNullStreams, executablePath: string, timeoutMs: number) {
        this.child = child;
        this.executablePath = executablePath;
        this.timeoutMs = timeoutMs;
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", chunk => this.consume(String(chunk)));
        this.child.stderr.resume();
        this.child.on("error", error => {
            this.failAll(new CodexError("launchFailed", "app-server 启动失败", String(error)));
        });
        this.child.on("exit", code => {
            this.failAll(new CodexError("connectionClosed", "app-server 连接已关闭", `exit=${code ?? "unknown"}`));
        });
        // stdin 写入失败由 write 抛错走重建路径
        this.child.stdin.on("error", () => undefined);
    }

    static launch(executablePath: string, options: AppServerOptions = {}): AppServerSession {
        const description = spawnDescription(executablePath, appServerArguments);
        const child = spawn(description.command, description.args, {
            env: options.environment ?? process.env,
            windowsHide: true,
            windowsVerbatimArguments: description.windowsVerbatimArguments,
            stdio: ["pipe", "pipe", "pipe"]
        }) as ChildProcessWithoutNullStreams;
        return new AppServerSession(child, executablePath, options.timeoutMs ?? defaultTimeoutMs);
    }

    get isClosed(): boolean {
        return this.closed;
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        for (;;) {
            const breakIndex = this.buffer.indexOf("\n");
            if (breakIndex < 0) {
                break;
            }
            const line = this.buffer.slice(0, breakIndex).replace(/\r$/, "");
            this.buffer = this.buffer.slice(breakIndex + 1);
            this.handleLine(line);
        }
        // 单行超长说明对端输出异常, 丢弃避免无界增长
        if (this.buffer.length > 8 * 1024 * 1024) {
            this.buffer = "";
        }
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            return;
        }
        let message: { id?: unknown; result?: unknown; error?: { message?: string } };
        try {
            message = JSON.parse(trimmed);
        } catch {
            return;
        }
        if (typeof message.id !== "number") {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            const text = message.error.message ?? "app-server 返回错误";
            const kind = classifyServerError(text);
            if (kind === "unsupportedMethod") {
                this.unsupportedMethods.add(pending.method);
            }
            pending.reject(new CodexError(kind, text));
            return;
        }
        pending.resolve(message.result ?? null);
    }

    private failAll(error: CodexError): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closeReason = error;
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    notify(method: string, params?: unknown): void {
        this.write({ method, ...(params === undefined ? {} : { params }) });
    }

    async request<T>(method: string, params?: unknown): Promise<T> {
        if (this.unsupportedMethods.has(method)) {
            throw new CodexError("unsupportedMethod", `app-server 不支持 ${method}`);
        }
        if (this.closed) {
            throw this.closeReason ?? new CodexError("connectionClosed", "app-server 连接已关闭");
        }
        const id = this.nextId;
        this.nextId += 1;
        const payload = { id, method, ...(params === undefined ? {} : { params }) };
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CodexError("serverTimeout", `app-server 响应超时: method=${method}`));
            }, this.timeoutMs);
            this.pending.set(id, {
                resolve: value => resolve(value as T),
                reject,
                timer,
                method
            });
            try {
                this.write(payload);
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    private write(payload: unknown): void {
        if (this.closed) {
            throw this.closeReason ?? new CodexError("connectionClosed", "app-server 连接已关闭");
        }
        const line = `${JSON.stringify(payload)}\n`;
        const accepted = this.child.stdin.write(line);
        if (!accepted) {
            // 背压时不阻塞, 后续写入仍会排队
            return;
        }
    }

    /// 握手并读取账户, 版本不达标时直接失败
    async initializeAccount(clientVersion = "1.0.0"): Promise<{ version: string; account: AccountReadResponse }> {
        const result = await this.request<{ userAgent?: string }>("initialize", {
            clientInfo: { name: "codex_bar", title: "Codex Bar", version: clientVersion }
        });
        const version = serverVersionFromUserAgent(result?.userAgent);
        const supported = isVersionAtLeast(version, minimumCodexVersion);
        if (!version || supported === null) {
            throw new CodexError("invalidResponse", "无法识别 app-server 版本");
        }
        if (!supported) {
            throw new CodexError("unsupportedVersion", `Codex 版本过低, 需要 ${minimumCodexVersion} 或更高`, version);
        }
        this.serverVersion = version;
        this.notify("initialized");
        const account = await this.request<AccountReadResponse>("account/read", { refreshToken: false });
        if (!account?.account) {
            throw new CodexError("notLoggedIn", "Codex 尚未登录");
        }
        return { version, account };
    }

    close(): void {
        this.failAll(new CodexError("connectionClosed", "app-server 连接已关闭", "reason=closedByApp"));
        try {
            this.child.stdin.end();
        } catch {
            // 管道已关闭时无需处理
        }
        try {
            this.child.kill();
        } catch {
            // 进程已退出时无需处理
        }
    }
}

export interface CodexAccount {
    type: string;
    email?: string | null;
    planType?: string | null;
}

export interface AccountReadResponse {
    account?: CodexAccount | null;
}
