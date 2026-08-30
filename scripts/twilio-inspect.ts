/**
 * 直接查 Twilio REST API，比翻控制台可靠。
 *
 *   pnpm twilio:inspect            # 号码 / Messaging Service / 入站 webhook 现状
 *   pnpm twilio:inspect --logs     # 最近 20 条消息记录
 */

import { config } from "dotenv";

config({ path: ".env.local" });

const ACCOUNT = process.env.TWILIO_ACCOUNT_SID?.trim();
const KEY = process.env.TWILIO_API_KEY_SID?.trim();
const SECRET = process.env.TWILIO_API_KEY_SECRET?.trim();
const MSG_SVC = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();

if (!(ACCOUNT && KEY && SECRET)) {
  console.log("缺 TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET");
  process.exit(1);
}

const auth = Buffer.from(`${KEY}:${SECRET}`).toString("base64");

/** Messaging Service 的接口在 messaging.twilio.com，不在 api.twilio.com */
async function api(path: string, host = "https://api.twilio.com") {
  const res = await fetch(`${host}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

const MESSAGING_HOST = "https://messaging.twilio.com";

async function main() {
  console.log("── 账号下所有号码 ──");
  const nums = await api(`/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=50`);
  for (const n of nums.incoming_phone_numbers ?? []) {
    console.log(`\n  ${n.phone_number}  ${n.friendly_name ?? ""}`);
    console.log(`    SID          ${n.sid}`);
    console.log(`    SMS 能力     ${n.capabilities?.sms ? "✓" : "✗"}`);
    console.log(`    入站 webhook ${n.sms_url || "（空）"}  [${n.sms_method}]`);
    console.log(`    归属服务     ${n.messaging_service_sid || "（未加入 Messaging Service）"}`);
  }

  if (MSG_SVC) {
    console.log("\n── Messaging Service ──");
    const svc = await api(`/v1/Services/${MSG_SVC}`, MESSAGING_HOST).catch(
      (e) => ({ _err: String(e) }) as Record<string, unknown>
    );
    if (svc._err) {
      console.log(`  查询失败：${svc._err}`);
    } else {
      console.log(`  ${svc.friendly_name}  (${svc.sid})`);
      console.log(`  入站 webhook   ${svc.inbound_request_url || "（空 → 回落到号码级配置）"}`);
      console.log(`  入站方式       ${svc.inbound_method ?? "-"}`);
      console.log(`  号码级 webhook 优先 = ${svc.use_inbound_webhook_on_number}`);
    }
    const senders = await api(
      `/v1/Services/${MSG_SVC}/PhoneNumbers?PageSize=50`,
      MESSAGING_HOST
    ).catch(() => null);
    console.log("  Sender Pool：");
    const list = senders?.phone_numbers ?? [];
    if (list.length === 0) {
      console.log("    （空）");
    }
    for (const p of list) {
      console.log(`    ${p.phone_number}  ${p.capabilities?.join?.(",") ?? ""}`);
    }
  }

  const setIdx = process.argv.indexOf("--set-webhook");
  if (setIdx !== -1) {
    const url = process.argv[setIdx + 1];
    if (!url?.startsWith("https://")) {
      console.log("\n--set-webhook 后面要跟 https:// 开头的完整地址");
      process.exit(1);
    }
    console.log(`\n── 把所有有 SMS 能力的号码入站 webhook 设为 ${url} ──`);
    for (const n of nums.incoming_phone_numbers ?? []) {
      if (!n.capabilities?.sms) {
        continue;
      }
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/${n.sid}.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ SmsUrl: url, SmsMethod: "POST" }),
        }
      );
      console.log(
        `  ${res.ok ? "✓" : "✗"} ${n.phone_number}${res.ok ? "" : ` ${res.status} ${(await res.text()).slice(0, 150)}`}`
      );
    }
  }

  if (process.argv.includes("--logs")) {
    console.log("\n── 最近 20 条消息 ──");
    const msgs = await api(`/2010-04-01/Accounts/${ACCOUNT}/Messages.json?PageSize=20`);
    for (const m of msgs.messages ?? []) {
      const dir = m.direction?.includes("inbound") ? "收" : "发";
      console.log(
        `  ${m.date_sent ?? m.date_created}  ${dir}  ${m.from} → ${m.to}  [${m.status}]${m.error_code ? ` err=${m.error_code}` : ""}`
      );
      console.log(`      ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
}

main().catch((e) => {
  console.log("失败：", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
