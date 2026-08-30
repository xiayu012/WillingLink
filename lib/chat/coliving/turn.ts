import "server-only";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { assembleSystemPrompt } from "@/lib/ai/brains";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { recordEvent, type Severity } from "./events";
import { appendTurn, getTurns } from "./session";
import { buildRuntimeContext, findPerson, getManagers, normalizePhone } from "./roster";

/** 工具最多跑几步。合租房场景不需要长链路：识别 → 记录/转交 → 回话。 */
const MAX_STEPS = 4;

export type TurnOutcome = {
  reply: string;
  modules: string[];
  promptChars: number;
  toolsUsed: string[];
  /** 需要额外发给管理方的短信（由调用方投递，便于本地模拟时不真发） */
  outbound: Array<{ to: string; text: string }>;
};

/**
 * 跑完一轮合租房对话。**不做投递**——把要发的消息返回给调用方，
 * 这样本地模拟器可以只打印不发送，线上路由才真发。
 */
export async function runColivingTurn(args: {
  fromPhone: string;
  text: string;
}): Promise<TurnOutcome> {
  const from = normalizePhone(args.fromPhone);
  const me = findPerson(from);
  const fromName = me?.name ?? from;

  const outbound: TurnOutcome["outbound"] = [];
  const toolsUsed: string[] = [];
  /** 一轮只转交一次，防止重复短信 */
  let notified = false;

  const { system, loadedModuleIds, chars } = assembleSystemPrompt({
    brainId: "coliving",
    routeOn: args.text,
    runtimeContext: buildRuntimeContext(from),
  });

  recordEvent({
    fromPhone: from,
    fromName,
    kind: "message",
    summary: args.text.slice(0, 200),
    modules: loadedModuleIds,
  });

  const tools = {
    logEvent: tool({
      description:
        "记录一件事，用于留痕与后续复查。**判断为「无需处理」时也要调用**，" +
        "把不处理的理由写进 detail——准则要求不作为同样必须可被复核。",
      inputSchema: z.object({
        severity: z
          .enum(["P0", "P1", "P2", "P3"])
          .describe(
            "P0=人身安全/火灾燃气/居住功能全失，P1=居住条件失效/非法进入/盗窃/骚扰，P2=持续性生活摩擦，P3=早期信号需观察"
          ),
        summary: z.string().describe("一句话说清发生了什么，用于人快速扫读"),
        detail: z
          .string()
          .optional()
          .describe("依据、各方陈述、你的判断理由；判定无需处理时写明为什么"),
        noAction: z
          .boolean()
          .optional()
          .describe("true 表示本次判定为无需进一步处理"),
      }),
      execute: async ({ severity, summary, detail, noAction }) => {
        recordEvent({
          fromPhone: from,
          fromName,
          kind: noAction ? "no-action" : "logged",
          severity: severity as Severity,
          summary,
          detail,
          modules: loadedModuleIds,
        });
        return { ok: true };
      },
    }),

    notifyManager: tool({
      description:
        "把事情转交给管理方（房东）。达到 P0/P1，或需要人到现场、需要动钱、" +
        "需要法定权限时调用。**转交不是询问住户的选项，是你按流程做的判断。**",
      inputSchema: z.object({
        urgency: z.enum(["P0", "P1", "P2"]).describe("紧急程度"),
        summary: z
          .string()
          .describe("给管理方看的简报：谁、什么事、需要他做什么、什么时候之前"),
      }),
      execute: async ({ urgency, summary }) => {
        // 同一轮里模型有时会连调两次，那会给管理方发两条重复短信。
        if (notified) {
          return { ok: true, note: "本轮已经转交过，不重复发送" };
        }
        notified = true;

        // 不能把上报发回给发起人本人。管理方自己下达不当指令时，
        // 「通知管理方」等于通知那个下命令的人——准则要求这类事不得在
        // 管理方内部闭环（见 情境_05），必须留外部渠道并如实告知。
        const managers = getManagers().filter((m) => m.phone !== from);

        if (managers.length === 0) {
          const senderIsManager = me?.role === "manager";
          recordEvent({
            fromPhone: from,
            fromName,
            kind: "notified",
            severity: urgency as Severity,
            summary: senderIsManager
              ? `【无法内部上报：事涉管理方本人】${summary}`
              : `【名册里没有管理方】${summary}`,
            modules: loadedModuleIds,
          });
          return {
            ok: false,
            reason: senderIsManager
              ? "事情涉及管理方本人，不能上报给他自己。已完整留痕。请如实告知对方：你不会执行、已记录、且不隐瞒外部申诉渠道。"
              : "名册里没有可通知的管理方，已记录但无人可转交。请如实告知对方目前无法转交。",
          };
        }

        for (const m of managers) {
          outbound.push({
            to: m.phone,
            text: `[${urgency}] 来自${fromName}：${summary}`,
          });
        }
        recordEvent({
          fromPhone: from,
          fromName,
          kind: "notified",
          severity: urgency as Severity,
          summary,
          detail: `已通知：${managers.map((m) => m.name).join("、")}`,
          modules: loadedModuleIds,
        });
        return { ok: true, notified: managers.map((m) => m.name) };
      },
    }),
  };

  const history = getTurns(from);

  const result = await generateText({
    model: getLanguageModel(DEFAULT_CHAT_MODEL),
    system,
    messages: [...history, { role: "user" as const, content: args.text }],
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  for (const step of result.steps) {
    for (const call of step.toolCalls ?? []) {
      toolsUsed.push(call.toolName);
    }
  }

  const reply =
    result.text.trim() ||
    result.steps
      .map((s) => s.text.trim())
      .filter(Boolean)
      .at(-1) ||
    "";

  if (reply) {
    appendTurn(from, { role: "user", content: args.text });
    appendTurn(from, { role: "assistant", content: reply });
  }

  return {
    reply,
    modules: loadedModuleIds,
    promptChars: chars,
    toolsUsed,
    outbound,
  };
}
