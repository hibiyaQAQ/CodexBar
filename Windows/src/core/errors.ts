export type CodexErrorKind =
    | "executableNotFound"
    | "notLoggedIn"
    | "unsupportedVersion"
    | "unsupportedMethod"
    | "serverError"
    | "serverTimeout"
    | "connectionClosed"
    | "invalidResponse"
    | "launchFailed";

export class CodexError extends Error {
    readonly kind: CodexErrorKind;
    readonly detail: string | undefined;

    constructor(kind: CodexErrorKind, message: string, detail?: string) {
        super(message);
        this.name = "CodexError";
        this.kind = kind;
        this.detail = detail;
    }

    static isKind(error: unknown, kind: CodexErrorKind): boolean {
        return error instanceof CodexError && error.kind === kind;
    }
}

/// app-server 用 -32601 表示方法不存在, 认证失败靠消息文本识别
export function classifyServerError(message: string): CodexErrorKind {
    const text = message.toLowerCase();
    if (text.includes("method not found") || text.includes("unknown method") || text.includes("-32601")) {
        return "unsupportedMethod";
    }
    return "serverError";
}

export function isAuthenticationFailure(message: string): boolean {
    const text = message.toLowerCase();
    return text.includes("unauthorized")
        || text.includes("401")
        || text.includes("token expired")
        || text.includes("authentication");
}
