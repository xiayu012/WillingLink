import type { Brain } from "./types";

const brains = new Map<string, Brain>();

export function registerBrain(brain: Brain): void {
  if (brains.has(brain.id)) {
    throw new Error(`[brains] 大脑 id 重复注册：${brain.id}`);
  }
  brains.set(brain.id, brain);
}

export function getBrain(id: string): Brain {
  const brain = brains.get(id);
  if (!brain) {
    const known = [...brains.keys()].join(", ") || "（空）";
    throw new Error(`[brains] 未注册的大脑：${id}。已注册：${known}`);
  }
  return brain;
}

export function listBrains(): Brain[] {
  return [...brains.values()];
}

/** 仅测试用 */
export function resetBrains(): void {
  brains.clear();
}
