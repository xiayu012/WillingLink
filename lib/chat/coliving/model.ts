/**
 * 合租房大脑用哪个模型。**只管这一个大脑，不影响项目里任何别的 AI。**
 *
 * 各条链路的模型互相独立，别在这里"顺手统一"：
 *   · 租房搜索      `lib/ai/models.ts` 的 DEFAULT_CHAT_MODEL
 *   · 小红书私信    `lib/chat/xhs-dm.ts` 的 XHS_DM_MODEL
 *   · 合租房管理员  这里
 *
 * 默认 `deepseek/deepseek-v4-flash`（老板 2026-09-07 拍板：**不上 opus、保持
 * 便宜**）。同一条真实投诉它 $0.004–0.011 一轮、sonnet-4.5 $0.127，便宜约 18 倍，
 * 三个安全探针（非法驱逐 / 自杀信号 / 住房公平陷阱）全过（见 AGENT_LOG 2026-08-30）。
 * 它在多轮冲突协调上的不可靠（跨轮忘偏好 / 编时段 / 慢到撞 gateway 超时）已由
 * **确定性代码**兜底：软偏好注入、自动补发漏人、6.x 打回重算、简单肯定短路等，
 * 不再靠换贵模型硬扛。
 *
 * 想临时换更强模型验一把：设 `COLIVING_MODEL=anthropic/claude-sonnet-4.5`。
 * 同在 gateway 上、值得一试的还有 `deepseek/deepseek-v4-pro`、
 * `minimax/minimax-m3`、`zai/glm-5.3`。
 * **注意 `zai/glm-5.3-flash` 试过，不行**——它反问问题、一个工具都不调。
 */
export const COLIVING_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export function colivingModelId(): string {
  return process.env.COLIVING_MODEL?.trim() || COLIVING_DEFAULT_MODEL;
}

/**
 * 影子跑（`lib/chat/coliving/shadow.ts`）候选版本要不要换一个模型跑，
 * 从而做真正的 A/B。不设就返回 `null`，调用方应当退回跟生产同一个模型——
 * 那种情况下影子跑提供的是"候选路径端到端可用性 + 语料沉淀"，**不提供
 * 模型差异对比**，这一点由调用方如实记录，不要假装是 A/B。
 *
 * `runColivingTurn` 早就支持 `modelId` 参数覆盖（原本是给测试用的），
 * 这里只是把它接到影子跑上。
 */
export function shadowCandidateModelId(): string | null {
  return process.env.COLIVING_SHADOW_MODEL?.trim() || null;
}
