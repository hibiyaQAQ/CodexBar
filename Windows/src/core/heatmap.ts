import { DailyMetrics, emptyMetrics, metricsByDate } from "./workflow";
import { UsageView, tokenCountOn } from "./quota";
import { dayKey } from "./paths";

export const heatmapRowCount = 7;
export const heatmapColumnCount = 30;

export type TokenState =
    | { kind: "available"; count: number }
    | { kind: "pending" }
    | { kind: "unavailable" };

export interface HeatmapDay {
    startDate: string;
    tokenState: TokenState;
    tokenCount: number | null;
    workflow: DailyMetrics;
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function sundayStartOfWeek(date: Date): Date {
    return addDays(date, -date.getDay());
}

/// 固定按列为周, 行从周日开始; 未来日期返回 null 由 UI 留空
export function weekGridDates(columnCount: number, endingDaysAgo: number, today: Date): Array<Date | null> {
    if (columnCount <= 0) {
        return [];
    }
    const lastVisible = addDays(startOfDay(today), -Math.max(endingDaysAgo, 0));
    const currentWeekStart = sundayStartOfWeek(lastVisible);
    const firstWeekStart = addDays(currentWeekStart, -(columnCount - 1) * 7);
    const cells: Array<Date | null> = [];
    for (let column = 0; column < columnCount; column += 1) {
        const weekStart = addDays(firstWeekStart, column * 7);
        for (let row = 0; row < heatmapRowCount; row += 1) {
            const date = addDays(weekStart, row);
            cells.push(date.getTime() <= lastVisible.getTime() ? date : null);
        }
    }
    return cells;
}

export interface HeatmapInput {
    usage: UsageView | null;
    workflowMetrics: DailyMetrics[];
    showsWorkflow: boolean;
    columnCount?: number;
    today?: Date;
    /// app-server 缺少按日 bucket 时用本机 rollout 统计兜底
    localTokensByDate?: Record<string, number> | null;
}

export function buildHeatmap(input: HeatmapInput): Array<HeatmapDay | null> {
    const today = input.today ?? new Date();
    const columnCount = input.columnCount ?? heatmapColumnCount;
    const local = input.localTokensByDate ?? null;
    const hasDailyBuckets = input.usage?.hasDailyBuckets === true || (local !== null && Object.keys(local).length > 0);
    const todayString = dayKey(today);
    const todayTokenCount = tokenCountOn(input.usage, today) ?? local?.[todayString] ?? null;
    // Hook 开启时当天工作流统计可见; Hook 关闭时只在 token 已返回时展示今天
    const endingDaysAgo = input.showsWorkflow || todayTokenCount !== null ? 0 : 1;
    const workflowByDate = metricsByDate(input.workflowMetrics);

    return weekGridDates(columnCount, endingDaysAgo, today).map(date => {
        if (!date) {
            return null;
        }
        const startDate = dayKey(date);
        let tokenState: TokenState;
        if (!hasDailyBuckets) {
            tokenState = { kind: "unavailable" };
        } else if (startDate === todayString && todayTokenCount !== null) {
            tokenState = { kind: "available", count: todayTokenCount };
        } else if (startDate === todayString) {
            tokenState = { kind: "pending" };
        } else {
            tokenState = {
                kind: "available",
                count: tokenCountOn(input.usage, date) ?? local?.[startDate] ?? 0
            };
        }
        return {
            startDate,
            tokenState,
            tokenCount: tokenState.kind === "available" ? tokenState.count : null,
            workflow: workflowByDate.get(startDate) ?? emptyMetrics(startDate)
        };
    });
}

/// 单元格配色分五档, 与 macOS 版一样按当期最大值归一
export function heatmapLevel(tokens: number, maximum: number): number {
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

export function heatmapMaximum(days: Array<HeatmapDay | null>): number {
    return days.reduce((maximum, day) => Math.max(maximum, day?.tokenCount ?? 0), 0);
}
