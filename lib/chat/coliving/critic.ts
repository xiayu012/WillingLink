import "server-only";

import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import { readDoctrine } from "@/lib/ai/brains/loader";
import { getBrain } from "@/lib/ai/brains/registry";
import { colivingModelId } from "./model";

/**
 * 发出去之前的批判器。
 *
 * ## 为什么不是「你自己再检查一遍」
 *
 * 查过资料：**朴素的自我复查在生产里不可靠**——模型会朝「它以为你想听的」
 * 修正（sycophancy），甚至把本来对的改错。行业里站得住的做法是
 * **生成器–批判器分离**：换一套提示词、只做评判不做创作、迭代次数封顶。
 *
 * 所以这里刻意做了四件事：
 *   1. **不给它准则全文**，只给宪法十四条 —— 批判器要判的是原则，不是细则
 *   2. **不给它工具**，不让它改写，只让它回「过 / 不过 + 哪条 + 为什么」
 *   3. **只跑一次**。不过就退回生成器改一版，改完直接发，不再评第二轮
 *   4. **默认放行**：批判器自己出错、超时、说不清楚，一律当通过 ——
 *      **绝不能因为这道闸挂了就让住户收不到消息**
 */

export type Verdict = {
  pass: boolean;
  /** 违反了哪一条（宪法的序号或名字），没违反就空 */
  broke: string;
  /** 一句话说清哪儿不对，交给生成器去改 */
  why: string;
};

const PASS: Verdict = { pass: true, broke: "", why: "" };

function constitution(): string {
  const brain = getBrain("coliving");
  const mod = brain.always.find((m) => m.id === "constitution");
  return mod ? readDoctrine(brain, mod) : "";
}

/**
 * 判一条待发消息过不过。
 *
 * `situation` 是这一轮的事实摘要（谁说了什么、房子里有谁），
 * 批判器需要它才能判断「说的是不是真的」这类问题。
 */
export async function critique(args: {
  situation: string;
  draft: string;
  modelId?: string;
}): Promise<Verdict> {
  if (process.env.COLIVING_CRITIC_OFF === "1" || !args.draft.trim()) {
    return PASS;
  }

  try {
    const result = await generateText({
      model: getLanguageModel(args.modelId ?? colivingModelId()),
      system: [
        {
          role: "system" as const,
          content:
            "你是审稿人，不是作者。有人写了一条要发给住户的短信，" +
            "你只判断它有没有违反下面这份宪法。\n\n" +
            "**只挑真正的违反**：读完之后住户会被误导、被不公平对待、" +
            "被摊上不该他承担的事、或者收到一个执行不下去的安排。\n" +
            "**措辞不够漂亮不算违反。** 你不写替代方案，只说哪条、为什么。\n\n" +
            constitution(),
        },
      ],
      messages: [
        {
          role: "user" as const,
          content:
            `【这一轮的情况】\n${args.situation}\n\n` +
            `【待发出的消息】\n${args.draft}\n\n` +
            "只回一行 JSON，别的都不要：\n" +
            '{"pass": true} 或 ' +
            '{"pass": false, "broke": "第几条", "why": "一句话"}',
        },
      ],
    });

    const m = result.text.match(/\{[\s\S]*\}/);
    if (!m) {
      return PASS;
    }
    const parsed = JSON.parse(m[0]) as Partial<Verdict>;
    if (parsed.pass !== false) {
      return PASS;
    }
    return {
      pass: false,
      broke: String(parsed.broke ?? ""),
      why: String(parsed.why ?? ""),
    };
  } catch (error) {
    // **默认放行。** 这道闸是加分项，不能让它变成消息发不出去的原因。
    console.log(
      "[critic] 判不了，放行：",
      error instanceof Error ? error.message : String(error)
    );
    return PASS;
  }
}
