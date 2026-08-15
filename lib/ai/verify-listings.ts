/**
 * 搜索终审（路线 C）：硬筛选 + rerank 之后、返回之前，用一次 LLM 调用
 * 拿"用户原始需求全文"逐条对读"候选房源原文"，剔除与需求实质矛盾的房源——
 * 接住结构化列永远覆盖不到的言下之意（"神仙室友继续住"→ 只出租一间，
 * 两人无法整租入住）。
 *
 * 设计约定：
 * - 只做减法：verifier 只能从已通过严格谓词的集合里剔除，绝不添加，
 *   所以评测的 PASS 语义不受影响（剔空记 VERIFIER_CUT，不算 CODE_BUG）。
 * - 宁缺毋滥（用户明确接受空结果）：有实质理由怀疑不满足就剔；
 *   但帖子只是没提到某个需求不算矛盾，不因沉默剔除。
 * - fail-open：LLM 不可用（本地无 gateway）或返回异常时原样放行，
 *   搜索永不因终审挂掉。剔除决策 console.log 进 Vercel log，供人工复核。
 */
import { generateObject } from "ai";
import { z } from "zod";

import { getTitleModel } from "@/lib/ai/providers";
import type { XhsRentalSearchResultRow } from "@/lib/db/queries";

const EXCERPT_CHARS = 1200;

const verdictSchema = z.object({
  cuts: z.array(
    z.object({
      index: z.number().int().describe("要剔除的候选序号（【n】里的 n）"),
      reason: z
        .string()
        .describe("一句话：帖子里的什么证据与用户的什么需求矛盾"),
    })
  ),
});

const VERIFIER_SYSTEM = `你是租房搜索的终审员。硬性条件（城市/预算/房型/租期等）已由上游筛过，你唯一的职责是读懂**言下之意**，剔除与用户需求实质矛盾的候选房源。

大胆推理隐含信息，例如：
- "和室友互不打扰"/"神仙室友，作息正常"/"我实习结束要走" → 出租的只是合租房里的一间，另一间室友继续住 → 两人/家庭想整租整套的需求无法满足。
- "限女生"对男性租客、"仅限一人"对情侣/两人同住，都是矛盾。
- 求租帖/找室友帖混进候选，对找房源的用户是矛盾。

原则：
- 宁缺毋滥：有实质理由怀疑不满足就剔，剔空也没关系。
- 但"帖子没提到某个需求"不是矛盾，不要因为沉默而剔除。
- 输出所有该剔除的序号，各配一句话理由（写清证据→结论）。没有要剔的就输出空数组。`;

export type VerifierResult = {
  kept: XhsRentalSearchResultRow[];
  cut: { id: string; title: string | null; reason: string }[];
};

/**
 * 一次 LLM 调用终审全部候选（≤5 条）。任何失败都 fail-open 原样放行。
 */
export async function verifyListingsAgainstQuery(
  query: string,
  listings: XhsRentalSearchResultRow[]
): Promise<VerifierResult> {
  if (listings.length === 0) {
    return { kept: listings, cut: [] };
  }
  try {
    const docs = listings
      .map(
        (l, i) =>
          `【${i}】${l.title ?? "(无标题)"}\n${l.rawText.slice(0, EXCERPT_CHARS)}`
      )
      .join("\n\n");
    const { object } = await generateObject({
      model: getTitleModel(),
      schema: verdictSchema,
      system: VERIFIER_SYSTEM,
      prompt: `【用户需求】\n${query}\n\n【候选房源】\n${docs}`,
    });

    const reasonByIndex = new Map(
      object.cuts
        .filter((c) => c.index >= 0 && c.index < listings.length)
        .map((c) => [c.index, c.reason])
    );
    const kept: XhsRentalSearchResultRow[] = [];
    const cut: VerifierResult["cut"] = [];
    listings.forEach((l, i) => {
      const reason = reasonByIndex.get(i);
      if (reason == null) {
        kept.push(l);
      } else {
        cut.push({ id: l.id, title: l.title, reason });
      }
    });
    return { kept, cut };
  } catch (error) {
    console.error("[verifyListings] fail-open:", error);
    return { kept: listings, cut: [] };
  }
}
