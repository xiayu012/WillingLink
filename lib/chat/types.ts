/**
 * 多渠道聊天的公共类型。
 *
 * 一句话原则：**WillingLink 的 conversation 才是聊天本体**，网页/小红书/短信/
 * 企业微信只是同一个 conversation 的不同窗口。所以这里没有"某渠道的会话"这种
 * 概念，只有「一条消息从哪个渠道进来的」。
 */

/** 已规划的渠道。新增渠道 = 加一个值 + 写一个 adapter，其它都不用动。 */
export const CHANNELS = ["web", "xhs", "sms", "wecom"] as const;

export type ChannelId = (typeof CHANNELS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" && (CHANNELS as readonly string[]).includes(value)
  );
}

/** 某渠道上的一个外部身份，例如 { channel: "sms", externalUserId: "+14085551234" } */
export type ExternalIdentity = {
  channel: ChannelId;
  /** 该渠道里这个人的唯一 id：xhs userId / 手机号 / wecom external_userid */
  externalUserId: string;
  /**
   * 同一渠道下的多账号场景：哪个客服号/公众号/发件号收到的。
   * 现在全填 null 也能跑，留着是因为以后接第二个小红书号时不用改表。
   */
  accountId?: string | null;
  /** 该渠道里的昵称（小红书帖主用户名等）。只为好认，不参与判重 */
  displayName?: string | null;
};

/** adapter 交给 Chat Engine 的统一输入 */
export type InboundTurn = {
  chatId: string;
  userId: string;
  /** 用户这次说的话（纯文本；富媒体以后再说） */
  text: string;
  /** 消息来源，只是标签，**不因此拆会话** */
  channel: ChannelId;
  /**
   * 渠道自己的消息 id，用来防重复投递（webhook 重试很常见）。
   * 现在只是存下来，去重逻辑等接真实 webhook 时再补。
   */
  externalMessageId?: string | null;
};

/** Chat Engine 的统一输出。怎么把它变成 SSE / JSON / TwiML 是 adapter 的事。 */
export type TurnResult = {
  chatId: string;
  /** 最终回答的纯文本（已去掉 <memory> 块） */
  text: string;
  /** 这一轮用到的工具，便于日志排查 */
  toolsUsed: string[];
  /**
   * 工具的原始返回。adapter 偶尔需要看工具到底查到了什么（例如评论回复要用
   * 真实字段兜底拼装），不给的话它只能自己再调一次工具。
   */
  toolOutputs: unknown[];
  elapsedMs: number;
};
