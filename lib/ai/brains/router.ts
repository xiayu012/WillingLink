import type { Brain, RoutingDecision } from "./types";

const DEFAULT_MAX_SITUATIONAL = 2;

/**
 * 按关键词规则决定这一轮加载哪些情境模块。
 *
 * 为什么不用向量检索：情境模块只有个位数，类别边界清晰，
 * 规则命中率高于 embedding 相似度，而且可解释、可测试、出错时知道原因。
 * 等模块涨到几十份、或需要检索各州法规这类长尾，再引入检索。
 */
export function route(brain: Brain, text: string): RoutingDecision {
  const trace: RoutingDecision["trace"] = [];
  const forced = new Set<string>();
  const matched: string[] = [];
  let exclusive: string[] | null = null;

  for (const rule of brain.routes) {
    const hit = rule.match.find((re) => re.test(text));
    if (!hit) {
      continue;
    }

    const reason = rule.reason ?? `命中 ${hit.source}`;

    if (rule.force) {
      for (const id of rule.modules) {
        if (!forced.has(id)) {
          forced.add(id);
          trace.push({ moduleId: id, reason, forced: true });
        }
      }
      continue;
    }

    // 第一条命中的 exclusive 规则锁定非 force 部分
    if (rule.exclusive && exclusive === null) {
      exclusive = rule.modules;
      trace.push(
        ...rule.modules.map((id) => ({
          moduleId: id,
          reason: `${reason}（独占，短路其余规则）`,
          forced: false,
        }))
      );
      continue;
    }

    if (exclusive !== null) {
      continue;
    }

    for (const id of rule.modules) {
      if (!matched.includes(id)) {
        matched.push(id);
        trace.push({ moduleId: id, reason, forced: false });
      }
    }
  }

  const cap = brain.maxSituational ?? DEFAULT_MAX_SITUATIONAL;
  const pool = exclusive ?? matched;
  // force 的不占额度——安全类漏加载的代价远高于多占的上下文
  const kept = pool.filter((id) => !forced.has(id)).slice(0, cap);

  let moduleIds = [...forced, ...kept];

  if (moduleIds.length === 0) {
    moduleIds = brain.fallback;
    for (const id of moduleIds) {
      trace.push({ moduleId: id, reason: "无规则命中，走兜底", forced: false });
    }
  }

  return { moduleIds, trace };
}
