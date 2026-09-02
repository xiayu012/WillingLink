import { after } from "next/server";
import { kickoffLandlord } from "@/lib/chat/coliving/outreach";
import { enrollLandlord } from "@/lib/chat/coliving/repo";

/**
 * 房东入库 —— **整个系统的起点**。
 *
 * 用户先认识房东、先拿到房东的手机号，写进本地那个 csv；
 * `pnpm coliving:watch` 监听文件保存，把号码 POST 到这里。
 * 这里建房子 + 建房东，然后**主动给房东发第一条消息**
 * （内容由准则决定，不是这里写的 —— 见 CLAUDE.md「不要替大脑写话术」）。
 *
 * 其余住户的号码由 AI 在跟房东的对话里问出来，用 addResident 加进去。
 * **没有加入码、没有表格、没有注册。**
 *
 * 鉴权：`Authorization: Bearer $CRON_SECRET`。没配就只允许本机。
 */
export const maxDuration = 120;
export const preferredRegion = "sfo1";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { phones?: unknown; label?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "expect json" }, { status: 400 });
  }

  const phones = Array.isArray(body.phones)
    ? body.phones.filter((p): p is string => typeof p === "string")
    : [];
  if (phones.length === 0) {
    return Response.json({ ok: false, error: "no phones" }, { status: 400 });
  }

  const results: Array<{ phone: string; created: boolean; error?: string }> = [];
  for (const phone of phones) {
    try {
      const r = await enrollLandlord({
        phone,
        label: typeof body.label === "string" ? body.label : null,
      });
      results.push({ phone, created: r.created });

      // 新建的才打招呼；已经在库里的不要重复骚扰
      if (r.created) {
        after(async () => {
          await kickoffLandlord({
            householdId: r.householdId,
            personId: r.personId,
          });
        });
      }
    } catch (error) {
      results.push({
        phone,
        created: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log("[coliving/enroll]", JSON.stringify(results));
  return Response.json({ ok: true, results });
}
