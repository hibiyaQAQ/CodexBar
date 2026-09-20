import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeUsageStats, formatDuration, formatRelativeReset, formatTokens } from "../core/stats";

test("按日 token 派生累计, 峰值与连续天数", () => {
    const today = new Date(2026, 8, 20);
    const stats = computeUsageStats(
        {
            "2026-09-20": 100,
            "2026-09-19": 400,
            "2026-09-18": 50,
            "2026-09-15": 10,
            "2026-09-14": 10,
            "2026-09-13": 0
        },
        today
    );
    assert.equal(stats.lifetimeTokens, 570);
    assert.equal(stats.peakDailyTokens, 400);
    assert.equal(stats.peakDate, "2026-09-19");
    assert.equal(stats.currentStreakDays, 3);
    assert.equal(stats.longestStreakDays, 3);
    assert.equal(stats.activeDays, 5);
});

test("今天没有用量时连续天数从昨天起算", () => {
    const today = new Date(2026, 8, 20);
    const stats = computeUsageStats({ "2026-09-19": 5, "2026-09-18": 5 }, today);
    assert.equal(stats.currentStreakDays, 2);
});

test("格式化按量级缩写并对空值给出占位", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5K");
    assert.equal(formatTokens(2_500_000), "2.50M");
    assert.equal(formatTokens(null), "暂无数据");
    assert.equal(formatDuration(null), "暂无数据");
    assert.equal(formatDuration(65_000), "1m 5s");
    assert.equal(formatDuration(3_900_000), "1h 5m");
});

test("重置时间按剩余时长展示", () => {
    const now = Date.UTC(2026, 8, 20, 0, 0, 0);
    assert.equal(formatRelativeReset(null, now), "未知");
    assert.equal(formatRelativeReset(Math.trunc(now / 1000) - 10, now), "即将重置");
    assert.equal(formatRelativeReset(Math.trunc(now / 1000) + 1800, now), "30 分钟后");
    assert.equal(formatRelativeReset(Math.trunc(now / 1000) + 7200, now), "2 小时后");
    assert.equal(formatRelativeReset(Math.trunc(now / 1000) + 200000, now), "2 天 7 小时后");
});
