import "server-only";

/**
 * 单次模型调用的时限。
 *
 * ## 为什么需要
 *
 * 2026-09-02 生产环境两次 120 秒超时，住户完全收不到回复。
 * 日志里能看到**单次外部调用就花了 117.81 秒**——一个卡住的调用
 * 吃光了整个函数预算，后面的步骤一个都没跑成。
 *
 * 一轮现在的调用数不少：生成器 2–3 次 + 回复审稿 1 次 +
 * 每条主动消息各审 1 次 + 打回后重写 1 次。**任何一次卡住都会连累全部。**
 *
 * ## 分档的理由
 *
 * 生成器是主线，卡了就没回复，给得宽一点；
 * **批判器是加分项**，超时按放行处理（见 critic.ts），给得紧一点——
 * 宁可少审一次，也不能因为审稿把回复拖没了。
 */

/** 生成一轮回复。留够多步工具调用的时间 */
export const GENERATE_TIMEOUT_MS = Number(
  process.env.COLIVING_GENERATE_TIMEOUT_MS ?? 75_000
);

/** 审稿。短提示词、无工具，正常几秒就回 */
export const CRITIC_TIMEOUT_MS = Number(
  process.env.COLIVING_CRITIC_TIMEOUT_MS ?? 20_000
);

/** 打回后的重写。比首次生成短，因为不带工具 */
export const REWRITE_TIMEOUT_MS = Number(
  process.env.COLIVING_REWRITE_TIMEOUT_MS ?? 30_000
);

/**
 * `AbortSignal.timeout` 的薄封装。
 * 单独放一个函数是为了让调用点读起来是「这一步最多花多久」，
 * 而不是散落的魔法数字。
 */
export function deadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}
