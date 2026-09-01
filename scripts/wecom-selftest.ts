/**
 * 企业微信配置与加解密自检。**不联网、不发消息**（除非加 --token）。
 *
 *   pnpm wecom:selftest           # 环境变量 + 验签 + 加解密往返
 *   pnpm wecom:selftest --token   # 额外真的去换一次 access_token（会联网）
 *
 * 存在的理由：企业微信这套东西写错的表现是**静默 403**，后台只说
 * 「回调地址验证失败」，不告诉你是签名错了还是解密错了。先在本地跑通再部署。
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

/** 只在自检里用：把明文按企业微信的格式加密，用来验证解密是对的 */
function encryptForTest(aesKey: string, corpId: string, message: string): string {
  const key = Buffer.from(`${aesKey}=`, "base64");
  const iv = key.subarray(0, 16);
  const msg = Buffer.from(message, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([randomBytes(16), len, msg, Buffer.from(corpId, "utf8")]);
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

async function main() {
  const mod = await import("../lib/chat/wecom");
  const cfg = mod.wecomConfig();

  console.log("── 环境变量 ──");
  const names = [
    "WECOM_CORP_ID",
    "WECOM_AGENT_ID",
    "WECOM_SECRET",
    "WECOM_TOKEN",
    "WECOM_ENCODING_AES_KEY",
  ];
  for (const n of names) {
    const v = process.env[n]?.trim();
    console.log(`  ${n.padEnd(24)} ${v ? `已设置（${v.length} 字符）` : "✗ 缺失"}`);
  }
  if (!cfg) {
    console.log("\n配置不全，后面的检查跳过。");
    process.exit(1);
  }
  if (cfg.aesKey.length !== 43) {
    console.log(`\n⚠️ EncodingAESKey 应该是 43 个字符，现在是 ${cfg.aesKey.length}`);
  }

  console.log("\n── 验签算法 ──");
  const ts = "1409659813";
  const nonce = "1372623149";
  const fake = "encrypted-payload";
  const sig = mod.wecomSignature({ token: cfg.token, timestamp: ts, nonce, encrypt: fake });
  const ok = mod.verifyWecomSignature({
    config: cfg,
    msgSignature: sig,
    timestamp: ts,
    nonce,
    encrypt: fake,
  });
  console.log(`  自签自验：${ok ? "✓ 通过" : "✗ 失败"}`);
  console.log(
    `  篡改后应失败：${
      mod.verifyWecomSignature({
        config: cfg,
        msgSignature: sig,
        timestamp: ts,
        nonce,
        encrypt: "tampered",
      })
        ? "✗ 竟然通过了"
        : "✓ 正确拒绝"
    }`
  );

  console.log("\n── 加解密往返 ──");
  const plain =
    "<xml><ToUserName><![CDATA[wx]]></ToUserName>" +
    "<FromUserName><![CDATA[TestUser]]></FromUserName>" +
    "<MsgType><![CDATA[text]]></MsgType>" +
    "<Content><![CDATA[你好，测试一下]]></Content>" +
    "<MsgId>1234567890</MsgId></xml>";
  try {
    const enc = encryptForTest(cfg.aesKey, cfg.corpId, plain);
    const dec = mod.decryptWecom(cfg, enc);
    console.log(`  解密还原：${dec === plain ? "✓ 一致" : "✗ 不一致"}`);
    console.log(`  取 Content：「${mod.xmlValue(dec, "Content")}」`);
    console.log(`  取 FromUserName：「${mod.xmlValue(dec, "FromUserName")}」`);
  } catch (e) {
    console.log("  ✗ 往返失败：", e instanceof Error ? e.message : e);
  }

  console.log("\n── receiveid 校验（应当拒绝别家的密文）──");
  try {
    const wrong = encryptForTest(cfg.aesKey, "ww_someone_else", plain);
    mod.decryptWecom(cfg, wrong);
    console.log("  ✗ 竟然接受了");
  } catch {
    console.log("  ✓ 正确拒绝");
  }

  if (process.argv.includes("--token")) {
    console.log("\n── 真的换一次 access_token ──");
    const t = await mod.getWecomAccessToken(cfg);
    console.log(t ? `  ✓ 拿到了（${t.length} 字符）` : "  ✗ 失败，看上面的 errcode");
  } else {
    console.log("\n（没联网。要验证 CorpID/Secret 是否正确，加 --token）");
  }
  process.exit(0);
}

main().catch((e) => {
  console.log("失败：", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
