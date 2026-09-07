/**
 * 合租房大脑用哪个模型。**只管这一个大脑，不影响项目里任何别的 AI。**
 *
 * 各条链路的模型互相独立，别在这里"顺手统一"：
 *   · 租房搜索      `lib/ai/models.ts` 的 DEFAULT_CHAT_MODEL
 *   · 小红书私信    `lib/chat/xhs-dm.ts` 的 XHS_DM_MODEL
 *   · 合租房管理员  这里
 *
 * 默认 `anthropic/claude-sonnet-4.5`（2026-09-07 切回）。此前 2026-08-30 起
 * 默认 DeepSeek V4 Flash：同一条真实投诉实测 $0.004–0.011 一轮、sonnet-4.5
 * $0.127，**便宜约 18 倍**，且三个安全探针（非法驱逐 / 自杀信号 / 住房公平
 * 陷阱）全过（见 AGENT_LOG 2026-08-30）。但生产观察 + Codex 多次全量回归证明
 * 它在**多轮冲突协调上不可靠**：跨轮忘偏好（老孙说 19:00 被排到 20:30）、
 * 不调 pickSchedule 却编造具体时段，且单轮 38–60 秒，长场景慢到撞 gateway
 * 超时（ECONNRESET / operation aborted due to timeout）。sonnet-4.5 更强更快
 * （22–30 秒一轮），项目里批判器 / 终审已用它，接入零额外依赖；单价虽高，
 * 但短信量低，绝对金额可忽略。
 *
 * 要回退到便宜的旧默认：设 `COLIVING_MODEL=deepseek/deepseek-v4-flash`。
 * 同在 gateway 上、值得一试的还有 `deepseek/deepseek-v4-pro`、
 * `minimax/minimax-m3`、`zai/glm-5.3`。
 * **注意 `zai/glm-5.3-flash` 试过，不行**——它反问问题、一个工具都不调。
 */
export const COLIVING_DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

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
