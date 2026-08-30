/**
 * 「大脑」模块入口。
 *
 * 一个大脑 = 常驻准则 + 情境模块 + 路由规则。
 * 目的是让多个 AI 产品（合租房管理、租房搜索…）共用同一套准则组装机制，
 * 而各自的准则内容互相隔离。
 *
 * 用法：
 *   import { assembleSystemPrompt } from "@/lib/ai/brains";
 *   const { system } = assembleSystemPrompt({
 *     brainId: "coliving",
 *     routeOn: userMessage,
 *     runtimeContext: houseAndResidentState,
 *   });
 *
 * 注意：只能在服务端调用（doctrine 走 fs 读取）。
 */

import { colivingBrain } from "./coliving";
import { listBrains, registerBrain } from "./registry";

// 注册。新增大脑时在这里加一行。
if (listBrains().length === 0) {
  registerBrain(colivingBrain);
}

export { assembleSystemPrompt } from "./assemble";
export type { AssembleOptions } from "./assemble";
export { clearDoctrineCache } from "./loader";
export { getBrain, listBrains } from "./registry";
export { route } from "./router";
export type {
  AssembledPrompt,
  Brain,
  DoctrineModule,
  RouteRule,
  RoutingDecision,
} from "./types";
