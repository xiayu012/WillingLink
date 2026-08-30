import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio 渠道的底层工具：验签、TwiML、出站发送、分段。
 *
 * 认证用的是 **API Key**（`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`）而不是
 * Auth Token —— API Key 可单独吊销，泄露了不用换整个账号。
 *
 * 但**验签只能用 Auth Token**：`X-Twilio-Signature` 是 Twilio 用账号的 Auth Token
 * 算的 HMAC-SHA1，API Key Secret 算不出来。所以 `TWILIO_AUTH_TOKEN` 是另外一个变量，
 * 只用于验签，不用于发送。
 */

// ─────────────────────────── 验签 ───────────────────────────

export type VerifyResult =
  | { ok: true; mode: "verified" | "skipped-insecure" }
  | { ok: false; reason: string };

/**
 * 校验 `X-Twilio-Signature`。
 *
 * 算法（Twilio 文档）：把请求 URL 与**按 key 排序后的 POST 参数**依次拼接成
 * `url + k1 + v1 + k2 + v2 + ...`，用 Auth Token 做 HMAC-SHA1，base64 后比对。
 *
 * URL 必须与 Twilio 实际请求的完全一致。反向代理后面 `request.url` 常常是内网地址，
 * 所以优先用 `TWILIO_WEBHOOK_URL` 显式指定；没配就用转发头重建。
 */
export function verifyTwilioSignature(args: {
  request: Request;
  params: Record<string, string>;
  signature: string | null;
}): VerifyResult {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!authToken) {
    if (process.env.TWILIO_WEBHOOK_INSECURE === "1") {
      console.log(
        "[twilio] 警告：未配置 TWILIO_AUTH_TOKEN，验签已跳过。这是无鉴权入口，仅限联调，勿用于生产。"
      );
      return { ok: true, mode: "skipped-insecure" };
    }
    return {
      ok: false,
      reason:
        "缺少 TWILIO_AUTH_TOKEN（验签必需，可在 Twilio 控制台账号页取）。仅联调可临时设 TWILIO_WEBHOOK_INSECURE=1 跳过。",
    };
  }

  if (!args.signature) {
    return { ok: false, reason: "缺少 X-Twilio-Signature 头" };
  }

  const url = resolveWebhookUrl(args.request);
  const sorted = Object.keys(args.params).sort();
  let payload = url;
  for (const key of sorted) {
    payload += key + args.params[key];
  }

  const expected = createHmac("sha1", authToken).update(payload, "utf8").digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      reason: `签名不匹配（用于计算的 URL：${url}。若与 Twilio 控制台里配置的不一致，请设 TWILIO_WEBHOOK_URL）`,
    };
  }

  return { ok: true, mode: "verified" };
}

function resolveWebhookUrl(request: Request): string {
  const override = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (override) {
    return override;
  }
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (proto) {
    url.protocol = `${proto}:`;
  }
  if (host) {
    url.host = host;
  }
  return url.toString();
}

// ─────────────────────────── TwiML ───────────────────────────

/** 空 TwiML：告诉 Twilio「收到了，这次不同步回内容」。回复走出站 API。 */
export function emptyTwiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─────────────────────────── 分段 ───────────────────────────

/**
 * Twilio 单条消息上限 1600 字符（超了直接报错）。
 *
 * 注意中文走 UCS-2，**每 70 字符算一条计费短信**，所以准则里那条「一条消息只说
 * 一件事」不只是体验要求，也是成本要求。这里的分段只是兜底，正常不该触发。
 */
const TWILIO_MAX_CHARS = 1500;

export function segmentForSms(text: string, max = TWILIO_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return [trimmed];
  }

  const segments: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    // 优先在段落/句子边界切，避免把一句话劈成两条
    const window = rest.slice(0, max);
    const cut =
      Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf("？"),
        window.lastIndexOf("！")
      ) + 1;
    const at = cut > max * 0.5 ? cut : max;
    segments.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) {
    segments.push(rest);
  }
  return segments;
}

// ─────────────────────────── 出站 ───────────────────────────

export type SendResult = { ok: true; sids: string[] } | { ok: false; error: string };

/**
 * 通过 Messaging Service 发短信。用 API Key 做 HTTP Basic（用户名=Key SID，
 * 密码=Key Secret），账号 SID 出现在 URL 路径里。
 */
export async function sendSms(to: string, text: string): Promise<SendResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const keySid = process.env.TWILIO_API_KEY_SID?.trim();
  const keySecret = process.env.TWILIO_API_KEY_SECRET?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();

  const missing = [
    !accountSid && "TWILIO_ACCOUNT_SID",
    !keySid && "TWILIO_API_KEY_SID",
    !keySecret && "TWILIO_API_KEY_SECRET",
    !messagingServiceSid && "TWILIO_MESSAGING_SERVICE_SID",
  ].filter(Boolean);
  if (missing.length) {
    return { ok: false, error: `缺少环境变量：${missing.join(", ")}` };
  }

  const auth = Buffer.from(`${keySid}:${keySecret}`).toString("base64");
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const sids: string[] = [];

  for (const segment of segmentForSms(text)) {
    const body = new URLSearchParams({
      To: to,
      Body: segment,
      MessagingServiceSid: messagingServiceSid as string,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 不要把 detail 原样往上抛给调用方日志之外的地方，里面可能带号码
      return {
        ok: false,
        error: `Twilio ${res.status}: ${detail.slice(0, 300)}`,
      };
    }

    const json = (await res.json().catch(() => null)) as { sid?: string } | null;
    if (json?.sid) {
      sids.push(json.sid);
    }
  }

  return { ok: true, sids };
}
