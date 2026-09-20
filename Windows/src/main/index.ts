import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, screen, shell } from "electron";
import * as path from "node:path";
import { handleHookEventIfRequested } from "./hookMode";
import { hookInvocation } from "./hookInvocation";
import { CodexBarService } from "./service";
import { AppSettings } from "../core/settings";
import { currentEnvironment, storagePaths } from "../core/paths";
import { log } from "../core/log";
import { formatTokens } from "../core/stats";

/// 启动分流: 带 --hook-event 时只做 Hook 记录, 绝不初始化托盘 UI
async function bootstrap(): Promise<void> {
    if (await handleHookEventIfRequested(process.argv)) {
        app?.exit(0);
        process.exit(0);
        return;
    }
    startApplication();
}

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let service: CodexBarService | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function panelSize(): { width: number; height: number } {
    return { width: 460, height: 720 };
}

function createPanel(): BrowserWindow {
    const { width, height } = panelSize();
    const window = new BrowserWindow({
        width,
        height,
        show: false,
        frame: false,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        transparent: false,
        backgroundColor: "#111318",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    window.on("blur", () => {
        if (!window.webContents.isDevToolsOpened()) {
            window.hide();
        }
    });
    return window;
}

/// 面板锚定托盘图标, 超出屏幕时夹回工作区内
function positionPanel(window: BrowserWindow, trayBounds: Electron.Rectangle | null): void {
    const { width, height } = panelSize();
    const display = screen.getDisplayNearestPoint(
        trayBounds ? { x: trayBounds.x, y: trayBounds.y } : screen.getCursorScreenPoint()
    );
    const work = display.workArea;
    let x = trayBounds ? Math.round(trayBounds.x + trayBounds.width / 2 - width / 2) : work.x + work.width - width - 12;
    let y = trayBounds ? trayBounds.y - height - 8 : work.y + work.height - height - 12;
    if (trayBounds && trayBounds.y < work.y + work.height / 2) {
        y = trayBounds.y + trayBounds.height + 8;
    }
    x = Math.min(Math.max(x, work.x + 8), work.x + work.width - width - 8);
    y = Math.min(Math.max(y, work.y + 8), work.y + work.height - height - 8);
    window.setBounds({ x, y, width, height });
}

function togglePanel(): void {
    if (!panel) {
        panel = createPanel();
    }
    if (panel.isVisible()) {
        panel.hide();
        return;
    }
    positionPanel(panel, tray?.getBounds() ?? null);
    panel.show();
    panel.focus();
    void refresh("panel");
}

function trayImage(): Electron.NativeImage {
    const iconPath = path.join(__dirname, "..", "..", "resources", "tray.png");
    const image = nativeImage.createFromPath(iconPath);
    return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function updateTrayTooltip(): void {
    if (!tray || !service) {
        return;
    }
    const snapshot = service.currentSnapshot();
    const limits = snapshot.codex.limits;
    const limit = limits.find(entry => entry.limitId.toLowerCase() === "codex") ?? limits[0] ?? null;
    const parts = ["CodexBar"];
    if (snapshot.codex.accountLabel) {
        parts.push(snapshot.codex.accountLabel);
    }
    const windows = limit?.windows.filter(window => window.hasData) ?? [];
    for (const window of windows) {
        parts.push(`${window.label} 剩余 ${window.remainingPercent}%`);
    }
    if (snapshot.codex.lifetimeTokens !== null) {
        parts.push(`累计 ${formatTokens(snapshot.codex.lifetimeTokens)}`);
    }
    tray.setToolTip(parts.join("\n"));
}

function buildContextMenu(): Electron.Menu {
    const settings = service?.currentSettings();
    return Menu.buildFromTemplate([
        { label: "显示面板", click: () => togglePanel() },
        { label: "立即刷新", click: () => void refresh("menu") },
        { type: "separator" },
        {
            label: "开机自动启动",
            type: "checkbox",
            checked: settings?.launchAtLogin === true,
            click: menuItem => applyLaunchAtLogin(menuItem.checked)
        },
        {
            label: "打开数据目录",
            click: () => void shell.openPath(storagePaths(currentEnvironment()).root)
        },
        { type: "separator" },
        { label: "退出", click: () => app.quit() }
    ]);
}

function applyLaunchAtLogin(enabled: boolean): void {
    service?.updateSettings({ launchAtLogin: enabled });
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] });
    log("settings", "notice", "开机自动启动变更", { enabled });
}

async function refresh(trigger: string): Promise<void> {
    if (!service) {
        return;
    }
    const snapshot = await service.refresh(trigger);
    updateTrayTooltip();
    if (panel && !panel.isDestroyed()) {
        panel.webContents.send("snapshot:update", snapshot);
    }
}

function scheduleRefresh(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
    const seconds = service?.currentSettings().refreshIntervalSeconds ?? 60;
    refreshTimer = setInterval(() => void refresh("timer"), seconds * 1000);
}

function registerIPC(): void {
    ipcMain.handle("snapshot:get", () => service?.currentSnapshot() ?? null);
    ipcMain.handle("snapshot:refresh", async (_event, trigger: string) => {
        await refresh(typeof trigger === "string" ? trigger : "manual");
        return service?.currentSnapshot() ?? null;
    });
    ipcMain.handle("settings:update", async (_event, patch: Partial<AppSettings>) => {
        service?.updateSettings(patch ?? {});
        if (patch?.refreshIntervalSeconds !== undefined) {
            scheduleRefresh();
        }
        if (patch?.launchAtLogin !== undefined) {
            app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin === true, args: [] });
        }
        tray?.setContextMenu(buildContextMenu());
        await refresh("settings");
        return service?.currentSnapshot() ?? null;
    });
    ipcMain.handle("hook:set", async (_event, enabled: boolean) => {
        const result = await service?.setHookEnabled(enabled === true);
        await refresh("hook");
        return result ?? { ok: false, message: "服务尚未就绪" };
    });
    ipcMain.handle("app:open-data", async () => {
        await shell.openPath(storagePaths(currentEnvironment()).root);
    });
    ipcMain.handle("app:quit", () => app.quit());
}

function startApplication(): void {
    const single = app.requestSingleInstanceLock();
    if (!single) {
        app.quit();
        return;
    }
    app.on("second-instance", () => togglePanel());
    // 托盘应用不需要在任务栏或 Dock 留下入口
    app.setAppUserModelId("io.github.yatotm.codexbar");

    app.whenReady().then(() => {
        service = new CodexBarService({
            environment: currentEnvironment(),
            hookInvocation: hookInvocation({
                isPackaged: app.isPackaged,
                appPath: app.getAppPath(),
                resourcesPath: process.resourcesPath,
                execPath: process.execPath
            }),
            clientVersion: app.getVersion()
        });
        registerIPC();
        tray = new Tray(trayImage());
        tray.setToolTip("CodexBar");
        tray.setContextMenu(buildContextMenu());
        tray.on("click", () => togglePanel());
        panel = createPanel();
        log("app", "notice", "应用启动完成", {
            version: app.getVersion(),
            hook: service.currentSettings().hookEnabled,
            interval: service.currentSettings().refreshIntervalSeconds
        });
        void refresh("launch");
        scheduleRefresh();
    });

    app.on("window-all-closed", () => {
        // 托盘应用关闭面板后继续驻留
    });
    app.on("before-quit", () => {
        if (refreshTimer) {
            clearInterval(refreshTimer);
        }
        service?.dispose();
    });
}

void bootstrap();
