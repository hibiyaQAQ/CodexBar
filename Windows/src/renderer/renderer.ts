type Snapshot = import("../core/snapshot").AppSnapshot;
type CodexSection = import("../core/snapshot").CodexSection;
type HookSection = import("../core/snapshot").HookSection;
type ClaudeSection = import("../core/snapshot").ClaudeSection;
type Settings = import("../core/settings").AppSettings;
type HeatmapDay = import("../core/heatmap").HeatmapDay;
type QuotaWindowView = import("../core/quota").QuotaWindowView;
type WindowEstimate = import("../core/estimate").WindowEstimate;

interface CodexBarAPI {
    getSnapshot(): Promise<Snapshot | null>;
    refresh(trigger: string): Promise<Snapshot | null>;
    updateSettings(patch: Partial<Settings>): Promise<Snapshot | null>;
    setHookEnabled(enabled: boolean): Promise<{ ok: boolean; message: string | null }>;
    openDataFolder(): Promise<void>;
    quit(): Promise<void>;
    onSnapshot(handler: (snapshot: Snapshot) => void): void;
}

const api = (window as unknown as { codexbar: CodexBarAPI }).codexbar;

let snapshot: Snapshot | null = null;
let selectedCodexDate: string | null = null;
let selectedClaudeDate: string | null = null;
let activeTab = "codex";

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function formatTokens(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "暂无数据";
    }
    if (value >= 1_000_000_000) {
        return `${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return String(Math.trunc(value));
}

function formatDuration(milliseconds: number | null | undefined): string {
    if (milliseconds === null || milliseconds === undefined || milliseconds <= 0) {
        return "暂无数据";
    }
    const totalSeconds = Math.round(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function formatRelativeReset(resetsAtSeconds: number | null): string {
    if (resetsAtSeconds === null) {
        return "未知";
    }
    const difference = resetsAtSeconds * 1000 - Date.now();
    if (difference <= 0) {
        return "即将重置";
    }
    const minutes = Math.round(difference / 60_000);
    if (minutes < 60) {
        return `${minutes} 分钟后重置`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const remainder = minutes % 60;
        return remainder > 0 ? `${hours} 小时 ${remainder} 分后重置` : `${hours} 小时后重置`;
    }
    const days = Math.floor(hours / 24);
    const remainderHours = hours % 24;
    return remainderHours > 0 ? `${days} 天 ${remainderHours} 小时后重置` : `${days} 天后重置`;
}

function formatClock(resetsAtSeconds: number | null): string {
    if (resetsAtSeconds === null) {
        return "";
    }
    const date = new Date(resetsAtSeconds * 1000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function card(title: string, trailing?: string): HTMLDivElement {
    const node = element("div", "card");
    const head = element("div", "card-title");
    head.append(element("span", undefined, title));
    if (trailing) {
        head.append(element("span", undefined, trailing));
    }
    node.append(head);
    return node;
}

function statTile(label: string, value: string, note?: string): HTMLDivElement {
    const tile = element("div", "stat");
    tile.append(element("div", "stat-label", label));
    tile.append(element("div", "stat-value", value));
    if (note) {
        tile.append(element("div", "stat-note", note));
    }
    return tile;
}

function quotaRow(window: QuotaWindowView): HTMLDivElement {
    const row = element("div", "quota-row");
    const head = element("div", "quota-head");
    const label = element("div", "quota-label");
    label.append(element("span", "chip", window.label));
    label.append(element("span", undefined, window.kind === "primary" ? "主窗口" : "次窗口"));
    head.append(label);
    head.append(element("div", "quota-value", window.hasData ? `剩余 ${window.remainingPercent}%` : "暂无数据"));
    row.append(head);

    const bar = element("div", "bar");
    if (window.remainingPercent <= 10) {
        bar.classList.add("critical");
    } else if (window.remainingPercent <= 25) {
        bar.classList.add("low");
    }
    const fill = element("span");
    fill.style.width = `${window.hasData ? window.remainingPercent : 0}%`;
    bar.append(fill);
    row.append(bar);

    const foot = element("div", "quota-foot");
    foot.append(element("span", undefined, window.usedPercent === null ? "已用 未知" : `已用 ${window.usedPercent}%`));
    const reset = element("span", undefined, `${formatRelativeReset(window.resetsAt)} ${formatClock(window.resetsAt)}`.trim());
    foot.append(reset);
    row.append(foot);
    return row;
}

function confidenceText(estimate: WindowEstimate): string {
    switch (estimate.confidence) {
        case "high":
            return "样本充足";
        case "medium":
            return "样本一般";
        case "low":
            return "样本较少";
        default:
            return "样本不足";
    }
}

function estimateCard(estimates: WindowEstimate[]): HTMLDivElement {
    const node = card("额度估算", "基于本机观测");
    const usable = estimates.filter(estimate => estimate.usedPercent !== null);
    if (usable.length === 0) {
        node.append(element("div", "empty", "暂无可用窗口数据"));
        return node;
    }
    for (const estimate of usable) {
        const row = element("div", "quota-row");
        const head = element("div", "quota-head");
        const label = element("div", "quota-label");
        label.append(element("span", "chip", estimate.label));
        label.append(element("span", undefined, "窗口总额度估算"));
        head.append(label);
        head.append(element("div", "quota-value", estimate.totalTokens === null ? "继续积累样本" : formatTokens(estimate.totalTokens)));
        row.append(head);
        const foot = element("div", "quota-foot");
        foot.append(element(
            "span",
            undefined,
            estimate.remainingTokens === null
                ? `剩余 ${estimate.remainingPercent}%`
                : `预计可用 ${formatTokens(estimate.remainingTokens)}`
        ));
        foot.append(element("span", undefined, `${confidenceText(estimate)} · ${estimate.sampleCount} 次观测`));
        row.append(foot);
        node.append(row);
    }
    const note = element("div", "meta");
    note.append(element("span", undefined, "估算口径为输入与输出计费 Token, 由窗口内用量与百分比变化推算"));
    node.append(note);
    return node;
}

function heatmapLevel(tokens: number, maximum: number): number {
    if (tokens <= 0 || maximum <= 0) {
        return 0;
    }
    const ratio = tokens / maximum;
    if (ratio <= 0.25) {
        return 1;
    }
    if (ratio <= 0.5) {
        return 2;
    }
    if (ratio <= 0.75) {
        return 3;
    }
    return 4;
}

function heatmapGrid(
    days: Array<HeatmapDay | null>,
    maximum: number,
    selected: string | null,
    onSelect: (date: string) => void
): HTMLDivElement {
    const grid = element("div", "heatmap");
    const columnCount = Math.ceil(days.length / 7);
    for (let column = 0; column < columnCount; column += 1) {
        const columnNode = element("div", "heat-column");
        for (let row = 0; row < 7; row += 1) {
            const day = days[column * 7 + row] ?? null;
            const cell = element("div", "heat-cell");
            if (!day) {
                cell.classList.add("empty");
            } else {
                const tokens = day.tokenCount ?? 0;
                cell.classList.add(`level-${heatmapLevel(tokens, maximum)}`);
                cell.title = `${day.startDate} · ${day.tokenCount === null ? "暂无数据" : `${formatTokens(tokens)} Token`}`;
                if (selected === day.startDate) {
                    cell.classList.add("selected");
                }
                cell.addEventListener("click", () => onSelect(day.startDate));
            }
            columnNode.append(cell);
        }
        grid.append(columnNode);
    }
    return grid;
}

function legend(): HTMLDivElement {
    const node = element("div", "legend");
    node.append(element("span", undefined, "少"));
    for (let level = 0; level <= 4; level += 1) {
        node.append(element("div", `heat-cell level-${level}`));
    }
    node.append(element("span", undefined, "多"));
    return node;
}

function detailItem(label: string, value: string): HTMLDivElement {
    const item = element("div", "detail-item");
    item.append(element("span", undefined, label));
    const strong = element("b", undefined, value);
    item.append(strong);
    return item;
}

function codexDetail(day: HeatmapDay | null, showsWorkflow: boolean): HTMLDivElement {
    const detail = element("div", "detail");
    if (!day) {
        detail.append(element("div", "empty", "点击方格查看当日明细"));
        return detail;
    }
    detail.append(element("div", "card-title", `${day.startDate} 明细`));
    const grid = element("div", "detail-grid");
    grid.append(detailItem("Token", day.tokenCount === null ? "暂无数据" : formatTokens(day.tokenCount)));
    if (showsWorkflow) {
        grid.append(detailItem("会话", String(day.workflow.sessionCount)));
        grid.append(detailItem("对话轮次", String(day.workflow.turnCount)));
        grid.append(detailItem("工具调用", String(day.workflow.toolCallCount)));
        grid.append(detailItem("子 Agent", String(day.workflow.subagentCount)));
        grid.append(detailItem("审批请求", String(day.workflow.permissionRequestCount)));
        grid.append(detailItem("上下文压缩", String(day.workflow.contextCompactionCount)));
        grid.append(detailItem("最长任务", formatDuration(day.workflow.longestTurnMs)));
        if (day.workflow.mostUsedModel) {
            grid.append(detailItem("主要模型", day.workflow.mostUsedModel));
        }
    }
    detail.append(grid);
    if (!showsWorkflow) {
        detail.append(element("div", "empty", "开启 CodexBar Hook 后可查看会话, 轮次, 工具调用和子 Agent 统计"));
    }
    return detail;
}

function renderCodex(section: CodexSection, hook: HookSection): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (section.state !== "ok" && section.message) {
        const notice = element("div", "notice error", section.message);
        nodes.push(notice);
    }

    const account = card("账户");
    const line = element("div", "account-line");
    line.append(element("div", "account-name", section.accountLabel ?? "未登录"));
    if (section.planLabel) {
        line.append(element("span", "badge", section.planLabel));
    }
    account.append(line);
    const meta = element("div", "meta");
    if (section.version) {
        meta.append(element("span", undefined, `Codex ${section.version}`));
    }
    if (section.executableSource) {
        meta.append(element("span", undefined, `来源 ${section.executableSource}`));
    }
    if (section.credits?.hasCredits) {
        meta.append(element("span", undefined, `Credits ${section.credits.unlimited ? "不限" : section.credits.balance ?? ""}`));
    }
    if (section.resetCreditsAvailableCount) {
        meta.append(element("span", undefined, `可用重置 ${section.resetCreditsAvailableCount} 次`));
    }
    account.append(meta);
    nodes.push(account);

    const quota = card("额度窗口", section.isRateLimitsStale ? "缓存数据" : undefined);
    if (section.limits.length === 0) {
        quota.append(element("div", "empty", "暂无额度数据"));
    } else {
        for (const limit of section.limits) {
            const title = element("div", "card-title");
            title.append(element("span", undefined, limit.title));
            quota.append(title);
            for (const window of limit.windows) {
                quota.append(quotaRow(window));
            }
        }
    }
    nodes.push(quota);

    nodes.push(estimateCard(section.estimates));

    const stats = card("Token 用量", section.isUsageStale ? "缓存数据" : undefined);
    const grid = element("div", "stat-grid");
    const local = section.localStats;
    grid.append(statTile(
        "累计 Token",
        formatTokens(section.lifetimeTokens ?? local?.lifetimeTokens ?? null),
        section.lifetimeTokens === null && local ? "本机统计" : undefined
    ));
    grid.append(statTile(
        "单日峰值",
        formatTokens(section.peakDailyTokens ?? local?.peakDailyTokens ?? null),
        section.peakDailyTokens === null && local?.peakDate ? local.peakDate : undefined
    ));
    grid.append(statTile(
        "连续使用",
        `${section.currentStreakDays ?? local?.currentStreakDays ?? 0} 天`,
        `最长 ${section.longestStreakDays ?? local?.longestStreakDays ?? 0} 天`
    ));
    stats.append(grid);
    const second = element("div", "stat-grid");
    second.style.marginTop = "8px";
    const longestMs = section.longestRunningTurnSec !== null
        ? section.longestRunningTurnSec * 1000
        : section.localLongestTurnMs ?? hook.totals.longestTurnMs;
    second.append(statTile("最长任务时长", formatDuration(longestMs)));
    second.append(statTile("活跃天数", `${local?.activeDays ?? 0} 天`, "本机会话统计"));
    second.append(statTile("本机扫描", section.localScanComplete ? "已完成" : "进行中"));
    stats.append(second);
    nodes.push(stats);

    const heat = card("30 周热力图", `${section.heatmap.filter(Boolean).length} 天`);
    heat.append(heatmapGrid(section.heatmap, section.heatmapMaximum, selectedCodexDate, date => {
        selectedCodexDate = date;
        render();
    }));
    heat.append(legend());
    const selected = section.heatmap.find(day => day && day.startDate === selectedCodexDate) ?? null;
    heat.append(codexDetail(selected ?? null, hook.enabled && hook.complete));
    nodes.push(heat);

    nodes.push(hookCard(hook));
    return nodes;
}

function hookCard(hook: HookSection): HTMLDivElement {
    const node = card("CodexBar Hook", hook.enabled ? (hook.verified ? "已生效" : "待校验") : "未开启");
    const row = element("div", "switch-row");
    const label = element("div", "switch-label");
    label.append(element("span", undefined, "启用 Hook 统计"));
    const hint = element("small", undefined, hook.supportsHooks
        ? "写入 ~/.codex/hooks.json, 只添加 CodexBar 自己的 handler"
        : `需要 Codex 0.150.0 或更高版本`);
    label.append(hint);
    row.append(label);
    const toggle = element("input");
    toggle.type = "checkbox";
    toggle.checked = hook.enabled;
    toggle.addEventListener("change", () => {
        toggle.disabled = true;
        void api.setHookEnabled(toggle.checked).then(result => {
            if (!result.ok && result.message) {
                window.setTimeout(() => alert(result.message), 0);
            }
        });
    });
    row.append(toggle);
    node.append(row);

    if (hook.message) {
        node.append(element("div", "notice", hook.message));
    }

    if (hook.enabled) {
        const today = hook.today;
        const grid = element("div", "stat-grid");
        grid.style.marginTop = "8px";
        grid.append(statTile("今日会话", String(today?.sessionCount ?? 0)));
        grid.append(statTile("今日轮次", String(today?.turnCount ?? 0)));
        grid.append(statTile("今日工具", String(today?.toolCallCount ?? 0)));
        node.append(grid);
        const second = element("div", "stat-grid");
        second.style.marginTop = "8px";
        second.append(statTile("今日子 Agent", String(today?.subagentCount ?? 0)));
        second.append(statTile("今日审批", String(today?.permissionRequestCount ?? 0)));
        second.append(statTile("今日最长任务", formatDuration(today?.longestTurnMs ?? null)));
        node.append(second);
        const totals = element("div", "meta");
        totals.append(element("span", undefined, `累计会话 ${hook.totals.sessions}`));
        totals.append(element("span", undefined, `累计轮次 ${hook.totals.turns}`));
        totals.append(element("span", undefined, `累计工具 ${hook.totals.tools}`));
        totals.append(element("span", undefined, `累计子 Agent ${hook.totals.subagents}`));
        node.append(totals);
    } else {
        node.append(element("div", "empty", "开启后可按天统计会话, 对话轮次, 工具调用和子 Agent"));
    }
    if (hook.commandText) {
        const command = element("div", "meta");
        command.append(element("span", undefined, `Hook 命令 ${hook.commandText}`));
        node.append(command);
    }
    return node;
}

function renderClaude(section: ClaudeSection): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    if (!section.available) {
        const empty = card("Claude Code");
        empty.append(element("div", "empty", section.message ?? "未检测到 Claude Code 数据"));
        nodes.push(empty);
        return nodes;
    }
    const account = card("账户");
    const line = element("div", "account-line");
    line.append(element("div", "account-name", section.account?.email ?? "本机 Claude Code"));
    if (section.planLabel) {
        line.append(element("span", "badge", section.planLabel));
    }
    account.append(line);
    const meta = element("div", "meta");
    if (section.account?.organization) {
        meta.append(element("span", undefined, section.account.organization));
    }
    meta.append(element("span", undefined, section.scanComplete ? "本机扫描已完成" : "本机扫描进行中"));
    account.append(meta);
    nodes.push(account);

    const quota = card("额度窗口", section.quota ? `来源 ${section.quota.source}` : undefined);
    if (!section.quota || section.quota.windows.length === 0) {
        quota.append(element("div", "empty", "未找到 Claude 额度记录, 需要客户端留下相应缓存"));
    } else {
        for (const window of section.quota.windows) {
            quota.append(quotaRow({
                kind: "primary",
                label: window.label,
                windowDurationMins: null,
                usedPercent: window.usedPercent,
                remainingPercent: window.remainingPercent,
                resetsAt: window.resetsAt,
                hasData: true
            }));
        }
    }
    nodes.push(quota);

    const stats = card("Token 用量", "本机会话统计");
    const grid = element("div", "stat-grid");
    grid.append(statTile("累计 Token", formatTokens(section.stats?.lifetimeTokens ?? null)));
    grid.append(statTile("单日峰值", formatTokens(section.stats?.peakDailyTokens ?? null), section.stats?.peakDate ?? undefined));
    grid.append(statTile("连续使用", `${section.stats?.currentStreakDays ?? 0} 天`, `最长 ${section.stats?.longestStreakDays ?? 0} 天`));
    stats.append(grid);
    const second = element("div", "stat-grid");
    second.style.marginTop = "8px";
    second.append(statTile("最长任务时长", formatDuration(section.longestTurnMs)));
    second.append(statTile("今日轮次", String(section.today?.turns ?? 0)));
    second.append(statTile("今日工具", String(section.today?.tools ?? 0)));
    stats.append(second);
    nodes.push(stats);

    const heat = card("30 周热力图");
    heat.append(heatmapGrid(section.heatmap, section.heatmapMaximum, selectedClaudeDate, date => {
        selectedClaudeDate = date;
        render();
    }));
    heat.append(legend());
    const selected = section.heatmap.find(day => day && day.startDate === selectedClaudeDate) ?? null;
    const detail = element("div", "detail");
    if (selected) {
        detail.append(element("div", "card-title", `${selected.startDate} 明细`));
        const grid = element("div", "detail-grid");
        grid.append(detailItem("Token", selected.tokenCount === null ? "暂无数据" : formatTokens(selected.tokenCount)));
        detail.append(grid);
    } else {
        detail.append(element("div", "empty", "点击方格查看当日 Token"));
    }
    heat.append(detail);
    nodes.push(heat);
    return nodes;
}

function settingsRow(title: string, hint: string, control: HTMLElement): HTMLDivElement {
    const row = element("div", "switch-row");
    const label = element("div", "switch-label");
    label.append(element("span", undefined, title));
    label.append(element("small", undefined, hint));
    row.append(label);
    row.append(control);
    return row;
}

function renderSettings(settings: Settings, section: CodexSection): HTMLElement[] {
    const node = card("常规");

    const interval = element("select");
    for (const seconds of [30, 60, 120, 300, 600]) {
        const option = element("option", undefined, seconds >= 60 ? `${seconds / 60} 分钟` : `${seconds} 秒`);
        option.value = String(seconds);
        option.selected = settings.refreshIntervalSeconds === seconds;
        interval.append(option);
    }
    interval.addEventListener("change", () => {
        void api.updateSettings({ refreshIntervalSeconds: Number(interval.value) });
    });
    node.append(settingsRow("刷新间隔", "额度与用量的轮询周期", interval));

    const weeks = element("select");
    for (const value of [20, 26, 30, 40, 52]) {
        const option = element("option", undefined, `${value} 周`);
        option.value = String(value);
        option.selected = settings.heatmapWeeks === value;
        weeks.append(option);
    }
    weeks.addEventListener("change", () => {
        void api.updateSettings({ heatmapWeeks: Number(weeks.value) });
    });
    node.append(settingsRow("热力图周数", "主面板热力图显示的周数", weeks));

    const executable = element("input");
    executable.type = "text";
    executable.value = settings.codexExecutablePath ?? "";
    executable.placeholder = section.executablePath ?? "自动查找 codex";
    executable.addEventListener("change", () => {
        void api.updateSettings({ codexExecutablePath: executable.value.trim() || null });
    });
    node.append(settingsRow("codex 路径", "留空时按 PATH 自动查找", executable));

    const claudeToggle = element("input");
    claudeToggle.type = "checkbox";
    claudeToggle.checked = settings.showsClaude;
    claudeToggle.addEventListener("change", () => {
        void api.updateSettings({ showsClaude: claudeToggle.checked });
    });
    node.append(settingsRow("显示 Claude", "读取本机 Claude Code 会话统计", claudeToggle));

    const scanToggle = element("input");
    scanToggle.type = "checkbox";
    scanToggle.checked = settings.scanLocalSessions;
    scanToggle.addEventListener("change", () => {
        void api.updateSettings({ scanLocalSessions: scanToggle.checked });
    });
    node.append(settingsRow("扫描本机会话", "额度估算与本机 Token 统计依赖它", scanToggle));

    const launchToggle = element("input");
    launchToggle.type = "checkbox";
    launchToggle.checked = settings.launchAtLogin;
    launchToggle.addEventListener("change", () => {
        void api.updateSettings({ launchAtLogin: launchToggle.checked });
    });
    node.append(settingsRow("开机自动启动", "登录 Windows 后自动驻留托盘", launchToggle));

    const actions = card("数据与退出");
    const openButton = element("button", undefined, "打开数据目录");
    openButton.addEventListener("click", () => void api.openDataFolder());
    actions.append(settingsRow("本机数据", "Hook 事件, 聚合结果与观测记录", openButton));
    const quitButton = element("button", undefined, "退出 CodexBar");
    quitButton.addEventListener("click", () => void api.quit());
    actions.append(settingsRow("退出", "关闭托盘应用", quitButton));

    return [node, actions];
}

function replaceChildren(container: HTMLElement, nodes: HTMLElement[]): void {
    container.textContent = "";
    for (const node of nodes) {
        container.append(node);
    }
}

function render(): void {
    if (!snapshot) {
        return;
    }
    replaceChildren(
        document.getElementById("tab-codex") as HTMLElement,
        renderCodex(snapshot.codex, snapshot.hook)
    );
    replaceChildren(
        document.getElementById("tab-claude") as HTMLElement,
        renderClaude(snapshot.claude)
    );
    replaceChildren(
        document.getElementById("tab-settings") as HTMLElement,
        renderSettings(snapshot.settings, snapshot.codex)
    );
    const status = document.getElementById("status-text") as HTMLElement;
    const time = document.getElementById("status-time") as HTMLElement;
    status.textContent = statusText(snapshot);
    time.textContent = snapshot.generatedAt
        ? `更新于 ${new Date(snapshot.generatedAt).toLocaleTimeString()}`
        : "";
    (document.getElementById("refresh-state") as HTMLElement).textContent = snapshot.refreshing ? "刷新中" : "";
}

function statusText(current: Snapshot): string {
    switch (current.codex.state) {
        case "ok":
            return current.hook.enabled && current.hook.complete ? "Codex 已连接 · Hook 已启用" : "Codex 已连接";
        case "loading":
            return "正在连接 Codex";
        case "notLoggedIn":
            return "Codex 未登录";
        case "executableNotFound":
            return "未找到 codex";
        case "unsupportedVersion":
            return "Codex 版本过低";
        default:
            return "Codex 连接失败";
    }
}

function selectTab(name: string): void {
    activeTab = name;
    for (const tab of Array.from(document.querySelectorAll(".tab"))) {
        tab.classList.toggle("active", (tab as HTMLElement).dataset.tab === name);
    }
    for (const page of Array.from(document.querySelectorAll(".tab-page"))) {
        page.classList.toggle("active", page.id === `tab-${name}`);
    }
}

function bind(): void {
    for (const tab of Array.from(document.querySelectorAll(".tab"))) {
        tab.addEventListener("click", () => selectTab((tab as HTMLElement).dataset.tab ?? "codex"));
    }
    (document.getElementById("refresh") as HTMLElement).addEventListener("click", () => {
        (document.getElementById("refresh-state") as HTMLElement).textContent = "刷新中";
        void api.refresh("manual");
    });
    api.onSnapshot(next => {
        snapshot = next;
        render();
    });
    void api.getSnapshot().then(next => {
        if (next) {
            snapshot = next;
            render();
        }
    });
}

document.addEventListener("DOMContentLoaded", () => {
    bind();
    selectTab(activeTab);
});
