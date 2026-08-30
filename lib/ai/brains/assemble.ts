import { readDoctrine } from "./loader";
import { getBrain } from "./registry";
import { route } from "./router";
import type { AssembledPrompt, DoctrineModule } from "./types";

export type AssembleOptions = {
  brainId: string;
  /** 用于路由判断的文本，通常是用户这一轮说的话 */
  routeOn: string;
  /**
   * 运行时状态（住户档案、房屋规则、未闭环事项等）。
   * 这一层目前由调用方自己拼，等状态库落地后改为从数据库取。
   */
  runtimeContext?: string;
  /** 强制加载的模块，绕过路由。用于外部已判定情境的场景 */
  forceModules?: string[];
};

function findModule(
  modules: DoctrineModule[],
  id: string
): DoctrineModule | undefined {
  return modules.find((m) => m.id === id);
}

/**
 * 组装一轮对话的 system prompt。
 *
 * 结构：常驻准则 → 情境模块 → 运行时状态
 * 常驻部分放在最前，便于上游做 prompt caching（前缀稳定才能命中缓存）。
 */
export function assembleSystemPrompt(opts: AssembleOptions): AssembledPrompt {
  const brain = getBrain(opts.brainId);
  const routing = route(brain, opts.routeOn);

  const moduleIds = opts.forceModules?.length
    ? [...new Set([...routing.moduleIds, ...opts.forceModules])]
    : routing.moduleIds;

  const parts: string[] = [readDoctrine(brain, brain.always)];

  for (const id of moduleIds) {
    const mod = findModule(brain.situational, id);
    if (!mod) {
      throw new Error(
        `[brains] 大脑 ${brain.id} 的路由指向了不存在的模块：${id}`
      );
    }
    parts.push(readDoctrine(brain, mod));
  }

  if (opts.runtimeContext?.trim()) {
    parts.push(`## 本轮运行时状态\n\n${opts.runtimeContext.trim()}`);
  }

  const system = parts.join("\n\n---\n\n");

  return {
    system,
    brainId: brain.id,
    loadedModuleIds: moduleIds,
    routing,
    chars: system.length,
  };
}
