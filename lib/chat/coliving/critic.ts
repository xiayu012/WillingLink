import "server-only";

import { generateText } from "ai";
// **必须从 index 引**，不能直接引 registry：注册发生在 index 的副作用里。
// 直接引 registry 会在大脑还没注册时静默放行一切（真踩过）。
import { getBrain, readDoctrine } from "@/lib/ai/brains";
import { getLanguageModel } from "@/lib/ai/providers";
import { colivingModelId } from "./model";

/**
 * 发出去之前的批判器。
 *
 * ## 为什么不是「你自己再检查一遍」
 *
 * 朴素的自我复查在生产里不可靠——模型会朝「它以为你想听的」修正，
 * 甚至把本来对的改错。行业里站得住的是**生成器–批判器分离**：
 * 换一套提示词、只评不写、迭代封顶。
 *
 * ## 为什么对着「清单」而不是「宪法」
 *
 * 上一版让它对着宪法判，结果放行了一条读起来像指控的消息——
 * 住户报告马桶脏，回信是「你用完顺手刷一下，别留给下一个人」。
 * **宪法里没有一条叫「别对报告问题的人下指令」**，抽象原则判不出这种事。
 *
 * 宪法是「没写过的情况怎么推」，清单是「这条写好的消息哪里不对」。
 * 推理要抽象原则，检查要具体问题。**两件事，两份文档。**
 *
 * ## 为什么批判器用更贵的模型
 *
 * 生成一轮要带一万多字准则、跑好几步；审稿只带一份清单和一条消息，
 * 短得多。所以**审稿换成聪明模型的边际成本很低，收益却直接**。
 * `COLIVING_CRITIC_MODEL` 可覆盖，默认 sonnet。
 *
 * ## 三条兜底
 * 只跑一次 · 不给工具不让改写 · **默认放行**——
 * 批判器自己挂了、超时了、说不清楚，一律当通过。
 * **绝不能因为这道闸让住户收不到消息。**
 */

export type Verdict = {
  pass: boolean;
  /** 第几条不合格 */
  broke: string;
  /** 一句话说清哪儿不对，交给生成器去改 */
  why: string;
};

const PASS: Verdict = { pass: true, broke: "", why: "" };

function criticModelId(): string {
  return (
    process.env.COLIVING_CRITIC_MODEL?.trim() || "anthropic/claude-sonnet-4.5"
  );
}

function rubric(): string {
  const brain = getBrain("coliving");
  const mod = brain.situational.find((m) => m.id === "rubric");
  return mod ? readDoctrine(brain, mod) : "";
}

export type CriticInput = {
  /** 收信人叫什么 */
  to: string;
  /**
   * 他在这件事里是什么角色。**批判器最需要的就是这个**——
   * 同一段内容发给报告问题的人和发给被说到的人，一个合格一个是指控。
   */
  role:
    | "报告问题的人"
    | "被说到的人"
    | "共用者通知的对象"
    | "受影响的其他人"
    | "不确定";
  /** 他刚才说了什么。没说（主动发起）就留空 */
  said: string;
  /** 这一轮还知道些什么，够批判器判断「有没有说没证据的事」 */
  facts: string;
  draft: string;
};

export async function critique(args: CriticInput): Promise<Verdict> {
  if (process.env.COLIVING_CRITIC_OFF === "1" || !args.draft.trim()) {
    return PASS;
  }

  try {
    const result = await generateText({
      model: getLanguageModel(criticModelId()),
      system: [
        {
          role: "system" as const,
          content:
            "你是审稿人，不是作者。有人写了一条要发给住户的短信，" +
            "你对着下面的清单逐条查，只报**真正的违反**。\n" +
            "你不写替代方案，只说第几条、为什么。\n\n" +
            rubric(),
          // 这段逐字不变（rubric 只在改动doctrine时才变），
          // 一轮对话里批判器常被调好几次（每条 contactPerson 各审一次+
          // 回复本身再审一次），不开缓存等于每次都全价重发这179行清单。
          // 跟主生成路径（turn.ts）同一个做法，之前漏做了。
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content:
            `【收信人】${args.to}\n` +
            `【他在这件事里的角色】${args.role}\n` +
            `【他刚才说的话】${args.said || "（没说话，是我们主动发的）"}\n` +
            `【这一轮已知的事实】\n${args.facts}\n\n` +
            `【待发出的消息】\n${args.draft}\n\n` +
            "只回一行 JSON：\n" +
            '{"pass":true} 或 {"pass":false,"broke":"第几条","why":"一句话"}\n' +
            "why 里要引用消息原文时，不要加引号，直接说是哪句话——" +
            "引号会把 JSON 撑破（真出过：模型自己引用了一句话，" +
            "打回原因解析成了乱码，喂给重写模型时更糟）。",
        },
      ],
    });

    // **贪婪匹配到最后一个 }**。非贪婪会在 why 字段里的中文引号处截断，
    // 解析失败 → 静默放行，等于这道闸白装（实测踩过）。
    const m = result.text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as Partial<Verdict>;
        if (parsed.pass === false) {
          return {
            pass: false,
            broke: String(parsed.broke ?? ""),
            why: String(parsed.why ?? ""),
          };
        }
        return PASS;
      } catch {
        // JSON 还是坏的 —— 退回看关键词，别整个放弃
      }
    }
    // 兜底：模型有时不给 JSON，直接说了理由。
    // **只在明确说了不合格时才打回**，含糊的一律放行。
    if (/"?pass"?\s*[:：]\s*false|不合格|违反了?第/.test(result.text)) {
      // 先试着从坏掉的 JSON 里精确抠 why 字段（模型在 why 里加了引号，
      // 把 JSON 撑破时最常见），抠不到才退回粗暴截断。
      const whyField = result.text.match(/"why"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);
      return {
        pass: false,
        broke: result.text.match(/第\s*(\d+)\s*条/)?.[1] ?? "?",
        why: (
          whyField?.[1] ?? result.text.replace(/[\s\S]*?[:：]/, "")
        ).slice(0, 100).trim(),
      };
    }
    return PASS;
  } catch (error) {
    console.log(
      "[critic] 判不了，放行：",
      error instanceof Error ? error.message : String(error)
    );
    return PASS;
  }
}

/** 生成器没被调用时也别浪费一次审稿 */
export function criticEnabled(): boolean {
  return process.env.COLIVING_CRITIC_OFF !== "1";
}

export { colivingModelId };
