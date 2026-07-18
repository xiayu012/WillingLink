import { generateObject } from "ai";
import { z } from "zod";

import { getTitleModel } from "@/lib/ai/providers";

export type FeedTitleJudgement = {
  index: number;
  related: boolean;
  confidence: number;
  reason: string;
};

const batchSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().min(0),
      related: z.boolean(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    })
  ),
});

const SYSTEM_PROMPT = `你是小红书标题分类器，判断标题是否属于「美国湾区租房交易帖」。

相关（related=true）：
- 出租、转租、短租、招租、求租、找房、找室友、roommate、sublease 等真实找房/出租信息

不相关（related=false）：
- 避雷、攻略、经验分享、科普、总结、政策解读、注意事项、吐槽、生活记录
- 仅提到「湾区」「租房」但没有具体交易意图的资讯帖

为每个标题输出 index / related / confidence / reason。`;

export async function classifyFeedTitles(
  titles: string[]
): Promise<FeedTitleJudgement[]> {
  if (titles.length === 0) {
    return [];
  }

  const userPrompt = titles
    .map((title, index) => `${index}. ${title.slice(0, 200)}`)
    .join("\n");

  try {
    const { object } = await generateObject({
      model: getTitleModel(),
      schema: batchSchema,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
    });

    return object.results.map((item) => ({
      index: item.index,
      related: item.related,
      confidence: item.confidence,
      reason: item.reason || "AI 未提供原因",
    }));
  } catch (error) {
    console.error("[classify-feed-titles] failed:", error);
    return [];
  }
}
