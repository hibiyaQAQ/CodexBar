import { AppServerSession } from "../core/appServer";
import { claudeHome, codexHome, currentEnvironment, storagePaths } from "../core/paths";
import { containsAllCodexBarHooks, containsAnyCodexBarHook, hookCommandText, hooksConfigPath, readHooksConfig } from "../core/hooksConfig";
import { hookInvocation } from "../main/hookInvocation";
import { isVersionAtLeast, minimumCodexVersion, minimumHookCodexVersion, resolveCodexExecutable } from "../core/codexResolver";
import { loadSettings } from "../core/settings";
import { readClaudeAccount, readClaudeQuotaCache } from "../core/claude";
import { dailyTokensMap, loadRolloutState } from "../core/rollouts";
import { computeUsageStats } from "../core/stats";
import * as fs from "node:fs";

/// 不启动界面的自检工具, 首次在 Windows 上排查环境时使用
async function main(): Promise<void> {
    const environment = currentEnvironment();
    const settings = loadSettings(environment);
    const paths = storagePaths(environment);
    print("目录", [
        ["Codex 配置", codexHome(environment)],
        ["Claude 配置", claudeHome(environment)],
        ["应用数据", paths.root],
        ["hooks.json", hooksConfigPath(environment)]
    ]);

    const executable = resolveCodexExecutable({ manualPath: settings.codexExecutablePath, environment });
    print("codex 可执行文件", [
        ["路径", executable?.executablePath ?? "未找到"],
        ["来源", executable?.source ?? "无"]
    ]);

    if (executable) {
        const session = AppServerSession.launch(executable.executablePath, { environment: environment.env });
        try {
            const handshake = await session.initializeAccount("1.0.0");
            print("app-server", [
                ["运行版本", handshake.version],
                ["账户最低版本", `${minimumCodexVersion} ${isVersionAtLeast(handshake.version, minimumCodexVersion) ? "满足" : "不满足"}`],
                ["Hook 最低版本", `${minimumHookCodexVersion} ${isVersionAtLeast(handshake.version, minimumHookCodexVersion) ? "满足" : "不满足"}`],
                ["账户", handshake.account.account?.email ?? handshake.account.account?.type ?? "未知"],
                ["套餐", handshake.account.account?.planType ?? "未知"]
            ]);
            const limits = await session.request<{ rateLimits?: { primary?: { usedPercent?: number }; secondary?: { usedPercent?: number } } }>(
                "account/rateLimits/read"
            );
            print("额度", [
                ["主窗口已用", String(limits?.rateLimits?.primary?.usedPercent ?? "未知")],
                ["次窗口已用", String(limits?.rateLimits?.secondary?.usedPercent ?? "未知")]
            ]);
        } catch (error) {
            print("app-server", [["失败", error instanceof Error ? error.message : String(error)]]);
        } finally {
            session.close();
        }
    }

    const invocation = hookInvocation({
        isPackaged: false,
        appPath: process.cwd(),
        resourcesPath: process.resourcesPath ?? process.cwd(),
        execPath: process.execPath
    });
    let installed = "读取失败";
    let complete = "读取失败";
    try {
        const config = readHooksConfig(environment);
        installed = containsAnyCodexBarHook(config, invocation) ? "是" : "否";
        complete = containsAllCodexBarHooks(config, invocation) ? "是" : "否";
    } catch (error) {
        installed = error instanceof Error ? error.message : String(error);
    }
    print("Hook", [
        ["设置中已开启", settings.hookEnabled ? "是" : "否"],
        ["配置中存在", installed],
        ["配置完整", complete],
        ["命令", hookCommandText(invocation)],
        ["事件目录", `${paths.eventsDirectory} ${countFiles(paths.eventsDirectory)} 个文件`]
    ]);

    const rollouts = loadRolloutState(environment);
    const tokens = dailyTokensMap(rollouts);
    const stats = computeUsageStats(tokens);
    print("本机 Codex 会话", [
        ["已扫描文件", String(Object.keys(rollouts.files).length)],
        ["有记录天数", String(stats.activeDays)],
        ["累计 Token", String(stats.lifetimeTokens)],
        ["扫描完成", rollouts.scanComplete ? "是" : "否"]
    ]);

    const claudeAccount = readClaudeAccount(environment);
    const claudeQuota = readClaudeQuotaCache(environment);
    print("Claude", [
        ["账户", claudeAccount?.email ?? "未找到"],
        ["套餐", claudeAccount?.plan ?? "未找到"],
        ["额度缓存", claudeQuota ? `${claudeQuota.windows.length} 个窗口` : "未找到"]
    ]);
}

function countFiles(directory: string): number {
    try {
        return fs.readdirSync(directory).filter(name => name.endsWith(".jsonl")).length;
    } catch {
        return 0;
    }
}

function print(title: string, rows: Array<[string, string]>): void {
    process.stdout.write(`\n[${title}]\n`);
    const width = Math.max(...rows.map(row => row[0].length));
    for (const [label, value] of rows) {
        process.stdout.write(`  ${label.padEnd(width, " ")}  ${value}\n`);
    }
}

void main().then(() => process.exit(0));
