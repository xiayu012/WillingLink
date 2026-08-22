/**
 * 把回复投递给集简云（小红书私信的出站通道）。
 *
 * 为什么是"投递"而不是"返回"：集简云调我们只等 **30 秒**，而一轮带搜索的对话
 * 要 15-30 秒，压线必挂。所以拆成两次单向消息——它 POST 进来我们立刻应答，
 * 想好了再 POST 回去。
 *
 * URL 走环境变量：这个仓库是公开的，而这个 webhook **没有任何鉴权**，写死在
 * 代码里等于谁都能往用户的自动化流程里灌消息。没配就不投递，只在日志里说清楚。
 */

export type JijyunDelivery = {
  /** 小红书用户 id，集简云靠它知道回给谁 */
  id: string;
  /** 已经剔过联系方式的回复；失败时为空字符串 */
  text: string;
  /**
   * 这一轮有没有在叫对方留联系方式（`wantsContactCollection` 判的）。
   * 集简云那边按它决定要不要挂留资组件，所以**必须每次都出现在 body 里**，
   * 不能靠"没有这个字段就是 false"——下游取不到字段的行为不归我们控制。
   */
  collectContact?: boolean;
  chatId?: string;
  ok?: boolean;
  error?: string;
};

export async function deliverToJijyun(
  payload: JijyunDelivery
): Promise<{ delivered: boolean; status?: number; detail?: string }> {
  const url = process.env.JIJYUN_WEBHOOK_URL?.trim();
  if (!url) {
    console.log(
      "[jijyun] 未配置 JIJYUN_WEBHOOK_URL，跳过投递",
      JSON.stringify({ id: payload.id, chars: payload.text.length })
    );
    return { delivered: false, detail: "JIJYUN_WEBHOOK_URL not set" };
  }

  // 集简云那边的字段名是 snake_case；`collect_contact` **默认 false 且总是带上**
  const { collectContact = false, ...rest } = payload;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        ...rest,
        collect_contact: collectContact,
      }),
    });
    // 集简云成功时回 {"Code":200,"Data":null,"Msg":"成功"}
    const detail = (await response.text()).slice(0, 200);
    const delivered = response.ok;
    console.log(
      delivered ? "[jijyun] 已投递" : "[jijyun] 投递失败",
      JSON.stringify({
        id: payload.id,
        chatId: payload.chatId,
        chars: payload.text.length,
        collectContact,
        status: response.status,
        detail,
      })
    );
    return { delivered, status: response.status, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      "[jijyun] 投递异常",
      JSON.stringify({ id: payload.id, message })
    );
    return { delivered: false, detail: message };
  }
}
