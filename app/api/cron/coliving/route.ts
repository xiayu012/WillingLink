import { runOutreach } from "@/lib/chat/coliving/outreach";
import { markCommunication, sendSmsOrSkip } from "@/lib/chat/coliving/deliver";

/**
 * 合租房管理员的主动发起。**这条路由是「管理员」和「客服」的分界线**——
 * 客服等人来问，管理员自己知道该回头看什么。
 *
 * 做三件事：回访冷掉的事 · 把还没问全的共同规则问完 · 新住户头两周的接触。
 *
 * 频率控制在 outreach.ts 里（同一个人两天内不主动找第二次，同一件事最多回访
 * 三次，`person.proactive_ok=false` 直接跳过）。**cron 跑得勤没关系，
 * 真正决定发不发的是那些闸门，不是 cron 的频率。**
 *
 * 认证：Vercel Cron 会带 `Authorization: Bearer $CRON_SECRET`。
 * 没设 CRON_SECRET 时只允许本机调用，避免裸奔。
 */
export const maxDuration = 300;
export const preferredRegion = "sfo1";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // 没配密钥就只让本地跑，别在公网上裸奔
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (process.env.COLIVING_OUTREACH_OFF === "1") {
    return Response.json({ ok: true, skipped: "COLIVING_OUTREACH_OFF=1" });
  }

  try {
    const results = await runOutreach();

    let sent = 0;
    for (const r of results) {
      for (const m of r.messages) {
        const outcome = await sendSmsOrSkip(m.to, m.text);
        await markCommunication({
          communicationId: m.communicationId,
          status: outcome.ok ? "sent" : "failed",
          error: outcome.ok ? null : outcome.error,
        });
        if (outcome.ok) {
          sent++;
        }
      }
    }

    console.log(
      "[cron/coliving]",
      JSON.stringify({
        households: results.length,
        sent,
        jobs: results.flatMap((r) => r.jobs),
      })
    );
    return Response.json({ ok: true, sent, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("[cron/coliving] failed", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
