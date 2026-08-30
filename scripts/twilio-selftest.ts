/**
 * Twilio 渠道自检。不发真短信，只验证配置与本地链路。
 *
 *   pnpm twilio:selftest              # 检查环境变量 + 验签算法 + 大脑组装
 *   pnpm twilio:selftest --send +1650...   # 额外真发一条测试短信（会计费）
 */

import { config } from "dotenv";
import { createHmac } from "node:crypto";

config({ path: ".env.local" });

const REQUIRED = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
];

function mask(v: string | undefined): string {
  if (!v) {
    return "（未设置）";
  }
  return v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

async function main() {
  console.log("── 环境变量 ──");
  let missing = false;
  for (const key of REQUIRED) {
    const v = process.env[key]?.trim();
    if (!v) {
      missing = true;
    }
    console.log(`  ${v ? "✓" : "✗"} ${key.padEnd(30)} ${mask(v)}`);
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  console.log(
    `  ${authToken ? "✓" : "!"} ${"TWILIO_AUTH_TOKEN".padEnd(30)} ${mask(authToken)}` +
      (authToken ? "" : "  ← 验签必需，去控制台账号页取")
  );
  console.log(
    `  ${process.env.CHANNEL_ADAPTERS_ENABLED === "1" ? "✓" : "✗"} ${"CHANNEL_ADAPTERS_ENABLED".padEnd(30)} ${process.env.CHANNEL_ADAPTERS_ENABLED ?? "（未设置，路由会返回 503）"}`
  );

  if (missing) {
    console.log("\n缺必需变量，先补齐再往下测。");
    process.exit(1);
  }

  // ── 验签算法自检：自己造签名自己验，确认实现与 Twilio 文档一致 ──
  console.log("\n── 验签算法 ──");
  if (authToken) {
    const url = "https://example.com/api/twilio/coliving";
    const params = { From: "+15551234567", Body: "测试", MessageSid: "SM123" };
    const payload =
      url +
      Object.keys(params)
        .sort()
        .map((k) => k + params[k as keyof typeof params])
        .join("");
    const sig = createHmac("sha1", authToken).update(payload, "utf8").digest("base64");

    process.env.TWILIO_WEBHOOK_URL = url;
    const { verifyTwilioSignature } = await import("../lib/chat/twilio");
    const good = verifyTwilioSignature({
      request: new Request(url, { method: "POST" }),
      params,
      signature: sig,
    });
    const bad = verifyTwilioSignature({
      request: new Request(url, { method: "POST" }),
      params,
      signature: "definitely-wrong",
    });
    console.log(`  ${good.ok ? "✓" : "✗"} 正确签名应通过 → ${JSON.stringify(good)}`);
    console.log(`  ${bad.ok ? "✗" : "✓"} 错误签名应拒绝 → ${JSON.stringify(bad)}`);
    process.env.TWILIO_WEBHOOK_URL = "";
  } else {
    console.log("  跳过（没有 TWILIO_AUTH_TOKEN）");
  }

  // ── 大脑组装 ──
  console.log("\n── 大脑组装 ──");
  const { assembleSystemPrompt } = await import("../lib/ai/brains");
  const sample = "楼上那个人半夜两三点还在弄出声音";
  const r = assembleSystemPrompt({
    brainId: "coliving",
    routeOn: sample,
    runtimeContext: "当前渠道：短信（SMS）。回复必须短。",
  });
  console.log(`  ✓ 输入「${sample}」`);
  console.log(`    命中模块：${r.loadedModuleIds.join(", ")}`);
  console.log(`    system prompt：${r.chars} 字符`);

  // ── 可选：真发一条 ──
  const sendIdx = process.argv.indexOf("--send");
  if (sendIdx !== -1) {
    const to = process.argv[sendIdx + 1];
    if (!to) {
      console.log("\n--send 后面要跟接收号码，例如 --send +16505551234");
      process.exit(1);
    }
    console.log(`\n── 真发一条到 ${to}（会计费）──`);
    const { sendSms } = await import("../lib/chat/twilio");
    const res = await sendSms(to, "WillingLink 合租房管理测试消息，收到请忽略。");
    console.log(`  ${res.ok ? "✓ 已发送" : "✗ 失败"} ${JSON.stringify(res)}`);
  } else {
    console.log("\n（要真发一条：pnpm twilio:selftest --send +1650XXXXXXX）");
  }
}

main().catch((e) => {
  console.log("自检失败：", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
