import "server-only";

import { assembleSystemPrompt } from "@/lib/ai/brains";
import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import { buildContext } from "./context";
import * as repo from "./repo";

/**
 * 主动发起。**这是「管理员」和「客服」的分界线**——
 * 客服等人来问，管理员自己知道该回头看什么。
 *
 * 三条铁律（来自轻管理十条，违反就变成骚扰）：
 *   · 可以不回，不产生任何后果。**绝不追问、绝不设期限。**
 *   · 主动关怀可以关掉（person.proactive_ok）。不能关的关心是骚扰。
 *   · 频率有硬上限：同一个人两天内不主动找第二次，同一件事最多回访三次。
 *
 * 每一条主动消息仍然走 Decision → Communication，跟被动回复同一条链路，
 * 这样以后能一起复盘「有没有过度介入」。
 */

const OUTREACH_MODEL = () =>
  process.env.COLIVING_MODEL?.trim() || "anthropic/claude-sonnet-4.5";

export type OutreachMessage = {
  to: string;
  personId: string;
  text: string;
  communicationId: string;
};

export type OutreachResult = {
  household: string;
  jobs: Array<{ job: string; considered: number; acted: number }>;
  messages: OutreachMessage[];
};

/** 让模型按一个具体目的写一条短信。共用同一份准则，语气才一致。 */
async function compose(args: {
  householdId: string;
  person: repo.Member;
  purpose: string;
  brief: string;
}): Promise<string> {
  const sender: repo.Sender = {
    personId: args.person.personId,
    name: args.person.name,
    role: args.person.role,
    householdId: args.householdId,
    householdLabel: "",
    dwellingId: "",
  };
  const ctx = await buildContext(sender);
  const { doctrine, runtime } = assembleSystemPrompt({
    brainId: "coliving",
    routeOn: args.brief,
    runtimeContext: ctx.text,
  });

  const result = await generateText({
    model: getLanguageModel(OUTREACH_MODEL()),
    system: [
      {
        role: "system" as const,
        content: doctrine,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "system" as const, content: runtime },
    ],
    messages: [
      {
        role: "user" as const,
        content:
          `【这不是住户发来的消息，是你自己要主动发一条短信】\n` +
          `收件人：${args.person.name}\n` +
          `目的：${args.purpose}\n` +
          `背景：${args.brief}\n\n` +
          `只输出要发出去的短信正文，不要解释、不要加引号。\n` +
          `记住：他可以不回，不回没有任何后果——所以不要写「请回复」「麻烦确认一下」，` +
          `也不要写期限。一条消息只说一件事。`,
      },
    ],
  });
  return result.text.trim();
}

async function send(args: {
  householdId: string;
  person: repo.Member;
  purpose: string;
  brief: string;
  caseId?: string | null;
  decisionKind: string;
  rationale: string;
  out: OutreachMessage[];
}): Promise<boolean> {
  if (!args.person.phone) {
    return false;
  }
  if (!(await repo.canReachProactively(args.person.personId))) {
    return false;
  }
  // 批量作业里，一个人写不出来不该让整轮 cron 崩掉
  let text: string;
  try {
    text = await compose({
      householdId: args.householdId,
      person: args.person,
      purpose: args.purpose,
      brief: args.brief,
    });
  } catch (error) {
    console.log(
      "[outreach] 生成失败，跳过这一条：",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
  if (!text) {
    return false;
  }
  const decisionId = await repo.recordDecision({
    householdId: args.householdId,
    caseId: args.caseId ?? null,
    kind: args.decisionKind,
    targetPersonIds: [args.person.personId],
    intent: args.purpose,
    rationale: args.rationale,
    modelId: OUTREACH_MODEL(),
  });
  const communicationId = await repo.queueCommunication({
    householdId: args.householdId,
    decisionId,
    caseId: args.caseId ?? null,
    toPersonId: args.person.personId,
    channel: "sms",
    purpose: args.purpose,
    body: text,
  });
  const conversationId = await repo.getOrCreateConversation({
    personId: args.person.personId,
    householdId: args.householdId,
    channel: "sms",
  });
  await repo.appendMessage({
    conversationId,
    personId: args.person.personId,
    direction: "outbound",
    channel: "sms",
    body: text,
    communicationId,
  });
  await repo.markOutreach(args.person.personId);
  args.out.push({
    to: args.person.phone,
    personId: args.person.personId,
    text,
    communicationId,
  });
  return true;
}

export async function runOutreachForHousehold(
  householdId: string,
  label: string
): Promise<OutreachResult> {
  const members = await repo.getMembers(householdId);
  const residents = members.filter((m) => m.resides);
  const messages: OutreachMessage[] = [];
  const jobs: OutreachResult["jobs"] = [];

  // ── 1. 冷掉的事要回访 ──────────────────────────────────────────────
  {
    const runId = await repo.startOutreachRun({ householdId, job: "case_followup" });
    const stale = await repo.casesNeedingFollowup({ householdId });
    let acted = 0;
    for (const c of stale) {
      // 回访谁：报过这件事的人。没有就跳过，不要群发
      const [reporter] = await repo.lookupEvents({
        householdId,
        kind: c.kind,
        limit: 1,
      });
      const who = residents.find((m) => m.name === reporter?.reportedBy);
      if (!who) {
        continue;
      }
      const ok = await send({
        householdId,
        person: who,
        purpose: "回访：之前那件事后来怎么样了",
        brief:
          `${c.lastActivityAt.toISOString().slice(0, 10)} 起没有新进展的一件事：${c.title}（${c.kind}）。` +
          `问一句现在情况有没有好转。**不要重述细节**，也不要让他觉得必须回。`,
        caseId: c.id,
        decisionKind: "observe",
        rationale: `Case 已 ${Math.round((Date.now() - c.lastActivityAt.getTime()) / 86400000)} 天无动静，按流程回访一次`,
        out: messages,
      });
      if (ok) {
        await repo.markFollowedUp(c.id);
        acted++;
      }
    }
    await repo.finishOutreachRun({ runId, considered: stale.length, acted });
    jobs.push({ job: "case_followup", considered: stale.length, acted });
  }

  // ── 2. 共同规则还没问全 —— 去问剩下的人 ────────────────────────────
  {
    const runId = await repo.startOutreachRun({ householdId, job: "rule_consult" });
    const pending = await repo.rulesNeedingConsult(householdId);
    let acted = 0;
    let considered = 0;
    for (const rule of pending) {
      const asked = new Set([...rule.consulted, ...rule.agreedBy, ...rule.objected]);
      const todo = residents.filter((m) => !asked.has(m.personId));
      considered += todo.length;
      if (todo.length === 0) {
        // 所有住在这里的人都表过态了 —— 这条规则才算真正成立
        await repo.closeConsultation(rule.id);
        continue;
      }
      // 一次只问一个人，不要同一轮把全屋都轰一遍
      const who = todo[0];
      const ok = await send({
        householdId,
        person: who,
        purpose: "征询他对一条共同规则的意见",
        brief:
          `这栋房子现在按这条在跑：「${rule.statement}」。\n` +
          `**这是默认方案，不是定论**——住在这里的人一起说了算，他有一票。\n` +
          `问他这样行不行、有没有要改的。说明不回也没关系，不回就照现在这样。`,
        decisionKind: "propose_rule",
        rationale: `规则 ${rule.kind} 尚未征询 ${who.name}，共同生活的规则要问过每个住的人`,
        out: messages,
      });
      if (ok) {
        await repo.recordConsultation({
          ruleId: rule.id,
          personId: who.personId,
          stance: "asked",
        });
        acted++;
      }
    }
    await repo.finishOutreachRun({ runId, considered, acted });
    jobs.push({ job: "rule_consult", considered, acted });
  }

  // ── 3. 新住户头两周 —— 唯一低成本建立约定的窗口 ────────────────────
  {
    const runId = await repo.startOutreachRun({ householdId, job: "onboarding" });
    const fresh = await repo.newcomers(householdId);
    let acted = 0;
    for (const who of fresh) {
      const known = who.notes.length;
      const ok = await send({
        householdId,
        person: who,
        purpose: "入住早期主动关注，顺便问一件他自己的事",
        brief:
          `他刚搬进来不久。这是建立约定成本最低的窗口。\n` +
          (known
            ? `已经知道的：${who.notes.join("；")}。**别重复问已经知道的。**\n`
            : "关于他还什么都不知道。\n") +
          `问一个跟他自己有关的问题（作息、什么时候需要用厨房或卫生间、` +
          `有没有什么会打扰到他）。一次只问一个。`,
        decisionKind: "observe",
        rationale: "入住两周内，按流程主动接触一次",
        out: messages,
      });
      if (ok) {
        acted++;
      }
    }
    await repo.finishOutreachRun({ runId, considered: fresh.length, acted });
    jobs.push({ job: "onboarding", considered: fresh.length, acted });
  }

  return { household: label, jobs, messages };
}

export async function runOutreach(): Promise<OutreachResult[]> {
  const households = await repo.listHouseholds();
  const out: OutreachResult[] = [];
  for (const h of households) {
    // 一栋房子出问题不该拖垮其余的
    try {
      out.push(await runOutreachForHousehold(h.id, h.label));
    } catch (error) {
      console.log(
        `[outreach] ${h.label} 这一轮失败：`,
        error instanceof Error ? error.message : String(error)
      );
      out.push({ household: h.label, jobs: [], messages: [] });
    }
  }
  return out;
}
