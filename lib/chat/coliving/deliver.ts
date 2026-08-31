import "server-only";

import { sendSms } from "@/lib/chat/twilio";

export { markCommunication } from "./repo";

/**
 * 投递一条主动消息。
 *
 * 独立成一层，是为了给 cron 一个统一的"发不出去也别炸"的出口：
 * 主动发起是批量的，一个号码发失败不该让整轮 cron 挂掉。
 */
export async function sendSmsOrSkip(
  to: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await sendSms(to, text);
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? "unknown" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
