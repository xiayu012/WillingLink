/**
 * 本地跑一遍主动发起，**不真发短信**——只打印会发出去什么。
 *
 *   pnpm coliving:outreach          # 干跑，看它想发什么
 *   pnpm coliving:outreach --send   # 真发（会计费、会打扰真人）
 *
 * 线上是 vercel.json 里的 cron 每天两次（正午与晚八点太平洋时间）打
 * /api/cron/coliving。频率控制不在 cron 上，在 outreach.ts 的闸门里：
 * 同一个人两天内不主动找第二次、同一件事最多回访三次、
 * person.proactive_ok=false 直接跳过。
 */

import { config } from "dotenv";

config({ path: ".env.local" });

async function main() {
  const { runOutreach } = await import("../lib/chat/coliving/outreach");
  const repo = await import("../lib/chat/coliving/repo");
  const doSend = process.argv.includes("--send");

  const results = await runOutreach();

  for (const r of results) {
    console.log(`\n── ${r.household} ──`);
    for (const j of r.jobs) {
      console.log(`  ${j.job.padEnd(16)} 考察 ${j.considered} · 发出 ${j.acted}`);
    }
    if (r.messages.length === 0) {
      console.log("  （这一轮没有该主动发的消息）");
      continue;
    }
    for (const m of r.messages) {
      console.log(`\n  \x1b[33m→ ${m.to}\x1b[0m`);
      console.log(`  ${m.text}`);
      if (!doSend) {
        // 干跑：把 communication 标成 skipped，否则会永远停在 queued
        await repo.markCommunication({
          communicationId: m.communicationId,
          status: "skipped",
        });
      }
    }
  }

  if (doSend) {
    const { sendSmsOrSkip } = await import("../lib/chat/coliving/deliver");
    for (const r of results) {
      for (const m of r.messages) {
        const out = await sendSmsOrSkip(m.to, m.text);
        await repo.markCommunication({
          communicationId: m.communicationId,
          status: out.ok ? "sent" : "failed",
          error: out.ok ? null : out.error,
        });
        console.log(out.ok ? `✓ 已发 ${m.to}` : `✗ ${m.to}：${out.error}`);
      }
    }
  } else {
    console.log("\n（干跑，没有真发。要真发加 --send）");
  }
  process.exit(0);
}

main().catch((e) => {
  console.log("失败：", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
