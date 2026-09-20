import { strict as assert } from "node:assert";
import { test } from "node:test";
import { estimateWindows, loadObservations, recordObservations, saveObservations, windowKey, windowStartMs } from "../core/estimate";
import { QuotaLimitView, QuotaWindowView } from "../core/quota";
import { RolloutState, loadRolloutState } from "../core/rollouts";
import { makeSandbox } from "./support";

const resetsAt = Math.trunc(Date.UTC(2026, 8, 20, 6, 0, 0) / 1000);
const windowStart = Date.UTC(2026, 8, 20, 1, 0, 0);

function primaryWindow(usedPercent: number): QuotaWindowView {
    return {
        kind: "primary",
        label: "5h",
        windowDurationMins: 300,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt,
        hasData: true
    };
}

function limitWith(usedPercent: number): QuotaLimitView {
    return { limitId: "codex", title: "Codex", windows: [primaryWindow(usedPercent)] };
}

function stateWithTokens(base: RolloutState, events: Array<{ at: number; tokens: number }>): RolloutState {
    return { ...base, tokenEvents: events };
}

test("窗口起点由重置时间与时长推算", () => {
    const window = primaryWindow(10);
    assert.equal(windowStartMs(window), windowStart);
    assert.equal(windowKey("codex", window), `codex:primary:${resetsAt}`);
});

test("两次观测的百分比差值推算窗口总额度", () => {
    const sandbox = makeSandbox("estimate");
    try {
        const base = loadRolloutState(sandbox.environment);
        let store = loadObservations(sandbox.environment);
        store = recordObservations(store, {
            limit: limitWith(10),
            rollouts: stateWithTokens(base, [{ at: windowStart + 60_000, tokens: 1000 }]),
            now: new Date(windowStart + 120_000)
        });
        store = recordObservations(store, {
            limit: limitWith(30),
            rollouts: stateWithTokens(base, [
                { at: windowStart + 60_000, tokens: 1000 },
                { at: windowStart + 600_000, tokens: 2000 }
            ]),
            now: new Date(windowStart + 700_000)
        });
        saveObservations(store, sandbox.environment);

        const estimates = estimateWindows(loadObservations(sandbox.environment), limitWith(30));
        const primary = estimates[0];
        assert.ok(primary);
        // 20 个百分点消耗 2000 token, 推出整窗 10000 token
        assert.equal(primary.totalTokens, 10_000);
        assert.equal(primary.usedTokens, 3_000);
        assert.equal(primary.remainingTokens, 7_000);
        assert.equal(primary.confidence, "high");
        assert.equal(primary.sampleCount, 2);
    } finally {
        sandbox.dispose();
    }
});

test("只有一次观测且用量偏低时不给出估算", () => {
    const sandbox = makeSandbox("estimate");
    try {
        const base = loadRolloutState(sandbox.environment);
        const store = recordObservations(loadObservations(sandbox.environment), {
            limit: limitWith(2),
            rollouts: stateWithTokens(base, [{ at: windowStart + 60_000, tokens: 100 }]),
            now: new Date(windowStart + 120_000)
        });
        const estimates = estimateWindows(store, limitWith(2));
        assert.equal(estimates[0]?.totalTokens, null);
        assert.equal(estimates[0]?.confidence, "none");
        assert.equal(estimates[0]?.remainingPercent, 98);
    } finally {
        sandbox.dispose();
    }
});

test("单点用量足够大时按比例外推", () => {
    const sandbox = makeSandbox("estimate");
    try {
        const base = loadRolloutState(sandbox.environment);
        const store = recordObservations(loadObservations(sandbox.environment), {
            limit: limitWith(40),
            rollouts: stateWithTokens(base, [{ at: windowStart + 60_000, tokens: 4000 }]),
            now: new Date(windowStart + 120_000)
        });
        const estimates = estimateWindows(store, limitWith(40));
        assert.equal(estimates[0]?.totalTokens, 10_000);
        assert.equal(estimates[0]?.confidence, "medium");
    } finally {
        sandbox.dispose();
    }
});

test("历史窗口给出参考值供新窗口使用", () => {
    const sandbox = makeSandbox("estimate");
    try {
        const base = loadRolloutState(sandbox.environment);
        let store = loadObservations(sandbox.environment);
        store = recordObservations(store, {
            limit: limitWith(10),
            rollouts: stateWithTokens(base, [{ at: windowStart + 10_000, tokens: 1000 }]),
            now: new Date(windowStart + 20_000)
        });
        store = recordObservations(store, {
            limit: limitWith(50),
            rollouts: stateWithTokens(base, [
                { at: windowStart + 10_000, tokens: 1000 },
                { at: windowStart + 30_000, tokens: 5000 }
            ]),
            now: new Date(windowStart + 40_000)
        });

        // 下一个窗口刚开始, 当前样本不足时使用历史中位数
        const nextResetsAt = resetsAt + 5 * 3600;
        const nextWindow: QuotaWindowView = {
            kind: "primary",
            label: "5h",
            windowDurationMins: 300,
            usedPercent: 1,
            remainingPercent: 99,
            resetsAt: nextResetsAt,
            hasData: true
        };
        const nextLimit: QuotaLimitView = { limitId: "codex", title: "Codex", windows: [nextWindow] };
        const estimates = estimateWindows(store, nextLimit);
        // 历史窗口两次观测相差 40 个百分点与 5000 token
        assert.equal(estimates[0]?.referenceTotalTokens, 12_500);
        assert.equal(estimates[0]?.totalTokens, 12_500);
        assert.equal(estimates[0]?.confidence, "low");
    } finally {
        sandbox.dispose();
    }
});
