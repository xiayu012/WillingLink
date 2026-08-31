import "server-only";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { assembleSystemPrompt } from "@/lib/ai/brains";
import { getLanguageModel } from "@/lib/ai/providers";
import { buildContext } from "./context";
import { normalizePhone } from "./phone";
import * as repo from "./repo";

/**
 * 一轮对话最多几步工具。比以前长：现在一轮里可能要
 * 判断 → 查历史 → 开 case → 联系另一个人 → 记规则。
 */
const MAX_STEPS = 6;

/**
 * 这个大脑用哪个模型。**不跟项目默认走。**
 * `DEFAULT_CHAT_MODEL` 是给查询理解那类「把已说出口的需求抄进 JSON」选的——
 * 便宜、快、听话，不需要推理。合租房大脑要做多方公平分配、算术、
 * 在互相冲突的原则之间权衡，是判断密集型任务。
 */
function colivingModelId(): string {
  return process.env.COLIVING_MODEL?.trim() || "anthropic/claude-sonnet-4.5";
}

export type OutboundMessage = {
  to: string;
  personId: string;
  text: string;
  communicationId: string;
};

export type TurnOutcome = {
  reply: string;
  /** 回复给发信人本人的那条，也算一次 communication */
  replyCommunicationId: string | null;
  /** 主动发给房子里其他人的（杠杆二） */
  outbound: OutboundMessage[];
  decisionId: string | null;
  modules: string[];
  promptChars: number;
  toolsUsed: string[];
  /** 认不出这个号码时为 true，调用方应当只回一句而不做任何记录 */
  unknownSender: boolean;
  /**
   * 这一轮真花了多少。`steps` 是模型往返次数——**带工具时一轮不止一次调用**，
   * 每次都重发整个提示词，所以这个数字直接决定成本。
   * `cachedInput` 是命中缓存的输入 token（价格是普通输入的十分之一）。
   */
  usage: {
    steps: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
};

const UNKNOWN_REPLY =
  "抱歉，我这边没有这个号码的记录。请问你是哪一位、找哪一户？";

export async function runColivingTurn(args: {
  fromPhone: string;
  text: string;
  /** 仅测试用：临时覆盖模型，便于 A/B */
  modelId?: string;
}): Promise<TurnOutcome> {
  const from = normalizePhone(args.fromPhone);
  const sender = await repo.resolveSender(from);

  if (!sender) {
    return {
      reply: UNKNOWN_REPLY,
      replyCommunicationId: null,
      outbound: [],
      decisionId: null,
      modules: [],
      promptChars: 0,
      toolsUsed: [],
      unknownSender: true,
      usage: {
        steps: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  const ctx = await buildContext(sender);
  const modelId = args.modelId ?? colivingModelId();

  /**
   * 关键词永远会有漏网的（真实投诉说的是"做饭""挨饿""不公平"，
   * 不是"厨房""室友""吵"）。**提到同住人的名字，几乎必然是人际问题**——
   * 这个信号比任何词表都可靠，而名册本来就在手上。
   */
  const mentionsOther = ctx.members.some(
    (m) => m.personId !== sender.personId && args.text.includes(m.name)
  );

  const { doctrine, runtime, loadedModuleIds, chars } = assembleSystemPrompt({
    brainId: "coliving",
    routeOn: args.text,
    runtimeContext: ctx.text,
    forceModules: mentionsOther ? ["conflict"] : undefined,
  });

  const conversationId = await repo.getOrCreateConversation({
    personId: sender.personId,
    householdId: sender.householdId,
    channel: "sms",
  });
  const history = await repo.getRecentTurns(conversationId);

  // ── 本轮累积的状态 ──
  let decisionId: string | null = null;
  let activeCaseId: string | null = null;
  let lastEventId: string | null = null;
  const outbound: OutboundMessage[] = [];
  const toolsUsed: string[] = [];
  const contacted = new Set<string>();

  /** 没调 decide 就直接说话时，兜底补一条，保证链路完整（设计稿第十四点） */
  const ensureDecision = async (kind: string): Promise<string> => {
    if (!decisionId) {
      decisionId = await repo.recordDecision({
        householdId: sender.householdId,
        kind,
        modelId,
        doctrineModules: loadedModuleIds,
        contextChars: chars,
      });
    }
    return decisionId;
  };

  const tools = {
    decide: tool({
      description:
        "**每一轮第一个调用这个。** 先说清楚你这次的治理判断：要不要介入、" +
        "找谁、想达成什么、为什么。这是判断本身，跟你实际说出口的话分开记录。",
      inputSchema: z.object({
        kind: z
          .enum([
            "observe",
            "stay_silent",
            "log_only",
            "reply_only",
            "contact_one",
            "contact_group",
            "propose_rule",
            "escalate",
          ])
          .describe(
            "observe=继续观察不动作 · stay_silent=这次不该说话 · log_only=只记录 · " +
              "reply_only=只回复当前这个人 · contact_one=还要私下联系某一个人 · " +
              "contact_group=要分别联系多个人 · propose_rule=要定一条规则 · escalate=要转给房东"
          ),
        intent: z.string().describe("这次想达成什么，一句话"),
        rationale: z.string().describe("为什么这么判断"),
        caseId: z
          .string()
          .optional()
          .describe("如果是某件未了结事情的后续，填它的 id"),
      }),
      execute: async ({ kind, intent, rationale, caseId }) => {
        if (caseId) {
          activeCaseId = caseId;
          await repo.touchCase(caseId);
        }
        decisionId = await repo.recordDecision({
          householdId: sender.householdId,
          caseId: activeCaseId,
          kind,
          intent,
          rationale,
          modelId,
          doctrineModules: loadedModuleIds,
          contextChars: chars,
        });
        return { ok: true, decisionId };
      },
    }),

    logEvent: tool({
      description:
        "记录发生了一件事。**判断为无需处理时也要记**，把理由写进 detail——" +
        "不作为同样必须可被复核。需要持续跟进的事，同时把 openCase 设为 true。",
      inputSchema: z.object({
        kind: z
          .string()
          .describe(
            "事件类别，用小写下划线：noise_complaint / kitchen_contention / " +
              "repair_request / rent_late / smell_complaint / safety_concern 等"
          ),
        severity: z
          .enum(["P0", "P1", "P2", "P3"])
          .describe(
            "P0=人身安全/火灾燃气/居住功能全失，P1=居住条件失效/非法进入/盗窃/骚扰，" +
              "P2=持续性生活摩擦，P3=早期信号需观察"
          ),
        summary: z.string().describe("一句话说清发生了什么"),
        detail: z.string().optional().describe("依据、各方陈述、你的判断理由"),
        aboutNames: z
          .array(z.string())
          .optional()
          .describe("这件事说的是谁（房子里的人名）"),
        openCase: z
          .boolean()
          .optional()
          .describe("是否需要开一件事持续跟进"),
        caseTitle: z.string().optional().describe("openCase 时给它起个短标题"),
      }),
      execute: async (a) => {
        const aboutIds: string[] = [];
        for (const n of a.aboutNames ?? []) {
          const m = await repo.findPersonByName(sender.householdId, n);
          if (m) {
            aboutIds.push(m.personId);
          }
        }
        if (a.openCase && !activeCaseId) {
          activeCaseId = await repo.openCase({
            householdId: sender.householdId,
            kind: a.kind,
            title: a.caseTitle ?? a.summary.slice(0, 80),
            severity: a.severity,
          });
        }
        lastEventId = await repo.recordEvent({
          householdId: sender.householdId,
          kind: a.kind,
          summary: a.summary,
          detail: a.detail ?? null,
          severity: a.severity,
          reportedBy: sender.personId,
          aboutPersonIds: aboutIds,
          caseId: activeCaseId,
        });
        return { ok: true, eventId: lastEventId, caseId: activeCaseId };
      },
    }),

    /**
     * 杠杆二。以前 AI 只能对着投诉人一个人把三个人的事定了，
     * 于是要么反复追问、要么替所有人拍板。现在它可以分别去说。
     */
    contactPerson: tool({
      description:
        "主动给这栋房子里的另一个人发消息（不是回复当前这个人）。" +
        "**这是你按流程做的判断，不是征求当前这位的同意。**\n" +
        "铁律：不得透露是谁反映的，除非那个人明确说了可以。" +
        "对被投诉的一方，先按中立提醒的力度说，不要一上来就指控。",
      inputSchema: z.object({
        name: z.string().describe("要联系的人的名字，必须是房子里现有的人"),
        purpose: z
          .string()
          .describe("这条消息的目的，例如：告知新的厨房时段安排"),
        message: z
          .string()
          .describe(
            "真正要发出去的短信正文。短、具体、直接说事。不提是谁反映的。"
          ),
      }),
      execute: async ({ name, purpose, message }) => {
        const target = await repo.findPersonByName(sender.householdId, name);
        if (!target) {
          return { ok: false, reason: `房子里没有叫「${name}」的人` };
        }
        if (target.personId === sender.personId) {
          return {
            ok: false,
            reason: "这是当前跟你说话的人，直接回复就行，不用另外发",
          };
        }
        if (!target.phone) {
          return { ok: false, reason: `${target.name} 没有登记手机号，联系不上` };
        }
        if (contacted.has(target.personId)) {
          return { ok: false, reason: `本轮已经给 ${target.name} 发过了` };
        }
        contacted.add(target.personId);

        const did = await ensureDecision("contact_one");
        // 模型常先说「只回复本人」，转头又来联系别人。判断记录要跟实际行为对得上。
        await repo.upgradeDecisionKind(
          did,
          contacted.size > 1 ? "contact_group" : "contact_one"
        );
        const communicationId = await repo.queueCommunication({
          householdId: sender.householdId,
          decisionId: did,
          caseId: activeCaseId,
          toPersonId: target.personId,
          channel: "sms",
          purpose,
          body: message,
        });
        // 也要写进对方自己的会话线。否则下次他发消息过来，
        // 我们看不到自己曾经对他说过什么——他却记得。
        const theirConversation = await repo.getOrCreateConversation({
          personId: target.personId,
          householdId: sender.householdId,
          channel: "sms",
        });
        await repo.appendMessage({
          conversationId: theirConversation,
          personId: target.personId,
          direction: "outbound",
          channel: "sms",
          body: message,
          communicationId,
        });

        outbound.push({
          to: target.phone,
          personId: target.personId,
          text: message,
          communicationId,
        });
        return { ok: true, sentTo: target.name };
      },
    }),

    proposeRule: tool({
      description:
        "把你定下来的安排记成这栋房子的一条规则。**定了时段、轮值、约定就要记**，" +
        "否则下一轮你自己也不知道说过什么。statement 要写成能直接念给住户听的一句话。",
      inputSchema: z.object({
        kind: z
          .string()
          .describe("quiet_hours / kitchen_schedule / trash / guests / cleaning 等"),
        statement: z.string().describe("一句话说清这条规则，含具体钟点和人名"),
        agreedByNames: z
          .array(z.string())
          .optional()
          .describe("已经明确同意的人。没人确认过就留空"),
      }),
      execute: async ({ kind, statement, agreedByNames }) => {
        const agreed: string[] = [];
        for (const n of agreedByNames ?? []) {
          const m = await repo.findPersonByName(sender.householdId, n);
          if (m) {
            agreed.push(m.personId);
          }
        }
        await repo.saveRule({
          householdId: sender.householdId,
          kind,
          statement,
          agreedBy: agreed,
          sourceCaseId: activeCaseId,
        });
        return { ok: true };
      },
    }),

    remember: tool({
      description:
        "把关于某个人的长期事实记下来（作息、偏好、在意的事、身体状况）。" +
        "**只记以后还用得上的**，不记这一次的经过——经过用 logEvent。",
      inputSchema: z.object({
        name: z.string().describe("这条记忆是关于谁的"),
        kind: z.enum(["preference", "schedule", "sensitivity", "fact"]),
        content: z.string().describe("一句话"),
      }),
      execute: async ({ name, kind, content }) => {
        const m = await repo.findPersonByName(sender.householdId, name);
        if (!m) {
          return { ok: false, reason: `房子里没有叫「${name}」的人` };
        }
        await repo.noteMemory({
          householdId: sender.householdId,
          personId: m.personId,
          kind,
          content,
          sourceEventId: lastEventId,
        });
        return { ok: true };
      },
    }),

    lookupHistory: tool({
      description:
        "查这栋房子过去发生过什么。**判断力度之前先查**：" +
        "首次和第五次是完全不同的处理。",
      inputSchema: z.object({
        aboutName: z.string().optional().describe("只看跟某个人有关的"),
        kind: z.string().optional().describe("只看某一类事件"),
        sinceDays: z.number().optional().describe("往回看多少天，默认 180"),
      }),
      execute: async ({ aboutName, kind, sinceDays }) => {
        let aboutId: string | null = null;
        if (aboutName) {
          const m = await repo.findPersonByName(sender.householdId, aboutName);
          aboutId = m?.personId ?? null;
        }
        const events = await repo.lookupEvents({
          householdId: sender.householdId,
          aboutPersonId: aboutId,
          kind: kind ?? null,
          sinceDays,
        });
        return {
          count: events.length,
          events: events.map((e) => ({
            date: e.recordedAt.toISOString().slice(0, 10),
            kind: e.kind,
            severity: e.severity,
            summary: e.summary,
          })),
        };
      },
    }),

    findSimilarCases: tool({
      description: "找这栋房子以前类似的事，看当时怎么收场的。",
      inputSchema: z.object({
        query: z.string().describe("用一句话描述现在这件事"),
        kind: z.string().optional(),
      }),
      execute: async ({ query, kind }) => {
        const cases = await repo.findSimilarCases({
          householdId: sender.householdId,
          query,
          kind: kind ?? null,
        });
        return { count: cases.length, cases };
      },
    }),

    checkEnvironment: tool({
      description:
        "查投诉时间点附近，房子周边有没有外部的噪音/气味/施工来源。" +
        "**不是所有抱怨都该归咎于室友**——先看看是不是外面的事。",
      inputSchema: z.object({
        kind: z
          .string()
          .optional()
          .describe("odor / noise / construction / air_quality"),
        windowMinutes: z.number().optional().describe("前后多少分钟，默认 180"),
      }),
      execute: async ({ kind, windowMinutes }) => {
        const obs = await repo.nearbyObservations({
          householdId: sender.householdId,
          kind: kind ?? null,
          at: new Date(),
          windowMinutes,
        });
        if (obs.length === 0) {
          return {
            count: 0,
            note: "附近没有登记到相关的环境观察。注意：这不等于外面没事，只是本系统没有数据。",
          };
        }
        return { count: obs.length, observations: obs };
      },
    }),
  };

  /**
   * 系统提示词拆成两条，**缓存断点卡在中间**。
   *
   * 这是本模块最大的一笔省钱：带工具的一轮对话不是一次调用，而是每调一次工具
   * 就把整个提示词重发一遍——四个工具就是五遍一万四千字的准则。
   * 准则那一段逐字不变，可以缓存（写入 1.25 倍价，命中 0.1 倍价）；
   * 运行时状态每轮都变，留在断点之外，否则一变就整段落空。
   */
  const result = await generateText({
    model: getLanguageModel(modelId),
    system: [
      {
        role: "system" as const,
        content: doctrine,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      ...(runtime ? [{ role: "system" as const, content: runtime }] : []),
    ],
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

  // ── 落库：入站消息、回复本身也算一次 communication ──
  await repo.appendMessage({
    conversationId,
    personId: sender.personId,
    direction: "inbound",
    channel: "sms",
    body: args.text,
  });

  let replyCommunicationId: string | null = null;
  if (reply) {
    const did = await ensureDecision("reply_only");
    replyCommunicationId = await repo.queueCommunication({
      householdId: sender.householdId,
      decisionId: did,
      caseId: activeCaseId,
      toPersonId: sender.personId,
      channel: "sms",
      purpose: "回复本人",
      body: reply,
    });
    await repo.appendMessage({
      conversationId,
      personId: sender.personId,
      direction: "outbound",
      channel: "sms",
      body: reply,
      communicationId: replyCommunicationId,
    });
  }

  return {
    reply,
    replyCommunicationId,
    outbound,
    decisionId,
    modules: loadedModuleIds,
    promptChars: chars,
    toolsUsed,
    unknownSender: false,
    usage: {
      steps: result.steps.length,
      inputTokens: result.usage.inputTokens ?? 0,
      cachedInputTokens: result.usage.cachedInputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}
