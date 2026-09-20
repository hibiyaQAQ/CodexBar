import { contextBridge, ipcRenderer } from "electron";
import { AppSnapshot } from "../core/snapshot";
import { AppSettings } from "../core/settings";

/// 渲染进程只拿到这几个受控入口, 不直接接触 Node API
contextBridge.exposeInMainWorld("codexbar", {
    getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("snapshot:get"),
    refresh: (trigger: string): Promise<AppSnapshot> => ipcRenderer.invoke("snapshot:refresh", trigger),
    updateSettings: (patch: Partial<AppSettings>): Promise<AppSnapshot> => ipcRenderer.invoke("settings:update", patch),
    setHookEnabled: (enabled: boolean): Promise<{ ok: boolean; message: string | null }> =>
        ipcRenderer.invoke("hook:set", enabled),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke("app:open-data"),
    quit: (): Promise<void> => ipcRenderer.invoke("app:quit"),
    onSnapshot: (handler: (snapshot: AppSnapshot) => void): void => {
        ipcRenderer.on("snapshot:update", (_event, snapshot: AppSnapshot) => handler(snapshot));
    }
});
