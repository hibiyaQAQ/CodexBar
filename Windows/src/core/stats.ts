import { dayKey, dayKeyOffset } from "./paths";

export interface UsageStats {
    lifetimeTokens: number;
    peakDailyTokens: number;
    peakDate: string | null;
    currentStreakDays: number;
    longestStreakDays: number;
    activeDays: number;
}

/// 按日 token 表派生累计, 单日峰值与连续使用天数
/// app-server 缺少 summary 或统计 Claude 时都用这一套口径
export function computeUsageStats(tokensByDate: Record<string, number>, today = new Date()): UsageStats {
    const entries = Object.entries(tokensByDate).filter(([, tokens]) => tokens > 0);
    const lifetimeTokens = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
    let peakDailyTokens = 0;
    let peakDate: string | null = null;
    for (const [date, tokens] of entries) {
        if (tokens > peakDailyTokens) {
            peakDailyTokens = tokens;
            peakDate = date;
        }
    }
    const activeDates = new Set(entries.map(([date]) => date));
    const todayKey = dayKey(today);
    let currentStreakDays = 0;
    // 今天还没有用量时从昨天起算, 避免清晨把连续天数清零
    let cursor = activeDates.has(todayKey) ? 0 : -1;
    for (;;) {
        const key = dayKeyOffset(today, cursor);
        if (!activeDates.has(key)) {
            break;
        }
        currentStreakDays += 1;
        cursor -= 1;
    }
    const sorted = [...activeDates].sort();
    let longestStreakDays = 0;
    let running = 0;
    let previous: string | null = null;
    for (const date of sorted) {
        if (previous && nextDay(previous) === date) {
            running += 1;
        } else {
            running = 1;
        }
        longestStreakDays = Math.max(longestStreakDays, running);
        previous = date;
    }
    return {
        lifetimeTokens,
        peakDailyTokens,
        peakDate,
        currentStreakDays,
        longestStreakDays,
        activeDays: activeDates.size
    };
}

function nextDay(date: string): string {
    const parts = date.split("-").map(Number);
    const value = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
    return dayKeyOffset(value, 1);
}

export function formatTokens(value: number | null | undefined): string {
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

export function formatDuration(milliseconds: number | null | undefined): string {
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

/// 重置时间展示为相对时长, 已过期时显示即将重置
export function formatRelativeReset(resetsAtSeconds: number | null, now = Date.now()): string {
    if (resetsAtSeconds === null) {
        return "未知";
    }
    const difference = resetsAtSeconds * 1000 - now;
    if (difference <= 0) {
        return "即将重置";
    }
    const minutes = Math.round(difference / 60_000);
    if (minutes < 60) {
        return `${minutes} 分钟后`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const remainder = minutes % 60;
        return remainder > 0 ? `${hours} 小时 ${remainder} 分后` : `${hours} 小时后`;
    }
    const days = Math.floor(hours / 24);
    const remainderHours = hours % 24;
    return remainderHours > 0 ? `${days} 天 ${remainderHours} 小时后` : `${days} 天后`;
}

export function formatClockTime(resetsAtSeconds: number | null): string {
    if (resetsAtSeconds === null) {
        return "";
    }
    const date = new Date(resetsAtSeconds * 1000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
