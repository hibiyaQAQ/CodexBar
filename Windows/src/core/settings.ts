import { readJSONIfPresent, writeAtomic } from "./files";
import { PathEnvironment, currentEnvironment, storagePaths } from "./paths";

export interface AppSettings {
    refreshIntervalSeconds: number;
    codexExecutablePath: string | null;
    hookEnabled: boolean;
    showsClaude: boolean;
    launchAtLogin: boolean;
    heatmapWeeks: number;
    scanLocalSessions: boolean;
}

export const defaultSettings: AppSettings = {
    refreshIntervalSeconds: 60,
    codexExecutablePath: null,
    hookEnabled: false,
    showsClaude: true,
    launchAtLogin: false,
    heatmapWeeks: 30,
    scanLocalSessions: true
};

function clampInterval(value: unknown): number {
    const seconds = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : defaultSettings.refreshIntervalSeconds;
    return Math.min(3600, Math.max(30, seconds));
}

function clampWeeks(value: unknown): number {
    const weeks = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : defaultSettings.heatmapWeeks;
    return Math.min(52, Math.max(10, weeks));
}

export function loadSettings(environment: PathEnvironment = currentEnvironment()): AppSettings {
    const loaded = readJSONIfPresent<Partial<AppSettings>>(storagePaths(environment).settingsPath);
    if (!loaded) {
        return { ...defaultSettings };
    }
    return {
        refreshIntervalSeconds: clampInterval(loaded.refreshIntervalSeconds),
        codexExecutablePath: typeof loaded.codexExecutablePath === "string" && loaded.codexExecutablePath.trim()
            ? loaded.codexExecutablePath.trim()
            : null,
        hookEnabled: loaded.hookEnabled === true,
        showsClaude: loaded.showsClaude !== false,
        launchAtLogin: loaded.launchAtLogin === true,
        heatmapWeeks: clampWeeks(loaded.heatmapWeeks),
        scanLocalSessions: loaded.scanLocalSessions !== false
    };
}

export function saveSettings(settings: AppSettings, environment: PathEnvironment = currentEnvironment()): void {
    writeAtomic(storagePaths(environment).settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
