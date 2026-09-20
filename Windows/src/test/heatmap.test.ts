import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildHeatmap, heatmapLevel, heatmapMaximum, weekGridDates } from "../core/heatmap";
import { emptyMetrics } from "../core/workflow";
import { usageView } from "../core/quota";
import { dayKey } from "../core/paths";

test("周历网格按列成周, 未来日期留空", () => {
    // 2026-09-20 是周日, 当周只有第一格有效
    const today = new Date(2026, 8, 20);
    const cells = weekGridDates(30, 0, today);
    assert.equal(cells.length, 210);
    assert.equal(cells[209], null);
    assert.equal(dayKey(cells[203] as Date), "2026-09-20");
    assert.equal(dayKey(cells[0] as Date), "2026-03-01");
});

test("Hook 关闭且今天没有 token 时不显示今天", () => {
    const today = new Date(2026, 8, 20);
    const usage = usageView({
        summary: {},
        dailyUsageBuckets: [{ startDate: "2026-09-19", tokens: 120 }]
    });
    const days = buildHeatmap({ usage, workflowMetrics: [], showsWorkflow: false, columnCount: 4, today });
    const keys = days.filter(Boolean).map(day => day?.startDate);
    assert.equal(keys.includes("2026-09-20"), false);
    assert.equal(keys.includes("2026-09-19"), true);
    assert.equal(days.find(day => day?.startDate === "2026-09-19")?.tokenCount, 120);
});

test("Hook 开启时今天可见, 缺少 token 记为待补", () => {
    const today = new Date(2026, 8, 20);
    const usage = usageView({ summary: {}, dailyUsageBuckets: [{ startDate: "2026-09-19", tokens: 10 }] });
    const metrics = { ...emptyMetrics("2026-09-20"), sessionCount: 2, turnCount: 3 };
    const days = buildHeatmap({ usage, workflowMetrics: [metrics], showsWorkflow: true, columnCount: 4, today });
    const todayCell = days.find(day => day?.startDate === "2026-09-20");
    assert.ok(todayCell);
    assert.equal(todayCell.tokenState.kind, "pending");
    assert.equal(todayCell.workflow.turnCount, 3);
});

test("缺少 app-server bucket 时使用本机统计兜底", () => {
    const today = new Date(2026, 8, 20);
    const days = buildHeatmap({
        usage: null,
        workflowMetrics: [],
        showsWorkflow: true,
        columnCount: 3,
        today,
        localTokensByDate: { "2026-09-18": 900, "2026-09-20": 100 }
    });
    assert.equal(days.find(day => day?.startDate === "2026-09-18")?.tokenCount, 900);
    assert.equal(days.find(day => day?.startDate === "2026-09-20")?.tokenCount, 100);
    assert.equal(heatmapMaximum(days), 900);
});

test("热力等级按当期最大值归一", () => {
    assert.equal(heatmapLevel(0, 100), 0);
    assert.equal(heatmapLevel(20, 100), 1);
    assert.equal(heatmapLevel(50, 100), 2);
    assert.equal(heatmapLevel(70, 100), 3);
    assert.equal(heatmapLevel(100, 100), 4);
});
