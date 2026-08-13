import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EPOCH_ISO = new Date(0).toISOString();

export type CheckedResult = "kept" | "error";

export type CheckedEntry = {
  lastCheckedAt: string;
  result: CheckedResult;
  consecutiveErrors: number;
};

export type CheckedLog = Record<string, CheckedEntry>;

export type CheckedLogSummary = {
  totalCandidates: number;
  neverChecked: number;
  oldestCheckedAt: string | null;
};

/** 读取本地记录文件；不存在或损坏时都安全回退为空记录，不会中断脚本。 */
export async function loadCheckedLog(logPath: string): Promise<CheckedLog> {
  try {
    const raw = await readFile(logPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CheckedLog;
    }
    console.warn(`[log] 记录文件格式不对，忽略并重新开始：${logPath}`);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") {
      console.warn(`[log] 读取记录文件失败，忽略并重新开始：${logPath}`, error);
    }
  }

  return {};
}

/** 先写临时文件再 rename，避免进程被杀掉时写出半截的坏文件。 */
export async function saveCheckedLog(
  logPath: string,
  log: CheckedLog
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const tmpPath = `${logPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(log, null, 2), "utf8");
  await rename(tmpPath, logPath);
}

/** 数据库里已经不存在的 id 从记录中裁掉，防止文件无限增长。 */
export function pruneCheckedLog(
  log: CheckedLog,
  activeIds: ReadonlySet<string>
): CheckedLog {
  return Object.fromEntries(
    Object.entries(log).filter(([id]) => activeIds.has(id))
  );
}

/** 帖子被删除后立即从记录里清掉，不留垂悬数据。 */
export function forgetChecked(log: CheckedLog, id: string): CheckedLog {
  if (!(id in log)) {
    return log;
  }
  return Object.fromEntries(
    Object.entries(log).filter(([entryId]) => entryId !== id)
  );
}

/** 排序用的优先级时间：从未查看过的视为最久远（时间戳 0）。 */
export function priorityTimestamp(log: CheckedLog, id: string): number {
  const entry = log[id];
  if (!entry) {
    return 0;
  }
  const parsed = Date.parse(entry.lastCheckedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 记录一次检查结果。`keepStaleForRetry` 为 true 时不更新时间戳，
 * 让这条帖子仍留在队列前面，下一轮很快重试（用于错误退避的前几次）。
 */
export function recordCheckedResult(
  log: CheckedLog,
  id: string,
  result: CheckedResult,
  options?: { keepStaleForRetry?: boolean }
): CheckedLog {
  const previous = log[id];
  const consecutiveErrors =
    result === "error" ? (previous?.consecutiveErrors ?? 0) + 1 : 0;
  const lastCheckedAt = options?.keepStaleForRetry
    ? (previous?.lastCheckedAt ?? EPOCH_ISO)
    : new Date().toISOString();

  return {
    ...log,
    [id]: { lastCheckedAt, result, consecutiveErrors },
  };
}

export function summarizeCheckedLog(
  log: CheckedLog,
  activeIds: readonly string[]
): CheckedLogSummary {
  let neverChecked = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let oldestAt: string | null = null;

  for (const id of activeIds) {
    const entry = log[id];
    if (!entry) {
      neverChecked += 1;
      continue;
    }

    const parsed = Date.parse(entry.lastCheckedAt);
    if (Number.isFinite(parsed) && parsed < oldestMs) {
      oldestMs = parsed;
      oldestAt = entry.lastCheckedAt;
    }
  }

  return {
    totalCandidates: activeIds.length,
    neverChecked,
    oldestCheckedAt: oldestAt,
  };
}
