import { strict as assert } from "node:assert";
import { test } from "node:test";
import { accountDisplayName, availableResetExpirations, buildQuotaSnapshot, codexLimit, tokenCountOn, windowLabel } from "../core/quota";

const account = { type: "chatgpt", email: "demo@example.com", planType: "pro" };

test("窗口标签按时长换算成 5h 或 7d", () => {
    assert.equal(windowLabel(300), "5h");
    assert.equal(windowLabel(10080), "7d");
    assert.equal(windowLabel(45), "45m");
    assert.equal(windowLabel(null), "窗口");
});

test("账户展示名优先使用邮箱", () => {
    assert.equal(accountDisplayName(account), "demo@example.com");
    assert.equal(accountDisplayName({ type: "apiKey" }), "API Key");
    assert.equal(accountDisplayName({ type: "chatgpt", email: "" }), "ChatGPT");
});

test("快照合成保留全部窗口并计算剩余比例", () => {
    const snapshot = buildQuotaSnapshot({
        account,
        rateLimits: {
            rateLimits: {
                limitId: "codex",
                planType: "pro",
                primary: { usedPercent: 40, resetsAt: 1_800_000_000, windowDurationMins: 300 },
                secondary: { usedPercent: 92, resetsAt: 1_800_600_000, windowDurationMins: 10080 }
            },
            rateLimitsByLimitId: {
                codex: {
                    limitId: "codex",
                    limitName: "codex",
                    primary: { usedPercent: 40, resetsAt: 1_800_000_000, windowDurationMins: 300 },
                    secondary: { usedPercent: 92, resetsAt: 1_800_600_000, windowDurationMins: 10080 },
                    credits: { balance: "12", hasCredits: true, unlimited: false }
                },
                other: {
                    limitId: "other",
                    limitName: "Another",
                    primary: { usedPercent: 10, resetsAt: null, windowDurationMins: 60 }
                }
            },
            rateLimitResetCredits: {
                availableCount: 2,
                credits: [
                    { id: "a", status: "available", resetType: "codexRateLimits", expiresAt: 2_000_000_000 },
                    { id: "b", status: "used", resetType: "codexRateLimits", expiresAt: 2_000_000_100 }
                ]
            }
        },
        usage: {
            summary: { lifetimeTokens: 1234, peakDailyTokens: 555, currentStreakDays: 3 },
            dailyUsageBuckets: [
                { startDate: "2026-09-19", tokens: 100 },
                { startDate: "2026-09-19", tokens: 50 },
                { startDate: "2026-09-20", tokens: 7 }
            ]
        },
        generatedAt: 1_700_000_000_000
    });

    assert.equal(snapshot.limits.length, 2);
    assert.equal(snapshot.limits[0]?.limitId, "codex");
    assert.equal(snapshot.limits[0]?.windows[0]?.label, "5h");
    assert.equal(snapshot.limits[0]?.windows[0]?.remainingPercent, 60);
    assert.equal(snapshot.limits[0]?.windows[1]?.remainingPercent, 8);
    assert.equal(snapshot.credits?.balance, "12");
    assert.deepEqual(snapshot.resetCreditExpirations, [2_000_000_000]);
    assert.equal(snapshot.planLabel, "pro");
    assert.equal(codexLimit(snapshot)?.limitId, "codex");
    // 同一天的多个 bucket 合并成一个数字
    assert.equal(snapshot.usage?.tokensByDate?.["2026-09-19"], 150);
    assert.equal(tokenCountOn(snapshot.usage, new Date(2026, 8, 20)), 7);
});

test("缺少额度响应时仍然生成快照", () => {
    const snapshot = buildQuotaSnapshot({ account, rateLimits: null, usage: null });
    assert.equal(snapshot.limits.length, 0);
    assert.equal(snapshot.usage, null);
    assert.equal(snapshot.accountLabel, "demo@example.com");
});

test("重置凭证过期时间只保留未来的可用项", () => {
    const now = 1_000;
    const result = availableResetExpirations(
        { availableCount: 1, credits: [{ id: "a", status: "available", resetType: "codexRateLimits", expiresAt: 500 }] },
        now
    );
    assert.equal(result, null);
});
