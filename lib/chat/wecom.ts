import "server-only";

import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/**
 * 企业微信渠道的加解密与出站。
 *
 * 与 `lib/chat/twilio.ts` 平级：**一个渠道一个文件，只放该渠道特有的东西**
 * （验签、加解密、出站投递、分段），大脑与业务逻辑一律不放这里。
 *
 * 企业微信比短信麻烦的三点，也是这个文件存在的理由：
 *   1. 配置回调地址时会先打一个 GET 带 echostr，**必须解密后原样回明文**，
 *      否则后台不让你保存配置。
 *   2. 消息体是 **AES 加密的 XML**，不是 JSON。
 *   3. 被动回复只有 5 秒，而一轮对话要几十秒 —— 所以先回空串，
 *      答案走「应用消息」接口异步推送（跟 Twilio 那条踩过的是同一个坑）。
 */

export type WecomConfig = {
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  aesKey: string;
};

export function wecomConfig(): WecomConfig | null {
  const corpId = process.env.WECOM_CORP_ID?.trim();
  const agentId = process.env.WECOM_AGENT_ID?.trim();
  const secret = process.env.WECOM_SECRET?.trim();
  const token = process.env.WECOM_TOKEN?.trim();
  const aesKey = process.env.WECOM_ENCODING_AES_KEY?.trim();
  if (!(corpId && agentId && secret && token && aesKey)) {
    return null;
  }
  return { corpId, agentId, secret, token, aesKey };
}

/**
 * 从一段 XML 里取某个标签的文本，兼容 CDATA。
 *
 * 不用动态拼正则：`new RegExp` 里的反斜杠要过两层转义，写错了不会报错，
 * 只会静默匹配不到（踩过一次）。字符串切片没有这个问题，也够快。
 */
export function xmlValue(xml: string, tag: string): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const i = xml.indexOf(open);
  if (i === -1) {
    return "";
  }
  const j = xml.indexOf(close, i + open.length);
  if (j === -1) {
    return "";
  }
  let body = xml.slice(i + open.length, j).trim();
  if (body.startsWith("<![CDATA[") && body.endsWith("]]>")) {
    body = body.slice(9, -3);
  }
  return body.trim();
}

/**
 * 签名 = sha1(把 token / timestamp / nonce / 密文 四个字符串排序后直接拼起来)。
 * 注意是**字典序排序**，不是固定顺序——顺序写错会一直 403 且看不出原因。
 */
export function wecomSignature(args: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): string {
  const joined = [args.token, args.timestamp, args.nonce, args.encrypt]
    .sort()
    .join("");
  return createHash("sha1").update(joined).digest("hex");
}

export function verifyWecomSignature(args: {
  config: WecomConfig;
  msgSignature: string | null;
  timestamp: string | null;
  nonce: string | null;
  encrypt: string;
}): boolean {
  if (!(args.msgSignature && args.timestamp && args.nonce)) {
    return false;
  }
  const expected = wecomSignature({
    token: args.config.token,
    timestamp: args.timestamp,
    nonce: args.nonce,
    encrypt: args.encrypt,
  });
  const a = Buffer.from(expected);
  const b = Buffer.from(args.msgSignature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 解密。明文结构是：
 *   随机 16 字节 + 4 字节大端消息长度 + 消息本体 + receiveid(corpid)
 *
 * 末尾的 receiveid 必须核对 —— 那是防止别人拿自己的密文往你这儿灌。
 */
export function decryptWecom(config: WecomConfig, encrypted: string): string {
  const key = Buffer.from(`${config.aesKey}=`, "base64");
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);

  // 手工去 PKCS#7 填充：企业微信用的是自定义补位，交给 node 自动去有时会炸
  const pad = raw[raw.length - 1];
  const body = pad >= 1 && pad <= 32 ? raw.subarray(0, raw.length - pad) : raw;

  const msgLen = body.readUInt32BE(16);
  const message = body.subarray(20, 20 + msgLen).toString("utf8");
  const receiveId = body.subarray(20 + msgLen).toString("utf8");

  if (receiveId !== config.corpId) {
    throw new Error(`[wecom] receiveid 不匹配：收到 ${receiveId}`);
  }
  return message;
}

// ── 出站 ────────────────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

/** access_token 有效期 7200 秒且**有调用频率上限**，必须缓存，不能每条消息取一次。 */
export async function getWecomAccessToken(
  config: WecomConfig
): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const url =
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken" +
    `?corpid=${encodeURIComponent(config.corpId)}` +
    `&corpsecret=${encodeURIComponent(config.secret)}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    errcode?: number;
    errmsg?: string;
    access_token?: string;
    expires_in?: number;
  };
  if (data.errcode || !data.access_token) {
    console.log("[wecom] 取 access_token 失败：", data.errcode, data.errmsg);
    return null;
  }
  cachedToken = {
    value: data.access_token,
    // 提前 5 分钟过期，避免边界上拿到刚失效的
    expiresAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000,
  };
  return cachedToken.value;
}

/**
 * 主动推送一条文本。被动回复只有 5 秒，正经答案都走这里。
 *
 * ⚠️ **errcode 60020 = 出站 IP 不在「企业可信IP」白名单里**，不是代码问题。
 * 企业微信对 message/send 这类接口做来源 IP 校验，要在
 * 「应用管理 → 自建应用 → 拉到底 → 企业可信IP」里加。
 * 错误信息里会带 `from ip: x.x.x.x`，加那个就行。
 *
 * **这跟无服务器是天然冲突的**：Vercel 的出站 IP 不保证固定。
 * 现在的做法是把观察到的 IP 加进去，失效了就再加。
 * 真要稳，得把出站走一个固定 IP 的中转（或 Vercel 的静态出口 IP 方案）。
 */
export async function sendWecomText(args: {
  config: WecomConfig;
  toUser: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const accessToken = await getWecomAccessToken(args.config);
  if (!accessToken) {
    return { ok: false, error: "no access_token" };
  }
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: args.toUser,
        msgtype: "text",
        agentid: Number(args.config.agentId),
        text: { content: args.text },
        safe: 0,
      }),
    }
  );
  const data = (await res.json()) as { errcode?: number; errmsg?: string };
  if (data.errcode) {
    // 40014/42001 = token 失效，清掉缓存下次重取
    if (data.errcode === 40014 || data.errcode === 42001) {
      cachedToken = null;
    }
    return { ok: false, error: `${data.errcode} ${data.errmsg}` };
  }
  return { ok: true };
}
