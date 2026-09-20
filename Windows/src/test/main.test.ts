import { strict as assert } from "node:assert";
import * as path from "node:path";
import { test } from "node:test";
import { dataRoot } from "../core/paths";
import { makeSandbox } from "./support";

interface Recorded {
    tooltips: string[];
    windows: Array<Record<string, unknown>>;
    handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
    appEvents: Map<string, () => void>;
    menus: Array<Array<{ label?: string }>>;
}

/// 用桩替换 electron, 验证主进程装配与 IPC 通道
function installElectronStub(recorded: Recorded): () => void {
    const moduleApi = require("node:module") as typeof import("node:module") & {
        _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const original = moduleApi._load;
    const stub = {
        app: {
            isPackaged: false,
            whenReady: () => Promise.resolve(),
            requestSingleInstanceLock: () => true,
            on: (name: string, handler: () => void) => recorded.appEvents.set(name, handler),
            setAppUserModelId: () => undefined,
            setLoginItemSettings: () => undefined,
            getVersion: () => "1.0.0",
            getAppPath: () => path.join(__dirname, "..", ".."),
            quit: () => undefined,
            exit: () => undefined
        },
        Tray: class {
            setToolTip(value: string): void {
                recorded.tooltips.push(value);
            }
            setContextMenu(): void {
                return undefined;
            }
            on(): void {
                return undefined;
            }
            getBounds(): null {
                return null;
            }
        },
        Menu: {
            buildFromTemplate: (template: Array<{ label?: string }>) => {
                recorded.menus.push(template);
                return template;
            }
        },
        BrowserWindow: class {
            webContents = { send: () => undefined, isDevToolsOpened: () => false };
            constructor(options: Record<string, unknown>) {
                recorded.windows.push(options);
            }
            loadFile(): void {
                return undefined;
            }
            on(): void {
                return undefined;
            }
            isVisible(): boolean {
                return false;
            }
            isDestroyed(): boolean {
                return false;
            }
            show(): void {
                return undefined;
            }
            hide(): void {
                return undefined;
            }
            focus(): void {
                return undefined;
            }
            setBounds(): void {
                return undefined;
            }
        },
        ipcMain: {
            handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
                recorded.handlers.set(channel, handler);
            }
        },
        nativeImage: {
            createFromPath: () => ({ isEmpty: () => false }),
            createEmpty: () => ({ isEmpty: () => true })
        },
        screen: {
            getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
            getCursorScreenPoint: () => ({ x: 0, y: 0 })
        },
        shell: { openPath: () => Promise.resolve("") }
    };
    moduleApi._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
        if (request === "electron") {
            return stub;
        }
        return original.call(this, request, parent, isMain);
    };
    return () => {
        moduleApi._load = original;
    };
}

function restoreEnvironment(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}

test("主进程装配托盘, 面板与全部 IPC 通道", async () => {
    const sandbox = makeSandbox("main");
    const recorded: Recorded = {
        tooltips: [],
        windows: [],
        handlers: new Map(),
        appEvents: new Map(),
        menus: []
    };
    const restore = installElectronStub(recorded);
    const previous = {
        data: process.env.CODEXBAR_DATA_DIR,
        codex: process.env.CODEX_HOME,
        claude: process.env.CLAUDE_CONFIG_DIR
    };
    process.env.CODEXBAR_DATA_DIR = dataRoot(sandbox.environment);
    process.env.CODEX_HOME = path.join(sandbox.environment.home, ".codex");
    process.env.CLAUDE_CONFIG_DIR = path.join(sandbox.environment.home, ".claude");
    try {
        require("../main/index");
        // 启动分流与首轮刷新都是异步的, 等它们跑完
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.deepEqual(
            [...recorded.handlers.keys()].sort(),
            ["app:open-data", "app:quit", "hook:set", "settings:update", "snapshot:get", "snapshot:refresh"]
        );
        assert.equal(recorded.windows.length > 0, true);
        const options = recorded.windows[0] as { webPreferences: { preload: string; contextIsolation: boolean; nodeIntegration: boolean } };
        assert.equal(options.webPreferences.contextIsolation, true);
        assert.equal(options.webPreferences.nodeIntegration, false);
        assert.equal(path.basename(options.webPreferences.preload), "preload.js");
        assert.equal(recorded.tooltips.length > 0, true);
        assert.equal(recorded.menus[0]?.some(item => item.label === "立即刷新"), true);
        assert.equal(recorded.menus[0]?.some(item => item.label === "退出"), true);

        const snapshot = await recorded.handlers.get("snapshot:get")?.(null) as { codex: { state: string } };
        assert.equal(snapshot.codex.state, "executableNotFound");
    } finally {
        // 关闭周期刷新, 否则测试进程不会退出
        recorded.appEvents.get("before-quit")?.();
        restore();
        restoreEnvironment("CODEXBAR_DATA_DIR", previous.data);
        restoreEnvironment("CODEX_HOME", previous.codex);
        restoreEnvironment("CLAUDE_CONFIG_DIR", previous.claude);
        sandbox.dispose();
    }
});
